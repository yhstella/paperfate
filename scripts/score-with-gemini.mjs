#!/usr/bin/env node
// PaperFate · Gemini Flash 자동 채점
//
// LLM-mode Q100/Q500 items를 Gemini API로 자동 채점. 결과는 paper_scores 테이블에 직접 upsert.
// Free tier: 10 RPM / 1500 RPD / 1M tokens/day → ~150 paper/day (Q100)
// Paid tier: 1000 RPM → ~50,000 paper/day (Q100)
//
// 사용:
//   GEMINI_API_KEY=... node scripts/score-with-gemini.mjs --limit 100
//   node scripts/score-with-gemini.mjs --mode Q100 --resume     # 안 한 paper만
//   node scripts/score-with-gemini.mjs --paid                   # 유료 tier (빠름)
//   node scripts/score-with-gemini.mjs --domain DESIGN --limit 1000
//
// 비용 (paid Flash):
//   Q100 한 paper ≈ $0.001 → 1000 paper $1
//   Q500 한 paper ≈ $0.005 → 1000 paper $5
//   215K paper Q100 → ~$200, Q500 → ~$1000

import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeminiExtractor } from '../src/server/geminiClient.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const RUBRIC_PATH = join(ROOT, 'docs/rubric/Q500.json')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=')[1]
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i+1] && !ARGS[i+1].startsWith('--')) return ARGS[i+1]
  return def
}

const LIMIT = parseInt(arg('limit', '100'))
const MODE = arg('mode', 'Q100')    // Q100 or Q500
const DOMAIN = arg('domain', null)   // optional filter
const RESUME = ARGS.includes('--resume')
const PAID = ARGS.includes('--paid')
const FAILSAFE_DOLLARS = parseFloat(arg('budget', PAID ? '50' : '0'))

// ── 1. Load Q500 rubric, filter to LLM/hybrid items ──
const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'))
const allItems = Array.isArray(rubric.items) ? rubric.items : Object.values(rubric)
let items = allItems
if (MODE === 'Q100') items = items.filter(i => i.Q100)
if (DOMAIN) items = items.filter(i => i.id.startsWith(DOMAIN + '_'))
items = items.filter(i => i.mode === 'llm' || i.mode === 'hybrid')

console.log(`PaperFate · Gemini batch scoring`)
console.log(`Mode: ${MODE}  Domain: ${DOMAIN || 'all'}`)
console.log(`Tier: ${PAID ? 'PAID (1000 RPM)' : 'FREE (10 RPM)'}`)
console.log(`Budget cap: $${FAILSAFE_DOLLARS}`)
console.log(`LLM items to score: ${items.length}`)

// ── 2. Open DB, find papers to score ──
const db = new Database(DB_PATH)
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')

let query = `
  SELECT doi, pmid, title, abstract, publication_types_json, mesh_terms_json, year
  FROM papers
  WHERE abstract IS NOT NULL
`
if (RESUME) {
  query += ` AND NOT EXISTS (
    SELECT 1 FROM paper_scores s WHERE s.doi = papers.doi AND s.mode = 'llm'
  )`
}
query += ` ORDER BY RANDOM() LIMIT ${LIMIT}`

const papers = db.prepare(query).all()
console.log(`Papers to score: ${papers.length}\n`)
if (papers.length === 0) { console.log('Nothing to do.'); process.exit(0) }

// ── 3. Init Gemini client ──
const gemini = new GeminiExtractor({
  rpm: PAID ? 900 : 9,
  isFreeTier: !PAID,
  batchSize: 8,
})

const upsert = db.prepare(`
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

function inferArticleType(paper) {
  const types = paper.publication_types_json ? JSON.parse(paper.publication_types_json) : []
  if (types.some(t => /Randomized Controlled Trial/i.test(t))) return 'RCT'
  if (types.some(t => /Meta-?Analysis/i.test(t))) return 'meta_analysis'
  if (types.some(t => /Systematic Review/i.test(t))) return 'systematic_review'
  if (types.some(t => /Comparative Study|Multicenter Study/i.test(t))) return 'clinical_cohort'
  if (types.some(t => /Case Reports?/i.test(t))) return 'case_report'
  // Heuristics from abstract
  const a = (paper.abstract || '').toLowerCase()
  if (/cohort|follow.?up|prospective/i.test(a)) return 'clinical_cohort'
  if (/case.?control/i.test(a)) return 'case_control'
  if (/diagnostic accuracy|sensitivity.*specificity/i.test(a)) return 'diagnostic_accuracy'
  if (/(prediction|risk) (model|score)|AUROC|c-index/i.test(a)) return 'prediction_model'
  if (/deep learning|neural network|convolutional/i.test(a) && /imag/i.test(a)) return 'ai_imaging'
  return 'clinical_cohort'  // default fallback
}

const t0 = Date.now()
let paperCount = 0, scoreCount = 0, naCount = 0, unkCount = 0, errorCount = 0

for (const paper of papers) {
  paperCount++
  const articleType = inferArticleType(paper)
  const manuscript = {
    title: paper.title || '',
    abstract: paper.abstract || '',
  }

  try {
    const results = await gemini.batchScore(items, manuscript, articleType)
    // results: array of {id, score, applicability, confidence, evidence_text, rationale_short}
    const rows = []
    for (const r of results) {
      if (!r.id) continue
      let score = null, raw_value = null
      if (r.applicability === 'not_applicable' || r.score === 'NA') {
        raw_value = 'na'
        naCount++
      } else if (r.applicability === 'indeterminate' || r.score === 'UNK') {
        raw_value = 'unknown'
        unkCount++
      } else if (!isNaN(parseInt(r.score))) {
        score = parseInt(r.score)
        raw_value = String(score)
        scoreCount++
      } else {
        continue
      }
      rows.push({
        doi: paper.doi,
        item_id: r.id,
        score,
        raw_value,
        mode: 'llm',
        confidence: r.confidence ?? null,
        evidence: (r.evidence_text || r.rationale_short || '').slice(0, 200),
      })
    }
    if (rows.length) {
      db.transaction(() => { for (const row of rows) upsert.run(row) })()
    }
  } catch (e) {
    errorCount++
    console.error(`  paper ${paper.doi} failed: ${e.message}`)
    // Optional: backoff on rate-limit errors
    if (/429|quota/i.test(e.message)) {
      console.error('  → rate limit hit, sleeping 60s')
      await new Promise(r => setTimeout(r, 60000))
    }
  }

  // Progress + cost monitoring every 10 paper
  if (paperCount % 5 === 0 || paperCount === papers.length) {
    const c = gemini.cost
    const totalCost = c.input + c.output
    const elapsed = (Date.now() - t0) / 1000
    const rate = paperCount / elapsed
    const eta = Math.round((papers.length - paperCount) / rate / 60)
    console.log(`  ${paperCount}/${papers.length}  scores=${scoreCount} na=${naCount} unk=${unkCount} err=${errorCount}  $${totalCost.toFixed(3)}  ${rate.toFixed(2)}/s  eta ${eta}m`)
    // Failsafe budget
    if (FAILSAFE_DOLLARS > 0 && totalCost > FAILSAFE_DOLLARS) {
      console.error(`✗ Budget cap $${FAILSAFE_DOLLARS} exceeded — stopping`)
      break
    }
  }
}

const c = gemini.cost
console.log(`\n✓ Done`)
console.log(`  papers processed: ${paperCount}`)
console.log(`  scores: ${scoreCount} | NA: ${naCount} | UNK: ${unkCount} | errors: ${errorCount}`)
console.log(`  Gemini calls: ${c.calls}`)
console.log(`  Tokens: ${(c.input/1e-6).toFixed(0)}M in, ${(c.output/1e-6).toFixed(0)}M out`)
console.log(`  Cost: $${(c.input + c.output).toFixed(4)} (${PAID ? 'paid' : 'free tier'})`)
console.log(`  Elapsed: ${((Date.now() - t0) / 60000).toFixed(1)} min`)

db.close()
