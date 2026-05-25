#!/usr/bin/env node
// PaperFate · FateCore feature matrix builder
//
// paperfate.db → CSV/Parquet feature matrix for LightGBM training.
//
// Output:
//   data/fatecore/features-YYYY-MM-DD.csv          (X: features)
//   data/fatecore/labels-YYYY-MM-DD.csv            (y: targets — JIF, citations, RCR)
//   data/fatecore/feature-schema.json              (column docs)
//
// 사용:
//   node scripts/build-fatecore-features.mjs                          # 전체 코퍼스
//   node scripts/build-fatecore-features.mjs --min-scores 50          # 최소 채점 50 items 있는 paper만
//   node scripts/build-fatecore-features.mjs --label jcr_jif          # JIF label만 (drop NULL labels)
//   node scripts/build-fatecore-features.mjs --score-mode codex_deterministic   # 어느 mode 점수 사용
//
// 학습 데이터 구조 (X → y):
//   X: ~640 cols
//     ├─ 100 cols  Q100 점수 (각 item별 numeric 0-5, NA→-1)
//     ├─ ~50 cols  paper metadata (year, citations, fwci, RCR, references, ...)
//     ├─ ~20 cols  journal metadata (h_index, two_yr_mean_citedness, is_oa, ...)
//     ├─ ~10 cols  author metadata (author count, first_affiliation present, ...)
//     └─ 768 cols  SPECTER2 embedding (optional, separate parquet for size)
//   y: 3-4 cols
//     ├─ jcr_jif (출판 시점) ← 핵심 target
//     ├─ icite_rcr           ← weak label
//     ├─ citations_5yr       ← derived
//     └─ desk_reject_risk    ← derived (citations==0 within 2yr proxy)

import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'fatecore')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=')[1]
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i+1] && !ARGS[i+1].startsWith('--')) return ARGS[i+1]
  return def
}

const MIN_SCORES = parseInt(arg('min-scores', '20'))
const SCORE_MODE = arg('score-mode', 'codex_deterministic') // codex_deterministic | llm | rule | external
const LABEL_TYPE = arg('label', 'multi') // jcr_jif | icite_rcr | citations | multi

mkdirSync(OUT_DIR, { recursive: true })

const db = new Database(DB_PATH, { readonly: true })

// ── 1. Build column schema ──
// 🚨 X_pre vs X_post separation (사용자 #5 통찰 — docs/FATECORE_DESIGN.md §3.7):
// X_pre: 추론 시점에 사용 가능 (production-safe). 학습 X에 포함.
// X_post: publish 후에만 알 수 있음. y label로만 사용, X에서 제외.
const q100Items = db.prepare(`
  SELECT DISTINCT item_id
  FROM paper_scores
  WHERE mode = ?
  ORDER BY item_id
`).all(SCORE_MODE).map(r => r.item_id)
const q100Cols = q100Items.map(id => `q_${id}`)

// X_pre: paper metadata 가용 at submission time
const preMetaCols = [
  'year', 'pub_year_age',
  'is_research_article',      // from publication_types regex — 추론 시 사용자 manuscript에서 추출
  'is_clinical',              // 동일
  'author_count', 'has_first_affiliation', 'has_funder',
  'first_author_h_index', 'last_author_h_index',
  'max_team_h_index', 'median_team_h_index',
  'team_size_with_id', 'international_collab',
  'publication_types_count', 'mesh_terms_count',
  'is_preprint',              // optional, user에게 묻거나 default 0
]
// ⚠️ Target journal metadata REMOVED entirely from v0.1 baseline.
//
// Rationale: 사용자가 target journal 명시 안 한 default case에 대비.
// 학습 시: j_* 들이 같은 시점 journal-level metric이라 y_jcr_jif와 trivially correlated
//          (e.g. j_two_yr_mean_citedness ≈ jcr_jif의 OpenAlex version).
// 추론 시: target journal unknown이면 j_* features unavailable → 빈 vector로 generalize 안 됨.
//
// v0.2에서 optional target journal 별도 모델 추가 예정.
// v0.1은 paper-only quality → journal tier 추정 (진짜 forecast).
const preJournalCols = []

// X_post: publish 후에만 가용. 학습용 ablation 비교에만 사용, production X.
const postMetaCols = [
  'citations_openalex', 'citations_s2', 'citations_crossref',
  'fwci', 'icite_rcr', 'icite_nih_percentile', 'icite_apt',
  'icite_citations_per_year', 'icite_expected_cit_per_year', 'icite_field_citation_rate',
  'reference_count', 'influential_citations',
  'is_oa', 'unpaywall_is_oa', 'unpaywall_journal_oa', 'unpaywall_journal_doaj',
  'has_pmcid', 'pmc_body_word_count', 'pmc_section_count', 'pmc_figure_count',
  'pmc_table_count', 'pmc_ref_count', 'pmc_has_data_avail', 'pmc_has_ethics', 'pmc_has_coi',
  'epmc_body_word_count', 'pdf_body_words',
]
const postJournalCols = [
  'j_jcr_eigenfactor', 'j_jcr_article_influence',  // JCR proprietary, lookup-able but post-pub
]

const labelCols = ['y_jcr_jif', 'y_icite_rcr', 'y_citations_log']

// Default: X_pre only (production-safe). Use --include-post for ablation baseline.
const INCLUDE_POST = ARGS.includes('--include-post')
const metaCols = INCLUDE_POST ? [...preMetaCols, ...postMetaCols] : preMetaCols
const journalCols = INCLUDE_POST ? [...preJournalCols, ...postJournalCols] : preJournalCols
const allCols = ['doi', 'pmid', ...q100Cols, ...metaCols, ...journalCols, ...labelCols]

console.log('Schema:')
console.log(`  Q100 items:     ${q100Cols.length}`)
console.log(`  Paper meta:     ${metaCols.length}  (X_pre: ${preMetaCols.length}, X_post: ${INCLUDE_POST ? postMetaCols.length : 0})`)
console.log(`  Journal meta:   ${journalCols.length}  (X_pre: ${preJournalCols.length}, X_post: ${INCLUDE_POST ? postJournalCols.length : 0})`)
console.log(`  Labels:         ${labelCols.length}`)
console.log(`  Total cols:     ${allCols.length}`)
console.log(`  Mode:           ${INCLUDE_POST ? 'INCLUDE_POST (ablation baseline)' : 'X_pre only (production-safe)'}`)

// ── 2. Save schema ──
const schema = {
  generated_at: new Date().toISOString(),
  score_mode: SCORE_MODE,
  label_type: LABEL_TYPE,
  min_scores: MIN_SCORES,
  include_post: INCLUDE_POST,
  cols: allCols,
  q100_items: q100Items,
  pre_meta_cols: preMetaCols,
  post_meta_cols: postMetaCols,
  pre_journal_cols: preJournalCols,
  post_journal_cols: postJournalCols,
  meta_cols: metaCols,
  journal_cols: journalCols,
  label_cols: labelCols,
  notes: {
    q_score_NA: -1,
    q_score_unknown: -2,
    pre_vs_post: 'X_pre is production-safe (available at submission time). X_post is post-publication (citations, fwci, RCR, ...) — only for ablation baseline, NOT for production model.',
    label_jcr_jif: '출판 시점의 journal JIF — 가장 중요한 target',
    label_icite_rcr: 'NIH RCR — weak label, 분야 보정된 영향력',
    label_citations_log: 'log(citations_openalex + 1) — weak label, 정규화된 인용',
    train_split: 'random ONLY — 연도 기반 split 금지 (feedback_fatecore_validation.md)',
  },
}
writeFileSync(join(OUT_DIR, 'feature-schema.json'), JSON.stringify(schema, null, 2))
console.log(`\nSaved schema → ${join(OUT_DIR, 'feature-schema.json')}`)

// ── 3. Query papers with enough scores ──
// Optimized: use only paper_scores (mode index) — no papers JOIN needed
// SQLite avoids full table scan when mode index is selective
console.log(`\nQuerying eligible papers (mode=${SCORE_MODE}, ≥${MIN_SCORES} scores)...`)
const t1 = Date.now()
const eligibleDois = db.prepare(`
  SELECT doi, COUNT(*) AS n
  FROM paper_scores
  WHERE mode = ?
  GROUP BY doi
  HAVING n >= ?
`).all(SCORE_MODE, MIN_SCORES)
console.log(`Eligible papers: ${eligibleDois.length} (query ${((Date.now()-t1)/1000).toFixed(1)}s)`)

if (eligibleDois.length === 0) {
  console.error('No eligible papers. Try --score-mode external --min-scores 1')
  process.exit(1)
}

// ── 4. Build feature matrix ──
const today = new Date().toISOString().slice(0,10)
const featuresPath = join(OUT_DIR, `features-${today}.csv`)
const labelsPath = join(OUT_DIR, `labels-${today}.csv`)

const fout = createWriteStream(featuresPath)
const lout = createWriteStream(labelsPath)
fout.write(['doi', 'pmid', ...q100Cols, ...metaCols, ...journalCols].join(',') + '\n')
lout.write(['doi', ...labelCols].join(',') + '\n')

// ── Preload journals + journal_year_metrics into memory ──
console.log('\nPreloading journals + journal_year_metrics into memory...')
const tPre = Date.now()
const journalMap = new Map()  // issn_l → journal row
for (const j of db.prepare('SELECT issn_l, h_index, i10_index, two_yr_mean_citedness, works_count, cited_by_count, is_oa, is_in_doaj, is_core, apc_usd, first_publication_year FROM journals WHERE issn_l IS NOT NULL').iterate()) {
  journalMap.set(j.issn_l, j)
}
const jymMap = new Map()  // `${issn}|${year}` → metrics
for (const r of db.prepare('SELECT issn, year, jcr_jif, jcr_jif_5yr, jci, eigenfactor, article_influence FROM journal_year_metrics WHERE issn IS NOT NULL AND year IS NOT NULL').iterate()) {
  jymMap.set(`${r.issn}|${r.year}`, r)
}
console.log(`  journals: ${journalMap.size}, journal_year_metrics: ${jymMap.size}  (${((Date.now()-tPre)/1000).toFixed(1)}s)`)

// Now paper_scores: paginate doi list, fetch papers + scores
// Use single SELECT FROM papers (no JOIN — manual lookup from journalMap)
const paperQ = db.prepare(`SELECT * FROM papers WHERE doi = ?`)
const scoreQ = db.prepare(`SELECT item_id, score, raw_value FROM paper_scores WHERE doi=? AND mode=?`)

function safe(v, isNum = true) {
  if (v == null || v === '') return ''
  if (isNum && (typeof v === 'string' && isNaN(parseFloat(v)))) return ''
  return v
}

const currentYear = new Date().getFullYear()
let written = 0
const t0 = Date.now()

for (const { doi } of eligibleDois) {
  const p = paperQ.get(doi)
  if (!p) continue

  const scores = scoreQ.all(doi, SCORE_MODE)
  const scoreMap = {}
  for (const s of scores) {
    if (s.score !== null) scoreMap[s.item_id] = s.score
    else if (s.raw_value === 'na') scoreMap[s.item_id] = -1
    else if (s.raw_value === 'unknown') scoreMap[s.item_id] = -2
  }
  const qRow = q100Items.map(id => scoreMap[id] ?? '')

  // In-memory lookups (replace DB JOIN + jymQ)
  const j = p.issn ? journalMap.get(p.issn) : null
  if (j) {
    p.j_h_index = j.h_index
    p.j_i10_index = j.i10_index
    p.j_two_yr_mean_citedness = j.two_yr_mean_citedness
    p.j_works_count = j.works_count
    p.j_cited_by_count = j.cited_by_count
    p.j_is_oa = j.is_oa
    p.j_is_in_doaj = j.is_in_doaj
    p.j_is_core = j.is_core
    p.j_apc_usd = j.apc_usd
    p.j_first_publication_year = j.first_publication_year
  }
  const jym = (p.issn && p.year) ? jymMap.get(`${p.issn}|${p.year}`) : null

  // Parse JSON
  const authors = p.authors_json ? JSON.parse(p.authors_json) : []
  const pubTypes = p.publication_types_json ? JSON.parse(p.publication_types_json) : []
  const mesh = p.mesh_terms_json ? JSON.parse(p.mesh_terms_json) : []
  const funder = p.funder_json ? JSON.parse(p.funder_json) : []

  // X_pre paper meta (always included — production-safe)
  const preMetaVals = [
    p.year,
    p.year ? currentYear - p.year : '',
    p.icite_is_research_article, p.icite_is_clinical,
    authors.length, p.first_affiliation ? 1 : 0, funder.length > 0 ? 1 : 0,
    p.first_author_h_index, p.last_author_h_index,
    p.max_team_h_index, p.median_team_h_index,
    p.team_size_with_id, p.international_collab,
    pubTypes.length, mesh.length,
    p.preprint_doi ? 1 : 0,
  ]
  // v0.1: target journal features removed (leakage + default unavailable)
  const preJournalVals = []
  // X_post (ablation baseline only)
  const postMetaVals = INCLUDE_POST ? [
    p.citations_openalex, p.citations_s2, p.citations_crossref,
    p.fwci, p.icite_rcr, p.icite_nih_percentile, p.icite_apt,
    p.icite_citations_per_year, p.icite_expected_cit_per_year, p.icite_field_citation_rate,
    p.reference_count, p.influential_citations,
    p.is_oa, p.unpaywall_is_oa, p.unpaywall_journal_oa, p.unpaywall_journal_doaj,
    p.pmcid ? 1 : 0, p.pmc_body_word_count, p.pmc_section_count, p.pmc_figure_count,
    p.pmc_table_count, p.pmc_ref_count, p.pmc_has_data_avail, p.pmc_has_ethics, p.pmc_has_coi,
    p.epmc_body_word_count, p.pdf_body_words,
  ] : []
  const postJournalVals = INCLUDE_POST ? [
    jym?.eigenfactor, jym?.article_influence,
  ] : []
  const metaVals = [...preMetaVals, ...postMetaVals].map(v => safe(v))
  const journalVals = [...preJournalVals, ...postJournalVals].map(v => safe(v))

  // Labels
  const yJcrJif = jym?.jcr_jif ?? ''
  const yRcr = p.icite_rcr ?? ''
  const cit = p.citations_openalex ?? p.citations_s2
  const yCitLog = cit != null ? Math.log(cit + 1).toFixed(4) : ''

  // Filter rows with no label at all
  if (yJcrJif === '' && yRcr === '' && yCitLog === '') continue

  fout.write([doi, p.pmid ?? '', ...qRow, ...metaVals, ...journalVals].join(',') + '\n')
  lout.write([doi, yJcrJif, yRcr, yCitLog].join(',') + '\n')
  written++

  if (written % 5000 === 0) {
    const rate = (written / ((Date.now() - t0) / 1000)).toFixed(0)
    console.log(`  ${written}/${eligibleDois.length}  ${rate}/s`)
  }
}

fout.end()
lout.end()
console.log(`\n✓ Wrote ${written} rows`)
console.log(`  features: ${featuresPath}`)
console.log(`  labels:   ${labelsPath}`)
db.close()
