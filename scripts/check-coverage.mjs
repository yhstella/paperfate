#!/usr/bin/env node
import Database from 'better-sqlite3'
import { join } from 'node:path'

const DB = join(process.env.DATA_ROOT || './data', 'paperfate.db')
const db = new Database(DB, { readonly: true })
db.pragma('busy_timeout=60000')
const fmt = n => Number(n || 0).toLocaleString()

const papers = db.prepare('SELECT COUNT(*) AS n FROM papers').get().n
console.log('papers total:', fmt(papers))

const cols = db.prepare('PRAGMA table_info(papers)').all().map(c => c.name)
const bodyCols = cols.filter(c => /body.*word|word.*count|_body_/i.test(c))
console.log('\nfulltext body columns:', bodyCols.join(', ') || '(none)')
for (const c of bodyCols) {
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE COALESCE(${c},0) >= 800`).get().n
    console.log('  ', c.padEnd(30), '>=800w:', fmt(n))
  } catch {}
}
if (bodyCols.length) {
  const anyCov = bodyCols.map(c => `COALESCE(${c},0) >= 800`).join(' OR ')
  const n = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE ${anyCov}`).get().n
  console.log('\npapers with ANY fulltext (>=800w):', fmt(n), `(${(100*n/papers).toFixed(1)}% of corpus)`)
}

// JIF label coverage (training target availability)
const jifCol = cols.find(c => /real_jcr_jif|jcr_jif|jif$/i.test(c))
if (jifCol) {
  const labelled = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE ${jifCol} IS NOT NULL`).get().n
  console.log(`\npapers with ${jifCol} label:`, fmt(labelled), `(${(100*labelled/papers).toFixed(1)}%)`)
}

// codex_deterministic distinct papers via a count/507 estimate is enough; skip slow DISTINCT
const detRows = db.prepare(`SELECT COUNT(*) AS n FROM paper_scores WHERE mode='codex_deterministic'`).get().n
console.log('\ncodex_deterministic rows:', fmt(detRows), '~papers:', fmt(Math.round(detRows/507)))
const llmRows = db.prepare(`SELECT COUNT(*) AS n FROM paper_scores WHERE mode='llm'`).get().n
console.log('llm-scored rows:', fmt(llmRows))
const r7 = db.prepare(`SELECT COUNT(*) AS n FROM paper_scores WHERE mode LIKE '%fulltext%' OR mode LIKE '%Q500-full%'`).get().n
console.log('Q500-fulltext (Round 7) rows:', fmt(r7))

db.close()
