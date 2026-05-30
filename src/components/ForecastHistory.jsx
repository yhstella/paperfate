import { useEffect, useMemo, useRef, useState } from 'react'
import { trackEvent } from '../lib/telemetry.js'
import {
  getForecasts,
  clearAll,
  generateShareUrl,
  setFavorite,
  addTag,
  removeTag,
  exportAsJson,
} from '../lib/forecastHistory.js'
import { shareForecast, canShareForecast } from '../lib/shareForecast.js'

const MAX_TAGS_PER_ENTRY = 5
const TAG_MAX_LEN = 32

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
  const [sharedId, setSharedId] = useState(null)
  const [sharedMethod, setSharedMethod] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [tagDraftId, setTagDraftId] = useState(null)
  const [tagDraft, setTagDraft] = useState('')
  const tagInputRef = useRef(null)
  const shareAvailable = useMemo(() => canShareForecast(), [])

  function reload() {
    try {
      setEntries(getForecasts())
    } catch {
      setEntries([])
    }
  }

  // Refresh on open. Avoid re-reading on every render — localStorage is
  // cheap but we don't want to fight React's render loop.
  useEffect(() => {
    if (!open) return
    reload()
    try { trackEvent('history_open', { count: getForecasts().length }) } catch { /* ignore */ }
    setConfirmClear(false)
    setCopiedId(null)
    setSharedId(null)
    setSharedMethod(null)
    setTagDraftId(null)
    setTagDraft('')
  }, [open])

  // When a tag input opens, focus it so the user can type immediately.
  useEffect(() => {
    if (tagDraftId && tagInputRef.current) {
      try { tagInputRef.current.focus() } catch { /* ignore */ }
    }
  }, [tagDraftId])

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

  async function handleShare(entry) {
    if (!entry) return
    let result
    try {
      result = await shareForecast(entry)
    } catch {
      result = { ok: false, method: 'none' }
    }
    if (!result || !result.ok) return
    setSharedId(entry.id)
    setSharedMethod(result.method)
    setTimeout(() => {
      setSharedId(prev => (prev === entry.id ? null : prev))
      setSharedMethod(prev => (prev && prev === result.method ? null : prev))
    }, 1600)
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

  function handleToggleFavorite(entry) {
    if (!entry) return
    const nextFlag = !(entry.favorite === true)
    try { setFavorite(entry.id, nextFlag) } catch { /* ignore */ }
    try { trackEvent('history_favorite_toggle', { id: entry.id, value: nextFlag }) } catch { /* ignore */ }
    reload()
  }

  function openTagDraft(entry) {
    if (!entry) return
    const tagCount = Array.isArray(entry.tags) ? entry.tags.length : 0
    if (tagCount >= MAX_TAGS_PER_ENTRY) return
    setTagDraftId(entry.id)
    setTagDraft('')
  }

  function cancelTagDraft() {
    setTagDraftId(null)
    setTagDraft('')
  }

  function commitTagDraft(entry) {
    if (!entry) return
    const raw = (tagDraft || '').trim()
    if (!raw) {
      cancelTagDraft()
      return
    }
    const value = raw.slice(0, TAG_MAX_LEN)
    try { addTag(entry.id, value) } catch { /* ignore */ }
    try { trackEvent('history_tag_add', { id: entry.id, len: value.length }) } catch { /* ignore */ }
    cancelTagDraft()
    reload()
  }

  function handleRemoveTag(entry, tag) {
    if (!entry || !tag) return
    try { removeTag(entry.id, tag) } catch { /* ignore */ }
    try { trackEvent('history_tag_remove', { id: entry.id, len: tag.length }) } catch { /* ignore */ }
    reload()
  }

  function handleExport() {
    if (typeof window === 'undefined') return
    let json = ''
    try { json = exportAsJson() } catch { json = '' }
    if (!json) return
    try { trackEvent('history_export', { count: entries.length }) } catch { /* ignore */ }
    try {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const a = document.createElement('a')
      a.href = url
      a.download = `paperfate-history-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Give the browser a tick to start the download before revoking.
      setTimeout(() => {
        try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      }, 1000)
    } catch {
      // Blob / anchor not available — best-effort silent fail.
    }
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
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100">Forecast history</h3>
            <p className="text-[11px] text-slate-500">
              Last {entries.length || 0} run{entries.length === 1 ? '' : 's'} on this device
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {hasEntries && (
              <button
                type="button"
                onClick={handleExport}
                aria-label="Export forecast history as JSON"
                title="Download history as JSON"
                className="text-[11px] text-slate-300 hover:text-slate-100 px-2 py-1 rounded-md border border-white/10 hover:bg-white/5 transition-colors"
              >
                Export JSON
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-slate-400 hover:text-slate-200 px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
            >
              Close
            </button>
          </div>
        </header>

        <div className="flex-1 px-4 py-3">
          {!hasEntries ? (
            <div className="rounded-md border border-white/5 bg-ink-900/60 p-4 text-xs text-slate-400">
              No forecasts yet. Successful runs will appear here so you can revisit them.
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map(entry => {
                const tags = Array.isArray(entry.tags) ? entry.tags : []
                const isFav = entry.favorite === true
                const isDraftingTag = tagDraftId === entry.id
                const tagFull = tags.length >= MAX_TAGS_PER_ENTRY
                return (
                <li key={entry.id}>
                  <div className="rounded-md border border-white/10 bg-ink-900/60 p-3 hover:border-fate-400/30 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleFavorite(entry)}
                            aria-pressed={isFav}
                            aria-label={isFav ? 'Unfavorite this forecast' : 'Favorite this forecast'}
                            title={isFav ? 'Favorited' : 'Mark as favorite'}
                            className={`shrink-0 mt-0.5 text-base leading-none px-1 rounded hover:bg-white/5 transition-colors ${
                              isFav ? 'text-amber-300' : 'text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            <span aria-hidden="true">{isFav ? '★' : '☆'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRestore(entry)}
                            aria-label={`Restore forecast: ${entry.title || 'Untitled'}`}
                            className="block min-w-0 flex-1 text-left"
                          >
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
                          </button>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">JIF</div>
                        <div className="font-mono text-sm text-slate-100">{formatJif(entry)}</div>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {tags.map(tag => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 text-[10px] text-slate-300 pl-2 pr-1 py-0.5"
                        >
                          <span className="truncate max-w-[120px]">{tag}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveTag(entry, tag)}
                            aria-label={`Remove tag ${tag}`}
                            className="text-slate-500 hover:text-rose-300 leading-none px-1"
                          >
                            <span aria-hidden="true">{'×'}</span>
                          </button>
                        </span>
                      ))}
                      {isDraftingTag ? (
                        <form
                          onSubmit={(e) => { e.preventDefault(); commitTagDraft(entry) }}
                          className="inline-flex items-center gap-1"
                        >
                          <input
                            ref={tagInputRef}
                            type="text"
                            value={tagDraft}
                            onChange={(e) => setTagDraft(e.target.value.slice(0, TAG_MAX_LEN))}
                            onBlur={() => commitTagDraft(entry)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelTagDraft()
                              }
                            }}
                            maxLength={TAG_MAX_LEN}
                            placeholder="tag"
                            aria-label="New tag"
                            className="w-24 rounded-full border border-fate-400/30 bg-ink-950 text-[10px] text-slate-100 px-2 py-0.5 focus:outline-none focus:border-fate-400/60"
                          />
                        </form>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openTagDraft(entry)}
                          disabled={tagFull}
                          aria-label={tagFull ? 'Tag limit reached' : 'Add a tag'}
                          title={tagFull ? `Up to ${MAX_TAGS_PER_ENTRY} tags` : 'Add tag'}
                          className={`inline-flex items-center gap-0.5 rounded-full border border-dashed text-[10px] px-2 py-0.5 transition-colors ${
                            tagFull
                              ? 'border-white/5 text-slate-600 cursor-not-allowed'
                              : 'border-white/15 text-slate-400 hover:text-slate-200 hover:border-white/30'
                          }`}
                        >
                          <span aria-hidden="true">+</span>
                          <span>tag</span>
                        </button>
                      )}
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/5 pt-2">
                      <div className="flex items-center gap-1">
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
                          onClick={() => handleShare(entry)}
                          disabled={!shareAvailable}
                          aria-label="Share this forecast"
                          title={shareAvailable ? 'Share forecast' : 'Sharing not supported in this browser'}
                          className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-colors ${
                            shareAvailable
                              ? 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                              : 'text-slate-600 cursor-not-allowed'
                          }`}
                        >
                          <svg
                            aria-hidden="true"
                            xmlns="http://www.w3.org/2000/svg"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="18" cy="5" r="3" />
                            <circle cx="6" cy="12" r="3" />
                            <circle cx="18" cy="19" r="3" />
                            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                          </svg>
                          <span>
                            {sharedId === entry.id
                              ? (sharedMethod === 'clipboard' ? 'Copied!' : 'Shared!')
                              : 'Share'}
                          </span>
                        </button>
                      </div>
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
              )})}
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
