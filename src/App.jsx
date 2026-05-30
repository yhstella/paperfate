import { useState, lazy, Suspense } from 'react'
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

// Code-split: Compare is a heavier sibling of Simulator and most first
// loads land on Simulator. Lazy-load it so initial JS stays lean.
const Compare = lazy(() => import('./components/Compare.jsx'))
// Status fires a handful of probe fetches on mount; lazy-load so users
// who never click the tab don't pay the network cost.
const Status = lazy(() => import('./components/Status.jsx'))

const TABS = [
  { key: 'simulator', label: 'Simulator' },
  { key: 'compare',   label: 'Compare venues' },
  { key: 'status',    label: 'Status' },
]

export default function App() {
  const [tab, setTab] = useState('simulator')
  const activeLabel = (TABS.find(t => t.key === tab) || TABS[0]).label
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
          <ErrorBoundary name="Features"><Features /></ErrorBoundary>
          <ErrorBoundary name="AboutFateCore"><AboutFateCore /></ErrorBoundary>
          <ErrorBoundary name="Methods"><Methods /></ErrorBoundary>
          <ErrorBoundary name="FAQ"><FAQ /></ErrorBoundary>
        </main>
        <Footer />
        {/* Persists across tab switches; renders nothing unless the SW
            signals a waiting/updated worker and the 24h snooze has elapsed. */}
        <SWUpdateToast />
      </div>
    </ErrorBoundary>
  )
}
