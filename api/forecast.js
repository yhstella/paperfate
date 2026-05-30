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

import { forecastManuscript } from '../src/server/extract.js'
import { forecastManuscriptDeterministic } from '../src/server/deterministicExtract.js'
import { predictFromExtraction } from '../src/server/fatecoreInference.js'
import { generateSuggestions, generateJointCounterfactual } from '../src/server/suggestionEngine.js'
import crypto from 'node:crypto'

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

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')   return bad(res, 405, 'method_not_allowed', undefined, requestId)

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
