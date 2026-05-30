// PaperFate · POST /api/abstract-quality
//
// Pure Q100 abstract-only scorer. Forces mode='Q100' regardless of caller
// hints and strips everything except the rollup the abstract surface
// actually needs (no FateCore, no suggestions, no counterfactual).
//
// Request body:
//   {
//     title:        string,   // required (≥5 chars)
//     abstract:     string,   // required (≥200 chars)
//     article_type: string?,  // schema.json article_types, default "*"
//   }
//
// Response:
//   200 → {
//     overall_score,
//     domain_rollup,
//     key_weaknesses,
//     items,
//     items_attempted,
//     items_scored,
//     elapsed_ms,
//     server_version,
//     request_id,
//   }
//   4xx / 5xx → { error, detail }
//
// Rate limiting (best-effort, in-process token bucket):
//   60 requests / IP / hour. Vercel serverless is stateless across cold
//   starts so this only catches loops/abuse against a single warm
//   instance. OPTIONS preflight is never limited, and a request carrying
//   `x-paperfate-internal: $PAPERFATE_INTERNAL_TOKEN` (when the env var is
//   set) bypasses the bucket. On overflow: 429 with
//   { error: 'rate_limited', retry_after_seconds, request_id } plus a
//   Retry-After header. The bucket Map self-prunes every minute.

import { forecastManuscript } from '../src/server/extract.js'

// ── Rate limiter (in-memory token bucket) ─────────────────────────────────
const RATE_LIMIT_PER_HOUR = 60
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

export const config = { maxDuration: 60, runtime: 'nodejs' }

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

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

function bad(res, status, error, detail = undefined, requestId = undefined) {
  return res.status(status).json({
    error,
    ...(detail !== undefined && { detail }),
    ...(requestId !== undefined && { request_id: requestId }),
  })
}

// Validation: subset of forecast schema — only title, abstract, article_type
// are accepted by this endpoint. Additive guard; legacy required-field checks
// below remain authoritative for back-compat error codes.
function _isStringAQ(v) { return typeof v === 'string' }
function validateAbstractQualityBody(body) {
  const errors = []
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ field: '', code: 'not_object', detail: 'body must be a JSON object' }] }
  }
  if (!_isStringAQ(body.title)) {
    errors.push({ field: 'title', code: 'wrong_type', detail: 'must be string' })
  } else {
    const t = body.title.trim()
    if (t.length < 5)   errors.push({ field: 'title', code: 'too_short', detail: 'min length 5' })
    if (t.length > 500) errors.push({ field: 'title', code: 'too_long',  detail: 'max length 500' })
  }
  if (!_isStringAQ(body.abstract)) {
    errors.push({ field: 'abstract', code: 'wrong_type', detail: 'must be string' })
  } else {
    const a = body.abstract.trim()
    if (a.length < 200)   errors.push({ field: 'abstract', code: 'too_short', detail: 'min length 200' })
    if (a.length > 50000) errors.push({ field: 'abstract', code: 'too_long',  detail: 'max length 50000' })
  }
  if (body.article_type !== undefined && body.article_type !== null) {
    if (!_isStringAQ(body.article_type)) {
      errors.push({ field: 'article_type', code: 'wrong_type', detail: 'must be string' })
    } else if (body.article_type.length > 64) {
      errors.push({ field: 'article_type', code: 'too_long', detail: 'max length 64' })
    }
  }
  return { ok: errors.length === 0, errors }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      if (!buf) return resolve({})
      try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function newRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {}
  // Fallback: timestamp + random hex
  const rnd = Math.random().toString(16).slice(2, 10)
  return `req_${Date.now().toString(16)}_${rnd}`
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)

  // Generate request_id up front so every response (incl. 405/429) carries it
  // in both the JSON body and the X-Request-Id header.
  const request_id = newRequestId()
  res.setHeader('X-Request-Id', request_id)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')   return bad(res, 405, 'method_not_allowed')

  // Rate limit BEFORE readBody so abusive clients can't waste bandwidth.
  // Internal bypass header (when env token is set) skips the bucket entirely.
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_PER_HOUR))
  if (_bypassRateLimit(req)) {
    res.setHeader('X-RateLimit-Bypass', 'true')
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
        request_id,
      })
    }
  }

  let body
  try { body = await readBody(req) } catch (e) { return bad(res, 400, 'invalid_json', String(e.message || e), request_id) }

  // Structural schema validation (additive — runs BEFORE legacy required checks).
  const _v = validateAbstractQualityBody(body)
  if (!_v.ok) {
    return bad(res, 400, 'invalid_request', { errors: _v.errors }, request_id)
  }

  const { title, abstract, article_type = '*' } = body || {}

  if (!title || typeof title !== 'string' || title.trim().length < 5)
    return bad(res, 400, 'missing_or_short_title')
  if (!abstract || typeof abstract !== 'string' || abstract.trim().length < 200)
    return bad(res, 400, 'missing_or_short_abstract', 'abstract must be ≥200 chars')

  const manuscript = {
    title: title.trim(),
    abstract: abstract.trim(),
  }

  const t0 = Date.now()
  try {
    // Paid-tier Gemini: 120 RPM, batchSize 25.
    const geminiOpts = { rpm: 120, batchSize: 25, isFreeTier: false }
    const extraction = await forecastManuscript(manuscript, article_type, {
      mode: 'Q100',
      concurrency: Number(process.env.PAPERFATE_CONCURRENCY) || 35,
      geminiOpts,
    })
    const elapsed_ms = Date.now() - t0
    return res.status(200).json({
      overall_score:    extraction?.overall_score    ?? null,
      domain_rollup:    extraction?.domain_rollup    ?? null,
      key_weaknesses:   extraction?.key_weaknesses   ?? [],
      items:            extraction?.items            ?? [],
      items_attempted:  extraction?.items_attempted  ?? null,
      items_scored:     extraction?.items_scored     ?? null,
      elapsed_ms,
      server_version: '0.3.1',
      request_id,
    })
  } catch (e) {
    return bad(res, 500, 'extraction_failed', String(e.message || e))
  }
}
