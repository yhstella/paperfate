// PaperFate · Cmd+K command palette.
//
// Listens for the 'paperfate:open-command-palette' window event (fired
// by src/lib/shortcuts.js) and renders a centered modal with:
//   - a single text input that fuzzy-filters the action list
//   - keyboard navigation: ArrowUp / ArrowDown to move, Enter to run,
//     Escape to close, Tab is trapped so focus stays inside the modal
//   - role=dialog, aria-modal=true, aria-labelledby for the heading
//
// Actions are passed in as a prop so the parent (App.jsx) keeps the
// real callbacks (setTab, etc.). Each action is `{ id, label, hint?,
// shortcut?, run, available? }`. If `available` is a function we call
// it on every render to decide whether to show the row (e.g. 'Clear
// current input' only appears on Simulator). `run` may return false
// to keep the palette open; otherwise we close after invoking it.
//
// Focus management:
//   - on open, store document.activeElement, focus the input
//   - on close, restore focus to the previously-active element
//   - while open, scroll lock the body so the underlying page doesn't
//     drift when navigating with arrow keys
//
// We render nothing while closed so there's zero DOM cost on the
// happy path.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { OPEN_EVENT } from '../lib/shortcuts.js'

// Tiny case-insensitive subsequence matcher. Returns a positive score
// when every char in `query` appears in `label` in order; lower scores
// are better. Returns -1 if not a match. Empty query always matches
// with score 0 (preserves declaration order).
function fuzzyScore(label, query) {
  if (!query) return 0
  const l = String(label || '').toLowerCase()
  const q = String(query).toLowerCase()
  let li = 0
  let qi = 0
  let firstHit = -1
  let lastHit = -1
  while (li < l.length && qi < q.length) {
    if (l[li] === q[qi]) {
      if (firstHit < 0) firstHit = li
      lastHit = li
      qi++
    }
    li++
  }
  if (qi < q.length) return -1
  // Score = span between first and last hit + start offset. Lower = better.
  return (lastHit - firstHit) + firstHit
}

export default function CommandPalette({ actions }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  const inputRef = useRef(null)
  const listRef = useRef(null)
  const dialogRef = useRef(null)
  const lastFocusRef = useRef(null)

  // Subscribe to the global Cmd+K event.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onOpen = () => {
      lastFocusRef.current = (typeof document !== 'undefined') ? document.activeElement : null
      setQuery('')
      setActiveIdx(0)
      setOpen(true)
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  // Scroll-lock the body while the palette is open.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Focus the input on open, restore previous focus on close.
  useEffect(() => {
    if (open) {
      // Defer to next tick so the input is in the DOM.
      const id = setTimeout(() => {
        if (inputRef.current) inputRef.current.focus()
      }, 0)
      return () => clearTimeout(id)
    }
    // On close, restore focus to whatever had it before we opened.
    const prev = lastFocusRef.current
    if (prev && typeof prev.focus === 'function') {
      try { prev.focus() } catch { /* ignore */ }
    }
    return undefined
  }, [open])

  // Filter + sort actions whenever query or actions change.
  const visibleActions = useMemo(() => {
    const list = Array.isArray(actions) ? actions : []
    const rows = []
    for (const a of list) {
      if (!a || typeof a.run !== 'function') continue
      if (typeof a.available === 'function' && !a.available()) continue
      const score = fuzzyScore(a.label, query)
      if (score < 0) continue
      rows.push({ action: a, score })
    }
    // Stable sort: by score ascending, then by original declaration order.
    rows.sort((x, y) => x.score - y.score)
    return rows.map(r => r.action)
  }, [actions, query])

  // Clamp activeIdx into range whenever the visible list shrinks.
  useEffect(() => {
    if (activeIdx >= visibleActions.length) {
      setActiveIdx(visibleActions.length > 0 ? visibleActions.length - 1 : 0)
    }
  }, [visibleActions.length, activeIdx])

  // Scroll the active row into view on arrow nav.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    const el = list.querySelector(`[data-cp-idx="${activeIdx}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'nearest' }) } catch { /* ignore */ }
    }
  }, [activeIdx, open])

  const close = useCallback(() => { setOpen(false) }, [])

  const runAt = useCallback((idx) => {
    const action = visibleActions[idx]
    if (!action || typeof action.run !== 'function') return
    let keepOpen = false
    try {
      const ret = action.run()
      if (ret === false) keepOpen = true
    } catch {
      // Don't let a buggy callback freeze the palette.
    }
    if (!keepOpen) close()
  }, [visibleActions, close])

  const onKeyDown = useCallback((e) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => (visibleActions.length === 0 ? 0 : (i + 1) % visibleActions.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => (visibleActions.length === 0 ? 0 : (i - 1 + visibleActions.length) % visibleActions.length))
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setActiveIdx(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setActiveIdx(Math.max(0, visibleActions.length - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      runAt(activeIdx)
      return
    }
    if (e.key === 'Tab') {
      // Trap focus inside the dialog. Since we have one focusable input
      // and the list rows aren't tab stops, this collapses to keeping
      // focus on the input.
      e.preventDefault()
      if (inputRef.current) inputRef.current.focus()
    }
  }, [open, visibleActions.length, activeIdx, runAt, close])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="paperfate-command-palette-title"
      ref={dialogRef}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-20 sm:pt-28"
    >
      {/* Backdrop — click outside closes. */}
      <button
        type="button"
        aria-label="Close command palette"
        onClick={close}
        className="absolute inset-0 cursor-default bg-ink-950/70 backdrop-blur-sm"
        tabIndex={-1}
      />
      <div
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-ink-900/95 shadow-2xl"
      >
        <div className="border-b border-white/5 px-3 py-2">
          <h2
            id="paperfate-command-palette-title"
            className="sr-only"
          >
            PaperFate command palette
          </h2>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0) }}
            placeholder="Type a command…"
            aria-label="Search commands"
            aria-controls="paperfate-command-palette-list"
            aria-activedescendant={
              visibleActions.length > 0 ? `paperfate-cp-item-${activeIdx}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent px-2 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
          />
        </div>
        <ul
          id="paperfate-command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto py-1"
        >
          {visibleActions.length === 0 && (
            <li className="px-3 py-3 text-xs text-slate-500">No commands match.</li>
          )}
          {visibleActions.map((action, idx) => {
            const isActive = idx === activeIdx
            return (
              <li
                key={action.id || action.label}
                id={`paperfate-cp-item-${idx}`}
                data-cp-idx={idx}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => runAt(idx)}
                className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-fate-600/30 text-white'
                    : 'text-slate-200 hover:bg-white/5'
                }`}
              >
                <span className="truncate">{action.label}</span>
                {action.shortcut && (
                  <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                    {action.shortcut}
                  </kbd>
                )}
              </li>
            )
          })}
        </ul>
        <div className="flex items-center justify-between gap-2 border-t border-white/5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">
          <span>
            <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-slate-400">↑↓</kbd>{' '}
            navigate
          </span>
          <span>
            <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-slate-400">enter</kbd>{' '}
            run
          </span>
          <span>
            <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-slate-400">esc</kbd>{' '}
            close
          </span>
        </div>
      </div>
    </div>
  )
}
