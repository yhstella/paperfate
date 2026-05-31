// PaperFate · Admin / operator diagnostics panel.
//
// This tab is intentionally hidden from regular users — App.jsx only
// adds it to the tab strip when the localStorage flag
// `paperfate.admin_mode === '1'` is set. Operators flip the flag in
// devtools, reload, and get a focused view that complements the public
// Status page:
//
//   1. Run health-check  — minimal probes against /api/status,
//      /api/forecast (tiny synthetic Q100 payload), and /api/extras-lookup.
//      Each row gets pass/warn/fail per the same colour rules Status uses
//      (red on non-2xx / network error, amber on graceful-degraded, green
//      otherwise).
//   2. Rate-limit status — re-runs a /api/forecast probe and surfaces the
//      X-RateLimit-Limit / Remaining / Reset response headers so the
//      operator can confirm the server is shipping the bucket headers.
//   3. Telemetry status   — wraps getTelemetryStatus() so the operator can
//      see why telemetry is (or isn't) flowing right now (DNT, GPC,
//      explicit opt-out, effective_enabled).
//   4. Service worker status — surfaces navigator.serviceWorker
//      .getRegistration() info: scope, the active/installing/waiting
//      states + scriptURL, and (when present) the SW's reported version.
//
// Round 15 additions (Worker V):
//   5. Recent telemetry summary — placeholder panel that explains the
//      production sink is server-side (console + file) and points the
//      operator at the local analyzer script. Production builds have no
//      queryable endpoint so we deliberately don't fetch anything.
//   6. Smoke history — reads the rolling array we persist under
//      localStorage 'paperfate.admin.smoke_history' and renders the most
//      recent N entries. 'Run smoke now' button runs the same probes as
//      the Round 14 health-check (no network POST anywhere new) and
//      appends a compact summary row to the history.
//   7. Cache stats — uses the Cache Storage API (caches.keys() →
//      cache.keys()) to surface every named cache + entry count. Useful
//      for confirming the SW pre-cache landed.
//
// Telemetry:
//   - trackEvent('admin_view')                  on mount
//   - trackEvent('admin_stats_view')            on mount (Round 15)
//   - trackEvent('admin_health_run')            on every health-check click
//   - trackEvent('admin_smoke_history_view')    on mount (Round 15)
//
// Accessibility: top-level <section role="region" aria-label="Admin
// diagnostics"> so screen readers announce the tab as a single landmark.

import { useCallback, useEffect, useRef, useState } from 'react'
import { trackEvent, getTelemetryStatus } from '../lib/telemetry.js'
import {
  DEFAULT_FLAGS,
  EVENT_NAME as FLAG_EVENT_NAME,
  STORAGE_KEY as FLAG_STORAGE_KEY,
  getAllFlags,
  resetFlags,
  setFlag,
} from '../lib/featureFlags.js'

// Same synthetic ≥200-char payload shape as Status.jsx so /api/forecast
// validation passes without us shipping any real manuscript content.
const PROBE_ABSTRACT = (
  'PaperFate admin diagnostic probe. This synthetic abstract exists ' +
  'solely to exercise the /api/forecast Q100 path with a payload that ' +
  'satisfies the 200-character minimum length check enforced by the ' +
  'server-side abstract validator. Background. Methods. Results. ' +
  'Conclusions. No real research content is transmitted.'
)

async function safeJson(res) {
  try { return await res.json() } catch { return null }
}

// Health-check rows. Each `run` returns { httpStatus, ok, degraded, raw,
// headers, error? } so the renderer stays stateless.
const HEALTH_ROWS = [
  {
    key: 'status',
    label: '/api/status',
    async run() {
      const res = await fetch('/api/status', { method: 'GET' })
      const raw = await safeJson(res)
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
  {
    key: 'forecast',
    label: '/api/forecast (Q100 probe)',
    async run() {
      const res = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'paperfate admin probe',
          abstract: PROBE_ABSTRACT,
          mode: 'Q100',
          article_type: '*',
        }),
      })
      const raw = await safeJson(res)
      const extractor = raw && (raw.extractor_used || (raw.meta && raw.meta.extractor_used))
      const degraded = extractor === 'deterministic'
      // Snapshot rate-limit headers off the same response so the
      // dedicated Rate-limit panel can show whatever the server sent
      // without firing a second probe.
      const headers = {
        limit: res.headers.get('X-RateLimit-Limit'),
        remaining: res.headers.get('X-RateLimit-Remaining'),
        reset: res.headers.get('X-RateLimit-Reset'),
      }
      return { httpStatus: res.status, ok: res.ok, degraded, raw, headers }
    },
  },
  {
    key: 'extras-lookup',
    label: '/api/extras-lookup',
    async run() {
      const res = await fetch('/api/extras-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doi: '10.1056/NEJMoa1504720' }),
      })
      const raw = await safeJson(res)
      // Mirror Status.jsx: 503 + source:'unavailable' is a known graceful
      // state (subset file not yet populated) — surface as amber.
      if (res.status === 503 && raw && raw.source === 'unavailable') {
        return { httpStatus: res.status, ok: true, degraded: true, raw }
      }
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
]

function badgeClass(state) {
  if (state === 'pass') return 'bg-emerald-600/30 text-emerald-300 border-emerald-500/40'
  if (state === 'warn') return 'bg-amber-600/30 text-amber-200 border-amber-500/40'
  if (state === 'fail') return 'bg-rose-600/30 text-rose-200 border-rose-500/40'
  return 'bg-slate-700/40 text-slate-300 border-slate-600/40'
}

function badgeLabel(state) {
  if (state === 'pass') return 'pass'
  if (state === 'warn') return 'warn'
  if (state === 'fail') return 'fail'
  return 'pending'
}

function deriveState(result) {
  if (!result) return 'pending'
  if (result.error) return 'fail'
  if (!result.ok) return 'fail'
  if (result.degraded) return 'warn'
  return 'pass'
}

// Pull rate-limit headers off the freshest forecast probe result so the
// dedicated panel doesn't need its own fetch.
function extractRateLimit(results) {
  const r = results && results['forecast']
  if (r && r.headers) return r.headers
  return { limit: null, remaining: null, reset: null }
}

// Format a service-worker registration into a flat shape the panel can
// render line-by-line. Defensive against undefined fields because every
// state below registration is optional.
async function describeServiceWorker() {
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      return { supported: false }
    }
    let reg = null
    try { reg = await navigator.serviceWorker.getRegistration() } catch { reg = null }
    const controller = navigator.serviceWorker.controller || null
    const out = {
      supported: true,
      controlling: !!controller,
      controller_script: controller && controller.scriptURL ? controller.scriptURL : null,
      registered: !!reg,
    }
    if (reg) {
      out.scope = reg.scope || null
      out.installing = reg.installing ? { state: reg.installing.state, scriptURL: reg.installing.scriptURL } : null
      out.waiting    = reg.waiting    ? { state: reg.waiting.state,    scriptURL: reg.waiting.scriptURL }    : null
      out.active     = reg.active     ? { state: reg.active.state,     scriptURL: reg.active.scriptURL }     : null
    }
    // Optional version probe: ask the active SW for its version. Many of
    // our SW builds reply { type: 'VERSION', version: '…' } to a
    // postMessage; if it doesn't, we just leave version null.
    out.version = null
    try {
      const target = (reg && (reg.active || reg.waiting || reg.installing)) || controller
      if (target && typeof MessageChannel === 'function') {
        const version = await new Promise((resolve) => {
          let done = false
          const channel = new MessageChannel()
          const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, 400)
          channel.port1.onmessage = (ev) => {
            if (done) return
            done = true
            clearTimeout(timer)
            const data = ev && ev.data
            if (data && typeof data === 'object' && typeof data.version === 'string') resolve(data.version)
            else resolve(null)
          }
          try { target.postMessage({ type: 'GET_VERSION' }, [channel.port2]) }
          catch { if (!done) { done = true; clearTimeout(timer); resolve(null) } }
        })
        if (version) out.version = version
      }
    } catch { /* ignore — version is best-effort */ }
    return out
  } catch (e) {
    return { supported: true, error: String((e && e.message) || e) }
  }
}

// ── Round 15 helpers ─────────────────────────────────────────────────
// All net-new functions live here so the original Round 14 code above
// stays byte-identical (helps `git blame` and future audits).

// localStorage key for the rolling smoke-result cache.
const SMOKE_HISTORY_KEY = 'paperfate.admin.smoke_history'
// How many entries we keep / show. The list is FIFO-trimmed on write.
const SMOKE_HISTORY_MAX = 20

// Defensive localStorage read — returns [] for any error (private mode,
// quota, JSON corruption, missing API in SSR previews, …).
function loadSmokeHistory() {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(SMOKE_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

// Append one entry, trim to SMOKE_HISTORY_MAX, persist. Swallows quota
// errors silently — smoke history is best-effort diagnostic data.
function appendSmokeHistory(entry) {
  try {
    if (typeof localStorage === 'undefined') return []
    const prev = loadSmokeHistory()
    const next = [...prev, entry].slice(-SMOKE_HISTORY_MAX)
    localStorage.setItem(SMOKE_HISTORY_KEY, JSON.stringify(next))
    return next
  } catch {
    return loadSmokeHistory()
  }
}

// Walk the Cache Storage API and return [{ name, entries }]. Empty
// array when caches aren't available (SSR, http://, older browsers,
// or when the user blocks storage).
async function describeCaches() {
  try {
    if (typeof caches === 'undefined' || !caches || typeof caches.keys !== 'function') {
      return { supported: false, items: [] }
    }
    const names = await caches.keys()
    const items = []
    for (const name of names) {
      let entries = null
      try {
        const c = await caches.open(name)
        const keys = await c.keys()
        entries = Array.isArray(keys) ? keys.length : null
      } catch {
        entries = null
      }
      items.push({ name, entries })
    }
    return { supported: true, items }
  } catch (e) {
    return { supported: true, items: [], error: String((e && e.message) || e) }
  }
}

// Same probe set the Round 14 health-check runs — used by the smoke
// button so the two views stay aligned (no second source of truth).
async function runSmokeProbes() {
  const out = {}
  await Promise.all(HEALTH_ROWS.map(async (row) => {
    let result
    try { result = await row.run() }
    catch (e) {
      result = { httpStatus: 0, ok: false, degraded: false, raw: null, error: String((e && e.message) || e) }
    }
    out[row.key] = deriveState(result)
  }))
  return out
}

export default function Admin() {
  // Per-row health-check results, keyed by HEALTH_ROWS[i].key.
  const [healthResults, setHealthResults] = useState(() => {
    const init = {}
    for (const row of HEALTH_ROWS) init[row.key] = null
    return init
  })
  const [running, setRunning] = useState(false)
  const [lastRunAt, setLastRunAt] = useState(null)

  // Telemetry status is a synchronous snapshot, refreshed whenever the
  // operator runs a health-check (cheap and lets them see opt-out flips
  // without leaving the tab).
  const [telemetryStatus, setTelemetryStatus] = useState(() => {
    try { return getTelemetryStatus() } catch { return null }
  })

  // Service-worker snapshot is async (we postMessage for the version) so
  // it lives in its own state slot and refreshes on mount + on click.
  const [swStatus, setSwStatus] = useState(null)

  // ── Round 15 state ────────────────────────────────────────────────
  // Smoke history is hydrated from localStorage on mount and kept in
  // React state so the panel re-renders after every 'Run smoke now'.
  const [smokeHistory, setSmokeHistory] = useState(() => loadSmokeHistory())
  const [smokeRunning, setSmokeRunning] = useState(false)
  // Cache Storage snapshot. null until the async probe finishes; shape
  // matches describeCaches()'s return.
  const [cacheStats, setCacheStats] = useState(null)

  // ── Worker IV state ───────────────────────────────────────────────
  // Feature-flag map. Hydrated from the lib (defaults merged with any
  // persisted overrides) and refreshed on any 'paperfate:flag-changed'
  // event so cross-tab / API-driven flips are reflected here.
  const [flags, setFlags] = useState(() => getAllFlags())

  // Guard against late setState after unmount (the health-check fan-out
  // and the SW version probe both await — without this guard a quick
  // tab switch leaks a React warning).
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  // Fire 'admin_view' once on mount and grab an initial SW snapshot.
  useEffect(() => {
    trackEvent('admin_view')
    describeServiceWorker().then((sw) => {
      if (aliveRef.current) setSwStatus(sw)
    })
  }, [])

  // Round 15: separate mount effect so the Round 14 effect above stays
  // untouched. Fires the two new analytics events + kicks the cache
  // probe. The smoke-history view event is fired here because the
  // panel renders unconditionally on mount.
  useEffect(() => {
    trackEvent('admin_stats_view')
    trackEvent('admin_smoke_history_view')
    describeCaches().then((cs) => {
      if (aliveRef.current) setCacheStats(cs)
    })
  }, [])

  // Refresh the cache snapshot — used by the 'Refresh' button under the
  // Cache stats panel.
  const refreshCacheStats = useCallback(async () => {
    const cs = await describeCaches()
    if (aliveRef.current) setCacheStats(cs)
  }, [])

  // Subscribe to feature-flag changes (both same-tab via our custom
  // event and cross-tab via the native storage event) so the toggle
  // panel always reflects the persisted truth — even when another tab
  // (or the console) flips a flag.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const refresh = () => {
      if (aliveRef.current) setFlags(getAllFlags())
    }
    const onFlagEvent = (e) => {
      const detail = e && e.detail
      if (detail && detail.all && typeof detail.all === 'object') {
        if (aliveRef.current) setFlags({ ...detail.all })
      } else {
        refresh()
      }
    }
    const onStorage = (e) => {
      if (!e || e.key !== FLAG_STORAGE_KEY) return
      refresh()
    }
    window.addEventListener(FLAG_EVENT_NAME, onFlagEvent)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(FLAG_EVENT_NAME, onFlagEvent)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // Toggle a single flag and fire the telemetry event. The lib
  // dispatches 'paperfate:flag-changed' which our subscription above
  // catches and writes back to state, so we don't setFlags() here.
  const toggleFlag = useCallback((name, nextValue) => {
    const value = nextValue === true
    setFlag(name, value)
    try { trackEvent('flag_toggle', { flag: name, value }) }
    catch { /* telemetry is best-effort */ }
  }, [])

  // Reset every flag to its DEFAULT_FLAGS value. We fire one
  // 'flag_toggle' event per flag whose effective value actually
  // changed, so downstream telemetry doesn't get a synthetic 'reset'
  // bucket it has to special-case.
  const onResetFlags = useCallback(() => {
    const before = getAllFlags()
    resetFlags()
    try {
      for (const key of Object.keys(DEFAULT_FLAGS)) {
        if (before[key] !== DEFAULT_FLAGS[key]) {
          trackEvent('flag_toggle', { flag: key, value: DEFAULT_FLAGS[key] === true })
        }
      }
    } catch { /* ignore */ }
  }, [])

  // Run the same probes as the Round 14 health-check, then append a
  // summary entry into localStorage. We intentionally don't POST
  // anywhere new — the task spec is explicit that 'Run smoke now'
  // re-uses the existing probes.
  const runSmokeNow = useCallback(async () => {
    if (!aliveRef.current || smokeRunning) return
    setSmokeRunning(true)
    let states = {}
    try { states = await runSmokeProbes() }
    catch { states = {} }
    if (!aliveRef.current) return
    const entry = {
      at: Date.now(),
      results: states,
    }
    const next = appendSmokeHistory(entry)
    if (aliveRef.current) {
      setSmokeHistory(next)
      setSmokeRunning(false)
    }
  }, [smokeRunning])

  const runHealthCheck = useCallback(async () => {
    if (!aliveRef.current) return
    trackEvent('admin_health_run')
    setRunning(true)
    // Reset row badges back to 'pending' so the operator sees motion.
    setHealthResults(() => {
      const init = {}
      for (const row of HEALTH_ROWS) init[row.key] = null
      return init
    })

    // Snapshot telemetry + SW state alongside the network probes so the
    // operator gets a single coherent moment-in-time view.
    try { setTelemetryStatus(getTelemetryStatus()) } catch { /* ignore */ }
    describeServiceWorker().then((sw) => {
      if (aliveRef.current) setSwStatus(sw)
    })

    await Promise.all(HEALTH_ROWS.map(async (row) => {
      let result
      try {
        result = await row.run()
      } catch (e) {
        result = { httpStatus: 0, ok: false, degraded: false, raw: null, error: String((e && e.message) || e) }
      }
      if (!aliveRef.current) return
      setHealthResults(prev => ({ ...prev, [row.key]: result }))
    }))

    if (aliveRef.current) {
      setLastRunAt(Date.now())
      setRunning(false)
    }
  }, [])

  const rateLimit = extractRateLimit(healthResults)

  return (
    <section
      role="region"
      aria-label="Admin diagnostics"
      className="mx-auto max-w-6xl px-4 sm:px-6 py-8"
    >
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Admin diagnostics</h2>
          <p className="mt-1 text-xs text-slate-400">
            Operator-only panel. Toggle via{' '}
            <code className="rounded bg-black/40 px-1 py-0.5 text-[11px]">
              localStorage.setItem(&apos;paperfate.admin_mode&apos;, &apos;1&apos;)
            </code>{' '}
            and reload.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={runHealthCheck}
            disabled={running}
            className="rounded-md bg-fate-600 px-3 py-1.5 font-medium text-white hover:bg-fate-500 focus:outline-none focus:ring-2 focus:ring-fate-400 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Run health-check"
          >
            {running ? 'Running…' : 'Run health-check'}
          </button>
          {lastRunAt && (
            <span className="text-[11px] text-slate-500">
              Last run {new Date(lastRunAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Health-check rows */}
        <div className="rounded-xl border border-white/10 bg-ink-900 p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Health-check</h3>
          <ul className="divide-y divide-white/5">
            {HEALTH_ROWS.map((row) => {
              const result = healthResults[row.key]
              const state = deriveState(result)
              const httpStatus = result && result.httpStatus
              const errMsg = result && result.error
              return (
                <li
                  key={row.key}
                  className="flex items-center justify-between gap-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-slate-200">{row.label}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {state === 'pending' && (running ? 'Probing…' : 'Not run yet')}
                      {state !== 'pending' && (
                        <>
                          HTTP {httpStatus || '—'}
                          {result && result.degraded && ' · degraded mode'}
                          {errMsg && ` · ${errMsg}`}
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded border px-2 py-0.5 ${badgeClass(state)}`}
                    aria-label={`${row.label} ${badgeLabel(state)}`}
                  >
                    {badgeLabel(state)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Rate-limit status — sourced from the most recent forecast probe */}
        <div className="rounded-xl border border-white/10 bg-ink-900 p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Rate-limit status</h3>
          <p className="mb-2 text-[11px] text-slate-500">
            Headers from the most recent <code>/api/forecast</code> probe.
          </p>
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-slate-500">X-RateLimit-Limit</dt>
              <dd className="font-mono text-slate-200">{rateLimit.limit || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Remaining</dt>
              <dd className="font-mono text-slate-200">{rateLimit.remaining || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Reset</dt>
              <dd className="font-mono text-slate-200">{rateLimit.reset || '—'}</dd>
            </div>
          </dl>
        </div>

        {/* Telemetry status */}
        <div className="rounded-xl border border-white/10 bg-ink-900 p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Telemetry status</h3>
          {telemetryStatus ? (
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-slate-500">DNT</dt>
                <dd className="font-mono text-slate-200">{String(telemetryStatus.dnt)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">GPC</dt>
                <dd className="font-mono text-slate-200">{String(telemetryStatus.gpc)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">User opt-out</dt>
                <dd className="font-mono text-slate-200">{String(telemetryStatus.optOut)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Effective</dt>
                <dd className="font-mono text-slate-200">
                  {telemetryStatus.effective_enabled ? 'enabled' : 'disabled'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-slate-400">Telemetry module unavailable.</p>
          )}
        </div>

        {/* Service worker status */}
        <div className="rounded-xl border border-white/10 bg-ink-900 p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Service worker status</h3>
          {!swStatus && (
            <p className="text-xs text-slate-400">Probing…</p>
          )}
          {swStatus && !swStatus.supported && (
            <p className="text-xs text-slate-400">Not supported in this browser.</p>
          )}
          {swStatus && swStatus.supported && (
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-slate-500">Registered</dt>
                <dd className="font-mono text-slate-200">{String(!!swStatus.registered)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Controlling</dt>
                <dd className="font-mono text-slate-200">{String(!!swStatus.controlling)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Scope</dt>
                <dd className="truncate font-mono text-slate-200" title={swStatus.scope || ''}>
                  {swStatus.scope || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Version</dt>
                <dd className="font-mono text-slate-200">{swStatus.version || '—'}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-slate-500">Active</dt>
                <dd className="truncate font-mono text-slate-200">
                  {swStatus.active
                    ? `${swStatus.active.state} · ${swStatus.active.scriptURL || ''}`
                    : '—'}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-slate-500">Waiting</dt>
                <dd className="truncate font-mono text-slate-200">
                  {swStatus.waiting
                    ? `${swStatus.waiting.state} · ${swStatus.waiting.scriptURL || ''}`
                    : '—'}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-slate-500">Installing</dt>
                <dd className="truncate font-mono text-slate-200">
                  {swStatus.installing
                    ? `${swStatus.installing.state} · ${swStatus.installing.scriptURL || ''}`
                    : '—'}
                </dd>
              </div>
              {swStatus.error && (
                <div className="col-span-2">
                  <dt className="text-slate-500">Error</dt>
                  <dd className="font-mono text-rose-300">{swStatus.error}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      </div>

      {/* ── Round 15 panels ─────────────────────────────────────── */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {/* Recent telemetry summary — placeholder by design */}
        <div
          role="region"
          aria-label="Recent telemetry summary"
          className="rounded-xl border border-white/10 bg-ink-900 p-4"
        >
          <h3 className="mb-2 text-sm font-semibold text-slate-200">
            Recent telemetry summary
          </h3>
          <p className="text-xs text-slate-400">
            Telemetry summary unavailable in this environment. Run{' '}
            <code className="rounded bg-black/40 px-1 py-0.5 text-[11px]">
              scripts/analyze-telemetry.mjs
            </code>{' '}
            locally with the Vercel log export.
          </p>
          <p className="mt-2 text-[11px] text-slate-500">
            The production sink is server-side (console + file) and has
            no queryable endpoint, so this panel intentionally does not
            fetch.
          </p>
        </div>

        {/* Smoke history — local cache of past 'Run smoke now' results */}
        <div
          role="region"
          aria-label="Smoke history"
          className="rounded-xl border border-white/10 bg-ink-900 p-4"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Smoke history</h3>
            <button
              type="button"
              onClick={runSmokeNow}
              disabled={smokeRunning}
              className="rounded-md bg-fate-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-fate-500 focus:outline-none focus:ring-2 focus:ring-fate-400 disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Run smoke now"
            >
              {smokeRunning ? 'Running…' : 'Run smoke now'}
            </button>
          </div>
          <p className="mb-2 text-[11px] text-slate-500">
            Last {SMOKE_HISTORY_MAX} entries cached locally in{' '}
            <code className="rounded bg-black/40 px-1 py-0.5 text-[11px]">
              localStorage.paperfate.admin.smoke_history
            </code>
            .
          </p>
          {smokeHistory.length === 0 ? (
            <p className="text-xs text-slate-400">No smoke runs recorded yet.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {smokeHistory.slice().reverse().map((entry, i) => {
                const at = entry && entry.at
                const results = (entry && entry.results) || {}
                return (
                  <li
                    key={`${at || 'na'}-${i}`}
                    className="flex items-center justify-between gap-3 py-1.5 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[11px] text-slate-300">
                        {at ? new Date(at).toLocaleString() : '—'}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1">
                      {HEALTH_ROWS.map((row) => {
                        const state = results[row.key] || 'pending'
                        return (
                          <span
                            key={row.key}
                            className={`rounded border px-1.5 py-0.5 text-[10px] ${badgeClass(state)}`}
                            title={`${row.label}: ${badgeLabel(state)}`}
                          >
                            {row.key.replace(/^\//, '')}:{badgeLabel(state)}
                          </span>
                        )
                      })}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Cache stats — Cache Storage API */}
        <div
          role="region"
          aria-label="Cache storage stats"
          className="rounded-xl border border-white/10 bg-ink-900 p-4 md:col-span-2"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Cache stats</h3>
            <button
              type="button"
              onClick={refreshCacheStats}
              className="rounded-md border border-white/10 bg-ink-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-ink-700 focus:outline-none focus:ring-2 focus:ring-fate-400"
              aria-label="Refresh cache stats"
            >
              Refresh
            </button>
          </div>
          {!cacheStats && (
            <p className="text-xs text-slate-400">Probing…</p>
          )}
          {cacheStats && !cacheStats.supported && (
            <p className="text-xs text-slate-400">
              Cache Storage API unavailable in this environment.
            </p>
          )}
          {cacheStats && cacheStats.supported && cacheStats.items.length === 0 && (
            <p className="text-xs text-slate-400">No caches present.</p>
          )}
          {cacheStats && cacheStats.supported && cacheStats.items.length > 0 && (
            <ul className="divide-y divide-white/5">
              {cacheStats.items.map((c) => (
                <li
                  key={c.name}
                  className="flex items-center justify-between gap-3 py-1.5 text-xs"
                >
                  <div className="min-w-0 flex-1 truncate font-mono text-slate-200" title={c.name}>
                    {c.name}
                  </div>
                  <div className="shrink-0 font-mono text-slate-400">
                    {c.entries == null ? '—' : `${c.entries} entr${c.entries === 1 ? 'y' : 'ies'}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {cacheStats && cacheStats.error && (
            <p className="mt-2 font-mono text-[11px] text-rose-300">{cacheStats.error}</p>
          )}
        </div>
      </div>

      {/* ── Worker IV: feature flags ───────────────────────────── */}
      <div className="mt-4">
        <div
          role="region"
          aria-label="Feature flags"
          className="rounded-xl border border-white/10 bg-ink-900 p-4"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Feature flags</h3>
            <button
              type="button"
              onClick={onResetFlags}
              className="rounded-md border border-white/10 bg-ink-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-ink-700 focus:outline-none focus:ring-2 focus:ring-fate-400"
              aria-label="Reset feature flags to defaults"
            >
              Reset to defaults
            </button>
          </div>
          <p className="mb-3 text-[11px] text-slate-500">
            Client-side overrides stored in{' '}
            <code className="rounded bg-black/40 px-1 py-0.5 text-[11px]">
              localStorage.{FLAG_STORAGE_KEY}
            </code>
            . Changes apply immediately and broadcast via{' '}
            <code className="rounded bg-black/40 px-1 py-0.5 text-[11px]">
              {FLAG_EVENT_NAME}
            </code>
            .
          </p>
          <ul className="divide-y divide-white/5">
            {Object.keys(DEFAULT_FLAGS).map((name) => {
              const value = flags[name] === true
              const defaultValue = DEFAULT_FLAGS[name] === true
              const overridden = value !== defaultValue
              return (
                <li
                  key={name}
                  className="flex items-center justify-between gap-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-slate-200">{name}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      default: {String(defaultValue)}
                      {overridden && ' · overridden'}
                    </div>
                  </div>
                  <label
                    className="inline-flex shrink-0 cursor-pointer items-center gap-2"
                    aria-label={`Toggle ${name}`}
                  >
                    <span
                      className={`font-mono text-[11px] ${value ? 'text-emerald-300' : 'text-slate-400'}`}
                    >
                      {value ? 'on' : 'off'}
                    </span>
                    <span
                      className={`relative inline-block h-5 w-9 rounded-full transition-colors ${value ? 'bg-emerald-600/70' : 'bg-slate-600/60'}`}
                    >
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={value}
                        onChange={(e) => toggleFlag(name, e.target.checked)}
                        aria-label={`${name} feature flag`}
                      />
                      <span
                        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-4' : 'translate-x-0'} peer-focus-visible:ring-2 peer-focus-visible:ring-fate-400`}
                        aria-hidden="true"
                      />
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </section>
  )
}
