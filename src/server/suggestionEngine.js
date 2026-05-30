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
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// Inline-load Q500.json at module init so we know each item's rubric ceiling
// (we DO NOT import from extract.js to avoid the Codex Round 7 lock).
let Q500 = { items: [] }
try {
  Q500 = JSON.parse(readFileSync(join(HERE, '..', '..', 'docs', 'rubric', 'Q500.json'), 'utf-8'))
} catch {
  Q500 = { items: [] }
}
const MAX_SCORE_BY_ID = Object.fromEntries(
  (Q500.items || []).map(it => [
    it.id,
    it.rubric?.length === 6 ? 5 : it.rubric?.length === 4 ? 5 : (it.rubric?.length ?? 5) - 1,
  ])
)
const Q500_BY_ID = Object.fromEntries((Q500.items || []).map(it => [it.id, it]))

const TARGET_ANCHOR = 4   // "addressed and adequate" — what counterfactual lifts the item to
const MAX_SUGGESTIONS = 5
const JOINT_TOP_N = 3

// Article-type guardrail: returns true if this item is incompatible with this
// manuscript's article type and should therefore be skipped as a suggestion.
function shouldSkipForArticleType(itemMeta, manuscript) {
  if (!itemMeta) return false
  const types = itemMeta.types
  const articleType = String(manuscript?.article_type || '').trim()
  // (a) item.types is an array, manuscript.article_type is non-empty non-'*', not in item.types
  if (Array.isArray(types) && articleType && articleType !== '*' && !types.includes(articleType)) {
    return true
  }
  // (b) item.types is exactly ['RCT'] — require abstract to look like an RCT, conservative skip if missing
  if (Array.isArray(types) && types.length === 1 && types[0] === 'RCT') {
    const abstract = manuscript?.abstract
    if (!abstract || !String(abstract).trim()) return true
    if (!/\b(randomi[sz]ed|allocation|placebo-controlled|double-blind)\b/i.test(String(abstract))) return true
  }
  return false
}

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
    if (!w?.id || !Number.isFinite(w?.score)) continue
    const itemMeta = Q500_BY_ID[w.id]
    // Article-type guardrail: skip items that don't apply to this manuscript.
    if (shouldSkipForArticleType(itemMeta, manuscript)) continue
    // Per-item target: cap TARGET_ANCHOR by the item's actual rubric ceiling.
    const itemMax = MAX_SCORE_BY_ID[w.id]
    const targetScore = Math.min(TARGET_ANCHOR, Number.isFinite(itemMax) ? itemMax : 4)
    if (w.score >= targetScore) continue
    const cf = withItemScore(extraction, w.id, targetScore)
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
      target_score: targetScore,
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
  // Use per-item target_score (already capped by rubric ceiling in singletons).
  const idMap = new Map(top.map(s => [s.id, Number.isFinite(s.target_score) ? s.target_score : TARGET_ANCHOR]))
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
