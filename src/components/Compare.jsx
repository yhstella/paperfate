import { useEffect, useMemo, useRef, useState } from 'react'
import { trackEvent } from '../lib/telemetry.js'

const ISSN_RE = /^\d{4}-\d{3}[\dxX]$/
const PLACEHOLDER = 'NEJM, Lancet, JAMA, Annals of Internal Medicine'

const ROWS = [
  { key: 'name',          label: 'Journal name' },
  { key: 'publisher',     label: 'Publisher' },
  { key: 'jif',           label: 'JIF',                       fmt: fmtNumber },
  { key: 'jcr_quartile',  label: 'JCR quartile' },
  { key: 'oa_status',     label: 'Open access' },
  { key: 'apc_usd',       label: 'APC (USD)',                 fmt: fmtMoney },
  { key: 'h_index',       label: 'h-index',                   fmt: fmtInt },
  { key: 'scope',         label: 'Scope' },
]

function fmtNumber(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(1) : '—'
}
function fmtInt(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.round(n)) : '—'
}
function fmtMoney(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function splitEntries(raw) {
  if (!raw || !raw.trim()) return { issns: [], names: [] }
  const tokens = raw
    .split(/[\n;,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5)
  const issns = []
  const names = []
  for (const t of tokens) {
    if (ISSN_RE.test(t)) issns.push(t)
    else names.push(t)
  }
  return { issns, names }
}

export default function Compare() {
  const [raw, setRaw] = useState('')
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const formRef = useRef(null)

  const parsed = useMemo(() => splitEntries(raw), [raw])
  const tokenCount = parsed.issns.length + parsed.names.length
  const canSubmit = tokenCount >= 2 && tokenCount <= 5 && status !== 'loading'

  // Fire compare_open exactly once on mount.
  useEffect(() => {
    trackEvent('compare_open')
  }, [])

  async function onSubmit(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault()
    if (!canSubmit) return
    setStatus('loading')
    setError(null)
    setData(null)
    trackEvent('compare_submit', {
      n_issns: parsed.issns.length,
      n_names: parsed.names.length,
    })
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
    try {
      const res = await fetch('/api/journal-compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issns: parsed.issns, names: parsed.names }),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        // Surface HTTP status to the catch block via Error.cause-like marker.
        const err = new Error(`HTTP ${res.status}${txt ? ` — ${txt.slice(0, 160)}` : ''}`)
        err.__status = res.status
        throw err
      }
      const json = await res.json()
      const journals = Array.isArray(json.journals) ? json.journals : []
      if (!journals.length) {
        const err = new Error('No matching journals were returned.')
        err.__status = 'empty'
        throw err
      }
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
      trackEvent('compare_result_ok', {
        wall_ms: Math.max(0, Math.round(t1 - t0)),
        n_journals_returned: journals.length,
      })
      setData(journals)
      setStatus('done')
    } catch (err) {
      const code = (err && err.__status != null) ? err.__status : 'network_error'
      trackEvent('compare_result_error', { http_status_or_code: code })
      setError(err.message || 'Comparison failed')
      setStatus('error')
    }
  }

  function loadSample() {
    trackEvent('compare_sample_load')
    setRaw(PLACEHOLDER)
  }

  function onTextareaKeyDown(e) {
    // Ctrl+Enter (or Cmd+Enter on mac) submits.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (canSubmit) onSubmit(e)
      return
    }
    // Escape clears the textarea.
    if (e.key === 'Escape') {
      e.preventDefault()
      setRaw('')
    }
  }

  return (
    <section id="compare" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">Compare venues</h2>
          <p className="mt-3 text-slate-400">
            Drop 2–5 journals — by name or ISSN — and see JIF, quartile, OA status,
            APC, h-index, and scope side-by-side. Useful for shortlisting a target
            before you run the simulator.
          </p>
          <div className="mt-6 text-xs text-slate-500">
            Try a sample:
            <button
              type="button"
              onClick={loadSample}
              aria-label="Load sample journals: NEJM, Lancet, JAMA, Annals"
              className="ml-2 rounded-md border border-fate-400/30 bg-fate-400/[0.06] px-2.5 py-1 text-xs text-fate-300 hover:bg-fate-400/[0.12] transition-colors"
            >
              NEJM · Lancet · JAMA · Annals
            </button>
          </div>
        </div>

        <form ref={formRef} onSubmit={onSubmit} className="card p-5 sm:p-6 lg:col-span-3">
          <div className="space-y-4">
            <label className="block" htmlFor="compare-journals-input">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Journals (2–5, comma or newline)
                </span>
                <span className="text-[11px] text-slate-500" aria-hidden="true">
                  {tokenCount}/5 · {parsed.issns.length} ISSN · {parsed.names.length} name
                </span>
              </div>
              <textarea
                id="compare-journals-input"
                value={raw}
                onChange={e => setRaw(e.target.value)}
                onKeyDown={onTextareaKeyDown}
                rows={3}
                placeholder={PLACEHOLDER}
                aria-label="Journals to compare — enter 2 to 5 names or ISSNs separated by comma or newline. Press Ctrl+Enter to submit, Escape to clear."
                aria-describedby="compare-token-summary compare-input-hint"
                className="input resize-y leading-relaxed"
              />
              <span id="compare-token-summary" className="sr-only">
                {tokenCount} of 5 entries: {parsed.issns.length} ISSN, {parsed.names.length} name.
              </span>
            </label>

            {tokenCount > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="Parsed entries">
                {parsed.issns.map(s => (
                  <span key={`i-${s}`} className="chip border-emerald-400/30 text-emerald-300/90 bg-emerald-400/[0.06]">
                    ISSN · {s}
                  </span>
                ))}
                {parsed.names.map(s => (
                  <span key={`n-${s}`} className="chip border-fate-400/30 text-fate-300 bg-fate-400/[0.06]">
                    {s}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <div id="compare-input-hint" className="text-[11px] text-slate-500">
                Matches /\d{'{4}'}-\d{'{3}'}[\dxX]/ go to ISSN lookup. Everything else is name-matched.
              </div>
              <button
                type="submit"
                disabled={!canSubmit}
                aria-label="Compare selected journals"
                className="btn-primary shrink-0"
              >
                {status === 'loading' ? 'Comparing…' : 'Compare'}
              </button>
            </div>

            {tokenCount > 0 && tokenCount < 2 && (
              <div className="rounded-md border border-amber-400/20 bg-amber-400/[0.04] p-2.5 text-[11px] text-amber-200">
                Add at least one more journal — comparisons need 2 entries minimum.
              </div>
            )}
            {tokenCount > 5 && (
              <div className="rounded-md border border-amber-400/20 bg-amber-400/[0.04] p-2.5 text-[11px] text-amber-200">
                Only the first 5 entries will be used.
              </div>
            )}
          </div>
        </form>
      </div>

      <div className="mt-10 scroll-mt-24">
        {status === 'loading' && <CompareSkeleton />}
        {status === 'error' && (
          <div
            role="alert"
            aria-live="assertive"
            className="card p-6 text-sm text-amber-200"
          >
            <div className="font-semibold mb-1">Comparison failed</div>
            <div className="text-amber-200 text-[13px]">{error}</div>
          </div>
        )}
        {status === 'done' && data && data.length > 0 && (
          <CompareTable journals={data} />
        )}
      </div>
    </section>
  )
}

function CompareTable({ journals }) {
  return (
    <div className="card p-5 sm:p-6 animate-fade-up overflow-x-auto">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          Side-by-side comparison
        </div>
        <span className="chip">{journals.length} journals</span>
      </div>
      <table
        className="min-w-full border-separate border-spacing-0 text-sm"
        aria-label="Side-by-side journal comparison"
      >
        <caption className="sr-only">
          Comparison of {journals.length} journals across {ROWS.length} metrics including JIF, JCR quartile, open access status, APC, h-index, and scope.
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 bg-ink-800/80 backdrop-blur-sm text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-3 py-2 border-b border-white/5"
            >
              Metric
            </th>
            {journals.map((j, i) => (
              <th
                key={`h-${i}`}
                scope="col"
                className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-300 px-3 py-2 border-b border-white/5 min-w-[160px]"
              >
                {j.name || j.issn || `Journal ${i + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(row => (
            <tr key={row.key} className="hover:bg-white/[0.02]">
              <th
                scope="row"
                className="sticky left-0 bg-ink-800/80 backdrop-blur-sm align-top px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500 border-b border-white/5"
              >
                {row.label}
              </th>
              {journals.map((j, i) => {
                const raw = j?.[row.key]
                const value = row.fmt ? row.fmt(raw) : (raw == null || raw === '' ? '—' : String(raw))
                const isMissing = value === '—'
                return (
                  <td
                    key={`${row.key}-${i}`}
                    className={`align-top px-3 py-2 border-b border-white/5 ${isMissing ? 'text-slate-500' : 'text-slate-200'} ${row.key === 'scope' ? 'text-[12px] leading-relaxed' : ''}`}
                  >
                    {value}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 text-[11px] text-slate-500">
        Missing fields render as "—". JIF and quartile reflect the most recent JCR release in PaperFate's snapshot.
      </div>
    </div>
  )
}

function CompareSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading comparison results"
      className="card p-6 animate-fade-up"
    >
      <span className="sr-only">Loading comparison results…</span>
      <div className="h-4 w-40 rounded bg-white/5 mb-4 animate-pulse" aria-hidden="true" />
      <div className="grid gap-3" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 w-full rounded bg-white/5 animate-pulse" />
        ))}
      </div>
    </div>
  )
}
