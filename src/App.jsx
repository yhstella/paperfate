import './lib/polyfills.js'
import { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import Nav from './components/Nav.jsx'
import Hero from './components/Hero.jsx'
import Simulator from './components/Simulator.jsx'
import Features from './components/Features.jsx'
import AboutFateCore from './components/AboutFateCore.jsx'
import Methods from './components/Methods.jsx'
import FAQ from './components/FAQ.jsx'
import Footer from './components/Footer.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import SWUpdateToast from './components/SWUpdateToast.jsx'
import PWAInstallPrompt from './components/PWAInstallPrompt.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import AboutChangelog from './components/AboutChangelog.jsx'
import FeedbackWidget from './components/FeedbackWidget.jsx'
import { registerShortcuts } from './lib/shortcuts.js'
import { getLocale, setLocale } from './lib/i18n.js'
import * as perfMonitor from './lib/perfMonitor.js'

// Code-split: Compare is a heavier sibling of Simulator and most first
// loads land on Simulator. Lazy-load it so initial JS stays lean.
const Compare = lazy(() => import('./components/Compare.jsx'))
// Status fires a handful of probe fetches on mount; lazy-load so users
// who never click the tab don't pay the network cost.
const Status = lazy(() => import('./components/Status.jsx'))
// Admin is an operator-only panel hidden behind the
// `paperfate.admin_mode` localStorage flag — see `adminMode` below. We
// lazy-load it for the same reason as Status: regular users never reach
// for this tab so they shouldn't pay for it on first load.
const Admin = lazy(() => import('./components/Admin.jsx'))

const BASE_TABS = [
  { key: 'simulator', label: 'Simulator' },
  { key: 'compare',   label: 'Compare venues' },
  { key: 'status',    label: 'Status' },
]
const ADMIN_TAB = { key: 'admin', label: 'Admin' }

// Read the admin-mode flag once at module evaluation time. Operators
// flip it in devtools then reload, so we don't bother subscribing to
// storage events — a reload is the documented enablement path.
function readAdminMode() {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem('paperfate.admin_mode') === '1'
  } catch { return false }
}

export default function App() {
  const [tab, setTab] = useState('simulator')
  // Admin mode is evaluated once on first render. We deliberately don't
  // subscribe to changes — flipping the flag requires a page reload, which
  // also gives the lazy Admin chunk a clean fetch.
  const [adminMode] = useState(() => readAdminMode())
  const TABS = useMemo(() => (adminMode ? [...BASE_TABS, ADMIN_TAB] : BASE_TABS), [adminMode])
  const activeLabel = (TABS.find(t => t.key === tab) || TABS[0]).label

  // Register the global Cmd/Ctrl+K shortcut once on mount. The handler
  // dispatches a window event that CommandPalette subscribes to, so we
  // don't need to thread refs through the tree.
  useEffect(() => {
    const unregister = registerShortcuts()
    return unregister
  }, [])

  // Boot the long-task + LCP performance monitor after the first paint.
  // We defer via requestAnimationFrame so the observer attaches just
  // after the initial render commits — early enough that `buffered:
  // true` still catches the LCP candidate, but late enough that we
  // don't pile work into the first-paint critical path.
  useEffect(() => {
    let cancelled = false
    let raf = 0
    const start = () => { if (!cancelled) perfMonitor.init() }
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      raf = window.requestAnimationFrame(start)
    } else {
      start()
    }
    return () => {
      cancelled = true
      if (raf && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        try { window.cancelAnimationFrame(raf) } catch { /* ignore */ }
      }
      perfMonitor.dispose()
    }
  }, [])

  // Command palette actions. We rebuild on every tab change so the
  // 'Clear current input' row only appears on Simulator. Each `run` is
  // a closure over the current setTab / setter.
  const paletteActions = useMemo(() => {
    return [
      {
        id: 'switch-simulator',
        label: 'Switch to Simulator',
        shortcut: 'Tab 1',
        run: () => {
          setTab('simulator')
          if (typeof window !== 'undefined') {
            try { window.location.hash = '#simulator' } catch { /* ignore */ }
          }
        },
      },
      {
        id: 'switch-compare',
        label: 'Switch to Compare venues',
        shortcut: 'Tab 2',
        run: () => { setTab('compare') },
      },
      {
        id: 'switch-status',
        label: 'Switch to Status',
        shortcut: 'Tab 3',
        run: () => { setTab('status') },
      },
      {
        id: 'clear-input',
        label: 'Clear current input',
        available: () => tab === 'simulator',
        run: () => {
          // Drop any persisted draft so a reload starts clean, and
          // fire a CustomEvent that Simulator can (optionally) listen
          // to in order to wipe live form state without a reload.
          if (typeof window !== 'undefined') {
            try { window.localStorage?.removeItem('paperfate.simulator.draft') } catch { /* ignore */ }
            try { window.dispatchEvent(new CustomEvent('paperfate:clear-simulator-draft')) } catch { /* ignore */ }
          }
        },
      },
      {
        id: 'open-history',
        label: 'Open history',
        run: () => {
          // Make sure we're on Simulator (where the history drawer
          // lives) and ask it to open the drawer.
          setTab('simulator')
          if (typeof window !== 'undefined') {
            try { window.dispatchEvent(new CustomEvent('paperfate:open-history')) } catch { /* ignore */ }
          }
        },
      },
      {
        id: 'toggle-locale',
        label: 'Toggle locale (KO ↔ EN)',
        run: () => {
          const next = getLocale() === 'ko' ? 'en' : 'ko'
          setLocale(next)
        },
      },
      {
        id: 'privacy-settings',
        label: 'Privacy settings',
        run: () => {
          // Nav listens for this event (or will). If nothing listens,
          // we fall back to a no-op so the palette still closes.
          if (typeof window !== 'undefined') {
            try { window.dispatchEvent(new CustomEvent('paperfate:open-privacy')) } catch { /* ignore */ }
          }
        },
      },
      {
        id: 'run-smoke',
        label: 'Run smoke from Status',
        run: () => {
          setTab('status')
          if (typeof window !== 'undefined') {
            // Defer so the Status tab has mounted before we ask it to refresh.
            setTimeout(() => {
              try { window.dispatchEvent(new CustomEvent('paperfate:run-smoke')) } catch { /* ignore */ }
            }, 50)
          }
        },
      },
      {
        id: 'view-api-docs',
        label: 'View API docs',
        run: () => {
          if (typeof window !== 'undefined') {
            try {
              window.open(
                'https://github.com/yhstella/paperfate/blob/main/docs/API.md',
                '_blank',
                'noopener,noreferrer',
              )
            } catch { /* ignore */ }
          }
        },
      },
      {
        id: 'view-user-guide',
        label: 'View user guide',
        run: () => {
          if (typeof window !== 'undefined') {
            try {
              window.open(
                'https://github.com/yhstella/paperfate/blob/main/docs/USER_GUIDE.md',
                '_blank',
                'noopener,noreferrer',
              )
            } catch { /* ignore */ }
          }
        },
      },
      {
        id: 'open-about',
        label: 'About + What’s new',
        run: () => {
          // AboutChangelog mounts at the App root and subscribes to
          // this event; it fetches CHANGELOG.md, renders it through
          // our minimal markdown lib, and opens a modal.
          if (typeof window !== 'undefined') {
            try { window.dispatchEvent(new CustomEvent('paperfate:open-about')) } catch { /* ignore */ }
          }
        },
      },
    ]
  }, [tab])

  return (
    <ErrorBoundary name="App">
      <div className="min-h-screen flex flex-col">
        <Nav />
        <main className="flex-1">
          <Hero />
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div
              role="tablist"
              aria-label="Workflow"
              className="inline-flex rounded-lg border border-white/10 bg-ink-900 p-1 text-xs"
            >
              {TABS.map(t => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`rounded-md px-3 py-1.5 transition ${tab === t.key ? 'bg-fate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {/* Polite live region so screen readers announce tab changes. */}
            <div className="sr-only" aria-live="polite" aria-atomic="true">
              {`${activeLabel} tab selected`}
            </div>
          </div>
          {tab === 'simulator' && (
            <ErrorBoundary name="Simulator">
              <Simulator />
            </ErrorBoundary>
          )}
          {tab === 'compare' && (
            <ErrorBoundary name="Compare">
              <Suspense
                fallback={
                  <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 text-sm text-slate-400">
                    Loading comparison…
                  </div>
                }
              >
                <Compare />
              </Suspense>
            </ErrorBoundary>
          )}
          {tab === 'status' && (
            <ErrorBoundary name="Status">
              <Suspense
                fallback={
                  <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 text-sm text-slate-400">
                    Loading status…
                  </div>
                }
              >
                <Status />
              </Suspense>
            </ErrorBoundary>
          )}
          {tab === 'admin' && adminMode && (
            <ErrorBoundary name="Admin">
              <Suspense
                fallback={
                  <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 text-sm text-slate-400">
                    Loading admin…
                  </div>
                }
              >
                <Admin />
              </Suspense>
            </ErrorBoundary>
          )}
          <ErrorBoundary name="Features"><Features /></ErrorBoundary>
          <ErrorBoundary name="AboutFateCore"><AboutFateCore /></ErrorBoundary>
          <ErrorBoundary name="Methods"><Methods /></ErrorBoundary>
          <ErrorBoundary name="FAQ"><FAQ /></ErrorBoundary>
        </main>
        <Footer />
        {/* Persists across tab switches; renders nothing unless the SW
            signals a waiting/updated worker and the 24h snooze has elapsed. */}
        <SWUpdateToast />
        {/* Floating amber pill that surfaces the deferred PWA install
            prompt after 30s of engagement. Renders nothing until then. */}
        <PWAInstallPrompt />
        {/* Cmd/Ctrl+K command palette. Renders nothing until the
            shortcut fires the 'paperfate:open-command-palette' event. */}
        <CommandPalette actions={paletteActions} />
        {/* About + What's new modal. Renders nothing until the
            'paperfate:open-about' event is dispatched (from the
            command palette action above). */}
        <AboutChangelog />
        {/* Floating "Feedback" button at bottom-right (just above the
            SWUpdateToast pill). Opens a small modal that POSTs to
            /api/feedback and renders an in-place "Thanks!" toast. */}
        <FeedbackWidget />
      </div>
    </ErrorBoundary>
  )
}
