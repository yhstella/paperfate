export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-4 pt-16 pb-10 sm:px-6 sm:pt-24 sm:pb-14">
        <div className="mx-auto max-w-3xl text-center animate-fade-up">
          <div className="mb-5 flex justify-center">
            <span className="chip">
              <span className="h-1.5 w-1.5 rounded-full bg-fate-400" />
              Pre-submission manuscript forecasting
            </span>
          </div>
          <h1 className="font-serif text-4xl leading-tight tracking-tight sm:text-6xl">
            Know your paper's <span className="gradient-text italic">fate</span> before submission.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-base text-slate-300 sm:text-lg">
            PaperFate estimates journal fit, desk-reject risk, expected review timeline,
            and citation potential — by comparing your manuscript against millions of
            published biomedical papers.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href="#simulator" className="btn-primary">
              Simulate my manuscript
              <Arrow />
            </a>
            <a href="#features" className="btn-ghost">See what it predicts</a>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            Free · No account required · Built on a multi-source biomedical corpus
          </p>
        </div>
      </div>
    </section>
  )
}

function Arrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
