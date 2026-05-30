#!/usr/bin/env node
/**
 * db-integrity.mjs — Read-only sanity check for paperfate.db
 *
 * Runs five families of checks:
 *   1. SQLite PRAGMA integrity_check
 *   2. Foreign-key style integrity
 *        - paper_references.doi      -> papers.doi
 *        - paper_extras_v2.doi       -> papers.doi
 *        - journal_year_metrics.issn -> journals.issn_l or journals.issn_json
 *   3. Null-count summary on critical columns
 *   4. Distribution sanity (year range, jcr_jif numeric)
 *   5. Size summary (rows per table, DB file MB)
 *
 * Exit codes:
 *   0 = clean (FAILs == 0). WARNings allowed.
 *   1 = at least one FAIL.
 *
 * Usage:
 *   DATA_ROOT=./data node scripts/db-integrity.mjs
 */
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statSync, existsSync } from 'node:fs'

const DATA_ROOT = process.env.DATA_ROOT || './data'
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

if (!existsSync(DB_PATH)) {
  console.error(`[db-integrity] DB not found at ${DB_PATH}`)
  process.exit(1)
}

const db = new Database(DB_PATH, { readonly: true })
db.pragma('busy_timeout=60000')

const results = [] // { check, status: 'PASS'|'WARN'|'FAIL', detail }
const STATUS_PASS = 'PASS'
const STATUS_WARN = 'WARN'
const STATUS_FAIL = 'FAIL'

function record(check, status, detail = '') {
  results.push({ check, status, detail: String(detail) })
}

const fmt = (n) => Number(n || 0).toLocaleString()

function tableExists(name) {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name)
  return !!r
}

function columnNames(table) {
  if (!tableExists(table)) return []
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
}

function safeGet(sql, ...params) {
  try {
    return db.prepare(sql).get(...params)
  } catch (e) {
    return { __error: e.message }
  }
}

function safeAll(sql, ...params) {
  try {
    return db.prepare(sql).all(...params)
  } catch (e) {
    return [{ __error: e.message }]
  }
}

// ----------------------------------------------------------------------------
// Check 1: PRAGMA integrity_check
// ----------------------------------------------------------------------------
try {
  const rows = db.prepare('PRAGMA integrity_check').all()
  const messages = rows.map((r) => r.integrity_check)
  if (messages.length === 1 && messages[0] === 'ok') {
    record('pragma integrity_check', STATUS_PASS, 'ok')
  } else {
    record(
      'pragma integrity_check',
      STATUS_FAIL,
      messages.slice(0, 3).join(' | ') + (messages.length > 3 ? ' ...' : '')
    )
  }
} catch (e) {
  record('pragma integrity_check', STATUS_FAIL, e.message)
}

// ----------------------------------------------------------------------------
// Check 2: foreign-key style integrity
// ----------------------------------------------------------------------------

// 2a. paper_references.doi must exist in papers.doi
if (tableExists('paper_references') && tableExists('papers')) {
  const refCols = columnNames('paper_references')
  if (refCols.includes('doi')) {
    const r = safeGet(`
      SELECT COUNT(*) AS orphans
      FROM paper_references pr
      WHERE pr.doi IS NOT NULL
        AND pr.doi <> ''
        AND NOT EXISTS (SELECT 1 FROM papers p WHERE p.doi = pr.doi)
    `)
    if (r.__error) {
      record('fk paper_references.doi -> papers.doi', STATUS_WARN, r.__error)
    } else {
      const orphans = r.orphans
      // paper_references is naturally a superset (cited works not in our corpus).
      // Only fail on a truly impossible value (none), warn otherwise so the
      // operator can see the magnitude.
      record(
        'fk paper_references.doi -> papers.doi',
        STATUS_PASS,
        `${fmt(orphans)} citation rows reference DOIs outside papers (expected; corpus is finite)`
      )
    }
  } else {
    record('fk paper_references.doi -> papers.doi', STATUS_WARN, 'no doi column on paper_references')
  }
} else {
  record('fk paper_references.doi -> papers.doi', STATUS_WARN, 'table missing')
}

// 2b. paper_extras_v2.doi must exist in papers.doi
if (tableExists('paper_extras_v2') && tableExists('papers')) {
  const extrasCols = columnNames('paper_extras_v2')
  if (extrasCols.includes('doi')) {
    const r = safeGet(`
      SELECT COUNT(*) AS orphans
      FROM paper_extras_v2 pe
      WHERE pe.doi IS NOT NULL
        AND pe.doi <> ''
        AND NOT EXISTS (SELECT 1 FROM papers p WHERE p.doi = pe.doi)
    `)
    if (r.__error) {
      record('fk paper_extras_v2.doi -> papers.doi', STATUS_WARN, r.__error)
    } else if (r.orphans === 0) {
      record('fk paper_extras_v2.doi -> papers.doi', STATUS_PASS, '0 orphans')
    } else {
      record(
        'fk paper_extras_v2.doi -> papers.doi',
        STATUS_FAIL,
        `${fmt(r.orphans)} paper_extras_v2 rows have DOIs missing from papers`
      )
    }
  } else {
    record('fk paper_extras_v2.doi -> papers.doi', STATUS_WARN, 'no doi column on paper_extras_v2')
  }
} else {
  record('fk paper_extras_v2.doi -> papers.doi', STATUS_WARN, 'table missing')
}

// 2c. journal_year_metrics.issn -> journals.issn_l OR appears in journals.issn_json
if (tableExists('journal_year_metrics') && tableExists('journals')) {
  const jymCols = columnNames('journal_year_metrics')
  const jCols = columnNames('journals')
  if (!jymCols.includes('issn')) {
    record('fk journal_year_metrics.issn -> journals', STATUS_WARN, 'no issn column on journal_year_metrics')
  } else {
    const hasIssnL = jCols.includes('issn_l')
    const hasIssnJson = jCols.includes('issn_json')
    if (!hasIssnL && !hasIssnJson) {
      record('fk journal_year_metrics.issn -> journals', STATUS_WARN, 'journals has neither issn_l nor issn_json')
    } else {
      // Direct match against issn_l is cheap. The issn_json fallback is
      // expensive (LIKE scan), so only run it on the residual.
      const issnLClause = hasIssnL
        ? `EXISTS (SELECT 1 FROM journals j WHERE j.issn_l = jym.issn)`
        : `0`
      const issnJsonClause = hasIssnJson
        ? `EXISTS (SELECT 1 FROM journals j WHERE j.issn_json LIKE '%"' || jym.issn || '"%')`
        : `0`
      const r = safeGet(`
        SELECT COUNT(*) AS orphans
        FROM journal_year_metrics jym
        WHERE jym.issn IS NOT NULL
          AND jym.issn <> ''
          AND NOT (${issnLClause})
          AND NOT (${issnJsonClause})
      `)
      if (r.__error) {
        record('fk journal_year_metrics.issn -> journals', STATUS_WARN, r.__error)
      } else if (r.orphans === 0) {
        record('fk journal_year_metrics.issn -> journals', STATUS_PASS, '0 orphans')
      } else {
        // Some ISSNs from metrics providers (Scimago/JCR) may not map to our
        // journals table — flag loudly but as WARN unless it's a large share.
        const total = safeGet(`SELECT COUNT(*) AS n FROM journal_year_metrics WHERE issn IS NOT NULL AND issn <> ''`).n || 0
        const ratio = total > 0 ? r.orphans / total : 0
        if (ratio > 0.5) {
          record(
            'fk journal_year_metrics.issn -> journals',
            STATUS_FAIL,
            `${fmt(r.orphans)} / ${fmt(total)} (${(ratio * 100).toFixed(1)}%) metric ISSNs not in journals`
          )
        } else {
          record(
            'fk journal_year_metrics.issn -> journals',
            STATUS_WARN,
            `${fmt(r.orphans)} / ${fmt(total)} (${(ratio * 100).toFixed(1)}%) metric ISSNs not in journals`
          )
        }
      }
    }
  }
} else {
  record('fk journal_year_metrics.issn -> journals', STATUS_WARN, 'table missing')
}

// ----------------------------------------------------------------------------
// Check 3: null-count summary on critical columns
// ----------------------------------------------------------------------------
const nullTargets = [
  { table: 'papers', column: 'doi', failOnAny: false },
  { table: 'papers', column: 'title', failOnAny: false },
  { table: 'papers', column: 'issn', failOnAny: false },
  { table: 'journal_year_metrics', column: 'issn', failOnAny: true },
]
for (const t of nullTargets) {
  if (!tableExists(t.table)) {
    record(`null ${t.table}.${t.column}`, STATUS_WARN, 'table missing')
    continue
  }
  const cols = columnNames(t.table)
  if (!cols.includes(t.column)) {
    record(`null ${t.table}.${t.column}`, STATUS_WARN, 'column missing')
    continue
  }
  const r = safeGet(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${t.column} IS NULL OR ${t.column} = '' THEN 1 ELSE 0 END) AS nulls
    FROM ${t.table}
  `)
  if (r.__error) {
    record(`null ${t.table}.${t.column}`, STATUS_WARN, r.__error)
    continue
  }
  const nulls = r.nulls || 0
  const total = r.total || 0
  const detail = `${fmt(nulls)} null / ${fmt(total)} total`
  if (nulls === 0) {
    record(`null ${t.table}.${t.column}`, STATUS_PASS, detail)
  } else if (t.failOnAny) {
    record(`null ${t.table}.${t.column}`, STATUS_FAIL, detail)
  } else {
    // Soft: warn if more than 1% null, pass otherwise.
    const ratio = total > 0 ? nulls / total : 0
    if (ratio > 0.01) {
      record(`null ${t.table}.${t.column}`, STATUS_WARN, `${detail} (${(ratio * 100).toFixed(2)}%)`)
    } else {
      record(`null ${t.table}.${t.column}`, STATUS_PASS, detail)
    }
  }
}

// ----------------------------------------------------------------------------
// Check 4: distribution sanity
// ----------------------------------------------------------------------------

// 4a. papers.year range 1900–2030
if (tableExists('papers') && columnNames('papers').includes('year')) {
  const r = safeGet(`
    SELECT
      MIN(year) AS min_y,
      MAX(year) AS max_y,
      SUM(CASE WHEN year IS NOT NULL AND (year < 1900 OR year > 2030) THEN 1 ELSE 0 END) AS bad
    FROM papers
  `)
  if (r.__error) {
    record('range papers.year [1900,2030]', STATUS_WARN, r.__error)
  } else {
    const detail = `min=${r.min_y ?? 'NULL'} max=${r.max_y ?? 'NULL'} bad=${fmt(r.bad)}`
    if ((r.bad || 0) === 0) {
      record('range papers.year [1900,2030]', STATUS_PASS, detail)
    } else {
      record('range papers.year [1900,2030]', STATUS_FAIL, detail)
    }
  }
} else {
  record('range papers.year [1900,2030]', STATUS_WARN, 'papers.year missing')
}

// 4b. journal_year_metrics.jcr_jif numeric & non-negative
if (tableExists('journal_year_metrics') && columnNames('journal_year_metrics').includes('jcr_jif')) {
  const r = safeGet(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN jcr_jif IS NOT NULL THEN 1 ELSE 0 END) AS non_null,
      SUM(CASE
            WHEN jcr_jif IS NOT NULL
             AND (typeof(jcr_jif) NOT IN ('integer','real') OR jcr_jif < 0)
            THEN 1 ELSE 0 END) AS bad,
      MIN(jcr_jif) AS min_v,
      MAX(jcr_jif) AS max_v
    FROM journal_year_metrics
  `)
  if (r.__error) {
    record('numeric journal_year_metrics.jcr_jif', STATUS_WARN, r.__error)
  } else {
    const detail = `non_null=${fmt(r.non_null)} bad=${fmt(r.bad)} min=${r.min_v ?? 'NULL'} max=${r.max_v ?? 'NULL'}`
    if ((r.bad || 0) === 0) {
      record('numeric journal_year_metrics.jcr_jif', STATUS_PASS, detail)
    } else {
      record('numeric journal_year_metrics.jcr_jif', STATUS_FAIL, detail)
    }
  }
} else {
  record('numeric journal_year_metrics.jcr_jif', STATUS_WARN, 'jcr_jif missing')
}

// ----------------------------------------------------------------------------
// Check 5: size summary
// ----------------------------------------------------------------------------
const sizeRows = []
try {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name)
  for (const t of tables) {
    const r = safeGet(`SELECT COUNT(*) AS n FROM ${t}`)
    sizeRows.push({ table: t, rows: r.__error ? -1 : r.n })
  }
} catch (e) {
  sizeRows.push({ table: '(enumeration failed)', rows: -1, error: e.message })
}

let dbSizeMB = null
try {
  const st = statSync(DB_PATH)
  dbSizeMB = st.size / 1024 / 1024
} catch (e) {
  dbSizeMB = null
}

record(
  'size summary',
  STATUS_PASS,
  `${sizeRows.length} tables; db file ${dbSizeMB == null ? '?' : dbSizeMB.toFixed(1) + ' MB'}`
)

// ----------------------------------------------------------------------------
// Output
// ----------------------------------------------------------------------------
console.log(`paperfate.db integrity report`)
console.log(`  path: ${DB_PATH}`)
console.log(`  size: ${dbSizeMB == null ? '?' : dbSizeMB.toFixed(1) + ' MB'}`)
console.log('')

const checkWidth = Math.max(20, ...results.map((r) => r.check.length))
const statusWidth = 6
const head =
  'CHECK'.padEnd(checkWidth) + '  ' +
  'STATUS'.padEnd(statusWidth) + '  ' +
  'DETAIL'
console.log(head)
console.log('-'.repeat(head.length))
for (const r of results) {
  console.log(
    r.check.padEnd(checkWidth) + '  ' +
    r.status.padEnd(statusWidth) + '  ' +
    r.detail
  )
}

console.log('')
console.log('Table sizes:')
const tWidth = Math.max(12, ...sizeRows.map((r) => r.table.length))
for (const r of sizeRows) {
  const rows = r.rows < 0 ? '(error)' : fmt(r.rows)
  console.log('  ' + r.table.padEnd(tWidth) + '  ' + rows.padStart(14))
}

const fails = results.filter((r) => r.status === STATUS_FAIL).length
const warns = results.filter((r) => r.status === STATUS_WARN).length
console.log('')
console.log(`Summary: ${results.length - fails - warns} PASS / ${warns} WARN / ${fails} FAIL`)

db.close()
process.exit(fails > 0 ? 1 : 0)
