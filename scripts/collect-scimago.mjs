#!/usr/bin/env node
// PaperFate · Scimago Journal Rank (SJR) collector
//
// Scimago publishes per-year journal rankings as a downloadable CSV at:
//   https://www.scimagojr.com/journalrank.php?out=xls&year={YYYY}
// (Despite "xls" in the URL, the response is CSV with ';' separator.)
//
// We download one CSV per year so PaperFate can track venue metrics
// over time — quartile shifts, SJR drift, etc.
//
// Captures per (journal × year):
//   - SJR, SJR Best Quartile, H index, Total Docs, Total Citations
//   - Country, Publisher, Categories
//   - ISSN (join key for OpenAlex Sources)
//
// Usage:
//   node scripts/collect-scimago.mjs                # default years 2015..lastYear
//   node scripts/collect-scimago.mjs 2018 2024      # custom range
//
// MANUAL FALLBACK (Scimago aggressively blocks automated downloads):
//   1. Open https://www.scimagojr.com/journalrank.php?year=YYYY in a browser
//   2. Click "Download data" (☁ icon) → saves as scimagojr_2024.csv (or similar)
//   3. Move/rename to: $DATA_ROOT/scimago/scimago-YYYY.csv
//   4. Run this script — it parses any existing CSV in that folder and writes
//      the JSONL companion files. Network download is skipped if CSV exists.

import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const OUT_DIR = join(DATA_ROOT, 'scimago')

const args = process.argv.slice(2).map(Number).filter(Number.isFinite)
const thisYear = new Date().getFullYear()
const [fromYear, toYear] = args.length === 2 ? args : [2015, thisYear]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function downloadYear(year) {
  const url = `https://www.scimagojr.com/journalrank.php?out=xls&year=${year}`
  const res = await fetch(url, {
    headers: {
      // Scimago blocks non-browser UAs. Mimic a modern browser.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept': 'text/csv,application/vnd.ms-excel,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `https://www.scimagojr.com/journalrank.php?year=${year}`,
    },
  })
  if (!res.ok) {
    if (res.status === 404) return { ok: false, reason: 'not yet published' }
    if (res.status === 403) return { ok: false, reason: 'HTTP 403 (Scimago is blocking automated requests — try downloading manually from scimagojr.com)' }
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  if (!text || text.length < 1000) return { ok: false, reason: `payload too small (${text.length} bytes)` }
  return { ok: true, csv: text }
}

// Scimago CSV header (representative, may shift slightly across years):
//   Rank;Sourceid;Title;Type;Issn;SJR;SJR Best Quartile;H index;Total Docs. (2023);
//   Total Docs. (3years);Total Refs.;Total Cites (3years);Citable Docs. (3years);
//   Cites / Doc. (2years);Ref. / Doc.;Female;Overton;SDG;Country;Region;
//   Publisher;Coverage;Categories;Areas
function parseCsv(csv) {
  const lines = csv.replace(/\r/g, '').split('\n').filter(Boolean)
  if (lines.length < 2) return []
  const header = lines[0].split(';').map(s => s.trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(';')
    if (cells.length < 5) continue
    const obj = {}
    for (let j = 0; j < header.length; j++) obj[header[j]] = (cells[j] || '').trim()
    rows.push(obj)
  }
  return rows
}

function normalize(row, year) {
  const issnStr = row['Issn'] || ''
  const issnList = issnStr.match(/\d{4}[\s-]?\d{3}[\dxX]/g) || []
  const issns = issnList.map(s => s.replace(/[\s-]/g, '').toUpperCase()).map(s => s.length === 8 ? `${s.slice(0,4)}-${s.slice(4)}` : s)
  return {
    year,
    scimago_id:        row['Sourceid'] || null,
    title:             row['Title'] || null,
    type:              row['Type'] || null,
    issns,
    sjr:               toNum(row['SJR']),
    sjr_quartile:      row['SJR Best Quartile'] || null,
    h_index:           toInt(row['H index']),
    total_docs_year:   toInt(row[`Total Docs. (${year})`]),
    total_docs_3y:     toInt(row['Total Docs. (3years)']),
    total_refs:        toInt(row['Total Refs.']),
    total_cites_3y:    toInt(row['Total Cites (3years)']),
    citable_docs_3y:   toInt(row['Citable Docs. (3years)']),
    cites_per_doc_2y:  toNum(row['Cites / Doc. (2years)']),
    refs_per_doc:      toNum(row['Ref. / Doc.']),
    country:           row['Country'] || null,
    region:            row['Region'] || null,
    publisher:         row['Publisher'] || null,
    coverage:          row['Coverage'] || null,
    categories:        row['Categories'] || null,
    areas:             row['Areas'] || null,
  }
}

function toNum(s) {
  if (s == null || s === '') return null
  const n = Number(String(s).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
function toInt(s) {
  const n = toNum(s)
  return n == null ? null : Math.round(n)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log(`PaperFate · Scimago collector`)
  console.log(`Years: ${fromYear}..${toYear}`)
  console.log(`Output: ${OUT_DIR}\n`)

  for (let y = fromYear; y <= toYear; y++) {
    const csvPath  = join(OUT_DIR, `scimago-${y}.csv`)
    const jsonPath = join(OUT_DIR, `scimago-${y}.jsonl`)
    if (existsSync(jsonPath) && statSync(jsonPath).size > 1000) {
      console.log(`  ${y}: jsonl already present (${jsonPath})`)
      continue
    }
    // Prefer a manually-downloaded CSV if present
    if (existsSync(csvPath) && statSync(csvPath).size > 1000) {
      const csv = readFileSync(csvPath, 'utf-8')
      const rows = parseCsv(csv).map(r => normalize(r, y))
      writeFileSync(jsonPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
      console.log(`  ${y}: parsed local CSV → ${rows.length} journals  (${(statSync(jsonPath).size / 1024).toFixed(1)} KB)`)
      continue
    }
    try {
      const { ok, csv, reason } = await downloadYear(y)
      if (!ok) { console.log(`  ${y}: skipped — ${reason}`); continue }
      writeFileSync(csvPath, csv)
      const rows = parseCsv(csv).map(r => normalize(r, y))
      writeFileSync(jsonPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
      console.log(`  ${y}: ${rows.length} journals  (${(statSync(jsonPath).size / 1024).toFixed(1)} KB)`)
      await sleep(2000)
    } catch (e) {
      console.error(`  ${y}: ERROR ${e.message}`)
    }
  }
  console.log(`\nDone. (If automated download was blocked, see header comment for the manual-drop workaround.)`)
}

main().catch(err => { console.error(err); process.exit(1) })
