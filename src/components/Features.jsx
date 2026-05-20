const ITEMS = [
  {
    title: 'Journal tier & best fit',
    body: 'Predicted IF range plus a shortlist of journals where comparable papers actually landed in the last 5 years.',
    icon: 'tier',
  },
  {
    title: 'Recommended submission journey',
    body: 'An ordered sequence of journals to try — optimized so each successive target shares formatting, reference style, and reporting checklists with the previous, minimizing rework if a submission gets rejected.',
    icon: 'journey',
  },
  {
    title: 'Desk-reject risk',
    body: 'Probability that an editor sends it back without external review — modeled from scope, novelty, and venue history.',
    icon: 'flag',
  },
  {
    title: 'Review timeline',
    body: 'Expected weeks from submission to first decision, conditioned on target tier and study type.',
    icon: 'clock',
  },
  {
    title: 'Citation potential',
    body: 'Field- and year-normalized 3-year and 5-year citation forecast, with percentile in your domain.',
    icon: 'cite',
  },
  {
    title: 'Reviewer-risk patterns',
    body: 'Where reviewers most often push back on similar work — sample size, validation, endpoint choice, generalizability.',
    icon: 'shield',
  },
  {
    title: 'Title & abstract lift',
    body: 'Specific edits that, in comparable papers, correlated with higher early citation velocity.',
    icon: 'wand',
  },
]

export default function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="max-w-2xl">
        <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">What PaperFate predicts</h2>
        <p className="mt-3 text-slate-400">
          Seven forecasts, grounded in similarity search against published biomedical literature
          and field-normalized citation patterns. Probabilistic — never absolute.
        </p>
      </div>
      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.map((it) => (
          <div key={it.title} className="card p-5">
            <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-fate-500/15 text-fate-300">
              <Icon name={it.icon} />
            </div>
            <div className="font-semibold">{it.title}</div>
            <p className="mt-1.5 text-sm text-slate-400">{it.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function Icon({ name }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }
  switch (name) {
    case 'tier': return <svg {...common}><path d="M4 20h16M6 16h4M14 12h4M10 8h4"/></svg>
    case 'journey': return <svg {...common}><path d="M4 17h4l3-10 3 7 2-4h4"/><circle cx="4" cy="17" r="1.5"/><circle cx="20" cy="10" r="1.5"/></svg>
    case 'flag': return <svg {...common}><path d="M5 21V4M5 4h12l-2 4 2 4H5"/></svg>
    case 'clock': return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    case 'cite': return <svg {...common}><path d="M7 7h4v4H7zM13 7h4v4h-4z"/><path d="M9 11c0 3-2 5-2 5M15 11c0 3-2 5-2 5"/></svg>
    case 'shield': return <svg {...common}><path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6l8-3z"/></svg>
    case 'wand': return <svg {...common}><path d="M3 21l14-14M17 3l2 2M17 7l2-2M5 11l2 2M3 13l2-2"/></svg>
    default: return null
  }
}
