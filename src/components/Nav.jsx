import { trackEvent } from '../lib/telemetry.js'
import { FATECORE_VERSION } from '../lib/version.js'
import { t, setLocale, useLocale } from '../lib/i18n.js'

export default function Nav() {
  const locale = useLocale()
  const onNavClick = (target) => {
    trackEvent('nav_click', { target })
  }
  const onLocaleChange = (next) => {
    if (next === locale) return
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
      <button
        type="button"
        onClick={() => onChange('ko')}
        aria-label={t('nav.switch_to_ko')}
        aria-pressed={locale === 'ko'}
        className={`${baseBtn} ${locale === 'ko' ? activeCls : inactiveCls}`}
      >
        KO
      </button>
      <button
        type="button"
        onClick={() => onChange('en')}
        aria-label={t('nav.switch_to_en')}
        aria-pressed={locale === 'en'}
        className={`${baseBtn} ${locale === 'en' ? activeCls : inactiveCls}`}
      >
        EN
      </button>
    </div>
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
