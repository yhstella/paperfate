// PaperFate · Counterfactual suggestion engine
//
// Takes the extraction + baseline FateCore prediction and, for each of the
// top-5 weakest applicable Q500 items, runs a "what if this item were
// strengthened to anchor 4?" prediction. The lift in predicted jcr_jif is
// reported back as an actionable suggestion.
//
// Cost: one extra LightGBM inference per weakness (≤5). LightGBM models are
// module-scope cached inside fatecoreInference.js, so this only adds
// ~5–25 ms on top of the baseline forecast.

import { predictFromExtraction } from './fatecoreInference.js'

const TARGET_ANCHOR = 4   // "addressed and adequate" — what counterfactual lifts the item to
const MAX_SUGGESTIONS = 5

function withItemScore(extraction, itemId, newScore) {
  if (!extraction || !Array.isArray(extraction.items)) return extraction
  const items = extraction.items.map(it =>
    it.id === itemId
      ? { ...it, score: newScore, applicability: 'applicable' }
      : it
  )
  return { ...extraction, items }
}

export function generateSuggestions(extraction, manuscript, baselinePred, opts = {}) {
  const baselineJif = baselinePred?.predictions?.jcr_jif?.point
  if (!Number.isFinite(baselineJif)) return []

  const weaknesses = Array.isArray(extraction?.key_weaknesses) ? extraction.key_weaknesses : []
  if (!weaknesses.length) return []

  const out = []
  for (const w of weaknesses.slice(0, MAX_SUGGESTIONS)) {
    if (!w?.id || !Number.isFinite(w?.score) || w.score >= TARGET_ANCHOR) continue
    const cf = withItemScore(extraction, w.id, TARGET_ANCHOR)
    let liftPred
    try { liftPred = predictFromExtraction(manuscript, cf, opts) }
    catch { continue }
    const newJif = liftPred?.predictions?.jcr_jif?.point
    if (!Number.isFinite(newJif)) continue
    const lift = +(newJif - baselineJif).toFixed(2)
    if (lift <= 0) continue
    out.push({
      id: w.id,
      name: w.name,
      domain: w.domain,
      current_score: w.score,
      target_score: TARGET_ANCHOR,
      predicted_jif_lift: lift,
      rationale: w.rationale || null,
    })
  }

  return out.sort((a, b) => b.predicted_jif_lift - a.predicted_jif_lift)
}
