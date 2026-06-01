// PaperFate · shared API copy-resistance guard
//
// Lives under src/server/ (NOT api/) so Vercel never registers it as a
// serverless function — it is import-only. Endpoints call origin-check +
// rate-limit through this single module so the policy stays consistent.
//
// Policy (the "balanced" copy-resistance tier):
//   - Origin enforcement: if a request carries an Origin header that is NOT
//     in the allowlist, reject 403. Missing Origin (curl, server-to-server,
//     some beacons) is allowed through — the rate limiter is its backstop.
//     Origin is forgeable, so this is first-line friction, not a wall.
//   - Allowlist: env PAPERFATE_ALLOWED_ORIGINS (comma-sep) OR the default
//     below, which now includes the canonical www host and *.vercel.app
//     preview deploys so we never break our own surfaces.
//   - Rate limit: per-IP token bucket, per warm instance (best-effort —
//     Vercel runs many instances, so this caps a single hammering client
//     rather than global volume). Internal bypass via PAPERFATE_INTERNAL_TOKEN.

const DEFAULT_ALLOWED = [
  'https://paperfate.com',
  'https://www.paperfate.com',
  'http://localhost:5180',
  'http://127.0.0.1:5180',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

export function allowedOrigins() {
  const env = process.env.PAPERFATE_ALLOWED_ORIGINS
  return env ? env.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_ALLOWED
}

// Exact match, or *.vercel.app preview suffix (https only).
export function isOriginAllowed(origin, list = allowedOrigins()) {
  if (!origin) return true // missing Origin is not a cross-origin browser attack
  if (list.includes(origin)) return true
  try {
    const u = new URL(origin)
    if (u.protocol === 'https:' && u.hostname.endsWith('.vercel.app')) return true
  } catch { /* malformed Origin → not allowed */ }
  return false
}

// CORS headers. ACAO is only echoed for an allowed Origin; absent otherwise.
export function corsHeaders(origin, methods = 'POST, OPTIONS') {
  const h = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, X-Paperfate-Internal',
    'Vary': 'Origin',
  }
  if (origin && isOriginAllowed(origin)) h['Access-Control-Allow-Origin'] = origin
  return h
}

// Returns true and writes a 403 if the request's Origin is present but
// disallowed. Returns false (caller proceeds) when allowed or Origin-less.
export function blockDisallowedOrigin(req, res, requestId = undefined) {
  const origin = req.headers?.origin || ''
  if (origin && !isOriginAllowed(origin)) {
    res.status(403).json({
      error: 'origin_not_allowed',
      ...(requestId !== undefined && { request_id: requestId }),
    })
    return true
  }
  return false
}

export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for']
  if (xff && typeof xff === 'string') {
    const first = xff.split(',')[0]?.trim()
    if (first) return first.slice(0, 64)
  }
  const real = req.headers?.['x-real-ip']
  if (real && typeof real === 'string') return real.trim().slice(0, 64)
  return 'unknown'
}

export function internalBypass(req) {
  const expected = process.env.PAPERFATE_INTERNAL_TOKEN
  if (!expected) return false
  const got = req.headers?.['x-paperfate-internal']
  return typeof got === 'string' && got === expected
}

// Token-bucket factory. Each endpoint owns its own bucket map + cap.
//   const limiter = createRateLimiter(120) // 120 req / IP / hour
//   const { ok, remaining, resetSeconds, retryAfterSeconds } = limiter.take(ip)
export function createRateLimiter(perHour) {
  const WINDOW_MS = 60 * 60 * 1000
  const REFILL_PER_SEC = perHour / 3600
  const PRUNE_INTERVAL_MS = 60 * 1000
  const buckets = new Map()
  let lastPrune = 0

  function prune(now) {
    if (now - lastPrune < PRUNE_INTERVAL_MS) return
    lastPrune = now
    const cutoff = now - WINDOW_MS
    for (const [ip, b] of buckets) if (b.lastRefillTs < cutoff) buckets.delete(ip)
  }

  return {
    limit: perHour,
    take(ip, now = Date.now()) {
      prune(now)
      let b = buckets.get(ip)
      if (!b) {
        b = { tokens: perHour, lastRefillTs: now }
        buckets.set(ip, b)
      } else {
        const elapsedSec = (now - b.lastRefillTs) / 1000
        if (elapsedSec > 0) {
          b.tokens = Math.min(perHour, b.tokens + elapsedSec * REFILL_PER_SEC)
          b.lastRefillTs = now
        }
      }
      if (b.tokens >= 1) {
        b.tokens -= 1
        return {
          ok: true,
          remaining: Math.floor(b.tokens),
          resetSeconds: Math.ceil((perHour - b.tokens) / REFILL_PER_SEC),
        }
      }
      const deficit = 1 - b.tokens
      return {
        ok: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(deficit / REFILL_PER_SEC)),
        resetSeconds: Math.ceil((perHour - b.tokens) / REFILL_PER_SEC),
      }
    },
  }
}

// Convenience: apply rate-limit + standard headers to a response. Returns
// true and writes 429 if exhausted. Always sets X-RateLimit-* headers.
export function applyRateLimit(req, res, limiter, requestId = undefined) {
  if (internalBypass(req)) {
    res.setHeader('X-RateLimit-Bypass', 'true')
    return false
  }
  const ip = clientIp(req)
  const r = limiter.take(ip)
  res.setHeader('X-RateLimit-Limit', String(limiter.limit))
  res.setHeader('X-RateLimit-Remaining', String(r.remaining))
  res.setHeader('X-RateLimit-Reset', String(r.resetSeconds))
  if (!r.ok) {
    res.setHeader('Retry-After', String(r.retryAfterSeconds))
    res.status(429).json({
      error: 'rate_limited',
      retry_after_seconds: r.retryAfterSeconds,
      ...(requestId !== undefined && { request_id: requestId }),
    })
    return true
  }
  return false
}
