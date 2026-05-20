#!/usr/bin/env node
// PaperFate · Calibration model — fill estimated_jif for years without JCR
//
// We have:
//   • jcr_jif for 2022 / 2024 / 2025 (from user's xlsx files), ~4,000 journals
//   • if_proxy_openalex for 2005-2025, ~78,000 (journal × year) rows
//   • jcr_jif_5yr (5-Year JIF, smoother baseline) on some 2024 rows
//
// The OpenAlex proxy = cite[Y] / (works[Y-1] + works[Y-2]). Its scale
// differs from JCR JIF (counted from WoS) — usually proxy is HIGHER for
// old years (broader citation graph + mature citations) and LOWER for
// recent years (citations still accumulating).
//
// Strategy: for each journal with at least one known jcr_jif, pick the
// most recent known year as the "anchor". Compute scale = jif_anchor /
// proxy_anchor. Predict estimated_jif[y] = proxy[y] * scale.
//
// For journals without any jcr_jif, fall back to the global mean scale
// over journals in the same OpenAlex venue type.
//
// Validation: leave-one-year-out — pretend a given (journal, year)'s
// jcr_jif is unknown, predict it from the other years, compare.
//
// Output: writes estimated_jif column on journal_year_metrics, plus
// est_jif_method ("anchor" / "global" / "matched_jcr") and est_jif_conf
// (0..1 self-rated confidence).

import Database from 'better-sqlite3'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = process.env.DATA_ROOT || join(HERE, '..', 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

function median(arr) {
  if (arr.length === 0) return null
  const a = [...arr].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function addColumnIfMissing(db, table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name)
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    console.log(`  + ${table}.${col} ${type}`)
  }
}

function main() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  console.log('PaperFate · JIF calibration')
  console.log('Adding columns:')
  addColumnIfMissing(db, 'journal_year_metrics', 'estimated_jif',     'REAL')
  addColumnIfMissing(db, 'journal_year_metrics', 'est_jif_method',    'TEXT')
  addColumnIfMissing(db, 'journal_year_metrics', 'est_jif_confidence','REAL')

  // STEP 1 — Load (journal, year, proxy, jcr_jif, 5yr) into memory
  console.log('\nLoading journal_year_metrics …')
  const rows = db.prepare(`
    SELECT openalex_id, year, if_proxy_openalex AS proxy, jcr_jif, jcr_jif_5yr
    FROM journal_year_metrics
  `).all()
  console.log(`Loaded ${rows.length} rows`)

  // Group by journal
  const byJ = new Map()
  for (const r of rows) {
    if (!byJ.has(r.openalex_id)) byJ.set(r.openalex_id, [])
    byJ.get(r.openalex_id).push(r)
  }
  console.log(`Distinct journals in metrics: ${byJ.size}`)

  // STEP 2 — Per-journal anchor & scale
  // For each journal, find rows where BOTH proxy and jcr_jif are non-null.
  // anchor = most recent such year. scale = jcr_jif[anchor] / proxy[anchor].
  // If proxy[anchor] is near zero, fall back.
  const scales = new Map()           // openalex_id → {scale, anchorYear}
  let anchored = 0, globalCandidates = 0
  const globalScales = []            // ratios from anchored journals for global mean
  for (const [oa, list] of byJ) {
    const both = list.filter(r => r.proxy != null && r.jcr_jif != null && r.proxy > 0.05)
    if (both.length === 0) {
      globalCandidates++
      continue
    }
    both.sort((a, b) => b.year - a.year)
    const anchor = both[0]
    // If multiple anchor years available, take MEDIAN ratio instead of just-most-recent — more robust
    const ratios = both.map(r => r.jcr_jif / r.proxy)
    const scale = median(ratios)
    scales.set(oa, { scale, anchorYear: anchor.year, n: both.length })
    globalScales.push(scale)
    anchored++
  }
  const globalScale = median(globalScales) || 1.0
  console.log(`Anchored journals: ${anchored} · global fallback candidates: ${globalCandidates}`)
  console.log(`Global median scale (jcr_jif / proxy): ${globalScale.toFixed(3)}`)

  // STEP 3 — Validation: leave-one-year-out on journals with ≥2 known JIF
  console.log('\nValidation (leave-one-year-out on journals with ≥2 known JIF):')
  let validCount = 0, validWithin20 = 0, validWithin40 = 0
  const validErrs = []
  for (const [oa, list] of byJ) {
    const both = list.filter(r => r.proxy != null && r.jcr_jif != null && r.proxy > 0.05)
    if (both.length < 2) continue
    for (let i = 0; i < both.length; i++) {
      const heldOut = both[i]
      const rest = both.filter((_, j) => j !== i)
      const restScale = median(rest.map(r => r.jcr_jif / r.proxy))
      const predicted = heldOut.proxy * restScale
      const absErr = Math.abs(predicted - heldOut.jcr_jif)
      const pctErr = absErr / heldOut.jcr_jif * 100
      validErrs.push(pctErr)
      validCount++
      if (pctErr <= 20) validWithin20++
      if (pctErr <= 40) validWithin40++
    }
  }
  const meanPct = validErrs.length ? validErrs.reduce((s, x) => s + x, 0) / validErrs.length : 0
  console.log(`  Held-out predictions: ${validCount}`)
  console.log(`  Within ±20%: ${validWithin20} (${(100 * validWithin20 / validCount).toFixed(1)}%)`)
  console.log(`  Within ±40%: ${validWithin40} (${(100 * validWithin40 / validCount).toFixed(1)}%)`)
  console.log(`  Mean abs % error: ${meanPct.toFixed(1)}`)

  // STEP 4 — Apply to all rows where proxy exists
  console.log('\nApplying to journal_year_metrics …')
  const upd = db.prepare(`
    UPDATE journal_year_metrics
    SET estimated_jif      = @estimated_jif,
        est_jif_method     = @method,
        est_jif_confidence = @confidence
    WHERE openalex_id = @openalex_id AND year = @year
  `)
  let updated = 0, byMethod = { matched_jcr: 0, anchor: 0, global: 0, none: 0 }
  db.transaction(() => {
    for (const r of rows) {
      if (r.proxy == null || r.proxy <= 0.05) {
        byMethod.none++
        continue
      }
      let method, scale, confidence
      if (r.jcr_jif != null) {
        // Already have real JCR — just echo it, mark as ground truth
        method = 'matched_jcr'
        scale = r.jcr_jif / r.proxy
        confidence = 1.0
      } else if (scales.has(r.openalex_id)) {
        const s = scales.get(r.openalex_id)
        method = 'anchor'
        scale = s.scale
        confidence = 0.6 + Math.min(0.3, s.n * 0.1)
      } else {
        method = 'global'
        scale = globalScale
        confidence = 0.3
      }
      const estimated = r.proxy * scale
      // Cap unrealistic outliers (no journal IF > 600 today)
      const clamped = Math.min(600, Math.max(0.01, estimated))
      upd.run({
        openalex_id:    r.openalex_id,
        year:           r.year,
        estimated_jif:  +clamped.toFixed(3),
        method,
        confidence:     +confidence.toFixed(2),
      })
      updated++
      byMethod[method]++
    }
  })()
  console.log(`  Updated ${updated} rows`)
  console.log(`  By method: matched_jcr=${byMethod.matched_jcr}  anchor=${byMethod.anchor}  global=${byMethod.global}  skipped(no_proxy)=${byMethod.none}`)

  // STEP 5 — Summary stats on the new column
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN estimated_jif IS NOT NULL THEN 1 ELSE 0 END) AS with_est,
      ROUND(AVG(estimated_jif), 2) AS mean_est,
      SUM(CASE WHEN est_jif_method = 'matched_jcr' THEN 1 ELSE 0 END) AS jcr_passthrough,
      SUM(CASE WHEN est_jif_method = 'anchor' THEN 1 ELSE 0 END) AS anchor_based,
      SUM(CASE WHEN est_jif_method = 'global' THEN 1 ELSE 0 END) AS global_fallback
    FROM journal_year_metrics
  `).get()
  console.log('\nFinal estimated_jif coverage:', JSON.stringify(stats, null, 2))

  db.close()
}

main()
