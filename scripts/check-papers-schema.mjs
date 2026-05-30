import Database from 'better-sqlite3'
import { join } from 'node:path'
const DB = join(process.env.DATA_ROOT || './data', 'paperfate.db')
const db = new Database(DB, { readonly: true })
db.pragma('busy_timeout=60000')

const cols = db.prepare('PRAGMA table_info(papers)').all()
const jifCols = cols.filter(c => /jif|impact|cited/i.test(c.name))
console.log('papers columns matching jif/impact/cited:')
for (const c of jifCols) console.log(' ', c.name, c.type)

const jymCols = db.prepare('PRAGMA table_info(journal_year_metrics)').all()
console.log('\njournal_year_metrics columns:')
for (const c of jymCols) console.log(' ', c.name, c.type)

const journalCols = db.prepare('PRAGMA table_info(journals)').all()
const jjifCols = journalCols.filter(c => /jif|impact|cited/i.test(c.name))
console.log('\njournals columns matching jif/impact/cited:')
for (const c of jjifCols) console.log(' ', c.name, c.type)

const peCols = db.prepare('PRAGMA table_info(paper_extras_v2)').all()
console.log('\npaper_extras_v2 columns:')
for (const c of peCols) console.log(' ', c.name, c.type)

const peCount = db.prepare('SELECT COUNT(*) AS n FROM paper_extras_v2').get().n
console.log('\npaper_extras_v2 rows:', peCount.toLocaleString())
db.close()
