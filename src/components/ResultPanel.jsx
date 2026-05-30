export default function ResultPanel({ result, input }) {
  const { tier, deskReject, timeline, citation, score, weakness, suggestions, similars, journey, targetJournal, referencesSummary, confidence, fatecoreMeta, jointCounterfactual, manuscriptJifPoint, authorFeatures, adjustedJif } = result

  const safeTitle = input?.title || ''
  const titleDisplay = safeTitle || 'Untitled manuscript'
  const titleTrunc = safeTitle.length > 90

  const llmHealth = input?.llmHealth
  const extractionFallbackReason = input?.extractionFallbackReason
  const extractorUsed = input?.extractorUsed
  const degradedMode = input?.degradedMode || llmHealth?.status === 'degraded'
  const authorsCount = input?.authorsCount
  const referencesCount = input?.referencesCount
  const runMode = input?.mode
  const inputJifPoint = input?.manuscriptJifPoint

  const hideCounterfactuals = extractorUsed === 'deterministic' || extractorUsed === 'rule_fallback' || !!extractionFallbackReason

  const hasInputsStrip = Number.isFinite(authorsCount) || Number.isFinite(referencesCount) || runMode
  const authorMismatch = authorFeatures?.team_size_with_id === 0 && Number.isFinite(authorsCount) && authorsCount > 0

  const adjustedDelta = adjustedJif && adjustedJif.is_adjusted && Number.isFinite(adjustedJif.point) && Number.isFinite(inputJifPoint)
    ? (adjustedJif.point - inputJifPoint)
    : null

  return (
    <div className="card p-6 animate-fade-up">
      {degradedMode && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-50/10 px-4 py-3 text-sm text-amber-200">
          LLM scoring unavailable right now — showing rule-only forecast. Q-rubric domain breakdowns are degraded; please retry shortly.
        </div>
      )}

      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-slate-400">Forecast for</div>
          <div className="mt-0.5 font-serif text-lg italic text-slate-200">
            "{titleDisplay.slice(0, 90)}{titleTrunc ? '…' : ''}"
          </div>
          {hasInputsStrip && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span>
                Ran against {Number.isFinite(authorsCount) ? authorsCount : 0} authors detected
                {' · '}{Number.isFinite(referencesCount) ? referencesCount : 0} reference DOIs
                {runMode ? ` · mode ${runMode}` : ''}
              </span>
              {authorMismatch && (
                <span className="chip border-amber-400/30 text-amber-200/90 bg-amber-400/[0.06]">
                  0 of {authorsCount} author names matched OpenAlex — names may be malformed
                </span>
              )}
            </div>
          )}
        </div>
        <ScoreDial score={score} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Expected journal tier" tone="primary">
          <div className="text-2xl font-semibold">
            {adjustedJif && adjustedJif.is_adjusted
              ? `JIF ${adjustedJif.point}${Number.isFinite(tier?.ci_low) && Number.isFinite(tier?.ci_high) ? ` (90% CI ${tier.ci_low}–${tier.ci_high})` : ''}`
              : (tier?.range || '—')}
          </div>
          {adjustedJif && adjustedJif.is_adjusted ? (
            <>
              <div className="mt-1 text-xs text-slate-400">Best-fit: {tier?.bestFit || '—'}</div>
              <div className="mt-2 flex flex-wrap gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
                {Number.isFinite(adjustedDelta) && (
                  <span className={`chip ${adjustedDelta >= 0 ? 'border-emerald-400/30 text-emerald-300/90 bg-emerald-400/[0.06]' : 'border-amber-400/30 text-amber-200/90 bg-amber-400/[0.06]'}`}>
                    {adjustedDelta >= 0 ? '↑' : '↓'} {inputJifPoint?.toFixed?.(2)} → {adjustedJif.point} ({adjustedDelta >= 0 ? '+' : ''}{adjustedDelta.toFixed(2)})
                  </span>
                )}
                <span className="chip">model only {adjustedJif.baseline}</span>
                {(adjustedJif.components || []).filter(c => c.label !== 'model').map(c => (
                  <span key={c.label} className="chip">{c.label} {c.jif}</span>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="mt-1 text-xs text-slate-400">Best-fit: {tier?.bestFit || '—'}</div>
              <div className="mt-2 text-xs text-slate-500">Stretch: {tier?.stretch || '—'}</div>
            </>
          )}
        </Card>

        <Card title="Desk-reject risk">
          <div className="text-2xl font-semibold">{deskReject?.label || '—'}</div>
          <Bar pct={deskReject?.pct ?? 0} />
          <div className="mt-1 text-xs text-slate-500">{deskReject?.pct ?? 0}% at your target tier</div>
        </Card>

        <Card title="Expected review timeline">
          <div className="text-2xl font-semibold">{timeline?.weeks ?? '—'} <span className="text-base font-normal text-slate-400">weeks to decision</span></div>
          <div className="mt-1 text-xs text-slate-500">{timeline?.note}</div>
          {fatecoreMeta?.timelineModel && fatecoreMeta.timelineModel !== 'not_loaded' && (
            <div className="mt-2">
              <span className="chip border-fate-400/30 text-fate-300/90 bg-fate-400/[0.06] text-[10px]">
                {fatecoreMeta.timelineModel === 'fatecore-v0.4-timeline' ? 'model v0.4' : fatecoreMeta.timelineModel}
              </span>
            </div>
          )}
        </Card>

        <Card title="Citation potential (5y)">
          <div className="text-2xl font-semibold">{citation?.range || '—'}</div>
          <div className="mt-1 text-xs text-slate-400">Percentile in field: top {citation?.percentile ?? '—'}%</div>
          <div className="mt-2 text-xs text-slate-500">Median of similar papers: {citation?.peerMedian ?? '—'}</div>
        </Card>

        <Card title="Actual Impact Score">
          {Number.isFinite(score) ? (
            <>
              <div className="text-2xl font-semibold">{score}/100</div>
              <Bar pct={score} />
              <div className="mt-1 text-xs text-slate-500">
                Composite: novelty · methods · clinical relevance · momentum
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-500">Score unavailable</div>
          )}
        </Card>

        <Card title="Main weakness">
          <div className="text-sm leading-relaxed text-slate-300">{weakness}</div>
        </Card>
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
                    <span
                      title={i === 0 || j.switchCostValue == null ? undefined : `cost ${j.switchCostValue.toFixed(3)} on 0–1 scale (category jaccard + publisher + |Δlog IF| + OA model)`}
                      className={`chip ${
                      j.switchCost === 'minimal' || j.switchCost === 'first submission' ? 'border-emerald-400/30 text-emerald-300/90 bg-emerald-400/[0.06]' :
                      j.switchCost === 'low' ? 'border-fate-400/30 text-fate-300 bg-fate-400/[0.06]' :
                      j.switchCost === 'moderate' ? 'border-amber-400/30 text-amber-200/90 bg-amber-400/[0.06]' :
                      'border-rose-400/30 text-rose-300/90 bg-rose-400/[0.06]'
                    }`}>
                      {i === 0 ? 'start' : `switch cost · ${j.switchCost}${Number.isFinite(j.switchCostValue) ? ` (${j.switchCostValue.toFixed(2)})` : ''}`}
                    </span>
                    {j.switchReason && <span className="text-slate-400">{j.switchReason}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {adjustedJif && adjustedJif.is_adjusted && (
        <div className="mt-4 rounded-xl border border-fate-500/30 bg-fate-500/[0.06] p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Adjusted JIF estimate</div>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="text-2xl font-semibold text-slate-100">{adjustedJif.point}</span>
            <span className="chip">manuscript-only model {adjustedJif.baseline}</span>
            {(adjustedJif.components || []).filter(c => c.label !== 'model').map(c => (
              <span key={c.label} className="chip">{c.label} contribution {c.jif}</span>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            Model alone (R²(log JIF)≈0.43) compresses to mid-tier; this blends in bibliography, target-journal prior IF, and senior-author h-index.
          </div>
        </div>
      )}

      {authorFeatures && authorFeatures.team_size_with_id > 0 && (
        <div className="mt-4 rounded-xl border border-white/5 bg-ink-900/60 p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Author profile</div>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="text-sm text-slate-200">{authorFeatures.team_size_with_id} of {(authorFeatures.resolved || []).length} authors resolved</span>
            {Number.isFinite(authorFeatures.first_author_h_index) && <span className="chip">first-author h {authorFeatures.first_author_h_index}</span>}
            {Number.isFinite(authorFeatures.last_author_h_index) && <span className="chip">senior-author h {authorFeatures.last_author_h_index}</span>}
            {Number.isFinite(authorFeatures.max_team_h_index) && <span className="chip">max team h {authorFeatures.max_team_h_index}</span>}
            {Number.isFinite(authorFeatures.median_team_h_index) && <span className="chip">median h {authorFeatures.median_team_h_index}</span>}
          </div>
          {(authorFeatures.resolved || []).length > 0 && (
            <div className="mt-2 text-xs text-slate-400">
              {(authorFeatures.resolved || []).slice(0, 8).map((a, i) => (
                <span key={i}>
                  {i > 0 && ' · '}
                  {a.matched || a.name}{Number.isFinite(a.h_index) ? ` (h=${a.h_index})` : ' (?)'}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 text-[11px] text-slate-500">
            Names matched via OpenAlex top-result — verify if the field has common names.
          </div>
        </div>
      )}

      {!hideCounterfactuals && jointCounterfactual && jointCounterfactual.items_count >= 2 && (
        <div className="mt-4 rounded-xl border border-fate-500/30 bg-fate-500/[0.06] p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">If you fix all top {jointCounterfactual.items_count}</div>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="text-2xl font-semibold text-slate-100">
              +{jointCounterfactual.predicted_jif_lift?.toFixed?.(2)} <span className="text-base font-normal text-slate-400">JIF together</span>
            </span>
            <span className="chip">baseline {jointCounterfactual.baseline_jif?.toFixed?.(2)}</span>
            <span className="chip">lifted {jointCounterfactual.lifted_jif?.toFixed?.(2)}</span>
            <span className={`chip ${Math.abs(jointCounterfactual.interaction_gap) < 0.05 ? '' : jointCounterfactual.interaction_gap > 0 ? 'border-emerald-400/30 text-emerald-300/90 bg-emerald-400/[0.06]' : 'border-amber-400/30 text-amber-200/90 bg-amber-400/[0.06]'}`}>
              {jointCounterfactual.interaction_gap > 0 ? '+' : ''}{jointCounterfactual.interaction_gap?.toFixed?.(2)} vs sum
            </span>
          </div>
          <div className="mt-2 text-xs text-slate-400">
            {(jointCounterfactual.item_names || []).join(' · ')}
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            Joint fix of the top {jointCounterfactual.items_count} weaknesses; 'vs sum' positive ⇒ super-additive interaction.
          </div>
        </div>
      )}

      {targetJournal && (
        <div className="mt-6 rounded-xl border border-fate-500/30 bg-fate-500/[0.06] p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">If you submit to your target</div>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="font-semibold text-slate-100">{targetJournal.name}</span>
            {targetJournal.issn && <span className="chip">ISSN {targetJournal.issn}</span>}
            {Number.isFinite(+targetJournal.jif) && <span className="chip">prior-year IF {(+targetJournal.jif).toFixed(2)}</span>}
            {Number.isFinite(+targetJournal.jif_5yr) && <span className="chip">5-yr IF {(+targetJournal.jif_5yr).toFixed(2)}</span>}
            {targetJournal.tier && <span className="chip">{targetJournal.tier} tier</span>}
            {targetJournal.quartile && <span className="chip">{targetJournal.quartile}</span>}
            {targetJournal.is_oa && <span className="chip">open access</span>}
          </div>
          <div className="mt-2 text-xs text-slate-400">
            {targetJournal.publisher || '—'}{targetJournal.country ? ` · ${targetJournal.country}` : ''}
            {targetJournal.category ? ` · ${targetJournal.category}` : ''}
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            Anchor only — manuscript-level forecast above is independent of this IF.
          </div>
        </div>
      )}

      {referencesSummary && referencesSummary.n_resolved > 0 && (
        <div className="mt-4 rounded-xl border border-white/5 bg-ink-900/60 p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Your bibliography</div>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="text-sm text-slate-200">
              {referencesSummary.n_resolved}/{referencesSummary.n_input} references resolved
              {Number.isFinite(referencesSummary.n_with_jif) ? ` · ${referencesSummary.n_with_jif} with IF` : ''}
            </span>
            {Number.isFinite(referencesSummary.median_jif) && <span className="chip">median IF {referencesSummary.median_jif}</span>}
            {Number.isFinite(referencesSummary.mean_jif) && <span className="chip">mean IF {referencesSummary.mean_jif}</span>}
            {referencesSummary.year_median && (
              <span className="chip">years {referencesSummary.year_min}–{referencesSummary.year_max} · median {referencesSummary.year_median}</span>
            )}
          </div>
          {referencesSummary.top_journals?.length > 0 && (
            <div className="mt-2 text-xs text-slate-400">
              <span className="font-medium text-slate-300">Top venues: </span>
              {referencesSummary.top_journals.slice(0, 5).map((j, i) => (
                <span key={j.name}>
                  {i > 0 && ' · '}
                  {j.name} ({j.count}{Number.isFinite(j.jif) ? `, IF ${j.jif}` : ''})
                </span>
              ))}
            </div>
          )}
          {referencesSummary.top_categories?.length > 0 && (
            <div className="mt-1 text-xs text-slate-400">
              <span className="font-medium text-slate-300">Top categories: </span>
              {referencesSummary.top_categories.slice(0, 3).map((c, i) => (
                <span key={c.category}>{i > 0 && ' · '}{c.category} ({c.count})</span>
              ))}
            </div>
          )}
          {Number.isFinite(manuscriptJifPoint) && Number.isFinite(referencesSummary.median_jif) && referencesSummary.median_jif > 0 && (
            (() => {
              const ratio = manuscriptJifPoint / referencesSummary.median_jif
              let verdict, tone
              if (ratio >= 0.5 && ratio <= 2.0) { verdict = 'matched'; tone = 'border-emerald-400/30 text-emerald-300/90 bg-emerald-400/[0.06]' }
              else if (ratio < 0.5) { verdict = 'bibliography tier higher — stretch targets worth trying'; tone = 'border-fate-400/30 text-fate-300 bg-fate-400/[0.06]' }
              else { verdict = 'bibliography tier lower — broader-impact framing may help'; tone = 'border-amber-400/30 text-amber-200/90 bg-amber-400/[0.06]' }
              return (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className={`chip ${tone}`}>manuscript JIF {manuscriptJifPoint.toFixed(2)} vs refs median {referencesSummary.median_jif} → {verdict}</span>
                </div>
              )
            })()
          )}
          <div className="mt-2 text-[11px] text-slate-500">
            Descriptive sanity-check vs. the literature you cite.
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        {suggestions && suggestions.length > 0 && (
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
        )}
        <div className={(suggestions && suggestions.length > 0) ? 'lg:col-span-2' : 'lg:col-span-5'}>
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

      <div className="mt-6 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <span>ⓘ Probabilistic forecast — actual outcomes depend on reviewers, editors, and timing.</span>
      </div>
      {(Number.isFinite(confidence) || fatecoreMeta?.version || fatecoreMeta?.timelineModel) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {Number.isFinite(confidence) && (
            <span className="chip" title="Overall extraction + model confidence">
              confidence {(confidence * 100).toFixed(0)}%
            </span>
          )}
          {fatecoreMeta?.version && <span className="chip">{fatecoreMeta.version}</span>}
          {fatecoreMeta?.timelineModel && fatecoreMeta.timelineModel !== 'not_loaded' && (
            <span className="chip">{fatecoreMeta.timelineModel}</span>
          )}
        </div>
      )}
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
  const safe = Number.isFinite(pct) ? pct : 0
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <div
        className="h-full rounded-full bg-gradient-to-r from-fate-500 to-fate-300"
        style={{ width: `${Math.max(2, Math.min(100, safe))}%` }}
      />
    </div>
  )
}

function ScoreDial({ score }) {
  const r = 28, c = 2 * Math.PI * r
  if (!Number.isFinite(score)) {
    return (
      <div className="relative h-20 w-20 flex-none">
        <svg viewBox="0 0 70 70" className="h-full w-full -rotate-90">
          <circle cx="35" cy="35" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="6" fill="none" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold text-slate-500">—</span>
          <span className="text-[9px] uppercase tracking-wider text-slate-400">score</span>
        </div>
      </div>
    )
  }
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
