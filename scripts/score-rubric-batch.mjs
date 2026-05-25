#!/usr/bin/env node
// PaperFate · Batch Q500 scoring (rule + external mode only — no LLM)
//
// 목적: 학습 데이터셋의 X-y 쌍을 위해 모든 코퍼스 paper에 대해 미리 채점.
// 단, LLM 호출은 안 함 (비용 ~$1000-3000) — rule + external mode만.
//
// 채점 방식:
//   - external: DB 컬럼에서 직접 매핑 (citation count, OA, has_data_avail 등)
//   - rule:     src/server/ruleExtractors.js 호출 (regex 기반)
//   - hybrid:   rule 시도, fail이면 mark as "needs_llm"
//   - llm:      skip (per-request 시점에 채점)
//
// 출력: paperfate.db paper_scores 테이블에 upsert
//
// 사용:
//   node scripts/score-rubric-batch.mjs                # 전체 paper
//   node scripts/score-rubric-batch.mjs --limit 1000   # 1000개만 (테스트)
//   node scripts/score-rubric-batch.mjs --resume       # 이미 채점된 paper skip

import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractSampleSize, extractAUC, extractCIPresence, extractPValueExact,
  extractRegistry, extractAgreement, extractFollowUp, extractMulticenter,
  extractGuidelineMention, extractSoftware, extractEthics,
  extractExternalValidation, extractDCA, extractFunding,
  extractCRediT, extractPreregistration,
} from '../src/server/ruleExtractors.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const RUBRIC_PATH = join(ROOT, 'docs/rubric/Q500.json')

const ARGS = process.argv.slice(2)
const LIMIT = (() => {
  const arg = ARGS.find(a => a.startsWith('--limit='))
  return arg ? parseInt(arg.split('=')[1]) : null
})()
const RESUME = ARGS.includes('--resume')

// ───────────────────────────────────────────────────────────────────────────
// External mappings: paper row → Q500 item score
//
// Each mapper takes (paperRow, ctTrials) → { score, raw_value, confidence, evidence } | null
// score is 0..5 (Q500 rubric scale: 0=worst, 5=best)
// ───────────────────────────────────────────────────────────────────────────

function scoreFromCitations(paper) {
  // Citation count → 0..5 score (log scale)
  const c = paper.icite_citation_count ?? paper.citations_openalex ?? paper.citations_s2
  if (c == null) return null
  // Anchor: 0=0 cites, 1=1-5, 2=6-20, 3=21-50, 4=51-200, 5=200+
  let score
  if (c === 0) score = 0
  else if (c <= 5) score = 1
  else if (c <= 20) score = 2
  else if (c <= 50) score = 3
  else if (c <= 200) score = 4
  else score = 5
  return { score, raw_value: String(c), confidence: 0.95, evidence: `citation_count=${c}` }
}

function scoreFromRCR(paper) {
  const rcr = paper.icite_rcr
  if (rcr == null) return null
  // RCR: 1.0 = NIH median. 0 = no/below-median, 5 = top 1%
  let score
  if (rcr < 0.5) score = 0
  else if (rcr < 1.0) score = 1
  else if (rcr < 2.0) score = 2
  else if (rcr < 4.0) score = 3
  else if (rcr < 10.0) score = 4
  else score = 5
  return { score, raw_value: String(rcr), confidence: 0.9, evidence: `RCR=${rcr.toFixed(2)}` }
}

function scoreFromOAStatus(paper) {
  const oa = paper.unpaywall_is_oa
  const status = paper.unpaywall_oa_status
  if (oa == null) return null
  let score = oa === 1 ? 4 : 1
  if (status === 'gold' || status === 'hybrid') score = 5
  return { score, raw_value: status || (oa ? 'oa' : 'closed'), confidence: 0.95, evidence: `oa=${oa}, status=${status}` }
}

function scoreFromDataAvail(paper) {
  if (paper.pmc_has_data_avail == null) return null
  return {
    score: paper.pmc_has_data_avail ? 5 : 0,
    raw_value: paper.pmc_has_data_avail ? 'present' : 'absent',
    confidence: 0.9,
    evidence: `PMC fulltext data availability section: ${paper.pmc_has_data_avail ? 'yes' : 'no'}`,
  }
}

function scoreFromEthics(paper) {
  if (paper.pmc_has_ethics == null) return null
  return {
    score: paper.pmc_has_ethics ? 5 : 0,
    raw_value: paper.pmc_has_ethics ? 'present' : 'absent',
    confidence: 0.9,
    evidence: `PMC fulltext ethics section: ${paper.pmc_has_ethics ? 'yes' : 'no'}`,
  }
}

function scoreFromCOI(paper) {
  if (paper.pmc_has_coi == null) return null
  return {
    score: paper.pmc_has_coi ? 5 : 0,
    raw_value: paper.pmc_has_coi ? 'present' : 'absent',
    confidence: 0.9,
    evidence: `PMC fulltext COI statement: ${paper.pmc_has_coi ? 'yes' : 'no'}`,
  }
}

function scoreFromRCT(paper) {
  if (!paper.publication_types_json) return null
  const types = JSON.parse(paper.publication_types_json || '[]')
  const isRCT = types.some(t => /randomized controlled trial/i.test(t))
  return {
    score: isRCT ? 5 : 0,
    raw_value: isRCT ? 'RCT' : 'non-RCT',
    confidence: 0.95,
    evidence: `publication_types: ${types.join(', ')}`,
  }
}

function scoreFromMetaAnalysis(paper) {
  if (!paper.publication_types_json) return null
  const types = JSON.parse(paper.publication_types_json || '[]')
  const isMA = types.some(t => /meta-?analysis|systematic review/i.test(t))
  return {
    score: isMA ? 5 : 0,
    raw_value: isMA ? 'meta-analysis' : 'other',
    confidence: 0.95,
    evidence: `publication_types: ${types.join(', ')}`,
  }
}

function scoreFromFunding(paper) {
  if (!paper.funder_json) return null
  const funders = JSON.parse(paper.funder_json || '[]')
  return {
    score: funders.length > 0 ? 5 : 0,
    raw_value: funders.length > 0 ? `${funders.length} funder(s)` : 'no funding listed',
    confidence: 0.9,
    evidence: funders.slice(0, 2).map(f => f.name || f.DOI).join('; '),
  }
}

function scoreFromAuthorCount(paper) {
  if (!paper.authors_json) return null
  const authors = JSON.parse(paper.authors_json || '[]')
  // 0=1, 1=2-3, 2=4-6, 3=7-15, 4=16-50, 5=>50
  const n = authors.length
  let score
  if (n <= 1) score = 0
  else if (n <= 3) score = 1
  else if (n <= 6) score = 2
  else if (n <= 15) score = 3
  else if (n <= 50) score = 4
  else score = 5
  return { score, raw_value: String(n), confidence: 0.95, evidence: `${n} authors` }
}

function scoreFromReferences(paper) {
  const refs = paper.reference_count ?? paper.pmc_ref_count
  if (refs == null) return null
  // 0=<10, 1=10-19, 2=20-39, 3=40-69, 4=70-100, 5=>100
  let score
  if (refs < 10) score = 0
  else if (refs < 20) score = 1
  else if (refs < 40) score = 2
  else if (refs < 70) score = 3
  else if (refs < 100) score = 4
  else score = 5
  return { score, raw_value: String(refs), confidence: 0.9, evidence: `${refs} references` }
}

// Q500 item ID → external scorer mapping
// Hand-curated against actual Q500.json IDs (2026-05-21).
const EXTERNAL_SCORERS = {
  // Design type (publication_types_json)
  'DESIGN_001': scoreFromRCT,            // "Design type stated"
  'DESIGN_002': scoreFromMetaAnalysis,   // "Meta-analysis appropriate"
  // Sample size (CT.gov enrollment) — also covered by rule extractor below
  // Citation / impact
  'RELEV_011':  scoreFromCitations,      // existing 'external' mode
  'RELEV_022':  scoreFromCitations,
  'OUTCM_036':  scoreFromCitations,
  'QUEST_022':  scoreFromCitations,
  // OA / accessibility (Unpaywall)
  'REPRT_022':  scoreFromOAStatus,
  // Reporting (PMC fulltext)
  'REPRT_018':  scoreFromDataAvail,      // Data availability
  'REPRT_019':  scoreFromDataAvail,
  'REPRT_015':  scoreFromEthics,         // Ethics approval (matched by search above)
  'BIAS_034':   scoreFromCOI,            // Author COI disclosed
  // Funding from Crossref
  'BIAS_033':   scoreFromFunding,        // Industry funding disclosed (proxy)
  // Reference count (S2 or PMC)
  'REPRT_030':  scoreFromReferences,
}

// Rule extractors → Q500 item mapping
// Each entry: itemId → { extractor, valueToScore(value) }
function sampleSizeToScore(n) {
  if (n < 30) return 0
  if (n < 100) return 1
  if (n < 500) return 2
  if (n < 2000) return 3
  if (n < 10000) return 4
  return 5
}

const RULE_SCORERS = {
  // Sample size
  'DESIGN_005': { fn: extractSampleSize,  toScore: r => sampleSizeToScore(r.value) },  // "Sample size pre-specified"
  'DESIGN_032': { fn: extractSampleSize,  toScore: r => sampleSizeToScore(r.value) },  // "Sample size calc reproducible"
  // AUROC / discrimination
  'AIPRED_015': { fn: extractAUC,         toScore: r => {
    const v = r.value
    if (v < 0.6) return 0
    if (v < 0.7) return 1
    if (v < 0.8) return 2
    if (v < 0.85) return 3
    if (v < 0.9) return 4
    return 5
  }},
  'EXTV_008':   { fn: extractAUC,         toScore: r => {
    const v = r.value
    if (v < 0.6) return 0
    if (v < 0.7) return 1
    if (v < 0.8) return 2
    if (v < 0.85) return 3
    if (v < 0.9) return 4
    return 5
  }},
  // Effect size with p-value
  'STATS_005':  { fn: extractPValueExact, toScore: r => r.value != null ? 5 : 0 },
  'OUTCM_037':  { fn: extractPValueExact, toScore: r => r.value != null ? 5 : 0 },
  // CIs reported
  'OUTCM_038':  { fn: extractCIPresence,  toScore: r => r.value ? 5 : 0 },
  // Trial registration
  'DESIGN_003': { fn: extractRegistry,    toScore: r => r.value ? 5 : 0 },  // "Pre-registered"
  'REPRT_004':  { fn: extractRegistry,    toScore: r => r.value ? 5 : 0 },  // "Pre-registration ID"
  // Multi-center
  'DESIGN_011': { fn: extractMulticenter, toScore: r => r.value ? 5 : 0 },
  'DESIGN_012': { fn: extractMulticenter, toScore: r => r.value ? 5 : 0 },
  // Follow-up duration
  'DESIGN_017': { fn: extractFollowUp,    toScore: r => {
    const days = r.value
    if (days < 30) return 1
    if (days < 365) return 3
    return 5
  }},
  // Reporting guideline mention
  'REPRT_001':  { fn: extractGuidelineMention, toScore: r => r.value ? 5 : 0 },
  'REPRT_002':  { fn: extractGuidelineMention, toScore: r => r.value ? 5 : 0 },
  // Software / code disclosure
  'REPRT_021':  { fn: extractSoftware,    toScore: r => r.value ? 4 : 0 },
  // Ethics (rule-fallback for non-PMC papers)
  'REPRT_015':  { fn: extractEthics,      toScore: r => r.value ? 5 : 0 },
  // External validation
  'EXTV_001':   { fn: extractExternalValidation, toScore: r => r.value ? 5 : 0 },
  // Decision curve analysis
  'AIPRED_030': { fn: extractDCA,         toScore: r => r.value ? 5 : 0 },
  // Funding mentioned in text
  'BIAS_033':   { fn: extractFunding,     toScore: r => r.value ? 5 : 0 },
  // CRediT contributorship
  'REPRT_023':  { fn: extractCRediT,      toScore: r => r.value ? 5 : 0 },
  // Inter-rater agreement
  'STATS_032':  { fn: extractAgreement,   toScore: r => {
    const v = r.value
    if (v < 0.4) return 1
    if (v < 0.6) return 2
    if (v < 0.8) return 3
    return 5
  }},
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

function main() {
  console.log('PaperFate · batch Q500 scoring (rule + external)')
  console.log('DB:', DB_PATH)

  const db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')

  const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'))
  const items = Array.isArray(rubric.items) ? rubric.items : Object.values(rubric)
  console.log('Q500 items:', items.length)

  // Find scorable items
  const externalItems = items.filter(i => EXTERNAL_SCORERS[i.id])
  const ruleItems = items.filter(i => RULE_SCORERS[i.id])
  console.log(`Scorable now (no LLM): ${externalItems.length + ruleItems.length} items`)
  console.log(`  external: ${externalItems.length}`)
  console.log(`  rule:     ${ruleItems.length}`)
  console.log(`Remaining (need LLM): ${items.length - externalItems.length - ruleItems.length}`)

  // Count target papers
  // Use streaming (iterate) — 215K papers × ~5 KB each would OOM with .all()
  let countQuery = `SELECT COUNT(*) AS n FROM papers`
  let query = `SELECT doi, title, abstract, publication_types_json, authors_json, funder_json, reference_count,
                       icite_citation_count, icite_rcr, citations_openalex, citations_s2,
                       unpaywall_is_oa, unpaywall_oa_status,
                       pmc_has_data_avail, pmc_has_ethics, pmc_has_coi, pmc_ref_count
               FROM papers`
  if (RESUME) {
    countQuery = `SELECT COUNT(*) AS n FROM papers p WHERE NOT EXISTS (SELECT 1 FROM paper_scores s WHERE s.doi = p.doi AND s.mode IN ('rule','external'))`
    query = query + ` p WHERE NOT EXISTS (SELECT 1 FROM paper_scores s WHERE s.doi = p.doi AND s.mode IN ('rule','external'))`
  }
  if (LIMIT) query += ` LIMIT ${LIMIT}`
  const totalCount = db.prepare(countQuery).get().n
  console.log(`Papers to score: ${LIMIT ? Math.min(LIMIT, totalCount) : totalCount}\n`)

  const upsertScore = db.prepare(`
    INSERT INTO paper_scores (doi, item_id, score, raw_value, mode, confidence, evidence, scored_at)
    VALUES (@doi, @item_id, @score, @raw_value, @mode, @confidence, @evidence, datetime('now'))
    ON CONFLICT(doi, item_id, mode) DO UPDATE SET
      score = excluded.score,
      raw_value = excluded.raw_value,
      mode = excluded.mode,
      confidence = excluded.confidence,
      evidence = excluded.evidence,
      scored_at = excluded.scored_at
  `)

  let paperCount = 0
  let scoreCount = 0
  const t0 = Date.now()

  const writeMany = db.transaction((rows) => {
    for (const r of rows) upsertScore.run(r)
  })

  // Page-based batch processing — better-sqlite3 doesn't allow concurrent
  // read+write on one connection, so we fetch a page, write its scores, repeat.
  const PAGE_SIZE = 1000
  let offset = 0
  const pagedQuery = LIMIT
    ? `${query.replace(/ LIMIT \d+$/, '')} LIMIT ${PAGE_SIZE} OFFSET ?`
    : `${query} LIMIT ${PAGE_SIZE} OFFSET ?`
  const fetchPage = db.prepare(pagedQuery)
  const hardCap = LIMIT || Infinity

  while (paperCount < hardCap) {
    const pageLimit = Math.min(PAGE_SIZE, hardCap - paperCount)
    const papers = fetchPage.all(offset)
    if (papers.length === 0) break

    const pageRows = []
    for (const paper of papers) {
      paperCount++
      const m = { title: paper.title || '', abstract: paper.abstract || '' }

      // External-mode scoring
      for (const item of externalItems) {
        const scorer = EXTERNAL_SCORERS[item.id]
        const result = scorer(paper)
        if (result == null) continue
        pageRows.push({
          doi: paper.doi,
          item_id: item.id,
          score: result.score,
          raw_value: result.raw_value,
          mode: 'external',
          confidence: result.confidence,
          evidence: (result.evidence || '').slice(0, 200),
        })
      }

      // Rule-mode scoring
      for (const item of ruleItems) {
        const { fn, toScore } = RULE_SCORERS[item.id]
        const result = fn(m)
        if (result == null) continue
        const score = toScore(result)
        pageRows.push({
          doi: paper.doi,
          item_id: item.id,
          score,
          raw_value: JSON.stringify(result.value),
          mode: 'rule',
          confidence: result.confidence ?? 0.7,
          evidence: (result.evidence_text || '').slice(0, 200),
        })
      }

      if (paperCount >= hardCap) break
    }

    if (pageRows.length) {
      writeMany(pageRows)
      scoreCount += pageRows.length
    }

    offset += papers.length
    const rate = (paperCount / ((Date.now() - t0) / 1000)).toFixed(0)
    const eta = Math.round((Math.min(totalCount, hardCap) - paperCount) / Number(rate || 1) / 60)
    console.log(`  ${paperCount}/${Math.min(totalCount, hardCap)}  scores=${scoreCount}  ${rate}/s  eta ${eta}m`)

    if (papers.length < PAGE_SIZE) break  // last page
  }

  console.log(`\n✓ Done`)
  console.log(`  papers scored: ${paperCount}`)
  console.log(`  total scores:  ${scoreCount}`)
  console.log(`  avg scores/paper: ${(scoreCount/paperCount).toFixed(1)}`)
  console.log(`  elapsed: ${((Date.now()-t0)/1000).toFixed(1)}s`)

  // Per-item summary
  const itemStats = db.prepare(`
    SELECT item_id, mode, COUNT(*) AS n, ROUND(AVG(score),2) AS avg_score
    FROM paper_scores
    GROUP BY item_id, mode
    ORDER BY n DESC
  `).all()
  console.log(`\nPer-item coverage:`)
  for (const r of itemStats) {
    console.log(`  ${r.item_id.padEnd(15)} ${r.mode.padEnd(10)} n=${String(r.n).padStart(7)}  avg=${r.avg_score}`)
  }

  db.close()
}

main()
