#!/usr/bin/env node
// PaperFate · Ingest NIH RePORTER publication→grant links
//
// Reads data/nih-reporter/*.jsonl produced by collect-nih-reporter.mjs and:
//   - Inserts (pmid, coreproject, applid) tuples into nih_grants table
//   - Updates papers.has_nih_grant flag + papers.n_nih_grants count
//
// Schema additions are idempotent.

import Database from 'better-sqlite3'
import { createReadStream, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const SRC_DIR = join(DATA_ROOT, 'nih-reporter')

function addColumnIfMissing(db, table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name)
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    console.log(`  + added ${table}.${col} ${type}`)
  }
}

async function main() {
  console.log('PaperFate · NIH RePORTER ingest')
  console.log(`DB:    ${DB_PATH}`)
  console.log(`Src:   ${SRC_DIR}`)

  const db = new Database(DB_PATH, { fileMustExist: true })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 60000')

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS nih_grants (
      pmid        TEXT NOT NULL,
      coreproject TEXT NOT NULL,
      applid      INTEGER,
      ingested_at TEXT,
      PRIMARY KEY (pmid, coreproject)
    );
    CREATE INDEX IF NOT EXISTS idx_nih_grants_pmid ON nih_grants(pmid);
    CREATE INDEX IF NOT EXISTS idx_nih_grants_coreproject ON nih_grants(coreproject);
  `)
  addColumnIfMissing(db, 'papers', 'has_nih_grant', 'INTEGER')
  addColumnIfMissing(db, 'papers', 'n_nih_grants', 'INTEGER')

  const files = readdirSync(SRC_DIR).filter(n => n.endsWith('.jsonl') && !n.startsWith('_')).map(n => join(SRC_DIR, n))
  if (!files.length) { console.log('no files'); db.close(); return }

  const insertGrant = db.prepare(`
    INSERT OR IGNORE INTO nih_grants (pmid, coreproject, applid, ingested_at)
    VALUES (@pmid, @coreproject, @applid, @ts)
  `)
  // Aggregate counts per PMID
  const grantCounts = new Map()  // pmid -> set of coreprojects
  const noGrantPmids = new Set()

  for (const f of files) {
    console.log(`\nScanning ${f.split(/[\\/]/).pop()} ...`)
    let lines = 0, links = 0, marks = 0
    const ts = new Date().toISOString()
    const batch = []
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      lines++
      if (!line.trim()) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      if (r.no_grant) {
        if (r.pmid) noGrantPmids.add(String(r.pmid))
        marks++
      } else if (r.pmid && r.coreproject) {
        const pmid = String(r.pmid)
        batch.push({ pmid, coreproject: String(r.coreproject), applid: r.applid ?? null, ts })
        if (!grantCounts.has(pmid)) grantCounts.set(pmid, new Set())
        grantCounts.get(pmid).add(String(r.coreproject))
        links++
        if (batch.length >= 5000) {
          db.transaction((rs) => { for (const x of rs) insertGrant.run(x) })(batch.splice(0))
        }
      }
    }
    if (batch.length) db.transaction((rs) => { for (const x of rs) insertGrant.run(x) })(batch)
    console.log(`  lines=${lines.toLocaleString()}  links=${links.toLocaleString()}  no-grant marks=${marks.toLocaleString()}`)
  }

  // Update papers.has_nih_grant / n_nih_grants
  console.log('\nUpdating papers.has_nih_grant / n_nih_grants ...')
  const updHasGrant = db.prepare(`UPDATE papers SET has_nih_grant = @v, n_nih_grants = @n WHERE pmid = @pmid`)
  let withGrant = 0, withoutGrant = 0
  const allRows = []
  for (const [pmid, set] of grantCounts) allRows.push({ pmid, v: 1, n: set.size })
  for (const pmid of noGrantPmids) {
    if (!grantCounts.has(pmid)) allRows.push({ pmid, v: 0, n: 0 })
  }
  console.log(`  prepared ${allRows.length.toLocaleString()} paper updates`)

  const flush = (rs) => {
    let n = 0
    db.transaction((batch) => {
      for (const r of batch) {
        const info = updHasGrant.run(r)
        if (info.changes > 0) n++
      }
    })(rs)
    return n
  }
  for (let i = 0; i < allRows.length; i += 5000) {
    const chunk = allRows.slice(i, i + 5000)
    const n = flush(chunk)
    if (i % 50000 === 0) console.log(`  ${i.toLocaleString()}/${allRows.length.toLocaleString()} ...`)
  }

  const c = (sql) => db.prepare(sql).get()
  console.log('\nFinal coverage:')
  console.log(`  nih_grants rows:       ${c('SELECT COUNT(*) n FROM nih_grants').n.toLocaleString()}`)
  console.log(`  papers with NIH grant: ${c('SELECT COUNT(*) n FROM papers WHERE has_nih_grant=1').n.toLocaleString()}`)
  console.log(`  papers queried no-grant:${c('SELECT COUNT(*) n FROM papers WHERE has_nih_grant=0').n.toLocaleString()}`)
  console.log(`  papers max n_grants:   ${c('SELECT MAX(n_nih_grants) n FROM papers').n}`)
  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
