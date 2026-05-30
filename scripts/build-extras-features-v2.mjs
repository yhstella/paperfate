#!/usr/bin/env node
// Build per-paper reference-derived + coauthor-derived feature table:
//   table: paper_extras_v2
//
// Columns:
//   doi                          TEXT PRIMARY KEY COLLATE NOCASE
//   refs_count                   INTEGER
//   refs_jif_mean                REAL
//   refs_jif_median              REAL
//   refs_jif_top5_share          REAL    -- share of references whose JIF >= top5 cutoff (default 20)
//   refs_to_NEJM_class_count     INTEGER -- references with JIF >= 40 (NEJM/Lancet/JAMA/Nature/Science class)
//   refs_mean_year_gap           REAL    -- mean(source_year - ref_year) over refs with year
//   coauthor_max_h               INTEGER
//   coauthor_top3_h_mean         REAL
//   coauthor_count_h_gt_50       INTEGER
//   author_tier0_pubs            INTEGER -- count of co-authors with h_index >= 70 (tier 0)
//   author_tier1_pubs            INTEGER -- count of co-authors with h_index >= 40 and < 70 (tier 1)
//   computed_at                  TEXT
//
// This script is READ-ONLY against:
//   papers, paper_references, authors, journals, journal_year_metrics
// and writes only to paper_extras_v2.
//
// Usage:
//   node scripts/build-extras-features-v2.mjs
//   node scripts/build-extras-features-v2.mjs --limit=1000
//   node scripts/build-extras-features-v2.mjs --force        # recompute existing rows
//   node scripts/build-extras-features-v2.mjs --rebuild      # DROP & recreate table
//   DATA_ROOT=E:/paperfate/data node scripts/build-extras-features-v2.mjs

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const LIMIT = Number(arg('limit', '0'))
const BATCH_SIZE = Number(arg('batch', '1000'))
const FORCE = ARGS.includes('--force')
const REBUILD = ARGS.includes('--rebuild')

// Tunable thresholds — kept explicit so trainers / docs stay aligned with code.
const TOP5_JIF_CUTOFF = Number(arg('top5-cutoff', '20'))     // "top 5%" JIF proxy
const NEJM_CLASS_JIF_CUTOFF = Number(arg('nejm-cutoff', '40')) // NEJM/Lancet/JAMA/Nature/Science class
const COAUTHOR_H_GT_THRESHOLD = Number(arg('h-gt', '50'))      // count_h_gt_50
const TIER0_H = Number(arg('tier0-h', '70'))                   // h-index ≥70: tier 0
const TIER1_H = Number(arg('tier1-h', '40'))                   // h-index ≥40 and <tier0: tier 1
const IF_PROXY_SCALE = Number(arg('if-proxy-scale', '1.0'))    // multiplicative fallback factor

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function mean(values) {
  if (!values.length) return null
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

function parseJsonArray(text) {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeOpenAlexAuthorId(value) {
  if (!value) return null
  if (typeof value === 'object') {
    value = value.id || value.openalex_id || value.openalex_url || value.author_id
  }
  if (!value) return null
  const s = String(value).trim()
  const m = s.match(/(?:openalex\.org\/)?(A\d+)/i)
  return m ? m[1].toUpperCase() : null
}

function normalizeOpenAlexWorkId(value) {
  if (!value) return null
  const s = String(value).trim()
  const m = s.match(/(?:openalex\.org\/)?(W\d+)/i)
  return m ? m[1].toUpperCase() : null
}

function authorshipId(authorship) {
  return normalizeOpenAlexAuthorId(
    authorship?.author_id ||
    authorship?.author?.id ||
    authorship?.id ||
    authorship?.openalex_id,
  )
}

// ----------------------------------------------------------------------------
// schema
// ----------------------------------------------------------------------------

const EXTRAS_COLUMNS = [
  ['refs_count',                'INTEGER'],
  ['refs_jif_mean',             'REAL'],
  ['refs_jif_median',           'REAL'],
  ['refs_jif_top5_share',       'REAL'],
  ['refs_to_NEJM_class_count',  'INTEGER'],
  ['refs_mean_year_gap',        'REAL'],
  ['coauthor_max_h',            'INTEGER'],
  ['coauthor_top3_h_mean',      'REAL'],
  ['coauthor_count_h_gt_50',    'INTEGER'],
  ['author_tier0_pubs',         'INTEGER'],
  ['author_tier1_pubs',         'INTEGER'],
]

function tableExists(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
}

function existingCols(db, table) {
  if (!tableExists(db, table)) return new Set()
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name))
}

function ensureSchema(db) {
  if (REBUILD && tableExists(db, 'paper_extras_v2')) {
    db.exec('DROP TABLE paper_extras_v2')
    console.log('  dropped: paper_extras_v2 (--rebuild)')
  }
  if (!tableExists(db, 'paper_extras_v2')) {
    const colDefs = EXTRAS_COLUMNS.map(([n, t]) => `${n} ${t}`).join(',\n      ')
    db.exec(`
      CREATE TABLE paper_extras_v2 (
        doi TEXT PRIMARY KEY COLLATE NOCASE,
        ${colDefs},
        computed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_extras_v2_refs_count ON paper_extras_v2(refs_count);
      CREATE INDEX IF NOT EXISTS idx_extras_v2_coauthor_max_h ON paper_extras_v2(coauthor_max_h);
    `)
    console.log('  created: paper_extras_v2')
  } else {
    // augment if existing schema is missing any columns (idempotent migration)
    const cur = existingCols(db, 'paper_extras_v2')
    for (const [name, type] of EXTRAS_COLUMNS) {
      if (cur.has(name)) continue
      try {
        db.exec(`ALTER TABLE paper_extras_v2 ADD COLUMN ${name} ${type}`)
        console.log(`  migrated: paper_extras_v2.${name} ${type}`)
      } catch (e) {
        console.warn(`  migration skipped: paper_extras_v2.${name} (${e.message})`)
      }
    }
    if (!cur.has('computed_at')) {
      try { db.exec(`ALTER TABLE paper_extras_v2 ADD COLUMN computed_at TEXT`) } catch {}
    }
  }
}

// ----------------------------------------------------------------------------
// lookups
// ----------------------------------------------------------------------------

function loadAuthorH(db) {
  console.log('Loading author h_index map...')
  const t0 = Date.now()
  const map = new Map()
  const rows = db.prepare(`
    SELECT openalex_id, h_index
    FROM authors
    WHERE openalex_id IS NOT NULL AND openalex_id != ''
  `).iterate()
  for (const r of rows) {
    const id = normalizeOpenAlexAuthorId(r.openalex_id)
    if (!id) continue
    const h = Number(r.h_index)
    map.set(id, Number.isFinite(h) ? h : null)
  }
  console.log(`  authors loaded: ${map.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return map
}

function loadWorkVenueYear(db) {
  console.log('Loading W-id → (venue_openalex_id, year) map...')
  const t0 = Date.now()
  const map = new Map()
  const rows = db.prepare(`
    SELECT openalex_id, venue_openalex_id, year
    FROM papers
    WHERE openalex_id IS NOT NULL AND openalex_id != ''
  `).iterate()
  for (const r of rows) {
    const id = normalizeOpenAlexWorkId(r.openalex_id)
    if (!id) continue
    const y = Number(r.year)
    map.set(id, {
      venue: r.venue_openalex_id || null,
      year: Number.isFinite(y) ? y : null,
    })
  }
  console.log(`  works loaded: ${map.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return map
}

function loadVenueYearJif(db) {
  console.log('Loading (venue, year) → jcr_jif map...')
  const t0 = Date.now()
  const map = new Map()
  const rows = db.prepare(`
    SELECT openalex_id, year, jcr_jif
    FROM journal_year_metrics
    WHERE openalex_id IS NOT NULL AND year IS NOT NULL AND jcr_jif IS NOT NULL
  `).iterate()
  for (const r of rows) {
    map.set(`${r.openalex_id}|${r.year}`, Number(r.jcr_jif))
  }
  console.log(`  (venue,year,jcr_jif) loaded: ${map.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return map
}

function loadVenueIfProxy(db) {
  console.log('Loading venue → two_yr_mean_citedness fallback map...')
  const t0 = Date.now()
  const map = new Map()
  const rows = db.prepare(`
    SELECT openalex_id, two_yr_mean_citedness
    FROM journals
    WHERE openalex_id IS NOT NULL AND two_yr_mean_citedness IS NOT NULL
  `).iterate()
  for (const r of rows) {
    const v = Number(r.two_yr_mean_citedness)
    if (Number.isFinite(v)) map.set(r.openalex_id, v)
  }
  console.log(`  venue IF-proxy loaded: ${map.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return map
}

// ----------------------------------------------------------------------------
// per-paper computation
// ----------------------------------------------------------------------------

function jifForRef(refWid, workMap, venueYearJif, venueIfProxy) {
  const ref = workMap.get(refWid)
  if (!ref) return { jif: null, year: null }
  let jif = null
  if (ref.venue && ref.year != null) {
    const key = `${ref.venue}|${ref.year}`
    if (venueYearJif.has(key)) jif = venueYearJif.get(key)
  }
  if (jif == null && ref.venue && venueIfProxy.has(ref.venue)) {
    jif = venueIfProxy.get(ref.venue) * IF_PROXY_SCALE
  }
  return { jif, year: ref.year }
}

function computeRow(paper, refsForDoi, authorH, workMap, venueYearJif, venueIfProxy) {
  // -- reference-side features --
  let refs_count = refsForDoi.length
  const jifs = []
  const yearGaps = []
  let nejmClass = 0
  let top5Hits = 0
  const sourceYear = Number(paper?.year)
  const sourceYearFinite = Number.isFinite(sourceYear)

  for (const refWid of refsForDoi) {
    const { jif, year } = jifForRef(refWid, workMap, venueYearJif, venueIfProxy)
    if (jif != null && Number.isFinite(jif)) {
      jifs.push(jif)
      if (jif >= NEJM_CLASS_JIF_CUTOFF) nejmClass++
      if (jif >= TOP5_JIF_CUTOFF) top5Hits++
    }
    if (sourceYearFinite && Number.isFinite(year)) {
      yearGaps.push(sourceYear - year)
    }
  }

  const refs_jif_mean = jifs.length ? mean(jifs) : null
  const refs_jif_median = jifs.length ? median(jifs) : null
  const refs_jif_top5_share = jifs.length ? top5Hits / jifs.length : null
  const refs_to_NEJM_class_count = jifs.length ? nejmClass : (refs_count ? 0 : null)
  const refs_mean_year_gap = yearGaps.length ? mean(yearGaps) : null

  // -- coauthor-side features --
  const authorships = parseJsonArray(paper?.authorships_json)
  const hValues = []
  let tier0 = 0
  let tier1 = 0
  let countHgt = 0
  for (const a of authorships) {
    const aid = authorshipId(a)
    if (!aid) continue
    const h = authorH.get(aid)
    if (h == null || !Number.isFinite(h)) continue
    hValues.push(h)
    if (h >= TIER0_H) tier0++
    else if (h >= TIER1_H) tier1++
    if (h > COAUTHOR_H_GT_THRESHOLD) countHgt++
  }
  const coauthor_max_h = hValues.length ? Math.max(...hValues) : null
  let coauthor_top3_h_mean = null
  if (hValues.length) {
    const top3 = [...hValues].sort((a, b) => b - a).slice(0, 3)
    coauthor_top3_h_mean = mean(top3)
  }
  const coauthor_count_h_gt_50 = hValues.length ? countHgt : null
  const author_tier0_pubs = authorships.length ? tier0 : null
  const author_tier1_pubs = authorships.length ? tier1 : null

  return {
    refs_count,
    refs_jif_mean,
    refs_jif_median,
    refs_jif_top5_share,
    refs_to_NEJM_class_count,
    refs_mean_year_gap,
    coauthor_max_h,
    coauthor_top3_h_mean,
    coauthor_count_h_gt_50,
    author_tier0_pubs,
    author_tier1_pubs,
  }
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

function main() {
  if (!existsSync(DB_PATH)) throw new Error(`DB not found: ${DB_PATH}`)
  console.log('PaperFate paper_extras_v2 feature builder')
  console.log(`DB:   ${DB_PATH}`)
  console.log(`Args: limit=${LIMIT || 'none'} batch=${BATCH_SIZE} force=${FORCE} rebuild=${REBUILD}`)
  console.log(`Cutoffs: top5_jif=${TOP5_JIF_CUTOFF} nejm_jif=${NEJM_CLASS_JIF_CUTOFF} h_gt=${COAUTHOR_H_GT_THRESHOLD} tier0_h=${TIER0_H} tier1_h=${TIER1_H}`)

  const readDb = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  readDb.pragma('busy_timeout = 60000')
  readDb.pragma('query_only = ON')

  const writeDb = new Database(DB_PATH, { fileMustExist: true, timeout: 60000 })
  writeDb.pragma('journal_mode = WAL')
  writeDb.pragma('busy_timeout = 60000')
  writeDb.pragma('synchronous = NORMAL')

  ensureSchema(writeDb)

  const authorH = loadAuthorH(readDb)
  const workMap = loadWorkVenueYear(readDb)
  const venueYearJif = loadVenueYearJif(readDb)
  const venueIfProxy = loadVenueIfProxy(readDb)

  // candidate DOIs: papers that either have references OR an authorships_json
  // (the AND-of-OR keeps coverage broad without forcing both signals).
  const whereParts = [
    "p.doi IS NOT NULL",
    "p.doi != ''",
    "(EXISTS (SELECT 1 FROM paper_references pr WHERE pr.doi = p.doi) OR (p.authorships_json IS NOT NULL AND p.authorships_json != ''))",
  ]
  if (!FORCE && !REBUILD) {
    whereParts.push(`NOT EXISTS (SELECT 1 FROM paper_extras_v2 e WHERE e.doi = p.doi)`)
  }
  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : ''
  const sql = `
    SELECT p.doi AS doi, p.year AS year, p.authorships_json AS authorships_json
    FROM papers p
    WHERE ${whereParts.join(' AND ')}
    ORDER BY p.doi
    ${limitClause}
  `
  const rows = readDb.prepare(sql).iterate()

  const refQuery = readDb.prepare(`SELECT ref_openalex_id FROM paper_references WHERE doi = ?`)

  const cols = EXTRAS_COLUMNS.map(([n]) => n)
  const insert = writeDb.prepare(`
    INSERT INTO paper_extras_v2 (doi, ${cols.join(', ')}, computed_at)
    VALUES (@doi, ${cols.map(c => `@${c}`).join(', ')}, datetime('now'))
    ON CONFLICT(doi) DO UPDATE SET
      ${cols.map(c => `${c} = excluded.${c}`).join(',\n      ')},
      computed_at = datetime('now')
  `)
  const writeBatch = writeDb.transaction(batch => {
    for (const r of batch) insert.run(r)
  })

  const t0 = Date.now()
  let seen = 0
  let written = 0
  let withRefs = 0
  let withCoauthors = 0
  let batch = []

  for (const row of rows) {
    seen++
    const doi = row.doi
    const refRows = refQuery.all(doi).map(r => normalizeOpenAlexWorkId(r.ref_openalex_id)).filter(Boolean)
    const feats = computeRow(row, refRows, authorH, workMap, venueYearJif, venueIfProxy)
    if (feats.refs_count > 0) withRefs++
    if (feats.coauthor_max_h != null) withCoauthors++
    batch.push({ doi, ...feats })
    if (batch.length >= BATCH_SIZE) {
      writeBatch(batch)
      written += batch.length
      batch = []
      if (written % (BATCH_SIZE * 10) === 0) {
        const elapsed = (Date.now() - t0) / 1000
        const rate = written / elapsed
        console.log(
          `  seen=${seen.toLocaleString()} written=${written.toLocaleString()} ` +
          `with_refs=${withRefs.toLocaleString()} with_coauthors=${withCoauthors.toLocaleString()} ` +
          `rate=${rate.toFixed(0)} papers/s`,
        )
      }
    }
  }
  if (batch.length) {
    writeBatch(batch)
    written += batch.length
    batch = []
  }

  const elapsed = (Date.now() - t0) / 1000
  console.log('\nDone.')
  console.log(`  seen:           ${seen.toLocaleString()}`)
  console.log(`  written:        ${written.toLocaleString()}`)
  console.log(`  with_refs:      ${withRefs.toLocaleString()}`)
  console.log(`  with_coauthors: ${withCoauthors.toLocaleString()}`)
  console.log(`  elapsed:        ${elapsed.toFixed(1)}s`)

  const finalCount = readDb.prepare(`SELECT COUNT(*) n FROM paper_extras_v2`).get().n
  console.log(`  table rows now: ${finalCount.toLocaleString()}`)

  readDb.close()
  writeDb.close()
}

main()
