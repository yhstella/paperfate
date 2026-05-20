const PILLARS = [
  {
    title: 'Retrieval',
    body: 'SPECTER2 scientific embeddings (768-dim) match your manuscript against papers with comparable topic, design, and venue history.',
  },
  {
    title: 'Rubric',
    body: 'Q500 — a 500-item evaluation framework across 14 reporting domains (CONSORT, STROBE, TRIPOD, PRISMA), with a Q100 abstract-only subset for early forecasts.',
  },
  {
    title: 'Calibration',
    body: 'Journal-year-stratified models for citation range, desk-reject probability, and review timeline — anchored to real JCR Impact Factor records and per-venue acceptance patterns.',
  },
]

export default function AboutFateCore() {
  return (
    <section id="fatecore" className="border-y border-white/5 bg-slate-950/40">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="max-w-2xl">
          <div className="mb-3 inline-flex items-center gap-2 chip">
            <span className="h-1.5 w-1.5 rounded-full bg-fate-400" />
            Model
          </div>
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">
            About <span className="gradient-text italic">FateCore</span>
          </h2>
          <p className="mt-3 text-slate-300">
            FateCore is the inference engine behind PaperFate. It is trained on a curated
            corpus of biomedical papers with publication outcomes — actual journal placement,
            citation trajectories, and review timelines — across 35+ clinical and methodological
            specialties.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PILLARS.map((p) => (
            <div key={p.title} className="card p-5">
              <div className="text-xs uppercase tracking-wider text-fate-300">{p.title}</div>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{p.body}</p>
            </div>
          ))}
        </div>

        <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-4">
          <Stat label="Papers in corpus" value="200K+" hint="biomedical, 2005–2025" />
          <Stat label="Journals covered" value="4,400+" hint="with IF history" />
          <Stat label="Specialties" value="35+" hint="clinical + methodological" />
          <Stat label="Embedding dim" value="768" hint="SPECTER2" />
        </dl>

        <p className="mt-10 max-w-3xl text-sm text-slate-400">
          Current release:{' '}
          <span className="font-mono text-slate-200">FateCore v0.1</span>.
          Forecasts are probabilistic ranges with explicit uncertainty. Calibration metrics
          and held-out validation are reported with each release.
        </p>
      </div>
    </section>
  )
}

function Stat({ label, value, hint }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-1 font-serif text-2xl text-slate-100">{value}</dd>
      <div className="text-xs text-slate-500">{hint}</div>
    </div>
  )
}
