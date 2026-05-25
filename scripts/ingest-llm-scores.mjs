#!/usr/bin/env node
// PaperFate · LLM scoring 결과 ingest
//
// 사용:
//   node scripts/ingest-llm-scores.mjs --in batch1-response.json
//
// 입력 JSON 구조 (LLM이 반환한 형태):
//   {
//     "scores": [
//       {
//         "doi": "10.xxxx/xxxx",
//         "items": [
//           {"id": "QUEST_001", "score": 4, "evidence": "...", "confidence": 0.85},
//           {"id": "DESIGN_003", "na": true},
//           {"id": "STATS_005", "unknown": true},
//           ...
//         ]
//       },
//       ...
//     ]
//   }
//
// paper_scores 테이블에 upsert. mode defaults to 'llm'.

import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

const ARGS = process.argv.slice(2)
const IN = (() => {
  const a = ARGS.find(x => x.startsWith('--in='))
  if (a) return a.split('=')[1]
  const i = ARGS.indexOf('--in')
  if (i >= 0 && ARGS[i+1]) return ARGS[i+1]
  throw new Error('Usage: --in <response.json>')
})()
const MODE = (() => {
  const a = ARGS.find(x => x.startsWith('--mode='))
  if (a) return a.split('=')[1]
  const i = ARGS.indexOf('--mode')
  if (i >= 0 && ARGS[i+1]) return ARGS[i+1]
  return 'llm'
})()

const data = JSON.parse(readFileSync(IN, 'utf-8'))
if (!Array.isArray(data.scores)) throw new Error('Expected { scores: [...] }')

// Optional: default_na batch — if a paper has `applicable_items` list and an item
// is missing from response, mark as NA. Requires batch JSON to include applicable_items.
const DEFAULT_NA_BATCH = (() => {
  const path = ARGS.find(x => x.startsWith('--applicable='))
  if (!path) return null
  return JSON.parse(readFileSync(path.split('=')[1], 'utf-8'))
})()

const db = new Database(DB_PATH)
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')

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

let paperCount = 0, scoreCount = 0, naCount = 0, unkCount = 0

const writeMany = db.transaction((rows) => {
  for (const r of rows) upsert.run(r)
})

// Build applicable_items lookup if batch JSON provided
const applicableLookup = {}
if (DEFAULT_NA_BATCH && Array.isArray(DEFAULT_NA_BATCH.papers)) {
  for (const p of DEFAULT_NA_BATCH.papers) {
    if (p.doi && p.applicable_items) {
      applicableLookup[p.doi.toLowerCase()] = new Set(p.applicable_items)
    }
  }
}
const allItemIds = DEFAULT_NA_BATCH?.rubric_items?.map(r => r.id) || null

for (const paperEntry of data.scores) {
  const { doi, items } = paperEntry
  if (!doi || !Array.isArray(items)) continue
  paperCount++
  const doiLower = doi.toLowerCase()
  const rows = []
  const seenItemIds = new Set()

  for (const item of items) {
    if (!item.id) continue
    seenItemIds.add(item.id)
    // Support both verbose (score, evidence, na, unknown) and compact (s, e, u, n) formats
    const score = item.score ?? item.s
    const evidence = item.evidence ?? item.e
    const naFlag = item.na ?? item.n
    const unkFlag = item.unknown ?? item.u
    const conf = item.confidence ?? item.c

    let scoreVal = null, raw_value = null
    if (naFlag) {
      raw_value = 'na'; naCount++
    } else if (unkFlag) {
      raw_value = 'unknown'; unkCount++
    } else if (typeof score === 'number') {
      scoreVal = score
      raw_value = String(score)
      scoreCount++
    } else if (typeof score === 'string' && !isNaN(parseInt(score))) {
      scoreVal = parseInt(score)
      raw_value = String(scoreVal)
      scoreCount++
    } else {
      continue
    }
    rows.push({
      doi: doiLower,
      item_id: item.id,
      score: scoreVal,
      raw_value,
      mode: MODE,
      confidence: conf ?? null,
      evidence: (evidence || '').slice(0, 200),
    })
  }

  // Default-NA: items in batch's applicable but missing from response → na
  // Also items not in applicable list → na (auto-N/A for non-applicable types)
  if (allItemIds) {
    const applicable = applicableLookup[doiLower]
    for (const id of allItemIds) {
      if (seenItemIds.has(id)) continue
      const isApplicable = !applicable || applicable.has(id)
      rows.push({
        doi: doiLower,
        item_id: id,
        score: null,
        raw_value: isApplicable ? 'unknown' : 'na',
        mode: MODE,
        confidence: null,
        evidence: isApplicable ? 'omitted from response' : 'auto-NA: item type not applicable',
      })
      if (isApplicable) unkCount++; else naCount++
    }
  }

  if (rows.length) writeMany(rows)
}

console.log('✓ Ingest complete')
console.log(`  papers ingested: ${paperCount}`)
console.log(`  scores written:  ${scoreCount}`)
console.log(`  N/A entries:     ${naCount}`)
console.log(`  unknown entries: ${unkCount}`)

const totalMode = db.prepare(`SELECT COUNT(*) AS n FROM paper_scores WHERE mode=?`).get(MODE).n
console.log(`  total ${MODE} scores in DB: ${totalMode}`)

db.close()
