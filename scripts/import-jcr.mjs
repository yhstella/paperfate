#!/usr/bin/env node
// PaperFate · Journal Citation Reports (JCR) Impact Factor importer
//
// Reads JIF_YYYY.xlsx files from a source directory and writes one JSONL
// per year to $DATA_ROOT/jcr/jcr-YYYY.jsonl. The JSONL feeds into the
// journal_year_metrics table (jcr_if / jcr_quartile / jcr_category / jci).
//
// USAGE
//   node scripts/import-jcr.mjs
//   JCR_SOURCE_DIR=D:/path/to/folder node scripts/import-jcr.mjs
//
// LICENSE NOTE — JCR data is Clarivate-licensed. PaperFate treats it as
// a local-only training/calibration signal: never exposed verbatim via
// the public API; the only thing users see is the model's predicted IF
// (which is a transformative output, not raw JCR). The user is
// responsible for source data compliance with their institutional
// license.
//
// FILE FORMATS RECOGNIZED
//   Schema A (2024-style):
//     Name, Abbr Name, ISSN, EISSN, JIF, JIF5Years, Category
//     Category format: "ONCOLOGY|Q1|1/322"  →  parsed into category/quartile/rank.
//   Schema B (2025-style, full JCR):
//     Rank, Journal Name, Abbreviated Journal, Publisher, JIF, 5-Year JIF,
//     JIF Without Self-Cites, JCI, JIF Quartile, Category, ISSN, eISSN,
//     Total Cites, Total Articles, Citable Items, ...
//   Schema C (2022-style):
//     journal_name, issn, eissn, category, citations, if_2022, jci,
//     percentageOAGold
//     Quartile not directly in own column; extracted from category if formatted.

import XLSX from 'xlsx'
import { mkdirSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const SOURCE_DIR = process.env.JCR_SOURCE_DIR || 'C:/Users/R/Dropbox/Medicine/0.Research'
const OUT_DIR = join(DATA_ROOT, 'jcr')

function findJifFiles(dir) {
  const out = []
  function walk(d) {
    let entries
    try { entries = readdirSync(d) } catch { return }
    for (const name of entries) {
      const full = join(d, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (/^JIF[_-]?(\d{4})\.xlsx$/i.test(name)) out.push(full)
    }
  }
  walk(dir)
  return out
}

function yearFromFilename(p) {
  const m = basename(p).match(/(\d{4})/)
  return m ? Number(m[1]) : null
}

function toNumOrNull(s) {
  if (s == null || s === '' || s === 'N/A') return null
  const n = Number(String(s).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function normIssn(s) {
  if (!s) return null
  const v = String(s).trim().toUpperCase().replace(/[\s]/g, '')
  if (v === 'N/A' || !v) return null
  // Accept "0007-9235" or "00079235"; normalize to dashed form
  const m = v.match(/^(\d{4})-?(\d{3}[\dX])$/)
  if (!m) return v
  return `${m[1]}-${m[2]}`
}

// Parse "ONCOLOGY|Q1|1/322" → {category, quartile, rank}
function parseCategoryToken(s) {
  if (!s) return { category: null, quartile: null, rank: null, total_in_category: null }
  const parts = String(s).split('|').map(x => x.trim())
  const out = { category: parts[0] || null, quartile: null, rank: null, total_in_category: null }
  if (parts[1] && /^Q[1-4]$/i.test(parts[1])) out.quartile = parts[1].toUpperCase()
  if (parts[2]) {
    const m = parts[2].match(/^(\d+)\s*\/\s*(\d+)$/)
    if (m) { out.rank = Number(m[1]); out.total_in_category = Number(m[2]) }
  }
  return out
}

// Each per-row normalizer returns one record (or null if unparseable)
const normalizers = {
  schemaA(row, year) {
    const issn = normIssn(row['ISSN'])
    const eissn = normIssn(row['EISSN'])
    if (!issn && !eissn) return null
    const cat = parseCategoryToken(row['Category'])
    return {
      year,
      issn, eissn,
      name: row['Name'] || null,
      abbr: row['Abbr Name'] || null,
      jif: toNumOrNull(row['JIF']),
      jif_5yr: toNumOrNull(row['JIF5Years']),
      jif_no_self: null,
      jci: null,
      jcr_quartile: cat.quartile,
      jcr_category: cat.category,
      jcr_rank: cat.rank,
      jcr_total_in_category: cat.total_in_category,
      publisher: null,
      total_cites: null,
      total_articles: null,
      citable_items: null,
    }
  },
  schemaB(row, year) {
    const issn = normIssn(row['ISSN'])
    const eissn = normIssn(row['eISSN'])
    if (!issn && !eissn) return null
    const cat = parseCategoryToken(row['Category'])
    return {
      year,
      issn, eissn,
      name: row['Journal Name'] || null,
      abbr: row['Abbreviated Journal'] || null,
      jif: toNumOrNull(row['JIF']),
      jif_5yr: toNumOrNull(row['5-Year JIF']),
      jif_no_self: toNumOrNull(row['JIF Without Self-Cites']),
      jci: toNumOrNull(row['JCI']),
      jcr_quartile: row['JIF Quartile'] || cat.quartile || null,
      jcr_category: cat.category,
      jcr_rank: cat.rank,
      jcr_total_in_category: cat.total_in_category,
      publisher: row['Publisher'] || null,
      total_cites: toNumOrNull(row['Total Cites']),
      total_articles: toNumOrNull(row['Total Articles']),
      citable_items: toNumOrNull(row['Citable Items']),
    }
  },
  schemaC(row, year) {
    const issn = normIssn(row['issn'])
    const eissn = normIssn(row['eissn'])
    if (!issn && !eissn) return null
    const cat = parseCategoryToken(row['category'])
    const ifKey = Object.keys(row).find(k => /^if[_\s]*\d{4}$/i.test(k))
    return {
      year,
      issn, eissn,
      name: row['journal_name'] || null,
      abbr: null,
      jif: toNumOrNull(ifKey ? row[ifKey] : row['JIF']),
      jif_5yr: null,
      jif_no_self: null,
      jci: toNumOrNull(row['jci']),
      jcr_quartile: cat.quartile,
      jcr_category: cat.category,
      jcr_rank: cat.rank,
      jcr_total_in_category: cat.total_in_category,
      publisher: null,
      total_cites: toNumOrNull(row['citations']),
      total_articles: null,
      citable_items: null,
    }
  },
}

function detectSchema(headers) {
  const set = new Set(headers.map(h => String(h)))
  if (set.has('Rank') && set.has('JIF Quartile')) return 'schemaB'
  if (set.has('JIF5Years')) return 'schemaA'
  if ([...set].some(h => /^if[_\s]*\d{4}$/i.test(h))) return 'schemaC'
  if (set.has('JIF') && set.has('ISSN')) return 'schemaA'  // best guess
  return null
}

function parseFile(path) {
  const year = yearFromFilename(path)
  if (!year) throw new Error(`Cannot detect year from filename: ${path}`)
  const wb = XLSX.readFile(path)
  const allRecords = []
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    const objRows = XLSX.utils.sheet_to_json(sheet, { defval: null, blankrows: false })
    if (objRows.length === 0) continue
    const headers = Object.keys(objRows[0])
    const schemaKey = detectSchema(headers)
    if (!schemaKey) {
      console.warn(`  ${path} :: sheet "${sheetName}" — unknown schema, headers=${headers.slice(0, 8).join(',')}`)
      continue
    }
    const norm = normalizers[schemaKey]
    let n = 0
    for (const row of objRows) {
      const rec = norm(row, year)
      if (rec) { allRecords.push(rec); n++ }
    }
    console.log(`  ${basename(path)} :: ${sheetName}  schema=${schemaKey}  → ${n} records`)
  }
  return allRecords
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log(`PaperFate · JCR importer`)
  console.log(`Source dir: ${SOURCE_DIR}`)
  console.log(`Output:     ${OUT_DIR}\n`)

  const files = findJifFiles(SOURCE_DIR)
  if (files.length === 0) {
    console.error(`No JIF_YYYY.xlsx files found under ${SOURCE_DIR}`)
    console.error(`Set JCR_SOURCE_DIR env var to point elsewhere.`)
    process.exit(1)
  }
  console.log(`Found ${files.length} JIF file(s):`)
  for (const f of files) console.log(`  ${f}`)
  console.log('')

  // Group records by year (in case multiple files map to same year)
  const byYear = {}
  for (const f of files) {
    const records = parseFile(f)
    for (const r of records) {
      if (!byYear[r.year]) byYear[r.year] = []
      byYear[r.year].push({ ...r, source_file: basename(f) })
    }
  }

  for (const [year, records] of Object.entries(byYear)) {
    const outPath = join(OUT_DIR, `jcr-${year}.jsonl`)
    const txt = records.map(r => JSON.stringify(r)).join('\n') + '\n'
    writeFileSync(outPath, txt)
    const withIf = records.filter(r => r.jif != null).length
    const withQuartile = records.filter(r => r.jcr_quartile).length
    console.log(`✓ ${year}: ${records.length} records (${withIf} with JIF, ${withQuartile} with quartile) → ${outPath}`)
  }
  console.log('\nDone.')
}

main()
