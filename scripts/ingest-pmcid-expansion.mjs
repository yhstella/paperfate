#!/usr/bin/env node
// PaperFate · Ingest PMID → PMCID expansion results into papers.pmcid
//
// Reads data/pmcid-expansion/*.jsonl produced by expand-pmid-to-pmcid.mjs and
// updates `papers.pmcid` for any matched (pmid, pmcid) pair where the paper's
// existing pmcid is null or empty.
//
// Also fills in `papers.doi` if missing.

import Database from 'better-sqlite3'
import { createReadStream, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const SRC_DIR = join(DATA_ROOT, 'pmcid-expansion')

async function main() {
  console.log('PaperFate · pmcid-expansion ingest')
  console.log(`DB:    ${DB_PATH}`)
  console.log(`Src:   ${SRC_DIR}`)
  const files = readdirSync(SRC_DIR)
    .filter(n => n.endsWith('.jsonl') && !n.startsWith('_'))
    .map(n => join(SRC_DIR, n))
  if (!files.length) { console.log('no files'); return }

  const db = new Database(DB_PATH, { fileMustExist: true })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 60000')
  const setPmcid = db.prepare(`
    UPDATE papers
       SET pmcid = @pmcid, doi = COALESCE(doi, @doi)
     WHERE pmid = @pmid
       AND (pmcid IS NULL OR pmcid = '')
  `)

  for (const f of files) {
    let seen = 0, hits = 0, updated = 0
    const batch = []
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      seen++
      if (!line.trim()) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      if (!r.pmid || !r.pmcid) continue
      hits++
      batch.push({ pmid: String(r.pmid), pmcid: String(r.pmcid), doi: r.doi || null })
      if (batch.length >= 5000) {
        updated += flush(db, setPmcid, batch.splice(0))
      }
    }
    if (batch.length) updated += flush(db, setPmcid, batch)
    console.log(`  ${f.split(/[\\/]/).pop()}  seen=${seen.toLocaleString()}  hits=${hits.toLocaleString()}  updated=${updated.toLocaleString()}`)
  }
  db.close()
}

function flush(db, stmt, rows) {
  let changed = 0
  const txn = db.transaction((rs) => {
    for (const r of rs) {
      const info = stmt.run(r)
      if (info.changes > 0) changed++
    }
  })
  txn(rows)
  return changed
}

main().catch(e => { console.error(e); process.exit(1) })
