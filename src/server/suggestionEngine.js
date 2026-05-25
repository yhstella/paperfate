// PaperFate · Counterfactual suggestion engine
//
// Takes the extraction + baseline FateCore prediction and, for each of the
// top-5 weakest applicable Q500 items, runs a "what if this item were
// strengthened to anchor 4?" prediction. The lift in predicted jcr_jif is
// reported back as an actionable suggestion.
//
// v2 also runs one joint counterfactual: lift the top-3 weakest items to
// anchor 4 simultaneously, reporting both the joint lift and the gap
// between the joint lift and the sum of singletons (super- or sub-additive).
//
// Cost: one LightGBM inference per weakness (≤5) plus one joint inference.
// LightGBM models are module-scope cached, so total overhead is ~5–30 ms.

import { predictFromExtraction } from './fatecoreInference.js'

const TARGET_ANCHOR = 4   // "addressed and adequate" — what counterfactual lifts the item to
const MAX_SUGGESTIONS = 5
const JOINT_TOP_N = 3

function withItemScore(extraction, itemId, newScore) {
  if (!extraction || !Array.isArray(extraction.items)) return extraction
  const items = extraction.items.map(it =>
    it.id === itemId
      ? { ...it, score: newScore, applicability: 'applicable' }
      : it
  )
  return { ...extraction, items }
}

function withItemScores(extraction, idToScore) {
  if (!extraction || !Array.isArray(extraction.items)) return extraction
  const items = extraction.items.map(it =>
    idToScore.has(it.id)
      ? { ...it, score: idToScore.get(it.id), applicability: 'applicable' }
      : it
  )
  return { ...extraction, items }
}

export function generateSuggestions(extraction, manuscript, baselinePred, opts = {}) {
  const baselineJif = baselinePred?.predictions?.jcr_jif?.point
  if (!Number.isFinite(baselineJif)) return []

  const weaknesses = Array.isArray(extraction?.key_weaknesses) ? extraction.key_weaknesses : []
  if (!weaknesses.length) return []

  const singles = []
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
    singles.push({
      id: w.id,
      name: w.name,
      domain: w.domain,
      current_score: w.score,
      target_score: TARGET_ANCHOR,
      predicted_jif_lift: lift,
      rationale: w.rationale || null,
    })
  }
  singles.sort((a, b) => b.predicted_jif_lift - a.predicted_jif_lift)
  return singles
}

export function generateJointCounterfactual(extraction, manuscript, baselinePred, singletonSuggestions, opts = {}) {
  const baselineJif = baselinePred?.predictions?.jcr_jif?.point
  if (!Number.isFinite(baselineJif)) return null
  if (!Array.isArray(singletonSuggestions) || singletonSuggestions.length < 2) return null

  const top = singletonSuggestions.slice(0, JOINT_TOP_N)
  const idMap = new Map(top.map(s => [s.id, TARGET_ANCHOR]))
  const cf = withItemScores(extraction, idMap)

  let liftPred
  try { liftPred = predictFromExtraction(manuscript, cf, opts) }
  catch { return null }
  const newJif = liftPred?.predictions?.jcr_jif?.point
  if (!Number.isFinite(newJif)) return null

  const jointLift = +(newJif - baselineJif).toFixed(2)
  if (jointLift <= 0) return null
  const sumSingletons = +top.reduce((s, x) => s + (x.predicted_jif_lift || 0), 0).toFixed(2)
  const interactionGap = +(jointLift - sumSingletons).toFixed(2)

  return {
    item_ids: top.map(s => s.id),
    item_names: top.map(s => s.name),
    items_count: top.length,
    predicted_jif_lift: jointLift,
    sum_singletons_jif_lift: sumSingletons,
    interaction_gap: interactionGap,        // positive → super-additive; negative → sub-additive
    target_score: TARGET_ANCHOR,
    baseline_jif: +baselineJif.toFixed(2),
    lifted_jif: +newJif.toFixed(2),
  }
}
