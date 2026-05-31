// PaperFate · POST /api/feedback
//
// In-app feedback sink. Accepts a tiny JSON payload from the floating
// FeedbackWidget and persists it to disk (best-effort) plus stdout.
//
// Body shape:
//   { rating: 1..5, text: string<=2000, email?: string, page_url?: string }
//
// Validation:
//   - rating must be an integer in [1,5]
//   - text must be a non-empty string up to 2000 chars
//   - email (optional) must match a permissive RFC-ish regex
//   - page_url (optional) is sliced to 512 chars
//
// Rate limit: 5 submissions per IP per rolling hour. No internal bypass
// — this is a low-volume endpoint and the bucket is cheap.
//
// Responses:
//   202 { received: true, request_id } on success
//   400 invalid_json / invalid_shape / invalid_rating / invalid_text / invalid_email
//   405 method_not_allowed
//   413 payload_too_large (>8KB body)
//   429 rate_limited (with Retry-After + retry_after_seconds)
//
// Persistence:
//   - Always console.log('[feedback]', json) so Vercel log capture sees it
//   - If PAPERFATE_FEEDBACK_LOG_PATH env is set, append a JSONL record
//     there. Failure to write disk falls back to console only.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export const config = { maxDuration: 5, runtime: 'nodejs' }

const BODY_MAX_BYTES = 8 * 1024
const TEXT_MAX = 2000
const EMAIL_MAX = 254
const URL_MAX = 512
// Conservative email pattern. Not RFC 5322 exhaustive, but rejects the
// usual mistakes (spaces, missing @, missing TLD) without over-fitting.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

function bad(res, status, error, request_id, detail) {
  const body = { error, request_id }
  if (detail !== undefined) body.detail = detail
  return res.status(status).json(body)
}

function newRequestId() {
  try {
    return crypto.randomUUID()
  } catch {
    return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
  }
}

// ── Rate limiter (5 submissions / IP / rolling hour) ─────────────────────
const RATE_LIMIT_PER_HOUR = 5
const RATE_WINDOW_MS = 60 * 60 * 1000
const _buckets = new Map() // ip → number[] of submission timestamps
let _lastPruneTs = 0
const PRUNE_INTERVAL_MS = 60 * 1000

function _clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff && typeof xff === 'string') {
    const first = xff.split(',')[0]?.trim()
    if (first) return first.slice(0, 64)
  }
  if (Array.isArray(xff) && xff.length > 0) {
    const first = String(xff[0]).split(',')[0]?.trim()
    if (first) return first.slice(0, 64)
  }
  const direct = (req.socket && req.socket.remoteAddress) || ''
  return String(direct).slice(0, 64) || 'unknown'
}

function _pruneBuckets(now) {
  if (now - _lastPruneTs < PRUNE_INTERVAL_MS) return
  _lastPruneTs = now
  for (const [ip, list] of _buckets) {
    const kept = list.filter(ts => now - ts < RATE_WINDOW_MS)
    if (kept.length === 0) _buckets.delete(ip)
    else _buckets.set(ip, kept)
  }
}

// Sliding-window check. Returns { ok, remaining, retryAfterSeconds }.
// On ok=true the timestamp is recorded so the next call sees the spend.
function _takeSlot(ip) {
  const now = Date.now()
  _pruneBuckets(now)
  const list = (_buckets.get(ip) || []).filter(ts => now - ts < RATE_WINDOW_MS)
  if (list.length >= RATE_LIMIT_PER_HOUR) {
    // Oldest entry will fall out at ts + RATE_WINDOW_MS; compute time until then.
    const oldest = list[0]
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000))
    _buckets.set(ip, list)
    return { ok: false, remaining: 0, retryAfterSeconds }
  }
  list.push(now)
  _buckets.set(ip, list)
  return { ok: true, remaining: RATE_LIMIT_PER_HOUR - list.length, retryAfterSeconds: 0 }
}

// ── Body parsing (size-capped) ────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      const serialised = (() => { try { return JSON.stringify(req.body) } catch { return '' } })()
      if (serialised.length > BODY_MAX_BYTES) {
        return reject(Object.assign(new Error('too_large'), { code: 'too_large' }))
      }
      return resolve(req.body)
    }
    let buf = ''
    let aborted = false
    req.on('data', (c) => {
      if (aborted) return
      buf += c
      if (buf.length > BODY_MAX_BYTES) {
        aborted = true
        reject(Object.assign(new Error('too_large'), { code: 'too_large' }))
      }
    })
    req.on('end', () => {
      if (aborted) return
      if (!buf) return resolve({})
      try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
    })
    req.on('error', (e) => { if (!aborted) reject(e) })
  })
}

// ── Persistence ──────────────────────────────────────────────────────────
function appendRecord(logPath, record) {
  try {
    const dir = path.dirname(logPath)
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n')
    return true
  } catch {
    return false
  }
}

// ── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)

  const request_id = newRequestId()
  res.setHeader('X-Request-Id', request_id)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed', request_id)

  // Rate limit BEFORE body read.
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_PER_HOUR))
  const ip = _clientIp(req)
  const gate = _takeSlot(ip)
  res.setHeader('X-RateLimit-Remaining', String(gate.remaining))
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfterSeconds))
    return res.status(429).json({
      error: 'rate_limited',
      retry_after_seconds: gate.retryAfterSeconds,
      request_id,
    })
  }

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    if (e && e.code === 'too_large') return bad(res, 413, 'payload_too_large', request_id)
    return bad(res, 400, 'invalid_json', request_id, String((e && e.message) || e))
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad(res, 400, 'invalid_shape', request_id)
  }

  // rating: integer 1..5
  const ratingRaw = body.rating
  const rating = Number(ratingRaw)
  if (!Number.isFinite(rating) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return bad(res, 400, 'invalid_rating', request_id)
  }

  // text: required string 1..2000
  const text = typeof body.text === 'string' ? body.text : ''
  const textTrim = text.trim()
  if (textTrim.length < 1 || text.length > TEXT_MAX) {
    return bad(res, 400, 'invalid_text', request_id)
  }

  // email: optional; if present must match regex
  let email = null
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    if (typeof body.email !== 'string' || body.email.length > EMAIL_MAX || !EMAIL_RE.test(body.email)) {
      return bad(res, 400, 'invalid_email', request_id)
    }
    email = body.email
  }

  const page_url = typeof body.page_url === 'string' ? body.page_url.slice(0, URL_MAX) : ''

  const record = {
    request_id,
    ts: Date.now(),
    rating,
    text: text.slice(0, TEXT_MAX),
    email,
    page_url,
    ip_hint: ip.slice(0, 64),
    ua: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 256) : '',
  }

  // Always log to stdout. Best-effort disk append when env path is set.
  try { console.log('[feedback]', JSON.stringify(record)) } catch {}
  const logPath = process.env.PAPERFATE_FEEDBACK_LOG_PATH
  if (logPath && typeof logPath === 'string' && logPath.length > 0) {
    appendRecord(logPath, record)
  }

  return res.status(202).json({ received: true, request_id })
}
