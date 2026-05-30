#!/usr/bin/env node
// Read-only audit of paperfate.db indexes vs the application's hot query patterns.
// Exits 0 always: this is a report, not a gate.
import Database from 'better-sqlite3'
import { join } from 'node:path'

const DB = join(process.env.DATA_ROOT || './data', 'paperfate.db')

let db
try {
  db = new Database(DB, { readonly: true, fileMustExist: true })
} catch (e) {
  console.log('db-index-audit: cannot open', DB, '-', e.message)
  process.exit(0)
}
db.pragma('busy_timeout=60000')

const fmt = n => Number(n || 0).toLocaleString()
const pad = (s, n) => String(s ?? '').padEnd(n)

function safeAll(sql, params = []) {
  try { return db.prepare(sql).all(...params) } catch (e) { return { _error: e.message } }
}

function safeGet(sql) {
  try { return db.prepare(sql).get() } catch (e) { return { _error: e.message } }
}

// --- 1. List indexes ----------------------------------------------------------
console.log('=== sqlite_master indexes ===')
const indexes = safeAll(
  "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name",
)
if (indexes._error) {
  console.log('  error:', indexes._error)
} else if (indexes.length === 0) {
  console.log('  (no indexes)')
} else {
  console.log('  ', pad('table', 32), pad('index', 40), 'definition')
  for (const r of indexes) {
    const sql = (r.sql || '(auto)').replace(/\s+/g, ' ').slice(0, 120)
    console.log('  ', pad(r.tbl_name, 32), pad(r.name, 40), sql)
  }
  console.log('  total indexes:', indexes.length)
}

// --- 2. EXPLAIN QUERY PLAN over hot patterns ---------------------------------
// Hardcoded representative read patterns that the app uses (forecast/score/build paths).
const HOT_QUERIES = [
  {
    label: 'extras-lookup by doi',
    sql: 'SELECT * FROM paper_extras_v2 WHERE doi = ?',
    params: ['10.0/example'],
    hint: 'CREATE INDEX IF NOT EXISTS idx_paper_extras_v2_doi ON paper_extras_v2(doi)',
  },
  {
    label: 'paper_references by source_doi',
    sql: 'SELECT * FROM paper_references WHERE source_doi = ?',
    params: ['10.0/example'],
    hint: 'CREATE INDEX IF NOT EXISTS idx_paper_references_source_doi ON paper_references(source_doi)',
  },
  {
    label: 'journal_year_metrics by issn+year',
    sql: 'SELECT * FROM journal_year_metrics WHERE issn = ? AND year = ?',
    params: ['0000-0000', 2024],
    hint: 'CREATE INDEX IF NOT EXISTS idx_journal_year_metrics_issn_year ON journal_year_metrics(issn, year)',
  },
  {
    label: 'papers by doi',
    sql: 'SELECT * FROM papers WHERE doi = ?',
    params: ['10.0/example'],
    hint: 'CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi)',
  },
  {
    label: 'papers by issn',
    sql: 'SELECT * FROM papers WHERE issn = ?',
    params: ['0000-0000'],
    hint: 'CREATE INDEX IF NOT EXISTS idx_papers_issn ON papers(issn)',
  },
]

function planFor(sql, params) {
  try {
    const rows = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params)
    return rows.map(r => r.detail || r.opcode || JSON.stringify(r)).join(' | ')
  } catch (e) {
    return 'ERROR: ' + e.message
  }
}

function classify(planText) {
  // SQLite plan vocabulary: "SEARCH ... USING INDEX/COVERING INDEX/PRIMARY KEY/rowid=" is good.
  // "SCAN" without an INDEX qualifier is a full table scan.
  if (/ERROR:/.test(planText)) return 'ERROR'
  const hasIndexedSearch = /SEARCH .* USING (COVERING INDEX|INDEX|INTEGER PRIMARY KEY|PRIMARY KEY|ROWID)/i.test(planText)
  const hasScan = /\bSCAN\b/.test(planText) && !/SCAN .* USING (COVERING INDEX|INDEX)/i.test(planText)
  if (hasIndexedSearch && !hasScan) return 'SEARCH'
  if (hasScan) return 'SCAN'
  return 'OTHER'
}

console.log('\n=== EXPLAIN QUERY PLAN (hot patterns) ===')
const LABEL_W = 36
const PLAN_W = 16
console.log('  ', pad('query', LABEL_W), pad('plan', PLAN_W), 'detail / recommendation')
console.log('  ', pad('-----', LABEL_W), pad('----', PLAN_W), '---------------------------')

const recommendations = []
for (const q of HOT_QUERIES) {
  const detail = planFor(q.sql, q.params)
  const verdict = classify(detail)
  console.log('  ', pad(q.label, LABEL_W), pad(verdict, PLAN_W), detail.slice(0, 160))
  if (verdict === 'SCAN') recommendations.push({ label: q.label, hint: q.hint })
}

// --- 3. Recommendations -------------------------------------------------------
console.log('\n=== recommendations ===')
if (recommendations.length === 0) {
  console.log('  (none — all hot patterns are using SEARCH on an index or primary key)')
} else {
  for (const r of recommendations) {
    console.log('  -', r.label)
    console.log('     ', r.hint + ';')
  }
}

// --- 4. DB size for context ---------------------------------------------------
console.log('\n=== database size ===')
const size = safeGet(
  'SELECT (SELECT page_count FROM pragma_page_count()) AS pages, (SELECT page_size FROM pragma_page_size()) AS page_size',
)
if (size && !size._error && size.pages && size.page_size) {
  const bytes = Number(size.pages) * Number(size.page_size)
  const mb = bytes / (1024 * 1024)
  console.log('  pages:    ', fmt(size.pages))
  console.log('  page_size:', fmt(size.page_size), 'bytes')
  console.log('  total:    ', fmt(bytes), 'bytes (', mb.toFixed(1), 'MiB )')
} else {
  console.log('  (page_count/page_size unavailable)', size && size._error ? size._error : '')
}

// Per-table approximate row counts for the hot tables, for context only.
console.log('\n=== row counts (hot tables) ===')
const HOT_TABLES = ['papers', 'paper_extras_v2', 'paper_references', 'journal_year_metrics']
for (const t of HOT_TABLES) {
  const r = safeGet(`SELECT COUNT(*) AS n FROM ${t}`)
  if (r && !r._error) console.log('  ', pad(t, 24), fmt(r.n))
  else console.log('  ', pad(t, 24), '(missing:', (r && r._error) || 'n/a', ')')
}

db.close()
process.exit(0)
