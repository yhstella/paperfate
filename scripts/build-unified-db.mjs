#!/usr/bin/env node
// PaperFate · build unified SQLite DB from all four sources
//
// Inputs (all under $DATA_ROOT):
//   pubmed/*.jsonl               (PMID + DOI + title + abstract + meta)
//   openalex/all-*.jsonl         (citation_count, fwci, concepts, venue, OA)
//   semantic-scholar/all-*.jsonl (s2 citation, influential, embedding, tldr)
//   crossref/all-*.jsonl         (is-referenced-by-count, license, funder)
//
// Output:  $DATA_ROOT/paperfate.db  (SQLite, indexed on doi/pmid/year/citations)
//
// Idempotent: re-running upserts by doi. Embeddings stored as Float32 BLOB
// (3072 bytes per paper = 768d × 4). For 60K papers ≈ 180MB just for vectors.
//
// Usage:
//   node scripts/build-unified-db.mjs
//   node scripts/build-unified-db.mjs --reset     # drop and rebuild

import Database from 'better-sqlite3'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

const ARGS = process.argv.slice(2)
const RESET = ARGS.includes('--reset')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  doi                          TEXT PRIMARY KEY COLLATE NOCASE,
  pmid                         TEXT,
  title                        TEXT,
  abstract                     TEXT,
  journal                      TEXT,
  issn                         TEXT,
  year                         INTEGER,
  publication_types_json       TEXT,
  mesh_terms_json              TEXT,
  authors_json                 TEXT,
  first_affiliation            TEXT,
  seeds_json                   TEXT,
  -- OpenAlex
  openalex_id                  TEXT,
  citations_openalex           INTEGER,
  fwci                         REAL,
  concepts_json                TEXT,
  primary_topic_json           TEXT,
  venue_openalex_id            TEXT,
  venue_name                   TEXT,
  venue_type                   TEXT,
  is_oa                        INTEGER,
  oa_status                    TEXT,
  authorships_json             TEXT,
  oa_publication_date          TEXT,
  -- Semantic Scholar
  s2_id                        TEXT,
  citations_s2                 INTEGER,
  influential_citations        INTEGER,
  reference_count              INTEGER,
  fields_of_study_json         TEXT,
  tldr                         TEXT,
  embedding_model              TEXT,
  embedding_dim                INTEGER,
  embedding                    BLOB,
  s2_open_access_pdf           TEXT,
  -- Crossref
  citations_crossref           INTEGER,
  license_json                 TEXT,
  funder_json                  TEXT,
  container_title              TEXT,
  publisher                    TEXT,
  cr_published_print           TEXT,
  cr_published_online          TEXT,
  -- Provenance
  fetched_pubmed_at            TEXT,
  fetched_openalex_at          TEXT,
  fetched_s2_at                TEXT,
  fetched_crossref_at          TEXT,
  -- Audit
  ingested_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pmid       ON papers(pmid);
CREATE INDEX IF NOT EXISTS idx_year       ON papers(year);
CREATE INDEX IF NOT EXISTS idx_journal    ON papers(journal);
CREATE INDEX IF NOT EXISTS idx_oa_cit     ON papers(citations_openalex);
CREATE INDEX IF NOT EXISTS idx_s2_cit     ON papers(citations_s2);
CREATE INDEX IF NOT EXISTS idx_venue_id   ON papers(venue_openalex_id);
CREATE INDEX IF NOT EXISTS idx_embedding_present ON papers(embedding_dim) WHERE embedding_dim IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingest_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT,
  file              TEXT,
  rows_seen         INTEGER,
  rows_upserted     INTEGER,
  started_at        TEXT,
  finished_at       TEXT
);

-- One row per journal/venue (OpenAlex Sources + Scimago overlay).
CREATE TABLE IF NOT EXISTS journals (
  openalex_id              TEXT PRIMARY KEY,
  issn_l                   TEXT,
  issn_json                TEXT,
  display_name             TEXT,
  alternate_titles_json    TEXT,
  type                     TEXT,
  country_code             TEXT,
  host_organization        TEXT,
  host_organization_name   TEXT,
  homepage_url             TEXT,
  works_count              INTEGER,
  cited_by_count           INTEGER,
  first_publication_year   INTEGER,
  last_publication_year    INTEGER,
  is_oa                    INTEGER,
  is_in_doaj               INTEGER,
  is_core                  INTEGER,
  apc_usd                  REAL,
  h_index                  INTEGER,
  i10_index                INTEGER,
  two_yr_mean_citedness    REAL,        -- snapshot IF proxy (current)
  topics_json              TEXT,         -- top OpenAlex topics for venue
  fetched_at               TEXT
);
CREATE INDEX IF NOT EXISTS idx_journals_issn  ON journals(issn_l);
CREATE INDEX IF NOT EXISTS idx_journals_name  ON journals(display_name);
CREATE INDEX IF NOT EXISTS idx_journals_ifproxy ON journals(two_yr_mean_citedness);

-- One row per (journal × year) — supports tracking IF-proxy drift, SJR moves,
-- quartile changes, and the real JCR JIF over time.
CREATE TABLE IF NOT EXISTS journal_year_metrics (
  openalex_id            TEXT,
  issn                   TEXT,
  year                   INTEGER,
  -- From OpenAlex counts_by_year + derived IF proxy
  works_count            INTEGER,
  cited_by_count         INTEGER,
  if_proxy_openalex      REAL,         -- our derived: cite[Y] / (works[Y-1]+works[Y-2])
  -- From Scimago for that year
  scimago_id             TEXT,
  sjr                    REAL,
  sjr_quartile           TEXT,
  scimago_h_index        INTEGER,
  total_docs_year        INTEGER,
  total_docs_3y          INTEGER,
  total_cites_3y         INTEGER,
  citable_docs_3y        INTEGER,
  cites_per_doc_2y       REAL,
  scimago_country        TEXT,
  scimago_publisher      TEXT,
  scimago_categories     TEXT,
  scimago_areas          TEXT,
  -- From JCR (Clarivate JIF) — local-only training/calibration signal.
  jcr_jif                REAL,         -- ground-truth JIF for this (journal, year)
  jcr_jif_5yr            REAL,         -- 5-Year JIF
  jcr_jif_no_self        REAL,         -- JIF without self-citations
  jci                    REAL,         -- Journal Citation Indicator
  jcr_quartile           TEXT,         -- Q1/Q2/Q3/Q4
  jcr_category           TEXT,         -- e.g., "ONCOLOGY"
  jcr_rank               INTEGER,
  jcr_total_in_category  INTEGER,
  jcr_publisher          TEXT,
  jcr_total_cites        INTEGER,
  jcr_total_articles     INTEGER,
  jcr_citable_items      INTEGER,
  jcr_source_file        TEXT,
  ingested_at            TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (openalex_id, year)
);
CREATE INDEX IF NOT EXISTS idx_jym_year  ON journal_year_metrics(year);
CREATE INDEX IF NOT EXISTS idx_jym_issn  ON journal_year_metrics(issn);
CREATE INDEX IF NOT EXISTS idx_jym_sjr   ON journal_year_metrics(sjr);
CREATE INDEX IF NOT EXISTS idx_jym_jcr_q ON journal_year_metrics(jcr_quartile);
CREATE INDEX IF NOT EXISTS idx_jym_jif   ON journal_year_metrics(jcr_jif);
`

function openDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  if (RESET) {
    db.exec('DROP TABLE IF EXISTS papers; DROP TABLE IF EXISTS journals; DROP TABLE IF EXISTS journal_year_metrics; DROP TABLE IF EXISTS ingest_runs;')
    console.log('Dropped existing tables (--reset)')
  }
  // Note: CREATE TABLE IF NOT EXISTS skips altered columns on pre-existing
  // tables. Run lightweight column-add migrations BEFORE the schema block
  // creates indexes that depend on the new columns.
  migrateAddMissingColumns(db)
  db.exec(SCHEMA)
  return db
}

// Lightweight column-only migration: ALTER TABLE ADD COLUMN if a column is
// missing. Idempotent — re-runnable.
function migrateAddMissingColumns(db) {
  const tableExists = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)
  function existingCols(table) {
    if (!tableExists(table)) return new Set()
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name))
  }
  function addColumns(table, defs) {
    if (!tableExists(table)) return
    const existing = existingCols(table)
    for (const [name, type] of defs) {
      if (existing.has(name)) continue
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
        console.log(`  migrated: ${table}.${name} ${type}`)
      } catch (e) { console.warn(`  migration skipped: ${table}.${name} (${e.message})`) }
    }
  }
  // JCR fields added 2026-05-20
  addColumns('journal_year_metrics', [
    ['jcr_jif',               'REAL'],
    ['jcr_jif_5yr',           'REAL'],
    ['jcr_jif_no_self',       'REAL'],
    ['jci',                   'REAL'],
    ['jcr_quartile',          'TEXT'],
    ['jcr_category',          'TEXT'],
    ['jcr_rank',              'INTEGER'],
    ['jcr_total_in_category', 'INTEGER'],
    ['jcr_publisher',         'TEXT'],
    ['jcr_total_cites',       'INTEGER'],
    ['jcr_total_articles',    'INTEGER'],
    ['jcr_citable_items',     'INTEGER'],
    ['jcr_source_file',       'TEXT'],
  ])
}

function listJsonl(subdir) {
  const dir = join(DATA_ROOT, subdir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f))
}

function* readJsonl(path) {
  const text = readFileSync(path, 'utf-8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { yield JSON.parse(line) } catch {}
  }
}

function logRun(db, source, file, seen, upserted, startedAt) {
  db.prepare('INSERT INTO ingest_runs (source, file, rows_seen, rows_upserted, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(source, file, seen, upserted, startedAt, new Date().toISOString())
}

// ────────────────── PubMed ingestion ──────────────────
function ingestPubMed(db) {
  const files = listJsonl('pubmed')
  if (files.length === 0) { console.log('PubMed: no files.'); return }
  const upsert = db.prepare(`
    INSERT INTO papers (
      doi, pmid, title, abstract, journal, issn, year,
      publication_types_json, mesh_terms_json, authors_json, first_affiliation,
      seeds_json, fetched_pubmed_at
    ) VALUES (
      @doi, @pmid, @title, @abstract, @journal, @issn, @year,
      @publication_types_json, @mesh_terms_json, @authors_json, @first_affiliation,
      @seeds_json, @fetched_pubmed_at
    )
    ON CONFLICT(doi) DO UPDATE SET
      pmid = COALESCE(excluded.pmid, pmid),
      title = COALESCE(excluded.title, title),
      abstract = COALESCE(excluded.abstract, abstract),
      journal = COALESCE(excluded.journal, journal),
      issn = COALESCE(excluded.issn, issn),
      year = COALESCE(excluded.year, year),
      publication_types_json = excluded.publication_types_json,
      mesh_terms_json = excluded.mesh_terms_json,
      authors_json = excluded.authors_json,
      first_affiliation = COALESCE(excluded.first_affiliation, first_affiliation),
      seeds_json = excluded.seeds_json,
      fetched_pubmed_at = excluded.fetched_pubmed_at
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    const seedOfPaper = {}   // doi → set of seeds
    // Collect seeds per DOI to merge across files
    for (const rec of readJsonl(f)) {
      seen++
      if (!rec.doi) continue
      const doi = String(rec.doi).toLowerCase()
      if (!seedOfPaper[doi]) seedOfPaper[doi] = new Set()
      if (rec.seed) seedOfPaper[doi].add(rec.seed)
    }
    db.transaction(() => {
      for (const rec of readJsonl(f)) {
        if (!rec.doi) continue
        const doi = String(rec.doi).toLowerCase()
        upsert.run({
          doi,
          pmid: rec.pmid || null,
          title: rec.title || null,
          abstract: rec.abstract || null,
          journal: rec.journal || null,
          issn: rec.issn || null,
          year: rec.year || null,
          publication_types_json: JSON.stringify(rec.publicationTypes || []),
          mesh_terms_json: JSON.stringify(rec.meshTerms || []),
          authors_json: JSON.stringify(rec.authors || []),
          first_affiliation: rec.firstAffiliation || null,
          seeds_json: JSON.stringify([...seedOfPaper[doi]]),
          fetched_pubmed_at: rec.fetched_at || startedAt,
        })
        up++
      }
    })()
    logRun(db, 'pubmed', f, seen, up, startedAt)
    console.log(`  pubmed: ${f.split(/[\\/]/).pop()}  seen=${seen} upserted=${up}`)
  }
}

// ────────────────── OpenAlex ingestion ──────────────────
function ingestOpenAlex(db) {
  const files = listJsonl('openalex')
  if (files.length === 0) { console.log('OpenAlex: no files.'); return }
  const upd = db.prepare(`
    INSERT INTO papers (
      doi, openalex_id, citations_openalex, fwci, concepts_json, primary_topic_json,
      venue_openalex_id, venue_name, venue_type, is_oa, oa_status,
      authorships_json, oa_publication_date, fetched_openalex_at
    ) VALUES (
      @doi, @openalex_id, @citations_openalex, @fwci, @concepts_json, @primary_topic_json,
      @venue_openalex_id, @venue_name, @venue_type, @is_oa, @oa_status,
      @authorships_json, @oa_publication_date, @fetched_openalex_at
    )
    ON CONFLICT(doi) DO UPDATE SET
      openalex_id = excluded.openalex_id,
      citations_openalex = excluded.citations_openalex,
      fwci = excluded.fwci,
      concepts_json = excluded.concepts_json,
      primary_topic_json = excluded.primary_topic_json,
      venue_openalex_id = excluded.venue_openalex_id,
      venue_name = excluded.venue_name,
      venue_type = excluded.venue_type,
      is_oa = excluded.is_oa,
      oa_status = excluded.oa_status,
      authorships_json = excluded.authorships_json,
      oa_publication_date = excluded.oa_publication_date,
      fetched_openalex_at = excluded.fetched_openalex_at
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    db.transaction(() => {
      for (const rec of readJsonl(f)) {
        seen++
        if (!rec.doi) continue
        const doi = String(rec.doi).toLowerCase().replace(/^https?:\/\/doi\.org\//, '')
        upd.run({
          doi,
          openalex_id: rec.openalex_id || null,
          citations_openalex: rec.cited_by_count ?? null,
          fwci: rec.fwci ?? null,
          concepts_json: JSON.stringify(rec.concepts || []),
          primary_topic_json: JSON.stringify(rec.primary_topic || null),
          venue_openalex_id: rec.venue?.id || null,
          venue_name: rec.venue?.name || null,
          venue_type: rec.venue?.type || null,
          is_oa: rec.open_access?.is_oa ? 1 : 0,
          oa_status: rec.open_access?.status || null,
          authorships_json: JSON.stringify(rec.authorships || []),
          oa_publication_date: rec.publication_date || null,
          fetched_openalex_at: rec.fetched_at || startedAt,
        })
        up++
      }
    })()
    logRun(db, 'openalex', f, seen, up, startedAt)
    console.log(`  openalex: ${f.split(/[\\/]/).pop()}  seen=${seen} upserted=${up}`)
  }
}

// ────────────────── Semantic Scholar ingestion ──────────────────
function ingestS2(db) {
  const files = listJsonl('semantic-scholar')
  if (files.length === 0) { console.log('Semantic Scholar: no files.'); return }
  const upd = db.prepare(`
    INSERT INTO papers (
      doi, s2_id, citations_s2, influential_citations, reference_count,
      fields_of_study_json, tldr, embedding_model, embedding_dim, embedding,
      s2_open_access_pdf, fetched_s2_at
    ) VALUES (
      @doi, @s2_id, @citations_s2, @influential_citations, @reference_count,
      @fields_of_study_json, @tldr, @embedding_model, @embedding_dim, @embedding,
      @s2_open_access_pdf, @fetched_s2_at
    )
    ON CONFLICT(doi) DO UPDATE SET
      s2_id = excluded.s2_id,
      citations_s2 = excluded.citations_s2,
      influential_citations = excluded.influential_citations,
      reference_count = excluded.reference_count,
      fields_of_study_json = excluded.fields_of_study_json,
      tldr = excluded.tldr,
      embedding_model = excluded.embedding_model,
      embedding_dim = excluded.embedding_dim,
      embedding = excluded.embedding,
      s2_open_access_pdf = excluded.s2_open_access_pdf,
      fetched_s2_at = excluded.fetched_s2_at
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0, embCount = 0
    db.transaction(() => {
      for (const rec of readJsonl(f)) {
        seen++
        if (!rec.doi) continue
        const doi = String(rec.doi).toLowerCase()
        let embBlob = null
        let embDim = null
        let embModel = null
        if (rec.embedding && Array.isArray(rec.embedding.vector)) {
          embDim = rec.embedding.vector.length
          embModel = rec.embedding.model
          const f32 = new Float32Array(rec.embedding.vector)
          embBlob = Buffer.from(f32.buffer)
          embCount++
        }
        upd.run({
          doi,
          s2_id: rec.s2_id || null,
          citations_s2: rec.citation_count ?? null,
          influential_citations: rec.influential_citation_count ?? null,
          reference_count: rec.reference_count ?? null,
          fields_of_study_json: JSON.stringify(rec.fields_of_study || []),
          tldr: rec.tldr || null,
          embedding_model: embModel,
          embedding_dim: embDim,
          embedding: embBlob,
          s2_open_access_pdf: rec.open_access_pdf || null,
          fetched_s2_at: rec.fetched_at || startedAt,
        })
        up++
      }
    })()
    logRun(db, 'semantic-scholar', f, seen, up, startedAt)
    console.log(`  s2: ${f.split(/[\\/]/).pop()}  seen=${seen} upserted=${up} embeddings=${embCount}`)
  }
}

// ────────────────── Crossref ingestion ──────────────────
function ingestCrossref(db) {
  const files = listJsonl('crossref')
  if (files.length === 0) { console.log('Crossref: no files.'); return }
  const upd = db.prepare(`
    INSERT INTO papers (
      doi, citations_crossref, license_json, funder_json,
      container_title, publisher, cr_published_print, cr_published_online,
      fetched_crossref_at
    ) VALUES (
      @doi, @citations_crossref, @license_json, @funder_json,
      @container_title, @publisher, @cr_published_print, @cr_published_online,
      @fetched_crossref_at
    )
    ON CONFLICT(doi) DO UPDATE SET
      citations_crossref = excluded.citations_crossref,
      license_json = excluded.license_json,
      funder_json = excluded.funder_json,
      container_title = COALESCE(excluded.container_title, container_title),
      publisher = COALESCE(excluded.publisher, publisher),
      cr_published_print = COALESCE(excluded.cr_published_print, cr_published_print),
      cr_published_online = COALESCE(excluded.cr_published_online, cr_published_online),
      fetched_crossref_at = excluded.fetched_crossref_at
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    db.transaction(() => {
      for (const rec of readJsonl(f)) {
        seen++
        if (!rec.doi) continue
        const doi = String(rec.doi).toLowerCase()
        upd.run({
          doi,
          citations_crossref: rec.is_referenced_by_count ?? null,
          license_json: JSON.stringify(rec.license || []),
          funder_json: JSON.stringify(rec.funder || []),
          container_title: rec.container_title || null,
          publisher: rec.publisher || null,
          cr_published_print: rec.published_print || null,
          cr_published_online: rec.published_online || null,
          fetched_crossref_at: rec.fetched_at || startedAt,
        })
        up++
      }
    })()
    logRun(db, 'crossref', f, seen, up, startedAt)
    console.log(`  crossref: ${f.split(/[\\/]/).pop()}  seen=${seen} upserted=${up}`)
  }
}

// ────────────────── OpenAlex Sources (journals) ingestion ──────────────────
function ingestOpenAlexSources(db) {
  const files = listJsonl('openalex-sources')
  if (files.length === 0) { console.log('OpenAlex Sources: no files.'); return }
  const upJournal = db.prepare(`
    INSERT INTO journals (
      openalex_id, issn_l, issn_json, display_name, alternate_titles_json,
      type, country_code, host_organization, host_organization_name, homepage_url,
      works_count, cited_by_count, first_publication_year, last_publication_year,
      is_oa, is_in_doaj, is_core, apc_usd,
      h_index, i10_index, two_yr_mean_citedness, topics_json, fetched_at
    ) VALUES (
      @openalex_id, @issn_l, @issn_json, @display_name, @alternate_titles_json,
      @type, @country_code, @host_organization, @host_organization_name, @homepage_url,
      @works_count, @cited_by_count, @first_publication_year, @last_publication_year,
      @is_oa, @is_in_doaj, @is_core, @apc_usd,
      @h_index, @i10_index, @two_yr_mean_citedness, @topics_json, @fetched_at
    )
    ON CONFLICT(openalex_id) DO UPDATE SET
      issn_l = excluded.issn_l, issn_json = excluded.issn_json,
      display_name = excluded.display_name, alternate_titles_json = excluded.alternate_titles_json,
      type = excluded.type, country_code = excluded.country_code,
      host_organization = excluded.host_organization,
      host_organization_name = excluded.host_organization_name,
      homepage_url = excluded.homepage_url,
      works_count = excluded.works_count, cited_by_count = excluded.cited_by_count,
      first_publication_year = excluded.first_publication_year,
      last_publication_year = excluded.last_publication_year,
      is_oa = excluded.is_oa, is_in_doaj = excluded.is_in_doaj, is_core = excluded.is_core,
      apc_usd = excluded.apc_usd,
      h_index = excluded.h_index, i10_index = excluded.i10_index,
      two_yr_mean_citedness = excluded.two_yr_mean_citedness,
      topics_json = excluded.topics_json,
      fetched_at = excluded.fetched_at
  `)
  const upYear = db.prepare(`
    INSERT INTO journal_year_metrics (
      openalex_id, issn, year, works_count, cited_by_count, if_proxy_openalex
    ) VALUES (@openalex_id, @issn, @year, @works_count, @cited_by_count, @if_proxy_openalex)
    ON CONFLICT(openalex_id, year) DO UPDATE SET
      works_count       = excluded.works_count,
      cited_by_count    = excluded.cited_by_count,
      if_proxy_openalex = excluded.if_proxy_openalex,
      issn              = COALESCE(excluded.issn, issn)
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0, yearRows = 0
    db.transaction(() => {
      for (const rec of readJsonl(f)) {
        seen++
        if (!rec.openalex_id) continue
        upJournal.run({
          openalex_id:           rec.openalex_id,
          issn_l:                rec.issn_l || null,
          issn_json:             JSON.stringify(rec.issn || []),
          display_name:          rec.display_name || null,
          alternate_titles_json: JSON.stringify(rec.alternate_titles || []),
          type:                  rec.type || null,
          country_code:          rec.country_code || null,
          host_organization:     rec.host_organization || null,
          host_organization_name:rec.host_organization_name || null,
          homepage_url:          rec.homepage_url || null,
          works_count:           rec.works_count ?? null,
          cited_by_count:        rec.cited_by_count ?? null,
          first_publication_year:rec.first_publication_year ?? null,
          last_publication_year: rec.last_publication_year ?? null,
          is_oa:                 rec.is_oa ? 1 : 0,
          is_in_doaj:            rec.is_in_doaj ? 1 : 0,
          is_core:               rec.is_core ? 1 : 0,
          apc_usd:               rec.apc_usd ?? null,
          h_index:               rec.h_index ?? null,
          i10_index:             rec.i10_index ?? null,
          two_yr_mean_citedness: rec.two_yr_mean_citedness ?? null,
          topics_json:           JSON.stringify(rec.topics || []),
          fetched_at:            rec.fetched_at || startedAt,
        })
        up++
        for (const y of (rec.yearly_if_proxy || [])) {
          upYear.run({
            openalex_id:       rec.openalex_id,
            issn:              rec.issn_l || (rec.issn?.[0] ?? null),
            year:              y.year,
            works_count:       y.works ?? null,
            cited_by_count:    y.cited_by ?? null,
            if_proxy_openalex: y.if_proxy ?? null,
          })
          yearRows++
        }
      }
    })()
    logRun(db, 'openalex-sources', f, seen, up, startedAt)
    console.log(`  openalex-sources: ${f.split(/[\\/]/).pop()}  seen=${seen} journals=${up} year_rows=${yearRows}`)
  }
}

// ────────────────── Scimago ingestion (per-year SJR + quartile) ─────────────
function ingestScimago(db) {
  const files = listJsonl('scimago')
  if (files.length === 0) { console.log('Scimago: no files.'); return }
  // Build ISSN→openalex_id map for join
  const issnToOa = new Map()
  for (const row of db.prepare('SELECT openalex_id, issn_l, issn_json FROM journals').all()) {
    if (row.issn_l) issnToOa.set(row.issn_l, row.openalex_id)
    try {
      for (const i of JSON.parse(row.issn_json || '[]')) issnToOa.set(i, row.openalex_id)
    } catch {}
  }
  console.log(`  Scimago ISSN→openalex_id map: ${issnToOa.size}`)
  const upd = db.prepare(`
    INSERT INTO journal_year_metrics (
      openalex_id, issn, year,
      scimago_id, sjr, sjr_quartile, scimago_h_index,
      total_docs_year, total_docs_3y, total_cites_3y, citable_docs_3y,
      cites_per_doc_2y, scimago_country, scimago_publisher,
      scimago_categories, scimago_areas
    ) VALUES (
      @openalex_id, @issn, @year,
      @scimago_id, @sjr, @sjr_quartile, @scimago_h_index,
      @total_docs_year, @total_docs_3y, @total_cites_3y, @citable_docs_3y,
      @cites_per_doc_2y, @scimago_country, @scimago_publisher,
      @scimago_categories, @scimago_areas
    )
    ON CONFLICT(openalex_id, year) DO UPDATE SET
      scimago_id        = excluded.scimago_id,
      sjr               = excluded.sjr,
      sjr_quartile      = excluded.sjr_quartile,
      scimago_h_index   = excluded.scimago_h_index,
      total_docs_year   = excluded.total_docs_year,
      total_docs_3y     = excluded.total_docs_3y,
      total_cites_3y    = excluded.total_cites_3y,
      citable_docs_3y   = excluded.citable_docs_3y,
      cites_per_doc_2y  = excluded.cites_per_doc_2y,
      scimago_country   = excluded.scimago_country,
      scimago_publisher = excluded.scimago_publisher,
      scimago_categories= excluded.scimago_categories,
      scimago_areas     = excluded.scimago_areas,
      issn              = COALESCE(excluded.issn, issn)
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, matched = 0, unmatched = 0
    db.transaction(() => {
      for (const rec of readJsonl(f)) {
        seen++
        const issns = rec.issns || []
        let oa = null
        for (const i of issns) if (issnToOa.has(i)) { oa = issnToOa.get(i); break }
        if (!oa) { unmatched++; continue }
        upd.run({
          openalex_id:       oa,
          issn:              issns[0] || null,
          year:              rec.year,
          scimago_id:        rec.scimago_id || null,
          sjr:               rec.sjr ?? null,
          sjr_quartile:      rec.sjr_quartile || null,
          scimago_h_index:   rec.h_index ?? null,
          total_docs_year:   rec.total_docs_year ?? null,
          total_docs_3y:     rec.total_docs_3y ?? null,
          total_cites_3y:    rec.total_cites_3y ?? null,
          citable_docs_3y:   rec.citable_docs_3y ?? null,
          cites_per_doc_2y:  rec.cites_per_doc_2y ?? null,
          scimago_country:   rec.country || null,
          scimago_publisher: rec.publisher || null,
          scimago_categories:rec.categories || null,
          scimago_areas:     rec.areas || null,
        })
        matched++
      }
    })()
    logRun(db, 'scimago', f, seen, matched, startedAt)
    console.log(`  scimago: ${f.split(/[\\/]/).pop()}  seen=${seen} matched=${matched} unmatched=${unmatched}`)
  }
}

// ────────────────── JCR JIF ingestion (per-journal × per-year IF) ──────────
function ingestJCR(db) {
  const files = listJsonl('jcr')
  if (files.length === 0) { console.log('JCR: no files. Run scripts/import-jcr.mjs first.'); return }
  // Build ISSN→openalex_id map for join (same approach as Scimago)
  const issnToOa = new Map()
  for (const row of db.prepare('SELECT openalex_id, issn_l, issn_json FROM journals').all()) {
    if (row.issn_l) issnToOa.set(row.issn_l, row.openalex_id)
    try {
      for (const i of JSON.parse(row.issn_json || '[]')) issnToOa.set(i, row.openalex_id)
    } catch {}
  }
  console.log(`  JCR ISSN→openalex_id map: ${issnToOa.size}`)
  const upd = db.prepare(`
    INSERT INTO journal_year_metrics (
      openalex_id, issn, year,
      jcr_jif, jcr_jif_5yr, jcr_jif_no_self, jci, jcr_quartile, jcr_category,
      jcr_rank, jcr_total_in_category, jcr_publisher,
      jcr_total_cites, jcr_total_articles, jcr_citable_items, jcr_source_file
    ) VALUES (
      @openalex_id, @issn, @year,
      @jcr_jif, @jcr_jif_5yr, @jcr_jif_no_self, @jci, @jcr_quartile, @jcr_category,
      @jcr_rank, @jcr_total_in_category, @jcr_publisher,
      @jcr_total_cites, @jcr_total_articles, @jcr_citable_items, @jcr_source_file
    )
    ON CONFLICT(openalex_id, year) DO UPDATE SET
      jcr_jif              = excluded.jcr_jif,
      jcr_jif_5yr          = excluded.jcr_jif_5yr,
      jcr_jif_no_self      = excluded.jcr_jif_no_self,
      jci                  = excluded.jci,
      jcr_quartile         = COALESCE(excluded.jcr_quartile, jcr_quartile),
      jcr_category         = COALESCE(excluded.jcr_category, jcr_category),
      jcr_rank             = COALESCE(excluded.jcr_rank, jcr_rank),
      jcr_total_in_category= COALESCE(excluded.jcr_total_in_category, jcr_total_in_category),
      jcr_publisher        = COALESCE(excluded.jcr_publisher, jcr_publisher),
      jcr_total_cites      = COALESCE(excluded.jcr_total_cites, jcr_total_cites),
      jcr_total_articles   = COALESCE(excluded.jcr_total_articles, jcr_total_articles),
      jcr_citable_items    = COALESCE(excluded.jcr_citable_items, jcr_citable_items),
      jcr_source_file      = excluded.jcr_source_file,
      issn                 = COALESCE(excluded.issn, issn)
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, matched = 0, unmatched = 0
    db.transaction(() => {
      for (const rec of readJsonl(f)) {
        seen++
        const candIssns = [rec.issn, rec.eissn].filter(Boolean)
        let oa = null
        for (const i of candIssns) if (issnToOa.has(i)) { oa = issnToOa.get(i); break }
        if (!oa) { unmatched++; continue }
        upd.run({
          openalex_id:           oa,
          issn:                  rec.issn || rec.eissn || null,
          year:                  rec.year,
          jcr_jif:               rec.jif ?? null,
          jcr_jif_5yr:           rec.jif_5yr ?? null,
          jcr_jif_no_self:       rec.jif_no_self ?? null,
          jci:                   rec.jci ?? null,
          jcr_quartile:          rec.jcr_quartile || null,
          jcr_category:          rec.jcr_category || null,
          jcr_rank:              rec.jcr_rank ?? null,
          jcr_total_in_category: rec.jcr_total_in_category ?? null,
          jcr_publisher:         rec.publisher || null,
          jcr_total_cites:       rec.total_cites ?? null,
          jcr_total_articles:    rec.total_articles ?? null,
          jcr_citable_items:     rec.citable_items ?? null,
          jcr_source_file:       rec.source_file || null,
        })
        matched++
      }
    })()
    logRun(db, 'jcr', f, seen, matched, startedAt)
    console.log(`  jcr: ${f.split(/[\\/]/).pop()}  seen=${seen} matched=${matched} unmatched=${unmatched}`)
  }
}

function summary(db) {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                  AS total,
      SUM(CASE WHEN pmid IS NOT NULL THEN 1 ELSE 0 END) AS with_pmid,
      SUM(CASE WHEN openalex_id IS NOT NULL THEN 1 ELSE 0 END) AS with_openalex,
      SUM(CASE WHEN s2_id IS NOT NULL THEN 1 ELSE 0 END) AS with_s2,
      SUM(CASE WHEN citations_crossref IS NOT NULL THEN 1 ELSE 0 END) AS with_crossref,
      SUM(CASE WHEN embedding_dim IS NOT NULL THEN 1 ELSE 0 END) AS with_embedding,
      ROUND(AVG(citations_openalex), 1) AS avg_oa_citations
    FROM papers
  `).get()
  const jrow = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM journals)                  AS journals,
      (SELECT COUNT(*) FROM journal_year_metrics)      AS journal_year_rows,
      (SELECT COUNT(DISTINCT year) FROM journal_year_metrics) AS years_covered,
      (SELECT COUNT(*) FROM journal_year_metrics WHERE sjr IS NOT NULL) AS scimago_rows,
      (SELECT COUNT(*) FROM journal_year_metrics WHERE jcr_jif IS NOT NULL) AS jcr_rows,
      (SELECT COUNT(DISTINCT openalex_id) FROM journal_year_metrics WHERE jcr_jif IS NOT NULL) AS journals_with_jcr,
      (SELECT ROUND(AVG(two_yr_mean_citedness), 2) FROM journals WHERE two_yr_mean_citedness IS NOT NULL) AS avg_if_proxy,
      (SELECT ROUND(AVG(jcr_jif), 2) FROM journal_year_metrics WHERE jcr_jif IS NOT NULL) AS avg_jcr_jif
  `).get()
  console.log('\n── DB summary (papers) ──')
  for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(24)} ${v}`)
  console.log('\n── DB summary (journals) ──')
  for (const [k, v] of Object.entries(jrow)) console.log(`  ${k.padEnd(24)} ${v}`)
  console.log(`  DB file size              ${(statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB`)
}

async function main() {
  console.log(`PaperFate · build-unified-db`)
  console.log(`DATA_ROOT: ${DATA_ROOT}`)
  console.log(`DB:        ${DB_PATH}\n`)

  const db = openDb()
  const started = Date.now()

  console.log('── ingesting PubMed ──')
  ingestPubMed(db)
  console.log('── ingesting OpenAlex ──')
  ingestOpenAlex(db)
  console.log('── ingesting Semantic Scholar ──')
  ingestS2(db)
  console.log('── ingesting Crossref ──')
  ingestCrossref(db)
  console.log('── ingesting OpenAlex Sources (journals) ──')
  ingestOpenAlexSources(db)
  console.log('── ingesting Scimago ──')
  ingestScimago(db)
  console.log('── ingesting JCR JIF ──')
  ingestJCR(db)

  summary(db)
  console.log(`\nTotal elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`)
  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
