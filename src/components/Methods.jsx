const SECTIONS = [
  {
    title: 'Training corpus',
    body: 'FateCore is trained on a curated biomedical literature corpus assembled from PubMed, OpenAlex, Crossref, Semantic Scholar, iCite (NIH), Unpaywall, NIH RePORTER, Europe PMC fulltext, and the AWS-hosted PMC Open Access Subset. The corpus spans 3.5M+ articles across more than ten thousand journals and is refreshed continuously.',
  },
  {
    title: 'Pre-submission features only',
    body: 'The model is trained exclusively on signals available before submission: title, abstract, structured Q500 rubric scores, author historical h-index, team composition, target-journal prior-year impact factor and category, funding indicators, MeSH terms, and publication-type flags. Post-publication features (citation counts, fwci, iCite RCR, PMCID/PMC body, OA URL) are excluded from training to avoid leakage between fitted score and real-world manuscript signal.',
  },
  {
    title: 'Architecture',
    body: 'FateCore-v0.2-prod is a LightGBM multi-target regressor with log-transformed targets and class-weighted training. Predictions are calibrated with isotonic regression followed by split-conformal prediction at α=0.10, so each forecast carries a 90% prediction interval rather than a single point estimate. Review timeline is a separate v0.4 LightGBM model trained on PubMed history dates (received → accepted).',
  },
  {
    title: 'What the forecast surfaces',
    body: 'Expected journal tier (JIF point + 90% CI), desk-reject risk, review timeline (days from received to accepted), citation potential at 5 years, an overall impact score, the main weakness, an ordered submission journey with switch-cost reasoning between successive targets, counterfactual suggestions ("if you raised item X to anchor 4, predicted JIF +Y"), and the most lexically similar published papers retrieved through OpenAlex.',
  },
  {
    title: 'Calibration and reporting',
    body: 'Each released model ships with a held-out random-split evaluation (no temporal holdout — IF and citation distributions shift year over year, making temporal split a poor proxy for calibration). Conformal coverage targets 90% on a separate calibration set; current models verify at 89–92% empirical coverage. Tier-stratified mean absolute error is reported for each target.',
  },
  {
    title: 'Limitations',
    body: 'Forecasts are probabilistic, not guarantees. The corpus is biomedical and English-language; non-biomedical or non-English manuscripts will be out-of-distribution. Review-acceptance ground truth is not available, so review timeline is modeled from journal-side received/accepted dates of published papers; rejected submissions are not represented. Reviewer, editor, and timing effects are inherently unmodeled.',
  },
]

export default function Methods() {
  return (
    <section id="methods" className="border-t border-white/5 bg-slate-950/50">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="max-w-2xl">
          <div className="mb-3 inline-flex items-center gap-2 chip">
            <span className="h-1.5 w-1.5 rounded-full bg-fate-400" />
            Methods
          </div>
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">
            How <span className="gradient-text italic">PaperFate</span> reaches a forecast
          </h2>
          <p className="mt-3 text-slate-300">
            Each forecast is a calibrated combination of the manuscript's own text features and journal-side priors. The details below describe what goes in, what stays out, and how the intervals were calibrated.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {SECTIONS.map(s => (
            <div key={s.title} className="card p-5">
              <div className="text-xs font-semibold uppercase tracking-wider text-fate-300">{s.title}</div>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
