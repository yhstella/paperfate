const QA = [
  {
    q: 'Is this just predicting journal Impact Factor?',
    a: 'No. IF is a venue-level number — it tells you nothing about your specific paper. PaperFate forecasts the actual impact of your manuscript: where comparable work landed, how often it was cited, how fast, and what reviewers tend to push back on.',
  },
  {
    q: 'Where does the data come from?',
    a: 'PaperFate is built on PubMed (NCBI E-utilities), OpenAlex (≈250M scholarly works), Semantic Scholar (citation graph, influential citations, SPECTER2 embeddings), and Crossref metadata — joined and deduplicated per DOI. Journal-level Impact Factor history is reconciled against JCR and venue-level archives.',
  },
  {
    q: 'How accurate is the forecast?',
    a: 'For citation ranges we report calibration on a held-out set of biomedical papers from 2018–2022. Forecasts are probabilistic ranges with explicit uncertainty, never single-point predictions. Validation metrics are published alongside each release.',
  },
  {
    q: 'Will my abstract be stored or used to train models?',
    a: 'Submissions are processed in your browser and discarded after the forecast. No accounts, no logging of full text. Saved reports are opt-in.',
  },
  {
    q: 'Which fields are supported?',
    a: 'FateCore v0.1 covers clinical and translational biomedicine across 35+ specialties and methodological domains — internal medicine, surgery, oncology, neurology, methodology (RCTs, meta-analysis, AI/ML, decision curve, external validation), and more.',
  },
]

export default function FAQ() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">FAQ</h2>
      <div className="mt-8 divide-y divide-white/5 border-y border-white/5">
        {QA.map((it, i) => (
          <details key={i} className="group py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
              <span className="font-medium text-slate-100">{it.q}</span>
              <span className="text-slate-500 transition group-open:rotate-45">+</span>
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-slate-400">{it.a}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
