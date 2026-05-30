#!/usr/bin/env node
// PaperFate extras corpus status.
//
// Read-only snapshot of `paper_extras_v2` coverage against `papers`. Used to
// monitor how far the extras feature build has progressed without poking the
// live builder process.
//
// Usage:
//   node scripts/extras-corpus-status.mjs
//
// Env:
//   DATA_ROOT   defaults to <repo>/data
//
// Behaviour:
//   - Opens paperfate.db readonly with busy_timeout=60000.
//   - Reports total papers, total paper_extras_v2 rows, coverage %.
//   - Reports distributions for refs_count / coauthor_max_h / author_tier1_pubs.
//   - Gracefully reports "table missing" instead of crashing when extras has
//     not been built yet.
//   - Never writes to the database.

import Database from 'better-sqlite3'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

const fmt = n => (n == null ? 'n/a' : Number(n).toLocaleString())
const pct = (num, den) =>
  den && den > 0 && num != null ? `${((100 * num) / den).toFixed(2)}%` : 'n/a'
const fixed = (n, d = 2) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(d))

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name)
  return !!row
}

// SQLite has no native median; pull the column (filtered to non-null) and
// compute mean / median / max / count_nonzero in JS. The extras table is
// bounded by `papers` (a few hundred k rows max), so the working set is fine.
function distribution(db, table, col) {
  const rows = db
    .prepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)
    .all()
  const values = rows.map(r => Number(r.v)).filter(v => Number.isFinite(v))
  const n = values.length
  if (n === 0) {
    return { n: 0, mean: null, median: null, max: null, gt0: 0 }
  }
  values.sort((a, b) => a - b)
  let sum = 0
  let gt0 = 0
  for (const v of values) {
    sum += v
    if (v > 0) gt0++
  }
  const mean = sum / n
  const median =
    n % 2 === 1 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2
  const max = values[n - 1]
  return { n, mean, median, max, gt0 }
}

function main() {
  console.log('PaperFate extras corpus status')
  console.log(`  db_path  : ${DB_PATH}`)
  console.log('')

  let db
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  } catch (err) {
    console.error(`!! cannot open db: ${err.message}`)
    process.exit(1)
  }
  db.pragma('busy_timeout=60000')

  const papersTotal = tableExists(db, 'papers')
    ? db.prepare('SELECT COUNT(*) AS n FROM papers').get().n
    : null

  console.log('=== corpus ===')
  console.log(`  papers.total            : ${fmt(papersTotal)}`)

  if (!tableExists(db, 'paper_extras_v2')) {
    console.log('  paper_extras_v2         : (table missing — extras pipeline has not run yet)')
    db.close()
    return
  }

  const extrasTotal = db.prepare('SELECT COUNT(*) AS n FROM paper_extras_v2').get().n
  console.log(`  paper_extras_v2.rows    : ${fmt(extrasTotal)}`)
  console.log(`  coverage_vs_papers      : ${pct(extrasTotal, papersTotal)}`)

  // refs_count: integer column, never null in builder output for processed rows
  // (defaults to 0 when no refs found). Use distribution helper anyway.
  console.log('\n=== refs_count ===')
  const refs = distribution(db, 'paper_extras_v2', 'refs_count')
  console.log(`  n_non_null              : ${fmt(refs.n)}`)
  console.log(`  mean                    : ${fixed(refs.mean, 2)}`)
  console.log(`  median                  : ${fixed(refs.median, 2)}`)
  console.log(`  max                     : ${fmt(refs.max)}`)
  console.log(`  with_refs (>0)          : ${fmt(refs.gt0)}  (${pct(refs.gt0, refs.n)} of non-null)`)

  console.log('\n=== coauthor_max_h ===')
  const cmh = distribution(db, 'paper_extras_v2', 'coauthor_max_h')
  console.log(`  n_non_null              : ${fmt(cmh.n)}`)
  console.log(`  mean                    : ${fixed(cmh.mean, 2)}`)
  console.log(`  median                  : ${fixed(cmh.median, 2)}`)
  console.log(`  max                     : ${fmt(cmh.max)}`)

  console.log('\n=== author_tier1_pubs ===')
  const tier1 = distribution(db, 'paper_extras_v2', 'author_tier1_pubs')
  console.log(`  n_non_null              : ${fmt(tier1.n)}`)
  console.log(`  mean                    : ${fixed(tier1.mean, 2)}`)
  console.log(`  max                     : ${fmt(tier1.max)}`)

  db.close()
}

try {
  main()
} catch (err) {
  console.error('extras-corpus-status crashed:', err && err.stack ? err.stack : err)
  process.exit(1)
}
