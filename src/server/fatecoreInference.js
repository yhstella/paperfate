// FateCore v0.1 inference runtime.
//
// Loads LightGBM native .txt models when available. Until Claude's training
// finishes, the same public interface returns a calibrated heuristic fallback
// so /api/forecast and scripts/test-fatecore-inference.mjs can be integrated.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DEFAULT_WEIGHTS_DIR = join(ROOT, 'weights')
const DEFAULT_DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DEFAULT_FATECORE_DIR = join(DEFAULT_DATA_ROOT, 'fatecore')

const TARGETS = [
  { key: 'jcr_jif', label: 'y_jcr_jif', file: 'fatecore-v0.1-y_jcr_jif.txt' },
  { key: 'icite_rcr', label: 'y_icite_rcr', file: 'fatecore-v0.1-y_icite_rcr.txt' },
  { key: 'citations_5yr', label: 'y_citations_log', file: 'fatecore-v0.1-y_citations_log.txt' },
]

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo
  return Math.max(lo, Math.min(hi, x))
}

function parseNumericList(value) {
  if (!value) return []
  return value.trim().split(/\s+/).map(x => {
    const n = Number(x)
    return Number.isFinite(n) ? n : x
  })
}

function parseStringList(value) {
  if (!value) return []
  return value.trim().split(/\s+/)
}

function parseLightGbmModel(text) {
  const lines = text.split(/\r?\n/)
  const trees = []
  let featureNames = []
  let current = null

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('feature_names=')) {
      featureNames = parseStringList(line.slice('feature_names='.length))
      continue
    }
    if (line.startsWith('Tree=')) {
      if (current) trees.push(current)
      current = {}
      continue
    }
    if (!current) continue
    const i = line.indexOf('=')
    if (i < 0) continue
    const key = line.slice(0, i)
    const value = line.slice(i + 1)
    if (
      key === 'split_feature' ||
      key === 'left_child' ||
      key === 'right_child' ||
      key === 'leaf_value' ||
      key === 'threshold' ||
      key === 'default_left' ||
      key === 'decision_type' ||
      key === 'missing_type'
    ) {
      current[key] = key === 'missing_type' ? parseStringList(value) : parseNumericList(value)
    }
  }
  if (current) trees.push(current)
  return { featureNames, trees }
}

function childToLeafIndex(child) {
  return -child - 1
}

function predictTree(tree, features) {
  let node = 0
  while (node >= 0) {
    const fIdx = tree.split_feature?.[node]
    const threshold = tree.threshold?.[node]
    const x = features[fIdx]
    const missing = x == null || Number.isNaN(x)
    const defaultLeft = String(tree.default_left?.[node] ?? '1') === '1'
    const goLeft = missing ? defaultLeft : Number(x) <= Number(threshold)
    node = goLeft ? tree.left_child[node] : tree.right_child[node]
  }
  const leaf = childToLeafIndex(node)
  return Number(tree.leaf_value?.[leaf] ?? 0)
}

function predictLightGbm(model, features) {
  return model.trees.reduce((sum, tree) => sum + predictTree(tree, features), 0)
}

function interpolateIso(x, xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length === 0 || xs.length !== ys.length) return x
  if (x <= xs[0]) return ys[0]
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1]
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const x0 = xs[i - 1], x1 = xs[i]
      const y0 = ys[i - 1], y1 = ys[i]
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0)
      return y0 + t * (y1 - y0)
    }
  }
  return x
}

function loadJson(path, fallback = null) {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function latestFeatureSchema(fatecoreDir) {
  const direct = join(fatecoreDir, 'feature-schema.json')
  return loadJson(direct, null)
}

export function loadFateCore(opts = {}) {
  const weightsDir = opts.weightsDir || process.env.FATECORE_WEIGHTS_DIR || DEFAULT_WEIGHTS_DIR
  const fatecoreDir = opts.fatecoreDir || process.env.FATECORE_DATA_DIR || DEFAULT_FATECORE_DIR
  const metricsPath = join(weightsDir, 'fatecore-v0.1-metrics.json')
  const metrics = loadJson(metricsPath, {})
  const schema = latestFeatureSchema(fatecoreDir) || {}
  const featuresUsed = metrics.features_used || schema.cols?.filter(c => !['doi', 'pmid', 'y_jcr_jif', 'y_icite_rcr', 'y_citations_log'].includes(c)) || []

  const models = {}
  for (const target of TARGETS) {
    const path = join(weightsDir, target.file)
    if (!existsSync(path)) continue
    models[target.key] = parseLightGbmModel(readFileSync(path, 'utf8'))
  }

  return {
    version: 'fatecore-v0.1',
    weightsDir,
    featureNames: featuresUsed,
    metrics,
    models,
    loadedTargets: Object.keys(models),
    missingTargets: TARGETS.map(t => t.key).filter(k => !models[k]),
  }
}

function scoreToNumber(item) {
  if (!item) return NaN
  if (typeof item.score === 'number') return item.score
  if (item.na) return -1
  if (item.unknown) return -2
  if (item.score === 'NA') return -1
  if (item.score === 'UNK') return -2
  return NaN
}

function extractionItems(extraction) {
  if (Array.isArray(extraction?.items)) return extraction.items
  return []
}

function inferClinical(manuscript, extraction) {
  const text = `${manuscript?.title || ''} ${manuscript?.abstract || ''}`.toLowerCase()
  if (/\b(patient|patients|clinical|trial|cohort|mortality|therapy|treatment|hospital)\b/.test(text)) return 1
  if (String(extraction?.article_type || '').match(/clinical|RCT|cohort|diagnostic/i)) return 1
  return 0
}

function countAuthors(manuscript) {
  if (Array.isArray(manuscript?.authors)) return manuscript.authors.length
  if (typeof manuscript?.authors === 'string' && manuscript.authors.trim()) return manuscript.authors.split(/[,;]/).filter(Boolean).length
  return NaN
}

export function buildFeatureVector(manuscript, extraction, model, opts = {}) {
  const targetJournal = opts.targetJournal || {}
  const itemMap = new Map(extractionItems(extraction).map(item => [item.id, item]))
  const year = Number(opts.year || manuscript?.year || new Date().getFullYear())
  const nowYear = new Date().getFullYear()

  const values = {
    year,
    pub_year_age: Math.max(0, nowYear - year),
    is_research_article: 1,
    is_clinical: inferClinical(manuscript, extraction),
    author_count: countAuthors(manuscript),
    has_first_affiliation: manuscript?.first_affiliation ? 1 : NaN,
    has_funder: manuscript?.funder || manuscript?.funding ? 1 : 0,
    publication_types_count: NaN,
    mesh_terms_count: NaN,
    is_preprint: manuscript?.is_preprint ? 1 : 0,
    first_author_h_index: targetJournal.first_author_h_index ?? NaN,
    last_author_h_index: targetJournal.last_author_h_index ?? NaN,
    max_team_h_index: targetJournal.max_team_h_index ?? NaN,
    median_team_h_index: targetJournal.median_team_h_index ?? NaN,
    team_size_with_id: targetJournal.team_size_with_id ?? NaN,
    international_collab: targetJournal.international_collab ?? NaN,
    j_h_index: targetJournal.h_index ?? targetJournal.j_h_index ?? NaN,
    j_i10_index: targetJournal.i10_index ?? targetJournal.j_i10_index ?? NaN,
    j_two_yr_mean_citedness: targetJournal.two_yr_mean_citedness ?? targetJournal.j_two_yr_mean_citedness ?? NaN,
    j_works_count: targetJournal.works_count ?? targetJournal.j_works_count ?? NaN,
    j_cited_by_count: targetJournal.cited_by_count ?? targetJournal.j_cited_by_count ?? NaN,
    j_is_oa: targetJournal.is_oa ?? targetJournal.j_is_oa ?? NaN,
    j_is_in_doaj: targetJournal.is_in_doaj ?? targetJournal.j_is_in_doaj ?? NaN,
    j_is_core: targetJournal.is_core ?? targetJournal.j_is_core ?? NaN,
    j_apc_usd: targetJournal.apc_usd ?? targetJournal.j_apc_usd ?? NaN,
    j_first_publication_year: targetJournal.first_publication_year ?? targetJournal.j_first_publication_year ?? NaN,
    j_jcr_jif_5yr: targetJournal.jcr_jif_5yr ?? targetJournal.j_jcr_jif_5yr ?? NaN,
    j_jci: targetJournal.jci ?? targetJournal.j_jci ?? NaN,
  }

  const featureNames = model.featureNames || []
  const vector = featureNames.map(name => {
    if (name.startsWith('q_')) return scoreToNumber(itemMap.get(name.slice(2)))
    const v = values[name]
    return Number.isFinite(v) ? Number(v) : NaN
  })
  return { featureNames, vector }
}

function domainScores(extraction) {
  const out = {}
  for (const d of extraction?.domain_rollup || []) {
    out[d.domain] = d.score
  }
  return out
}

function quality01(extraction) {
  if (Number.isFinite(extraction?.overall_score)) return clamp(extraction.overall_score / 100, 0, 1)
  const vals = Object.values(domainScores(extraction)).filter(Number.isFinite)
  if (vals.length) return clamp(vals.reduce((a, b) => a + b, 0) / vals.length / 100, 0, 1)
  const items = extractionItems(extraction).map(scoreToNumber).filter(v => Number.isFinite(v) && v >= 0)
  if (items.length) return clamp(items.reduce((a, b) => a + b, 0) / items.length / 5, 0, 1)
  return 0.5
}

function heuristicPredictions(extraction, targetJournal = {}) {
  const q = quality01(extraction)
  const jifAnchor = Number(targetJournal.jcr_jif_5yr ?? targetJournal.jif ?? targetJournal.j_jcr_jif_5yr)
  const jif = Number.isFinite(jifAnchor) ? jifAnchor * (0.65 + 0.7 * q) : 1.5 + 18 * Math.pow(q, 1.8)
  const rcr = 0.35 + 3.8 * Math.pow(q, 1.5)
  const citations = Math.round(Math.expm1(1.2 + 4.2 * Math.pow(q, 1.7)))
  const desk = clamp(0.82 - 0.68 * q, 0.04, 0.9)
  return {
    jcr_jif: interval(jif, Math.max(1.5, jif * 0.55), 0, 300),
    icite_rcr: interval(rcr, Math.max(0.35, rcr * 0.6), 0, 100),
    citations_5yr: interval(citations, Math.max(8, citations * 1.2), 0, 100000),
    desk_reject_risk: interval(desk, 0.16, 0, 1),
  }
}

function interval(point, radius, lo, hi) {
  return {
    point: +clamp(point, lo, hi).toFixed(3),
    ci_low: +clamp(point - radius, lo, hi).toFixed(3),
    ci_high: +clamp(point + radius, lo, hi).toFixed(3),
  }
}

function applyTargetCalibration(raw, target, model) {
  const m = model.metrics?.[target.label] || {}
  const point = interpolateIso(raw, m.iso_x, m.iso_y)
  const q90 = Number(m.conformal_q90)
  const radius = Number.isFinite(q90) ? q90 : Math.max(1, Math.abs(point) * 0.4)
  return { point, radius }
}

export function predictFromExtraction(manuscript, extraction, opts = {}) {
  const model = opts.model || loadFateCore(opts)
  const { vector } = buildFeatureVector(manuscript, extraction, model, opts)
  const predictions = {}
  let modelTargets = 0

  for (const target of TARGETS) {
    const lgb = model.models[target.key]
    if (!lgb) continue
    const raw = predictLightGbm(lgb, vector)
    const cal = applyTargetCalibration(raw, target, model)
    const value = target.key === 'citations_5yr' ? Math.expm1(cal.point) : cal.point
    const radius = target.key === 'citations_5yr' ? Math.max(5, value * 0.8) : cal.radius
    const hi = target.key === 'citations_5yr' ? 100000 : target.key === 'jcr_jif' ? 300 : 100
    predictions[target.key] = interval(value, radius, 0, hi)
    modelTargets++
  }

  const fallback = heuristicPredictions(extraction, opts.targetJournal)
  for (const [k, v] of Object.entries(fallback)) {
    if (!predictions[k]) predictions[k] = v
  }
  if (!predictions.desk_reject_risk) predictions.desk_reject_risk = fallback.desk_reject_risk

  const domain = domainScores(extraction)
  const q = quality01(extraction)
  const extractionConfidence = extraction?.items_attempted
    ? clamp((extraction.items_scored || 0) / extraction.items_attempted, 0.2, 1)
    : 0.6

  return {
    predictions,
    domain_scores: domain,
    weakness: extraction?.key_weaknesses || extraction?.weakest_domains || [],
    similar_papers: [],
    confidence: +clamp((modelTargets ? 0.72 : 0.45) + 0.18 * extractionConfidence + 0.08 * q, 0, 0.95).toFixed(3),
    cost_usd: Number(extraction?.cost?.total_usd ?? extraction?.cost_usd ?? 0),
    fatecore: {
      version: model.version,
      model_status: modelTargets ? 'loaded' : 'heuristic_fallback',
      loaded_targets: model.loadedTargets,
      missing_targets: model.missingTargets,
      feature_count: model.featureNames.length,
    },
  }
}

export { parseLightGbmModel, predictLightGbm, interpolateIso }
