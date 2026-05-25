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
import { closeSync, createReadStream, openSync, readFileSync, readSync, readdirSync, existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

const ARGS = process.argv.slice(2)
const RESET = ARGS.includes('--reset')
// --only=authors,icite,unpaywall,clinicaltrials,pmc,epmc,pdf,biorxiv,pubmed,openalex,s2,crossref,sources,scimago,jcr
const ONLY = (() => {
  const arg = ARGS.find(a => a.startsWith('--only='))
  if (!arg) return null
  return new Set(arg.split('=')[1].split(',').map(s => s.trim().toLowerCase()))
})()
const shouldRun = (name) => !ONLY || ONLY.has(name)

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
  history_received_date        TEXT,
  history_accepted_date        TEXT,
  history_epublish_date        TEXT,
  history_pubmed_date          TEXT,
  history_revised_date         TEXT,
  review_days_received_to_accepted INTEGER,
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
  first_author_h_index         INTEGER,
  last_author_h_index          INTEGER,
  max_team_h_index             INTEGER,
  median_team_h_index          REAL,
  team_size_with_id            INTEGER,
  international_collab         INTEGER,
  fetched_authors_at           TEXT,
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
CREATE INDEX IF NOT EXISTS idx_pmcid      ON papers(pmcid);
CREATE INDEX IF NOT EXISTS idx_year       ON papers(year);
CREATE INDEX IF NOT EXISTS idx_history_received ON papers(history_received_date);
CREATE INDEX IF NOT EXISTS idx_review_days_received_to_accepted ON papers(review_days_received_to_accepted);
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
  const db = new Database(DB_PATH, { timeout: 60000 })  // 60s busy_timeout — wait for concurrent writers
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('busy_timeout = 60000')
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
  // SchemaD additional fields (richer JCR direct exports)
  addColumns('journal_year_metrics', [
    ['eigenfactor',            'REAL'],
    ['normalized_eigenfactor', 'REAL'],
    ['article_influence',      'REAL'],
    ['immediacy_index',        'REAL'],
    ['jci_percentile',         'REAL'],
    ['jif_5yr_quartile',       'TEXT'],
    ['jcr_edition',            'TEXT'],
  ])
  // PubMed publication history dates (2026-05-25)
  addColumns('papers', [
    ['history_received_date',                 'TEXT'],
    ['history_accepted_date',                 'TEXT'],
    ['history_epublish_date',                 'TEXT'],
    ['history_pubmed_date',                   'TEXT'],
    ['history_revised_date',                  'TEXT'],
    ['review_days_received_to_accepted',      'INTEGER'],
  ])
  if (tableExists('papers')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_received ON papers(history_received_date);
      CREATE INDEX IF NOT EXISTS idx_review_days_received_to_accepted ON papers(review_days_received_to_accepted);
    `)
  }
  // iCite (NIH-curated citation metrics, 2026-05-21)
  addColumns('papers', [
    ['icite_rcr',                      'REAL'],
    ['icite_nih_percentile',           'REAL'],
    ['icite_citation_count',           'INTEGER'],
    ['icite_citations_per_year',       'REAL'],
    ['icite_expected_cit_per_year',    'REAL'],
    ['icite_field_citation_rate',      'REAL'],
    ['icite_is_clinical',              'INTEGER'],
    ['icite_is_research_article',      'INTEGER'],
    ['icite_apt',                      'REAL'],
    ['icite_cited_by_clin',            'INTEGER'],
    ['fetched_icite_at',               'TEXT'],
  ])
  // Unpaywall OA metadata (2026-05-21)
  addColumns('papers', [
    ['unpaywall_is_oa',          'INTEGER'],
    ['unpaywall_oa_status',      'TEXT'],
    ['unpaywall_best_oa_url',    'TEXT'],
    ['unpaywall_best_oa_host',   'TEXT'],
    ['unpaywall_best_oa_version','TEXT'],
    ['unpaywall_best_oa_license','TEXT'],
    ['unpaywall_journal_oa',     'INTEGER'],
    ['unpaywall_journal_doaj',   'INTEGER'],
    ['fetched_unpaywall_at',     'TEXT'],
  ])
  // PMC OA full-text features (2026-05-21)
  addColumns('papers', [
    ['pmcid',                  'TEXT'],
    ['pmc_body_word_count',    'INTEGER'],
    ['pmc_section_count',      'INTEGER'],
    ['pmc_figure_count',       'INTEGER'],
    ['pmc_table_count',        'INTEGER'],
    ['pmc_ref_count',          'INTEGER'],
    ['pmc_has_data_avail',     'INTEGER'],
    ['pmc_has_ethics',         'INTEGER'],
    ['pmc_has_coi',            'INTEGER'],
    ['fetched_pmc_at',         'TEXT'],
  ])
  // Europe PMC full-text features (2026-05-21)
  addColumns('papers', [
    ['epmc_body_word_count',   'INTEGER'],
    ['epmc_section_count',     'INTEGER'],
    ['epmc_figure_count',      'INTEGER'],
    ['epmc_ref_count',         'INTEGER'],
    ['fetched_epmc_at',        'TEXT'],
  ])
  // PDF text extraction (Unpaywall PDFs, 2026-05-21)
  addColumns('papers', [
    ['pdf_body_chars',         'INTEGER'],
    ['pdf_body_words',         'INTEGER'],
    ['pdf_num_pages',          'INTEGER'],
    ['pdf_source_url',         'TEXT'],
    ['fetched_pdf_at',         'TEXT'],
  ])
  // bioRxiv/medRxiv preprint linkage (2026-05-21)
  addColumns('papers', [
    ['preprint_server',           'TEXT'],
    ['preprint_doi',              'TEXT'],
    ['preprint_published_date',   'TEXT'],
    ['preprint_pub_gap_days',     'INTEGER'],
    ['fetched_preprint_at',       'TEXT'],
  ])
  // OpenAlex author-derived production features (2026-05-21)
  addColumns('papers', [
    ['first_author_h_index',   'INTEGER'],
    ['last_author_h_index',    'INTEGER'],
    ['max_team_h_index',       'INTEGER'],
    ['median_team_h_index',    'REAL'],
    ['team_size_with_id',      'INTEGER'],
    ['international_collab',   'INTEGER'],
    ['fetched_authors_at',     'TEXT'],
  ])
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='authors'`).get()) {
    db.exec(`
      CREATE TABLE authors (
        openalex_id              TEXT PRIMARY KEY,
        orcid                    TEXT,
        display_name             TEXT,
        works_count              INTEGER,
        cited_by_count           INTEGER,
        h_index                  INTEGER,
        i10_index                INTEGER,
        two_yr_mean_citedness    REAL,
        affiliations_json        TEXT,
        last_known_country       TEXT,
        fetched_at               TEXT,
        ingested_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_authors_h ON authors(h_index);
      CREATE INDEX IF NOT EXISTS idx_authors_country ON authors(last_known_country);
    `)
    console.log('  created: authors table')
  }
  // paper_scores — per-paper × per-Q500-item score storage (2026-05-21)
  // Mode: rule | external | llm | hybrid
  // Created by scripts/score-rubric.mjs (rule + external) and forecast pipeline (llm)
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_scores'`).get()) {
    db.exec(`
      CREATE TABLE paper_scores (
        doi          TEXT NOT NULL,
        item_id      TEXT NOT NULL,        -- e.g. "QUEST_001"
        score        REAL,                 -- normalized 0..5 (Q500 6-level rubric)
        raw_value    TEXT,                 -- extracted raw (number/string/bool as JSON)
        mode         TEXT NOT NULL,        -- rule | external | llm | hybrid | codex_deterministic
        confidence   REAL,                 -- 0..1
        evidence     TEXT,                 -- text snippet (≤200 chars)
        scored_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (doi, item_id, mode)
      );
      CREATE INDEX IF NOT EXISTS idx_scores_doi ON paper_scores(doi);
      CREATE INDEX IF NOT EXISTS idx_scores_item ON paper_scores(item_id);
      CREATE INDEX IF NOT EXISTS idx_scores_mode ON paper_scores(mode);
    `)
    console.log('  created: paper_scores table')
  }
  // ClinicalTrials.gov gets its own table (one paper can cite multiple NCTs;
  // join via pubmed_nct_link many-to-many)
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='clinical_trials'`).get()) {
    db.exec(`
      CREATE TABLE clinical_trials (
        nct_id              TEXT PRIMARY KEY,
        brief_title         TEXT,
        study_type          TEXT,
        phases_json         TEXT,
        enrollment          INTEGER,
        enrollment_type     TEXT,
        allocation          TEXT,
        intervention_model  TEXT,
        masking             TEXT,
        overall_status      TEXT,
        start_date          TEXT,
        primary_completion_date TEXT,
        completion_date     TEXT,
        last_update_post_date TEXT,
        has_results         INTEGER,
        sponsor_name        TEXT,
        sponsor_class       TEXT,
        conditions_json     TEXT,
        interventions_json  TEXT,
        primary_outcomes_json   TEXT,
        secondary_outcomes_json TEXT,
        fetched_at          TEXT,
        ingested_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ct_status ON clinical_trials(overall_status);
      CREATE INDEX IF NOT EXISTS idx_ct_sponsor_class ON clinical_trials(sponsor_class);
    `)
    console.log('  created: clinical_trials table')
  }
}

function listJsonl(subdir) {
  const dir = join(DATA_ROOT, subdir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f))
}

function* readJsonl(path) {
  const fd = openSync(path, 'r')
  const decoder = new StringDecoder('utf8')
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
  let pending = ''
  const MAX_LINE = 100 * 1024 * 1024  // 100 MB per line cap (corrupted/oversized line guard)
  let skipped = 0
  try {
    while (true) {
      const bytes = readSync(fd, buf, 0, buf.length, null)
      if (bytes === 0) break
      pending += decoder.write(buf.subarray(0, bytes))
      // Safety: if pending too large without newline → skip + reset
      if (pending.length > MAX_LINE) {
        // find next \n to recover
        const nlIdx = pending.indexOf('\n')
        if (nlIdx >= 0) {
          pending = pending.slice(nlIdx + 1)
          skipped++
        } else {
          // no newline in entire buffer — discard
          pending = ''
          skipped++
          continue
        }
      }
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try { yield JSON.parse(line) } catch {}
      }
    }
    pending += decoder.end()
    if (pending.trim() && pending.length < MAX_LINE) {
      try { yield JSON.parse(pending) } catch {}
    }
    if (skipped > 0) console.warn(`  ⚠ skipped ${skipped} oversized line(s) in ${path}`)
  } finally {
    closeSync(fd)
  }
}

async function* readJsonlStream(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (!line.trim()) continue
    try { yield JSON.parse(line) } catch {}
  }
}

function logRun(db, source, file, seen, upserted, startedAt) {
  db.prepare('INSERT INTO ingest_runs (source, file, rows_seen, rows_upserted, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(source, file, seen, upserted, startedAt, new Date().toISOString())
}

function normalizeOpenAlexAuthorId(id) {
  if (!id) return null
  const m = String(id).match(/(?:https?:\/\/openalex\.org\/)?(A\d+)/i)
  return m ? m[1].toUpperCase() : null
}

function parseJsonArray(text) {
  if (!text) return []
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function median(values) {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

function normalizeIsoDate(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function daysBetweenIsoDates(start, end) {
  if (!start || !end) return null
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const days = Math.round((b - a) / 86400000)
  return days > 0 && days <= 3650 ? days : null
}

function historyFields(history = {}) {
  const received = normalizeIsoDate(history.received)
  const accepted = normalizeIsoDate(history.accepted)
  const epublish = normalizeIsoDate(history.epublish || history.aheadofprint)
  const pubmed = normalizeIsoDate(history.pubmed)
  const revised = normalizeIsoDate(history.revised)
  return {
    history_received_date: received,
    history_accepted_date: accepted,
    history_epublish_date: epublish,
    history_pubmed_date: pubmed,
    history_revised_date: revised,
    review_days_received_to_accepted: daysBetweenIsoDates(received, accepted),
  }
}

// ────────────────── PubMed ingestion ──────────────────
function ingestPubMed(db) {
  const files = listJsonl('pubmed')
  if (files.length === 0) { console.log('PubMed: no files.'); return }
  const upsert = db.prepare(`
    INSERT INTO papers (
      doi, pmid, title, abstract, journal, issn, year,
      publication_types_json, mesh_terms_json, authors_json, first_affiliation,
      seeds_json,
      history_received_date, history_accepted_date, history_epublish_date,
      history_pubmed_date, history_revised_date, review_days_received_to_accepted,
      fetched_pubmed_at
    ) VALUES (
      @doi, @pmid, @title, @abstract, @journal, @issn, @year,
      @publication_types_json, @mesh_terms_json, @authors_json, @first_affiliation,
      @seeds_json,
      @history_received_date, @history_accepted_date, @history_epublish_date,
      @history_pubmed_date, @history_revised_date, @review_days_received_to_accepted,
      @fetched_pubmed_at
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
      history_received_date = COALESCE(excluded.history_received_date, history_received_date),
      history_accepted_date = COALESCE(excluded.history_accepted_date, history_accepted_date),
      history_epublish_date = COALESCE(excluded.history_epublish_date, history_epublish_date),
      history_pubmed_date = COALESCE(excluded.history_pubmed_date, history_pubmed_date),
      history_revised_date = COALESCE(excluded.history_revised_date, history_revised_date),
      review_days_received_to_accepted = COALESCE(excluded.review_days_received_to_accepted, review_days_received_to_accepted),
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
        const hist = historyFields(rec.history || {})
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
          ...hist,
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
async function ingestOpenAlex(db) {
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
    const writeBatch = db.transaction((rows) => {
      for (const rec of rows) {
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
      }
    })
    let seen = 0, up = 0
    let batch = []
    for await (const rec of readJsonlStream(f)) {
      seen++
      if (!rec.doi) continue
      batch.push(rec)
      if (batch.length >= 5000) {
        writeBatch(batch)
        up += batch.length
        batch = []
      }
    }
    if (batch.length) {
      writeBatch(batch)
      up += batch.length
    }
    logRun(db, 'openalex', f, seen, up, startedAt)
    console.log(`  openalex: ${f.split(/[\\/]/).pop()}  seen=${seen} upserted=${up}`)
  }
}

// ────────────────── Semantic Scholar ingestion ──────────────────
// OpenAlex Authors ingestion.
async function ingestAuthors(db) {
  const files = listJsonl('openalex-authors')
  if (files.length === 0) { console.log('OpenAlex Authors: no files.'); return }

  const upsert = db.prepare(`
    INSERT INTO authors (
      openalex_id, orcid, display_name, works_count, cited_by_count,
      h_index, i10_index, two_yr_mean_citedness,
      affiliations_json, last_known_country, fetched_at
    ) VALUES (
      @openalex_id, @orcid, @display_name, @works_count, @cited_by_count,
      @h_index, @i10_index, @two_yr_mean_citedness,
      @affiliations_json, @last_known_country, @fetched_at
    )
    ON CONFLICT(openalex_id) DO UPDATE SET
      orcid = COALESCE(excluded.orcid, orcid),
      display_name = COALESCE(excluded.display_name, display_name),
      works_count = COALESCE(excluded.works_count, works_count),
      cited_by_count = COALESCE(excluded.cited_by_count, cited_by_count),
      h_index = COALESCE(excluded.h_index, h_index),
      i10_index = COALESCE(excluded.i10_index, i10_index),
      two_yr_mean_citedness = COALESCE(excluded.two_yr_mean_citedness, two_yr_mean_citedness),
      affiliations_json = COALESCE(excluded.affiliations_json, affiliations_json),
      last_known_country = COALESCE(excluded.last_known_country, last_known_country),
      fetched_at = COALESCE(excluded.fetched_at, fetched_at),
      ingested_at = datetime('now')
  `)
  const writeBatch = db.transaction((rows) => {
    for (const r of rows) upsert.run(r)
  })

  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    let batch = []
    const rl = createInterface({
      input: createReadStream(f, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      seen++
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.missing || rec.error) continue
      const openalexId = normalizeOpenAlexAuthorId(rec.openalex_id || rec.openalex_url || rec.id)
      if (!openalexId) continue
      batch.push({
        openalex_id: openalexId,
        orcid: rec.orcid || null,
        display_name: rec.display_name || null,
        works_count: rec.works_count ?? null,
        cited_by_count: rec.cited_by_count ?? null,
        h_index: rec.h_index ?? null,
        i10_index: rec.i10_index ?? null,
        two_yr_mean_citedness: rec.two_yr_mean_citedness ?? null,
        affiliations_json: JSON.stringify(rec.affiliations || []),
        last_known_country: rec.last_known_country || rec.last_known_institution?.country_code || null,
        fetched_at: rec.fetched_at || startedAt,
      })
      if (batch.length >= 5000) {
        writeBatch(batch)
        up += batch.length
        batch = []
      }
    }
    if (batch.length) {
      writeBatch(batch)
      up += batch.length
    }
    logRun(db, 'openalex-authors', f, seen, up, startedAt)
    console.log(`  authors: ${f.split(/[\\/]/).pop()}  seen=${seen} upserted=${up}`)
  }

  await refreshPaperAuthorFeatures(db)
}

async function refreshPaperAuthorFeatures(db) {
  const rawUpdated = await refreshPaperAuthorFeaturesFromOpenAlex(db)
  if (rawUpdated > 0) return

  const authorQ = db.prepare(`SELECT h_index, last_known_country FROM authors WHERE openalex_id = ?`)
  const update = db.prepare(`
    UPDATE papers SET
      first_author_h_index = @first_author_h_index,
      last_author_h_index = @last_author_h_index,
      max_team_h_index = @max_team_h_index,
      median_team_h_index = @median_team_h_index,
      team_size_with_id = @team_size_with_id,
      international_collab = @international_collab,
      fetched_authors_at = datetime('now')
    WHERE doi = @doi
  `)
  const writeBatch = db.transaction((rows) => {
    for (const r of rows) update.run(r)
  })
  const cache = new Map()
  function getAuthor(id) {
    if (!id) return null
    if (!cache.has(id)) cache.set(id, authorQ.get(id) || null)
    return cache.get(id)
  }

  const rows = db.prepare(`
    SELECT doi, authorships_json
    FROM papers
    WHERE authorships_json IS NOT NULL AND authorships_json != ''
  `).iterate()

  let seen = 0, updated = 0
  let batch = []
  for (const row of rows) {
    seen++
    const authorships = parseJsonArray(row.authorships_json)
    const featureRow = computeAuthorFeatureRow(row.doi, authorships, getAuthor)
    if (!featureRow) continue
    batch.push(featureRow)
    if (batch.length >= 5000) {
      writeBatch(batch)
      updated += batch.length
      batch = []
      if (updated % 50000 === 0) console.log(`  author features: updated=${updated} seen=${seen}`)
    }
  }
  if (batch.length) {
    writeBatch(batch)
    updated += batch.length
  }
  console.log(`  author features: seen=${seen} updated=${updated} cache=${cache.size}`)
}

function computeAuthorFeatureRow(doi, authorships, getAuthor) {
  const ids = authorships.map(a => normalizeOpenAlexAuthorId(a?.author_id || a?.author?.id || a?.id)).filter(Boolean)
  if (ids.length === 0) return null

  const countries = new Set()
  const hValues = []
  for (let i = 0; i < ids.length; i++) {
    const a = getAuthor(ids[i])
    const country = authorships[i]?.first_country || authorships[i]?.institutions?.[0]?.country_code || a?.last_known_country
    if (country) countries.add(country)
    if (Number.isFinite(a?.h_index)) hValues.push(a.h_index)
  }

  const corresponding = authorships.find(a => a?.is_corresponding && normalizeOpenAlexAuthorId(a?.author_id || a?.author?.id || a?.id))
  const lastId = normalizeOpenAlexAuthorId(corresponding?.author_id || corresponding?.author?.id || corresponding?.id) || ids.at(-1)
  const firstAuthor = getAuthor(ids[0])
  const lastAuthor = getAuthor(lastId)

  return {
    doi,
    first_author_h_index: Number.isFinite(firstAuthor?.h_index) ? firstAuthor.h_index : null,
    last_author_h_index: Number.isFinite(lastAuthor?.h_index) ? lastAuthor.h_index : null,
    max_team_h_index: hValues.length ? Math.max(...hValues) : null,
    median_team_h_index: median(hValues),
    team_size_with_id: ids.length,
    international_collab: countries.size >= 2 ? 1 : 0,
  }
}

async function refreshPaperAuthorFeaturesFromOpenAlex(db) {
  const files = listJsonl('openalex')
  if (files.length === 0) return 0
  const authorQ = db.prepare(`SELECT h_index, last_known_country FROM authors WHERE openalex_id = ?`)
  const update = db.prepare(`
    UPDATE papers SET
      first_author_h_index = @first_author_h_index,
      last_author_h_index = @last_author_h_index,
      max_team_h_index = @max_team_h_index,
      median_team_h_index = @median_team_h_index,
      team_size_with_id = @team_size_with_id,
      international_collab = @international_collab,
      fetched_authors_at = datetime('now')
    WHERE doi = @doi
  `)
  const writeBatch = db.transaction((rows) => {
    for (const r of rows) update.run(r)
  })
  const cache = new Map()
  function getAuthor(id) {
    if (!id) return null
    if (!cache.has(id)) cache.set(id, authorQ.get(id) || null)
    return cache.get(id)
  }

  let seen = 0, updated = 0
  let batch = []
  for (const f of files) {
    let fileSeen = 0, fileUpdated = 0
    for await (const rec of readJsonlStream(f)) {
      seen++
      fileSeen++
      if (!rec.doi || !Array.isArray(rec.authorships)) continue
      const doi = String(rec.doi).toLowerCase().replace(/^https?:\/\/doi\.org\//, '')
      const featureRow = computeAuthorFeatureRow(doi, rec.authorships, getAuthor)
      if (!featureRow) continue
      batch.push(featureRow)
      if (batch.length >= 5000) {
        writeBatch(batch)
        updated += batch.length
        fileUpdated += batch.length
        batch = []
      }
    }
    if (batch.length) {
      writeBatch(batch)
      updated += batch.length
      fileUpdated += batch.length
      batch = []
    }
    console.log(`  author features from openalex: ${f.split(/[\\/]/).pop()} seen=${fileSeen} updated=${fileUpdated}`)
  }
  console.log(`  author features from openalex: seen=${seen} updated=${updated} cache=${cache.size}`)
  return updated
}

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

// ────────────────── iCite ingestion (NIH-curated citation metrics) ────────
function ingestICite(db) {
  const files = listJsonl('icite')
  if (files.length === 0) { console.log('iCite: no files.'); return }
  const upd = db.prepare(`
    UPDATE papers SET
      icite_rcr = COALESCE(@icite_rcr, icite_rcr),
      icite_nih_percentile = COALESCE(@icite_nih_percentile, icite_nih_percentile),
      icite_citation_count = COALESCE(@icite_citation_count, icite_citation_count),
      icite_citations_per_year = COALESCE(@icite_citations_per_year, icite_citations_per_year),
      icite_expected_cit_per_year = COALESCE(@icite_expected_cit_per_year, icite_expected_cit_per_year),
      icite_field_citation_rate = COALESCE(@icite_field_citation_rate, icite_field_citation_rate),
      icite_is_clinical = COALESCE(@icite_is_clinical, icite_is_clinical),
      icite_is_research_article = COALESCE(@icite_is_research_article, icite_is_research_article),
      icite_apt = COALESCE(@icite_apt, icite_apt),
      icite_cited_by_clin = COALESCE(@icite_cited_by_clin, icite_cited_by_clin),
      fetched_icite_at = @fetched_icite_at
    WHERE pmid = @pmid
       OR (pmcid IS NOT NULL AND pmcid = @pmcid)
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    db.transaction(() => {
      for (const r of readJsonl(f)) {
        seen++
        if (!r.pmid) continue
        const info = upd.run({
          pmid: String(r.pmid),
          icite_rcr: r.rcr ?? null,
          icite_nih_percentile: r.nih_percentile ?? null,
          icite_citation_count: r.citation_count ?? null,
          icite_citations_per_year: r.citations_per_year ?? null,
          icite_expected_cit_per_year: r.expected_citations_per_year ?? null,
          icite_field_citation_rate: r.field_citation_rate ?? null,
          icite_is_clinical: r.is_clinical === true ? 1 : (r.is_clinical === false ? 0 : null),
          icite_is_research_article: r.is_research_article === true ? 1 : (r.is_research_article === false ? 0 : null),
          icite_apt: r.apt ?? null,
          icite_cited_by_clin: Array.isArray(r.cited_by_clin) ? r.cited_by_clin.length : (r.cited_by_clin ?? null),
          fetched_icite_at: r.fetched_at || startedAt,
          pmcid: r.pmcid || null,
        })
        if (info.changes > 0) up++
      }
    })()
    logRun(db, 'icite', f, seen, up, startedAt)
    console.log(`  icite: ${f.split(/[\\/]/).pop()}  seen=${seen} updated=${up}`)
  }
}

// ────────────────── Unpaywall ingestion ──────────
function ingestUnpaywall(db) {
  const files = listJsonl('unpaywall')
  if (files.length === 0) { console.log('Unpaywall: no files.'); return }
  const upd = db.prepare(`
    UPDATE papers SET
      unpaywall_is_oa = @unpaywall_is_oa,
      unpaywall_oa_status = COALESCE(@unpaywall_oa_status, unpaywall_oa_status),
      unpaywall_best_oa_url = COALESCE(@unpaywall_best_oa_url, unpaywall_best_oa_url),
      unpaywall_best_oa_host = COALESCE(@unpaywall_best_oa_host, unpaywall_best_oa_host),
      unpaywall_best_oa_version = COALESCE(@unpaywall_best_oa_version, unpaywall_best_oa_version),
      unpaywall_best_oa_license = COALESCE(@unpaywall_best_oa_license, unpaywall_best_oa_license),
      unpaywall_journal_oa = @unpaywall_journal_oa,
      unpaywall_journal_doaj = @unpaywall_journal_doaj,
      fetched_unpaywall_at = @fetched_unpaywall_at
    WHERE doi = @doi
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    db.transaction(() => {
      for (const r of readJsonl(f)) {
        seen++
        if (!r.doi) continue
        const info = upd.run({
          doi: String(r.doi).toLowerCase(),
          unpaywall_is_oa: r.is_oa === true ? 1 : (r.is_oa === false ? 0 : null),
          unpaywall_oa_status: r.oa_status || null,
          unpaywall_best_oa_url: r.best_oa_url_for_pdf || null,
          unpaywall_best_oa_host: r.best_oa_host_type || null,
          unpaywall_best_oa_version: r.best_oa_version || null,
          unpaywall_best_oa_license: r.best_oa_license || null,
          unpaywall_journal_oa: r.journal_is_oa === true ? 1 : (r.journal_is_oa === false ? 0 : null),
          unpaywall_journal_doaj: r.journal_is_in_doaj === true ? 1 : (r.journal_is_in_doaj === false ? 0 : null),
          fetched_unpaywall_at: r.fetched_at || startedAt,
        })
        if (info.changes > 0) up++
      }
    })()
    logRun(db, 'unpaywall', f, seen, up, startedAt)
    console.log(`  unpaywall: ${f.split(/[\\/]/).pop()}  seen=${seen} updated=${up}`)
  }
}

// ────────────────── ClinicalTrials.gov ingestion (own table) ──────────
function ingestClinicalTrials(db) {
  const files = listJsonl('clinicaltrials')
  if (files.length === 0) { console.log('ClinicalTrials: no files.'); return }
  const upd = db.prepare(`
    INSERT INTO clinical_trials (
      nct_id, brief_title, study_type, phases_json, enrollment, enrollment_type,
      allocation, intervention_model, masking, overall_status,
      start_date, primary_completion_date, completion_date, last_update_post_date,
      has_results, sponsor_name, sponsor_class,
      conditions_json, interventions_json, primary_outcomes_json, secondary_outcomes_json,
      fetched_at
    ) VALUES (
      @nct_id, @brief_title, @study_type, @phases_json, @enrollment, @enrollment_type,
      @allocation, @intervention_model, @masking, @overall_status,
      @start_date, @primary_completion_date, @completion_date, @last_update_post_date,
      @has_results, @sponsor_name, @sponsor_class,
      @conditions_json, @interventions_json, @primary_outcomes_json, @secondary_outcomes_json,
      @fetched_at
    )
    ON CONFLICT(nct_id) DO UPDATE SET
      brief_title = excluded.brief_title,
      study_type = excluded.study_type,
      phases_json = excluded.phases_json,
      enrollment = excluded.enrollment,
      enrollment_type = excluded.enrollment_type,
      allocation = excluded.allocation,
      intervention_model = excluded.intervention_model,
      masking = excluded.masking,
      overall_status = excluded.overall_status,
      start_date = excluded.start_date,
      primary_completion_date = excluded.primary_completion_date,
      completion_date = excluded.completion_date,
      last_update_post_date = excluded.last_update_post_date,
      has_results = excluded.has_results,
      sponsor_name = excluded.sponsor_name,
      sponsor_class = excluded.sponsor_class,
      conditions_json = excluded.conditions_json,
      interventions_json = excluded.interventions_json,
      primary_outcomes_json = excluded.primary_outcomes_json,
      secondary_outcomes_json = excluded.secondary_outcomes_json,
      fetched_at = excluded.fetched_at
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    db.transaction(() => {
      for (const r of readJsonl(f)) {
        seen++
        if (!r.nct_id) continue
        upd.run({
          nct_id: r.nct_id,
          brief_title: r.brief_title || null,
          study_type: r.study_type || null,
          phases_json: JSON.stringify(r.phases || []),
          enrollment: r.enrollment ?? null,
          enrollment_type: r.enrollment_type || null,
          allocation: r.allocation || null,
          intervention_model: r.intervention_model || null,
          masking: r.masking || null,
          overall_status: r.overall_status || null,
          start_date: r.start_date || null,
          primary_completion_date: r.primary_completion_date || null,
          completion_date: r.completion_date || null,
          last_update_post_date: r.last_update_post_date || null,
          has_results: r.has_results === true ? 1 : (r.has_results === false ? 0 : null),
          sponsor_name: r.sponsor_name || null,
          sponsor_class: r.sponsor_class || null,
          conditions_json: JSON.stringify(r.conditions || []),
          interventions_json: JSON.stringify(r.interventions || []),
          primary_outcomes_json: JSON.stringify(r.primary_outcomes || []),
          secondary_outcomes_json: JSON.stringify(r.secondary_outcomes || []),
          fetched_at: r.fetched_at || startedAt,
        })
        up++
      }
    })()
    logRun(db, 'clinicaltrials', f, seen, up, startedAt)
    console.log(`  ct.gov: ${f.split(/[\\/]/).pop()}  seen=${seen} upserted=${up}`)
  }
}

// ────────────────── PMC full-text features ──────────
async function ingestPmcFulltext(db) {
  const files = listJsonl('pmc-fulltext')
  // Also load the pmid→pmcid mapping to set pmcid on papers
  const mapPath = join(DATA_ROOT, 'pmc-fulltext', '_pmid_to_pmcid.json')
  let pmidMap = {}
  if (existsSync(mapPath)) {
    try { pmidMap = JSON.parse(readFileSync(mapPath, 'utf-8')) } catch {}
  }
  if (files.length === 0 && Object.keys(pmidMap).length === 0) {
    console.log('PMC fulltext: no files.'); return
  }
  // 1. Populate pmcid via the mapping
  const setPmcid = db.prepare(`UPDATE papers SET pmcid = @pmcid WHERE pmid = @pmid AND (pmcid IS NULL OR pmcid != @pmcid)`)
  let mapUp = 0
  db.transaction(() => {
    for (const [pmid, pmcid] of Object.entries(pmidMap)) {
      if (!pmcid) continue
      const info = setPmcid.run({ pmid, pmcid })
      if (info.changes > 0) mapUp++
    }
  })()
  console.log(`  pmc: pmid→pmcid map populated ${mapUp} papers`)

  // 2. Ingest full-text features by pmcid
  const upd = db.prepare(`
    UPDATE papers SET
      pmc_body_word_count = @body,
      pmc_section_count = @secs,
      pmc_figure_count = @figs,
      pmc_table_count = @tabs,
      pmc_ref_count = @refs,
      pmc_has_data_avail = @hasdata,
      pmc_has_ethics = @hasethics,
      pmc_has_coi = @hascoi,
      fetched_pmc_at = @fetched
    WHERE pmcid = @pmcid
  `)
  const writeBatch = db.transaction((rows) => {
    let changed = 0
    for (const r of rows) {
      if (!r.pmcid) continue
      const info = upd.run({
        pmcid: r.pmcid,
        body: r.body_word_count ?? null,
        secs: r.section_count ?? null,
        figs: r.figure_count ?? null,
        tabs: r.table_count ?? null,
        refs: r.ref_count ?? null,
        hasdata: r.data_availability ? 1 : 0,
        hasethics: r.ethics_statement ? 1 : 0,
        hascoi: r.conflict_of_interest ? 1 : 0,
        fetched: rows.startedAt,
      })
      if (info.changes > 0) changed++
    }
    return changed
  })
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    let batch = []
    for await (const r of readJsonlStream(f)) {
      seen++
      if (!r.pmcid) continue
      batch.push(r)
      if (batch.length >= 5000) {
        batch.startedAt = startedAt
        up += writeBatch(batch)
        batch = []
      }
    }
    if (batch.length) {
      batch.startedAt = startedAt
      up += writeBatch(batch)
    }
    logRun(db, 'pmc-fulltext', f, seen, up, startedAt)
    console.log(`  pmc: ${f.split(/[\\/]/).pop()}  seen=${seen} updated=${up}`)
  }
}

// ────────────────── Europe PMC full-text features ──────────
async function ingestEpmcFulltext(db) {
  const files = listJsonl('europepmc-fulltext')
  if (files.length === 0) { console.log('EPMC fulltext: no files.'); return }
  const upd = db.prepare(`
    UPDATE papers SET
      epmc_body_word_count = @body,
      epmc_section_count = @secs,
      epmc_figure_count = @figs,
      epmc_ref_count = @refs,
      fetched_epmc_at = @fetched
    WHERE pmid = @pmid
  `)
  const writeBatch = db.transaction((rows) => {
    let changed = 0
    for (const r of rows) {
      if (!r.pmid && !r.pmcid) continue
      const info = upd.run({
        pmid: r.pmid ? String(r.pmid) : null,
        pmcid: r.pmcid ? String(r.pmcid) : null,
        body: r.body_word_count ?? null,
        secs: r.section_count ?? null,
        figs: r.figure_count ?? null,
        refs: r.ref_count ?? null,
        fetched: rows.startedAt,
      })
      if (info.changes > 0) changed++
    }
    return changed
  })
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    let batch = []
    for await (const r of readJsonlStream(f)) {
      seen++
      if (!r.pmid) continue
      batch.push(r)
      if (batch.length >= 5000) {
        batch.startedAt = startedAt
        up += writeBatch(batch)
        batch = []
      }
    }
    if (batch.length) {
      batch.startedAt = startedAt
      up += writeBatch(batch)
    }
    logRun(db, 'europepmc-fulltext', f, seen, up, startedAt)
    console.log(`  epmc: ${f.split(/[\\/]/).pop()}  seen=${seen} updated=${up}`)
  }
}

// ────────────────── PDF full-text features ──────────
function ingestPdfFulltext(db) {
  const files = listJsonl('pdf-fulltext')
  if (files.length === 0) { console.log('PDF fulltext: no files.'); return }
  const upd = db.prepare(`
    UPDATE papers SET
      pdf_body_chars = @chars,
      pdf_body_words = @words,
      pdf_num_pages = @pages,
      pdf_source_url = COALESCE(@url, pdf_source_url),
      fetched_pdf_at = @fetched
    WHERE doi = @doi
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    db.transaction(() => {
      for (const r of readJsonl(f)) {
        seen++
        if (!r.doi) continue
        const info = upd.run({
          doi: String(r.doi).toLowerCase(),
          chars: r.body_chars ?? null,
          words: r.body_words ?? null,
          pages: r.num_pages ?? null,
          url: r.url || null,
          fetched: r.fetched_at || startedAt,
        })
        if (info.changes > 0) up++
      }
    })()
    logRun(db, 'pdf-fulltext', f, seen, up, startedAt)
    console.log(`  pdf: ${f.split(/[\\/]/).pop()}  seen=${seen} updated=${up}`)
  }
}

// ────────────────── bioRxiv/medRxiv preprint linkage ──────────
function ingestBiorxiv(db) {
  const files = listJsonl('biorxiv')
  if (files.length === 0) { console.log('bioRxiv: no files.'); return }
  // bioRxiv records have a preprint DOI; match by doi if the same DOI appears
  // in papers (rare — preprints usually keep their .101 DOI) OR by title-fuzzy.
  // For now, use the published_doi field if present in the record.
  const upd = db.prepare(`
    UPDATE papers SET
      preprint_server = @server,
      preprint_doi = @preprint_doi,
      preprint_published_date = @ppub,
      fetched_preprint_at = @fetched
    WHERE doi = @doi
  `)
  for (const f of files) {
    const startedAt = new Date().toISOString()
    let seen = 0, up = 0
    db.transaction(() => {
      for (const r of readJsonl(f)) {
        seen++
        // Two link paths:
        //   (a) record has a `published_doi` linking preprint → final paper DOI
        //   (b) record IS itself the published paper (rare for bioRxiv collector)
        const targetDoi = r.published_doi ? String(r.published_doi).toLowerCase() : null
        if (!targetDoi) continue
        const info = upd.run({
          doi: targetDoi,
          server: r.server || 'bioRxiv',
          preprint_doi: r.doi ? String(r.doi).toLowerCase() : null,
          ppub: r.date || null,
          fetched: startedAt,
        })
        if (info.changes > 0) up++
      }
    })()
    logRun(db, 'biorxiv', f, seen, up, startedAt)
    console.log(`  biorxiv: ${f.split(/[\\/]/).pop()}  seen=${seen} updated=${up}`)
  }
  // Compute gap days where both dates known
  const gap = db.prepare(`
    UPDATE papers SET
      preprint_pub_gap_days =
        CAST(julianday(COALESCE(cr_published_print, cr_published_online, oa_publication_date)) - julianday(preprint_published_date) AS INTEGER)
    WHERE preprint_published_date IS NOT NULL
      AND (cr_published_print IS NOT NULL OR cr_published_online IS NOT NULL OR oa_publication_date IS NOT NULL)
  `).run()
  console.log(`  biorxiv: preprint→publication gap computed on ${gap.changes} papers`)
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
      jcr_total_cites, jcr_total_articles, jcr_citable_items, jcr_source_file,
      eigenfactor, normalized_eigenfactor, article_influence, immediacy_index,
      jci_percentile, jif_5yr_quartile, jcr_edition
    ) VALUES (
      @openalex_id, @issn, @year,
      @jcr_jif, @jcr_jif_5yr, @jcr_jif_no_self, @jci, @jcr_quartile, @jcr_category,
      @jcr_rank, @jcr_total_in_category, @jcr_publisher,
      @jcr_total_cites, @jcr_total_articles, @jcr_citable_items, @jcr_source_file,
      @eigenfactor, @normalized_eigenfactor, @article_influence, @immediacy_index,
      @jci_percentile, @jif_5yr_quartile, @jcr_edition
    )
    ON CONFLICT(openalex_id, year) DO UPDATE SET
      jcr_jif              = COALESCE(excluded.jcr_jif, jcr_jif),
      jcr_jif_5yr          = COALESCE(excluded.jcr_jif_5yr, jcr_jif_5yr),
      jcr_jif_no_self      = COALESCE(excluded.jcr_jif_no_self, jcr_jif_no_self),
      jci                  = COALESCE(excluded.jci, jci),
      jcr_quartile         = COALESCE(excluded.jcr_quartile, jcr_quartile),
      jcr_category         = COALESCE(excluded.jcr_category, jcr_category),
      jcr_rank             = COALESCE(excluded.jcr_rank, jcr_rank),
      jcr_total_in_category= COALESCE(excluded.jcr_total_in_category, jcr_total_in_category),
      jcr_publisher        = COALESCE(excluded.jcr_publisher, jcr_publisher),
      jcr_total_cites      = COALESCE(excluded.jcr_total_cites, jcr_total_cites),
      jcr_total_articles   = COALESCE(excluded.jcr_total_articles, jcr_total_articles),
      jcr_citable_items    = COALESCE(excluded.jcr_citable_items, jcr_citable_items),
      jcr_source_file      = excluded.jcr_source_file,
      eigenfactor          = COALESCE(excluded.eigenfactor, eigenfactor),
      normalized_eigenfactor=COALESCE(excluded.normalized_eigenfactor, normalized_eigenfactor),
      article_influence    = COALESCE(excluded.article_influence, article_influence),
      immediacy_index      = COALESCE(excluded.immediacy_index, immediacy_index),
      jci_percentile       = COALESCE(excluded.jci_percentile, jci_percentile),
      jif_5yr_quartile     = COALESCE(excluded.jif_5yr_quartile, jif_5yr_quartile),
      jcr_edition          = COALESCE(excluded.jcr_edition, jcr_edition),
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
          eigenfactor:           rec.eigenfactor ?? null,
          normalized_eigenfactor:rec.normalized_eigenfactor ?? null,
          article_influence:     rec.article_influence ?? null,
          immediacy_index:       rec.immediacy_index ?? null,
          jci_percentile:        rec.jci_percentile ?? null,
          jif_5yr_quartile:      rec.jif_5yr_quartile || null,
          jcr_edition:           rec.edition || null,
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
      SUM(CASE WHEN icite_rcr IS NOT NULL THEN 1 ELSE 0 END) AS with_icite,
      SUM(CASE WHEN unpaywall_is_oa IS NOT NULL THEN 1 ELSE 0 END) AS with_unpaywall,
      SUM(CASE WHEN pmcid IS NOT NULL THEN 1 ELSE 0 END) AS with_pmcid,
      SUM(CASE WHEN pmc_body_word_count IS NOT NULL THEN 1 ELSE 0 END) AS with_pmc_fulltext,
      SUM(CASE WHEN epmc_body_word_count IS NOT NULL THEN 1 ELSE 0 END) AS with_epmc_fulltext,
      SUM(CASE WHEN pdf_body_words IS NOT NULL THEN 1 ELSE 0 END) AS with_pdf_fulltext,
      SUM(CASE WHEN preprint_doi IS NOT NULL THEN 1 ELSE 0 END) AS with_preprint,
      SUM(CASE WHEN first_author_h_index IS NOT NULL THEN 1 ELSE 0 END) AS with_first_author_h,
      ROUND(AVG(citations_openalex), 1) AS avg_oa_citations,
      ROUND(AVG(icite_rcr), 2) AS avg_rcr
    FROM papers
  `).get()
  const ctRow = db.prepare(`SELECT COUNT(*) AS clinical_trials FROM clinical_trials`).get()
  const authorRow = db.prepare(`SELECT COUNT(*) AS authors FROM authors`).get()
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
  console.log('\n── DB summary (clinical_trials) ──')
  console.log(`  total                     ${ctRow.clinical_trials}`)
  console.log('\n── DB summary (authors) ──')
  console.log(`  total                     ${authorRow.authors}`)
  console.log(`  DB file size              ${(statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB`)
}

async function main() {
  console.log(`PaperFate · build-unified-db`)
  console.log(`DATA_ROOT: ${DATA_ROOT}`)
  console.log(`DB:        ${DB_PATH}\n`)

  const db = openDb()
  const started = Date.now()

  if (shouldRun('pubmed'))         { console.log('── ingesting PubMed ──');                  ingestPubMed(db) }
  if (shouldRun('openalex'))       { console.log('── ingesting OpenAlex ──');                await ingestOpenAlex(db) }
  if (shouldRun('authors'))        { console.log('── ingesting OpenAlex Authors ──');        await ingestAuthors(db) }
  if (shouldRun('s2'))             { console.log('── ingesting Semantic Scholar ──');        ingestS2(db) }
  if (shouldRun('crossref'))       { console.log('── ingesting Crossref ──');                ingestCrossref(db) }
  if (shouldRun('sources'))        { console.log('── ingesting OpenAlex Sources ──');        ingestOpenAlexSources(db) }
  if (shouldRun('scimago'))        { console.log('── ingesting Scimago ──');                 ingestScimago(db) }
  if (shouldRun('jcr'))            { console.log('── ingesting JCR JIF ──');                 ingestJCR(db) }
  if (shouldRun('icite'))          { console.log('── ingesting iCite ──');                   ingestICite(db) }
  if (shouldRun('unpaywall'))      { console.log('── ingesting Unpaywall ──');               ingestUnpaywall(db) }
  if (shouldRun('clinicaltrials')) { console.log('── ingesting ClinicalTrials.gov ──');      ingestClinicalTrials(db) }
  if (shouldRun('pmc'))            { console.log('── ingesting PMC full-text ──');           await ingestPmcFulltext(db) }
  if (shouldRun('epmc'))           { console.log('── ingesting Europe PMC full-text ──');    await ingestEpmcFulltext(db) }
  if (shouldRun('pdf'))            { console.log('── ingesting PDF full-text ──');           ingestPdfFulltext(db) }
  if (shouldRun('biorxiv'))        { console.log('── ingesting bioRxiv preprints ──');       ingestBiorxiv(db) }

  summary(db)
  console.log(`\nTotal elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`)
  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
