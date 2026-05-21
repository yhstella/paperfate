// Local deterministic Q100 extraction for zero-cost server inference.
//
// This mirrors the Codex batch scorer output into the forecastManuscript()
// rollup schema so /api/forecast can run without Gemini/Anthropic keys.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inferArticleType, scoreItem } from '../../scripts/score-codex-batch-direct.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const Q500_PATH = join(ROOT, 'docs', 'rubric', 'Q500.json')

const DOMAIN_WEIGHTS = {
  QUEST: 0.8, NOVEL: 1.2, RELEV: 1.2, DESIGN: 1.2,
  POPUL: 1.0, EXPOS: 1.0, OUTCM: 1.0, STATS: 1.2,
  BIAS: 1.1, EXTV: 1.2, AIPRED: 1.1, REPRT: 0.7,
  INTERP: 0.8, FIGS: 0.5,
}

let q500Cache = null
function loadQ500() {
  if (!q500Cache) q500Cache = JSON.parse(readFileSync(Q500_PATH, 'utf8'))
  return q500Cache
}

function asExtractItem(out) {
  if (out.na) {
    return {
      id: out.id,
      score: 'NA',
      applicability: 'not_applicable',
      confidence: out.confidence ?? 0.8,
      evidence_text: out.evidence || '',
      rationale_short: 'Not applicable to article type.',
      scoring_mode: 'codex_deterministic',
    }
  }
  if (out.unknown) {
    return {
      id: out.id,
      score: 'UNK',
      applicability: 'applicable',
      confidence: out.confidence ?? 0.5,
      evidence_text: out.evidence || '',
      rationale_short: 'Insufficient evidence in supplied text.',
      scoring_mode: 'codex_deterministic',
    }
  }
  return {
    id: out.id,
    score: out.score,
    applicability: 'applicable',
    confidence: out.confidence ?? 0.75,
    evidence_text: out.evidence || '',
    rationale_short: 'Local deterministic scorer.',
    scoring_mode: 'codex_deterministic',
  }
}

function rollupDomain(items, domain) {
  const inDomain = items.filter(s => s.id.startsWith(domain + '_'))
  const applicable = inDomain.filter(s => s.applicability === 'applicable' && typeof s.score === 'number')
  if (!applicable.length) {
    return {
      domain,
      score: null,
      applicable_count: 0,
      total_count: inDomain.length,
      unk: inDomain.filter(s => s.score === 'UNK').length,
      na: inDomain.filter(s => s.score === 'NA').length,
      weight: DOMAIN_WEIGHTS[domain] ?? 1,
    }
  }
  return {
    domain,
    score: Math.round(applicable.reduce((sum, s) => sum + s.score, 0) / (applicable.length * 5) * 100),
    applicable_count: applicable.length,
    total_count: inDomain.length,
    unk: inDomain.filter(s => s.score === 'UNK').length,
    na: inDomain.filter(s => s.score === 'NA').length,
    weight: DOMAIN_WEIGHTS[domain] ?? 1,
  }
}

function overallScore(domainRollup) {
  const scored = domainRollup.filter(d => d.score !== null)
  if (!scored.length) return null
  const num = scored.reduce((sum, d) => sum + d.score * d.weight, 0)
  const den = scored.reduce((sum, d) => sum + 100 * d.weight, 0)
  return Math.round(num / den * 100)
}

function weakestItems(items, rubricItems, n = 5) {
  const byId = new Map(rubricItems.map(item => [item.id, item]))
  return items
    .filter(s => s.applicability === 'applicable' && typeof s.score === 'number' && s.score <= 2)
    .map(s => ({
      id: s.id,
      name: byId.get(s.id)?.name || s.id,
      domain: s.id.split('_')[0],
      score: s.score,
      gap: (5 - s.score) * (DOMAIN_WEIGHTS[s.id.split('_')[0]] ?? 1),
      rationale: s.rationale_short,
      evidence: s.evidence_text,
    }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, n)
}

export function forecastManuscriptDeterministic(manuscript, articleType = '*', opts = {}) {
  const q500 = loadQ500()
  const q100 = q500.items.filter(item => item.Q100)
  const inferred = inferArticleType({
    title: manuscript.title,
    abstract: manuscript.abstract,
    publication_types: manuscript.publication_types || [],
  })
  const effectiveArticleType = articleType && articleType !== '*' ? articleType : inferred
  const items = q100.map(item => asExtractItem(scoreItem(item, manuscript, effectiveArticleType)))
  const domains = Object.keys(q500.domains).map(domain => rollupDomain(items, domain))
  const overall = overallScore(domains)
  const scored = domains.filter(d => d.score !== null)

  return {
    mode: 'Q100',
    article_type: effectiveArticleType,
    items_attempted: q100.length,
    items_scored: items.filter(s => typeof s.score === 'number').length,
    overall_score: overall,
    domain_rollup: domains,
    strongest_domains: [...scored].sort((a, b) => b.score - a.score).slice(0, 3).map(d => ({ domain: d.domain, score: d.score })),
    weakest_domains: [...scored].sort((a, b) => a.score - b.score).slice(0, 3).map(d => ({ domain: d.domain, score: d.score })),
    key_weaknesses: weakestItems(items, q100),
    items,
    elapsed_ms: 0,
    pipeline: {
      rule_pre_pass_hits: q100.length,
      llm_items: 0,
      llm_cost_savings_pct: 100,
      deterministic: true,
      requested_mode: opts.mode || 'Q100',
    },
    cost: { total_usd: 0 },
    rubric_version: q500.version,
  }
}
