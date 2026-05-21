#!/usr/bin/env node
// Export top journals as static JSON for Vercel function bundling.
// Output: weights/journals-shortlist.json
//
// Selection: top-N by JCR JIF + popular journals + diversity by jcr_category.
// Size target: < 500 KB.

import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_PATH = join(ROOT, 'weights', 'journals-shortlist.json')

const db = new Database(DB_PATH, { readonly: true })

// Query: best (jcr_jif_5yr, jcr_category) per journal — latest year
const rows = db.prepare(`
  WITH latest_jym AS (
    SELECT jym.issn, jym.openalex_id,
      MAX(jym.year) AS year,
      MAX(jym.jcr_jif) AS jcr_jif,
      MAX(jym.jcr_jif_5yr) AS jcr_jif_5yr,
      MAX(jym.jcr_category) AS jcr_category,
      MAX(jym.jcr_quartile) AS jcr_quartile,
      MAX(jym.jcr_publisher) AS jcr_publisher
    FROM journal_year_metrics jym
    WHERE jym.jcr_jif IS NOT NULL OR jym.jcr_jif_5yr IS NOT NULL
    GROUP BY jym.openalex_id
  )
  SELECT
    j.openalex_id, j.issn_l, j.display_name,
    j.host_organization_name AS publisher,
    j.country_code, j.is_oa, j.is_in_doaj, j.apc_usd, j.h_index,
    j.two_yr_mean_citedness AS oa_2yr_proxy,
    j.first_publication_year,
    COALESCE(ljym.jcr_jif, ljym.jcr_jif_5yr) AS jif,
    ljym.jcr_jif_5yr,
    ljym.jcr_category,
    ljym.jcr_quartile,
    ljym.year AS jif_year
  FROM journals j
  LEFT JOIN latest_jym ljym ON ljym.openalex_id = j.openalex_id
  WHERE j.type = 'journal'
    AND (
      ljym.jcr_jif IS NOT NULL
      OR ljym.jcr_jif_5yr IS NOT NULL
      OR j.h_index >= 50
    )
  ORDER BY jif DESC NULLS LAST
`).all()

console.log(`Candidate journals: ${rows.length}`)

// Tier classification by JIF
function tier(jif) {
  if (jif == null) return 'unknown'
  if (jif >= 30) return 'top'
  if (jif >= 10) return 'high'
  if (jif >= 5) return 'upper_mid'
  if (jif >= 3) return 'mid'
  if (jif >= 1.5) return 'lower_mid'
  return 'low'
}

// Normalize category: pick first category if comma-separated, lowercase, alpha-only
function normCategory(s) {
  if (!s) return null
  const first = s.split(/[;,]/)[0].trim().toLowerCase()
  return first || null
}

const journals = rows.map(r => ({
  name: r.display_name,
  issn: r.issn_l,
  oa_id: r.openalex_id?.replace(/^https?:\/\/openalex\.org\//, ''),
  jif: r.jif ? Number(r.jif.toFixed(2)) : null,
  jif_5yr: r.jcr_jif_5yr ? Number(r.jcr_jif_5yr.toFixed(2)) : null,
  tier: tier(r.jif ?? r.jcr_jif_5yr),
  category: normCategory(r.jcr_category),
  quartile: r.jcr_quartile,
  publisher: r.publisher,
  country: r.country_code,
  is_oa: r.is_oa === 1,
  is_in_doaj: r.is_in_doaj === 1,
  apc: r.apc_usd,
  h_index: r.h_index,
}))

// Diversity-aware shortlist:
// 1. Top 200 by JIF
// 2. + top 30 per major category to ensure breadth
// 3. cap at 800 total

const byTier = { top: [], high: [], upper_mid: [], mid: [], lower_mid: [], low: [], unknown: [] }
for (const j of journals) byTier[j.tier].push(j)

// Order tiers by aspirational then realistic
const ordered = [
  ...byTier.top.slice(0, 50),
  ...byTier.high.slice(0, 100),
  ...byTier.upper_mid.slice(0, 150),
  ...byTier.mid.slice(0, 250),
  ...byTier.lower_mid.slice(0, 150),
  ...byTier.low.slice(0, 100),
]

// Dedup by issn
const seen = new Set()
const final = []
for (const j of ordered) {
  const key = j.issn || j.name
  if (seen.has(key)) continue
  seen.add(key)
  final.push(j)
  if (final.length >= 800) break
}

const out = {
  version: '0.1',
  generated_at: new Date().toISOString(),
  n_journals: final.length,
  tier_buckets: {
    top: final.filter(j => j.tier === 'top').length,
    high: final.filter(j => j.tier === 'high').length,
    upper_mid: final.filter(j => j.tier === 'upper_mid').length,
    mid: final.filter(j => j.tier === 'mid').length,
    lower_mid: final.filter(j => j.tier === 'lower_mid').length,
    low: final.filter(j => j.tier === 'low').length,
  },
  notes: {
    selection: 'top-N by JCR JIF + diversity by tier, dedup by ISSN-L',
    use: 'FateCore journey generator picks 5 ordered journals matching predicted JIF',
  },
  journals: final,
}

writeFileSync(OUT_PATH, JSON.stringify(out))
const sizeKB = (JSON.stringify(out).length / 1024).toFixed(1)
console.log(`✓ Wrote ${final.length} journals → ${OUT_PATH} (${sizeKB} KB)`)
console.log('Tier distribution:', out.tier_buckets)
db.close()
