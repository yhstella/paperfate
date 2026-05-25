#!/usr/bin/env node
// Build FateCore v0.3 training matrix.
//
// Output is a single CSV with feature columns + y_* labels:
//   DATA_ROOT/features/v0.3-features.csv
//   DATA_ROOT/features/v0.3-features-manifest.json
//
// Leakage rule: same-year target journal metrics are labels only. Journal feature
// columns use the latest journal_year_metrics row with metric_year < paper.year.

import Database from 'better-sqlite3'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
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
const LIMIT = Number(arg('limit', '0'))
const MIN_YEAR = Number(arg('min-year', '2000'))
const MAX_YEAR = Number(arg('max-year', String(new Date().getFullYear())))
const REQUIRE_JIF = ARGS.includes('--require-jif')
const OUT_PATH = arg('out', join(OUT_DIR, 'v0.3-features.csv'))
const MANIFEST_PATH = arg('manifest', join(OUT_DIR, 'v0.3-features-manifest.json'))

mkdirSync(OUT_DIR, { recursive: true })

function parseJsonArray(text) {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(text) {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
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

function topicId(primaryTopicJson) {
  const topic = parseJsonObject(primaryTopicJson)
  const id = topic?.id ? String(topic.id) : ''
  const m = id.match(/T\d+/i)
  return m ? m[0].toUpperCase() : null
}

function firstMeshRoot(meshTerms) {
  const first = meshTerms.find(Boolean)
  if (!first) return null
  return String(first).split('/')[0].trim().toLowerCase() || null
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

function loadScoreStats(db) {
  if (MIN_SCORES <= 0) return new Map()

  console.log(`Preloading Q score aggregates mode=${SCORE_MODE} min_scores=${MIN_SCORES}...`)
  const t0 = Date.now()
  const map = new Map()
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
    WHERE mode = ?
    GROUP BY doi
    HAVING q_score_count >= ?
  `).iterate(SCORE_MODE, MIN_SCORES)

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

  console.log(`  score aggregates: ${map.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return map
}

function loadTopicFwciMeans(db) {
  console.log('Preloading primary_topic FWCI means...')
  const t0 = Date.now()
  const acc = new Map()
  for (const r of db.prepare(`
    SELECT primary_topic_json, fwci
    FROM papers
    WHERE primary_topic_json IS NOT NULL AND primary_topic_json != ''
      AND fwci IS NOT NULL
  `).iterate()) {
    const tid = topicId(r.primary_topic_json)
    const f = num(r.fwci)
    if (!tid || f === null) continue
    const a = acc.get(tid) || { sum: 0, n: 0 }
    a.sum += f
    a.n++
    acc.set(tid, a)
  }
  const means = new Map()
  for (const [tid, a] of acc) means.set(tid, a.sum / a.n)
  console.log(`  topics: ${means.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return means
}

function loadJournalMetrics(db) {
  console.log('Preloading journal_year_metrics...')
  const t0 = Date.now()
  const sameYear = new Map()
  const byIssn = new Map()
  for (const r of db.prepare(`
    SELECT
      issn, year, jcr_jif, jcr_jif_5yr, jci, sjr, scimago_h_index,
      total_docs_year, total_cites_3y, citable_docs_3y, cites_per_doc_2y,
      eigenfactor, normalized_eigenfactor, article_influence, immediacy_index,
      jci_percentile, estimated_jif, wayback_jif
    FROM journal_year_metrics
    WHERE issn IS NOT NULL AND issn != '' AND year IS NOT NULL
  `).iterate()) {
    sameYear.set(`${r.issn}|${r.year}`, r)
    if (!byIssn.has(r.issn)) byIssn.set(r.issn, [])
    byIssn.get(r.issn).push(r)
  }
  for (const rows of byIssn.values()) rows.sort((a, b) => a.year - b.year)
  console.log(`  same-year rows: ${sameYear.size.toLocaleString()} issn: ${byIssn.size.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return { sameYear, byIssn }
}

const featureCols = [
  'year',
  'pub_year_age',
  'title_word_count',
  'abstract_word_count',
  'has_structured_abstract',
  'publication_types_count',
  'mesh_terms_count',
  'first_mesh_root_hash',
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
  'citations_openalex',
  'fwci',
  'fwci_topic_norm',
  'reference_count',
  'funder_count',
  'unpaywall_is_oa',
  'unpaywall_journal_oa',
  'unpaywall_journal_doaj',
  'has_pmcid',
  'pmc_body_word_count',
  'pmc_figure_count',
  'pmc_table_count',
  'pmc_ref_count',
  'epmc_body_word_count',
  'pdf_body_words',
  'preprint_exists',
  'preprint_pub_gap_days',
  'first_author_h_index',
  'last_author_h_index',
  'max_team_h_index',
  'median_team_h_index',
  'team_size_with_id',
  'international_collab',
  'icite_citation_count',
  'icite_nih_percentile',
  'icite_apt',
  'icite_is_clinical',
  'icite_cited_by_clin',
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
  'j_hist_jcr_jif_5yr',
  'j_hist_jci',
  'j_hist_sjr',
  'j_hist_scimago_h_index',
  'j_hist_total_docs_year',
  'j_hist_cites_per_doc_2y',
  'j_hist_eigenfactor',
  'j_hist_article_influence',
]

const labelCols = ['y_jcr_jif', 'y_icite_rcr', 'y_citations_log']

function stableStringHash(value) {
  if (!value) return null
  let h = 2166136261
  for (const ch of String(value)) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function buildFeatureRow(p, ctx) {
  const pubTypes = parseJsonArray(p.publication_types_json)
  const meshTerms = parseJsonArray(p.mesh_terms_json)
  const authors = parseJsonArray(p.authors_json)
  const funders = parseJsonArray(p.funder_json)
  const pubFlags = pubTypeFlags(pubTypes)
  const tid = topicId(p.primary_topic_json)
  const fwci = num(p.fwci)
  const topicMean = tid ? ctx.topicFwciMeans.get(tid) : null
  const hist = p.issn && p.year ? latestBefore(ctx.journalMetrics.byIssn.get(p.issn), p.year) : null
  const q = ctx.scoreStats.get(p.doi) || {}

  return {
    year: p.year,
    pub_year_age: p.year ? ctx.currentYear - p.year : null,
    title_word_count: countWords(p.title),
    abstract_word_count: countWords(p.abstract),
    has_structured_abstract: structuredAbstract(p.abstract),
    publication_types_count: pubTypes.length,
    mesh_terms_count: meshTerms.length,
    first_mesh_root_hash: stableStringHash(firstMeshRoot(meshTerms)),
    is_research_article: bool01(p.icite_is_research_article),
    is_clinical: bool01(p.icite_is_clinical),
    is_review: pubFlags.is_review,
    is_case_report: pubFlags.is_case_report,
    is_trial: pubFlags.is_trial,
    author_count: authors.length,
    has_first_affiliation: p.first_affiliation ? 1 : 0,
    has_funder: (funders.length > 0 || Number(p.has_nih_grant) > 0) ? 1 : 0,
    has_nih_grant: bool01(p.has_nih_grant),
    n_nih_grants: num(p.n_nih_grants),
    citations_openalex: num(p.citations_openalex),
    fwci,
    fwci_topic_norm: fwci !== null && topicMean !== null ? fwci - topicMean : null,
    citations_s2: num(p.citations_s2),
    influential_citations: num(p.influential_citations),
    citations_crossref: num(p.citations_crossref),
    reference_count: num(p.reference_count),
    funder_count: funders.length,
    unpaywall_is_oa: bool01(p.unpaywall_is_oa),
    unpaywall_journal_oa: bool01(p.unpaywall_journal_oa),
    unpaywall_journal_doaj: bool01(p.unpaywall_journal_doaj),
    has_pmcid: p.pmcid ? 1 : 0,
    pmc_body_word_count: num(p.pmc_body_word_count),
    pmc_section_count: num(p.pmc_section_count),
    pmc_figure_count: num(p.pmc_figure_count),
    pmc_table_count: num(p.pmc_table_count),
    pmc_ref_count: num(p.pmc_ref_count),
    pmc_has_data_avail: bool01(p.pmc_has_data_avail),
    pmc_has_ethics: bool01(p.pmc_has_ethics),
    pmc_has_coi: bool01(p.pmc_has_coi),
    epmc_body_word_count: num(p.epmc_body_word_count),
    epmc_section_count: num(p.epmc_section_count),
    epmc_figure_count: num(p.epmc_figure_count),
    epmc_ref_count: num(p.epmc_ref_count),
    pdf_body_words: num(p.pdf_body_words),
    pdf_num_pages: num(p.pdf_num_pages),
    preprint_exists: p.preprint_doi ? 1 : 0,
    preprint_pub_gap_days: num(p.preprint_pub_gap_days),
    first_author_h_index: num(p.first_author_h_index),
    last_author_h_index: num(p.last_author_h_index),
    max_team_h_index: num(p.max_team_h_index),
    median_team_h_index: num(p.median_team_h_index),
    team_size_with_id: num(p.team_size_with_id),
    international_collab: bool01(p.international_collab),
    icite_citation_count: num(p.icite_citation_count),
    icite_nih_percentile: num(p.icite_nih_percentile),
    icite_apt: num(p.icite_apt),
    icite_is_clinical: bool01(p.icite_is_clinical),
    icite_cited_by_clin: num(p.icite_cited_by_clin),
    icite_rcr: num(p.icite_rcr),
    icite_citations_per_year: num(p.icite_citations_per_year),
    icite_expected_cit_per_year: num(p.icite_expected_cit_per_year),
    icite_field_citation_rate: num(p.icite_field_citation_rate),
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
    j_hist_jcr_jif_5yr: num(hist?.jcr_jif_5yr),
    j_hist_jci: num(hist?.jci),
    j_hist_sjr: num(hist?.sjr),
    j_hist_scimago_h_index: num(hist?.scimago_h_index),
    j_hist_total_docs_year: num(hist?.total_docs_year),
    j_hist_total_cites_3y: num(hist?.total_cites_3y),
    j_hist_citable_docs_3y: num(hist?.citable_docs_3y),
    j_hist_cites_per_doc_2y: num(hist?.cites_per_doc_2y),
    j_hist_eigenfactor: num(hist?.eigenfactor),
    j_hist_article_influence: num(hist?.article_influence),
    j_hist_immediacy_index: num(hist?.immediacy_index),
    j_hist_jci_percentile: num(hist?.jci_percentile),
    j_hist_estimated_jif: num(hist?.estimated_jif),
    j_hist_wayback_jif: num(hist?.wayback_jif),
  }
}

function labelsForPaper(p, journalMetrics) {
  const same = p.issn && p.year ? journalMetrics.sameYear.get(`${p.issn}|${p.year}`) : null
  const citations = num(p.citations_openalex) ?? num(p.citations_s2)
  return {
    y_jcr_jif: num(same?.jcr_jif),
    y_icite_rcr: num(p.icite_rcr),
    y_citations_log: citations === null ? null : Math.log1p(Math.max(0, citations)).toFixed(6),
  }
}

function hasUsableLabel(labels) {
  if (REQUIRE_JIF) return labels.y_jcr_jif !== null
  return labels.y_jcr_jif !== null || labels.y_icite_rcr !== null || labels.y_citations_log !== null
}

function main() {
  console.log('PaperFate FateCore v0.3 feature builder')
  console.log(`DB: ${DB_PATH}`)
  console.log(`Output: ${OUT_PATH}`)
  console.log(`Manifest: ${MANIFEST_PATH}`)
  console.log(`Args: score_mode=${SCORE_MODE} min_scores=${MIN_SCORES} years=${MIN_YEAR}-${MAX_YEAR} limit=${LIMIT || 'none'} require_jif=${REQUIRE_JIF}`)

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  db.pragma('busy_timeout = 60000')

  const scoreStats = loadScoreStats(db)
  const topicFwciMeans = loadTopicFwciMeans(db)
  const journalMetrics = loadJournalMetrics(db)
  const ctx = {
    scoreStats,
    topicFwciMeans,
    journalMetrics,
    currentYear: new Date().getFullYear(),
  }

  const out = createWriteStream(OUT_PATH, { encoding: 'utf8' })
  const header = ['doi', 'pmid', ...featureCols, ...labelCols]
  writeCsvRow(out, header)

  const paperRows = db.prepare(`
    SELECT
      doi, pmid, title, abstract, journal, issn, year,
      publication_types_json, mesh_terms_json, authors_json, first_affiliation,
      citations_openalex, fwci, primary_topic_json,
      citations_s2, influential_citations, reference_count, citations_crossref, funder_json,
      icite_rcr, icite_nih_percentile, icite_citation_count, icite_citations_per_year,
      icite_expected_cit_per_year, icite_field_citation_rate, icite_is_clinical,
      icite_is_research_article, icite_apt, icite_cited_by_clin,
      unpaywall_is_oa, unpaywall_journal_oa, unpaywall_journal_doaj,
      pmcid, pmc_body_word_count, pmc_section_count, pmc_figure_count, pmc_table_count,
      pmc_ref_count, pmc_has_data_avail, pmc_has_ethics, pmc_has_coi,
      epmc_body_word_count, epmc_section_count, epmc_figure_count, epmc_ref_count,
      pdf_body_words, pdf_num_pages,
      preprint_doi, preprint_pub_gap_days,
      first_author_h_index, last_author_h_index, max_team_h_index, median_team_h_index,
      team_size_with_id, international_collab,
      has_nih_grant, n_nih_grants
    FROM papers
    WHERE doi IS NOT NULL AND doi != ''
      AND year BETWEEN ? AND ?
      AND abstract IS NOT NULL AND abstract != ''
  `).iterate(MIN_YEAR, MAX_YEAR)

  const t0 = Date.now()
  let seen = 0
  let scoreFiltered = 0
  let labelFiltered = 0
  let written = 0

  for (const p of paperRows) {
    seen++
    if (MIN_SCORES > 0 && !scoreStats.has(p.doi)) {
      scoreFiltered++
      continue
    }

    const labels = labelsForPaper(p, journalMetrics)
    if (!hasUsableLabel(labels)) {
      labelFiltered++
      continue
    }

    const features = buildFeatureRow(p, ctx)
    writeCsvRow(out, [
      p.doi,
      p.pmid,
      ...featureCols.map(c => features[c]),
      ...labelCols.map(c => labels[c]),
    ])
    written++

    if (written % 10000 === 0) {
      const elapsed = (Date.now() - t0) / 1000
      const rate = (seen / Math.max(1, elapsed)).toFixed(0)
      console.log(`  seen=${seen.toLocaleString()} written=${written.toLocaleString()} score_filtered=${scoreFiltered.toLocaleString()} label_filtered=${labelFiltered.toLocaleString()} ${rate}/s`)
    }

    if (LIMIT > 0 && written >= LIMIT) break
  }

  out.end()
  const manifest = {
    generated_at: new Date().toISOString(),
    db_path: DB_PATH,
    output_path: OUT_PATH,
    version: 'v0.3',
    score_mode: SCORE_MODE,
    min_scores: MIN_SCORES,
    min_year: MIN_YEAR,
    max_year: MAX_YEAR,
    require_jif: REQUIRE_JIF,
    rows_seen: seen,
    rows_written: written,
    score_filtered: scoreFiltered,
    label_filtered: labelFiltered,
    columns: header,
    feature_cols: featureCols,
    label_cols: labelCols,
    notes: {
      leakage_rule: 'Same-year journal_year_metrics are labels only. j_hist_* features use latest metric row with metric_year < paper.year.',
      q_scores: 'Per-item Q500 scores are summarized as aggregate q_* columns to keep v0.3 matrix compact.',
      fwci_topic_norm: 'fwci minus mean fwci among papers with the same OpenAlex primary_topic_id.',
      first_mesh_root_hash: 'Stable FNV-1a hash of the first MeSH root term; numeric to keep CSV model-ready.',
    },
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))

  console.log(`\nWrote ${written.toLocaleString()} rows x ${header.length.toLocaleString()} columns`)
  console.log(`  CSV:      ${OUT_PATH}`)
  console.log(`  Manifest: ${MANIFEST_PATH}`)
  db.close()
}

main()
