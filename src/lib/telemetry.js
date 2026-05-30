// PaperFate · Minimal privacy-respecting client telemetry.
//
// Single export `trackEvent(name, props)` fires a one-shot beacon to
// POST /api/_telemetry. Uses navigator.sendBeacon when available, falls
// back to fetch with keepalive:true. Safe in SSR (no-op when navigator
// is undefined). All errors are swallowed — telemetry MUST NEVER throw
// into the host app.
//
// We deliberately do NOT pull in any third-party analytics SDK, and we
// deliberately keep the payload tiny:
//   - `name` is bounded to 64 chars
//   - `props` JSON serialised payload is capped at 1KB
//   - manuscript text is never sent (caller responsibility, but we also
//     refuse any oversized props string)
//
// Internal sampling: SAMPLING_RATE knob (0..1). Default 1.0 = sampling
// off, every call is sent.

const ENDPOINT = '/api/_telemetry'
const NAME_MAX = 64
const PROPS_MAX_BYTES = 1024

// Sampling threshold. 1.0 means every call is sent. Lower values
// probabilistically drop events. Change this knob if/when volume forces
// us to sample on the client.
const SAMPLING_RATE = 1.0

function uaSummary(ua) {
  if (typeof ua !== 'string' || !ua) return ''
  // Keep it short — just enough to coarsely bucket UA in logs.
  // We avoid the full UA string to limit fingerprinting surface.
  let bucket = 'other'
  if (/Mobi|Android|iPhone|iPad/.test(ua)) bucket = 'mobile'
  else if (/Mac OS X|Macintosh/.test(ua)) bucket = 'mac'
  else if (/Windows/.test(ua)) bucket = 'windows'
  else if (/Linux/.test(ua)) bucket = 'linux'
  return bucket
}

function safeStringify(obj) {
  try { return JSON.stringify(obj) } catch { return '' }
}

function byteLength(str) {
  if (typeof str !== 'string') return 0
  if (typeof TextEncoder !== 'undefined') {
    try { return new TextEncoder().encode(str).length } catch { /* ignore */ }
  }
  // Rough fallback: each char is 1-4 bytes; assume worst case isn't
  // worth simulating, just use char length as a conservative lower
  // bound — we'll still pass the cap check for ASCII-heavy payloads.
  return str.length
}

export function trackEvent(name, props) {
  try {
    // SSR / non-browser guard.
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return

    // Sampling.
    if (SAMPLING_RATE < 1.0 && Math.random() >= SAMPLING_RATE) return

    // Name validation.
    if (typeof name !== 'string' || !name) return
    const safeName = name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name

    // Props validation — must be a plain object and must serialise to
    // <=PROPS_MAX_BYTES bytes. If too big we drop the event entirely
    // (better silent loss than truncating a half-event of unknown shape).
    let safeProps = {}
    if (props && typeof props === 'object') {
      const serialised = safeStringify(props)
      if (!serialised) return
      if (byteLength(serialised) > PROPS_MAX_BYTES) return
      safeProps = props
    }

    const payload = {
      name: safeName,
      props: safeProps,
      ts: Date.now(),
      url: typeof location !== 'undefined' && location && location.href ? String(location.href).slice(0, 512) : '',
      ua_summary: uaSummary(typeof navigator !== 'undefined' && navigator.userAgent),
    }

    const body = safeStringify(payload)
    if (!body) return

    // Prefer sendBeacon — it's purpose-built for one-shot fire-and-forget.
    if (typeof navigator.sendBeacon === 'function') {
      try {
        const blob = typeof Blob !== 'undefined'
          ? new Blob([body], { type: 'application/json' })
          : body
        const ok = navigator.sendBeacon(ENDPOINT, blob)
        if (ok) return
        // fall through to fetch fallback if sendBeacon refused (e.g. quota)
      } catch { /* fall through */ }
    }

    // Fallback: fetch with keepalive so it survives page unload.
    if (typeof fetch === 'function') {
      try {
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
          credentials: 'omit',
        }).catch(() => { /* swallow */ })
      } catch { /* swallow */ }
    }
  } catch {
    // Telemetry must never bubble. Swallow everything.
  }
}
