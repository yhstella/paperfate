import { useState } from 'react'
import Nav from './components/Nav.jsx'
import Hero from './components/Hero.jsx'
import Simulator from './components/Simulator.jsx'
import Compare from './components/Compare.jsx'
import Features from './components/Features.jsx'
import AboutFateCore from './components/AboutFateCore.jsx'
import Methods from './components/Methods.jsx'
import FAQ from './components/FAQ.jsx'
import Footer from './components/Footer.jsx'

const TABS = [
  { key: 'simulator', label: 'Simulator' },
  { key: 'compare',   label: 'Compare venues' },
]

export default function App() {
  const [tab, setTab] = useState('simulator')
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="inline-flex rounded-lg border border-white/10 bg-ink-900 p-1 text-xs">
            {TABS.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`rounded-md px-3 py-1.5 transition ${tab === t.key ? 'bg-fate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {tab === 'simulator' && <Simulator />}
        {tab === 'compare' && <Compare />}
        <Features />
        <AboutFateCore />
        <Methods />
        <FAQ />
      </main>
      <Footer />
    </div>
  )
}
