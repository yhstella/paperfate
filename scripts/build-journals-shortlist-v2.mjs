#!/usr/bin/env node
// PaperFate · expand weights/journals-shortlist.json from 800 → 3,000+ journals.
//
// Joins journal_year_metrics (latest non-null jcr_jif per ISSN) to journals
// (display_name, host_organization_name, is_oa, etc.) and bins into tiers.
//
// Output: weights/journals-shortlist-v2.json with the same schema the
// existing loader uses, plus a small bump in tier coverage breadth.

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = process.env.PAPERFATE_DB || join(DATA_ROOT, 'paperfate.db')
const WEIGHTS_DIR = join(ROOT, 'weights')
const OUT_PATH = join(WEIGHTS_DIR, 'journals-shortlist.json')

const TIER_TARGETS = [
  { tier: 'top',       minJif: 30,  cap: 80 },
  { tier: 'high',      minJif: 10,  cap: 300 },
  { tier: 'upper_mid', minJif: 5,   cap: 700 },
  { tier: 'mid',       minJif: 3,   cap: 900 },
  { tier: 'lower_mid', minJif: 1.5, cap: 700 },
  { tier: 'low',       minJif: 0,   cap: 500 },
]

function tierOf(jif) {
  for (const t of TIER_TARGETS) if (jif >= t.minJif) return t.tier
  return 'low'
}

function quartileFrom(raw) {
  if (!raw) return null
  const m = String(raw).match(/q[1-4]/i)
  return m ? m[0].toUpperCase() : null
}

function safeIssn(j) {
  if (j.issn_l) return j.issn_l
  if (j.issn_json) {
    try { const a = JSON.parse(j.issn_json); if (Array.isArray(a) && a[0]) return a[0] } catch {}
  }
  return null
}

function main() {
  if (!existsSync(DB_PATH)) throw new Error(`DB not found: ${DB_PATH}`)
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 60000')
  db.pragma('query_only = ON')

  console.log('Loading latest-year JCR metrics per ISSN ...')
  const metrics = db.prepare(`
    WITH latest AS (
      SELECT issn, MAX(year) AS y FROM journal_year_metrics
      WHERE jcr_jif IS NOT NULL
      GROUP BY issn
    )
    SELECT j.issn, j.year, j.jcr_jif, j.jcr_jif_5yr, j.jci, j.jcr_category, j.jcr_quartile
    FROM journal_year_metrics j
    JOIN latest l ON j.issn = l.issn AND j.year = l.y
  `).all()
  console.log(`  ${metrics.length.toLocaleString()} ISSNs with a JIF`)

  console.log('Loading journals meta ...')
  const journalRows = db.prepare(`
    SELECT openalex_id, issn_l, issn_json, display_name, type, country_code,
           host_organization_name, is_oa, is_in_doaj, apc_usd, h_index
    FROM journals
    WHERE display_name IS NOT NULL
  `).all()
  const journalByIssn = new Map()
  for (const j of journalRows) {
    const issnL = safeIssn(j)
    if (issnL) journalByIssn.set(issnL, j)
    if (j.issn_json) {
      try { for (const i of JSON.parse(j.issn_json) || []) if (i && !journalByIssn.has(i)) journalByIssn.set(i, j) } catch {}
    }
  }
  console.log(`  ${journalByIssn.size.toLocaleString()} ISSN keys in journals lookup`)

  // Merge metrics + journal meta
  const merged = []
  for (const m of metrics) {
    const j = journalByIssn.get(m.issn) || null
    if (!j || !j.display_name) continue
    const jif = Number(m.jcr_jif)
    if (!Number.isFinite(jif)) continue
    merged.push({
      name: j.display_name,
      issn: m.issn,
      oa_id: j.openalex_id ? j.openalex_id.replace(/^https?:\/\/openalex\.org\//, '') : null,
      jif,
      jif_5yr: Number.isFinite(+m.jcr_jif_5yr) ? +m.jcr_jif_5yr : null,
      tier: tierOf(jif),
      category: m.jcr_category ? String(m.jcr_category).toLowerCase() : null,
      quartile: quartileFrom(m.jcr_quartile),
      publisher: j.host_organization_name || null,
      country: j.country_code || null,
      is_oa: !!j.is_oa,
      is_in_doaj: !!j.is_in_doaj,
      apc: j.apc_usd != null ? j.apc_usd : null,
      h_index: j.h_index != null ? j.h_index : null,
    })
  }
  console.log(`  ${merged.length.toLocaleString()} journals after merge`)
  db.close()

  // Tier-balanced selection
  merged.sort((a, b) => b.jif - a.jif)
  const buckets = Object.fromEntries(TIER_TARGETS.map(t => [t.tier, []]))
  for (const j of merged) buckets[j.tier].push(j)

  const picked = []
  const summary = {}
  for (const t of TIER_TARGETS) {
    const slice = buckets[t.tier].slice(0, t.cap)
    picked.push(...slice)
    summary[t.tier] = slice.length
  }

  picked.sort((a, b) => b.jif - a.jif)

  const out = {
    version: '0.2',
    generated_at: new Date().toISOString(),
    n_journals: picked.length,
    tier_buckets: summary,
    notes: {
      selection: 'top-N per tier from latest-year JCR JIF, joined to OpenAlex venue meta',
      use: 'FateCore journey generator + /api/similar JIF lookup + /api/journals-search autocomplete',
    },
    journals: picked,
  }

  if (!existsSync(WEIGHTS_DIR)) mkdirSync(WEIGHTS_DIR, { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))
  const sizeKb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(1)
  console.log(`\n✓ wrote ${OUT_PATH}`)
  console.log(`  journals=${picked.length}  size=${sizeKb} KB`)
  console.log(`  tiers:`)
  for (const t of TIER_TARGETS) console.log(`    ${t.tier.padEnd(10)} ${summary[t.tier]}`)
}

main()
