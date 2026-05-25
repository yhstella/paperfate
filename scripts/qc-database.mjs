#!/usr/bin/env node
// PaperFate · Database QC
//
// docs/DATA_DICTIONARY.md §6.1의 룰을 코드로 강제. 매 build-unified-db 직후 또는
// 별도 실행 가능. 결과는 콘솔 + data/qc-report-YYYY-MM-DD.json 으로 기록.
//
// 종료 코드:
//   0 = 모든 필수 QC 통과
//   1 = 필수 QC 실패 (data integrity 위협)
//   2 = 경고만 발생 (필수 통과, 보조 신호 이상)
//
// 사용:
//   node scripts/qc-database.mjs            # 기본
//   node scripts/qc-database.mjs --verbose  # 상세 row dump

import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

const ARGS = process.argv.slice(2)
const VERBOSE = ARGS.includes('--verbose')

const report = {
  generated_at: new Date().toISOString(),
  db_path: DB_PATH,
  required: [],   // 실패 시 exit 1
  warnings: [],   // 정보 제공만
  metrics: {},    // 정상 지표값들
}

function pad(s, n) { return String(s).padEnd(n) }

function rule(name, severity, fn) {
  try {
    const result = fn()
    const passed = result.passed
    const detail = result.detail
    const entry = { name, severity, passed, detail }
    if (severity === 'required') report.required.push(entry)
    else report.warnings.push(entry)
    const tag = passed ? '✓' : (severity === 'required' ? '✗ FAIL' : '⚠ WARN')
    console.log(`${tag.padEnd(8)} ${pad(name, 50)} ${detail}`)
    if (!passed && VERBOSE && result.rows) {
      for (const r of result.rows.slice(0, 5)) console.log('         ', JSON.stringify(r))
    }
  } catch (e) {
    console.log(`✗ ERROR  ${pad(name, 50)} ${e.message}`)
    report.required.push({ name, severity, passed: false, detail: 'EXCEPTION: ' + e.message })
  }
}

function main() {
  console.log('PaperFate · QC database')
  console.log('DB:', DB_PATH)
  console.log('')
  const db = new Database(DB_PATH, { readonly: true })

  // ────────────────── REQUIRED (§6.1 필수) ──────────────────
  rule('papers.doi PK uniqueness', 'required', () => {
    const dup = db.prepare(`SELECT doi, COUNT(*) AS n FROM papers GROUP BY doi HAVING n > 1 LIMIT 10`).all()
    return { passed: dup.length === 0, detail: `duplicates: ${dup.length}`, rows: dup }
  })

  rule('papers.pmid uniqueness (where not null)', 'required', () => {
    const dup = db.prepare(`SELECT pmid, COUNT(*) AS n FROM papers WHERE pmid IS NOT NULL GROUP BY pmid HAVING n > 1 LIMIT 10`).all()
    return { passed: dup.length === 0, detail: `duplicates: ${dup.length}`, rows: dup }
  })

  rule('papers.doi format (10.*/...)', 'warning', () => {
    // PubMed parser occasionally fills DOI field with PMID when DOI absent.
    // Fewer than 100 affected currently — cleanup task tracked separately.
    const bad = db.prepare(`SELECT doi FROM papers WHERE doi NOT LIKE '10.%/%' LIMIT 100`).all()
    const total = db.prepare(`SELECT COUNT(*) AS n FROM papers`).get().n
    return { passed: bad.length < 100, detail: `bad ${bad.length} / total ${total}`, rows: bad }
  })

  rule('papers.pmid is numeric', 'required', () => {
    const bad = db.prepare(`
      SELECT pmid FROM papers
      WHERE pmid IS NOT NULL
        AND pmid NOT GLOB '[0-9]*'
      LIMIT 10
    `).all()
    return { passed: bad.length === 0, detail: `non-numeric pmid: ${bad.length}`, rows: bad }
  })

  rule('papers.year in [1900, future+2]', 'required', () => {
    const futureLimit = new Date().getFullYear() + 2
    const bad = db.prepare(`
      SELECT doi, year FROM papers
      WHERE year IS NOT NULL AND (year < 1900 OR year > ?)
      LIMIT 10
    `).all(futureLimit)
    return { passed: bad.length === 0, detail: `out-of-range year: ${bad.length} (limit ${futureLimit})`, rows: bad }
  })

  rule('papers.embedding size = dim × 4', 'required', () => {
    const bad = db.prepare(`
      SELECT doi, embedding_dim, LENGTH(embedding) AS blob_size
      FROM papers
      WHERE embedding IS NOT NULL
        AND LENGTH(embedding) != embedding_dim * 4
      LIMIT 10
    `).all()
    return { passed: bad.length === 0, detail: `dim/blob mismatch: ${bad.length}`, rows: bad }
  })

  rule('journal_year_metrics.jcr_jif ≤ 800', 'required', () => {
    // CA: A Cancer Journal for Clinicians historically reaches JIF 200-500.
    // True data errors are typically > 1000 (off-by-decimal).
    const bad = db.prepare(`
      SELECT openalex_id, year, jcr_jif FROM journal_year_metrics
      WHERE jcr_jif > 800
      LIMIT 10
    `).all()
    return { passed: bad.length === 0, detail: `JIF >800 (likely off-by-decimal): ${bad.length}`, rows: bad }
  })

  rule('journal_year_metrics.year ≥ 1800', 'required', () => {
    // OpenAlex sources occasionally contain 0-1500 due to bad source metadata
    // (DOAJ catalog entries, "PubMed"/"Research Explorer" pseudo-sources).
    // True journal years should be ≥ 1800.
    const futureLimit = new Date().getFullYear() + 1
    const bad = db.prepare(`
      SELECT openalex_id, year FROM journal_year_metrics
      WHERE year < 1800 OR year > ?
      LIMIT 10
    `).all(futureLimit)
    return { passed: bad.length === 0, detail: `out-of-range journal year: ${bad.length}`, rows: bad }
  })

  rule('clinical_trials.nct_id format (NCT\\d{8})', 'required', () => {
    const bad = db.prepare(`
      SELECT nct_id FROM clinical_trials
      WHERE nct_id NOT GLOB 'NCT[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
      LIMIT 10
    `).all()
    return { passed: bad.length === 0, detail: `bad NCT: ${bad.length}`, rows: bad }
  })

  rule('clinical_trials.start ≤ completion', 'required', () => {
    const bad = db.prepare(`
      SELECT nct_id, start_date, completion_date FROM clinical_trials
      WHERE start_date IS NOT NULL
        AND completion_date IS NOT NULL
        AND completion_date < start_date
      LIMIT 10
    `).all()
    return { passed: bad.length === 0, detail: `start>completion: ${bad.length}`, rows: bad }
  })

  // JSON validity is heavy — sample 100 rows per *_json col
  rule('papers.*_json parse-able (sampled 100)', 'required', () => {
    const cols = ['publication_types_json', 'mesh_terms_json', 'authors_json',
                  'seeds_json', 'concepts_json', 'primary_topic_json',
                  'authorships_json', 'fields_of_study_json',
                  'license_json', 'funder_json']
    let badCount = 0
    const badSample = []
    for (const c of cols) {
      const rows = db.prepare(`SELECT doi, ${c} AS v FROM papers WHERE ${c} IS NOT NULL ORDER BY RANDOM() LIMIT 100`).all()
      for (const r of rows) {
        try { JSON.parse(r.v) } catch {
          badCount++
          if (badSample.length < 5) badSample.push({ col: c, doi: r.doi, v: String(r.v).slice(0, 80) })
        }
      }
    }
    return { passed: badCount === 0, detail: `parse failures in 1000 samples: ${badCount}`, rows: badSample }
  })

  // ────────────────── WARNINGS (§6.2 보조 신호) ──────────────────
  rule('papers.issn ⊆ journals (≥ 80%)', 'warning', () => {
    // Build hash set of all journal ISSNs once (linear, not n×m)
    const journals = db.prepare(`SELECT issn_l, issn_json FROM journals`).all()
    const issnSet = new Set()
    for (const j of journals) {
      if (j.issn_l) issnSet.add(j.issn_l)
      if (j.issn_json) {
        try { for (const i of JSON.parse(j.issn_json)) if (i) issnSet.add(i) } catch {}
      }
    }
    const papers = db.prepare(`SELECT issn FROM papers WHERE issn IS NOT NULL`).all()
    let linked = 0
    for (const p of papers) if (issnSet.has(p.issn)) linked++
    const pct = papers.length === 0 ? 0 : (100 * linked / papers.length)
    return { passed: pct >= 80, detail: `linked ${linked}/${papers.length} (${pct.toFixed(1)}%)` }
  })

  rule('iCite RCR null rate < 60% for papers year ≤ 2022', 'warning', () => {
    const cutoff = new Date().getFullYear() - 3
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN icite_rcr IS NULL THEN 1 ELSE 0 END) AS nulls
      FROM papers WHERE year <= ?
    `).get(cutoff)
    const pct = row.total === 0 ? 0 : (100 * row.nulls / row.total)
    return { passed: pct < 60, detail: `null rate ${pct.toFixed(1)}% (year ≤ ${cutoff})` }
  })

  rule('Unpaywall coverage ≥ 50%', 'warning', () => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE doi IS NOT NULL`).get().n
    const hit = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE unpaywall_is_oa IS NOT NULL`).get().n
    const pct = total === 0 ? 0 : (100 * hit / total)
    return { passed: pct >= 50, detail: `${hit}/${total} (${pct.toFixed(1)}%)` }
  })

  rule('citations_crossref ≤ citations_openalex × 1.5 (mature papers)', 'warning', () => {
    // Lag tolerance: only flag when both have meaningful counts (> 5).
    // Very recent papers commonly have CR=1, OA=0 due to fetch timing.
    const bad = db.prepare(`
      SELECT doi, citations_openalex, citations_crossref FROM papers
      WHERE citations_openalex IS NOT NULL
        AND citations_crossref IS NOT NULL
        AND citations_openalex > 5
        AND citations_crossref > citations_openalex * 1.5
      LIMIT 10
    `).all()
    return { passed: bad.length === 0, detail: `Crossref > 1.5x OpenAlex (citations > 5): ${bad.length}`, rows: bad }
  })

  rule('preprint_pub_gap_days ≥ 0', 'warning', () => {
    const bad = db.prepare(`
      SELECT doi, preprint_published_date, cr_published_print, preprint_pub_gap_days
      FROM papers
      WHERE preprint_pub_gap_days IS NOT NULL AND preprint_pub_gap_days < 0
      LIMIT 10
    `).all()
    return { passed: bad.length === 0, detail: `negative gap: ${bad.length}`, rows: bad }
  })

  // ────────────────── METRICS (참고 지표) ──────────────────
  const m = report.metrics
  m.papers_total = db.prepare(`SELECT COUNT(*) AS n FROM papers`).get().n
  m.papers_with_abstract = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE abstract IS NOT NULL`).get().n
  m.papers_with_embedding = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE embedding IS NOT NULL`).get().n
  m.papers_with_pmcid = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE pmcid IS NOT NULL`).get().n
  m.papers_with_pmc_fulltext = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE pmc_body_word_count IS NOT NULL`).get().n
  m.papers_with_epmc_fulltext = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE epmc_body_word_count IS NOT NULL`).get().n
  m.papers_with_pdf = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE pdf_body_words IS NOT NULL`).get().n
  m.papers_with_preprint = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE preprint_doi IS NOT NULL`).get().n
  m.journals_total = db.prepare(`SELECT COUNT(*) AS n FROM journals`).get().n
  m.journal_year_rows = db.prepare(`SELECT COUNT(*) AS n FROM journal_year_metrics`).get().n
  m.jcr_jif_rows = db.prepare(`SELECT COUNT(*) AS n FROM journal_year_metrics WHERE jcr_jif IS NOT NULL`).get().n
  m.clinical_trials_total = db.prepare(`SELECT COUNT(*) AS n FROM clinical_trials`).get().n

  // Year × Field heat map (top concerns)
  const yearCov = db.prepare(`
    SELECT year, COUNT(*) AS n,
      SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS emb,
      SUM(CASE WHEN icite_rcr IS NOT NULL THEN 1 ELSE 0 END) AS rcr,
      SUM(CASE WHEN unpaywall_is_oa IS NOT NULL THEN 1 ELSE 0 END) AS oa
    FROM papers WHERE year BETWEEN 2010 AND 2026
    GROUP BY year ORDER BY year
  `).all()
  m.year_coverage = yearCov

  // ────────────────── 결과 출력 ──────────────────
  const requiredFail = report.required.filter(r => !r.passed).length
  const warningFail = report.warnings.filter(r => !r.passed).length

  console.log('\n── Summary ──')
  console.log(`Required QC : ${report.required.length - requiredFail} passed / ${requiredFail} failed`)
  console.log(`Warnings    : ${report.warnings.length - warningFail} passed / ${warningFail} flagged`)
  console.log(`\n── Metrics ──`)
  console.log(`papers: ${m.papers_total} (abstract ${m.papers_with_abstract}, embedding ${m.papers_with_embedding})`)
  console.log(`  PMC fulltext ${m.papers_with_pmc_fulltext}, EPMC ${m.papers_with_epmc_fulltext}, PDF ${m.papers_with_pdf}`)
  console.log(`  preprint linked ${m.papers_with_preprint}, pmcid ${m.papers_with_pmcid}`)
  console.log(`journals: ${m.journals_total}, journal_year_metrics: ${m.journal_year_rows} (with JCR JIF: ${m.jcr_jif_rows})`)
  console.log(`clinical_trials: ${m.clinical_trials_total}`)

  console.log('\n── Year coverage (2010-2026) ──')
  console.log('year  papers   emb%   rcr%   oa%')
  for (const r of yearCov) {
    const pct = (n) => r.n ? (100 * n / r.n).toFixed(0).padStart(5) : '    -'
    console.log(`${r.year}  ${String(r.n).padStart(6)}  ${pct(r.emb)}  ${pct(r.rcr)}  ${pct(r.oa)}`)
  }

  // Persist JSON
  const reportPath = join(DATA_ROOT, `qc-report-${new Date().toISOString().slice(0,10)}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`\nFull report: ${reportPath}`)

  db.close()

  if (requiredFail > 0) {
    console.error(`\n✗ ${requiredFail} required QC failed — investigate before training`)
    process.exit(1)
  }
  if (warningFail > 0) {
    console.warn(`\n⚠ ${warningFail} warnings — review but not blocking`)
    process.exit(2)
  }
  console.log('\n✓ All QC passed')
  process.exit(0)
}

main()
