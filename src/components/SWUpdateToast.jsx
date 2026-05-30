import { useEffect, useRef, useState } from 'react'
import { skipWaiting } from '../lib/swUpdater.js'

// Floating amber pill (bottom-right) that surfaces when the service worker
// reports a new version is available. Two triggers:
//
//   1. 'paperfate:sw-waiting'  — fired by swUpdater's periodic check when
//      reg.waiting becomes non-null. Carries { registration } in detail.
//   2. 'paperfate:sw-updated'  — fired on controllerchange (a new worker
//      has just taken over). We surface the same prompt; clicking Reload
//      just triggers location.reload() because there's nothing waiting.
//
// Dismiss writes a 24h snooze timestamp to localStorage so a single user
// reload-decline doesn't keep pestering them across the same day.
//
// SSR / no-window safe: all browser-only access is inside effects and guarded.

const DISMISS_KEY = 'paperfate.swToast.dismissedUntil'
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000 // 24h

function isBrowser() {
  return typeof window !== 'undefined'
}

function readDismissedUntil() {
  if (!isBrowser()) return 0
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    if (!raw) return 0
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  } catch (_) {
    return 0
  }
}

function writeDismissedUntil(ts) {
  if (!isBrowser()) return
  try {
    window.localStorage.setItem(DISMISS_KEY, String(ts))
  } catch (_) {
    /* ignore */
  }
}

export default function SWUpdateToast() {
  const [visible, setVisible] = useState(false)
  const [reloading, setReloading] = useState(false)
  const waitingRegRef = useRef(null)
  const controllerChangeBoundRef = useRef(false)

  useEffect(() => {
    if (!isBrowser()) return

    function maybeShow() {
      const dismissedUntil = readDismissedUntil()
      if (Date.now() < dismissedUntil) return
      setVisible(true)
    }

    function onWaiting(ev) {
      try {
        const reg = ev && ev.detail && ev.detail.registration
        if (reg) waitingRegRef.current = reg
      } catch (_) {
        /* ignore */
      }
      maybeShow()
    }

    function onUpdated() {
      // controllerchange: a new worker has taken over. If we initiated this
      // via Reload, we've already set reloading=true and triggered the
      // page reload. Otherwise (a different tab activated it), still
      // surface the prompt so this tab can refresh too.
      if (reloading) return
      maybeShow()
    }

    window.addEventListener('paperfate:sw-waiting', onWaiting)
    window.addEventListener('paperfate:sw-updated', onUpdated)
    return () => {
      window.removeEventListener('paperfate:sw-waiting', onWaiting)
      window.removeEventListener('paperfate:sw-updated', onUpdated)
    }
  }, [reloading])

  async function handleReload() {
    if (reloading) return
    setReloading(true)
    const reg = waitingRegRef.current
    // If we have a waiting registration, ask it to skip waiting and reload
    // only once the new worker takes control (controllerchange fires).
    // If not (e.g. only the 'sw-updated' event triggered us), just reload.
    if (
      reg &&
      reg.waiting &&
      isBrowser() &&
      'serviceWorker' in navigator
    ) {
      if (!controllerChangeBoundRef.current) {
        controllerChangeBoundRef.current = true
        try {
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => {
              try {
                window.location.reload()
              } catch (_) {
                /* ignore */
              }
            },
            { once: true }
          )
        } catch (_) {
          /* ignore */
        }
      }
      try {
        skipWaiting(reg)
      } catch (_) {
        /* ignore */
      }
      // Fallback: if controllerchange never fires (e.g. user has DevTools
      // "Update on reload" disabled in some weird state), force-reload
      // after 3s so we don't appear stuck.
      setTimeout(() => {
        try {
          window.location.reload()
        } catch (_) {
          /* ignore */
        }
      }, 3000)
      return
    }
    // No registration handle — just reload.
    try {
      window.location.reload()
    } catch (_) {
      /* ignore */
    }
  }

  function handleDismiss() {
    writeDismissedUntil(Date.now() + DISMISS_DURATION_MS)
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 max-w-xs"
    >
      <div className="flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/15 px-4 py-2 text-xs text-amber-100 shadow-lg backdrop-blur">
        <span className="font-medium">Update available</span>
        <button
          type="button"
          onClick={handleReload}
          disabled={reloading}
          className="rounded-full bg-amber-400/90 px-2.5 py-1 text-[11px] font-semibold text-ink-900 transition hover:bg-amber-300 disabled:opacity-60"
        >
          {reloading ? 'Reloading…' : 'Reload'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss update notification"
          className="ml-1 rounded-full px-1.5 py-0.5 text-amber-200/80 transition hover:text-amber-100"
        >
          ×
        </button>
      </div>
    </div>
  )
}
