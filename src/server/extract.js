// PaperFate · top-level extraction wrapper
// Loads Q500 once, filters by lvl + article type, batches LLM scoring,
// computes 14-domain rollup. Server consumes forecastManuscript()
// from api/forecast.js.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PaperFateExtractor } from './anthropicClient.js'
import { GeminiExtractor } from './geminiClient.js'
import { RULE_BY_ITEM_ID } from './ruleExtractors.js'

// Factory: pick provider based on env vars.
// Priority: explicit opts.provider > GEMINI_API_KEY > ANTHROPIC_API_KEY.
// LLM_PROVIDER env can override ('gemini' | 'anthropic').
export function createExtractor(opts = {}) {
  const explicit = opts.provider || process.env.LLM_PROVIDER
  if (explicit === 'gemini')    return new GeminiExtractor(opts.geminiOpts || {})
  if (explicit === 'anthropic') return new PaperFateExtractor(opts.anthropicOpts || {})
  if (process.env.GEMINI_API_KEY)    return new GeminiExtractor(opts.geminiOpts || {})
  if (process.env.ANTHROPIC_API_KEY) return new PaperFateExtractor(opts.anthropicOpts || {})
  throw new Error('No LLM key set. Set GEMINI_API_KEY or ANTHROPIC_API_KEY.')
}

// filterItems shared between providers — both have a static method but they
// implement the same logic; expose a stable name here for callers.
export function filterItems(items, opts) {
  return PaperFateExtractor.filterItems(items, opts)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const RUBRIC_ROOT = join(HERE, '..', '..', 'docs', 'rubric')
const Q500_PATH   = join(RUBRIC_ROOT, 'Q500.json')

let _q500Cache = null
function loadQ500() {
  if (_q500Cache) return _q500Cache
  _q500Cache = JSON.parse(readFileSync(Q500_PATH, 'utf-8'))
  return _q500Cache
}

// Domain weights (mirrors schema.json → weights.domain_default).
// Replace by reading schema.json once the FateCore weights are trained.
const DOMAIN_WEIGHTS = {
  QUEST: 0.8,  NOVEL: 1.2, RELEV: 1.2,  DESIGN: 1.2,
  POPUL: 1.0,  EXPOS: 1.0, OUTCM: 1.0,  STATS:  1.2,
  BIAS:  1.1,  EXTV:  1.2, AIPRED: 1.1, REPRT:  0.7,
  INTERP: 0.8, FIGS:  0.5,
}

// Roll 0..5 item scores into a 0..100 domain score
function rollupDomain(scoredItems, domainCode) {
  const inDomain = scoredItems.filter(s => s.id.startsWith(domainCode + '_'))
  const applicable = inDomain.filter(s => s.applicability === 'applicable' && typeof s.score === 'number')
  if (applicable.length === 0) return { domain: domainCode, score: null, applicable_count: 0, total_count: inDomain.length, unk: inDomain.filter(s => s.score === 'UNK').length, na: inDomain.filter(s => s.score === 'NA').length }
  const sum = applicable.reduce((acc, s) => acc + s.score, 0)
  const max = applicable.length * 5
  return {
    domain: domainCode,
    score: Math.round((sum / max) * 100),
    applicable_count: applicable.length,
    total_count: inDomain.length,
    unk: inDomain.filter(s => s.score === 'UNK').length,
    na: inDomain.filter(s => s.score === 'NA').length,
    weight: DOMAIN_WEIGHTS[domainCode] ?? 1.0,
  }
}

function overallScore(domainRollup) {
  const scored = domainRollup.filter(d => d.score !== null)
  if (scored.length === 0) return null
  const num = scored.reduce((acc, d) => acc + d.score * d.weight, 0)
  const den = scored.reduce((acc, d) => acc + 100   * d.weight, 0)
  return Math.round((num / den) * 100)
}

function pickWeakest(domainRollup, n = 3) {
  return domainRollup
    .filter(d => d.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map(d => ({ domain: d.domain, score: d.score }))
}

function pickStrongest(domainRollup, n = 3) {
  return domainRollup
    .filter(d => d.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(d => ({ domain: d.domain, score: d.score }))
}

// Most-influential negatives: applicable items scored 0–2, weighted by domain
function pickKeyWeaknesses(scoredItems, q500items, n = 5) {
  const idToItem = Object.fromEntries(q500items.map(it => [it.id, it]))
  const negatives = scoredItems
    .filter(s => s.applicability === 'applicable' && typeof s.score === 'number' && s.score <= 2)
    .map(s => {
      const item = idToItem[s.id] || {}
      const domain = s.id.split('_')[0]
      const weight = DOMAIN_WEIGHTS[domain] ?? 1.0
      return {
        id: s.id,
        name: item.name || s.id,
        domain,
        score: s.score,
        gap: (5 - s.score) * weight,
        rationale: s.rationale_short,
        evidence: s.evidence_text,
      }
    })
    .sort((a, b) => b.gap - a.gap)
    .slice(0, n)
  return negatives
}

// ─────────────────── Rule layer (cheap pre-pass) ─────────────────────────────
//
// For every hybrid item with a wired rule extractor, run the rule first.
// If the rule succeeds, score is set deterministically and the LLM is
// skipped — significant cost saving (~25% of items with current 29-item
// coverage) and dramatically higher consistency on objective facts.
//
// The rule's high-confidence positive result maps to score 4 ("addressed
// with method") because rule extractors find evidence of presence + method;
// distinguishing 4 vs 5 (sensitivity analysis / transparency) requires
// LLM judgment, but score 4 is a reasonable floor.
//
function scoreFromRule(item, ruleResult) {
  if (!ruleResult) return null
  // Item-specific overrides for cases where the rule output maps cleanly to a
  // non-default anchor.
  if (item.id === 'STATS_007') {
    // exact p-values rubric: 0 absent → 5 exact + magnitude + correction
    const v = ruleResult.value
    if (v?.exact_count >= 1 && v?.threshold_only_count === 0) {
      return { score: 4, rationale: `${v.exact_count} exact p-value(s) reported (vs ${v.threshold_only_count} threshold-only).` }
    }
    if (v?.exact_count >= 1) {
      return { score: 3, rationale: `Mix of exact (${v.exact_count}) and threshold-only (${v.threshold_only_count}) p-values.` }
    }
    return { score: 1, rationale: 'Only threshold-style p<0.05 reported.' }
  }
  if (item.id === 'AIPRED_015') {
    // AUROC value gives more info
    const v = ruleResult.value
    if (typeof v === 'number') {
      return { score: 4, rationale: `Discrimination metric reported (≈${v}).` }
    }
    return { score: 3, rationale: 'Discrimination metric mentioned.' }
  }
  if (item.id === 'DESIGN_003' || item.id === 'REPRT_004') {
    // Registry ID found
    const v = ruleResult.value
    if (v?.id) {
      return { score: 3, rationale: `${v.registry} ID provided (${v.id}).` }
    }
  }
  if (item.id === 'DESIGN_011' || item.id === 'DESIGN_012') {
    const v = ruleResult.value
    if (v?.count >= 3) {
      return { score: 4, rationale: `Multicenter (${v.count} centers).` }
    }
    if (v?.multicenter) {
      return { score: 3, rationale: 'Multicenter design stated.' }
    }
  }
  if (item.id === 'REPRT_001') {
    const v = ruleResult.value
    if (Array.isArray(v) && v.length >= 1) {
      return { score: 3, rationale: `Reporting guideline(s) mentioned: ${v.join(', ')}.` }
    }
  }
  // Sample size — magnitude-aware: NEJM-class trials usually enroll 1k–20k,
  // mid-tier specialty often 100–500, single-center pilots <100.
  if (item.id === 'POPUL_005' || item.id === 'DESIGN_005' || item.id === 'STATS_021') {
    const n = Number(ruleResult.value)
    if (Number.isFinite(n)) {
      if (n >= 5000) return { score: 5, rationale: `N=${n.toLocaleString()} (very large, registry-/trial-class sample).` }
      if (n >= 1000) return { score: 4, rationale: `N=${n.toLocaleString()} (large, well-powered).` }
      if (n >=  300) return { score: 3, rationale: `N=${n.toLocaleString()} (typical specialty-cohort sample).` }
      if (n >=  100) return { score: 2, rationale: `N=${n} (limited sample).` }
      return         { score: 1, rationale: `N=${n} (small sample, underpowered for most endpoints).` }
    }
  }
  // Multicenter strengthened: international + many centers signals NEJM-tier.
  if (item.id === 'DESIGN_011' || item.id === 'DESIGN_012') {
    const v = ruleResult.value
    if (v?.international && (v?.count >= 10)) {
      return { score: 5, rationale: `International multicenter (${v.count} centers).` }
    }
    if (v?.count >= 3) {
      return { score: 4, rationale: `Multicenter (${v.count} centers).` }
    }
    if (v?.multicenter) {
      return { score: 3, rationale: 'Multicenter design stated.' }
    }
  }
  // AUC magnitude
  if (item.id === 'AIPRED_015' || item.id === 'EXTV_008') {
    const v = Number(ruleResult.value)
    if (Number.isFinite(v)) {
      if (v >= 0.90) return { score: 5, rationale: `Excellent discrimination (AUC ${v}).` }
      if (v >= 0.80) return { score: 4, rationale: `Good discrimination (AUC ${v}).` }
      if (v >= 0.70) return { score: 3, rationale: `Acceptable discrimination (AUC ${v}).` }
      return         { score: 2, rationale: `Limited discrimination (AUC ${v}).` }
    }
  }
  // Follow-up duration
  if (item.id === 'DESIGN_017') {
    const v = Number(ruleResult.value)
    if (Number.isFinite(v)) {
      if (v >= 60) return { score: 5, rationale: `≥5 year follow-up (${v} months).` }
      if (v >= 24) return { score: 4, rationale: `≥2 year follow-up (${v} months).` }
      if (v >= 12) return { score: 3, rationale: `≥1 year follow-up (${v} months).` }
      if (v >=  3) return { score: 2, rationale: `Short follow-up (${v} months).` }
      return         { score: 1, rationale: `Very short follow-up (${v} months).` }
    }
  }
  // Default: rule found a signal but cannot grade rigour. Returning null
  // defers to the LLM, which sees the calibration anchors and can produce
  // a tier-discriminating score. Previously this hard-coded score=4,
  // collapsing q_mean to ~4.0 across all tiers.
  return null
}

function runRulePrePass(items, manuscript) {
  const ruleResults = {}        // itemId → scored output (or null if skipped/no signal)
  const remainingItems = []      // items still needing LLM
  for (const item of items) {
    if (item.mode !== 'hybrid' && item.mode !== 'rule') {
      remainingItems.push(item)
      continue
    }
    const extractor = RULE_BY_ITEM_ID[item.id]
    if (!extractor) {
      remainingItems.push(item)
      continue
    }
    let r = null
    try { r = extractor(manuscript) } catch (e) {
      remainingItems.push(item)
      continue
    }
    if (!r) {
      // No signal found by rule — fall through to LLM
      remainingItems.push(item)
      continue
    }
    const mapping = scoreFromRule(item, r)
    if (!mapping) {
      remainingItems.push(item)
      continue
    }
    ruleResults[item.id] = {
      id:               item.id,
      score:            mapping.score,
      applicability:    'applicable',
      confidence:       r.confidence ?? 0.85,
      evidence_text:    r.evidence_text || '',
      evidence_section: r.evidence_section || '',
      rationale_short:  mapping.rationale,
      scoring_mode:     'rule',
    }
  }
  return { ruleResults, remainingItems }
}

/**
 * forecastManuscript — top-level entry the server endpoint calls.
 *
 * @param {Object}  manuscript     {title, abstract, methods?, results?, discussion?, full_text?}
 * @param {String}  articleType    one of schema.json article_types, or '*'
 * @param {Object}  opts
 *   - mode: 'Q100' | 'Q500' (default 'Q100' if only abstract supplied, else 'Q500')
 *   - concurrency: parallel item calls (default 10)
 *   - onProgress: (done, total) => void
 *   - extractor: PaperFateExtractor instance (else one is constructed from env)
 *   - skipRulePrePass: if true, send all items to LLM (default false)
 * @returns {Promise<Object>}
 */
export async function forecastManuscript(manuscript, articleType = '*', opts = {}) {
  const q500 = loadQ500()
  const hasFullText = !!(manuscript.full_text || manuscript.methods || manuscript.results)
  const mode = opts.mode || (hasFullText ? 'Q500' : 'Q100')
  const lvlMax = mode === 'Q500' ? 4 : 1
  const q100Only = mode === 'Q100'

  const items = filterItems(q500.items, {
    lvlMax,
    articleType,
    q100Only,
  })

  // STEP 1 — Rule pre-pass (free, ~ms)
  const { ruleResults, remainingItems } = opts.skipRulePrePass
    ? { ruleResults: {}, remainingItems: items }
    : runRulePrePass(items, manuscript)

  // STEP 2 — LLM scoring on what's left
  const extractor = opts.extractor || createExtractor(opts)
  const startedAt = Date.now()
  const llmScored = await extractor.batchScore(remainingItems, manuscript, articleType, {
    concurrency: opts.concurrency || 10,
    onItem: (_res, idx) => opts.onProgress?.(idx + 1 + Object.keys(ruleResults).length, items.length),
  })
  const elapsedMs = Date.now() - startedAt

  // Merge in original item order
  const llmById = new Map(llmScored.map((s, i) => [remainingItems[i].id, s]))
  const scored = items.map(it => ruleResults[it.id] || llmById.get(it.id))

  const domains = Object.keys(q500.domains)
  const domainRollup = domains.map(d => rollupDomain(scored, d))
  const overall = overallScore(domainRollup)

  const ruleHits = Object.keys(ruleResults).length
  const llmCalls = remainingItems.length
  return {
    mode,
    article_type: articleType,
    items_attempted: items.length,
    items_scored: scored.filter(s => s && !s._error).length,
    overall_score: overall,
    domain_rollup: domainRollup,
    strongest_domains: pickStrongest(domainRollup, 3),
    weakest_domains: pickWeakest(domainRollup, 3),
    key_weaknesses: pickKeyWeaknesses(scored, q500.items, 5),
    items: scored,
    elapsed_ms: elapsedMs,
    pipeline: {
      rule_pre_pass_hits: ruleHits,
      llm_items: llmCalls,
      llm_cost_savings_pct: items.length ? +(ruleHits / items.length * 100).toFixed(1) : 0,
    },
    cost: extractor.costSummary(),
    rubric_version: q500.version,
  }
}

// Exposed for testing
export { loadQ500, rollupDomain, overallScore, pickKeyWeaknesses }
