// PaperFate · GET /api/status-stream
//
// Server-Sent Events status stream. Emits a small JSON record every 5s
// for up to 60s, then closes the connection. Clients use it as a cheap
// "is the server still healthy" pulse — no per-request work, no DB.
//
// Caveat: Vercel serverless functions are *not* a great fit for
// long-lived streams. The platform may buffer, may kill the function
// before maxDuration, and the client socket can vanish at any time
// (proxy timeouts, client navigation, mobile network flap). We treat
// every write defensively: if the socket is gone we bail out cleanly
// instead of throwing an unhandled error that would mark the
// invocation as failed.
//
// Fallback: a client that can't hold the SSE connection open can poll
// /api/status every few seconds for the same server_version /
// deploy_time information. The stream is a nice-to-have, not load-
// bearing.
//
// Headers per SSE spec:
//   Content-Type:    text/event-stream
//   Cache-Control:   no-cache
//   X-Accel-Buffering: no   (disables nginx/edge buffering)
//
// Record shape:
//   data: {"server_version":"0.4.0","deploy_time":"abc1234",
//          "timestamp":"2026-...","healthy":true,"server_now":...}\n\n

export const config = { maxDuration: 70, runtime: 'nodejs' }

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

const STREAM_INTERVAL_MS = 5000
const STREAM_DURATION_MS = 60000

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  const deploy_time = (sha && typeof sha === 'string' && sha.length >= 7)
    ? sha.slice(0, 7)
    : 'local'

  // SSE headers. Must be written before any data flushes.
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Connection', 'keep-alive')
  // Force header flush so EventSource on the client switches to OPEN
  // state right away, even before the first data record arrives.
  if (typeof res.flushHeaders === 'function') {
    try { res.flushHeaders() } catch { /* socket already gone */ }
  }

  let closed = false
  const markClosed = () => { closed = true }
  req.on('close', markClosed)
  req.on('error', markClosed)
  res.on('close', markClosed)
  res.on('error', markClosed)

  // Defensive write: if the underlying socket has been torn down (client
  // disconnected, edge proxy timed out, Vercel killed the function), a
  // write throws EPIPE / ERR_STREAM_WRITE_AFTER_END. Swallow it, mark
  // the stream closed, and let the loop exit on its own.
  const safeWrite = (payload) => {
    if (closed) return false
    try {
      const ok = res.write(`data: ${JSON.stringify(payload)}\n\n`)
      return ok !== false
    } catch {
      closed = true
      return false
    }
  }

  const buildRecord = () => {
    const now = Date.now()
    return {
      server_version: '0.4.0',
      deploy_time,
      timestamp: new Date(now).toISOString(),
      healthy: true,
      server_now: now,
    }
  }

  // First record immediately so the client sees liveness without
  // waiting a full 5s tick.
  safeWrite(buildRecord())

  const startedAt = Date.now()
  await new Promise((resolve) => {
    const tick = () => {
      if (closed) return resolve()
      const elapsed = Date.now() - startedAt
      if (elapsed >= STREAM_DURATION_MS) return resolve()
      if (!safeWrite(buildRecord())) return resolve()
      // Schedule next tick. setTimeout (not setInterval) so a slow
      // write doesn't queue up overlapping ticks.
      setTimeout(tick, STREAM_INTERVAL_MS)
    }
    setTimeout(tick, STREAM_INTERVAL_MS)
  })

  if (!closed) {
    try { res.end() } catch { /* already gone */ }
  }
}
