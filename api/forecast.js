// PaperFate · POST /api/forecast
// Vercel serverless function. Receives a manuscript + (optional) article type,
// runs Q500 extraction via forecastManuscript, returns the rollup JSON.
//
// Request body:
//   {
//     title:        string,      // required
//     abstract:     string,      // required (≥200 chars)
//     methods:      string?,     // optional sections for full-text mode
//     results:      string?,
//     discussion:   string?,
//     full_text:    string?,     // concatenated full text fallback
//     authors:      string[]|string?,
//     year:         number?,
//     first_affiliation: string?,
//     author_features: {
//       first_author_h_index?: number,
//       last_author_h_index?: number,
//       max_team_h_index?: number,
//       median_team_h_index?: number,
//       team_size_with_id?: number,
//       international_collab?: 0|1
//     }?,
//     article_type: string?,     // schema.json article_types, default "*"
//     mode:         "Q100"|"Q500"|"auto"?,  // default "auto"
//   }
//
// Response:
//   200 → result of forecastManuscript() — see src/server/extract.js
//   4xx / 5xx → { error, detail, request_id }
//
// Rate limiting (best-effort, in-process token bucket):
//   30 requests / IP / hour. Vercel serverless is stateless across cold
//   starts so this protects against runaway loops on a single warm instance
//   rather than global abuse. OPTIONS preflight is never limited, and a
//   request carrying `x-paperfate-internal: $PAPERFATE_INTERNAL_TOKEN`
//   (when the env var is set) bypasses the bucket entirely. On overflow:
//   429 with { error: 'rate_limited', retry_after_seconds, request_id }
//   and a Retry-After header. The bucket Map self-prunes every minute to
//   bound memory.

import { forecastManuscript } from '../src/server/extract.js'
import { forecastManuscriptDeterministic } from '../src/server/deterministicExtract.js'
import { predictFromExtraction } from '../src/server/fatecoreInference.js'
import { generateSuggestions, generateJointCounterfactual } from '../src/server/suggestionEngine.js'
import crypto from 'node:crypto'

// ── Rate limiter (in-memory token bucket) ─────────────────────────────────
// Best-effort: each warm Vercel instance owns its own Map. A cold start
// resets the bucket, which is fine — we only need to stop loops/abuse from
// a single client hammering one warm function.
const RATE_LIMIT_PER_HOUR = 30
const RATE_WINDOW_MS = 60 * 60 * 1000
const RATE_REFILL_PER_SEC = RATE_LIMIT_PER_HOUR / 3600
const _buckets = new Map() // ip → { tokens, lastRefillTs }
let _lastPruneTs = 0
const PRUNE_INTERVAL_MS = 60 * 1000

function _clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff && typeof xff === 'string') {
    const first = xff.split(',')[0]?.trim()
    if (first) return first.slice(0, 64)
  }
  const real = req.headers['x-real-ip']
  if (real && typeof real === 'string') return real.trim().slice(0, 64)
  return 'unknown'
}

function _pruneBuckets(now) {
  if (now - _lastPruneTs < PRUNE_INTERVAL_MS) return
  _lastPruneTs = now
  const cutoff = now - RATE_WINDOW_MS
  for (const [ip, b] of _buckets) {
    if (b.lastRefillTs < cutoff) _buckets.delete(ip)
  }
}

/**
 * Take a token from the IP's bucket. Returns
 *   { ok: true,  remaining, resetSeconds }                        on success
 *   { ok: false, remaining, resetSeconds, retryAfterSeconds }     when limited
 * `remaining` is floor(tokens) AFTER the take (0 when limited).
 * `resetSeconds` is the seconds until the bucket would be back to full.
 */
function _takeToken(ip) {
  const now = Date.now()
  _pruneBuckets(now)
  let b = _buckets.get(ip)
  if (!b) {
    b = { tokens: RATE_LIMIT_PER_HOUR, lastRefillTs: now }
    _buckets.set(ip, b)
  } else {
    const elapsedSec = (now - b.lastRefillTs) / 1000
    if (elapsedSec > 0) {
      b.tokens = Math.min(RATE_LIMIT_PER_HOUR, b.tokens + elapsedSec * RATE_REFILL_PER_SEC)
      b.lastRefillTs = now
    }
  }
  if (b.tokens >= 1) {
    b.tokens -= 1
    const remaining = Math.max(0, Math.floor(b.tokens))
    const missing = RATE_LIMIT_PER_HOUR - b.tokens
    const resetSeconds = Math.max(0, Math.ceil(missing / RATE_REFILL_PER_SEC))
    return { ok: true, remaining, resetSeconds }
  }
  const deficit = 1 - b.tokens
  const retryAfterSeconds = Math.max(1, Math.ceil(deficit / RATE_REFILL_PER_SEC))
  const missing = RATE_LIMIT_PER_HOUR - b.tokens
  const resetSeconds = Math.max(0, Math.ceil(missing / RATE_REFILL_PER_SEC))
  return { ok: false, remaining: 0, resetSeconds, retryAfterSeconds }
}

function _bypassRateLimit(req) {
  const expected = process.env.PAPERFATE_INTERNAL_TOKEN
  if (!expected) return false
  const got = req.headers['x-paperfate-internal']
  return typeof got === 'string' && got === expected
}

// Allow ~5 minutes for full Q500 runs. Vercel Pro plan needed for >60s functions;
// on hobby plan this is best-effort and may time out for large requests.
export const config = {
  maxDuration: 300,
  runtime: 'nodejs',
}

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180').split(',').map(s => s.trim())

const MAX_BODY_BYTES = 256 * 1024
const READ_TIMEOUT_MS = 10000

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Request-Id',
    'Vary': 'Origin',
  }
}

function genRequestId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {}
  // Fallback: timestamp + random hex
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function bad(res, status, error, detail = undefined, requestId = undefined) {
  return res.status(status).json({
    error,
    ...(detail !== undefined && { detail }),
    ...(requestId !== undefined && { request_id: requestId }),
  })
}

function readBody(req) {
  // Vercel parses JSON when content-type is application/json
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
  // Fallback: collect stream with size cap + timeout
  const collect = new Promise((resolve, reject) => {
    let buf = ''
    let tooLarge = false
    req.on('data', (c) => {
      if (tooLarge) return
      buf += c
      if (buf.length > MAX_BODY_BYTES) {
        tooLarge = true
        const err = new Error('payload_too_large')
        err.code = 'PAYLOAD_TOO_LARGE'
        reject(err)
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      if (!buf) return resolve({})
      try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      const err = new Error('request_timeout')
      err.code = 'REQUEST_TIMEOUT'
      reject(err)
    }, READ_TIMEOUT_MS)
  })
  return Promise.race([collect, timeout])
}

// Validation: structural schema check applied AFTER readBody. Additive guard —
// the existing required-field checks below remain authoritative for back-compat
// error codes (missing_or_short_title / missing_or_short_abstract). This catches
// out-of-range / wrong-type optional fields BEFORE we hand them to the extractor.
const ALLOWED_MODES = new Set(['Q100', 'Q500', 'auto', 'abstract', 'full'])
function _isString(v) { return typeof v === 'string' }
function _isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v) }
function _isInteger(v) { return Number.isInteger(v) }
function _isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v) }

function validateForecastBody(body) {
  const errors = []
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ field: '', code: 'not_object', detail: 'body must be a JSON object' }] }
  }
  // title — required, 5..500
  if (!_isString(body.title)) {
    errors.push({ field: 'title', code: 'wrong_type', detail: 'must be string' })
  } else {
    const t = body.title.trim()
    if (t.length < 5)   errors.push({ field: 'title', code: 'too_short', detail: 'min length 5' })
    if (t.length > 500) errors.push({ field: 'title', code: 'too_long',  detail: 'max length 500' })
  }
  // abstract — required, 200..50000
  if (!_isString(body.abstract)) {
    errors.push({ field: 'abstract', code: 'wrong_type', detail: 'must be string' })
  } else {
    const a = body.abstract.trim()
    if (a.length < 200)   errors.push({ field: 'abstract', code: 'too_short', detail: 'min length 200' })
    if (a.length > 50000) errors.push({ field: 'abstract', code: 'too_long',  detail: 'max length 50000' })
  }
  // mode — optional enum
  if (body.mode !== undefined && body.mode !== null) {
    if (!_isString(body.mode) || !ALLOWED_MODES.has(body.mode)) {
      errors.push({ field: 'mode', code: 'invalid_enum', detail: "one of Q100|Q500|auto" })
    }
  }
  // article_type — optional string<=64
  if (body.article_type !== undefined && body.article_type !== null) {
    if (!_isString(body.article_type)) {
      errors.push({ field: 'article_type', code: 'wrong_type', detail: 'must be string' })
    } else if (body.article_type.length > 64) {
      errors.push({ field: 'article_type', code: 'too_long', detail: 'max length 64' })
    }
  }
  // methods/results/discussion/full_text — optional string<=100000
  for (const f of ['methods', 'results', 'discussion', 'full_text']) {
    const v = body[f]
    if (v === undefined || v === null) continue
    if (!_isString(v)) {
      errors.push({ field: f, code: 'wrong_type', detail: 'must be string' })
    } else if (v.length > 100000) {
      errors.push({ field: f, code: 'too_long', detail: 'max length 100000' })
    }
  }
  // authors — optional array<=50 OR string<=10000
  if (body.authors !== undefined && body.authors !== null) {
    if (Array.isArray(body.authors)) {
      if (body.authors.length > 50) {
        errors.push({ field: 'authors', code: 'too_many', detail: 'max 50 authors' })
      }
    } else if (_isString(body.authors)) {
      if (body.authors.length > 10000) {
        errors.push({ field: 'authors', code: 'too_long', detail: 'max length 10000' })
      }
    } else {
      errors.push({ field: 'authors', code: 'wrong_type', detail: 'must be array or string' })
    }
  }
  // year — optional integer 1900..2030
  if (body.year !== undefined && body.year !== null) {
    if (!_isInteger(body.year)) {
      errors.push({ field: 'year', code: 'wrong_type', detail: 'must be integer' })
    } else if (body.year < 1900 || body.year > 2030) {
      errors.push({ field: 'year', code: 'out_of_range', detail: 'must be in [1900, 2030]' })
    }
  }
  // first_affiliation — optional string<=500
  if (body.first_affiliation !== undefined && body.first_affiliation !== null) {
    if (!_isString(body.first_affiliation)) {
      errors.push({ field: 'first_affiliation', code: 'wrong_type', detail: 'must be string' })
    } else if (body.first_affiliation.length > 500) {
      errors.push({ field: 'first_affiliation', code: 'too_long', detail: 'max length 500' })
    }
  }
  // target_journal — optional object
  if (body.target_journal !== undefined && body.target_journal !== null) {
    if (!_isPlainObject(body.target_journal)) {
      errors.push({ field: 'target_journal', code: 'wrong_type', detail: 'must be object' })
    } else {
      const tj = body.target_journal
      if (tj.issn !== undefined && tj.issn !== null && !_isString(tj.issn)) {
        errors.push({ field: 'target_journal.issn', code: 'wrong_type', detail: 'must be string' })
      }
      if (tj.name !== undefined && tj.name !== null) {
        if (!_isString(tj.name)) {
          errors.push({ field: 'target_journal.name', code: 'wrong_type', detail: 'must be string' })
        } else if (tj.name.length > 200) {
          errors.push({ field: 'target_journal.name', code: 'too_long', detail: 'max length 200' })
        }
      }
      if (tj.jif !== undefined && tj.jif !== null && !_isFiniteNumber(tj.jif)) {
        errors.push({ field: 'target_journal.jif', code: 'wrong_type', detail: 'must be number' })
      }
    }
  }
  // author_features — optional object; all fields number; team_size_with_id integer 0..1000
  if (body.author_features !== undefined && body.author_features !== null) {
    if (!_isPlainObject(body.author_features)) {
      errors.push({ field: 'author_features', code: 'wrong_type', detail: 'must be object' })
    } else {
      for (const [k, v] of Object.entries(body.author_features)) {
        if (v === undefined || v === null) continue
        if (k === 'team_size_with_id') {
          if (!_isInteger(v)) {
            errors.push({ field: `author_features.${k}`, code: 'wrong_type', detail: 'must be integer' })
          } else if (v < 0 || v > 1000) {
            errors.push({ field: `author_features.${k}`, code: 'out_of_range', detail: 'must be in [0, 1000]' })
          }
        } else if (!_isFiniteNumber(v)) {
          errors.push({ field: `author_features.${k}`, code: 'wrong_type', detail: 'must be number' })
        }
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

function detectFailureReason(failedItems) {
  for (const it of failedItems) {
    const msg = String(it?._error_detail || it?.rationale_short || '')
    if (/API key not valid/i.test(msg)) return 'gemini_400_invalid_key'
  }
  for (const it of failedItems) {
    const msg = String(it?._error_detail || it?.rationale_short || '')
    if (/429|quota|rate.?limit/i.test(msg)) return 'rate_limited'
  }
  return 'unknown'
}

function sanitizeItems(extraction) {
  if (!extraction || !Array.isArray(extraction.items)) return { failed: [], errorMessages: [] }
  const failed = []
  const errorMessages = []
  for (const it of extraction.items) {
    if (!it || typeof it !== 'object') continue
    const rationale = String(it.rationale_short || '')
    const isFailed = !!it._error || /Batch failed|API key not valid/i.test(rationale)
    if (isFailed) {
      failed.push(it)
      const original = it.rationale_short
      if (original && !it._error_detail) it._error_detail = original
      if (original) errorMessages.push(String(original))
      it.rationale_short = 'LLM scoring unavailable — fell back to rule pre-pass for this item.'
    }
  }
  // Dedupe + cap to 10
  const seen = new Set()
  const dedupedErrors = []
  for (const m of errorMessages) {
    if (seen.has(m)) continue
    seen.add(m)
    dedupedErrors.push(m)
    if (dedupedErrors.length >= 10) break
  }
  return { failed, errorMessages: dedupedErrors }
}

export default async function handler(req, res) {
  const requestId = genRequestId()
  const origin = req.headers.origin || ''
  const headers = corsHeaders(origin)
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  // Mirror request_id in a header so consumers that only inspect headers
  // (browser fetch wrappers, edge logs) can correlate without parsing JSON.
  res.setHeader('X-Request-Id', requestId)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')   return bad(res, 405, 'method_not_allowed', undefined, requestId)

  // Rate limit BEFORE readBody so abusive clients can't waste bandwidth.
  // Internal bypass header (when env token is set) skips the bucket entirely.
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_PER_HOUR))
  if (_bypassRateLimit(req)) {
    res.setHeader('X-RateLimit-Bypass', 'true')
    // No bucket consumption: surface the full quota for observability.
    res.setHeader('X-RateLimit-Remaining', String(RATE_LIMIT_PER_HOUR))
    res.setHeader('X-RateLimit-Reset', '0')
  } else {
    const ip = _clientIp(req)
    const gate = _takeToken(ip)
    res.setHeader('X-RateLimit-Remaining', String(gate.remaining))
    res.setHeader('X-RateLimit-Reset', String(gate.resetSeconds))
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfterSeconds))
      return res.status(429).json({
        error: 'rate_limited',
        retry_after_seconds: gate.retryAfterSeconds,
        request_id: requestId,
      })
    }
  }

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    if (e && e.code === 'PAYLOAD_TOO_LARGE') {
      return bad(res, 413, 'payload_too_large', { max_bytes: MAX_BODY_BYTES }, requestId)
    }
    if (e && e.code === 'REQUEST_TIMEOUT') {
      return bad(res, 408, 'request_timeout', undefined, requestId)
    }
    return bad(res, 400, 'invalid_json', String(e.message || e), requestId)
  }

  // Structural schema validation (additive — runs BEFORE the legacy required
  // checks below so out-of-range optional fields surface as invalid_request
  // rather than silently flowing into the extractor).
  const _v = validateForecastBody(body)
  if (!_v.ok) {
    return bad(res, 400, 'invalid_request', { errors: _v.errors }, requestId)
  }

  const {
    title,
    abstract,
    methods,
    results,
    discussion,
    full_text,
    authors,
    year,
    first_affiliation,
    funder,
    funding,
    is_preprint,
    author_features,
    article_type = '*',
    mode = 'auto',
    target_journal,
  } = body || {}

  if (!title || typeof title !== 'string' || title.trim().length < 5)
    return bad(res, 400, 'missing_or_short_title', undefined, requestId)
  if (!abstract || typeof abstract !== 'string' || abstract.trim().length < 200)
    return bad(res, 400, 'missing_or_short_abstract', 'abstract must be ≥200 chars', requestId)

  // Cap per-section input length so each LLM call's prompt stays bounded.
  // Q500 forecasts iterate ~350-450 LLM items, each receiving the full
  // section block, so input tokens dominate latency. 8K chars per section
  // ≈ 2K tokens; manuscripts longer than this rarely add Q500-relevant
  // signal that isn't already in abstract + methods + results headers.
  const SECTION_CAP   = 8000
  const FULLTEXT_CAP  = 24000
  const cap = (s, n) => String(s || '').slice(0, n)

  // Track total body chars BEFORE capping for auto-mode short-body heuristic.
  const totalBodyChars =
    (methods?.length    || 0) +
    (results?.length    || 0) +
    (discussion?.length || 0) +
    (full_text?.length  || 0)

  const manuscript = {
    title: title.trim(),
    abstract: abstract.trim(),
    ...(methods    && { methods:    cap(methods,    SECTION_CAP) }),
    ...(results    && { results:    cap(results,    SECTION_CAP) }),
    ...(discussion && { discussion: cap(discussion, SECTION_CAP) }),
    ...(full_text  && { full_text:  cap(full_text,  FULLTEXT_CAP) }),
    ...((Array.isArray(authors) || typeof authors === 'string') && { authors }),
    ...(Number.isFinite(Number(year)) && { year: Number(year) }),
    ...(first_affiliation && { first_affiliation }),
    ...(funder && { funder }),
    ...(funding && { funding }),
    ...(typeof is_preprint === 'boolean' && { is_preprint }),
    ...(author_features && typeof author_features === 'object' && { author_features }),
  }

  const t0 = Date.now()
  try {
    let normalizedMode = mode === 'abstract' ? 'Q100' : mode === 'full' ? 'Q500' : mode
    // Auto-mode short body → force Q100 to avoid wasting LLM budget on missing sections.
    let autoDecision = null
    if (mode === 'auto' && totalBodyChars < 1500) {
      normalizedMode = 'Q100'
      autoDecision = 'Q100_short_body'
    }
    const hasLlmKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY)
    // Prefer LLM whenever a key is present so top-tier abstracts get differentiated
    // Q-scoring; only fall back to the deterministic rule pre-pass when no key is
    // configured OR the operator explicitly forces it via PAPERFATE_EXTRACTOR.
    const explicitMode = process.env.PAPERFATE_EXTRACTOR
    const useDeterministic =
      !hasLlmKey ||
      explicitMode === 'deterministic' ||
      explicitMode === 'codex_deterministic'
    // Vercel Pro plan: 300s budget. The real latency knob is the Gemini
    // client's RPM limit (default free-tier 9 = 6.67s gap between calls;
    // Q500's 44 sequential batches alone = 290s of forced gaps before any
    // LLM time). Paid tier supports 1k RPM; we run the client at 120 RPM
    // with batchSize 25 — Q500 needs ~14 batches × ~8s = ~110s.
    const isPaidGemini = process.env.GEMINI_PAID_TIER !== '0'
    const geminiOpts = {
      rpm:        Number(process.env.GEMINI_RPM) || (isPaidGemini ? 120 : 9),
      batchSize:  Number(process.env.GEMINI_BATCH_SIZE) || 25,
      isFreeTier: !isPaidGemini,
    }
    let extraction = useDeterministic
      ? forecastManuscriptDeterministic(manuscript, article_type, { mode: normalizedMode })
      : await forecastManuscript(manuscript, article_type, {
          mode: normalizedMode === 'auto' ? undefined : normalizedMode,
          concurrency: Number(process.env.PAPERFATE_CONCURRENCY) || 35,
          geminiOpts,
        })
    if (extraction) extraction.extractor_used = useDeterministic ? 'deterministic' : 'llm'

    // POST-PROCESS: graceful degradation + per-item sanitisation.
    if (extraction && !useDeterministic) {
      const { failed, errorMessages } = sanitizeItems(extraction)
      const attempted = Number(extraction.items_attempted) || (Array.isArray(extraction.items) ? extraction.items.length : 0)
      const scored = Number(extraction.items_scored)
      const failedRatio = attempted > 0 ? failed.length / Math.max(1, attempted) : 0
      const heavilyDegraded = (failedRatio > 0.5) || scored === 0
      if (heavilyDegraded) {
        // Re-run deterministic pre-pass and replace.
        const fallback = forecastManuscriptDeterministic(manuscript, article_type, {
          mode: normalizedMode === 'auto' ? undefined : normalizedMode,
        })
        if (fallback) {
          fallback.extraction_fallback_reason = 'llm_batch_failures'
          fallback.llm_health = {
            status: 'degraded',
            failed: failed.length,
            attempted,
            reason: detectFailureReason(failed),
          }
          if (errorMessages.length) fallback.llm_errors = errorMessages
          fallback.extractor_used = 'rule_fallback'
          extraction = fallback
        }
      } else {
        extraction.llm_health = {
          status: 'ok',
          failed: failed.length,
          attempted,
        }
        if (errorMessages.length) extraction.llm_errors = errorMessages
      }
    }

    if (extraction && autoDecision) extraction.auto_decision = autoDecision

    const inferenceOpts = {
      targetJournal: target_journal || {},
      authorFeatures: author_features || {},
    }
    const fatecore = predictFromExtraction(manuscript, extraction, inferenceOpts)

    // Rule-fallback runs lose access to the LLM's rubric judgement (NOVEL/INTERP/
    // framing items can't be regex-derived). Even at 100% deterministic coverage
    // the resulting forecast is structurally weaker than a healthy LLM run, so
    // cap the confidence the UI surfaces. This is independent of fatecoreInference's
    // coverage-ratio cap (which expects an LLM-shaped extraction).
    if (extraction?.extractor_used === 'rule_fallback' && fatecore && Number.isFinite(fatecore.confidence)) {
      fatecore.confidence = Math.min(fatecore.confidence, 0.30)
    }

    const suggestions = generateSuggestions(extraction, manuscript, fatecore, inferenceOpts)
    const jointCounterfactual = generateJointCounterfactual(extraction, manuscript, fatecore, suggestions, inferenceOpts)
    const wallMs = Date.now() - t0
    return res.status(200).json({
      ...extraction,
      ...fatecore,
      counterfactual_suggestions: suggestions,
      joint_counterfactual: jointCounterfactual,
      wall_ms: wallMs,
      server_version: '0.4.0',
      request_id: requestId,
    })
  } catch (e) {
    console.error('[forecast]', requestId, e)
    return res.status(500).json({ error: 'extraction_failed', request_id: requestId })
  }
}
