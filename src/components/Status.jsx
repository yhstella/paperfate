// PaperFate · Public status page.
//
// On mount, pings /api/status and renders the pretty-printed JSON. Then
// probes each public endpoint with a minimal payload and renders a
// green / amber / red badge per row based on HTTP code + (where it
// applies) the response's `extractor_used` field.
//
// Color rules per row:
//   - red    : network error or non-2xx response
//   - amber  : 2xx but extractor_used === 'deterministic' (degraded mode)
//              or otherwise-acknowledged graceful fallback
//   - green  : 2xx and no degraded signal
//
// Refresh button + 60s auto-refresh (toggleable). All probe text is
// minimal — no manuscript content is sent. The Q100 forecast probe uses
// a synthetic ≥200-char abstract just to satisfy validation; it is
// flagged as a probe via title 'paperfate status probe'.
//
// Accessibility:
//   - Whole region: role=region aria-label='PaperFate status'
//   - Each endpoint row: role=status (polite live region)
//   - Toggle/refresh buttons are real <button> elements with labels
//
// Telemetry: trackEvent('status_view') on mount, trackEvent('status_refresh')
// on every refresh (manual or automatic).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { trackEvent } from '../lib/telemetry.js'

const AUTO_REFRESH_MS = 60 * 1000

// Synthetic ≥200-char abstract for the forecast probe. We never send
// real user text from the status page.
const PROBE_ABSTRACT = (
  'PaperFate status probe. This is a synthetic abstract generated solely ' +
  'to exercise the /api/forecast Q100 path. It contains no real research ' +
  'content. Background. Methods. Results. Conclusions. We confirm that ' +
  'the probe payload satisfies the 200-character minimum length check ' +
  'enforced by the abstract validator on the server side.'
)

// Each probe describes one endpoint check. `run` returns
// { httpStatus, ok, degraded, raw, error? } so the renderer stays dumb.
const PROBES = [
  {
    key: 'forecast',
    label: '/api/forecast (Q100 probe)',
    async run() {
      const res = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'paperfate status probe',
          abstract: PROBE_ABSTRACT,
          mode: 'Q100',
          article_type: '*',
        }),
      })
      const raw = await safeJson(res)
      // /api/forecast graceful-degrades when Gemini is unavailable; it
      // exposes extractor_used so the UI can flag amber.
      const extractor = raw && (raw.extractor_used || (raw.meta && raw.meta.extractor_used))
      const degraded = extractor === 'deterministic'
      return { httpStatus: res.status, ok: res.ok, degraded, raw }
    },
  },
  {
    key: 'similar',
    label: '/api/similar',
    async run() {
      const res = await fetch('/api/similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'paperfate status probe',
          abstract: PROBE_ABSTRACT,
        }),
      })
      const raw = await safeJson(res)
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
  {
    key: 'journal-info',
    label: '/api/journal-info (NEJM)',
    async run() {
      const res = await fetch('/api/journal-info?issn=0028-4793', { method: 'GET' })
      const raw = await safeJson(res)
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
  {
    key: 'journals-search',
    label: '/api/journals-search',
    async run() {
      const res = await fetch('/api/journals-search?q=nejm&limit=1', { method: 'GET' })
      const raw = await safeJson(res)
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
  {
    key: 'references',
    label: '/api/references',
    async run() {
      const res = await fetch('/api/references', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dois: ['10.1056/NEJMoa2034577'] }),
      })
      const raw = await safeJson(res)
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
  {
    key: 'author-features',
    label: '/api/author-features',
    async run() {
      const res = await fetch('/api/author-features', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authors: ['Anthony S Fauci'] }),
      })
      const raw = await safeJson(res)
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
  {
    key: 'journal-compare',
    label: '/api/journal-compare',
    async run() {
      const res = await fetch('/api/journal-compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issns: ['0028-4793', '0140-6736'] }),
      })
      const raw = await safeJson(res)
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
  {
    key: 'abstract-quality',
    label: '/api/abstract-quality (Q100 probe)',
    async run() {
      const res = await fetch('/api/abstract-quality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'paperfate status probe',
          abstract: PROBE_ABSTRACT,
          article_type: '*',
        }),
      })
      const raw = await safeJson(res)
      // abstract-quality may also fall back to deterministic when Gemini
      // is unavailable; surface the same amber signal if present.
      const extractor = raw && (raw.extractor_used || (raw.meta && raw.meta.extractor_used))
      const degraded = extractor === 'deterministic'
      return { httpStatus: res.status, ok: res.ok, degraded, raw }
    },
  },
  {
    key: 'status',
    label: '/api/status',
    async run() {
      const res = await fetch('/api/status', { method: 'GET' })
      const raw = await safeJson(res)
      // 200 → green; anything else → red.
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
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
      // 503 with source:'unavailable' is a known graceful state (subset
      // file not yet populated) — surface as amber, not red.
      if (res.status === 503 && raw && raw.source === 'unavailable') {
        return { httpStatus: res.status, ok: true, degraded: true, raw }
      }
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
  {
    key: '_telemetry',
    label: '/api/_telemetry',
    async run() {
      const res = await fetch('/api/_telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'smoke_test', props: { from: 'status-page' } }),
      })
      // Telemetry returns 204 No Content — treat 204 as green explicitly
      // since res.ok is true for 204 but there is no body to parse.
      if (res.status === 204) {
        return { httpStatus: 204, ok: true, degraded: true, raw: null }
      }
      const raw = await safeJson(res)
      return { httpStatus: res.status, ok: res.ok, degraded: false, raw }
    },
  },
]

async function safeJson(res) {
  try { return await res.json() } catch { return null }
}

function badgeClass(state) {
  if (state === 'green') return 'bg-emerald-600/30 text-emerald-300 border-emerald-500/40'
  if (state === 'amber') return 'bg-amber-600/30 text-amber-200 border-amber-500/40'
  if (state === 'red')   return 'bg-rose-600/30 text-rose-200 border-rose-500/40'
  return 'bg-slate-700/40 text-slate-300 border-slate-600/40'
}

function badgeLabel(state) {
  if (state === 'green') return 'OK'
  if (state === 'amber') return 'Degraded'
  if (state === 'red')   return 'Down'
  return 'Checking…'
}

function deriveState(result) {
  if (!result) return 'pending'
  if (result.error) return 'red'
  if (!result.ok) return 'red'
  if (result.degraded) return 'amber'
  return 'green'
}

export default function Status() {
  // /api/status meta
  const [meta, setMeta] = useState(null)
  const [metaErr, setMetaErr] = useState(null)
  const [metaPending, setMetaPending] = useState(true)

  // Per-endpoint probe results, keyed by probe.key.
  const [probeResults, setProbeResults] = useState(() => {
    const init = {}
    for (const p of PROBES) init[p.key] = null
    return init
  })

  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null)

  // Guard against state updates after unmount.
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  // Fire 'status_view' once on mount.
  useEffect(() => {
    trackEvent('status_view')
  }, [])

  const runAll = useCallback(async (isAuto) => {
    if (!aliveRef.current) return
    trackEvent('status_refresh', { auto: !!isAuto })
    setMetaPending(true)
    setMetaErr(null)
    // Reset probe results so the row badges flip back to 'Checking…'.
    setProbeResults(() => {
      const init = {}
      for (const p of PROBES) init[p.key] = null
      return init
    })

    // /api/status first so the meta panel can render quickly.
    try {
      const res = await fetch('/api/status', { method: 'GET' })
      const raw = await safeJson(res)
      if (!aliveRef.current) return
      if (!res.ok || !raw) {
        setMeta(null)
        setMetaErr(`HTTP ${res.status}`)
      } else {
        setMeta(raw)
        setMetaErr(null)
      }
    } catch (e) {
      if (!aliveRef.current) return
      setMeta(null)
      setMetaErr(String((e && e.message) || e))
    } finally {
      if (aliveRef.current) setMetaPending(false)
    }

    // Run probes concurrently — each writes its own slot when it lands.
    await Promise.all(PROBES.map(async (p) => {
      let result
      try {
        result = await p.run()
      } catch (e) {
        result = { httpStatus: 0, ok: false, degraded: false, raw: null, error: String((e && e.message) || e) }
      }
      if (!aliveRef.current) return
      setProbeResults(prev => ({ ...prev, [p.key]: result }))
    }))

    if (aliveRef.current) setLastRefreshedAt(Date.now())
  }, [])

  // Initial check.
  useEffect(() => {
    runAll(false)
  }, [runAll])

  // Auto-refresh.
  useEffect(() => {
    if (!autoRefresh) return undefined
    const id = setInterval(() => { runAll(true) }, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [autoRefresh, runAll])

  const metaJsonPretty = useMemo(() => {
    if (metaPending && !meta) return null
    if (metaErr && !meta) return `// error: ${metaErr}`
    try { return JSON.stringify(meta, null, 2) } catch { return String(meta) }
  }, [meta, metaPending, metaErr])

  // Summary counts for the header strip.
  const counts = useMemo(() => {
    let green = 0, amber = 0, red = 0, pending = 0
    for (const p of PROBES) {
      const s = deriveState(probeResults[p.key])
      if (s === 'green') green++
      else if (s === 'amber') amber++
      else if (s === 'red') red++
      else pending++
    }
    return { green, amber, red, pending }
  }, [probeResults])

  // Initial-load fallback per the brief: until /api/status has returned
  // at least once, render a plain 'Loading…' so screen readers don't
  // announce a half-baked tree.
  const initialPending = metaPending && !meta && !metaErr

  return (
    <section
      role="region"
      aria-label="PaperFate status"
      className="mx-auto max-w-6xl px-4 sm:px-6 py-8"
    >
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">System status</h2>
          <p className="mt-1 text-xs text-slate-400">
            Live probes against every public PaperFate endpoint. Green is healthy,
            amber means the endpoint is up but running in degraded mode,
            red means the probe failed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded border px-2 py-0.5 ${badgeClass('green')}`}>{counts.green} OK</span>
          <span className={`rounded border px-2 py-0.5 ${badgeClass('amber')}`}>{counts.amber} degraded</span>
          <span className={`rounded border px-2 py-0.5 ${badgeClass('red')}`}>{counts.red} down</span>
          {counts.pending > 0 && (
            <span className={`rounded border px-2 py-0.5 ${badgeClass('pending')}`}>{counts.pending} checking</span>
          )}
          <button
            type="button"
            onClick={() => runAll(false)}
            className="rounded-md bg-fate-600 px-3 py-1.5 font-medium text-white hover:bg-fate-500 focus:outline-none focus:ring-2 focus:ring-fate-400"
            aria-label="Refresh status now"
          >
            Refresh
          </button>
          <label className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-ink-900 px-2 py-1 text-slate-300">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              aria-label="Auto-refresh every 60 seconds"
              className="h-3.5 w-3.5"
            />
            Auto-refresh (60s)
          </label>
        </div>
      </header>

      {initialPending ? (
        <div className="rounded-xl border border-white/10 bg-ink-900 p-6 text-sm text-slate-400">
          Loading…
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {/* /api/status meta panel */}
          <div className="rounded-xl border border-white/10 bg-ink-900 p-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-200">/api/status</h3>
            {metaErr && !meta && (
              <p className="text-xs text-rose-300" role="status">
                {metaErr}
              </p>
            )}
            {metaJsonPretty && (
              <pre className="max-h-80 overflow-auto rounded-md bg-black/40 p-3 text-[11px] leading-relaxed text-slate-200">
                {metaJsonPretty}
              </pre>
            )}
            {lastRefreshedAt && (
              <p className="mt-2 text-[11px] text-slate-500">
                Last refreshed {new Date(lastRefreshedAt).toLocaleTimeString()}
              </p>
            )}
          </div>

          {/* Endpoint probe rows */}
          <div className="rounded-xl border border-white/10 bg-ink-900 p-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Endpoint probes</h3>
            <ul className="divide-y divide-white/5">
              {PROBES.map((p) => {
                const result = probeResults[p.key]
                const state = deriveState(result)
                const httpStatus = result && result.httpStatus
                const errMsg = result && result.error
                return (
                  <li
                    key={p.key}
                    role="status"
                    className="flex items-center justify-between gap-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-slate-200">{p.label}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {state === 'pending' && 'Probing…'}
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
                      aria-label={`${p.label} ${badgeLabel(state)}`}
                    >
                      {badgeLabel(state)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}
