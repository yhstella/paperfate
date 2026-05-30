#!/usr/bin/env node
// PaperFate · run-fixture-smoke
//
// Drives tests/fixtures/manuscripts.json against /api/forecast (default) or
// /api/abstract-quality (with --use-abstract-quality) and prints a per-fixture
// row plus a final summary. Designed to be safe to point at production:
//   - sequential by default (no concurrent bursts against rate-limited APIs)
//   - mode=Q100 by default to keep latency bounded
//   - exits 0 unless --strict is given AND at least one fixture is out of
//     its expected_jif_range
//
// Usage:
//   node scripts/run-fixture-smoke.mjs
//   node scripts/run-fixture-smoke.mjs --use-abstract-quality
//   node scripts/run-fixture-smoke.mjs --strict
//   PAPERFATE_BASE=http://localhost:3000 node scripts/run-fixture-smoke.mjs
//   PAPERFATE_INTERNAL_TOKEN=xxx node scripts/run-fixture-smoke.mjs
//
// Env:
//   PAPERFATE_BASE              base URL (default https://paperfate.com)
//   PAPERFATE_INTERNAL_TOKEN    sent as x-paperfate-internal to bypass rate limit
//   FIXTURE_MODE                Q100|Q500|auto (default Q100; ignored for --use-abstract-quality)
//   FIXTURE_REQUEST_TIMEOUT_MS  per-request timeout (default 120000)
//   FIXTURE_DELAY_MS            sleep between requests (default 250)
//
// Flags:
//   --use-abstract-quality      hit /api/abstract-quality instead of /api/forecast
//   --strict                    exit 1 if any fixture is out of its expected_jif_range
//   --json                      print the raw per-fixture results as a final JSON blob

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'manuscripts.json')

const BASE = (process.env.PAPERFATE_BASE || 'https://paperfate.com').replace(/\/+$/, '')
const MODE = process.env.FIXTURE_MODE || 'Q100'
const REQUEST_TIMEOUT_MS = Number(process.env.FIXTURE_REQUEST_TIMEOUT_MS) || 120000
const DELAY_MS = Number(process.env.FIXTURE_DELAY_MS) || 250

const argv = process.argv.slice(2)
const USE_AQ = argv.includes('--use-abstract-quality')
const STRICT = argv.includes('--strict')
const PRINT_JSON = argv.includes('--json')

const ENDPOINT = USE_AQ ? '/api/abstract-quality' : '/api/forecast'

// ── tier → JIF bands used to evaluate tier_match ──────────────────────────
// These are wide on purpose; expected_jif_range in the fixture is the
// authoritative narrow band, while this maps a numeric prediction back to a
// coarse tier label so we can report tier_match independent of the band.
const TIER_BANDS = [
  { tier: 'top',      min: 40, max: Infinity },
  { tier: 'high',     min: 15, max: 40 },
  { tier: 'mid',      min: 3,  max: 15 },
  { tier: 'low',      min: 0,  max: 3 },
]

function tierFromJif(jif) {
  if (!Number.isFinite(jif)) return null
  for (const b of TIER_BANDS) {
    if (jif >= b.min && jif < b.max) return b.tier
  }
  return null
}

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return Number(n).toFixed(digits)
}

function fmtRange(range) {
  if (!Array.isArray(range) || range.length !== 2) return '—'
  return `${fmtNum(range[0], 1)}–${fmtNum(range[1], 1)}`
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function postJson(path, body) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  const headers = { 'Content-Type': 'application/json' }
  if (process.env.PAPERFATE_INTERNAL_TOKEN) {
    headers['x-paperfate-internal'] = process.env.PAPERFATE_INTERNAL_TOKEN
  }
  const t0 = Date.now()
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctl.signal,
    })
    const ms = Date.now() - t0
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, ms, json, text }
  } catch (e) {
    const ms = Date.now() - t0
    return { status: 0, ms, json: null, text: '', error: String(e?.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

function pickPredictedJif(payload) {
  if (!payload || typeof payload !== 'object') return null
  // forecast.js shape: predictions.jcr_jif.point
  const p = payload?.predictions?.jcr_jif?.point
  if (Number.isFinite(p)) return p
  // legacy / alt: predictions.jif.point
  const p2 = payload?.predictions?.jif?.point
  if (Number.isFinite(p2)) return p2
  // abstract-quality has no JIF — fall back to overall_score (0–100) mapped to null
  return null
}

function pickExtractorUsed(payload) {
  if (!payload || typeof payload !== 'object') return null
  return payload.extractor_used || payload?.pipeline?.extractor_used || null
}

function pickItemsScored(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (Number.isFinite(payload.items_scored)) return payload.items_scored
  if (Number.isFinite(payload?.pipeline?.items_scored)) return payload.pipeline.items_scored
  return null
}

function inRange(value, range) {
  if (!Number.isFinite(value)) return false
  if (!Array.isArray(range) || range.length !== 2) return false
  const [lo, hi] = range
  return value >= lo && value <= hi
}

function rangeMidpoint(range) {
  if (!Array.isArray(range) || range.length !== 2) return null
  const [lo, hi] = range
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  return (lo + hi) / 2
}

function buildRequestBody(fx) {
  if (USE_AQ) {
    return { title: fx.title, abstract: fx.abstract }
  }
  return { title: fx.title, abstract: fx.abstract, mode: MODE }
}

async function loadFixtures() {
  const raw = await readFile(FIXTURE_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`fixtures must be a JSON array, got ${typeof parsed}`)
  }
  return parsed
}

function summarize(rows) {
  const n = rows.length
  const finished = rows.filter(r => r.status === 200)
  const inRangeCount = rows.filter(r => r.in_expected_range === true).length
  const tierMatchCount = rows.filter(r => r.tier_match === true).length
  const residuals = []
  for (const r of rows) {
    const mid = rangeMidpoint(r.expected_jif_range)
    if (Number.isFinite(r.predicted_jif) && Number.isFinite(mid)) {
      residuals.push(r.predicted_jif - mid)
    }
  }
  const meanResidual = residuals.length
    ? residuals.reduce((a, b) => a + b, 0) / residuals.length
    : null
  const meanAbsResidual = residuals.length
    ? residuals.reduce((a, b) => a + Math.abs(b), 0) / residuals.length
    : null
  return {
    total: n,
    succeeded: finished.length,
    in_range: inRangeCount,
    tier_match: tierMatchCount,
    mean_residual: meanResidual,
    mean_abs_residual: meanAbsResidual,
  }
}

async function main() {
  const fixtures = await loadFixtures()

  console.log(`[fixture-smoke] base=${BASE} endpoint=${ENDPOINT} mode=${USE_AQ ? 'abstract-quality' : MODE} fixtures=${fixtures.length}`)
  console.log('')
  const header = ['id', 'tier', 'pred_jif', 'expected', 'in_range', 'tier_match', 'extractor', 'items', 'ms']
  console.log(header.join('\t'))

  const rows = []
  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i]
    const body = buildRequestBody(fx)
    const r = await postJson(ENDPOINT, body)
    const predicted_jif = pickPredictedJif(r.json)
    const extractor_used = pickExtractorUsed(r.json)
    const items_scored = pickItemsScored(r.json)
    const predicted_tier = tierFromJif(predicted_jif)
    const tier_match = predicted_tier && fx.tier
      ? predicted_tier === fx.tier
      : null
    const in_expected_range = USE_AQ
      ? null // abstract-quality has no JIF; report null rather than false
      : inRange(predicted_jif, fx.expected_jif_range)

    const row = {
      id: fx.id,
      label: fx.label,
      tier: fx.tier,
      expected_jif_range: fx.expected_jif_range,
      status: r.status,
      ms: r.ms,
      predicted_jif,
      predicted_tier,
      extractor_used,
      items_scored,
      tier_match,
      in_expected_range,
      ...(r.error && { error: r.error }),
      ...(r.status >= 400 && { error_body: r.json?.error || r.text?.slice(0, 200) }),
    }
    rows.push(row)
    console.log([
      fx.id,
      fx.tier,
      fmtNum(predicted_jif, 2),
      fmtRange(fx.expected_jif_range),
      String(in_expected_range),
      String(tier_match),
      extractor_used || '—',
      items_scored ?? '—',
      r.ms,
    ].join('\t'))

    if (i < fixtures.length - 1 && DELAY_MS > 0) {
      await sleep(DELAY_MS)
    }
  }

  const summary = summarize(rows)
  console.log('')
  console.log('[summary]')
  console.log(`  total:            ${summary.total}`)
  console.log(`  succeeded:        ${summary.succeeded}`)
  console.log(`  in_range:         ${summary.in_range}/${summary.total}`)
  console.log(`  tier_match:       ${summary.tier_match}/${summary.total}`)
  console.log(`  mean_residual:    ${fmtNum(summary.mean_residual, 3)}`)
  console.log(`  mean_abs_resid:   ${fmtNum(summary.mean_abs_residual, 3)}`)

  if (PRINT_JSON) {
    console.log('')
    console.log(JSON.stringify({ summary, rows }, null, 2))
  }

  // Exit semantics:
  //   default: always 0 (smoke is informational)
  //   --strict + /api/forecast: exit 1 if any fixture is out of expected range OR failed
  //   --strict + --use-abstract-quality: exit 1 only on transport/HTTP failures
  if (STRICT) {
    const failures = rows.filter(r => {
      if (r.status !== 200) return true
      if (USE_AQ) return false
      return r.in_expected_range !== true
    })
    if (failures.length > 0) {
      console.error(`[fixture-smoke] STRICT: ${failures.length} fixture(s) failed.`)
      process.exit(1)
    }
  }
  process.exit(0)
}

main().catch(e => {
  console.error('[fixture-smoke] fatal:', e?.stack || e)
  process.exit(2)
})
