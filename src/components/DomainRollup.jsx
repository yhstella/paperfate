import { DOMAIN_COLORS, DOMAIN_NAMES } from '../lib/forecastClient.js'

export default function DomainRollup({ rollup, keyWeaknesses }) {
  if (!rollup || rollup.length === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-ink-900/50 p-4 text-sm text-slate-500">
        No domain rollup available (this run used the mock engine).
      </div>
    )
  }

  const scored = rollup.filter(d => d.score !== null)
  const maxScore = Math.max(...scored.map(d => d.score), 100)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
          Quality by domain (14)
        </h3>
        <div className="space-y-2">
          {rollup.map(d => (
            <DomainBar key={d.domain} domain={d} maxScore={maxScore} />
          ))}
        </div>
      </div>

      {keyWeaknesses && keyWeaknesses.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
            Top 5 specific weaknesses
          </h3>
          <ul className="space-y-2">
            {keyWeaknesses.map((w, i) => (
              <li key={w.id} className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
                <div className="text-sm font-medium text-slate-200">
                  <span className="text-slate-500">{i + 1}.</span> {w.name}
                  <span className="ml-2 text-[10px] text-slate-500">{w.id}</span>
                </div>
                {w.rationale && !/Local deterministic scorer/i.test(w.rationale) && (
                  <div className="mt-1 text-xs leading-relaxed text-slate-400">{w.rationale}</div>
                )}
                {w.evidence && (
                  <div className="mt-1 text-[11px] italic text-slate-500">
                    "{w.evidence.slice(0, 140)}{w.evidence.length > 140 ? '…' : ''}"
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function DomainBar({ domain, maxScore }) {
  const { domain: code, score, applicable_count, total_count, unk, na } = domain
  const color = DOMAIN_COLORS[code] || '#94a3b8'
  const label = DOMAIN_NAMES[code] || code
  const pct = score == null ? 0 : Math.max(2, (score / maxScore) * 100)
  const tone = score == null ? 'text-slate-500'
              : score >= 70 ? 'text-emerald-300'
              : score >= 50 ? 'text-amber-300'
              : 'text-rose-300'

  return (
    <div className="grid grid-cols-[100px_1fr_auto] sm:grid-cols-[140px_1fr_auto] items-center gap-3">
      <div className="text-xs text-slate-300 truncate">
        {label}
        <span className="ml-1 text-[10px] text-slate-500 hidden sm:inline">({code})</span>
      </div>
      <div className="relative h-5 overflow-hidden rounded bg-white/[0.04]">
        {score != null && (
          <div
            className="h-full rounded transition-all"
            style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.85 }}
          />
        )}
        {score == null && (
          <div className="flex h-full items-center px-2 text-[10px] uppercase tracking-wider text-slate-500">
            {unk > 0 ? `${unk} indeterminate` : `${na} not applicable`}
          </div>
        )}
      </div>
      <div className={`font-mono text-xs tabular-nums ${tone}`}>
        {score == null ? '—' : `${score}`}
        <span className="ml-1 text-[10px] text-slate-500">({applicable_count}/{total_count})</span>
      </div>
    </div>
  )
}
