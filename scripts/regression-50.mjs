#!/usr/bin/env node
// PaperFate · tier-stratified regression-50
//
// Samples 50 papers stratified by real journal IF from the newest EPMC
// fulltext JSONL shard at E:/paperfate/data/europepmc-fulltext/, POSTs each
// to /api/forecast (mode=Q100, abstract-only), and aggregates per-tier
// q_score_mean, predicted JIF, MAE against real_jcr_jif, and Δ_q_mean
// (top minus mid).
//
// This is the Codex v0.5 verification gate (acceptance: tier-match-rate ≥ 50%,
// top-tier MAE < 30). The script MEASURES the gate — it does not change it.
//
// Tiers (by real_jcr_jif):
//   top  : >= 30        sample 10
//   high : 10 - 30      sample 10
//   mid  : 3 - 10       sample 15
//   low  : < 3          sample 15
//
// Usage:
//   node scripts/regression-50.mjs
//   node scripts/regression-50.mjs --date 2026-05-30
//   node scripts/regression-50.mjs --base-url http://localhost:3000
//   node scripts/regression-50.mjs --shard <path>       # override shard auto-pick
//   node scripts/regression-50.mjs --seed 1234          # reproducible sample
//
// Output:
//   E:/paperfate/data/_regression50_<date>.jsonl
//   One header line {kind:'meta',...}, then one line per paper
//   {kind:'paper',...}, then one footer line {kind:'summary',...}.

import { existsSync, readFileSync, statSync, createReadStream, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    date: '2026-05-30',
    baseUrl: 'https://paperfate.com',
    shard: null,
    seed: 42,
    shardDir: 'E:/paperfate/data/europepmc-fulltext',
    dbPath: 'E:/paperfate/data/paperfate.db',
    outDir: 'E:/paperfate/data',
    concurrency: 2,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const eat = () => argv[++i]
    if (a === '--date') { out.date = eat(); continue }
    if (a.startsWith('--date=')) { out.date = a.slice('--date='.length); continue }
    if (a === '--base-url') { out.baseUrl = eat(); continue }
    if (a.startsWith('--base-url=')) { out.baseUrl = a.slice('--base-url='.length); continue }
    if (a === '--shard') { out.shard = eat(); continue }
    if (a.startsWith('--shard=')) { out.shard = a.slice('--shard='.length); continue }
    if (a === '--seed') { out.seed = +eat(); continue }
    if (a === '--shard-dir') { out.shardDir = eat(); continue }
    if (a === '--db') { out.dbPath = eat(); continue }
    if (a === '--out-dir') { out.outDir = eat(); continue }
    if (a === '--concurrency') { out.concurrency = Math.max(1, +eat() || 2); continue }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/regression-50.mjs [--date YYYY-MM-DD] [--base-url URL] [--shard PATH] [--seed N]')
      process.exit(0)
    }
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '')
  return out
}

const ARGS = parseArgs(process.argv)

const TIERS = [
  { name: 'top',  min: 30,         max: Infinity, n: 10 },
  { name: 'high', min: 10,         max: 30,       n: 10 },
  { name: 'mid',  min: 3,          max: 10,       n: 15 },
  { name: 'low',  min: -Infinity,  max: 3,        n: 15 },
]

function tierOf(jif) {
  if (!Number.isFinite(jif)) return null
  for (const t of TIERS) if (jif >= t.min && jif < t.max) return t.name
  return null
}

// Mulberry32: cheap deterministic PRNG seeded for reproducible sampling
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(arr, rng) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ─── Shard discovery ────────────────────────────────────────────────────────
async function pickNewestShard(dir) {
  if (!existsSync(dir)) throw new Error(`shard dir not found: ${dir}`)
  const names = (await readdir(dir)).filter(n => n.endsWith('.jsonl'))
  if (!names.length) throw new Error(`no .jsonl in ${dir}`)
  const withStat = names.map(n => {
    const p = join(dir, n)
    return { p, mtime: statSync(p).mtimeMs }
  })
  withStat.sort((a, b) => b.mtime - a.mtime)
  return withStat[0].p
}

// ─── DB lookup for real_jcr_jif by DOI (via papers→journal_year_metrics) ────
function buildJifLookup(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`db not found: ${dbPath}`)
  const db = new Database(dbPath, { readonly: true })
  db.pragma('busy_timeout=60000')

  // Preload all (issn, year) → jcr_jif into a Map for fast lookup,
  // plus a fallback "latest jcr_jif per issn" map for papers whose year
  // is missing or has no metric row.
  const same = new Map()      // `${issn}|${year}` → jcr_jif
  const latest = new Map()    // issn → { year, jcr_jif }
  for (const r of db.prepare(`
    SELECT issn, year, jcr_jif
    FROM journal_year_metrics
    WHERE issn IS NOT NULL AND issn != '' AND year IS NOT NULL AND jcr_jif IS NOT NULL
  `).iterate()) {
    same.set(`${r.issn}|${r.year}`, +r.jcr_jif)
    const prev = latest.get(r.issn)
    if (!prev || r.year > prev.year) latest.set(r.issn, { year: r.year, jcr_jif: +r.jcr_jif })
  }

  // Paper lookup by DOI (case-insensitive)
  const paperStmt = db.prepare(`SELECT doi, issn, year, journal FROM papers WHERE LOWER(doi) = LOWER(?)`)

  function lookup(doi) {
    if (!doi) return null
    const row = paperStmt.get(doi)
    if (!row) return null
    const issn = row.issn
    const year = row.year
    if (!issn) return null
    if (year != null) {
      const k = `${issn}|${year}`
      if (same.has(k)) return { jif: same.get(k), source: 'same_year', issn, year, journal: row.journal }
      // try year-1 (label often only available for previous year)
      const km1 = `${issn}|${year - 1}`
      if (same.has(km1)) return { jif: same.get(km1), source: 'year_minus_1', issn, year, journal: row.journal }
    }
    const lt = latest.get(issn)
    if (lt) return { jif: lt.jcr_jif, source: 'latest_issn', issn, year, journal: row.journal }
    return null
  }

  function close() { db.close() }
  return { lookup, close }
}

// ─── Read JSONL line-by-line and pick stratified sample ─────────────────────
async function loadShardWithJif(shardPath, jifLookup) {
  const rl = createInterface({
    input: createReadStream(shardPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })
  // Bucket records by tier as we stream — cap each bucket to keep memory bounded
  // (e.g. 5000 candidates per tier; far more than 15 we need).
  const CAP = 5000
  const buckets = { top: [], high: [], mid: [], low: [] }
  let totalLines = 0, withDoi = 0, withJif = 0
  for await (const line of rl) {
    if (!line) continue
    totalLines++
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (!rec.doi || !rec.title || !rec.abstract_full) continue
    if (String(rec.abstract_full).length < 250) continue
    withDoi++
    const hit = jifLookup.lookup(rec.doi)
    if (!hit || !Number.isFinite(hit.jif)) continue
    withJif++
    const tier = tierOf(hit.jif)
    if (!tier) continue
    if (buckets[tier].length < CAP) {
      buckets[tier].push({
        doi: rec.doi,
        pmid: rec.pmid || null,
        pmcid: rec.pmcid || null,
        title: rec.title,
        abstract: rec.abstract_full,
        real_jcr_jif: hit.jif,
        real_jif_source: hit.source,
        issn: hit.issn,
        year: hit.year,
        journal: hit.journal,
        tier,
      })
    }
  }
  return { buckets, totalLines, withDoi, withJif }
}

function sampleStratified(buckets, rng) {
  const sample = []
  const counts = {}
  for (const t of TIERS) {
    const pool = buckets[t.name] || []
    const shuf = shuffle(pool, rng)
    const take = shuf.slice(0, t.n)
    counts[t.name] = { available: pool.length, sampled: take.length, target: t.n }
    sample.push(...take)
  }
  return { sample, counts }
}

// ─── Forecast call ──────────────────────────────────────────────────────────
async function callForecast(baseUrl, paper, timeoutMs = 90_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(`${baseUrl}/api/forecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        title: paper.title,
        abstract: paper.abstract,
        mode: 'Q100',
      }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, ms: Date.now() - t0, json, text }
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, json: null, text: '', error: String(e?.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

// Pull q_score_mean (or domain_rollup mean) from a forecast response.
function extractQScoreMean(json) {
  if (!json) return null
  if (Number.isFinite(json.q_score_mean)) return json.q_score_mean
  // Fall back to domain_rollup mean if present (legacy shape parity).
  const rollup = json.domain_rollup
  if (rollup && typeof rollup === 'object') {
    const vals = []
    for (const v of Object.values(rollup)) {
      if (Number.isFinite(v)) vals.push(v)
      else if (v && Number.isFinite(v.score)) vals.push(v.score)
      else if (v && Number.isFinite(v.mean)) vals.push(v.mean)
    }
    if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length
  }
  return null
}

function extractPredictedJif(json) {
  const p = json?.predictions?.jcr_jif?.point
  return Number.isFinite(p) ? p : null
}

// ─── Concurrency helper (small pool) ────────────────────────────────────────
async function runPool(items, n, worker) {
  const queue = items.slice()
  const inflight = []
  const results = new Array(items.length)
  let idx = 0
  async function next() {
    while (queue.length) {
      const myIdx = idx++
      const item = queue.shift()
      results[myIdx] = await worker(item, myIdx)
    }
  }
  for (let i = 0; i < Math.min(n, items.length); i++) inflight.push(next())
  await Promise.all(inflight)
  return results
}

// ─── Aggregation ────────────────────────────────────────────────────────────
function mean(arr) {
  const v = arr.filter(Number.isFinite)
  if (!v.length) return null
  return v.reduce((a, b) => a + b, 0) / v.length
}

function aggregate(perPaper) {
  const byTier = { top: [], high: [], mid: [], low: [] }
  for (const r of perPaper) if (r.tier && byTier[r.tier]) byTier[r.tier].push(r)

  const perTier = {}
  for (const tier of Object.keys(byTier)) {
    const rows = byTier[tier]
    const qs   = rows.map(r => r.q_score_mean)
    const pifs = rows.map(r => r.predicted_jif)
    const reals = rows.map(r => r.real_jcr_jif)
    const aes  = rows.map(r => Number.isFinite(r.predicted_jif) && Number.isFinite(r.real_jcr_jif)
      ? Math.abs(r.predicted_jif - r.real_jcr_jif) : null)
    perTier[tier] = {
      n: rows.length,
      n_with_q: qs.filter(Number.isFinite).length,
      n_with_pred: pifs.filter(Number.isFinite).length,
      q_score_mean:    mean(qs),
      predicted_jif_mean: mean(pifs),
      real_jcr_jif_mean: mean(reals),
      mae_vs_real_jif: mean(aes),
    }
  }
  const dQ = (perTier.top?.q_score_mean != null && perTier.mid?.q_score_mean != null)
    ? (perTier.top.q_score_mean - perTier.mid.q_score_mean)
    : null

  // Tier-match rate: predicted JIF lands in the SAME tier bucket as real JIF.
  let tierMatch = 0, tierComparable = 0
  for (const r of perPaper) {
    if (!Number.isFinite(r.predicted_jif)) continue
    const predTier = tierOf(r.predicted_jif)
    if (!predTier || !r.tier) continue
    tierComparable++
    if (predTier === r.tier) tierMatch++
  }
  return {
    perTier,
    delta_q_top_minus_mid: dQ,
    tier_match_rate: tierComparable ? tierMatch / tierComparable : null,
    tier_match_n: tierMatch,
    tier_comparable_n: tierComparable,
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const date = ARGS.date
  const outPath = join(ARGS.outDir, `_regression50_${date}.jsonl`)
  console.log(`[regression-50] date=${date} base=${ARGS.baseUrl}`)
  console.log(`[regression-50] out=${outPath}`)

  const shardPath = ARGS.shard || await pickNewestShard(ARGS.shardDir)
  console.log(`[regression-50] shard=${basename(shardPath)}`)

  const jifLookup = buildJifLookup(ARGS.dbPath)
  console.log(`[regression-50] streaming + tier-bucketing shard...`)
  const { buckets, totalLines, withDoi, withJif } = await loadShardWithJif(shardPath, jifLookup)
  console.log(`[regression-50] lines=${totalLines.toLocaleString()} with_doi+abstract=${withDoi.toLocaleString()} with_jif=${withJif.toLocaleString()}`)
  for (const t of TIERS) console.log(`  bucket ${t.name.padEnd(4)} (jif ${t.min}..${t.max}): ${buckets[t.name].length.toLocaleString()} candidates, need ${t.n}`)

  const rng = mulberry32(ARGS.seed)
  const { sample, counts } = sampleStratified(buckets, rng)
  console.log(`[regression-50] sampled ${sample.length} / ${TIERS.reduce((a, t) => a + t.n, 0)} papers`)
  for (const tn of Object.keys(counts)) {
    const c = counts[tn]
    if (c.sampled < c.target) console.warn(`  WARN: ${tn} under-sampled: ${c.sampled}/${c.target} (pool=${c.available})`)
  }

  // Forecast each paper with small concurrency.
  console.log(`[regression-50] forecasting (concurrency=${ARGS.concurrency})...`)
  const perPaper = await runPool(sample, ARGS.concurrency, async (paper, i) => {
    const r = await callForecast(ARGS.baseUrl, paper)
    const q_score_mean   = extractQScoreMean(r.json)
    const predicted_jif  = extractPredictedJif(r.json)
    const extractor_used = r.json?.extractor_used || null
    const llm_health     = r.json?.llm_health || null
    const request_id     = r.json?.request_id || null
    const out = {
      kind: 'paper',
      i,
      doi: paper.doi,
      pmid: paper.pmid,
      pmcid: paper.pmcid,
      issn: paper.issn,
      year: paper.year,
      journal: paper.journal,
      tier: paper.tier,
      real_jcr_jif: paper.real_jcr_jif,
      real_jif_source: paper.real_jif_source,
      http_status: r.status,
      forecast_ms: r.ms,
      error: r.error || null,
      q_score_mean,
      predicted_jif,
      extractor_used,
      llm_status: llm_health?.status || null,
      request_id,
    }
    process.stdout.write(`  [${i + 1}/${sample.length}] ${paper.tier} doi=${paper.doi} → http=${r.status} ms=${r.ms} pred_jif=${Number.isFinite(predicted_jif) ? predicted_jif.toFixed(2) : '-'} real=${paper.real_jcr_jif.toFixed(2)}\n`)
    return out
  })

  const summary = aggregate(perPaper)

  // Write JSONL (meta + papers + summary)
  const lines = []
  lines.push(JSON.stringify({
    kind: 'meta',
    date,
    base_url: ARGS.baseUrl,
    shard: shardPath,
    db: ARGS.dbPath,
    seed: ARGS.seed,
    tiers: TIERS.map(t => ({ name: t.name, min: t.min === -Infinity ? null : t.min, max: t.max === Infinity ? null : t.max, n: t.n })),
    sample_counts: counts,
    shard_stats: { total_lines: totalLines, with_doi: withDoi, with_jif: withJif },
    generated_at: new Date().toISOString(),
    gate: {
      tier_match_rate_threshold: 0.5,
      top_tier_mae_threshold: 30,
      note: 'measurement only — script does not change the gate',
    },
  }))
  for (const row of perPaper) lines.push(JSON.stringify(row))
  lines.push(JSON.stringify({ kind: 'summary', ...summary }))
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8')

  // Console summary
  console.log('\n=== Regression-50 Summary ===')
  for (const tn of ['top', 'high', 'mid', 'low']) {
    const t = summary.perTier[tn]
    if (!t) continue
    const fmt = v => v == null ? '-' : v.toFixed(2)
    console.log(`  ${tn.padEnd(4)} n=${String(t.n).padEnd(3)} q_mean=${fmt(t.q_score_mean)}  pred_jif_mean=${fmt(t.predicted_jif_mean)}  real_jif_mean=${fmt(t.real_jcr_jif_mean)}  MAE=${fmt(t.mae_vs_real_jif)}`)
  }
  console.log(`  Δq (top - mid) = ${summary.delta_q_top_minus_mid == null ? '-' : summary.delta_q_top_minus_mid.toFixed(3)}`)
  console.log(`  tier match    = ${summary.tier_comparable_n ? `${summary.tier_match_n}/${summary.tier_comparable_n} (${(100 * summary.tier_match_rate).toFixed(1)}%)` : '-'}`)
  console.log(`  v0.5 gate     = tier match ≥ 50%, top-tier MAE < 30`)
  console.log(`Wrote ${outPath}`)

  jifLookup.close()
}

main().catch(err => {
  console.error('[regression-50] fatal:', err)
  process.exit(1)
})
