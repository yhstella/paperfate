// PaperFate · POST /api/webhook-receive
//
// Generic webhook receiver endpoint for future external integrations
// (e.g. GitHub repository_dispatch, Vercel deploy notifications,
// Codex Round 7 step-completion callbacks, manual ops triggers).
//
// This endpoint intentionally does NOT process the payload yet. It
// validates the source + shared secret, logs the envelope, and acks.
// Downstream processors can later tail the on-disk JSONL or stdout
// stream and act on the events.
//
// Request body shape:
//   { source: string, event: string, payload: object|array|primitive }
//
// Headers:
//   x-paperfate-webhook-secret: must match env PAPERFATE_WEBHOOK_SECRET
//
// Env:
//   PAPERFATE_WEBHOOK_SECRET    — required, unset => 503 webhook_disabled
//   PAPERFATE_WEBHOOK_SOURCES   — optional CSV override of allowed sources
//                                 (default: github,codex,vercel,manual)
//
// Responses:
//   202 { received: true, request_id, source, event }    on accept
//   400 invalid_json / invalid_shape / invalid_source
//   401 unauthorized                                     on missing/bad secret
//   405 method_not_allowed
//   413 payload_too_large                                (>4KB body)
//   503 webhook_disabled                                 (secret env unset)

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export const config = { maxDuration: 5, runtime: 'nodejs' }

const BODY_MAX_BYTES = 4 * 1024
const SOURCE_MAX = 32
const EVENT_MAX = 64

const DEFAULT_SOURCES = ['github', 'codex', 'vercel', 'manual']

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-paperfate-webhook-secret',
    'Vary': 'Origin',
  }
}

function bad(res, status, error, detail = undefined) {
  return res.status(status).json({ error, ...(detail !== undefined && { detail }) })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      const serialised = (() => { try { return JSON.stringify(req.body) } catch { return '' } })()
      if (serialised.length > BODY_MAX_BYTES) return reject(Object.assign(new Error('too_large'), { code: 'too_large' }))
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

function todayStamp(d = new Date()) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function resolveLogPath() {
  return `/tmp/paperfate-webhooks-${todayStamp()}.jsonl`
}

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

function allowedSources() {
  const raw = process.env.PAPERFATE_WEBHOOK_SOURCES
  if (!raw || typeof raw !== 'string') return DEFAULT_SOURCES
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return list.length > 0 ? list : DEFAULT_SOURCES
}

// Constant-time comparison to avoid leaking secret length / prefix via
// timing. Returns false on any length mismatch or non-string input.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  try { return crypto.timingSafeEqual(ab, bb) } catch { return false }
}

function newRequestId() {
  try { return crypto.randomUUID() } catch {
    return 'req_' + crypto.randomBytes(8).toString('hex')
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed')

  // Graceful 503 when the secret has not been provisioned in this env.
  // This lets the route exist in preview/dev deploys without trapping
  // misrouted traffic.
  const expected = process.env.PAPERFATE_WEBHOOK_SECRET
  if (!expected || typeof expected !== 'string' || expected.length === 0) {
    return bad(res, 503, 'webhook_disabled')
  }

  const hdr = req.headers['x-paperfate-webhook-secret']
  const provided = Array.isArray(hdr) ? (hdr[0] || '') : (hdr || '')
  if (!safeEqual(provided, expected)) {
    // NEVER echo the expected secret in the response.
    return bad(res, 401, 'unauthorized')
  }

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    if (e && e.code === 'too_large') return bad(res, 413, 'payload_too_large')
    return bad(res, 400, 'invalid_json', String((e && e.message) || e))
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad(res, 400, 'invalid_shape')
  }

  const source = typeof body.source === 'string' ? body.source.trim().toLowerCase() : ''
  const event = typeof body.event === 'string' ? body.event.trim() : ''
  if (!source || source.length > SOURCE_MAX) return bad(res, 400, 'invalid_shape')
  if (!event || event.length > EVENT_MAX) return bad(res, 400, 'invalid_shape')

  const sources = allowedSources()
  if (!sources.includes(source)) {
    return bad(res, 400, 'invalid_source', { allowed: sources })
  }

  const request_id = newRequestId()
  const record = {
    request_id,
    ts: Date.now(),
    source,
    event,
    payload: body.payload !== undefined ? body.payload : null,
  }

  try { console.log('[webhook]', JSON.stringify(record)) } catch {}
  // Best-effort disk write; failure does not block the ack since the
  // stdout line above is already captured by Vercel log capture.
  appendRecord(resolveLogPath(), record)

  return res.status(202).json({ received: true, request_id, source, event })
}
