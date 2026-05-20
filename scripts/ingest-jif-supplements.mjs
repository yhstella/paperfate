#!/usr/bin/env node
// PaperFate · Ingest scraped JIF supplements
//
// Walks data/wayback-jif/*.jsonl and data/wiki-current-jif/*.jsonl, upserts
// the values into journal_year_metrics.{wayback_jif, wiki_current_jif}.
//
// Idempotent: takes MAX confidence record per (journal × year × source) when
// the same key was scraped multiple times across daily files.

import Database from 'better-sqlite3'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = process.env.DATA_ROOT || join(HERE, '..', 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

function addColumnIfMissing(db, table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name)
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    console.log(`  + ${table}.${col} ${type}`)
  }
}

function readJsonl(file) {
  const out = []
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

function bestByKey(records, valKey) {
  // (openalex_id, year) → record with highest confidence (default 0.5)
  const best = new Map()
  for (const r of records) {
    if (r[valKey] == null) continue
    const k = `${r.openalex_id}|${r.year}`
    const conf = r.confidence ?? 0.5
    const prev = best.get(k)
    if (!prev || conf > (prev.confidence ?? 0.5)) best.set(k, r)
  }
  return best
}

function ingestSource(db, dir, valColumn, confColumn, urlColumn) {
  if (!existsSync(dir)) {
    console.log(`  ${dir}: directory does not exist, skipping`)
    return { ingested: 0 }
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
  const all = []
  for (const f of files) all.push(...readJsonl(join(dir, f)))

  const best = bestByKey(all, valColumn)
  console.log(`  ${dir}: ${all.length} lines, ${best.size} unique (journal × year) with value`)

  const upd = db.prepare(`
    UPDATE journal_year_metrics
    SET ${valColumn} = @v,
        ${confColumn} = @c,
        ${urlColumn} = @u
    WHERE openalex_id = @id AND year = @y
  `)
  const ins = db.prepare(`
    INSERT OR IGNORE INTO journal_year_metrics (openalex_id, year, ${valColumn}, ${confColumn}, ${urlColumn})
    VALUES (@id, @y, @v, @c, @u)
  `)
  let ingested = 0
  db.transaction(() => {
    for (const r of best.values()) {
      const payload = {
        id: r.openalex_id,
        y: r.year,
        v: r[valColumn],
        c: r.confidence ?? 0.5,
        u: r.snapshot_url ?? r.wiki_url ?? null,
      }
      const ru = upd.run(payload)
      if (ru.changes === 0) ins.run(payload)
      ingested++
    }
  })()
  return { ingested }
}

function main() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  console.log('PaperFate · ingest-jif-supplements')
  console.log('Adding columns if missing …')
  addColumnIfMissing(db, 'journal_year_metrics', 'wayback_jif',                'REAL')
  addColumnIfMissing(db, 'journal_year_metrics', 'wayback_jif_confidence',     'REAL')
  addColumnIfMissing(db, 'journal_year_metrics', 'wayback_snapshot_url',       'TEXT')
  addColumnIfMissing(db, 'journal_year_metrics', 'wiki_current_jif',           'REAL')
  addColumnIfMissing(db, 'journal_year_metrics', 'wiki_current_jif_confidence','REAL')
  addColumnIfMissing(db, 'journal_year_metrics', 'wiki_current_jif_url',       'TEXT')

  console.log('\nIngesting wayback-jif …')
  const wb = ingestSource(
    db, join(DATA_ROOT, 'wayback-jif'),
    'wayback_jif', 'wayback_jif_confidence', 'wayback_snapshot_url'
  )
  console.log(`  ↳ ${wb.ingested} rows upserted`)

  console.log('\nIngesting wiki-current-jif …')
  const wc = ingestSource(
    db, join(DATA_ROOT, 'wiki-current-jif'),
    'wiki_current_jif', 'wiki_current_jif_confidence', 'wiki_current_jif_url'
  )
  console.log(`  ↳ ${wc.ingested} rows upserted`)

  // Final stats
  const s = db.prepare(`
    SELECT
      COUNT(*) AS total_rows,
      SUM(CASE WHEN jcr_jif IS NOT NULL THEN 1 ELSE 0 END) AS with_jcr,
      SUM(CASE WHEN wayback_jif IS NOT NULL THEN 1 ELSE 0 END) AS with_wayback,
      SUM(CASE WHEN wiki_current_jif IS NOT NULL THEN 1 ELSE 0 END) AS with_wiki,
      SUM(CASE WHEN jcr_jif IS NOT NULL OR wayback_jif IS NOT NULL OR wiki_current_jif IS NOT NULL THEN 1 ELSE 0 END) AS with_any_real_jif
    FROM journal_year_metrics
  `).get()
  console.log('\nFinal coverage:', JSON.stringify(s, null, 2))

  // Quick agreement check: where multiple sources exist, how close?
  const cross = db.prepare(`
    SELECT
      COUNT(*) n,
      ROUND(AVG(ABS(jcr_jif - wayback_jif) / jcr_jif * 100), 1) AS mean_pct_diff_jcr_wb,
      ROUND(AVG(ABS(jcr_jif - wiki_current_jif) / jcr_jif * 100), 1) AS mean_pct_diff_jcr_wiki
    FROM journal_year_metrics
    WHERE jcr_jif IS NOT NULL AND jcr_jif > 0.1
  `).get()
  console.log('\nAgreement (where both available):', JSON.stringify(cross, null, 2))

  db.close()
}

main()
