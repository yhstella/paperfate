import { useEffect, useMemo, useState } from 'react'
import { trackEvent } from '../lib/telemetry.js'
import {
  getForecasts,
  clearAll,
  generateShareUrl,
} from '../lib/forecastHistory.js'

// Side panel listing the 20 most-recent forecast entries persisted to
// localStorage via src/lib/forecastHistory.js. Click a row to restore that
// entry into the Simulator form; per-row "Copy share link" copies a
// /?forecast=<id> URL.
//
// Telemetry: emits history_open on mount, history_restore on row click,
// history_clear on Clear-all confirm. Never throws — telemetry / clipboard
// errors are swallowed.

function formatRelativeTime(tsMs) {
  if (!Number.isFinite(+tsMs)) return ''
  const diffSec = Math.max(0, Math.round((Date.now() - tsMs) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 48) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  return `${diffDay}d ago`
}

function formatJif(entry) {
  const pt = entry?.predictions?.jcr_jif?.point
  if (!Number.isFinite(+pt)) return '—'
  return (+pt).toFixed(1)
}

export default function ForecastHistory({ open, onClose, onRestore }) {
  const [entries, setEntries] = useState([])
  const [copiedId, setCopiedId] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)

  // Refresh on open. Avoid re-reading on every render — localStorage is
  // cheap but we don't want to fight React's render loop.
  useEffect(() => {
    if (!open) return
    try {
      setEntries(getForecasts())
    } catch {
      setEntries([])
    }
    try { trackEvent('history_open', { count: getForecasts().length }) } catch { /* ignore */ }
    setConfirmClear(false)
    setCopiedId(null)
  }, [open])

  // ESC closes the panel.
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const hasEntries = entries.length > 0

  function handleRestore(entry) {
    if (!entry) return
    try { trackEvent('history_restore', { id: entry.id }) } catch { /* ignore */ }
    try {
      onRestore?.(entry)
    } catch (err) {
      console.warn('history restore failed:', err && err.message)
    }
  }

  async function handleCopy(entry) {
    if (!entry) return
    const url = generateShareUrl(entry.id)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      }
      setCopiedId(entry.id)
      setTimeout(() => {
        setCopiedId(prev => (prev === entry.id ? null : prev))
      }, 1600)
    } catch {
      // Clipboard refused — best-effort, no fallback prompt to avoid UX noise.
    }
  }

  function handleClear() {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    try { trackEvent('history_clear', { count: entries.length }) } catch { /* ignore */ }
    try {
      clearAll()
    } catch { /* ignore */ }
    setEntries([])
    setConfirmClear(false)
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label="Forecast history"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close forecast history"
        className="flex-1 bg-black/40 backdrop-blur-sm"
      />
      <aside
        role="region"
        aria-label="Forecast history"
        className="w-full max-w-md h-full overflow-y-auto bg-ink-950 border-l border-white/10 shadow-xl flex flex-col"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-ink-950/95 backdrop-blur px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Forecast history</h3>
            <p className="text-[11px] text-slate-500">
              Last {entries.length || 0} run{entries.length === 1 ? '' : 's'} on this device
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-200 px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
          >
            Close
          </button>
        </header>

        <div className="flex-1 px-4 py-3">
          {!hasEntries ? (
            <div className="rounded-md border border-white/5 bg-ink-900/60 p-4 text-xs text-slate-400">
              No forecasts yet. Successful runs will appear here so you can revisit them.
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map(entry => (
                <li key={entry.id}>
                  <div className="rounded-md border border-white/10 bg-ink-900/60 p-3 hover:border-fate-400/30 transition-colors">
                    <button
                      type="button"
                      onClick={() => handleRestore(entry)}
                      aria-label={`Restore forecast: ${entry.title || 'Untitled'}`}
                      className="block w-full text-left"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-slate-100 truncate">
                            {entry.title || 'Untitled manuscript'}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                            <span>{formatRelativeTime(entry.ts)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{entry.mode === 'full' ? 'Full manuscript' : 'Abstract'}</span>
                            {entry.extractor_used && (
                              <span
                                className="chip border border-white/10 text-[10px] px-1.5 py-0.5 text-slate-400"
                                title={`Extractor: ${entry.extractor_used}`}
                              >
                                {entry.extractor_used}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[10px] uppercase tracking-wider text-slate-500">JIF</div>
                          <div className="font-mono text-sm text-slate-100">{formatJif(entry)}</div>
                        </div>
                      </div>
                    </button>
                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/5 pt-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(entry)}
                        aria-label="Copy share link for this forecast"
                        className="text-[11px] text-slate-400 hover:text-slate-200 px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
                      >
                        {copiedId === entry.id ? 'Copied!' : 'Copy share link'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRestore(entry)}
                        aria-label="Restore this forecast"
                        className="text-[11px] text-fate-300 hover:text-fate-200 px-2 py-1 rounded-md hover:bg-fate-400/10 transition-colors"
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {hasEntries && (
          <footer className="sticky bottom-0 border-t border-white/10 bg-ink-950/95 backdrop-blur px-4 py-3">
            <button
              type="button"
              onClick={handleClear}
              aria-label={confirmClear ? 'Confirm clear all forecast history' : 'Clear all forecast history'}
              className={`w-full text-xs px-3 py-2 rounded-md border transition-colors ${
                confirmClear
                  ? 'border-rose-400/40 text-rose-200 bg-rose-400/[0.08] hover:bg-rose-400/[0.14]'
                  : 'border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
              }`}
            >
              {confirmClear ? 'Click again to confirm — clears all history' : 'Clear all'}
            </button>
          </footer>
        )}
      </aside>
    </div>
  )
}
