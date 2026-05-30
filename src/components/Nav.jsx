import { useEffect, useRef, useState } from 'react'
import { trackEvent, getTelemetryStatus, setOptOut } from '../lib/telemetry.js'
import { FATECORE_VERSION } from '../lib/version.js'
import { t, setLocale, useLocale } from '../lib/i18n.js'

const LOCALE_OPTIONS = [
  { code: 'ko', short: 'KO', labelKey: 'nav.switch_to_ko', fallbackLabel: '한국어' },
  { code: 'en', short: 'EN', labelKey: 'nav.switch_to_en', fallbackLabel: 'English' },
  { code: 'zh', short: 'ZH', labelKey: 'nav.switch_to_zh', fallbackLabel: '中文' },
  { code: 'ja', short: 'JA', labelKey: 'nav.switch_to_ja', fallbackLabel: '日本語' },
]

export default function Nav() {
  const locale = useLocale()
  const onNavClick = (target) => {
    trackEvent('nav_click', { target })
  }
  const onLocaleChange = (next) => {
    if (next === locale) return
    if (!LOCALE_OPTIONS.some((o) => o.code === next)) return
    setLocale(next)
    trackEvent('locale_change', { locale: next })
  }
  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-ink-950/70 backdrop-blur" role="banner">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <a
          href="#top"
          className="flex items-center gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-400/60"
          aria-label="PaperFate home"
          onClick={() => onNavClick('home')}
        >
          <Logo />
          <span className="text-sm font-semibold tracking-tight">
            PaperFate
          </span>
        </a>
        <nav className="hidden items-center gap-1 sm:flex" aria-label={t('nav.primary_navigation')}>
          <a
            href="#simulator"
            className="rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-400/60"
            onClick={() => onNavClick('simulator')}
          >Simulator</a>
          <a
            href="#features"
            className="rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-400/60"
            onClick={() => onNavClick('features')}
          >What it predicts</a>
          <a
            href="#faq"
            className="rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-400/60"
            onClick={() => onNavClick('faq')}
          >FAQ</a>
          <a
            href="#simulator"
            className="btn-primary ml-2 px-4 py-2 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-400/60"
            onClick={() => onNavClick('cta_try_demo')}
          >Try the demo</a>
          <LocaleSwitcher locale={locale} onChange={onLocaleChange} />
          <PrivacyMenu />
          <span
            className="chip ml-2 text-slate-200"
            role="note"
            aria-label={`FateCore model version ${FATECORE_VERSION}`}
          >
            FateCore {FATECORE_VERSION}
          </span>
        </nav>
      </div>
    </header>
  )
}

function LocaleSwitcher({ locale, onChange }) {
  const baseBtn =
    'rounded-md px-2 py-1 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-400/60'
  const activeCls = 'bg-white/10 text-white'
  const inactiveCls = 'text-slate-300 hover:bg-white/5 hover:text-white'
  return (
    <div
      role="group"
      aria-label={t('nav.lang_label')}
      className="ml-2 flex items-center gap-0.5 rounded-lg border border-white/5 bg-white/[0.02] p-0.5"
    >
      {LOCALE_OPTIONS.map((opt) => {
        const translated = t(opt.labelKey)
        const label = translated === opt.labelKey ? opt.fallbackLabel : translated
        const isActive = locale === opt.code
        return (
          <button
            key={opt.code}
            type="button"
            onClick={() => onChange(opt.code)}
            aria-label={label}
            aria-pressed={isActive}
            className={`${baseBtn} ${isActive ? activeCls : inactiveCls}`}
          >
            {opt.short}
          </button>
        )
      })}
    </div>
  )
}

function PrivacyMenu() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState(() => getTelemetryStatus())
  const wrapRef = useRef(null)

  // Re-read status whenever the popover opens, whenever telemetry
  // changes elsewhere, and whenever the user clicks outside to close.
  useEffect(() => {
    const refresh = () => setStatus(getTelemetryStatus())
    if (typeof window !== 'undefined') {
      window.addEventListener('paperfate:telemetry-changed', refresh)
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('paperfate:telemetry-changed', refresh)
      }
    }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    setStatus(getTelemetryStatus())
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onToggle = () => {
    const next = !(status.optOut)
    setOptOut(next)
    setStatus(getTelemetryStatus())
  }

  const isOn = status.effective_enabled
  const forcedOffByBrowser = status.dnt || status.gpc
  const statusLine = isOn
    ? t('privacy.telemetry_status_on')
    : t('privacy.telemetry_status_off')
  const browserNote = status.dnt
    ? t('privacy.telemetry_dnt_detected')
    : status.gpc
      ? t('privacy.telemetry_gpc_detected')
      : ''

  return (
    <div ref={wrapRef} className="relative ml-2">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label={t('nav.privacy_label')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="rounded-md p-1.5 text-slate-300 transition hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-400/60"
      >
        <ShieldIcon on={isOn} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('nav.privacy_label')}
          className="absolute right-0 z-40 mt-2 w-64 rounded-lg border border-white/10 bg-ink-950/95 p-3 text-xs text-slate-200 shadow-xl backdrop-blur"
        >
          <p className="mb-2 font-medium text-slate-100">{statusLine}</p>
          {browserNote && (
            <p className="mb-2 text-[11px] leading-snug text-slate-400">{browserNote}</p>
          )}
          <button
            type="button"
            onClick={onToggle}
            disabled={forcedOffByBrowser}
            aria-disabled={forcedOffByBrowser}
            className="w-full rounded-md border border-white/10 px-2 py-1.5 text-xs text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-400/60"
          >
            {status.optOut ? t('privacy.toggle_enable') : t('privacy.toggle_disable')}
          </button>
        </div>
      )}
    </div>
  )
}

function ShieldIcon({ on }) {
  const stroke = on ? '#cbd5e1' : '#a78bfa'
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3l8 3v6c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V6l8-3z"
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {!on && (
        <path
          d="M5 5l14 14"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#0f1118" />
      <path d="M16 14h22l10 10v36H16z" fill="none" stroke="url(#lg)" strokeWidth="3" />
      <path d="M38 14v10h10" fill="none" stroke="url(#lg)" strokeWidth="3" />
      <circle cx="32" cy="42" r="9" fill="none" stroke="url(#lg)" strokeWidth="3" />
      <path d="M32 36v6l4 3" fill="none" stroke="url(#lg)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
