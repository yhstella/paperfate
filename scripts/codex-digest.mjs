#!/usr/bin/env node
// Read-only digest for Codex Round 7 progress.
//
// Summarises whether the Codex Round 7 deliverables (Q500 LLM rescoring
// + FateCore v0.5 training) have advanced. Inspects:
//   - DATA_ROOT/_q500_fulltext_round7.log  (tail)
//   - DATA_ROOT/_q500_fulltext_round7.jsonl  (row count, q_mean per tier)
//   - paper_scores grouped by mode in paperfate.db
//   - docs/CODEX_HANDOFF_2026-05-28_ROUND7_TASK*.md presence + mtime
//   - weights/fatecore-v0.5-* presence + mtime + size
//   - docs/EVAL_v0.5.md presence + mtime
//   - scripts/build-fatecore-features-v0.5.mjs presence
//   - scripts/train-fatecore-v0.5.py presence
//
// Pure read-only: better-sqlite3 is opened readonly with query_only=ON, and
// no files outside this script are written.
//
// Usage:
//   DATA_ROOT=E:/paperfate/data node scripts/codex-digest.mjs
//   DATA_ROOT=E:/paperfate/data node scripts/codex-digest.mjs --json
//   DATA_ROOT=E:/paperfate/data node scripts/codex-digest.mjs --tail 40

import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

const ARGV = process.argv.slice(2)
const ARG_SET = new Set(ARGV)
const JSON_OUT = ARG_SET.has('--json')
function argValue(name, fallback) {
  const idx = ARGV.indexOf(name)
  if (idx === -1 || idx === ARGV.length - 1) return fallback
  return ARGV[idx + 1]
}
const TAIL_LINES = Number(argValue('--tail', 20)) || 20

function safe(fn, fallback = null) {
  try { return fn() } catch { return fallback }
}

function mb(bytes) {
  return +(bytes / 1024 / 1024).toFixed(2)
}

function ageHours(date) {
  if (!date) return null
  const ms = Date.now() - new Date(date).getTime()
  if (!Number.isFinite(ms)) return null
  return +(ms / 1000 / 60 / 60).toFixed(2)
}

function statInfo(path) {
  if (!existsSync(path)) return { path, present: false }
  const st = safe(() => statSync(path), null)
  if (!st) return { path, present: false }
  return {
    path,
    present: true,
    size_bytes: st.size,
    size_mb: mb(st.size),
    mtime: st.mtime.toISOString(),
    age_hours: ageHours(st.mtime),
  }
}

function tailLines(path, n) {
  if (!existsSync(path)) return []
  const text = safe(() => readFileSync(path, 'utf8'), '')
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n)
}

function summariseRound7Jsonl(path) {
  if (!existsSync(path)) {
    return { present: false, rows: 0, tiers: {}, last_row: null }
  }
  const text = safe(() => readFileSync(path, 'utf8'), '')
  if (!text) {
    return { present: true, rows: 0, tiers: {}, last_row: null }
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(Boolean)
  const tiers = new Map()
  let last = null
  for (const line of lines) {
    const obj = safe(() => JSON.parse(line), null)
    if (!obj) continue
    last = obj
    const tier = obj.tier ?? obj.q_tier ?? obj.quartile ?? obj.bucket ?? 'unknown'
    const qMean = Number(
      obj.q_mean ?? obj.qMean ?? obj.q ?? obj.score_mean ?? obj.mean_q ?? NaN,
    )
    if (!tiers.has(tier)) tiers.set(tier, { count: 0, q_sum: 0, q_n: 0 })
    const bucket = tiers.get(tier)
    bucket.count += 1
    if (Number.isFinite(qMean)) {
      bucket.q_sum += qMean
      bucket.q_n += 1
    }
  }
  const tierSummary = {}
  for (const [tier, bucket] of tiers) {
    tierSummary[tier] = {
      rows: bucket.count,
      q_mean: bucket.q_n ? +(bucket.q_sum / bucket.q_n).toFixed(4) : null,
      q_samples: bucket.q_n,
    }
  }
  return {
    present: true,
    rows: lines.length,
    tiers: tierSummary,
    last_row: last,
  }
}

function listMatching(dir, predicate) {
  if (!existsSync(dir)) return []
  return safe(() => readdirSync(dir), [])
    .filter(predicate)
    .map(name => {
      const path = join(dir, name)
      const st = safe(() => statSync(path), null)
      return st
        ? {
            name,
            path,
            size_bytes: st.size,
            size_mb: mb(st.size),
            mtime: st.mtime.toISOString(),
            age_hours: ageHours(st.mtime),
          }
        : { name, path, present: false }
    })
    .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))
}

const digest = {
  generated_at: new Date().toISOString(),
  data_root: DATA_ROOT,
  db_path: DB_PATH,
  db_present: existsSync(DB_PATH),
  artefacts: {},
  round7_jsonl: null,
  round7_log_tail: [],
  score_modes: [],
  handoff_docs: [],
  weights_v05: [],
}

// 1. Q500 round 7 log + jsonl
const round7Log = join(DATA_ROOT, '_q500_fulltext_round7.log')
const round7Jsonl = join(DATA_ROOT, '_q500_fulltext_round7.jsonl')
digest.artefacts.round7_log = statInfo(round7Log)
digest.artefacts.round7_jsonl = statInfo(round7Jsonl)
digest.round7_log_tail = tailLines(round7Log, TAIL_LINES)
digest.round7_jsonl = summariseRound7Jsonl(round7Jsonl)

// 2. Codex handoff docs (Round 7)
const docsDir = join(ROOT, 'docs')
digest.handoff_docs = listMatching(
  docsDir,
  name => /^CODEX_HANDOFF_2026-05-28_ROUND7_TASK.*\.md$/i.test(name),
)
digest.artefacts.eval_v05_md = statInfo(join(docsDir, 'EVAL_v0.5.md'))

// 3. Weights
const weightsDir = join(ROOT, 'weights')
digest.weights_v05 = listMatching(
  weightsDir,
  name => /^fatecore-v0\.5-/i.test(name),
)

// 4. Build/train scripts
const scriptsDir = join(ROOT, 'scripts')
digest.artefacts.build_features_v05 = statInfo(
  join(scriptsDir, 'build-fatecore-features-v0.5.mjs'),
)
digest.artefacts.train_v05 = statInfo(
  join(scriptsDir, 'train-fatecore-v0.5.py'),
)

// 5. DB paper_scores by mode
if (digest.db_present) {
  const db = safe(
    () => new Database(DB_PATH, { readonly: true, fileMustExist: true }),
    null,
  )
  if (db) {
    safe(() => db.pragma('query_only = ON'))
    digest.score_modes = safe(
      () =>
        db
          .prepare(
            `SELECT mode, COUNT(*) AS rows, COUNT(DISTINCT item_id) AS items
             FROM paper_scores
             WHERE mode IN ('Q500-fulltext', 'codex_deterministic', 'llm', 'external', 'rule')
             GROUP BY mode
             ORDER BY rows DESC`,
          )
          .all(),
      [],
    )
    safe(() => db.close())
  }
}

// 6. Verdict heuristic
function findMode(name) {
  return digest.score_modes.find(m => m.mode === name) || { rows: 0, items: 0 }
}
const q500Mode = findMode('Q500-fulltext')
const lgbWeights = digest.weights_v05.filter(w => /\.(lgb|txt|bin|model|joblib)$/i.test(w.name))
const evalV05 = digest.artefacts.eval_v05_md?.present
const jsonlRows = digest.round7_jsonl?.rows || 0

let verdict = 'NOT STARTED'
const verdictReasons = []
if (q500Mode.rows > 1000 || jsonlRows > 1000) {
  verdict = 'IN PROGRESS'
  verdictReasons.push(
    `paper_scores Q500-fulltext rows=${q500Mode.rows}, round7 jsonl rows=${jsonlRows}`,
  )
}
if (lgbWeights.length > 0 && evalV05) {
  verdict = 'COMPLETE'
  verdictReasons.push(
    `weights/fatecore-v0.5-* model artefacts present (${lgbWeights.length}) and docs/EVAL_v0.5.md present`,
  )
} else if (lgbWeights.length > 0) {
  verdict = 'IN PROGRESS'
  verdictReasons.push(
    `weights/fatecore-v0.5-* model artefacts present (${lgbWeights.length}) but no docs/EVAL_v0.5.md yet`,
  )
}
if (verdict === 'NOT STARTED') {
  if (
    digest.artefacts.round7_log.present ||
    digest.artefacts.round7_jsonl.present ||
    digest.handoff_docs.length > 0
  ) {
    verdict = 'IN PROGRESS'
    verdictReasons.push('round7 artefacts or handoff docs present but below progress threshold')
  }
}
digest.verdict = verdict
digest.verdict_reasons = verdictReasons

if (JSON_OUT) {
  console.log(JSON.stringify(digest, null, 2))
} else {
  const fmt = info => {
    if (!info) return 'n/a'
    if (!info.present) return 'MISSING'
    const size = info.size_mb != null ? `${info.size_mb} MB` : ''
    const mtime = info.mtime ? `mtime=${info.mtime}` : ''
    const age = info.age_hours != null ? `age=${info.age_hours}h` : ''
    return [size, mtime, age].filter(Boolean).join('  ')
  }
  console.log(`Codex Round 7 digest @ ${digest.generated_at}`)
  console.log(`DATA_ROOT: ${digest.data_root}`)
  console.log(`DB:        ${digest.db_path} (${digest.db_present ? 'present' : 'MISSING'})`)
  console.log('')
  console.log('Artefacts')
  console.log(`  Q500 round7 log:      ${fmt(digest.artefacts.round7_log)}`)
  console.log(`  Q500 round7 jsonl:    ${fmt(digest.artefacts.round7_jsonl)}`)
  console.log(`  build features v0.5:  ${fmt(digest.artefacts.build_features_v05)}`)
  console.log(`  train v0.5:           ${fmt(digest.artefacts.train_v05)}`)
  console.log(`  EVAL_v0.5.md:         ${fmt(digest.artefacts.eval_v05_md)}`)
  console.log('')
  console.log(`Round 7 handoff docs (${digest.handoff_docs.length})`)
  if (!digest.handoff_docs.length) {
    console.log('  none')
  } else {
    for (const doc of digest.handoff_docs) {
      console.log(`  ${doc.name}  mtime=${doc.mtime}  age=${doc.age_hours}h`)
    }
  }
  console.log('')
  console.log(`weights/fatecore-v0.5-* (${digest.weights_v05.length})`)
  if (!digest.weights_v05.length) {
    console.log('  none')
  } else {
    for (const w of digest.weights_v05) {
      console.log(`  ${w.name}  ${w.size_mb} MB  mtime=${w.mtime}  age=${w.age_hours}h`)
    }
  }
  console.log('')
  console.log('paper_scores by mode')
  if (!digest.score_modes.length) {
    console.log('  none (or DB missing)')
  } else {
    for (const m of digest.score_modes) {
      console.log(`  ${m.mode}: ${m.rows} rows, ${m.items} items`)
    }
  }
  console.log('')
  console.log(`Round 7 jsonl summary (rows=${digest.round7_jsonl?.rows ?? 0})`)
  const tiers = digest.round7_jsonl?.tiers || {}
  const tierKeys = Object.keys(tiers)
  if (!tierKeys.length) {
    console.log('  no rows / no tier field')
  } else {
    for (const tier of tierKeys) {
      const t = tiers[tier]
      console.log(
        `  tier=${tier}: ${t.rows} rows, q_mean=${t.q_mean ?? 'n/a'} (n=${t.q_samples})`,
      )
    }
  }
  console.log('')
  console.log(`Round 7 log tail (last ${TAIL_LINES} lines)`)
  if (!digest.round7_log_tail.length) {
    console.log('  log missing or empty')
  } else {
    for (const line of digest.round7_log_tail) console.log(`  ${line}`)
  }
  console.log('')
  console.log(`Codex Round 7 status: ${digest.verdict}`)
  for (const reason of digest.verdict_reasons) console.log(`  reason: ${reason}`)
}
