#!/usr/bin/env node
// Smoke test for FateCore server-side inference.
//
// This does not call external LLM APIs. It scores a sample abstract with the
// local deterministic Q100 scorer, builds the FateCore feature vector, and
// runs LightGBM weights if present. If weights are not present yet, it exercises
// the heuristic fallback with the same response schema.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inferArticleType, scoreItem } from './score-codex-batch-direct.mjs'
import { loadFateCore, predictFromExtraction } from '../src/server/fatecoreInference.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const Q500_PATH = join(ROOT, 'docs', 'rubric', 'Q500.json')

const SAMPLE = {
  title: 'External validation of a machine-learning model for early detection of sepsis in emergency department patients',
  abstract: `Background: Early recognition of sepsis remains challenging in emergency departments.
Objective: To externally validate a machine-learning risk model for sepsis onset within 24 hours.
Methods: We performed a retrospective multicenter cohort study of 18,420 adult emergency department visits
from four hospitals between 2021 and 2024. Model discrimination, calibration, and clinical utility were
assessed using AUROC, calibration plots, and decision-curve analysis.
Results: The model achieved an AUROC of 0.87 (95% CI 0.85 to 0.89), with good calibration after intercept
updating. At a fixed sensitivity of 90%, specificity was 62%.
Conclusions: The externally validated model may support earlier sepsis recognition, although prospective
impact evaluation is warranted before deployment.`,
  authors: ['A. Kim', 'B. Lee', 'C. Park', 'D. Smith'],
  year: new Date().getFullYear(),
}

const DOMAIN_WEIGHTS = {
  QUEST: 0.8, NOVEL: 1.2, RELEV: 1.2, DESIGN: 1.2,
  POPUL: 1.0, EXPOS: 1.0, OUTCM: 1.0, STATS: 1.2,
  BIAS: 1.1, EXTV: 1.2, AIPRED: 1.1, REPRT: 0.7,
  INTERP: 0.8, FIGS: 0.5,
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
      rationale_short: 'Insufficient evidence in abstract.',
      scoring_mode: 'codex_deterministic',
    }
  }
  return {
    id: out.id,
    score: out.score,
    applicability: 'applicable',
    confidence: out.confidence ?? 0.75,
    evidence_text: out.evidence || '',
    rationale_short: 'Deterministic abstract scorer.',
    scoring_mode: 'codex_deterministic',
  }
}

function rollupDomain(items, domain) {
  const inDomain = items.filter(s => s.id.startsWith(domain + '_'))
  const applicable = inDomain.filter(s => s.applicability === 'applicable' && typeof s.score === 'number')
  if (!applicable.length) return { domain, score: null, applicable_count: 0, total_count: inDomain.length, weight: DOMAIN_WEIGHTS[domain] ?? 1 }
  const score = Math.round(applicable.reduce((sum, s) => sum + s.score, 0) / (applicable.length * 5) * 100)
  return {
    domain,
    score,
    applicable_count: applicable.length,
    total_count: inDomain.length,
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

function weakestItems(items, q100, n = 5) {
  const byId = new Map(q100.map(item => [item.id, item]))
  return items
    .filter(s => s.applicability === 'applicable' && typeof s.score === 'number' && s.score <= 2)
    .map(s => ({
      id: s.id,
      name: byId.get(s.id)?.name || s.id,
      domain: s.id.split('_')[0],
      score: s.score,
      evidence: s.evidence_text,
    }))
    .slice(0, n)
}

function deterministicExtraction(manuscript) {
  const q500 = JSON.parse(readFileSync(Q500_PATH, 'utf8'))
  const q100 = q500.items.filter(item => item.Q100)
  const articleType = inferArticleType({
    title: manuscript.title,
    abstract: manuscript.abstract,
    publication_types: [],
  })
  const items = q100.map(item => asExtractItem(scoreItem(item, manuscript, articleType)))
  const domains = Object.keys(q500.domains).map(domain => rollupDomain(items, domain))
  return {
    mode: 'Q100',
    article_type: articleType,
    items_attempted: q100.length,
    items_scored: items.filter(s => typeof s.score === 'number').length,
    overall_score: overallScore(domains),
    domain_rollup: domains,
    key_weaknesses: weakestItems(items, q100),
    items,
    cost: { total_usd: 0 },
    rubric_version: q500.version,
  }
}

const extraction = deterministicExtraction(SAMPLE)
const model = loadFateCore()
const forecast = predictFromExtraction(SAMPLE, extraction, {
  model,
  targetJournal: {
    name: 'Journal of Medical Internet Research',
    h_index: 180,
    i10_index: 500,
    two_yr_mean_citedness: 4.2,
    jcr_jif_5yr: 7.9,
    jci: 1.5,
    is_oa: 1,
    is_in_doaj: 1,
  },
})

console.log(JSON.stringify({
  sample: {
    title: SAMPLE.title,
    article_type: extraction.article_type,
    overall_score: extraction.overall_score,
  },
  ...forecast,
}, null, 2))
