#!/usr/bin/env node
// Recompute paper-level author features from papers.authorships_json + authors.
//
// This is intentionally separate from build-unified-db.mjs. The unified ingest path
// may update from raw OpenAlex JSONL and return before a full DB-backed propagation.
//
// Usage:
//   node scripts/propagate-author-features.mjs
//   node scripts/propagate-author-features.mjs --limit=10000 --dry-run

import Database from 'better-sqlite3'
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
const BATCH_SIZE = Number(arg('batch', '5000'))
const DRY_RUN = ARGS.includes('--dry-run')
const ONLY_MISSING = ARGS.includes('--only-missing')

function pct(n, d) {
  if (!d) return '0.00'
  return (100 * n / d).toFixed(2)
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

function countryFromAffiliations(text) {
  for (const aff of parseJsonArray(text)) {
    const c = aff?.country_code || aff?.country
    if (c) return String(c).toUpperCase()
  }
  return null
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function authorshipId(authorship) {
  return normalizeOpenAlexAuthorId(
    authorship?.author_id ||
    authorship?.author?.id ||
    authorship?.id ||
    authorship?.openalex_id,
  )
}

function authorshipCountries(authorship, authorRecord) {
  const countries = new Set()
  const add = value => {
    if (value) countries.add(String(value).toUpperCase())
  }

  add(authorship?.first_country)
  add(authorship?.country_code)
  add(authorship?.country)
  if (Array.isArray(authorship?.countries)) {
    for (const country of authorship.countries) add(country)
  }
  if (Array.isArray(authorship?.institutions)) {
    for (const inst of authorship.institutions) add(inst?.country_code || inst?.country)
  }
  add(authorRecord?.country)
  return countries
}

function computeFeatureRow(doi, authorships, authors) {
  const ids = []
  const authorRecords = []
  const countries = new Set()
  const hValues = []

  for (const authorship of authorships) {
    const id = authorshipId(authorship)
    if (!id) continue
    ids.push(id)
    const author = authors.get(id) || null
    authorRecords.push(author)
    for (const country of authorshipCountries(authorship, author)) countries.add(country)
    if (Number.isFinite(author?.h_index)) hValues.push(author.h_index)
  }

  if (!ids.length) return null

  const firstAuthor = authorRecords[0] || null
  const lastAuthor = authorRecords.at(-1) || null

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

function coverage(db) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN authorships_json IS NOT NULL AND authorships_json != '' THEN 1 ELSE 0 END) AS with_authorships,
      SUM(CASE WHEN first_author_h_index IS NOT NULL THEN 1 ELSE 0 END) AS first_author_h,
      SUM(CASE WHEN last_author_h_index IS NOT NULL THEN 1 ELSE 0 END) AS last_author_h,
      SUM(CASE WHEN max_team_h_index IS NOT NULL THEN 1 ELSE 0 END) AS max_team_h,
      SUM(CASE WHEN median_team_h_index IS NOT NULL THEN 1 ELSE 0 END) AS median_team_h,
      SUM(CASE WHEN team_size_with_id IS NOT NULL THEN 1 ELSE 0 END) AS team_size,
      SUM(CASE WHEN international_collab IS NOT NULL THEN 1 ELSE 0 END) AS intl
    FROM papers
  `).get()
}

function printCoverage(label, row) {
  console.log(`${label}:`)
  console.log(`  papers total:             ${row.total.toLocaleString()}`)
  console.log(`  with authorships_json:    ${row.with_authorships.toLocaleString()} (${pct(row.with_authorships, row.total)}% of papers)`)
  console.log(`  first_author_h_index:     ${row.first_author_h.toLocaleString()} (${pct(row.first_author_h, row.with_authorships)}% of authorship papers)`)
  console.log(`  last_author_h_index:      ${row.last_author_h.toLocaleString()} (${pct(row.last_author_h, row.with_authorships)}% of authorship papers)`)
  console.log(`  max_team_h_index:         ${row.max_team_h.toLocaleString()} (${pct(row.max_team_h, row.with_authorships)}% of authorship papers)`)
  console.log(`  median_team_h_index:      ${row.median_team_h.toLocaleString()} (${pct(row.median_team_h, row.with_authorships)}% of authorship papers)`)
  console.log(`  team_size_with_id:        ${row.team_size.toLocaleString()} (${pct(row.team_size, row.with_authorships)}% of authorship papers)`)
  console.log(`  international_collab:     ${row.intl.toLocaleString()} (${pct(row.intl, row.with_authorships)}% of authorship papers)`)
}

function loadAuthors(db) {
  console.log('Loading authors table into memory...')
  const t0 = Date.now()
  const authors = new Map()
  const rows = db.prepare(`
    SELECT openalex_id, h_index, works_count, cited_by_count, last_known_country, affiliations_json
    FROM authors
    WHERE openalex_id IS NOT NULL AND openalex_id != ''
  `).iterate()

  for (const row of rows) {
    const id = normalizeOpenAlexAuthorId(row.openalex_id)
    if (!id) continue
    authors.set(id, {
      h_index: numberOrNull(row.h_index),
      works_count: numberOrNull(row.works_count),
      cited_by_count: numberOrNull(row.cited_by_count),
      country: row.last_known_country ? String(row.last_known_country).toUpperCase() : countryFromAffiliations(row.affiliations_json),
    })
  }

  console.log(`  authors loaded: ${authors.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return authors
}

function main() {
  console.log('PaperFate author feature propagation')
  console.log(`DB: ${DB_PATH}`)
  console.log(`Args: batch=${BATCH_SIZE} limit=${LIMIT || 'none'} dry_run=${DRY_RUN} only_missing=${ONLY_MISSING}`)

  const readDb = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  readDb.pragma('query_only = ON')
  readDb.pragma('busy_timeout = 60000')
  const writeDb = new Database(DB_PATH, { fileMustExist: true })
  writeDb.pragma('busy_timeout = 60000')

  const before = coverage(readDb)
  printCoverage('Before', before)

  const authors = loadAuthors(readDb)
  const update = writeDb.prepare(`
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
  const writeBatch = writeDb.transaction(rows => {
    for (const row of rows) update.run(row)
  })

  const where = [
    "doi IS NOT NULL",
    "doi != ''",
    "authorships_json IS NOT NULL",
    "authorships_json != ''",
  ]
  if (ONLY_MISSING) {
    where.push(`(
      first_author_h_index IS NULL OR
      last_author_h_index IS NULL OR
      max_team_h_index IS NULL OR
      median_team_h_index IS NULL OR
      team_size_with_id IS NULL OR
      international_collab IS NULL
    )`)
  }

  const rows = readDb.prepare(`
    SELECT doi, authorships_json
    FROM papers
    WHERE ${where.join(' AND ')}
    ORDER BY doi
  `).iterate()

  const t0 = Date.now()
  let seen = 0
  let parsed = 0
  let withIds = 0
  let updated = 0
  let noIds = 0
  let noAuthorHits = 0
  let batch = []

  for (const row of rows) {
    seen++
    const authorships = parseJsonArray(row.authorships_json)
    if (!authorships.length) continue
    parsed++

    const featureRow = computeFeatureRow(row.doi, authorships, authors)
    if (!featureRow) {
      noIds++
      continue
    }
    withIds++
    if (featureRow.max_team_h_index === null) noAuthorHits++

    if (!DRY_RUN) batch.push(featureRow)
    if (!DRY_RUN && batch.length >= BATCH_SIZE) {
      writeBatch(batch)
      updated += batch.length
      batch = []
    }

    if (seen % 50000 === 0) {
      const elapsed = (Date.now() - t0) / 1000
      const rate = (seen / Math.max(1, elapsed)).toFixed(0)
      console.log(`  seen=${seen.toLocaleString()} parsed=${parsed.toLocaleString()} with_ids=${withIds.toLocaleString()} updated=${updated.toLocaleString()} no_hits=${noAuthorHits.toLocaleString()} ${rate}/s`)
    }

    if (LIMIT > 0 && seen >= LIMIT) break
  }

  if (!DRY_RUN && batch.length) {
    writeBatch(batch)
    updated += batch.length
  }

  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1)
  console.log(`\nPropagation ${DRY_RUN ? 'dry-run ' : ''}complete in ${elapsedMin} min`)
  console.log(`  seen=${seen.toLocaleString()} parsed=${parsed.toLocaleString()} with_ids=${withIds.toLocaleString()} no_ids=${noIds.toLocaleString()} no_author_hits=${noAuthorHits.toLocaleString()} updated=${updated.toLocaleString()}`)

  readDb.close()

  const after = coverage(writeDb)
  printCoverage('After', after)
  console.log(`first_author_h_index delta: ${(after.first_author_h - before.first_author_h).toLocaleString()} (${pct(after.first_author_h, after.with_authorships)}% of authorship papers)`)

  writeDb.close()
}

main()
