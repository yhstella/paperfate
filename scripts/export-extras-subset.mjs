#!/usr/bin/env node
// Export a JSON subset of paper_extras_v2 for /api/extras-lookup runtime use.
//
// Selection prioritises high-tier papers (real_jcr_jif >= --min-jif) so the
// lookup is useful for high-impact references most users cite.
//
// Output shape:
//   { exported_at, count, min_jif, rows: [ { ...paper_extras_v2 columns } ] }
//
// CLI:
//   --limit N       max rows to export (default 50000)
//   --min-jif F     minimum real_jcr_jif to include (default 10)
//   --out PATH      output JSON path (default weights/paper_extras_v2_subset.json)
//
// Constraints:
//   - Vercel function size limit: keep output under ~25MB on disk.
//   - Read-only access to paper_extras_v2 (and papers for the JIF join).

import Database from 'better-sqlite3'
import { writeFileSync, statSync } from 'node:fs'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = { limit: 50000, minJif: 10, outPath: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--limit' && next != null) {
      const n = Number(next)
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --limit: ${next}`)
        process.exit(2)
      }
      out.limit = Math.floor(n)
      i++
    } else if (a === '--min-jif' && next != null) {
      const f = Number(next)
      if (!Number.isFinite(f) || f < 0) {
        console.error(`Invalid --min-jif: ${next}`)
        process.exit(2)
      }
      out.minJif = f
      i++
    } else if (a === '--out' && next != null) {
      out.outPath = next
      i++
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/export-extras-subset.mjs [--limit N] [--min-jif F] [--out PATH]')
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${a}`)
      process.exit(2)
    }
  }
  if (!out.outPath) {
    out.outPath = join(ROOT, 'weights', 'paper_extras_v2_subset.json')
  } else if (!isAbsolute(out.outPath)) {
    out.outPath = resolve(process.cwd(), out.outPath)
  }
  return out
}

const { limit, minJif, outPath } = parseArgs(process.argv)

// ---------- DB open (read-only) ----------
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
db.pragma('busy_timeout=60000')

// Resolve paper_extras_v2 columns dynamically so we never assume schema.
const extraCols = db.prepare('PRAGMA table_info(paper_extras_v2)').all().map(c => c.name)
if (extraCols.length === 0) {
  console.error('paper_extras_v2 table not found or empty schema.')
  db.close()
  process.exit(1)
}

// We only want columns from paper_extras_v2 in the output rows; alias them
// with the table prefix to avoid collisions with papers.real_jcr_jif used for
// ordering / filtering.
const selectList = extraCols.map(c => `pe.${quoteIdent(c)}`).join(', ')

const sql = `
  SELECT ${selectList}, p.real_jcr_jif AS __jif
  FROM paper_extras_v2 pe
  JOIN papers p ON pe.doi = p.doi
  WHERE p.real_jcr_jif >= ?
  ORDER BY p.real_jcr_jif DESC
  LIMIT ?
`

const t0 = Date.now()
const raw = db.prepare(sql).all(minJif, limit)
const elapsedMs = Date.now() - t0

// Strip the helper __jif column from output rows but keep it for mean
const rows = new Array(raw.length)
let jifSum = 0
let jifCount = 0
for (let i = 0; i < raw.length; i++) {
  const r = raw[i]
  const jif = r.__jif
  if (typeof jif === 'number' && Number.isFinite(jif)) {
    jifSum += jif
    jifCount++
  }
  const clean = {}
  for (const c of extraCols) clean[c] = r[c]
  rows[i] = clean
}

const meanJif = jifCount > 0 ? jifSum / jifCount : null

const payload = {
  exported_at: new Date().toISOString(),
  count: rows.length,
  min_jif: minJif,
  rows,
}

writeFileSync(outPath, JSON.stringify(payload))

let fileSizeMb = null
try {
  fileSizeMb = statSync(outPath).size / (1024 * 1024)
} catch {}

console.log('paper_extras_v2 subset exported')
console.log('  out          :', outPath)
console.log('  rows_exported:', rows.length)
console.log('  file_size_mb :', fileSizeMb != null ? fileSizeMb.toFixed(2) : 'n/a')
console.log('  mean_jif     :', meanJif != null ? meanJif.toFixed(3) : 'n/a')
console.log('  min_jif      :', minJif)
console.log('  query_ms     :', elapsedMs)

if (fileSizeMb != null && fileSizeMb > 25) {
  console.warn(`  WARNING: output ${fileSizeMb.toFixed(2)} MB exceeds 25 MB Vercel budget — lower --limit or raise --min-jif`)
}

db.close()

// ---------- helpers ----------
function quoteIdent(name) {
  // SQLite identifier quoting: wrap in double quotes, escape embedded quotes.
  return `"${String(name).replace(/"/g, '""')}"`
}
