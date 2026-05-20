// PaperFate · top-level extraction wrapper
// Loads Q500 once, filters by lvl + article type, batches LLM scoring,
// computes 14-domain rollup. Server consumes forecastManuscript()
// from api/forecast.js.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PaperFateExtractor } from './anthropicClient.js'
import { GeminiExtractor } from './geminiClient.js'

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

  const extractor = opts.extractor || createExtractor(opts)
  const startedAt = Date.now()
  const scored = await extractor.batchScore(items, manuscript, articleType, {
    concurrency: opts.concurrency || 10,
    onItem: (_res, idx) => opts.onProgress?.(idx + 1, items.length),
  })
  const elapsedMs = Date.now() - startedAt

  const domains = Object.keys(q500.domains)
  const domainRollup = domains.map(d => rollupDomain(scored, d))
  const overall = overallScore(domainRollup)

  return {
    mode,
    article_type: articleType,
    items_attempted: items.length,
    items_scored: scored.filter(s => !s._error).length,
    overall_score: overall,
    domain_rollup: domainRollup,
    strongest_domains: pickStrongest(domainRollup, 3),
    weakest_domains: pickWeakest(domainRollup, 3),
    key_weaknesses: pickKeyWeaknesses(scored, q500.items, 5),
    items: scored,
    elapsed_ms: elapsedMs,
    cost: extractor.costSummary(),
    rubric_version: q500.version,
  }
}

// Exposed for testing
export { loadQ500, rollupDomain, overallScore, pickKeyWeaknesses }
