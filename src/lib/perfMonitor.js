// PaperFate · Long-task + LCP performance monitor.
//
// Wires the PerformanceObserver API to our existing trackEvent() beacon
// so we can see, in aggregate, when the main thread blocks for >50ms
// (jank) and when the page actually paints its biggest hero element
// (perceived load). Both signals are cheap to collect — the browser
// already emits them — but they're invisible to us until we forward
// them to telemetry.
//
// Design notes
// ------------
// * SSR-safe: every entry point bails immediately when window /
//   PerformanceObserver are not available. The module can be imported
//   from anywhere without risk.
// * Idempotent: init() can be called multiple times; subsequent calls
//   are no-ops until dispose() is called. React StrictMode (which
//   double-mounts effects in dev) therefore can't double-register
//   observers.
// * Throttled long-task reporting: a busy page can emit hundreds of
//   long-task entries within seconds. We cap reporting at
//   LONGTASK_MAX_EVENTS per page load (default 10) to avoid drowning
//   the telemetry beacon. Once the cap is hit we silently stop
//   forwarding; we do NOT disconnect the observer, because a future
//   dispose() still wants the buffered count.
// * LCP fires multiple times by spec — every time a larger element
//   paints, a new entry lands. We only forward the FIRST one (the
//   typical "above-the-fold hero painted" moment); later entries are
//   ignored. This matches what most RUM tools do.
// * All telemetry side-effects are wrapped in try/catch. A telemetry
//   failure must never crash the host app.

import { trackEvent } from './telemetry.js'

const LONGTASK_MAX_EVENTS = 10

// Module-level state. We keep this in module scope (not in a closure
// returned from init) so dispose() can find the observers no matter
// who calls it.
let _initialised = false
let _longTaskObserver = null
let _lcpObserver = null
let _longTaskCount = 0
let _lcpReported = false

function isBrowser() {
  return typeof window !== 'undefined'
    && typeof PerformanceObserver !== 'undefined'
}

function supportedEntryTypes() {
  try {
    const types = PerformanceObserver.supportedEntryTypes
    return Array.isArray(types) ? types : []
  } catch {
    return []
  }
}

function safeDisconnect(obs) {
  if (!obs) return
  try { obs.disconnect() } catch { /* ignore */ }
}

function elementTag(entry) {
  // LCP entries expose the painted DOM node via `element`. We surface
  // only the lowercase tag name — never an id, class, or text content —
  // to keep the payload small and PII-free.
  try {
    const el = entry && entry.element
    if (el && typeof el.tagName === 'string') {
      return el.tagName.toLowerCase()
    }
  } catch { /* ignore */ }
  return ''
}

function handleLongTask(list) {
  try {
    const entries = list.getEntries()
    for (let i = 0; i < entries.length; i++) {
      if (_longTaskCount >= LONGTASK_MAX_EVENTS) return
      const entry = entries[i]
      const duration = Number(entry && entry.duration)
      if (!Number.isFinite(duration) || duration <= 0) continue
      _longTaskCount += 1
      try {
        trackEvent('perf_long_task', {
          duration_ms_rounded: Math.round(duration),
          name: typeof entry.name === 'string' ? entry.name.slice(0, 64) : '',
        })
      } catch { /* swallow — telemetry must never throw */ }
    }
  } catch { /* ignore */ }
}

function handleLcp(list) {
  try {
    if (_lcpReported) return
    const entries = list.getEntries()
    if (!entries || entries.length === 0) return
    // Use the most recent entry — by spec LCP updates as larger
    // elements paint, so the latest entry is the current LCP candidate.
    // We mark _lcpReported immediately so subsequent updates are
    // ignored (we only want the first LCP signal per page load).
    const entry = entries[entries.length - 1]
    const value = Number(
      entry && (entry.renderTime || entry.startTime || entry.loadTime)
    )
    if (!Number.isFinite(value) || value <= 0) return
    _lcpReported = true
    try {
      trackEvent('perf_lcp', {
        value_ms: Math.round(value),
        element_tag: elementTag(entry),
      })
    } catch { /* swallow */ }
  } catch { /* ignore */ }
}

export function init() {
  if (_initialised) return
  if (!isBrowser()) return
  _initialised = true
  _longTaskCount = 0
  _lcpReported = false

  const types = supportedEntryTypes()

  // Long-task observer. Not all browsers support 'longtask' (Safari
  // historically lagged), so we feature-detect first.
  if (types.indexOf('longtask') !== -1) {
    try {
      _longTaskObserver = new PerformanceObserver(handleLongTask)
      // `buffered: true` flushes any long-tasks that fired before this
      // observer attached (e.g. during initial React mount).
      _longTaskObserver.observe({ type: 'longtask', buffered: true })
    } catch {
      _longTaskObserver = null
    }
  }

  // LCP observer. Same feature-detect dance.
  if (types.indexOf('largest-contentful-paint') !== -1) {
    try {
      _lcpObserver = new PerformanceObserver(handleLcp)
      _lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true })
    } catch {
      _lcpObserver = null
    }
  }
}

export function dispose() {
  safeDisconnect(_longTaskObserver)
  safeDisconnect(_lcpObserver)
  _longTaskObserver = null
  _lcpObserver = null
  _initialised = false
  _longTaskCount = 0
  _lcpReported = false
}

// Test-only inspector. Exposed so unit tests can assert state without
// reaching into module internals via hacks. Not part of the public
// runtime API — production callers should ignore it.
export function __getStateForTests() {
  return {
    initialised: _initialised,
    longTaskCount: _longTaskCount,
    lcpReported: _lcpReported,
    hasLongTaskObserver: _longTaskObserver !== null,
    hasLcpObserver: _lcpObserver !== null,
  }
}
