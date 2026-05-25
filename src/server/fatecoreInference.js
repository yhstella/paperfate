// FateCore inference runtime.
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
  { key: 'jcr_jif', label: 'y_jcr_jif', file: 'fatecore-v0.2-prod-y_jcr_jif.txt' },
  { key: 'icite_rcr', label: 'y_icite_rcr', file: 'fatecore-v0.2-prod-y_icite_rcr.txt' },
  { key: 'citations_5yr', label: 'y_citations_log', file: 'fatecore-v0.2-prod-y_citations_log.txt' },
]
const TIMELINE_VERSION = 'v0.4-timeline'

function targetFilesForVersion(versionTag) {
  return TARGETS.map(target => ({
    ...target,
    file: `fatecore-${versionTag}-${target.label}.txt`,
  }))
}

// ROLLBACK 2026-05-24: v0.3 deployed with severe data leakage (icite_citation_count,
// citations_openalex, fwci, pmc_body_word_count are post-publication features that
// don't exist for cold-start submissions). R²=0.9525 was test-set illusion — real
// production behavior was WORSE than v0.2-prod (EMPA-REG JIF prediction dropped
// from 1.25 to 0.61). Reverted to v0.2-prod until v0.3-prepub is retrained with
// pre-submission features only.
// v0.2-prod (2026-05-22): log-target + class weighting + author features.
//   y_jcr_jif: R²(log)=0.435  MAE_cal=1.35  (honest pre-submission baseline)

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
  const versionTag = opts.versionTag || process.env.FATECORE_VERSION || 'v0.2-prod'
  const targets = targetFilesForVersion(versionTag)
  const metricsPath = join(weightsDir, `fatecore-${versionTag}-metrics.json`)
  const metrics = loadJson(metricsPath, {})
  const schema = latestFeatureSchema(fatecoreDir) || {}
  const featuresUsed =
    metrics.feature_cols ||
    metrics.features_used ||
    schema.feature_cols ||
    schema.cols?.filter(c => !['doi', 'pmid', 'y_jcr_jif', 'y_icite_rcr', 'y_citations_log'].includes(c)) ||
    []

  const models = {}
  for (const target of targets) {
    const path = join(weightsDir, target.file)
    if (!existsSync(path)) continue
    models[target.key] = parseLightGbmModel(readFileSync(path, 'utf8'))
  }

  return {
    version: `fatecore-${versionTag}`,
    weightsDir,
    targets,
    featureNames: featuresUsed,
    metrics,
    models,
    loadedTargets: Object.keys(models),
    missingTargets: targets.map(t => t.key).filter(k => !models[k]),
  }
}

export function loadTimelineModel(opts = {}) {
  const weightsDir = opts.weightsDir || process.env.FATECORE_WEIGHTS_DIR || DEFAULT_WEIGHTS_DIR
  const versionTag = opts.timelineVersionTag || process.env.FATECORE_TIMELINE_VERSION || TIMELINE_VERSION
  const metricsPath = join(weightsDir, `fatecore-${versionTag}-metrics.json`)
  const modelPath = join(weightsDir, `fatecore-${versionTag}-review_days.txt`)
  if (!existsSync(metricsPath) || !existsSync(modelPath)) return null
  const metrics = loadJson(metricsPath, {})
  return {
    version: `fatecore-${versionTag}`,
    featureNames: metrics.feature_cols || [],
    metrics,
    model: parseLightGbmModel(readFileSync(modelPath, 'utf8')),
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

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return NaN
}

function wordCount(text) {
  if (!text) return 0
  const m = String(text).trim().match(/\S+/g)
  return m ? m.length : 0
}

function structuredAbstract(text) {
  return /\b(background|objective|methods?|results?|conclusions?|importance|design|setting|participants|interventions?)\s*:/i.test(String(text || '')) ? 1 : 0
}

function pubTypeFlags(manuscript, extraction) {
  const blob = `${extraction?.article_type || ''} ${manuscript?.article_type || ''} ${manuscript?.title || ''} ${manuscript?.abstract || ''}`.toLowerCase()
  return {
    is_review: /\b(review|meta-analysis|systematic review)\b/.test(blob) ? 1 : 0,
    is_case_report: /\bcase report\b/.test(blob) ? 1 : 0,
    is_trial: /\b(randomized|randomised|clinical trial|trial|rct)\b/.test(blob) ? 1 : 0,
  }
}

function stableStringHash(value) {
  if (!value) return NaN
  let h = 2166136261
  for (const ch of String(value)) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function qStats(extraction) {
  const items = extractionItems(extraction)
  const values = items.map(scoreToNumber)
  const numeric = values.filter(v => Number.isFinite(v) && v >= 0)
  const na = values.filter(v => v === -1).length
  const unknown = values.filter(v => v === -2 || Number.isNaN(v)).length
  const mean = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : NaN
  const sd = numeric.length
    ? Math.sqrt(numeric.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / numeric.length)
    : NaN
  return {
    q_score_count: items.length,
    q_numeric_count: numeric.length,
    q_score_mean: mean,
    q_score_sd: sd,
    q_score_min: numeric.length ? Math.min(...numeric) : NaN,
    q_score_max: numeric.length ? Math.max(...numeric) : NaN,
    q_numeric_frac: items.length ? numeric.length / items.length : NaN,
    q_na_count: na,
    q_unknown_count: unknown,
    q_na_frac: items.length ? na / items.length : NaN,
  }
}

function priorJournalValue(targetJournal, ...names) {
  for (const name of names) {
    const n = Number(targetJournal?.[name])
    if (Number.isFinite(n)) return n
  }
  return NaN
}

export function buildFeatureVector(manuscript, extraction, model, opts = {}) {
  const targetJournal = opts.targetJournal || {}
  const authorFeatures =
    opts.authorFeatures ||
    opts.author_features ||
    manuscript?.authorFeatures ||
    manuscript?.author_features ||
    {}
  const itemMap = new Map(extractionItems(extraction).map(item => [item.id, item]))
  const year = Number(opts.year || manuscript?.year || new Date().getFullYear())
  const nowYear = new Date().getFullYear()
  const flags = pubTypeFlags(manuscript, extraction)
  const q = qStats(extraction)
  const fundingText = `${manuscript?.funder || ''} ${manuscript?.funding || ''}`
  const meshTerms = Array.isArray(manuscript?.mesh_terms) ? manuscript.mesh_terms : []
  const firstMesh = meshTerms[0] ? String(meshTerms[0]).split('/')[0].toLowerCase() : ''

  const values = {
    year,
    pub_year_age: Math.max(0, nowYear - year),
    title_word_count: wordCount(manuscript?.title),
    abstract_word_count: wordCount(manuscript?.abstract),
    has_structured_abstract: structuredAbstract(manuscript?.abstract),
    is_research_article: 1,
    is_clinical: inferClinical(manuscript, extraction),
    icite_is_clinical: inferClinical(manuscript, extraction),
    is_review: flags.is_review,
    is_case_report: flags.is_case_report,
    is_trial: flags.is_trial,
    author_count: countAuthors(manuscript),
    has_first_affiliation: manuscript?.first_affiliation ? 1 : NaN,
    has_funder: manuscript?.funder || manuscript?.funding ? 1 : 0,
    has_nih_grant: /\b(NIH|NCI|NHLBI|NIDDK|NIAID|R01|R21|U01|P30|K23|K99)\b/i.test(fundingText) ? 1 : 0,
    n_nih_grants: (fundingText.match(/\b(?:R01|R21|U01|P30|K23|K99)[A-Z0-9-]*\b/gi) || []).length,
    publication_types_count: NaN,
    mesh_terms_count: meshTerms.length || NaN,
    first_mesh_root_hash: stableStringHash(firstMesh),
    is_preprint: manuscript?.is_preprint ? 1 : 0,
    preprint_exists: manuscript?.is_preprint ? 1 : 0,
    preprint_pub_gap_days: NaN,
    first_author_h_index: firstFinite(manuscript?.first_author_h_index, authorFeatures.first_author_h_index),
    last_author_h_index: firstFinite(manuscript?.last_author_h_index, authorFeatures.last_author_h_index),
    max_team_h_index: firstFinite(manuscript?.max_team_h_index, authorFeatures.max_team_h_index),
    median_team_h_index: firstFinite(manuscript?.median_team_h_index, authorFeatures.median_team_h_index),
    team_size_with_id: firstFinite(manuscript?.team_size_with_id, authorFeatures.team_size_with_id),
    international_collab: firstFinite(manuscript?.international_collab, authorFeatures.international_collab),
    citations_openalex: NaN,
    fwci: NaN,
    fwci_topic_norm: NaN,
    reference_count: NaN,
    funder_count: manuscript?.funder || manuscript?.funding ? 1 : 0,
    unpaywall_is_oa: NaN,
    unpaywall_journal_oa: NaN,
    unpaywall_journal_doaj: NaN,
    has_pmcid: 0,
    pmc_body_word_count: wordCount(manuscript?.full_text),
    pmc_figure_count: NaN,
    pmc_table_count: NaN,
    pmc_ref_count: NaN,
    epmc_body_word_count: NaN,
    pdf_body_words: NaN,
    icite_citation_count: NaN,
    icite_nih_percentile: NaN,
    icite_apt: NaN,
    icite_cited_by_clin: NaN,
    ...q,
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
    j_hist_metric_age: priorJournalValue(targetJournal, 'j_hist_metric_age', 'prior_metric_age'),
    j_hist_jcr_jif: priorJournalValue(targetJournal, 'j_hist_jcr_jif', 'prior_jcr_jif', 'jcr_jif_prior', 'jcr_jif', 'jif'),
    j_hist_jcr_jif_5yr: priorJournalValue(targetJournal, 'j_hist_jcr_jif_5yr', 'prior_jcr_jif_5yr', 'jcr_jif_5yr_prior', 'jcr_jif_5yr', 'j_jcr_jif_5yr'),
    j_hist_jci: priorJournalValue(targetJournal, 'j_hist_jci', 'prior_jci', 'jci_prior', 'jci', 'j_jci'),
    j_hist_sjr: priorJournalValue(targetJournal, 'j_hist_sjr', 'prior_sjr', 'sjr_prior', 'sjr'),
    j_hist_scimago_h_index: priorJournalValue(targetJournal, 'j_hist_scimago_h_index', 'prior_scimago_h_index'),
    j_hist_total_docs_year: priorJournalValue(targetJournal, 'j_hist_total_docs_year', 'prior_total_docs_year'),
    j_hist_cites_per_doc_2y: priorJournalValue(targetJournal, 'j_hist_cites_per_doc_2y', 'prior_cites_per_doc_2y'),
    j_hist_eigenfactor: priorJournalValue(targetJournal, 'j_hist_eigenfactor', 'prior_eigenfactor'),
    j_hist_article_influence: priorJournalValue(targetJournal, 'j_hist_article_influence', 'prior_article_influence'),
  }

  const featureNames = model.featureNames || []
  const vector = featureNames.map(name => {
    const v = values[name]
    if (Number.isFinite(v)) return Number(v)
    if (name.startsWith('q_')) return scoreToNumber(itemMap.get(name.slice(2)))
    return NaN
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
  const q90 = Number(m.conformal_q90_transformed ?? m.conformal_q90_log ?? m.conformal_q90)
  const radius = Number.isFinite(q90) ? q90 : Math.max(1, Math.abs(point) * 0.4)
  return { point, radius, logScale: !!m.log_scale }
}

function calibratedInterval(cal, target) {
  const hi = target.key === 'citations_5yr' ? 100000 : target.key === 'jcr_jif' ? 300 : 100
  if (cal.logScale || target.key === 'citations_5yr') {
    const point = Math.expm1(cal.point)
    const lo = Math.expm1(cal.point - cal.radius)
    const upper = Math.expm1(cal.point + cal.radius)
    return {
      point: +clamp(point, 0, hi).toFixed(3),
      ci_low: +clamp(lo, 0, hi).toFixed(3),
      ci_high: +clamp(upper, 0, hi).toFixed(3),
    }
  }
  return interval(cal.point, cal.radius, 0, hi)
}

function calibratedTimelineInterval(raw, timelineModel) {
  const metrics = timelineModel?.metrics || {}
  const pointLog = interpolateIso(raw, metrics.iso_x, metrics.iso_y)
  const radius = Number(metrics.conformal_q_log)
  const q = Number.isFinite(radius) ? radius : 0.9
  const toDays = (x) => clamp(Math.expm1(x), 1, 730)
  return {
    point: +toDays(pointLog).toFixed(1),
    ci_low: +toDays(pointLog - q).toFixed(1),
    ci_high: +toDays(pointLog + q).toFixed(1),
  }
}

export function predictFromExtraction(manuscript, extraction, opts = {}) {
  const model = opts.model || loadFateCore(opts)
  const { vector } = buildFeatureVector(manuscript, extraction, model, opts)
  const predictions = {}
  let modelTargets = 0

  for (const target of (model.targets || TARGETS)) {
    const lgb = model.models[target.key]
    if (!lgb) continue
    const raw = predictLightGbm(lgb, vector)
    const cal = applyTargetCalibration(raw, target, model)
    predictions[target.key] = calibratedInterval(cal, target)
    modelTargets++
  }

  const fallback = heuristicPredictions(extraction, opts.targetJournal)
  for (const [k, v] of Object.entries(fallback)) {
    if (!predictions[k]) predictions[k] = v
  }
  if (!predictions.desk_reject_risk) predictions.desk_reject_risk = fallback.desk_reject_risk

  const timelineModel = opts.timelineModel === false
    ? null
    : (opts.timelineModel || loadTimelineModel(opts))
  let timelineLoaded = false
  if (timelineModel?.model && timelineModel.featureNames?.length) {
    const { vector: timelineVector } = buildFeatureVector(manuscript, extraction, timelineModel, opts)
    const rawTimeline = predictLightGbm(timelineModel.model, timelineVector)
    predictions.review_timeline_days = calibratedTimelineInterval(rawTimeline, timelineModel)
    timelineLoaded = true
  }

  const domain = domainScores(extraction)
  const q = quality01(extraction)
  const extractionConfidence = extraction?.items_attempted
    ? clamp((extraction.items_scored || 0) / extraction.items_attempted, 0.2, 1)
    : 0.6

  const journey = generateJourney(predictions.jcr_jif, manuscript, extraction)

  return {
    predictions,
    domain_scores: domain,
    weakness: extraction?.key_weaknesses || extraction?.weakest_domains || [],
    similar_papers: [],
    journey,
    confidence: +clamp((modelTargets ? 0.72 : 0.45) + 0.18 * extractionConfidence + 0.08 * q, 0, 0.95).toFixed(3),
    cost_usd: Number(extraction?.cost?.total_usd ?? extraction?.cost_usd ?? 0),
    fatecore: {
      version: model.version,
      model_status: modelTargets ? 'loaded' : 'heuristic_fallback',
      loaded_targets: model.loadedTargets,
      missing_targets: model.missingTargets,
      timeline_model: timelineLoaded ? timelineModel.version : 'not_loaded',
      feature_count: model.featureNames.length,
    },
  }
}

// ─── Journey generator ────────────────────────────────────────────────────
let _journals = null
function loadJournals() {
  if (_journals) return _journals
  const p = join(DEFAULT_WEIGHTS_DIR, 'journals-shortlist.json')
  if (!existsSync(p)) { _journals = []; return _journals }
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    _journals = data.journals || []
  } catch { _journals = [] }
  return _journals
}

// Heuristic field detection from manuscript keywords + MeSH
function detectFields(manuscript, extraction) {
  const text = `${manuscript?.title || ''} ${manuscript?.abstract || ''}`.toLowerCase()
  const mesh = (manuscript?.mesh_terms || []).map(m => (typeof m === 'string' ? m : m.descriptor || '').toLowerCase())
  const blob = `${text} ${mesh.join(' ')}`
  const fields = []
  const patterns = {
    cardiology: /\b(heart|cardiac|cardiovascular|coronary|atrial|ventricular|myocardial|hypertension|arrhythmia)\b/,
    oncology: /\b(cancer|tumor|tumour|carcinoma|oncolog|chemo|metastasi|adenocarcinoma|sarcoma|melanoma|leukemia|lymphoma)\b/,
    neurology: /\b(brain|neuro|stroke|alzheimer|parkinson|dementia|epilepsy|multiple sclerosis|cognitive)\b/,
    endocrine: /\b(diabetes|insulin|thyroid|hba1c|glycemic|adrenal|pituitary|hormone|obesity)\b/,
    gastro: /\b(liver|hepat|gastro|colon|intestinal|ibd|crohn|colitis|pancrea|biliary)\b/,
    pulmonology: /\b(lung|pulmonary|respiratory|asthma|copd|pneumonia)\b/,
    nephrology: /\b(kidney|renal|dialysis|nephro|glomerul)\b/,
    rheumatology: /\b(rheumatoid|lupus|arthritis|autoimmune|vasculitis)\b/,
    psychiatry: /\b(depression|schizophrenia|bipolar|anxiety|psychiatric|psychotic|suicide)\b/,
    infectious: /\b(infection|infectious|hiv|tuberculosis|antimicrobial|sepsis|covid|vaccine|microbi)\b/,
    pediatrics: /\b(pediatric|paediatric|neonatal|infant|childhood|child|children|adolescent|birth cohort)\b/,
    obgyn: /\b(pregnan|obstetric|gynec|maternal|fetal|cesarean)\b/,
    hematology: /\b(blood|leukemia|lymphoma|anemia|hemato|sickle|thrombo)\b/,
    surgery: /\b(surgery|surgical|laparoscop|operative|perioperative|anesthesia)\b/,
    public_health: /\b(epidemiol|public health|population|policy|disparities)\b/,
    ai_imaging: /\b(deep learning|neural network|machine learning|convolutional|radiomic)\b.{0,200}\b(image|imaging|radiograph|mri|ct|x-ray)\b/,
  }
  for (const [k, re] of Object.entries(patterns)) {
    if (re.test(blob)) fields.push(k)
  }
  return fields
}

// Map field code → likely jcr_category substrings (lowercase)
const FIELD_CATEGORY_MAP = {
  cardiology: ['cardiac', 'cardiology', 'cardiovascular', 'peripheral vascular'],
  oncology: ['oncology', 'cancer', 'hematology'],
  neurology: ['neuroscience', 'clinical neurology', 'neurology', 'psychiatry'],
  endocrine: ['endocrinology', 'diabetes', 'metabolism', 'nutrition'],
  gastro: ['gastroenterology', 'hepatology'],
  pulmonology: ['respiratory', 'pulmonary'],
  nephrology: ['nephrology', 'renal', 'kidney'],
  rheumatology: ['rheumatology'],
  psychiatry: ['psychiatry', 'psychology'],
  infectious: ['infectious', 'microbiology', 'virology'],
  pediatrics: ['pediatric', 'paediatric'],
  obgyn: ['obstetrics', 'gynecology'],
  hematology: ['hematology', 'blood'],
  surgery: ['surgery'],
  public_health: ['public', 'environmental occupational'],
  ai_imaging: ['radiology', 'imaging', 'computer'],
}

// Split a journal-category string into a set of normalized tokens
// (e.g. "oncology - scie(q1)" → {"oncology"}; "general & internal medicine" → {"general","medicine"}).
function categoryTokens(catRaw) {
  const cat = String(catRaw || '').toLowerCase()
  if (!cat) return new Set()
  const stripped = cat
    .replace(/\b(scie|ssci)\s*\(\s*q[1-4]\s*\)/g, '')
    .replace(/\bq[1-4]\b/g, '')
    .replace(/[()]/g, ' ')
  const tokens = stripped.split(/[\s,;/&\-]+/).map(t => t.trim()).filter(t => t.length > 2)
  const stop = new Set(['and', 'the', 'for', 'general', 'journal', 'science', 'sciences'])
  return new Set(tokens.filter(t => !stop.has(t)))
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return inter / union
}

// Switch cost between two journals on a 0..1 scale, plus a human reason.
// Components: (a) category jaccard distance, (b) publisher change,
// (c) JIF gap (log scale), (d) OA model change.
function computeSwitchCost(from, to) {
  if (!from || !to) return { cost: 0, label: 'first submission', reason: 'Highest-impact target.' }

  const fromCats = categoryTokens(from.category)
  const toCats   = categoryTokens(to.category)
  const catSim   = jaccard(fromCats, toCats)
  const catDist  = 1 - catSim                                              // 0 = same scope, 1 = unrelated

  const publisherChange = (from.publisher || '') !== (to.publisher || '') ? 1 : 0
  const oaChange        = !!from.is_oa !== !!to.is_oa ? 1 : 0

  const fJif = Number.isFinite(+from.jif) ? Math.max(0.1, +from.jif) : null
  const tJif = Number.isFinite(+to.jif)   ? Math.max(0.1, +to.jif)   : null
  const jifGap = fJif != null && tJif != null
    ? Math.min(1, Math.abs(Math.log(fJif) - Math.log(tJif)) / Math.log(8))  // log-ratio of 8x → 1.0
    : 0.3                                                                   // unknown → moderate proxy

  // Weighted sum, clipped to [0, 1].
  const cost = Math.min(1, 0.45 * catDist + 0.25 * publisherChange + 0.20 * jifGap + 0.10 * oaChange)

  const reasons = []
  if (catDist <= 0.15) reasons.push('same scope')
  else if (catDist <= 0.5) reasons.push('adjacent scope')
  else reasons.push('different scope — abstract/intro rewrite likely')

  if (!publisherChange) reasons.push('same publisher (reference style reusable)')
  else reasons.push('publisher change (reformat references)')

  if (jifGap < 0.25) reasons.push('similar IF tier')
  else if (jifGap < 0.6) reasons.push('IF tier shift')
  else reasons.push('large IF tier shift — adjust framing')

  if (oaChange) reasons.push(from.is_oa ? 'switching to subscription model' : 'switching to OA (APC may apply)')

  const label = cost < 0.2 ? 'minimal'
              : cost < 0.45 ? 'low'
              : cost < 0.7 ? 'moderate'
              : 'high'

  return { cost: +cost.toFixed(3), label, reason: reasons.join(' · ') }
}

function generateJourney(jifPred, manuscript, extraction) {
  const journals = loadJournals()
  if (!journals.length || !jifPred || !Number.isFinite(jifPred.point)) return []

  const fields = detectFields(manuscript, extraction)
  const fieldCats = new Set(
    fields.flatMap(f => FIELD_CATEGORY_MAP[f] || []).map(s => s.toLowerCase())
  )

  // Score each journal by (1) JIF fit to target, (2) category fit
  function scoreFit(j, targetJif) {
    if (j.jif == null) return 0
    const ratio = Math.min(j.jif, targetJif) / Math.max(j.jif, targetJif)
    let fieldBoost = 1.0
    if (fieldCats.size && j.category) {
      const cat = String(j.category).toLowerCase()
      const matches = [...fieldCats].filter(c => cat.includes(c)).length
      // Strong boost if any field-category overlap; multi-overlap multiplies further.
      // Penalize unrelated categories more aggressively so off-topic picks lose out.
      if (matches >= 2) fieldBoost = 3.0
      else if (matches === 1) fieldBoost = 2.2
      else fieldBoost = 0.55
    }
    return ratio * fieldBoost
  }

  function pickBest(targetJif, excludeIssns) {
    let best = null, bestScore = 0
    for (const j of journals) {
      if (excludeIssns.has(j.issn || j.name)) continue
      const s = scoreFit(j, targetJif)
      if (s > bestScore) { bestScore = s; best = j }
    }
    return best
  }

  const pred = jifPred.point
  // 5 steps: stretch → best-fit → backup1 → backup2 → safety
  const targets = [
    { step: 1, label: 'stretch (aspirational)',  jif: pred * 1.5 },
    { step: 2, label: 'best fit (predicted JIF)', jif: pred },
    { step: 3, label: 'backup tier-1',            jif: pred * 0.7 },
    { step: 4, label: 'backup tier-2',            jif: pred * 0.5 },
    { step: 5, label: 'safety (OA fast review)',  jif: pred * 0.35 },
  ]

  const usedKeys = new Set()
  const result = []
  let prevPick = null
  for (const t of targets) {
    const pick = pickBest(t.jif, usedKeys)
    if (!pick) continue
    usedKeys.add(pick.issn || pick.name)
    const sc = computeSwitchCost(prevPick, pick)
    result.push({
      step: t.step,
      venue: pick.name,
      issn: pick.issn,
      if: pick.jif,
      publisher: pick.publisher || '—',
      style: pick.category || (pick.is_oa ? 'open access' : 'specialty journal'),
      switchCost: sc.label,
      switchCostValue: sc.cost,
      switchReason: sc.reason,
      tier: pick.tier,
      is_oa: pick.is_oa,
    })
    prevPick = pick
  }
  return result
}

export { parseLightGbmModel, predictLightGbm, interpolateIso, generateJourney }
