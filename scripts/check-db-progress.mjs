#!/usr/bin/env node
import Database from 'better-sqlite3'
import { join } from 'node:path'

const DB = join(process.env.DATA_ROOT || './data', 'paperfate.db')
const db = new Database(DB, { readonly: true })
db.pragma('busy_timeout=60000')

console.log('=== paper_scores by mode ===')
for (const r of db.prepare('SELECT mode, COUNT(*) AS n FROM paper_scores GROUP BY mode ORDER BY n DESC').all()) {
  console.log(' ', r.mode.padEnd(20), r.n.toLocaleString())
}

const totalPapers = db.prepare('SELECT COUNT(*) AS n FROM papers').get().n
console.log('\n=== papers total ===')
console.log(' ', totalPapers.toLocaleString())

console.log('\n=== fulltext coverage (body_word_count >= 800) ===')
for (const col of ['epmc_body_word_count', 'pmc_body_word_count', 'pdf_body_word_count']) {
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE ${col} >= 800`).get().n
    console.log(' ', col.padEnd(28), n.toLocaleString())
  } catch (e) {
    console.log(' ', col.padEnd(28), '(column missing)')
  }
}

console.log('\n=== top-JIF papers eligible for Q500-fulltext rescoring ===')
try {
  const r = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE real_jcr_jif >= 30) AS top,
      COUNT(*) FILTER (WHERE real_jcr_jif >= 10 AND real_jcr_jif < 30) AS high,
      COUNT(*) FILTER (WHERE real_jcr_jif >=  3 AND real_jcr_jif < 10) AS mid,
      COUNT(*) FILTER (WHERE real_jcr_jif <  3) AS low
    FROM papers
    WHERE (epmc_body_word_count >= 800 OR pmc_body_word_count >= 800)
  `).get()
  console.log('  IF >= 30 (NEJM-class):', (r.top || 0).toLocaleString())
  console.log('  IF 10-30            :', (r.high || 0).toLocaleString())
  console.log('  IF  3-10            :', (r.mid || 0).toLocaleString())
  console.log('  IF <  3             :', (r.low || 0).toLocaleString())
} catch (e) {
  console.log('  (real_jcr_jif column missing:', e.message, ')')
}

console.log('\n=== latest paper_scores rows (any mode) ===')
try {
  for (const r of db.prepare(`
    SELECT doi, mode, q_score_mean, scored_at
    FROM paper_scores
    ORDER BY scored_at DESC
    LIMIT 5
  `).all()) {
    console.log(' ', r.scored_at, r.mode.padEnd(18), 'q=' + (r.q_score_mean ?? 'NULL'), 'doi=' + (r.doi || '').slice(0, 40))
  }
} catch (e) {
  console.log('  scored_at column missing:', e.message)
}

db.close()
