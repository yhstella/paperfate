import { DOMAIN_COLORS, DOMAIN_NAMES } from '../lib/forecastClient.js'

export default function DomainRollup({ rollup, keyWeaknesses }) {
  if (!rollup || rollup.length === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-ink-900/50 p-4 text-sm text-slate-400">
        No domain rollup available (this run used the mock engine).
      </div>
    )
  }

  const scored = rollup.filter(d => d.score !== null)
  const maxScore = Math.max(...scored.map(d => d.score), 100)

  return (
    <div className="space-y-4">
      <section aria-labelledby="domain-rollup-heading">
        <h3 id="domain-rollup-heading" className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
          Quality by domain (14)
        </h3>
        <ul className="space-y-2" aria-label="Domain quality scores">
          {rollup.map(d => (
            <DomainBar key={d.domain} domain={d} maxScore={maxScore} />
          ))}
        </ul>
      </section>

      {keyWeaknesses && keyWeaknesses.length > 0 && (
        <section aria-labelledby="domain-weaknesses-heading">
          <h3 id="domain-weaknesses-heading" className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
            Top 5 specific weaknesses
          </h3>
          <ol className="space-y-2">
            {keyWeaknesses.map((w, i) => (
              <li key={w.id} className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
                <div className="text-sm font-medium text-slate-200">
                  <span aria-hidden="true" className="text-slate-400">{i + 1}.</span>
                  <span className="sr-only">Weakness {i + 1}: </span>
                  {w.name}
                  <span className="ml-2 text-[10px] text-slate-400" aria-label={`identifier ${w.id}`}>{w.id}</span>
                </div>
                {w.rationale && !/Local deterministic scorer/i.test(w.rationale) && (
                  <div className="mt-1 text-xs leading-relaxed text-slate-300">{w.rationale}</div>
                )}
                {w.evidence && (
                  <div className="mt-1 text-[11px] italic text-slate-400">
                    "{w.evidence.slice(0, 140)}{w.evidence.length > 140 ? '…' : ''}"
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

function DomainBar({ domain, maxScore }) {
  const { domain: code, score, applicable_count, total_count, unk, na } = domain
  const color = DOMAIN_COLORS[code] || '#94a3b8'
  const label = DOMAIN_NAMES[code] || code
  const pct = score == null ? 0 : Math.max(2, (score / maxScore) * 100)
  // Bumped tones from -300 to -200 for WCAG AA on dark backgrounds.
  const tone = score == null ? 'text-slate-400'
              : score >= 70 ? 'text-emerald-200'
              : score >= 50 ? 'text-amber-200'
              : 'text-rose-200'

  // Spec says: "Domain score X out of 5". Internally scores are on a 0-100
  // scale; we expose both, mapping to a 5-point quality scale for the
  // canonical aria-label and keeping the raw % in description.
  const fiveScale = score == null ? null : Math.round((score / 100) * 5 * 10) / 10
  const ariaLabel = score == null
    ? `${label}: not scored (${unk > 0 ? `${unk} indeterminate` : `${na} not applicable`})`
    : `${label}: Domain score ${fiveScale} out of 5 (${score} of 100, ${applicable_count} of ${total_count} items scored)`

  return (
    <li className="grid grid-cols-[100px_1fr_auto] sm:grid-cols-[140px_1fr_auto] items-center gap-3">
      <div className="text-xs text-slate-200 truncate">
        {label}
        <span className="ml-1 text-[10px] text-slate-400 hidden sm:inline">({code})</span>
      </div>
      <div
        role="img"
        aria-label={ariaLabel}
        className="relative h-5 overflow-hidden rounded bg-white/[0.04]"
      >
        {score != null && (
          <div
            aria-hidden="true"
            className="h-full rounded transition-all"
            style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.85 }}
          />
        )}
        {score == null && (
          <div aria-hidden="true" className="flex h-full items-center px-2 text-[10px] uppercase tracking-wider text-slate-400">
            {unk > 0 ? `${unk} indeterminate` : `${na} not applicable`}
          </div>
        )}
      </div>
      <div className={`font-mono text-xs tabular-nums ${tone}`} aria-hidden="true">
        {score == null ? '—' : `${score}`}
        <span className="ml-1 text-[10px] text-slate-400">({applicable_count}/{total_count})</span>
      </div>
    </li>
  )
}
