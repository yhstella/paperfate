// PaperFate · Forecast diff view (compare two history entries).
//
// Side-by-side comparison modal for two saved-history entries. The user
// picks 2 entries via the multi-select checkboxes in ForecastHistory and
// hits "Compare 2 selected"; that opens this modal with the two entries.
//
// We render four rows: predicted JIF, extractor used, wall-clock ms, and
// abstract preview / title. Per row we highlight the difference:
//   - JIF: Δ shown in green if B > A, red if B < A, slate if equal.
//   - extractor / mode / title / abstract preview: cells marked when
//     they differ (light amber border on the cell).
//
// Accessibility:
//   - role=dialog, aria-modal, aria-labelledby ties to the heading.
//   - ESC closes; backdrop click closes.
//   - Focus moves to the close button on open and restores on close.
//
// Telemetry: emits `forecast_diff_view` on open (once per mount) and
// `forecast_diff_close` on close. All telemetry/storage calls are
// swallowed — this view MUST NEVER throw into the host app.

import { useCallback, useEffect, useRef } from 'react'
import { trackEvent } from '../lib/telemetry.js'

function formatJif(entry) {
  const pt = entry?.predictions?.jcr_jif?.point
  if (!Number.isFinite(+pt)) return null
  return +pt
}

function formatJifLabel(value) {
  if (!Number.isFinite(+value)) return '—'
  return (+value).toFixed(2)
}

function formatWallMs(entry) {
  const v = entry?.wall_ms
  if (!Number.isFinite(+v)) return '—'
  return `${Math.round(+v)} ms`
}

function formatTs(entry) {
  const ts = entry?.ts
  if (!Number.isFinite(+ts)) return ''
  try {
    return new Date(+ts).toLocaleString()
  } catch {
    return ''
  }
}

function safeStr(v) {
  return typeof v === 'string' ? v : ''
}

// Cell wrapper. `diff` highlights when the two sides disagree.
function Cell({ children, diff, mono }) {
  const base =
    'rounded-md border px-3 py-2 text-xs leading-relaxed break-words'
  const tone = diff
    ? 'border-amber-400/40 bg-amber-400/[0.06] text-slate-100'
    : 'border-white/10 bg-ink-900/60 text-slate-300'
  const font = mono ? 'font-mono' : ''
  return <div className={`${base} ${tone} ${font}`}>{children}</div>
}

function RowHeader({ children }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-slate-500">
      {children}
    </div>
  )
}

export default function ForecastCompare({ open, entryA, entryB, onClose }) {
  const dialogRef = useRef(null)
  const closeBtnRef = useRef(null)
  const lastFocusRef = useRef(null)
  const viewedRef = useRef(false)

  // Fire forecast_diff_view exactly once per open.
  useEffect(() => {
    if (!open) {
      viewedRef.current = false
      return
    }
    if (viewedRef.current) return
    viewedRef.current = true
    try {
      trackEvent('forecast_diff_view', {
        a_id: entryA?.id || null,
        b_id: entryB?.id || null,
      })
    } catch {
      /* swallow */
    }
  }, [open, entryA, entryB])

  // Capture previously-focused element so we can restore on close.
  useEffect(() => {
    if (!open) return undefined
    try {
      lastFocusRef.current =
        typeof document !== 'undefined' ? document.activeElement : null
    } catch {
      lastFocusRef.current = null
    }
    return undefined
  }, [open])

  // Lock body scroll while open.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Move focus into the dialog on open; restore on close.
  useEffect(() => {
    if (open) {
      const id = setTimeout(() => {
        if (closeBtnRef.current) {
          try { closeBtnRef.current.focus() } catch { /* ignore */ }
        }
      }, 0)
      return () => clearTimeout(id)
    }
    const prev = lastFocusRef.current
    if (prev && typeof prev.focus === 'function') {
      try { prev.focus() } catch { /* ignore */ }
    }
    return undefined
  }, [open])

  const close = useCallback(() => {
    try { trackEvent('forecast_diff_close') } catch { /* swallow */ }
    onClose?.()
  }, [onClose])

  const onKeyDown = useCallback(
    (e) => {
      if (!open) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    },
    [open, close]
  )

  if (!open || !entryA || !entryB) return null

  const jifA = formatJif(entryA)
  const jifB = formatJif(entryB)
  const jifDelta =
    Number.isFinite(+jifA) && Number.isFinite(+jifB) ? +jifB - +jifA : null
  const jifDiffers =
    !(
      (jifA === null && jifB === null) ||
      (Number.isFinite(+jifA) &&
        Number.isFinite(+jifB) &&
        Math.abs(+jifA - +jifB) < 1e-9)
    )

  const extractorA = safeStr(entryA.extractor_used) || '—'
  const extractorB = safeStr(entryB.extractor_used) || '—'
  const extractorDiffers = extractorA !== extractorB

  const modeA = entryA.mode === 'full' ? 'Full manuscript' : 'Abstract'
  const modeB = entryB.mode === 'full' ? 'Full manuscript' : 'Abstract'
  const modeDiffers = modeA !== modeB

  const wallA = formatWallMs(entryA)
  const wallB = formatWallMs(entryB)
  const wallDiffers =
    Number.isFinite(+entryA.wall_ms) &&
    Number.isFinite(+entryB.wall_ms) &&
    Math.round(+entryA.wall_ms) !== Math.round(+entryB.wall_ms)

  const titleA = safeStr(entryA.title) || 'Untitled manuscript'
  const titleB = safeStr(entryB.title) || 'Untitled manuscript'
  const titleDiffers = titleA !== titleB

  const absA = safeStr(entryA.abstract_preview)
  const absB = safeStr(entryB.abstract_preview)
  const absDiffers = absA !== absB

  // Delta tone for JIF column.
  let deltaTone = 'text-slate-400'
  let deltaLabel = '0.00'
  if (Number.isFinite(+jifDelta)) {
    if (+jifDelta > 0) {
      deltaTone = 'text-emerald-300'
      deltaLabel = `+${(+jifDelta).toFixed(2)}`
    } else if (+jifDelta < 0) {
      deltaTone = 'text-rose-300'
      deltaLabel = (+jifDelta).toFixed(2)
    } else {
      deltaLabel = '0.00'
    }
  } else {
    deltaLabel = '—'
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="paperfate-diff-title"
      ref={dialogRef}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-12 sm:pt-20"
    >
      {/* Backdrop — click outside closes. */}
      <button
        type="button"
        aria-label="Close compare"
        onClick={close}
        className="absolute inset-0 cursor-default bg-ink-950/70 backdrop-blur-sm"
        tabIndex={-1}
      />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-ink-900/95 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-white/5 px-5 py-3">
          <div className="min-w-0">
            <h2
              id="paperfate-diff-title"
              className="text-sm font-semibold text-slate-100"
            >
              Compare forecasts
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Side-by-side diff between two saved runs. Differences are
              highlighted in amber; the JIF delta is colored by direction.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            aria-label="Close"
            className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-fate-500"
          >
            Close
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {/* Column labels with timestamps. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-white/10 bg-ink-950/60 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Run A
              </div>
              <div className="mt-0.5 text-xs text-slate-300">
                {formatTs(entryA) || '—'}
              </div>
            </div>
            <div className="rounded-md border border-white/10 bg-ink-950/60 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Run B
              </div>
              <div className="mt-0.5 text-xs text-slate-300">
                {formatTs(entryB) || '—'}
              </div>
            </div>
          </div>

          {/* Predicted JIF row + delta. */}
          <section>
            <RowHeader>Predicted JIF</RowHeader>
            <div className="mt-1 grid grid-cols-2 gap-3">
              <Cell diff={jifDiffers} mono>
                <span className="text-base text-slate-100">
                  {formatJifLabel(jifA)}
                </span>
              </Cell>
              <Cell diff={jifDiffers} mono>
                <span className="text-base text-slate-100">
                  {formatJifLabel(jifB)}
                </span>
              </Cell>
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              Δ (B − A){' '}
              <span className={`font-mono ${deltaTone}`}>{deltaLabel}</span>
            </div>
          </section>

          {/* Mode row. */}
          <section>
            <RowHeader>Mode</RowHeader>
            <div className="mt-1 grid grid-cols-2 gap-3">
              <Cell diff={modeDiffers}>{modeA}</Cell>
              <Cell diff={modeDiffers}>{modeB}</Cell>
            </div>
          </section>

          {/* Extractor row. */}
          <section>
            <RowHeader>Extractor used</RowHeader>
            <div className="mt-1 grid grid-cols-2 gap-3">
              <Cell diff={extractorDiffers} mono>{extractorA}</Cell>
              <Cell diff={extractorDiffers} mono>{extractorB}</Cell>
            </div>
          </section>

          {/* Wall ms row. */}
          <section>
            <RowHeader>Wall time</RowHeader>
            <div className="mt-1 grid grid-cols-2 gap-3">
              <Cell diff={wallDiffers} mono>{wallA}</Cell>
              <Cell diff={wallDiffers} mono>{wallB}</Cell>
            </div>
          </section>

          {/* Title row. */}
          <section>
            <RowHeader>Title</RowHeader>
            <div className="mt-1 grid grid-cols-2 gap-3">
              <Cell diff={titleDiffers}>{titleA}</Cell>
              <Cell diff={titleDiffers}>{titleB}</Cell>
            </div>
          </section>

          {/* Abstract preview row. */}
          <section>
            <RowHeader>Abstract preview</RowHeader>
            <div className="mt-1 grid grid-cols-2 gap-3">
              <Cell diff={absDiffers}>{absA || '—'}</Cell>
              <Cell diff={absDiffers}>{absB || '—'}</Cell>
            </div>
          </section>
        </div>

        <footer className="border-t border-white/5 px-5 py-2 text-[10px] uppercase tracking-wider text-slate-500">
          <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-slate-400">
            esc
          </kbd>{' '}
          close
        </footer>
      </div>
    </div>
  )
}
