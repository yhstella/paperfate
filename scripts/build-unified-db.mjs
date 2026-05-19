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
`

function openDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  if (RESET) {
    db.exec('DROP TABLE IF EXISTS papers; DROP TABLE IF EXISTS ingest_runs;')
    console.log('Dropped existing tables (--reset)')
  }
  db.exec(SCHEMA)
  return db
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
  console.log('\n── DB summary ──')
  for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(24)} ${v}`)
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

  summary(db)
  console.log(`\nTotal elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`)
  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
