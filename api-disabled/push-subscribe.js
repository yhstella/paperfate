// PaperFate · POST /api/push-subscribe
//
// Receives a Web Push subscription record from the browser and stores
// it best-effort to a JSONL file on disk so a future server-side
// delivery job (web-push, VAPID-signed POST to each endpoint) can fan
// out notifications later. This sprint covers ONLY the receive-and-store
// side — there is no outbound delivery code anywhere in the repo yet.
//
// Production-safe by default:
//   - If PAPERFATE_PUSH_ENABLED env is unset (or '0' / 'false'), returns
//     503 'push_disabled' so the client knows to back off.
//   - Otherwise validates shape, generates a request_id, and appends a
//     JSONL line to /tmp/paperfate-subscriptions-<YYYY-MM-DD>.jsonl (or
//     the path in PAPERFATE_PUSH_SUBS_PATH).
//
// Request body shape (from src/lib/pushNotifications.js):
//   { endpoint: string, keys: { p256dh: string, auth: string }, expirationTime?: number|null }
//
// Responses:
//   202 { accepted:true, request_id }
//   400 invalid_json / invalid_shape
//   413 payload_too_large (>8KB body — endpoints can be long)
//   405 method_not_allowed
//   503 push_disabled

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export const config = { maxDuration: 5, runtime: 'nodejs' }

const BODY_MAX_BYTES = 8 * 1024
const ENDPOINT_MAX = 2048
const KEY_MAX = 256

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

function bad(res, status, error, detail = undefined) {
  return res.status(status).json({ error, ...(detail !== undefined && { detail }) })
}

function pushEnabled() {
  const raw = process.env.PAPERFATE_PUSH_ENABLED
  if (!raw || typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v.length > 0 && v !== '0' && v !== 'false' && v !== 'off' && v !== 'no'
}

// Read the raw body so we can size-cap before JSON parsing. Mirrors the
// pattern in telemetry-beacon.js since Vercel doesn't always populate
// req.body for application/json POSTs from fetch().
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

function todayStamp(d = new Date()) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function resolveLogPath() {
  const env = process.env.PAPERFATE_PUSH_SUBS_PATH
  if (env && typeof env === 'string' && env.length > 0) return env
  return `/tmp/paperfate-subscriptions-${todayStamp()}.jsonl`
}

function validString(s, max) {
  return typeof s === 'string' && s.length > 0 && s.length <= max
}

function validateShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid_shape'
  if (!validString(body.endpoint, ENDPOINT_MAX)) return 'invalid_shape'
  // Endpoint must look like an absolute https:// URL — push services
  // never serve over plain http and never use relative paths.
  if (!/^https:\/\//i.test(body.endpoint)) return 'invalid_shape'
  const keys = body.keys
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return 'invalid_shape'
  if (!validString(keys.p256dh, KEY_MAX)) return 'invalid_shape'
  if (!validString(keys.auth, KEY_MAX)) return 'invalid_shape'
  return null
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

function newRequestId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {}
  try {
    return crypto.randomBytes(16).toString('hex')
  } catch {
    return `req_${Date.now()}_${Math.floor(Math.random() * 1e9)}`
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed')

  if (!pushEnabled()) return bad(res, 503, 'push_disabled')

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    if (e && e.code === 'too_large') return bad(res, 413, 'payload_too_large')
    return bad(res, 400, 'invalid_json', String((e && e.message) || e))
  }

  const shapeError = validateShape(body)
  if (shapeError) return bad(res, 400, shapeError)

  const request_id = newRequestId()
  const record = {
    ts: Date.now(),
    request_id,
    endpoint: body.endpoint,
    keys: {
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    },
    expirationTime: Number.isFinite(+body.expirationTime) ? +body.expirationTime : null,
  }

  // Best-effort disk write. Mirror to stdout so log capture still has
  // the record if the volume is read-only / missing.
  const wrote = appendRecord(resolveLogPath(), record)
  if (!wrote) {
    try { console.log('[push-subscribe]', JSON.stringify(record)) } catch {}
  }

  return res.status(202).json({ accepted: true, request_id })
}
