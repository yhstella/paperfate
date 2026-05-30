import { useEffect, useRef, useState } from 'react'
import { trackEvent } from '../lib/telemetry.js'

// Floating amber pill (bottom-left to avoid colliding with SWUpdateToast
// which lives at bottom-right) that surfaces the browser's deferred
// `beforeinstallprompt` event behind our own UX.
//
// Behaviour:
//   1. On mount we listen for 'beforeinstallprompt' and stash the event
//      in a ref so we can call .prompt() later. We preventDefault so the
//      browser does not auto-show its mini-infobar.
//   2. We only consider showing the pill once the user has been
//      meaningfully engaged: 30 seconds of wall-clock time after the
//      first user click anywhere in the document.
//   3. If the app is already installed (display-mode: standalone, or the
//      'appinstalled' event has fired) we never surface the pill.
//   4. Dismiss snoozes for 7 days via localStorage. We re-check the
//      timestamp on every load.
//   5. Install button calls deferredPrompt.prompt(), awaits userChoice,
//      and fires trackEvent('pwa_install_prompt_outcome', { outcome }).
//
// SSR / no-window safe: every browser-only access happens inside an
// effect and is guarded.

const DISMISS_KEY = 'paperfate.pwaPrompt.dismissedUntil'
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const ENGAGEMENT_DELAY_MS = 30 * 1000 // 30s after first meaningful click

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

function isStandalone() {
  if (!isBrowser()) return false
  try {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches
    ) {
      return true
    }
    // iOS Safari historically exposed navigator.standalone for home-screen
    // installs. Harmless to check on other UAs (returns undefined).
    if (typeof navigator !== 'undefined' && navigator.standalone === true) {
      return true
    }
  } catch (_) {
    /* ignore */
  }
  return false
}

export default function PWAInstallPrompt() {
  const [visible, setVisible] = useState(false)
  const [installing, setInstalling] = useState(false)
  const deferredPromptRef = useRef(null)
  const shownTelemetryFiredRef = useRef(false)
  const engagementTimerRef = useRef(null)
  const installedRef = useRef(false)

  useEffect(() => {
    if (!isBrowser()) return
    if (isStandalone()) {
      // Already installed — never surface the pill.
      installedRef.current = true
      return
    }

    function maybeShow() {
      if (installedRef.current) return
      if (!deferredPromptRef.current) return
      const dismissedUntil = readDismissedUntil()
      if (Date.now() < dismissedUntil) return
      setVisible(true)
      if (!shownTelemetryFiredRef.current) {
        shownTelemetryFiredRef.current = true
        try {
          trackEvent('pwa_install_prompt_shown')
        } catch (_) {
          /* ignore */
        }
      }
    }

    function onBeforeInstallPrompt(ev) {
      try {
        // Prevent the browser's default mini-infobar; we'll surface our
        // own pill after the engagement delay.
        if (ev && typeof ev.preventDefault === 'function') {
          ev.preventDefault()
        }
      } catch (_) {
        /* ignore */
      }
      deferredPromptRef.current = ev
      // If the engagement timer has already fired (e.g. user was clicking
      // around for 30s before the browser surfaced the event), show now.
      if (engagementTimerRef.current === 'fired') maybeShow()
    }

    function onAppInstalled() {
      installedRef.current = true
      deferredPromptRef.current = null
      setVisible(false)
    }

    // First-click engagement gate: arm a 30s timer once the user has
    // actually interacted with the page. We don't want the pill to
    // appear on a page they just opened and immediately bounced from.
    function onFirstClick() {
      window.removeEventListener('click', onFirstClick, true)
      engagementTimerRef.current = window.setTimeout(() => {
        engagementTimerRef.current = 'fired'
        maybeShow()
      }, ENGAGEMENT_DELAY_MS)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onAppInstalled)
    window.addEventListener('click', onFirstClick, true)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onAppInstalled)
      window.removeEventListener('click', onFirstClick, true)
      if (
        engagementTimerRef.current &&
        engagementTimerRef.current !== 'fired'
      ) {
        try {
          window.clearTimeout(engagementTimerRef.current)
        } catch (_) {
          /* ignore */
        }
      }
    }
  }, [])

  async function handleInstall() {
    if (installing) return
    const dp = deferredPromptRef.current
    if (!dp || typeof dp.prompt !== 'function') {
      setVisible(false)
      return
    }
    setInstalling(true)
    let outcome = 'unknown'
    try {
      dp.prompt()
      if (dp.userChoice && typeof dp.userChoice.then === 'function') {
        const choice = await dp.userChoice
        if (choice && typeof choice.outcome === 'string') {
          outcome = choice.outcome // 'accepted' | 'dismissed'
        }
      }
    } catch (_) {
      outcome = 'error'
    }
    try {
      trackEvent('pwa_install_prompt_outcome', { outcome })
    } catch (_) {
      /* ignore */
    }
    // The deferred prompt is single-use per browser spec.
    deferredPromptRef.current = null
    setInstalling(false)
    setVisible(false)
  }

  function handleDismiss() {
    writeDismissedUntil(Date.now() + DISMISS_DURATION_MS)
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div
      role="dialog"
      aria-label="Install PaperFate"
      className="fixed bottom-4 left-4 z-50 max-w-xs"
    >
      <div className="flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/15 px-4 py-2 text-xs text-amber-100 shadow-lg backdrop-blur">
        <span className="font-medium">Install PaperFate</span>
        <button
          type="button"
          onClick={handleInstall}
          disabled={installing}
          className="rounded-full bg-amber-400/90 px-2.5 py-1 text-[11px] font-semibold text-ink-900 transition hover:bg-amber-300 disabled:opacity-60"
        >
          {installing ? 'Installing…' : 'Install'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss install prompt"
          className="ml-1 rounded-full px-1.5 py-0.5 text-amber-200/80 transition hover:text-amber-100"
        >
          ×
        </button>
      </div>
    </div>
  )
}
