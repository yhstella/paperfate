// PaperFate · About + What's new modal.
//
// Subscribes to the 'paperfate:open-about' window event (fired by the
// Cmd+K command palette action in App.jsx). When the event fires we
// open a centered role=dialog modal with two sections:
//   1. "About PaperFate" — short product blurb.
//   2. "What's new" — CHANGELOG.md, rendered through our tiny
//      zero-dep markdown renderer (src/lib/markdown.js).
//
// CHANGELOG fetch strategy:
//   - First try `/CHANGELOG.md`. If the file is published into the Vite
//     public/ dir at build time, this is a same-origin static asset.
//   - If that 404s (changelog still lives at repo root only), fall
//     back to the raw GitHub URL for main. We deliberately fetch
//     unauthenticated and cache for the session in module scope so a
//     user opening the modal twice doesn't re-hit GitHub.
//   - All errors are swallowed into a friendly inline message; we
//     never let the fetch throw into the host app.
//
// Accessibility:
//   - role=dialog, aria-modal=true, aria-labelledby ties to the heading.
//   - Focus is captured on the dialog when opened and restored to the
//     previously focused element on close.
//   - ESC closes; clicking the backdrop closes.
//   - Body scroll is locked while open.
//
// Telemetry:
//   - `trackEvent('about_view')` fires once per open. Honours the
//     existing DNT / GPC / opt-out guards inside `trackEvent`.

import { useCallback, useEffect, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown.js'
import { trackEvent } from '../lib/telemetry.js'

const OPEN_EVENT = 'paperfate:open-about'
const RAW_CHANGELOG_URL =
  'https://raw.githubusercontent.com/yhstella/paperfate/main/CHANGELOG.md'

// Session-scoped cache so a second open doesn't re-fetch.
let cachedChangelog = null

async function fetchChangelog() {
  if (cachedChangelog !== null) return cachedChangelog

  // 1) Try the public/ static asset first.
  try {
    const res = await fetch('/CHANGELOG.md', { credentials: 'omit' })
    if (res && res.ok) {
      const text = await res.text()
      // Guard against an SPA fallback returning index.html for missing
      // files. If we got HTML instead of markdown, treat it as a miss.
      if (text && !/^\s*<!doctype/i.test(text) && !/^\s*<html/i.test(text)) {
        cachedChangelog = text
        return text
      }
    }
  } catch { /* fall through to raw github */ }

  // 2) Fallback to raw github.
  try {
    const res = await fetch(RAW_CHANGELOG_URL, { credentials: 'omit' })
    if (res && res.ok) {
      const text = await res.text()
      if (text) {
        cachedChangelog = text
        return text
      }
    }
  } catch { /* swallow */ }

  return null
}

export default function AboutChangelog() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState('idle') // 'idle' | 'loading' | 'ready' | 'error'
  const [html, setHtml] = useState('')

  const dialogRef = useRef(null)
  const closeBtnRef = useRef(null)
  const lastFocusRef = useRef(null)

  // Subscribe to the open event.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onOpen = () => {
      lastFocusRef.current =
        typeof document !== 'undefined' ? document.activeElement : null
      setOpen(true)
      try { trackEvent('about_view') } catch { /* swallow */ }
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  // Fetch + render the changelog on first open.
  useEffect(() => {
    if (!open) return undefined
    if (status === 'ready' || status === 'loading') return undefined
    let cancelled = false
    setStatus('loading')
    fetchChangelog().then((text) => {
      if (cancelled) return
      if (!text) {
        setStatus('error')
        setHtml('')
        return
      }
      try {
        setHtml(renderMarkdown(text))
        setStatus('ready')
      } catch {
        setStatus('error')
        setHtml('')
      }
    })
    return () => { cancelled = true }
  }, [open, status])

  // Lock body scroll while open.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Move focus to the close button on open, restore on close.
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

  const close = useCallback(() => { setOpen(false) }, [])

  const onKeyDown = useCallback((e) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }, [open, close])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="paperfate-about-title"
      ref={dialogRef}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-16 sm:pt-24"
    >
      {/* Backdrop — click outside closes. */}
      <button
        type="button"
        aria-label="Close About"
        onClick={close}
        className="absolute inset-0 cursor-default bg-ink-950/70 backdrop-blur-sm"
        tabIndex={-1}
      />
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-ink-900/95 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-white/5 px-5 py-3">
          <div>
            <h2
              id="paperfate-about-title"
              className="text-sm font-semibold text-slate-100"
            >
              About PaperFate
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Pre-submission manuscript forecasting. Estimate acceptance
              likelihood, review time, and downstream citations across
              candidate venues — before you submit.
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
        <div className="overflow-y-auto px-5 py-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            What&rsquo;s new
          </h3>
          {status === 'loading' && (
            <p className="text-xs text-slate-500">Loading changelog…</p>
          )}
          {status === 'error' && (
            <p className="text-xs text-slate-500">
              Couldn&rsquo;t load the changelog right now. You can view it on{' '}
              <a
                href="https://github.com/yhstella/paperfate/blob/main/CHANGELOG.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fate-400 underline hover:text-fate-300"
              >
                GitHub
              </a>
              .
            </p>
          )}
          {status === 'ready' && (
            <div
              className="paperfate-md text-sm leading-relaxed text-slate-200"
              // The HTML here is produced by our own minimal renderer,
              // which HTML-escapes the entire input before applying a
              // closed set of markdown patterns. See src/lib/markdown.js
              // for the security model.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
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
