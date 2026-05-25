#!/usr/bin/env node
// Build FateCore v0.4 review-timeline training matrix.
//
// Target:
//   review_days_received_to_accepted clipped to [1, 730]
//
// Feature policy:
//   pre-submission only, plus optional prior-year target-journal j_hist_*.

import Database from 'better-sqlite3'
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = process.env.PAPERFATE_DB || join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'features')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const SCORE_MODE = arg('score-mode', 'codex_deterministic')
const MIN_SCORES = Number(arg('min-scores', '80'))
const MIN_YEAR = Number(arg('min-year', '2010'))
const LIMIT = Number(arg('limit', '0'))
const OUT_PATH = arg('out', join(OUT_DIR, 'v0.4-timeline-features.csv'))
const MANIFEST_PATH = arg('manifest', join(OUT_DIR, 'v0.4-timeline-features-manifest.json'))
const SOURCE_FEATURES = arg('source-features', '')

mkdirSync(OUT_DIR, { recursive: true })

const featureCols = [
  'year',
  'title_word_count',
  'abstract_word_count',
  'has_structured_abstract',
  'publication_types_count',
  'mesh_terms_count',
  'is_research_article',
  'is_clinical',
  'is_review',
  'is_case_report',
  'is_trial',
  'author_count',
  'has_first_affiliation',
  'has_funder',
  'has_nih_grant',
  'n_nih_grants',
  'funder_count',
  'first_author_h_index',
  'last_author_h_index',
  'max_team_h_index',
  'median_team_h_index',
  'team_size_with_id',
  'international_collab',
  'q_score_count',
  'q_numeric_count',
  'q_score_mean',
  'q_score_sd',
  'q_score_min',
  'q_score_max',
  'q_numeric_frac',
  'q_na_count',
  'q_unknown_count',
  'q_na_frac',
  'j_hist_metric_age',
  'j_hist_jcr_jif',
]
const idCols = ['doi', 'pmid', 'issn']
const labelCols = ['y_review_days', 'y_review_days_log']

const forbiddenFeaturePatterns = [
  /^citations_/,
  /^fwci/,
  /^reference_count$/,
  /^influential_citations$/,
  /^icite_(?!is_clinical$|is_research_article$)/,
  /^unpaywall_/,
  /^pmc_/,
  /^epmc_/,
  /^pdf_/,
  /^preprint_pub_gap_days$/,
  /^pub_year_age$/,
]

function parseJsonArray(text) {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function csvCell(value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function writeCsvRow(stream, values) {
  stream.write(values.map(csvCell).join(',') + '\n')
}

function splitCsvLine(line) {
  const out = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  out.push(cell)
  return out
}

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function bool01(value) {
  if (value === null || value === undefined || value === '') return null
  return Number(value) ? 1 : 0
}

function countWords(text) {
  if (!text) return 0
  const m = String(text).trim().match(/\S+/g)
  return m ? m.length : 0
}

function structuredAbstract(text) {
  if (!text) return 0
  return /\b(background|objective|methods?|results?|conclusions?|importance|design|setting|participants|interventions?)\s*:/i.test(text) ? 1 : 0
}

function pubTypeFlags(pubTypes) {
  const text = pubTypes.join(' | ').toLowerCase()
  return {
    is_review: /review|meta-analysis|systematic review/.test(text) ? 1 : 0,
    is_case_report: /case reports?/.test(text) ? 1 : 0,
    is_trial: /clinical trial|randomized controlled trial/.test(text) ? 1 : 0,
  }
}

function latestBefore(rows, year) {
  if (!rows || !year) return null
  let lo = 0
  let hi = rows.length - 1
  let found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].year < year) {
      found = rows[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

function loadJournalMetrics(db) {
  console.log('Preloading journal_year_metrics...')
  const t0 = Date.now()
  const byIssn = new Map()
  for (const r of db.prepare(`
    SELECT issn, year, jcr_jif
    FROM journal_year_metrics
    WHERE issn IS NOT NULL AND issn != '' AND year IS NOT NULL
  `).iterate()) {
    if (!byIssn.has(r.issn)) byIssn.set(r.issn, [])
    byIssn.get(r.issn).push(r)
  }
  for (const rows of byIssn.values()) rows.sort((a, b) => a.year - b.year)
  console.log(`  issn=${byIssn.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return byIssn
}

function loadScoreStats(db) {
  if (MIN_SCORES <= 0) return new Map()
  console.log(`Preloading Q score aggregates mode=${SCORE_MODE} min_scores=${MIN_SCORES}...`)
  const t0 = Date.now()
  const map = new Map()
  const candidates = db.prepare(`
    SELECT doi
    FROM papers
    WHERE doi IS NOT NULL AND doi != ''
      AND year >= ?
      AND review_days_received_to_accepted IS NOT NULL
  `).all(MIN_YEAR).map(r => r.doi)
  console.log(`  candidate timeline dois=${candidates.length.toLocaleString()}`)

  const batchSize = 500
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT
        doi,
        COUNT(*) AS q_score_count,
        SUM(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END) AS q_numeric_count,
        AVG(CASE WHEN score IS NOT NULL THEN score ELSE NULL END) AS q_score_mean,
        AVG(CASE WHEN score IS NOT NULL THEN score * score ELSE NULL END) AS q_score_mean_sq,
        MIN(score) AS q_score_min,
        MAX(score) AS q_score_max,
        SUM(CASE WHEN raw_value = 'na' THEN 1 ELSE 0 END) AS q_na_count,
        SUM(CASE WHEN raw_value = 'unknown' THEN 1 ELSE 0 END) AS q_unknown_count
      FROM paper_scores
      WHERE mode = ? AND doi IN (${placeholders})
      GROUP BY doi
      HAVING q_score_count >= ?
    `).all(SCORE_MODE, ...batch, MIN_SCORES)

    for (const r of rows) {
      const mean = num(r.q_score_mean)
      const meanSq = num(r.q_score_mean_sq)
      const variance = mean !== null && meanSq !== null ? Math.max(0, meanSq - mean * mean) : null
      map.set(r.doi, {
        q_score_count: r.q_score_count,
        q_numeric_count: r.q_numeric_count,
        q_score_mean: mean,
        q_score_sd: variance === null ? null : Math.sqrt(variance),
        q_score_min: num(r.q_score_min),
        q_score_max: num(r.q_score_max),
        q_na_count: r.q_na_count || 0,
        q_unknown_count: r.q_unknown_count || 0,
        q_numeric_frac: r.q_score_count ? r.q_numeric_count / r.q_score_count : null,
        q_na_frac: r.q_score_count ? (r.q_na_count || 0) / r.q_score_count : null,
      })
    }
    if (i > 0 && i % 50000 === 0) {
      console.log(`  q batches: ${i.toLocaleString()}/${candidates.length.toLocaleString()} score_rows=${map.size.toLocaleString()}`)
    }
  }
  console.log(`  score aggregates=${map.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return map
}

function buildFeatureRow(p, ctx) {
  const pubTypes = parseJsonArray(p.publication_types_json)
  const meshTerms = parseJsonArray(p.mesh_terms_json)
  const authors = parseJsonArray(p.authors_json)
  const funders = parseJsonArray(p.funder_json)
  const flags = pubTypeFlags(pubTypes)
  const q = ctx.scoreStats.get(p.doi) || {}
  const hist = p.issn && p.year ? latestBefore(ctx.journalMetrics.get(p.issn), p.year) : null

  return {
    year: p.year,
    title_word_count: countWords(p.title),
    abstract_word_count: countWords(p.abstract),
    has_structured_abstract: structuredAbstract(p.abstract),
    publication_types_count: pubTypes.length,
    mesh_terms_count: meshTerms.length,
    is_research_article: bool01(p.icite_is_research_article),
    is_clinical: bool01(p.icite_is_clinical),
    is_review: flags.is_review,
    is_case_report: flags.is_case_report,
    is_trial: flags.is_trial,
    author_count: authors.length,
    has_first_affiliation: p.first_affiliation ? 1 : 0,
    has_funder: (funders.length > 0 || Number(p.has_nih_grant) > 0) ? 1 : 0,
    has_nih_grant: bool01(p.has_nih_grant),
    n_nih_grants: num(p.n_nih_grants),
    funder_count: funders.length,
    first_author_h_index: num(p.first_author_h_index),
    last_author_h_index: num(p.last_author_h_index),
    max_team_h_index: num(p.max_team_h_index),
    median_team_h_index: num(p.median_team_h_index),
    team_size_with_id: num(p.team_size_with_id),
    international_collab: bool01(p.international_collab),
    q_score_count: q.q_score_count ?? null,
    q_numeric_count: q.q_numeric_count ?? null,
    q_score_mean: q.q_score_mean ?? null,
    q_score_sd: q.q_score_sd ?? null,
    q_score_min: q.q_score_min ?? null,
    q_score_max: q.q_score_max ?? null,
    q_numeric_frac: q.q_numeric_frac ?? null,
    q_na_count: q.q_na_count ?? null,
    q_unknown_count: q.q_unknown_count ?? null,
    q_na_frac: q.q_na_frac ?? null,
    j_hist_metric_age: hist?.year ? p.year - hist.year : null,
    j_hist_jcr_jif: num(hist?.jcr_jif),
  }
}

function clippedReviewDays(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(1, Math.min(730, Math.round(n)))
}

function forbiddenFeatureNames(cols) {
  return cols.filter(c => forbiddenFeaturePatterns.some(re => re.test(c)))
}

function loadTargetsForBatch(db, dois) {
  if (dois.length === 0) return new Map()
  const placeholders = dois.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT doi, issn, review_days_received_to_accepted
    FROM papers
    WHERE doi IN (${placeholders})
      AND review_days_received_to_accepted IS NOT NULL
  `).all(...dois)
  const out = new Map()
  for (const r of rows) out.set(String(r.doi).toLowerCase(), r)
  return out
}

async function mainFromSourceFeatures(db) {
  console.log(`Source features: ${SOURCE_FEATURES}`)
  const rl = createInterface({
    input: createReadStream(SOURCE_FEATURES, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const out = createWriteStream(OUT_PATH, { encoding: 'utf8' })
  const header = [...idCols, ...featureCols, ...labelCols]
  writeCsvRow(out, header)

  let sourceHeader = null
  let idx = null
  let batch = []
  let rowsSeen = 0
  let rowsUnderMinYear = 0
  let rowsWithoutTarget = 0
  let rowsWritten = 0
  const batchSize = 1000
  const t0 = Date.now()

  async function flushBatch() {
    if (batch.length === 0) return
    const targetMap = loadTargetsForBatch(db, batch.map(r => r.doi))
    for (const row of batch) {
      const target = targetMap.get(row.doi)
      if (!target) {
        rowsWithoutTarget++
        continue
      }
      const y = clippedReviewDays(target.review_days_received_to_accepted)
      if (y === null) {
        rowsWithoutTarget++
        continue
      }
      writeCsvRow(out, [
        row.doi,
        row.pmid,
        target.issn || '',
        ...featureCols.map(c => row.cells[idx.get(c)] ?? ''),
        y,
        Math.log1p(y).toFixed(8),
      ])
      rowsWritten++
      if (LIMIT > 0 && rowsWritten >= LIMIT) break
    }
    batch = []
    if (rowsWritten > 0 && rowsWritten % 10000 === 0) {
      const elapsed = (Date.now() - t0) / 1000
      console.log(`  seen=${rowsSeen.toLocaleString()} written=${rowsWritten.toLocaleString()} no_target=${rowsWithoutTarget.toLocaleString()} ${Math.round(rowsSeen / Math.max(1, elapsed))}/s`)
    }
  }

  for await (const line of rl) {
    if (sourceHeader === null) {
      sourceHeader = splitCsvLine(line)
      idx = new Map(sourceHeader.map((name, i) => [name, i]))
      const required = ['doi', 'pmid', ...featureCols]
      const missing = required.filter(c => !idx.has(c))
      if (missing.length) throw new Error(`source features missing columns: ${missing.join(', ')}`)
      continue
    }
    if (!line) continue
    rowsSeen++
    const cells = splitCsvLine(line)
    const year = Number(cells[idx.get('year')])
    if (!Number.isFinite(year) || year < MIN_YEAR) {
      rowsUnderMinYear++
      continue
    }
    const doi = String(cells[idx.get('doi')] || '').toLowerCase()
    if (!doi) continue
    batch.push({ doi, pmid: cells[idx.get('pmid')] || '', cells })
    if (batch.length >= batchSize) await flushBatch()
    if (LIMIT > 0 && rowsWritten >= LIMIT) break
  }
  await flushBatch()
  out.end()

  const forbidden = forbiddenFeatureNames(featureCols)
  const manifest = {
    generated_at: new Date().toISOString(),
    version: 'v0.4-timeline',
    db_path: DB_PATH,
    output_path: OUT_PATH,
    source_features: SOURCE_FEATURES,
    source_mode: 'v0.3-pub-derived',
    score_mode: SCORE_MODE,
    min_scores: MIN_SCORES,
    min_year: MIN_YEAR,
    rows_seen: rowsSeen,
    rows_written: rowsWritten,
    rows_under_min_year: rowsUnderMinYear,
    rows_without_review_target: rowsWithoutTarget,
    columns: header,
    id_cols: idCols,
    feature_cols: featureCols,
    label_cols: labelCols,
    forbidden_feature_count: forbidden.length,
    forbidden_remaining: forbidden,
    notes: {
      target: 'review_days_received_to_accepted clipped to [1, 730], plus log1p label.',
      source: 'Feature values are selected from v0.3-pub feature CSV, which already contains Q score aggregates and pre-submission target-journal prior features.',
      leakage_rule: 'No citations, fulltext, OA availability, or post-publication article metrics. j_hist_jcr_jif is latest journal_year_metrics row with year < paper.year from the source v0.3 feature build.',
      split_rule: 'Training script uses random split only.',
    },
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')

  console.log(`\nWrote ${rowsWritten.toLocaleString()} rows x ${header.length.toLocaleString()} columns`)
  console.log(`Rows without target: ${rowsWithoutTarget.toLocaleString()}`)
  console.log(`Forbidden remaining: ${forbidden.length}`)
  console.log(`CSV: ${OUT_PATH}`)
  console.log(`Manifest: ${MANIFEST_PATH}`)
}

async function main() {
  console.log('PaperFate FateCore v0.4 timeline feature builder')
  console.log(`DB: ${DB_PATH}`)
  console.log(`Output: ${OUT_PATH}`)
  console.log(`Args: min_year=${MIN_YEAR} min_scores=${MIN_SCORES} score_mode=${SCORE_MODE} limit=${LIMIT || 'none'}`)

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  db.pragma('busy_timeout = 60000')

  if (SOURCE_FEATURES) {
    await mainFromSourceFeatures(db)
    db.close()
    return
  }

  const journalMetrics = loadJournalMetrics(db)
  const scoreStats = loadScoreStats(db)
  const ctx = { journalMetrics, scoreStats }

  const out = createWriteStream(OUT_PATH, { encoding: 'utf8' })
  const header = [...idCols, ...featureCols, ...labelCols]
  writeCsvRow(out, header)

  const paperRows = db.prepare(`
    SELECT
      doi, pmid, title, abstract, journal, issn, year,
      publication_types_json, mesh_terms_json, authors_json, first_affiliation,
      funder_json, icite_is_clinical, icite_is_research_article,
      first_author_h_index, last_author_h_index, max_team_h_index, median_team_h_index,
      team_size_with_id, international_collab,
      has_nih_grant, n_nih_grants,
      review_days_received_to_accepted
    FROM papers
    WHERE doi IS NOT NULL AND doi != ''
      AND year >= ?
      AND review_days_received_to_accepted IS NOT NULL
  `).iterate(MIN_YEAR)

  const t0 = Date.now()
  let seen = 0
  let scoreFiltered = 0
  let invalidTarget = 0
  let written = 0

  for (const p of paperRows) {
    seen++
    if (MIN_SCORES > 0 && !scoreStats.has(p.doi)) {
      scoreFiltered++
      continue
    }
    const y = clippedReviewDays(p.review_days_received_to_accepted)
    if (y === null) {
      invalidTarget++
      continue
    }
    const features = buildFeatureRow(p, ctx)
    writeCsvRow(out, [
      p.doi,
      p.pmid,
      p.issn,
      ...featureCols.map(c => features[c]),
      y,
      Math.log1p(y).toFixed(8),
    ])
    written++
    if (written % 10000 === 0) {
      const elapsed = (Date.now() - t0) / 1000
      const rate = (seen / Math.max(1, elapsed)).toFixed(0)
      console.log(`  seen=${seen.toLocaleString()} written=${written.toLocaleString()} score_filtered=${scoreFiltered.toLocaleString()} ${rate}/s`)
    }
    if (LIMIT > 0 && written >= LIMIT) break
  }
  out.end()

  const forbidden = forbiddenFeatureNames(featureCols)
  const manifest = {
    generated_at: new Date().toISOString(),
    version: 'v0.4-timeline',
    db_path: DB_PATH,
    output_path: OUT_PATH,
    score_mode: SCORE_MODE,
    min_scores: MIN_SCORES,
    min_year: MIN_YEAR,
    rows_seen: seen,
    rows_written: written,
    score_filtered: scoreFiltered,
    invalid_target_filtered: invalidTarget,
    columns: header,
    id_cols: idCols,
    feature_cols: featureCols,
    label_cols: labelCols,
    forbidden_feature_count: forbidden.length,
    forbidden_remaining: forbidden,
    notes: {
      target: 'review_days_received_to_accepted clipped to [1, 730], plus log1p label.',
      leakage_rule: 'No citations, fulltext, OA availability, or post-publication article metrics. j_hist_jcr_jif is latest journal_year_metrics row with year < paper.year.',
      split_rule: 'Training script uses random split only.',
    },
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')

  console.log(`\nWrote ${written.toLocaleString()} rows x ${header.length.toLocaleString()} columns`)
  console.log(`Forbidden remaining: ${forbidden.length}`)
  console.log(`CSV: ${OUT_PATH}`)
  console.log(`Manifest: ${MANIFEST_PATH}`)
  db.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
