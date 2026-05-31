import { useEffect, useRef, useState } from 'react'
import { trackEvent } from '../lib/telemetry.js'
import { t } from '../lib/i18n.js'
import { exportForecastPdf } from '../lib/exportPdf.js'

// Defer below-the-fold sections until after first paint so the hero
// (title + score dial + 6-tile grid) hits the screen with less inline JSX
// work on the critical path. Falls back to immediate render when
// requestAnimationFrame is unavailable (SSR / older runtimes).
function useDeferredRender() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    const schedule = (cb) => {
      if (typeof window === 'undefined') { cb(); return () => {} }
      if (typeof window.requestAnimationFrame === 'function') {
        // double-rAF: ensure the first paint has actually flushed
        const id1 = window.requestAnimationFrame(() => {
          const id2 = window.requestAnimationFrame(() => { if (!cancelled) cb() })
          return () => window.cancelAnimationFrame(id2)
        })
        return () => window.cancelAnimationFrame(id1)
      }
      const tid = setTimeout(cb, 0)
      return () => clearTimeout(tid)
    }
    const cleanup = schedule(() => setReady(true))
    return () => { cancelled = true; if (typeof cleanup === 'function') cleanup() }
  }, [])
  return ready
}

// Tiny shimmer block used while deferred sections wait for the first
// paint to flush. Keeps layout stable so CLS stays at 0.
function SectionSkeleton({ rows = 2, label }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label || 'Loading section'}
      className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/5 dark:bg-ink-900/40"
    >
      <div className="h-3 w-24 animate-pulse rounded bg-slate-200 dark:bg-white/5" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mt-3 h-3 w-full animate-pulse rounded bg-slate-200/70 dark:bg-white/[0.04]" />
      ))}
    </div>
  )
}

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

  const hasJourney = Array.isArray(journey) && journey.length > 0
  const hasSimilar = Array.isArray(similars) && similars.length > 0
  const hasRefs = !!(referencesSummary && referencesSummary.n_resolved > 0)

  // Defer the heavy/long sections (journey list, adjusted-JIF visualizer,
  // author profile, joint counterfactual, target journal card, references
  // summary, suggestions list, similar-papers table) until after first
  // paint. The hero + 6-tile grid renders synchronously so the user sees
  // the headline forecast immediately.
  const heavyReady = useDeferredRender()

  // 'result_render' — fires once per mount / per props identity change.
  useEffect(() => {
    trackEvent('result_render', {
      extractor_used: extractorUsed || null,
      degraded: !!degradedMode,
      has_journey: hasJourney,
      has_similar: hasSimilar,
      has_refs: hasRefs,
    })
  }, [extractorUsed, degradedMode, hasJourney, hasSimilar, hasRefs])

  // 'result_banner_view' — one-shot when degraded banner becomes visible
  // for this mount. Tracked via ref so re-renders don't re-fire.
  const bannerFiredRef = useRef(false)
  useEffect(() => {
    if (degradedMode && !bannerFiredRef.current) {
      bannerFiredRef.current = true
      trackEvent('result_banner_view', { extractor_used: extractorUsed || null })
    }
  }, [degradedMode, extractorUsed])

  // 'result_journey_step_view' — debounced to one event per render even
  // though there are N step <li>s. We fire from a single effect that
  // reports the step count rather than once per row.
  useEffect(() => {
    if (hasJourney) {
      trackEvent('result_journey_step_view', { steps: journey.length })
    }
  }, [hasJourney, journey?.length])

  const onSimilarClick = (paper, idx) => {
    trackEvent('result_similar_click', {
      idx,
      venue: typeof paper?.venue === 'string' ? paper.venue.slice(0, 80) : null,
      year: Number.isFinite(paper?.year) ? paper.year : null,
    })
  }

  // Print / Save-as-PDF entrypoint. Gathers the rendered result into the
  // shape exportForecastPdf expects and opens the print-ready popup.
  // Errors are swallowed inside exportForecastPdf, so we don't try/catch
  // here — the worst case is a no-op when popups are blocked.
  const onExportPdf = () => {
    const point = Number.isFinite(+adjustedJif?.point)
      ? +adjustedJif.point
      : (Number.isFinite(+manuscriptJifPoint) ? +manuscriptJifPoint : null)
    const ciLow = Number.isFinite(+tier?.ci_low) ? +tier.ci_low : null
    const ciHigh = Number.isFinite(+tier?.ci_high) ? +tier.ci_high : null
    const summaryParts = []
    if (tier?.bestFit) summaryParts.push(`Best-fit venue: ${tier.bestFit}.`)
    if (tier?.stretch) summaryParts.push(`Stretch venue: ${tier.stretch}.`)
    if (typeof weakness === 'string' && weakness.trim()) summaryParts.push(weakness.trim())
    exportForecastPdf({
      title: safeTitle,
      manuscript_title: safeTitle,
      summary: summaryParts.join(' '),
      predictions: {
        jcr_jif: point != null ? { point, ci_low: ciLow, ci_high: ciHigh } : null,
        desk_reject_risk: Number.isFinite(+deskReject?.pct)
          ? { point: +deskReject.pct, label: deskReject?.label || null }
          : null,
        score: Number.isFinite(+score) ? +score : null,
      },
      journey: Array.isArray(journey) ? journey : [],
      similar: Array.isArray(similars) ? similars : [],
    })
  }

  return (
    <div className="card p-6 animate-fade-up">
      {degradedMode && (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 rounded-lg border border-amber-500/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-50/10 dark:text-amber-100"
        >
          {t('result.degraded_banner')}
        </div>
      )}

      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-slate-600 dark:text-slate-400" id="forecast-for-label">Forecast for</div>
          <h2
            aria-labelledby="forecast-for-label"
            className="mt-0.5 font-serif text-lg italic font-normal text-slate-800 dark:text-slate-200"
          >
            "{titleDisplay.slice(0, 90)}{titleTrunc ? '…' : ''}"
          </h2>
          {hasInputsStrip && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-600 dark:text-slate-500" aria-label={t('result.run_inputs')}>
              <span>
                Ran against {Number.isFinite(authorsCount) ? authorsCount : 0} authors detected
                {' · '}{Number.isFinite(referencesCount) ? referencesCount : 0} reference DOIs
                {runMode ? ` · mode ${runMode}` : ''}
              </span>
              {authorMismatch && (
                <span className="chip border-amber-500/40 text-amber-800 bg-amber-100/60 dark:border-amber-400/30 dark:text-amber-100 dark:bg-amber-400/[0.06]">
                  0 of {authorsCount} author names matched OpenAlex — names may be malformed
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            onClick={onExportPdf}
            title="Print / Save as PDF"
            aria-label="Print or save forecast as PDF"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 transition hover:border-fate-500/50 hover:text-fate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-500/60 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-300 dark:hover:border-fate-400/40 dark:hover:text-fate-200 dark:focus-visible:ring-fate-400/60"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9V3h12v6" />
              <rect x="6" y="14" width="12" height="7" rx="1" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2" />
            </svg>
          </button>
          <ScoreDial score={score} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Expected journal tier" tone="primary">
          <div
            className="text-2xl font-semibold"
            aria-label={
              adjustedJif && adjustedJif.is_adjusted
                ? `Journal Impact Factor ${adjustedJif.point}${Number.isFinite(tier?.ci_low) && Number.isFinite(tier?.ci_high) ? `, 90 percent confidence interval ${tier.ci_low} to ${tier.ci_high}` : ''}`
                : `Expected journal tier ${tier?.range || 'unavailable'}`
            }
          >
            {adjustedJif && adjustedJif.is_adjusted
              ? `JIF ${adjustedJif.point}${Number.isFinite(tier?.ci_low) && Number.isFinite(tier?.ci_high) ? ` (90% CI ${tier.ci_low}–${tier.ci_high})` : ''}`
              : (tier?.range || '—')}
          </div>
          {adjustedJif && adjustedJif.is_adjusted ? (
            <>
              <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">Best-fit: {tier?.bestFit || '—'}</div>
              <div className="mt-2 flex flex-wrap gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
                {Number.isFinite(adjustedDelta) && (
                  <span
                    aria-label={`${adjustedDelta >= 0 ? 'Adjusted lift' : 'Adjusted drop'} of ${adjustedDelta.toFixed(2)} JIF`}
                    className={`chip ${adjustedDelta >= 0 ? 'border-emerald-500/40 text-emerald-800 bg-emerald-100/60 dark:border-emerald-400/30 dark:text-emerald-200 dark:bg-emerald-400/[0.06]' : 'border-amber-500/40 text-amber-800 bg-amber-100/60 dark:border-amber-400/30 dark:text-amber-100 dark:bg-amber-400/[0.06]'}`}
                  >
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
              <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">Best-fit: {tier?.bestFit || '—'}</div>
              <div className="mt-2 text-xs text-slate-600 dark:text-slate-500">Stretch: {tier?.stretch || '—'}</div>
            </>
          )}
        </Card>

        <Card title="Desk-reject risk">
          <div className="text-2xl font-semibold">{deskReject?.label || '—'}</div>
          <Bar pct={deskReject?.pct ?? 0} />
          <div className="mt-1 text-xs text-slate-600 dark:text-slate-500">{deskReject?.pct ?? 0}% at your target tier</div>
        </Card>

        <Card title="Expected review timeline">
          <div className="text-2xl font-semibold">{timeline?.weeks ?? '—'} <span className="text-base font-normal text-slate-600 dark:text-slate-400">weeks to decision</span></div>
          <div className="mt-1 text-xs text-slate-600 dark:text-slate-500">{timeline?.note}</div>
          {fatecoreMeta?.timelineModel && fatecoreMeta.timelineModel !== 'not_loaded' && (
            <div className="mt-2">
              <span className="chip border-fate-500/40 text-fate-700 bg-fate-100/60 dark:border-fate-400/30 dark:text-fate-200 dark:bg-fate-400/[0.06] text-[10px]">
                {fatecoreMeta.timelineModel === 'fatecore-v0.4-timeline' ? 'model v0.4' : fatecoreMeta.timelineModel}
              </span>
            </div>
          )}
        </Card>

        <Card title="Citation potential (5y)">
          <div className="text-2xl font-semibold">{citation?.range || '—'}</div>
          <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">Percentile in field: top {citation?.percentile ?? '—'}%</div>
          <div className="mt-2 text-xs text-slate-600 dark:text-slate-500">Median of similar papers: {citation?.peerMedian ?? '—'}</div>
        </Card>

        <Card title="Actual Impact Score">
          {Number.isFinite(score) ? (
            <>
              <div className="text-2xl font-semibold">{score}/100</div>
              <Bar pct={score} />
              <div className="mt-1 text-xs text-slate-600 dark:text-slate-500">
                Composite: novelty · methods · clinical relevance · momentum
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-600 dark:text-slate-500">Score unavailable</div>
          )}
        </Card>

        <Card title={t('result.weakness_title')}>
          <div className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{weakness}</div>
        </Card>
      </div>

      {journey && journey.length > 0 && !heavyReady && (
        <SectionSkeleton rows={3} label={t('result.journey_title')} />
      )}
      {journey && journey.length > 0 && heavyReady && (
        <section className="mt-8" aria-labelledby="journey-heading">
          <h3 id="journey-heading" className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
            {t('result.journey_title')}
          </h3>
          <p className="mb-4 text-xs text-slate-600 dark:text-slate-500">
            An ordered sequence to try if a submission is declined. Each step is chosen so the
            manuscript needs minimal reformatting to move on.
          </p>
          <ol className="space-y-3" aria-label={`Submission journey, ${journey.length} steps`}>
            {journey.map((j, i) => (
              <li
                key={i}
                aria-label={`Step ${j.step}: ${j.venue}${Number.isFinite(+j.if) ? `, Journal Impact Factor ${j.if}` : ''}`}
                className="flex gap-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-white/5 dark:bg-ink-900/60"
              >
                <div className="flex-none">
                  <div
                    aria-hidden="true"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-fate-500/20 text-xs font-semibold text-fate-700 dark:text-fate-300"
                  >
                    {j.step}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{j.venue}</span>
                    <span className="chip" aria-label={`Journal Impact Factor ${j.if}`}>IF {j.if}</span>
                    <span className="chip">{j.publisher}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">{j.style}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span
                      title={i === 0 || j.switchCostValue == null ? undefined : `cost ${j.switchCostValue.toFixed(3)} on 0–1 scale (category jaccard + publisher + |Δlog IF| + OA model)`}
                      className={`chip ${
                      j.switchCost === 'minimal' || j.switchCost === 'first submission' ? 'border-emerald-500/40 text-emerald-800 bg-emerald-100/60 dark:border-emerald-400/30 dark:text-emerald-200 dark:bg-emerald-400/[0.06]' :
                      j.switchCost === 'low' ? 'border-fate-500/40 text-fate-700 bg-fate-100/60 dark:border-fate-400/30 dark:text-fate-300 dark:bg-fate-400/[0.06]' :
                      j.switchCost === 'moderate' ? 'border-amber-500/40 text-amber-800 bg-amber-100/60 dark:border-amber-400/30 dark:text-amber-100 dark:bg-amber-400/[0.06]' :
                      'border-rose-500/40 text-rose-800 bg-rose-100/60 dark:border-rose-400/30 dark:text-rose-200 dark:bg-rose-400/[0.06]'
                    }`}>
                      {i === 0 ? 'start' : `switch cost · ${j.switchCost}${Number.isFinite(j.switchCostValue) ? ` (${j.switchCostValue.toFixed(2)})` : ''}`}
                    </span>
                    {j.switchReason && <span className="text-slate-600 dark:text-slate-400">{j.switchReason}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {adjustedJif && adjustedJif.is_adjusted && !heavyReady && (
        <SectionSkeleton rows={2} label="Adjusted JIF estimate" />
      )}
      {adjustedJif && adjustedJif.is_adjusted && heavyReady && (
        <section className="mt-4 rounded-xl border border-fate-500/40 bg-fate-100/40 p-4 dark:border-fate-500/30 dark:bg-fate-500/[0.06]">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">Adjusted JIF estimate</h3>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{adjustedJif.point}</span>
            <span className="chip">manuscript-only model {adjustedJif.baseline}</span>
            {(adjustedJif.components || []).filter(c => c.label !== 'model').map(c => (
              <span key={c.label} className="chip">{c.label} contribution {c.jif}</span>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-500">
            Model alone (R²(log JIF)≈0.43) compresses to mid-tier; this blends in bibliography, target-journal prior IF, and senior-author h-index.
          </div>
        </section>
      )}

      {authorFeatures && authorFeatures.team_size_with_id > 0 && !heavyReady && (
        <SectionSkeleton rows={2} label="Author profile" />
      )}
      {authorFeatures && authorFeatures.team_size_with_id > 0 && heavyReady && (
        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-white/5 dark:bg-ink-900/60">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">Author profile</h3>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="text-sm text-slate-800 dark:text-slate-200">{authorFeatures.team_size_with_id} of {(authorFeatures.resolved || []).length} authors resolved</span>
            {Number.isFinite(authorFeatures.first_author_h_index) && <span className="chip">first-author h {authorFeatures.first_author_h_index}</span>}
            {Number.isFinite(authorFeatures.last_author_h_index) && <span className="chip">senior-author h {authorFeatures.last_author_h_index}</span>}
            {Number.isFinite(authorFeatures.max_team_h_index) && <span className="chip">max team h {authorFeatures.max_team_h_index}</span>}
            {Number.isFinite(authorFeatures.median_team_h_index) && <span className="chip">median h {authorFeatures.median_team_h_index}</span>}
          </div>
          {(authorFeatures.resolved || []).length > 0 && (
            <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
              {(authorFeatures.resolved || []).slice(0, 8).map((a, i) => (
                <span key={i}>
                  {i > 0 && ' · '}
                  {a.matched || a.name}{Number.isFinite(a.h_index) ? ` (h=${a.h_index})` : ' (?)'}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-500">
            Names matched via OpenAlex top-result — verify if the field has common names.
          </div>
        </section>
      )}

      {!hideCounterfactuals && jointCounterfactual && jointCounterfactual.items_count >= 2 && !heavyReady && (
        <SectionSkeleton rows={2} label="Joint counterfactual" />
      )}
      {!hideCounterfactuals && jointCounterfactual && jointCounterfactual.items_count >= 2 && heavyReady && (
        <section className="mt-4 rounded-xl border border-fate-500/40 bg-fate-100/40 p-4 dark:border-fate-500/30 dark:bg-fate-500/[0.06]">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">If you fix all top {jointCounterfactual.items_count}</h3>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              +{jointCounterfactual.predicted_jif_lift?.toFixed?.(2)} <span className="text-base font-normal text-slate-600 dark:text-slate-400">JIF together</span>
            </span>
            <span className="chip">baseline {jointCounterfactual.baseline_jif?.toFixed?.(2)}</span>
            <span className="chip">lifted {jointCounterfactual.lifted_jif?.toFixed?.(2)}</span>
            <span className={`chip ${Math.abs(jointCounterfactual.interaction_gap) < 0.05 ? '' : jointCounterfactual.interaction_gap > 0 ? 'border-emerald-500/40 text-emerald-800 bg-emerald-100/60 dark:border-emerald-400/30 dark:text-emerald-200 dark:bg-emerald-400/[0.06]' : 'border-amber-500/40 text-amber-800 bg-amber-100/60 dark:border-amber-400/30 dark:text-amber-100 dark:bg-amber-400/[0.06]'}`}>
              {jointCounterfactual.interaction_gap > 0 ? '+' : ''}{jointCounterfactual.interaction_gap?.toFixed?.(2)} vs sum
            </span>
          </div>
          <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            {(jointCounterfactual.item_names || []).join(' · ')}
          </div>
          <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-500">
            Joint fix of the top {jointCounterfactual.items_count} weaknesses; 'vs sum' positive ⇒ super-additive interaction.
          </div>
        </section>
      )}

      {targetJournal && !heavyReady && (
        <SectionSkeleton rows={2} label={t('result.target_journal_title')} />
      )}
      {targetJournal && heavyReady && (
        <section className="mt-6 rounded-xl border border-fate-500/40 bg-fate-100/40 p-4 dark:border-fate-500/30 dark:bg-fate-500/[0.06]">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">{t('result.target_journal_title')}</h3>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="font-semibold text-slate-900 dark:text-slate-100">{targetJournal.name}</span>
            {targetJournal.issn && <span className="chip">ISSN {targetJournal.issn}</span>}
            {Number.isFinite(+targetJournal.jif) && <span className="chip">prior-year IF {(+targetJournal.jif).toFixed(2)}</span>}
            {Number.isFinite(+targetJournal.jif_5yr) && <span className="chip">5-yr IF {(+targetJournal.jif_5yr).toFixed(2)}</span>}
            {targetJournal.tier && <span className="chip">{targetJournal.tier} tier</span>}
            {targetJournal.quartile && <span className="chip">{targetJournal.quartile}</span>}
            {targetJournal.is_oa && <span className="chip">open access</span>}
          </div>
          <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            {targetJournal.publisher || '—'}{targetJournal.country ? ` · ${targetJournal.country}` : ''}
            {targetJournal.category ? ` · ${targetJournal.category}` : ''}
          </div>
          <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-500">
            Anchor only — manuscript-level forecast above is independent of this IF.
          </div>
        </section>
      )}

      {referencesSummary && referencesSummary.n_resolved > 0 && !heavyReady && (
        <SectionSkeleton rows={3} label={t('result.bibliography_title')} />
      )}
      {referencesSummary && referencesSummary.n_resolved > 0 && heavyReady && (
        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-white/5 dark:bg-ink-900/60">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">{t('result.bibliography_title')}</h3>
          <div className="flex flex-wrap items-baseline gap-2 sm:gap-3 text-[10px] sm:text-[11px]">
            <span className="text-sm text-slate-800 dark:text-slate-200">
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
            <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
              <span className="font-medium text-slate-700 dark:text-slate-300">Top venues: </span>
              {referencesSummary.top_journals.slice(0, 5).map((j, i) => (
                <span key={j.name}>
                  {i > 0 && ' · '}
                  {j.name} ({j.count}{Number.isFinite(j.jif) ? `, IF ${j.jif}` : ''})
                </span>
              ))}
            </div>
          )}
          {referencesSummary.top_categories?.length > 0 && (
            <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              <span className="font-medium text-slate-700 dark:text-slate-300">Top categories: </span>
              {referencesSummary.top_categories.slice(0, 3).map((c, i) => (
                <span key={c.category}>{i > 0 && ' · '}{c.category} ({c.count})</span>
              ))}
            </div>
          )}
          {Number.isFinite(manuscriptJifPoint) && Number.isFinite(referencesSummary.median_jif) && referencesSummary.median_jif > 0 && (
            (() => {
              const ratio = manuscriptJifPoint / referencesSummary.median_jif
              let verdict, tone
              if (ratio >= 0.5 && ratio <= 2.0) { verdict = 'matched'; tone = 'border-emerald-500/40 text-emerald-800 bg-emerald-100/60 dark:border-emerald-400/30 dark:text-emerald-200 dark:bg-emerald-400/[0.06]' }
              else if (ratio < 0.5) { verdict = 'bibliography tier higher — stretch targets worth trying'; tone = 'border-fate-500/40 text-fate-700 bg-fate-100/60 dark:border-fate-400/30 dark:text-fate-200 dark:bg-fate-400/[0.06]' }
              else { verdict = 'bibliography tier lower — broader-impact framing may help'; tone = 'border-amber-500/40 text-amber-800 bg-amber-100/60 dark:border-amber-400/30 dark:text-amber-100 dark:bg-amber-400/[0.06]' }
              return (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className={`chip ${tone}`}>manuscript JIF {manuscriptJifPoint.toFixed(2)} vs refs median {referencesSummary.median_jif} → {verdict}</span>
                </div>
              )
            })()
          )}
          <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-500">
            Descriptive sanity-check vs. the literature you cite.
          </div>
        </section>
      )}

      {!heavyReady && (
        <SectionSkeleton rows={4} label={`${t('result.suggestions_title')} / ${t('result.similar_papers_title')}`} />
      )}
      {heavyReady && (
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
        {suggestions && suggestions.length > 0 && (
          <section className="lg:col-span-3">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('result.suggestions_title')}</h3>
            <ol className="space-y-2 text-sm text-slate-700 dark:text-slate-300">
              {suggestions.map((s, i) => (
                <li key={i} className="flex gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-white/5 dark:bg-ink-900/60">
                  <span aria-hidden="true" className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-fate-500/20 text-xs font-semibold text-fate-700 dark:text-fate-300">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className={(suggestions && suggestions.length > 0) ? 'lg:col-span-2' : 'lg:col-span-5'}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('result.similar_papers_title')}</h3>
          <ul className="space-y-2">
            {similars.map((p, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onSimilarClick(p, i)}
                  aria-label={`Similar paper: ${p.title}, published in ${p.venue} (${p.year}), Journal Impact Factor ${p.if}, ${p.citations} citations`}
                  className="block w-full text-left rounded-lg border border-slate-200 bg-white p-3 transition hover:border-fate-500/40 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-500/60 dark:border-white/5 dark:bg-ink-900/60 dark:hover:border-fate-400/30 dark:hover:bg-ink-900/80 dark:focus-visible:ring-fate-400/60"
                >
                  <div className="line-clamp-2 text-sm text-slate-800 dark:text-slate-200">{p.title}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-700 dark:text-slate-300">
                    <span className="chip">{p.venue}</span>
                    <span className="chip" aria-label={`Journal Impact Factor ${p.if}`}>IF {p.if}</span>
                    <span className="chip" aria-label={`Year ${p.year}`}>{p.year}</span>
                    <span className="chip" aria-label={`${p.citations} citations`}>{p.citations}× cited</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-500">
        <span>ⓘ Probabilistic forecast — actual outcomes depend on reviewers, editors, and timing.</span>
      </div>
      {(Number.isFinite(confidence) || fatecoreMeta?.version || fatecoreMeta?.timelineModel) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-600 dark:text-slate-500">
          {Number.isFinite(confidence) && (
            <span
              className="chip"
              title={
                confidence < 0.5
                  ? t('result.confidence_low')
                  : confidence < 0.8
                    ? t('result.confidence_med')
                    : t('result.confidence_high')
              }
            >
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
  const accent = tone === 'primary'
    ? 'border-fate-500/40 bg-fate-100/40 dark:border-fate-500/30 dark:bg-fate-500/[0.06]'
    : 'border-slate-200 bg-white dark:border-white/5 dark:bg-ink-900/60'
  return (
    <section className={`rounded-xl border p-4 ${accent}`}>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">{title}</h3>
      {children}
    </section>
  )
}

function Bar({ pct }) {
  const safe = Number.isFinite(pct) ? pct : 0
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/5">
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
          <span className="text-lg font-semibold text-slate-600 dark:text-slate-500">—</span>
          <span className="text-[9px] uppercase tracking-wider text-slate-600 dark:text-slate-400">score</span>
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
        <span className="text-[9px] uppercase tracking-wider text-slate-600 dark:text-slate-400">score</span>
      </div>
    </div>
  )
}
