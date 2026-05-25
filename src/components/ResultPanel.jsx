export default function ResultPanel({ result, input }) {
  const { tier, deskReject, timeline, citation, score, weakness, suggestions, similars, journey } = result

  return (
    <div className="card p-6 animate-fade-up">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400">Forecast for</div>
          <div className="mt-0.5 font-serif text-lg italic text-slate-200">
            "{(input.title || 'Untitled manuscript').slice(0, 90)}{input.title.length > 90 ? '…' : ''}"
          </div>
        </div>
        <ScoreDial score={score} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Expected journal tier" tone="primary">
          <div className="text-2xl font-semibold">{tier.range}</div>
          <div className="mt-1 text-xs text-slate-400">Best-fit: {tier.bestFit}</div>
          <div className="mt-2 text-xs text-slate-500">Stretch: {tier.stretch}</div>
        </Card>

        <Card title="Desk-reject risk">
          <div className="text-2xl font-semibold">{deskReject.label}</div>
          <Bar pct={deskReject.pct} />
          <div className="mt-1 text-xs text-slate-500">{deskReject.pct}% at your target tier</div>
        </Card>

        <Card title="Expected review timeline">
          <div className="text-2xl font-semibold">{timeline.weeks} <span className="text-base font-normal text-slate-400">weeks to decision</span></div>
          <div className="mt-1 text-xs text-slate-500">{timeline.note}</div>
        </Card>

        <Card title="Citation potential (5y)">
          <div className="text-2xl font-semibold">{citation.range}</div>
          <div className="mt-1 text-xs text-slate-400">Percentile in field: top {citation.percentile}%</div>
          <div className="mt-2 text-xs text-slate-500">Median of similar papers: {citation.peerMedian}</div>
        </Card>

        <Card title="Actual Impact Score">
          <div className="text-2xl font-semibold">{score}/100</div>
          <Bar pct={score} />
          <div className="mt-1 text-xs text-slate-500">
            Composite: novelty · methods · clinical relevance · momentum
          </div>
        </Card>

        <Card title="Main weakness">
          <div className="text-sm leading-relaxed text-slate-300">{weakness}</div>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">How to lift impact</h3>
          <ul className="space-y-2 text-sm text-slate-300">
            {suggestions.map((s, i) => (
              <li key={i} className="flex gap-3 rounded-lg border border-white/5 bg-ink-900/60 p-3">
                <span className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-fate-500/20 text-xs font-semibold text-fate-300">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:col-span-2">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">Most similar published papers</h3>
          <ul className="space-y-2">
            {similars.map((p, i) => (
              <li key={i} className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
                <div className="line-clamp-2 text-sm text-slate-200">{p.title}</div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-400">
                  <span className="chip">{p.venue}</span>
                  <span className="chip">IF {p.if}</span>
                  <span className="chip">{p.year}</span>
                  <span className="chip">{p.citations}× cited</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {journey && journey.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
            Recommended submission journey
          </h3>
          <p className="mb-4 text-xs text-slate-500">
            An ordered sequence to try if a submission is declined. Each step is chosen so the
            manuscript needs minimal reformatting to move on.
          </p>
          <ol className="space-y-3">
            {journey.map((j, i) => (
              <li key={i} className="flex gap-3 rounded-lg border border-white/5 bg-ink-900/60 p-4">
                <div className="flex-none">
                  <div className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-fate-500/20 text-xs font-semibold text-fate-300">
                    {j.step}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold text-slate-100">{j.venue}</span>
                    <span className="chip">IF {j.if}</span>
                    <span className="chip">{j.publisher}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-400">{j.style}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className={`chip ${
                      j.switchCost === 'minimal' || j.switchCost === 'first submission' ? 'border-emerald-400/30 text-emerald-300/90 bg-emerald-400/[0.06]' :
                      j.switchCost === 'low' ? 'border-fate-400/30 text-fate-300 bg-fate-400/[0.06]' :
                      j.switchCost === 'moderate' ? 'border-amber-400/30 text-amber-200/90 bg-amber-400/[0.06]' :
                      'border-rose-400/30 text-rose-300/90 bg-rose-400/[0.06]'
                    }`}>
                      {i === 0 ? 'start' : `switch cost · ${j.switchCost}`}
                    </span>
                    {j.switchReason && <span className="text-slate-400">{j.switchReason}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="mt-6 text-xs text-slate-500">
        ⓘ Forecast is probabilistic, not a guarantee. PaperFate compares your manuscript against
        published literature; outcomes also depend on reviewers, editors, and timing.
      </p>
    </div>
  )
}

function Card({ title, tone, children }) {
  const accent = tone === 'primary' ? 'border-fate-500/30 bg-fate-500/[0.06]' : 'border-white/5 bg-ink-900/60'
  return (
    <div className={`rounded-xl border p-4 ${accent}`}>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</div>
      {children}
    </div>
  )
}

function Bar({ pct }) {
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <div
        className="h-full rounded-full bg-gradient-to-r from-fate-500 to-fate-300"
        style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
      />
    </div>
  )
}

function ScoreDial({ score }) {
  const r = 28, c = 2 * Math.PI * r
  const offset = c - (score / 100) * c
  return (
    <div className="relative h-20 w-20 flex-none">
      <svg viewBox="0 0 70 70" className="h-full w-full -rotate-90">
        <circle cx="35" cy="35" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="6" fill="none" />
        <circle
          cx="35" cy="35" r={r} stroke="url(#dial)" strokeWidth="6" fill="none"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset}
        />
        <defs>
          <linearGradient id="dial" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#c4b5fd" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-semibold">{score}</span>
        <span className="text-[9px] uppercase tracking-wider text-slate-400">score</span>
      </div>
    </div>
  )
}
