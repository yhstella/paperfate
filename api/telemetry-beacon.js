// PaperFate · POST /api/telemetry-beacon
//
// Minimal one-shot beacon sink for client telemetry. We deliberately
// avoid any DB writes — events are dumped to stdout with a
// '[telemetry]' prefix and harvested via Vercel log capture. This keeps
// the endpoint cheap, dependency-free, and easy to retire if we ever
// move to a real analytics pipeline.
//
// Request body shape (from src/lib/telemetry.js):
//   { name: string<=64, props: object, ts: number, url: string, ua_summary: string }
//
// Responses:
//   204 No Content on accepted beacon
//   400 invalid_json / invalid_shape
//   413 payload_too_large (>4KB body)
//   405 method_not_allowed for non-POST (OPTIONS preflight handled separately)

export const config = { maxDuration: 5, runtime: 'nodejs' }

const BODY_MAX_BYTES = 4 * 1024
const NAME_MAX = 64

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

  // Best-effort log line. We intentionally keep this on console.log so
  // Vercel's log capture is the only sink — no DB, no third-party
  // analytics, no extra dependencies.
  try {
    console.log('[telemetry]', JSON.stringify({
      name,
      props: body.props && typeof body.props === 'object' ? body.props : {},
      ts: Number.isFinite(+body.ts) ? +body.ts : Date.now(),
      url: typeof body.url === 'string' ? body.url.slice(0, 512) : '',
      ua_summary: typeof body.ua_summary === 'string' ? body.ua_summary.slice(0, 32) : '',
    }))
  } catch {
    // logging must never fail the handler
  }

  return res.status(204).end()
}
