import Database from 'better-sqlite3'
import { join } from 'node:path'
const db = new Database(join(process.env.DATA_ROOT || './data', 'paperfate.db'), { readonly: true })
db.pragma('busy_timeout=60000')
const fmt = n => Number(n || 0).toLocaleString()

console.log('=== paper_scores by mode ===')
for (const r of db.prepare('SELECT mode, COUNT(*) AS n FROM paper_scores GROUP BY mode ORDER BY n DESC').all()) {
  console.log(' ', String(r.mode).padEnd(22), fmt(r.n))
}

// Q500-fulltext specifically (Codex Round 7 target)
const q500ft = db.prepare(`SELECT COUNT(*) AS n FROM paper_scores WHERE mode LIKE '%Q500-fulltext%' OR mode LIKE '%fulltext%'`).get().n
console.log('\nQ500-fulltext-ish rows:', fmt(q500ft))

console.log('\n=== papers + extras + fulltext coverage ===')
console.log('  papers:', fmt(db.prepare('SELECT COUNT(*) AS n FROM papers').get().n))
try { console.log('  paper_extras_v2:', fmt(db.prepare('SELECT COUNT(*) AS n FROM paper_extras_v2').get().n)) } catch {}
for (const c of ['epmc_body_word_count','pmc_body_word_count','pdf_body_words']) {
  try { console.log('  ' + c + ' >=800:', fmt(db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE COALESCE(${c},0) >= 800`).get().n)) } catch {}
}

// high-JIF papers with fulltext (the priority extraction target)
console.log('\n=== high-JIF papers with fulltext (extraction priority) ===')
try {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM papers p
    JOIN journal_year_metrics jym ON jym.issn = p.issn AND jym.year = p.year
    WHERE jym.jcr_jif >= 10 AND (COALESCE(p.epmc_body_word_count,0) >= 800 OR COALESCE(p.pmc_body_word_count,0) >= 800)
  `).get()
  console.log('  JIF>=10 with fulltext:', fmt(r.n))
} catch (e) { console.log('  (query failed:', e.message, ')') }
db.close()
