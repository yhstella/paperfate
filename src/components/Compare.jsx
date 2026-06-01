import { useEffect, useMemo, useRef, useState } from 'react'
import { trackEvent } from '../lib/telemetry.js'
import { t, useLocale } from '../lib/i18n.js'

const ISSN_RE = /^\d{4}-\d{3}[\dxX]$/
const PLACEHOLDER = 'NEJM, Lancet, JAMA, Annals of Internal Medicine'

// Draft persistence — mirrors Simulator's localStorage strategy.
const DRAFT_KEY = 'paperfate.compare.draft'
const DRAFT_MAX_AGE_MS = 10 * 60 * 1000      // 10 minutes
const DRAFT_MAX_BYTES = 50 * 1024            // 50KB
const DRAFT_DEBOUNCE_MS = 1000

const ROWS = [
  { key: 'name',          labelKey: null,                      label: 'Journal name' },
  { key: 'publisher',     labelKey: 'compare.columns.publisher' },
  { key: 'jif',           labelKey: 'compare.columns.jif',           fmt: fmtNumber },
  { key: 'quartile',      labelKey: 'compare.columns.quartile' },
  { key: 'is_oa',         labelKey: 'compare.columns.oa_status',     fmt: fmtBool },
  { key: 'apc',           labelKey: 'compare.columns.apc',           fmt: fmtMoney },
  { key: 'h_index',       labelKey: 'compare.columns.h_index',       fmt: fmtInt },
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
function fmtBool(v) {
  if (v == null) return '—'
  return v ? 'Yes' : 'No'
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

// --- Draft persistence helpers (SSR safe, never throw to caller) ---
function readDraft() {
  if (typeof window === 'undefined') return null
  try {
    if (typeof localStorage === 'undefined') return null
    const blob = localStorage.getItem(DRAFT_KEY)
    if (!blob) return null
    const parsed = JSON.parse(blob)
    if (!parsed || typeof parsed !== 'object') return null
    const ts = Number(parsed.ts)
    const raw = typeof parsed.raw === 'string' ? parsed.raw : ''
    if (!Number.isFinite(ts) || !raw) return null
    if (Date.now() - ts > DRAFT_MAX_AGE_MS) return null
    return { ts, raw }
  } catch { return null }
}

function writeDraft(raw) {
  if (typeof window === 'undefined') return
  if (typeof raw !== 'string') return
  // Skip oversized values; UTF-16 byte estimate ~= length * 2 but we use
  // raw byte size via TextEncoder when available for fidelity.
  let size
  try {
    if (typeof TextEncoder !== 'undefined') {
      size = new TextEncoder().encode(raw).length
    } else {
      size = raw.length * 2
    }
  } catch { size = raw.length * 2 }
  if (size > DRAFT_MAX_BYTES) return
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), raw }))
  } catch { /* quota / private mode — ignore */ }
}

function clearDraft() {
  if (typeof window === 'undefined') return
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(DRAFT_KEY)
  } catch { /* ignore */ }
}

export default function Compare() {
  useLocale()   // subscribe so a language switch re-renders Compare + children
  const [raw, setRaw] = useState('')
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const formRef = useRef(null)
  const saveTimerRef = useRef(null)
  const rehydratedRef = useRef(false)

  const parsed = useMemo(() => splitEntries(raw), [raw])
  const tokenCount = parsed.issns.length + parsed.names.length
  const canSubmit = tokenCount >= 2 && tokenCount <= 5 && status !== 'loading'

  // Fire compare_open exactly once on mount + rehydrate any fresh draft.
  useEffect(() => {
    trackEvent('compare_open')
    const draft = readDraft()
    if (draft && draft.raw) {
      rehydratedRef.current = true
      setRaw(draft.raw)
    }
  }, [])

  // Debounced 1s save on textarea change. Cleared after submit / Clear.
  useEffect(() => {
    // Skip the very first sync after rehydration so we don't immediately
    // rewrite the same blob with a fresh timestamp.
    if (rehydratedRef.current) {
      rehydratedRef.current = false
      return
    }
    if (typeof window === 'undefined') return undefined
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (!raw) {
      // Empty value → wipe (don't persist empty drafts).
      clearDraft()
      return undefined
    }
    saveTimerRef.current = setTimeout(() => {
      writeDraft(raw)
      saveTimerRef.current = null
    }, DRAFT_DEBOUNCE_MS)
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [raw])

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
      // Successful comparison → wipe draft.
      clearDraft()
    } catch (err) {
      const code = (err && err.__status != null) ? err.__status : 'network_error'
      trackEvent('compare_result_error', { http_status_or_code: code })
      setError(err.message || t('compare.error_network'))
      setStatus('error')
    }
  }

  function loadSample() {
    trackEvent('compare_sample_load')
    setRaw(PLACEHOLDER)
  }

  function onClearClick() {
    setRaw('')
    setData(null)
    setError(null)
    setStatus('idle')
    clearDraft()
    trackEvent('compare_clear')
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
      clearDraft()
    }
  }

  return (
    <section id="compare" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">{t('compare.title')}</h2>
          <p className="mt-3 text-slate-600 dark:text-slate-400">
            Drop 2–5 journals — by name or ISSN — and see JIF, quartile, OA status,
            APC, h-index, and scope side-by-side. Useful for shortlisting a target
            before you run the simulator.
          </p>
          <div className="mt-6 text-xs text-slate-600 dark:text-slate-500">
            Try a sample:
            <button
              type="button"
              onClick={loadSample}
              aria-label="Load sample journals: NEJM, Lancet, JAMA, Annals"
              className="ml-2 rounded-md border border-fate-500/40 bg-fate-100/40 px-2.5 py-1 text-xs text-fate-700 hover:bg-fate-100/70 dark:border-fate-400/30 dark:bg-fate-400/[0.06] dark:text-fate-300 dark:hover:bg-fate-400/[0.12] transition-colors"
            >
              NEJM · Lancet · JAMA · Annals
            </button>
          </div>
        </div>

        <form ref={formRef} onSubmit={onSubmit} className="card p-5 sm:p-6 lg:col-span-3">
          <div className="space-y-4">
            <label className="block" htmlFor="compare-journals-input">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                  {t('compare.label_input')}
                </span>
                <span className="text-[11px] text-slate-600 dark:text-slate-500" aria-hidden="true">
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
                aria-label={t('compare.label_input')}
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
                  <span key={`i-${s}`} className="chip border-emerald-500/40 text-emerald-800 bg-emerald-100/60 dark:border-emerald-400/30 dark:text-emerald-300/90 dark:bg-emerald-400/[0.06]">
                    ISSN · {s}
                  </span>
                ))}
                {parsed.names.map(s => (
                  <span key={`n-${s}`} className="chip border-fate-500/40 text-fate-700 bg-fate-100/60 dark:border-fate-400/30 dark:text-fate-300 dark:bg-fate-400/[0.06]">
                    {s}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <div id="compare-input-hint" className="text-[11px] text-slate-600 dark:text-slate-500">
                Matches /\d{'{4}'}-\d{'{3}'}[\dxX]/ go to ISSN lookup. Everything else is name-matched.
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {raw && (
                  <button
                    type="button"
                    onClick={onClearClick}
                    aria-label={t('compare.clear_button')}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-300 dark:hover:bg-white/[0.06] transition-colors"
                  >
                    {t('compare.clear_button')}
                  </button>
                )}
                <button
                  type="submit"
                  disabled={!canSubmit}
                  aria-label={t('compare.submit_button')}
                  className="btn-primary"
                >
                  {status === 'loading' ? t('common.loading') : t('compare.submit_button')}
                </button>
              </div>
            </div>

            {tokenCount > 0 && tokenCount < 2 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-100/50 p-2.5 text-[11px] text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.04] dark:text-amber-200">
                {t('compare.error_no_input')}
              </div>
            )}
            {tokenCount > 5 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-100/50 p-2.5 text-[11px] text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.04] dark:text-amber-200">
                {t('compare.error_too_many')}
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
            className="card p-6 text-sm text-amber-800 dark:text-amber-200"
          >
            <div className="font-semibold mb-1">{t('compare.error_network')}</div>
            <div className="text-amber-800 dark:text-amber-200 text-[13px]">{error}</div>
            <div className="mt-3">
              <button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit}
                className="rounded-md border border-amber-500/40 bg-amber-100/60 px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-100 dark:border-amber-300/30 dark:bg-amber-300/[0.06] dark:text-amber-100 dark:hover:bg-amber-300/[0.12] transition-colors disabled:opacity-50"
              >
                {t('compare.refresh_button')}
              </button>
            </div>
          </div>
        )}
        {status === 'done' && data && data.length > 0 && (
          <CompareResults journals={data} />
        )}
      </div>
    </section>
  )
}

// Sort comparators. JIF numeric (missing → -Infinity for desc / +Infinity for
// asc so missing rows sink to the bottom in both directions). Name is locale-
// aware case-insensitive A-Z.
const SORT_OPTIONS = [
  { value: 'jif_desc',  labelKey: 'compare.sort_by_jif',  suffix: ' (desc)', by: 'jif',  direction: 'desc' },
  { value: 'jif_asc',   labelKey: 'compare.sort_by_jif',  suffix: ' (asc)',  by: 'jif',  direction: 'asc' },
  { value: 'name_asc',  labelKey: 'compare.sort_by_name', suffix: '',        by: 'name', direction: 'asc' },
]
const DEFAULT_SORT = 'jif_desc'
const PAGE_SIZE = 4
const COPIED_FLASH_MS = 1500

function sortJournals(journals, sortValue) {
  const opt = SORT_OPTIONS.find(o => o.value === sortValue) || SORT_OPTIONS[0]
  const arr = journals.slice()
  if (opt.by === 'jif') {
    const sinkMissing = opt.direction === 'desc' ? -Infinity : Infinity
    arr.sort((a, b) => {
      const na = Number(a?.jif)
      const nb = Number(b?.jif)
      const va = Number.isFinite(na) ? na : sinkMissing
      const vb = Number.isFinite(nb) ? nb : sinkMissing
      return opt.direction === 'desc' ? vb - va : va - vb
    })
  } else {
    arr.sort((a, b) => {
      const sa = (a?.name || a?.issn || '').toString()
      const sb = (b?.name || b?.issn || '').toString()
      return sa.localeCompare(sb, undefined, { sensitivity: 'base' })
    })
  }
  return arr
}

function escapeTSVCell(s) {
  // TSV is tab/newline delimited. Replace tabs with spaces and collapse
  // newlines so a single cell never breaks the grid when pasted into a
  // spreadsheet.
  return String(s ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim()
}

function buildTSV(journals) {
  // One row per metric, one column per journal — matches the on-screen layout
  // so users can paste straight into Excel/Sheets/Numbers.
  const header = ['Metric', ...journals.map((j, i) => j?.name || j?.issn || `Journal ${i + 1}`)]
  const lines = [header.map(escapeTSVCell).join('\t')]
  for (const row of ROWS) {
    const label = row.labelKey ? t(row.labelKey) : row.label
    const cells = [label]
    for (const j of journals) {
      const raw = j?.[row.key]
      const value = row.fmt ? row.fmt(raw) : (raw == null || raw === '' ? '—' : String(raw))
      cells.push(value)
    }
    lines.push(cells.map(escapeTSVCell).join('\t'))
  }
  return lines.join('\n')
}

function CompareResults({ journals }) {
  const [sortValue, setSortValue] = useState(DEFAULT_SORT)
  const [page, setPage] = useState(0)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef(null)

  const sorted = useMemo(() => sortJournals(journals, sortValue), [journals, sortValue])

  const showPagination = sorted.length > PAGE_SIZE
  const pageCount = showPagination ? Math.ceil(sorted.length / PAGE_SIZE) : 1
  // Clamp page if upstream data shrinks (e.g. new comparison submitted).
  const safePage = Math.min(page, Math.max(0, pageCount - 1))
  const pageStart = showPagination ? safePage * PAGE_SIZE : 0
  const pageEnd = showPagination ? Math.min(pageStart + PAGE_SIZE, sorted.length) : sorted.length
  const visible = showPagination ? sorted.slice(pageStart, pageEnd) : sorted

  useEffect(() => {
    // Reset to first page whenever the underlying data set or sort changes.
    setPage(0)
  }, [journals, sortValue])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
    }
  }, [])

  function onSortChange(e) {
    const next = e.target.value
    setSortValue(next)
    const opt = SORT_OPTIONS.find(o => o.value === next) || SORT_OPTIONS[0]
    trackEvent('compare_sort_change', { by: opt.by, direction: opt.direction })
  }

  function onPrev() {
    if (safePage <= 0) return
    const next = safePage - 1
    setPage(next)
    trackEvent('compare_paginate', { page: next })
  }

  function onNext() {
    if (safePage >= pageCount - 1) return
    const next = safePage + 1
    setPage(next)
    trackEvent('compare_paginate', { page: next })
  }

  async function onCopyTSV() {
    // Copy the *fully sorted* dataset, not just the current page — users
    // expect "copy table" to mean the whole comparison.
    const tsv = buildTSV(sorted)
    let ok = false
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(tsv)
        ok = true
      }
    } catch {
      ok = false
    }
    if (ok) {
      setCopied(true)
      trackEvent('compare_copy_tsv')
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        setCopied(false)
        copyTimerRef.current = null
      }, COPIED_FLASH_MS)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="compare-sort" className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
            Sort
          </label>
          <select
            id="compare-sort"
            value={sortValue}
            onChange={onSortChange}
            aria-label="Sort comparison table"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-1 focus:ring-fate-500/40 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-200 dark:hover:bg-white/[0.06] dark:focus:ring-fate-400/40 transition-colors"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{t(o.labelKey) + (o.suffix || '')}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCopyTSV}
            aria-label={t('compare.copy_to_clipboard')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-300 dark:hover:bg-white/[0.06] transition-colors"
          >
            {t('compare.copy_to_clipboard')}
          </button>
          <span
            role="status"
            aria-live="polite"
            className={`text-[11px] transition-opacity duration-150 ${copied ? 'opacity-100 text-emerald-700 dark:text-emerald-300' : 'opacity-0 text-slate-600 dark:text-slate-500'}`}
          >
            {copied ? 'Copied!' : ' '}
          </span>
        </div>
      </div>

      <CompareTable journals={visible} totalCount={sorted.length} />

      {showPagination && (
        <nav
          aria-label="Comparison pagination"
          className="flex items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400"
        >
          <button
            type="button"
            onClick={onPrev}
            disabled={safePage === 0}
            aria-label={t('compare.page_prev')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-300 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← {t('compare.page_prev')}
          </button>
          <span aria-live="polite">
            Page {safePage + 1} of {pageCount} · journals {pageStart + 1}–{pageEnd} of {sorted.length}
          </span>
          <button
            type="button"
            onClick={onNext}
            disabled={safePage >= pageCount - 1}
            aria-label={t('compare.page_next')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-300 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('compare.page_next')} →
          </button>
        </nav>
      )}
    </div>
  )
}

function CompareTable({ journals, totalCount }) {
  const countLabel = (totalCount != null && totalCount !== journals.length)
    ? `${journals.length} of ${totalCount} journals`
    : `${journals.length} journals`
  return (
    <div className="card p-5 sm:p-6 animate-fade-up overflow-x-auto">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
          Side-by-side comparison
        </div>
        <span className="chip">{countLabel}</span>
      </div>
      <table
        className="min-w-full border-separate border-spacing-0 text-sm"
        aria-label="Side-by-side journal comparison"
      >
        <caption className="sr-only">
          Comparison of {journals.length} journals across {ROWS.length} metrics including JIF, JCR quartile, open access status, APC, and h-index.
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 bg-slate-100/90 backdrop-blur-sm text-left text-[11px] font-semibold uppercase tracking-wider text-slate-600 px-3 py-2 border-b border-slate-200 dark:bg-ink-800/80 dark:text-slate-400 dark:border-white/5"
            >
              Metric
            </th>
            {journals.map((j, i) => (
              <th
                key={`h-${i}`}
                scope="col"
                className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700 px-3 py-2 border-b border-slate-200 min-w-[160px] dark:text-slate-300 dark:border-white/5"
              >
                {j.name || j.issn || `Journal ${i + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(row => {
            const label = row.labelKey ? t(row.labelKey) : row.label
            return (
              <tr key={row.key} className="hover:bg-slate-50 dark:hover:bg-white/[0.02]">
                <th
                  scope="row"
                  className="sticky left-0 bg-slate-100/90 backdrop-blur-sm align-top px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-600 border-b border-slate-200 dark:bg-ink-800/80 dark:text-slate-500 dark:border-white/5"
                >
                  {label}
                </th>
                {journals.map((j, i) => {
                  const raw = j?.[row.key]
                  const value = row.fmt ? row.fmt(raw) : (raw == null || raw === '' ? '—' : String(raw))
                  const isMissing = value === '—'
                  return (
                    <td
                      key={`${row.key}-${i}`}
                      className={`align-top px-3 py-2 border-b border-slate-200 dark:border-white/5 ${isMissing ? 'text-slate-500 dark:text-slate-500' : 'text-slate-800 dark:text-slate-200'}`}
                    >
                      {value}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-3 text-[11px] text-slate-600 dark:text-slate-500">
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
      <div className="h-4 w-40 rounded bg-slate-200 dark:bg-white/5 mb-4 animate-pulse" aria-hidden="true" />
      <div className="grid gap-3" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 w-full rounded bg-slate-200 dark:bg-white/5 animate-pulse" />
        ))}
      </div>
    </div>
  )
}
