#!/usr/bin/env node
import Database from 'better-sqlite3'
import { join } from 'node:path'

const DB = join(process.env.DATA_ROOT || './data', 'paperfate.db')
const db = new Database(DB, { readonly: true })
db.pragma('busy_timeout=60000')

const fmt = n => Number(n || 0).toLocaleString()

console.log('=== paper_scores by mode ===')
for (const r of db.prepare('SELECT mode, COUNT(*) AS n FROM paper_scores GROUP BY mode ORDER BY n DESC').all()) {
  console.log(' ', String(r.mode).padEnd(22), fmt(r.n))
}

console.log('\n=== distinct DOIs scored per mode ===')
try {
  for (const r of db.prepare('SELECT mode, COUNT(DISTINCT doi) AS d FROM paper_scores GROUP BY mode ORDER BY d DESC').all()) {
    console.log(' ', String(r.mode).padEnd(22), fmt(r.d))
  }
} catch (e) { console.log('  (no doi column:', e.message, ')') }

console.log('\n=== papers total ===', fmt(db.prepare('SELECT COUNT(*) AS n FROM papers').get().n))

// discover actual column names for body word counts
const cols = db.prepare('PRAGMA table_info(papers)').all().map(c => c.name)
const bodyCols = cols.filter(c => /body.*word|word.*count|_body_/i.test(c))
console.log('\n=== fulltext body columns present ===')
console.log(' ', bodyCols.join(', ') || '(none matched)')
for (const c of bodyCols) {
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE ${c} >= 800`).get().n
    console.log('  ', c.padEnd(28), '>=800 words:', fmt(n))
  } catch {}
}

// any-fulltext coverage
const anyCov = bodyCols.length
  ? `(${bodyCols.map(c => `COALESCE(${c},0) >= 800`).join(' OR ')})`
  : null
if (anyCov) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE ${anyCov}`).get().n
  console.log('\n=== papers with ANY fulltext (>=800 words) ===', fmt(n))
}

// recent scoring activity
console.log('\n=== recent paper_scores rows ===')
const tsCol = cols.includes('scored_at') ? 'scored_at' : (db.prepare('PRAGMA table_info(paper_scores)').all().map(c=>c.name).find(c => /at$|time|ts/i.test(c)))
try {
  const rows = db.prepare(`SELECT mode, ${tsCol} AS ts FROM paper_scores ORDER BY ${tsCol} DESC LIMIT 5`).all()
  for (const r of rows) console.log('  ', r.ts, r.mode)
} catch (e) { console.log('  (no timestamp col)', e.message) }

db.close()
