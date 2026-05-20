#!/usr/bin/env node
// PaperFate · Journal Citation Reports (JCR) Impact Factor importer
//
// Reads JIF_YYYY.xlsx files from a source directory and writes one JSONL
// per year to $DATA_ROOT/jcr/jcr-YYYY.jsonl. The JSONL feeds into the
// journal_year_metrics table (jcr_if / jcr_quartile / jcr_category / jci).
//
// USAGE
//   node scripts/import-jcr.mjs                                # auto-discover in JCR_SOURCE_DIR
//   node scripts/import-jcr.mjs /path/to/Custom_JCR.xlsx       # explicit file(s)
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
//   Schema D (JCR direct-export, "<Author>_JCR_JournalResults_*.xlsx"):
//     R0 = metadata line (e.g. "JCR Year: 2024")
//     R1 = headers: Journal name, JCR Abbreviation, Publisher, ISSN, eISSN,
//          Category, Edition, Total Citations, 2024 JIF (year-tagged),
//          JIF Quartile, 2024 JCI, % of Citable OA, JIF Rank, 5 Year JIF,
//          5 Year JIF Quartile, JIF Without Self Cites, Immediacy Index,
//          JCI Rank, JCI Quartile, JCI Percentile, Eigenfactor,
//          Normalized Eigenfactor, Article Influence Score, ...
//     R2+ = data. Year derived from R0 metadata or "<YYYY> JIF" column.

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
      else if (/JCR[_-]?JournalResults.*\.xlsx$/i.test(name)) out.push(full)
    }
  }
  walk(dir)
  return out
}

// Year detection priority:
//  1. "<YYYY> JIF" column header from R1
//  2. "JCR Year: <YYYY>" / "Selected JCR Year: <YYYY>" in R0 metadata
//  3. JIF_YYYY.xlsx style file name
function yearFromHeaders(headers) {
  for (const h of headers) {
    const m = String(h).match(/^\s*(\d{4})\s+JIF\s*$/i)
    if (m) return Number(m[1])
  }
  return null
}
function yearFromMetadataRow(r0) {
  if (!r0) return null
  for (const cell of r0) {
    if (!cell) continue
    const m = String(cell).match(/(?:Selected\s+)?JCR\s+Year[:\s]+(\d{4})/i)
    if (m) return Number(m[1])
  }
  return null
}
function yearFromFilename(p) {
  // Skip the trailing "_MM_YYYY" pattern in download timestamps — that's the
  // download date, NOT the JCR year (which is in the metadata row instead).
  const fname = basename(p)
  // First try strict pattern: JIF_YYYY.xlsx
  const strict = fname.match(/^JIF[_-]?(\d{4})\.xlsx$/i)
  if (strict) return Number(strict[1])
  // Otherwise scan for any 4-digit, but prefer ones not adjacent to MM_
  const allMatches = [...fname.matchAll(/(\d{4})/g)]
  if (allMatches.length === 0) return null
  // Prefer the FIRST year that isn't preceded by "MM_" (download timestamp)
  for (const m of allMatches) {
    const idx = m.index
    const before = fname.slice(Math.max(0, idx - 3), idx)
    if (/^\d{2}_$/.test(before)) continue
    return Number(m[1])
  }
  return Number(allMatches[0][1])
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

// Pull integer from "1/322" string
function rankFromSlashStr(s) {
  if (!s) return { rank: null, total: null }
  const m = String(s).match(/^(\d+)\s*\/\s*(\d+)$/)
  return m ? { rank: Number(m[1]), total: Number(m[2]) } : { rank: null, total: null }
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
  schemaD(row, year) {
    const issn = normIssn(row['ISSN'])
    const eissn = normIssn(row['eISSN'])
    if (!issn && !eissn) return null
    const yearKey = `${year} JIF`
    const jciYearKey = `${year} JCI`
    const jifRank = rankFromSlashStr(row['JIF Rank'])
    return {
      year,
      issn, eissn,
      name: row['Journal name'] || null,
      abbr: row['JCR Abbreviation'] || null,
      jif: toNumOrNull(row[yearKey] ?? row['JIF']),
      jif_5yr: toNumOrNull(row['5 Year JIF']),
      jif_no_self: toNumOrNull(row['JIF Without Self Cites']),
      jci: toNumOrNull(row[jciYearKey] ?? row['JCI']),
      jcr_quartile: row['JIF Quartile'] || null,
      jcr_category: row['Category'] || null,
      jcr_rank: jifRank.rank,
      jcr_total_in_category: jifRank.total,
      publisher: row['Publisher'] || null,
      total_cites: toNumOrNull(row['Total Citations']),
      total_articles: toNumOrNull(row['Articles']),
      citable_items: toNumOrNull(row['Citable Items']),
      // SchemaD richer fields
      eigenfactor: toNumOrNull(row['Eigenfactor']),
      normalized_eigenfactor: toNumOrNull(row['Normalized Eigenfactor']),
      article_influence: toNumOrNull(row['Article Influence Score']),
      immediacy_index: toNumOrNull(row['Immediacy Index']),
      jci_percentile: toNumOrNull(row['JCI Percentile']),
      jif_5yr_quartile: row['5 Year JIF Quartile'] || null,
      edition: row['Edition'] || null,
    }
  },
}

function detectSchema(headers) {
  const set = new Set(headers.map(h => String(h)))
  // SchemaD has a year-tagged "YYYY JIF" column + "5 Year JIF" + "Eigenfactor"
  if ([...set].some(h => /^\d{4}\s+JIF$/.test(h)) && set.has('Eigenfactor')) return 'schemaD'
  if (set.has('Rank') && set.has('JIF Quartile')) return 'schemaB'
  if (set.has('JIF5Years')) return 'schemaA'
  if ([...set].some(h => /^if[_\s]*\d{4}$/i.test(h))) return 'schemaC'
  if (set.has('JIF') && set.has('ISSN')) return 'schemaA'  // best guess
  return null
}

function parseFile(path) {
  const wb = XLSX.readFile(path)
  const allRecords = []
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    // Raw 2-d read; we manually pick which row is headers (banner row support).
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null })
    if (rawRows.length === 0) continue
    // schemaD heuristic: R0 mentions "JCR Year:" → headers live at R1
    const bannerYear = yearFromMetadataRow(rawRows[0])
    const headerRowIdx = bannerYear ? 1 : 0
    const headers = rawRows[headerRowIdx]
    if (!headers || headers.every(c => c == null)) continue
    // Build object rows by hand so the banner row is properly skipped.
    const objRows = []
    for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
      const row = rawRows[i]
      if (!row || row.every(c => c == null)) continue
      const obj = {}
      for (let j = 0; j < headers.length; j++) obj[String(headers[j])] = row[j] ?? null
      objRows.push(obj)
    }
    if (objRows.length === 0) continue
    const detected = detectSchema(headers)
    const year = bannerYear || yearFromHeaders(headers) || yearFromFilename(path)
    if (!year) {
      console.warn(`  ${basename(path)} :: ${sheetName} — cannot detect JCR year`)
      continue
    }
    if (!detected) {
      console.warn(`  ${basename(path)} :: ${sheetName} — unknown schema, headers=${headers.slice(0, 8).join(',')}`)
      continue
    }
    const norm = normalizers[detected]
    let n = 0
    for (const row of objRows) {
      const rec = norm(row, year)
      if (rec) { allRecords.push(rec); n++ }
    }
    console.log(`  ${basename(path)} :: ${sheetName}  schema=${detected}  year=${year}  → ${n} records`)
  }
  return allRecords
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log(`PaperFate · JCR importer`)
  console.log(`Source dir: ${SOURCE_DIR}`)
  console.log(`Output:     ${OUT_DIR}\n`)

  // ALWAYS merge auto-discovered files with explicit CLI paths so a richer
  // direct-export doesn't wipe out the full-JCR snapshot from the same year.
  const discovered = findJifFiles(SOURCE_DIR)
  const cliPaths = process.argv.slice(2).filter(p => p && !p.startsWith('--'))
  const cliValid = cliPaths.filter(p => existsSync(p) && /\.xlsx$/i.test(p))
  const files = Array.from(new Set([...discovered, ...cliValid]))
  if (files.length === 0) {
    console.error(`No JCR xlsx files found.`)
    console.error(`Either pass file paths as args, or place files matching`)
    console.error(`  JIF_YYYY.xlsx  /  *JCR*JournalResults*.xlsx`)
    console.error(`under ${SOURCE_DIR} (override via JCR_SOURCE_DIR env).`)
    process.exit(1)
  }
  console.log(`Importing ${files.length} JCR file(s):`)
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
    // Dedupe within year by primary key (issn || eissn). When two records
    // map to the same key, merge them field-by-field: non-null wins.
    const merged = new Map()
    for (const r of records) {
      const key = r.issn || r.eissn || `${r.name || ''}`.toLowerCase()
      if (!key) continue
      const cur = merged.get(key)
      if (!cur) { merged.set(key, { ...r }); continue }
      for (const [k, v] of Object.entries(r)) {
        if (v == null || v === '') continue
        if (cur[k] == null || cur[k] === '') cur[k] = v
      }
    }
    const finalRecords = [...merged.values()]
    const outPath = join(OUT_DIR, `jcr-${year}.jsonl`)
    const txt = finalRecords.map(r => JSON.stringify(r)).join('\n') + '\n'
    writeFileSync(outPath, txt)
    const withIf = finalRecords.filter(r => r.jif != null).length
    const withQuartile = finalRecords.filter(r => r.jcr_quartile).length
    const withEigenfactor = finalRecords.filter(r => r.eigenfactor != null).length
    console.log(`✓ ${year}: ${finalRecords.length} unique journals (${withIf} JIF · ${withQuartile} quartile · ${withEigenfactor} eigenfactor) → ${outPath}`)
  }
  console.log('\nDone.')
}

main()
