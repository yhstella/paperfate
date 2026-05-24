#!/usr/bin/env node
// Build the FateCore v0.3-prepub training matrix by filtering the v0.3 matrix
// down to production-safe pre-submission features only.
//
// This intentionally excludes all post-publication/corpus-response signals:
// citations, FWCI, iCite, OpenAlex/Crossref reference counts, PMC/EPMC/PDF
// fulltext, PMCID, Unpaywall article indexing, and accepted-journal history.
//
// Output:
//   DATA_ROOT/features/v0.3-prepub-features.csv
//   DATA_ROOT/features/v0.3-prepub-features-manifest.json

import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const FEATURES_DIR = join(DATA_ROOT, 'features')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const IN_PATH = arg('in', join(FEATURES_DIR, 'v0.3-features.csv'))
const IN_MANIFEST = arg('in-manifest', join(FEATURES_DIR, 'v0.3-features-manifest.json'))
const OUT_PATH = arg('out', join(FEATURES_DIR, 'v0.3-prepub-features.csv'))
const MANIFEST_PATH = arg('manifest', join(FEATURES_DIR, 'v0.3-prepub-features-manifest.json'))
const LIMIT = Number(arg('limit', '0'))

const idCols = ['doi', 'pmid']
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
  'preprint_exists',
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
]
const labelCols = ['y_jcr_jif', 'y_icite_rcr', 'y_citations_log']
const outCols = [...idCols, ...featureCols, ...labelCols]

const forbiddenFeaturePatterns = [
  /^citations_/,
  /^fwci/,
  /^reference_count$/,
  /^influential_citations$/,
  /^icite_(?!is_clinical$)/,
  /^unpaywall_/,
  /^has_pmcid$/,
  /^pmc_/,
  /^epmc_/,
  /^pdf_/,
  /^j_hist_/,
  /^preprint_pub_gap_days$/,
  /^pub_year_age$/,
]

function splitCsvLine(line) {
  // The v0.3 matrix contains numeric features plus DOI/PMID ids. This parser
  // still handles quoted cells to keep the filter safe if ids are quoted.
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

function csvCell(value) {
  if (value === null || value === undefined || value === '') return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function writeCsvRow(stream, values) {
  stream.write(values.map(csvCell).join(',') + '\n')
}

function forbiddenFeatureNames(cols) {
  return cols.filter(c => forbiddenFeaturePatterns.some(re => re.test(c)))
}

async function main() {
  if (!existsSync(IN_PATH)) throw new Error(`input CSV not found: ${IN_PATH}`)
  mkdirSync(FEATURES_DIR, { recursive: true })

  console.log('PaperFate FateCore v0.3-prepub feature builder')
  console.log(`Input:    ${IN_PATH}`)
  console.log(`Output:   ${OUT_PATH}`)
  console.log(`Manifest: ${MANIFEST_PATH}`)
  console.log(`Features: ${featureCols.length}`)

  const rl = createInterface({
    input: createReadStream(IN_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const out = createWriteStream(OUT_PATH, { encoding: 'utf8' })

  let header = null
  let indexes = null
  let rowsSeen = 0
  let rowsWritten = 0
  let missingLabelRows = 0

  for await (const line of rl) {
    if (header === null) {
      header = splitCsvLine(line)
      const idx = new Map(header.map((name, i) => [name, i]))
      const missing = outCols.filter(c => !idx.has(c))
      if (missing.length) throw new Error(`input CSV missing expected columns: ${missing.join(', ')}`)
      indexes = outCols.map(c => idx.get(c))
      writeCsvRow(out, outCols)
      continue
    }
    if (!line) continue
    rowsSeen++
    const cells = splitCsvLine(line)
    if (!labelCols.some(c => cells[header.indexOf(c)] !== '')) {
      missingLabelRows++
      continue
    }
    writeCsvRow(out, indexes.map(i => cells[i] ?? ''))
    rowsWritten++
    if (rowsWritten % 100000 === 0) {
      console.log(`  written=${rowsWritten.toLocaleString()} seen=${rowsSeen.toLocaleString()}`)
    }
    if (LIMIT > 0 && rowsWritten >= LIMIT) break
  }
  out.end()

  const inputManifest = existsSync(IN_MANIFEST)
    ? JSON.parse(await import('node:fs').then(fs => fs.readFileSync(IN_MANIFEST, 'utf8')))
    : {}
  const sourceFeatures = inputManifest.feature_cols || []
  const excludedFeatureCols = sourceFeatures.filter(c => !featureCols.includes(c))
  const forbiddenRemaining = forbiddenFeatureNames(featureCols)

  const manifest = {
    generated_at: new Date().toISOString(),
    version: 'v0.3-prepub',
    source_csv: IN_PATH,
    source_manifest: IN_MANIFEST,
    output_path: OUT_PATH,
    rows_seen: rowsSeen,
    rows_written: rowsWritten,
    missing_label_rows: missingLabelRows,
    columns: outCols,
    feature_cols: featureCols,
    label_cols: labelCols,
    pre_submission_only: true,
    forbidden_feature_count: forbiddenRemaining.length,
    forbidden_remaining: forbiddenRemaining,
    excluded_feature_cols: excludedFeatureCols,
    notes: {
      policy: 'Cold-start production-safe feature set. Accepted-journal historical metrics are excluded because the final journal is unknown in true cold-start tests.',
      allowed_groups: [
        'title/abstract shape',
        'article type flags',
        'author/funding metadata',
        'NIH grant metadata',
        'Q-score aggregate features computed from supplied manuscript text',
      ],
      forbidden_groups: [
        'citations/FWCI/iCite',
        'OpenAlex/Crossref/S2 reference counts',
        'PMC/EPMC/PDF fulltext and PMCID',
        'Unpaywall article indexing',
        'accepted-journal historical metrics',
        'post-publication preprint-to-publication gap',
      ],
    },
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')

  console.log(`\nWrote ${rowsWritten.toLocaleString()} rows x ${outCols.length.toLocaleString()} columns`)
  console.log(`Forbidden remaining: ${forbiddenRemaining.length}`)
  if (forbiddenRemaining.length) console.log(`  ${forbiddenRemaining.join(', ')}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
