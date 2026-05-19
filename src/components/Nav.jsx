export default function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-ink-950/70 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <a href="#top" className="flex items-center gap-2">
          <Logo />
          <span className="text-sm font-semibold tracking-tight">
            PaperFate
          </span>
          <span className="chip ml-1">FateCore v0.1 · Beta</span>
        </a>
        <nav className="hidden items-center gap-1 sm:flex">
          <a href="#simulator" className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5">Simulator</a>
          <a href="#features" className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5">What it predicts</a>
          <a href="#faq" className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5">FAQ</a>
          <a href="#simulator" className="btn-primary ml-2 px-4 py-2 text-xs">Try the demo</a>
        </nav>
      </div>
    </header>
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
