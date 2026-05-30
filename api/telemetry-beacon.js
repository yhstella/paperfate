// PaperFate · POST /api/telemetry-beacon
//
// Minimal one-shot beacon sink for client telemetry. Events are
// appended to a rotating JSONL log on disk (best-effort) and also
// emitted to stdout with a '[telemetry]' prefix so Vercel log capture
// continues to work as a fallback. No DB, no third-party analytics.
//
// On Vercel the default sink (/tmp/paperfate-telemetry-<YYYY-MM-DD>.jsonl)
// is ephemeral — production should wire TELEMETRY_LOG_PATH to a
// persistent volume mount. If the disk write fails for any reason we
// still log to console and return 204.
//
// Request body shape (from src/lib/telemetry.js):
//   { name: string<=64, props: object, ts: number, url: string, ua_summary: string }
//
// Responses:
//   204 No Content on accepted beacon
//   400 invalid_json / invalid_shape
//   413 payload_too_large (>4KB body)
//   405 method_not_allowed for non-POST (OPTIONS preflight handled separately)

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export const config = { maxDuration: 5, runtime: 'nodejs' }

const BODY_MAX_BYTES = 4 * 1024
const NAME_MAX = 64
const ROTATE_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const IP_HASH_LEN = 16

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

// Read the raw body so we can size-cap before JSON parsing. We can't
// rely on req.body being pre-parsed since sendBeacon sends a Blob with
// application/json content-type and Vercel's node runtime doesn't
// always populate req.body for it.
function readBody(req) {
  return new Promise((resolve, reject) => {
    // If the runtime already parsed it, fall through fast.
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
  const env = process.env.TELEMETRY_LOG_PATH
  if (env && typeof env === 'string' && env.length > 0) return env
  return `/tmp/paperfate-telemetry-${todayStamp()}.jsonl`
}

// Best-effort size-based rotation. If the existing file exceeds the
// threshold, rename it to <path>.1 (overwriting any prior rotation) and
// continue with a fresh file. Any failure here is swallowed so the
// caller can still attempt the append.
function maybeRotate(logPath) {
  try {
    const st = fs.statSync(logPath)
    if (st && st.size > ROTATE_MAX_BYTES) {
      const rotated = `${logPath}.1`
      try { fs.rmSync(rotated, { force: true }) } catch {}
      fs.renameSync(logPath, rotated)
    }
  } catch (e) {
    // ENOENT is expected for a fresh file; ignore everything else too.
  }
}

function ipHash(req) {
  try {
    const salt = process.env.TELEMETRY_SALT || ''
    const xff = req.headers['x-forwarded-for']
    let first = ''
    if (typeof xff === 'string' && xff.length > 0) {
      first = xff.split(',')[0].trim()
    } else if (Array.isArray(xff) && xff.length > 0) {
      first = String(xff[0]).split(',')[0].trim()
    }
    if (!first) return ''
    return crypto.createHash('sha256').update(first + salt).digest('hex').slice(0, IP_HASH_LEN)
  } catch {
    return ''
  }
}

function appendRecord(logPath, record) {
  try {
    const dir = path.dirname(logPath)
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    maybeRotate(logPath)
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n')
    return true
  } catch {
    return false
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed')

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
  const name = typeof body.name === 'string' ? body.name : ''
  if (!name || name.length > NAME_MAX) return bad(res, 400, 'invalid_shape')

  const record = {
    ts: Number.isFinite(+body.ts) ? +body.ts : Date.now(),
    name,
    props: body.props && typeof body.props === 'object' ? body.props : {},
    ua_summary: typeof body.ua_summary === 'string' ? body.ua_summary.slice(0, 32) : '',
    ip_hash: ipHash(req),
    url: typeof body.url === 'string' ? body.url.slice(0, 512) : '',
  }

  // Best-effort disk write. On failure we fall back to console so log
  // capture still has the event, and we always return 204 either way.
  const wrote = appendRecord(resolveLogPath(), record)
  if (!wrote) {
    try { console.log('[telemetry]', JSON.stringify(record)) } catch {}
  }

  return res.status(204).end()
}
