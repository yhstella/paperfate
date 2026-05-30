#!/usr/bin/env node
/**
 * perf-audit.mjs
 *
 * Lightweight performance check for the PaperFate public API surface — no real
 * browser, no Lighthouse, no Playwright. We just hit every endpoint over HTTP
 * a few times, measure Time-To-First-Byte (TTFB) + total wall time + response
 * body size, take the median across 3 runs, and assert against fixed budgets.
 *
 * Optionally also walks dist/assets/* (if a local build exists) and prints
 * raw + gzip size per chunk for a quick bundle sanity glance. This is *not* a
 * replacement for scripts/check-bundle-budget.mjs — that script enforces
 * per-chunk budgets in CI; this one only reports.
 *
 * Usage:
 *   node scripts/perf-audit.mjs                       # against https://paperfate.com
 *   node scripts/perf-audit.mjs --base-url http://localhost:3000
 *   node scripts/perf-audit.mjs --skip-bundle         # skip dist/assets walk
 *   node scripts/perf-audit.mjs --json                # machine-readable output
 *
 * Env:
 *   BASE_URL — same as --base-url, CLI wins if both set.
 *
 * Budgets (per request, median of 3):
 *   TTFB:    1500 ms for every endpoint
 *   Payload:  256 KB for forecast (heaviest)
 *             64 KB for every other endpoint
 *
 * Exit code:
 *   0 — every endpoint reachable and under budget (bundle is report-only)
 *   1 — any endpoint over budget, unreachable, or returned an unexpected 5xx
 *
 * Why TTFB and not "real" Web Vitals?
 *   The interesting failure mode for our serverless functions is cold-start
 *   latency + upstream API stalls (OpenAlex, NCBI, Gemini). TTFB captures
 *   both. LCP/CLS would require a headless browser which we explicitly want
 *   to avoid for this script (run locally, no chromedriver).
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'

// ───────────────────────── CLI parsing ─────────────────────────
function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const nxt = argv[i + 1]
    if (nxt && !nxt.startsWith('--')) { out[key] = nxt; i++ }
    else out[key] = true
  }
  return out
}
const args = parseArgs(process.argv)

const BASE_URL = (args['base-url'] || process.env.BASE_URL || 'https://paperfate.com')
  .replace(/\/+$/, '')
const SKIP_BUNDLE = Boolean(args['skip-bundle'])
const JSON_OUT = Boolean(args.json)
const REPEAT = 3

const KB = 1024
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DIST_DIR = join(ROOT, 'dist')
const ASSETS_DIR = join(DIST_DIR, 'assets')

// ───────────────────────── Budgets ─────────────────────────
const TTFB_BUDGET_MS = 1500
const PAYLOAD_BUDGET_FORECAST = 256 * KB
const PAYLOAD_BUDGET_DEFAULT = 64 * KB

function payloadBudgetFor(name) {
  return name === 'forecast' ? PAYLOAD_BUDGET_FORECAST : PAYLOAD_BUDGET_DEFAULT
}

// ───────────────────────── Fixture payloads ─────────────────────────
//
// Each endpoint gets the minimum body that exercises the happy path without
// triggering expensive upstream fetches we don't control. Where the route is
// rate-limited (forecast 30/hr, abstract-quality 60/hr per IP) we still send
// real bodies — a single audit run is far below the budget.
const ABSTRACT_FIXTURE = (
  'Background. Non-alcoholic fatty liver disease (NAFLD) is the leading ' +
  'cause of chronic liver disease worldwide. We hypothesised that a ' +
  'thyroid-hormone-receptor-beta agonist would reduce hepatic steatosis ' +
  'in a Mendelian-randomisation framework. Methods. We extracted instruments ' +
  'for THRB expression from GTEx and the eQTLGen consortium, then ran two- ' +
  'sample MR against liver-fat MRI-PDFF outcomes from UK Biobank. ' +
  'Sensitivity analyses included MR-Egger, weighted median, and MR-PRESSO. ' +
  'Results. Genetically predicted higher THRB expression was associated ' +
  'with lower liver fat (beta = -0.18, 95% CI -0.27 to -0.09, p = 4.2e-5). ' +
  'Effects were directionally consistent across all sensitivity estimators. ' +
  'Conclusion. THRB activation is causally linked to reduced hepatic ' +
  'steatosis, supporting ongoing clinical trials of resmetirom.'
)

const ENDPOINTS = [
  {
    name: 'forecast',
    method: 'POST',
    path: '/api/forecast',
    body: {
      title: 'THRB activation and hepatic steatosis: a Mendelian randomisation study',
      abstract: ABSTRACT_FIXTURE,
      article_type: 'research_article',
      mode: 'Q100',
    },
  },
  {
    name: 'similar',
    method: 'POST',
    path: '/api/similar',
    body: {
      title: 'THRB activation and hepatic steatosis',
      abstract: ABSTRACT_FIXTURE,
    },
  },
  {
    name: 'journal-info',
    method: 'GET',
    path: '/api/journal-info?name=Hepatology',
  },
  {
    name: 'journals-search',
    method: 'GET',
    path: '/api/journals-search?q=hepatol&limit=10',
  },
  {
    name: 'references',
    method: 'POST',
    path: '/api/references',
    body: { dois: ['10.1016/j.jhep.2020.03.039'] },
  },
  {
    name: 'author-features',
    method: 'POST',
    path: '/api/author-features',
    body: { authors: ['Rohit Loomba'] },
  },
  {
    name: 'journal-compare',
    method: 'POST',
    path: '/api/journal-compare',
    body: { names: ['Hepatology', 'Journal of Hepatology'] },
  },
  {
    name: 'abstract-quality',
    method: 'POST',
    path: '/api/abstract-quality',
    body: {
      title: 'THRB activation and hepatic steatosis',
      abstract: ABSTRACT_FIXTURE,
      article_type: 'research_article',
    },
  },
  {
    name: 'status',
    method: 'GET',
    path: '/api/status',
  },
  {
    name: 'extras-lookup',
    method: 'POST',
    path: '/api/extras-lookup',
    body: { doi: '10.1016/j.jhep.2020.03.039' },
  },
  {
    name: 'telemetry-beacon',
    method: 'POST',
    path: '/api/telemetry-beacon',
    body: {
      name: 'perf_audit_ping',
      props: { source: 'perf-audit.mjs' },
      ts: Date.now(),
      url: BASE_URL,
      ua_summary: 'node-perf-audit/1.0',
    },
  },
]

// ───────────────────────── HTTP probe ─────────────────────────
async function probe(endpoint) {
  const url = BASE_URL + endpoint.path
  const init = {
    method: endpoint.method,
    headers: { 'accept': 'application/json' },
  }
  if (endpoint.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(endpoint.body)
  }

  const t0 = performance.now()
  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    return {
      ok: false,
      error: err?.code || err?.message || String(err),
      ttfb: null,
      total: null,
      bytes: null,
      status: null,
    }
  }
  const ttfb = performance.now() - t0

  // Drain body to measure total wall time + payload size. We use arrayBuffer
  // so the count is bytes-on-the-wire equivalent, not decoded characters.
  let buf
  try {
    buf = await res.arrayBuffer()
  } catch (err) {
    return {
      ok: false,
      error: 'body_read_failed: ' + (err?.message || String(err)),
      ttfb,
      total: performance.now() - t0,
      bytes: null,
      status: res.status,
    }
  }
  const total = performance.now() - t0

  return {
    ok: res.status < 500, // 4xx counts as reachable (e.g. rate-limit, bad-payload validation)
    status: res.status,
    ttfb,
    total,
    bytes: buf.byteLength,
    error: null,
  }
}

function median(nums) {
  const xs = nums.filter(n => typeof n === 'number' && Number.isFinite(n)).slice().sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid]
}

async function auditEndpoint(ep) {
  const runs = []
  for (let i = 0; i < REPEAT; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await probe(ep)
    runs.push(r)
  }
  const reachableRuns = runs.filter(r => r.ok)
  const medTtfb = median(reachableRuns.map(r => r.ttfb))
  const medTotal = median(reachableRuns.map(r => r.total))
  const medBytes = median(reachableRuns.map(r => r.bytes))
  const lastStatus = runs[runs.length - 1]?.status ?? null
  const firstError = runs.find(r => r.error)?.error ?? null

  const ttfbBudget = TTFB_BUDGET_MS
  const payloadBudget = payloadBudgetFor(ep.name)
  const ttfbOk = medTtfb != null && medTtfb <= ttfbBudget
  const payloadOk = medBytes != null && medBytes <= payloadBudget
  const reachable = reachableRuns.length === runs.length
  const ok = reachable && ttfbOk && payloadOk

  return {
    name: ep.name,
    method: ep.method,
    path: ep.path,
    status: lastStatus,
    reachable,
    runs: runs.map(r => ({ status: r.status, ttfb: r.ttfb, total: r.total, bytes: r.bytes, error: r.error })),
    median_ttfb_ms: medTtfb,
    median_total_ms: medTotal,
    median_bytes: medBytes,
    ttfb_budget_ms: ttfbBudget,
    payload_budget_bytes: payloadBudget,
    ttfb_ok: ttfbOk,
    payload_ok: payloadOk,
    ok,
    error: firstError,
  }
}

// ───────────────────────── Bundle walk ─────────────────────────
function walkBundle() {
  if (!existsSync(ASSETS_DIR)) {
    return { available: false, reason: `dist/assets not found at ${ASSETS_DIR}` }
  }
  const files = readdirSync(ASSETS_DIR)
    .filter(f => /\.(js|css)$/i.test(f))
    .filter(f => !/\.map$/i.test(f))
  const rows = []
  let totalRaw = 0
  let totalGz = 0
  for (const f of files) {
    const full = join(ASSETS_DIR, f)
    const st = statSync(full)
    if (!st.isFile()) continue
    const buf = readFileSync(full)
    const raw = buf.length
    const gz = gzipSync(buf).length
    totalRaw += raw
    totalGz += gz
    rows.push({ file: f, raw, gz })
  }
  rows.sort((a, b) => b.raw - a.raw)
  return { available: true, files: rows, total_raw: totalRaw, total_gz: totalGz }
}

// ───────────────────────── Pretty print ─────────────────────────
function fmtKB(n) { return n == null ? '-' : `${(n / KB).toFixed(1)}KB` }
function fmtMs(n) { return n == null ? '-' : `${n.toFixed(0)}ms` }

function pad(s, w) { return String(s).padEnd(w) }

function renderTable(headers, rows) {
  const widths = headers.map(h => h.length)
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], String(row[i]).length)
    }
  }
  const lines = []
  lines.push(headers.map((h, i) => pad(h, widths[i])).join('  '))
  lines.push(headers.map((_, i) => '-'.repeat(widths[i])).join('  '))
  for (const row of rows) {
    lines.push(row.map((c, i) => pad(c, widths[i])).join('  '))
  }
  return lines.join('\n')
}

function statusLabel(r) {
  if (!r.reachable) return 'UNREACH'
  if (!r.ttfb_ok && !r.payload_ok) return 'OVER(both)'
  if (!r.ttfb_ok) return 'OVER(ttfb)'
  if (!r.payload_ok) return 'OVER(size)'
  return 'OK'
}

// ───────────────────────── Main ─────────────────────────
async function main() {
  if (!JSON_OUT) {
    console.log(`[perf-audit] base_url=${BASE_URL}  repeats=${REPEAT}`)
    console.log('')
  }

  const results = []
  for (const ep of ENDPOINTS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await auditEndpoint(ep)
    results.push(r)
  }

  const bundle = SKIP_BUNDLE ? { available: false, reason: 'skipped' } : walkBundle()

  const anyFailed = results.some(r => !r.ok)
  const exitCode = anyFailed ? 1 : 0

  if (JSON_OUT) {
    const out = {
      base_url: BASE_URL,
      repeats: REPEAT,
      budgets: {
        ttfb_ms: TTFB_BUDGET_MS,
        payload_bytes_forecast: PAYLOAD_BUDGET_FORECAST,
        payload_bytes_default: PAYLOAD_BUDGET_DEFAULT,
      },
      endpoints: results,
      bundle,
      pass: !anyFailed,
    }
    console.log(JSON.stringify(out, null, 2))
    process.exit(exitCode)
  }

  // Endpoint table
  const epHeaders = ['endpoint', 'method', 'status', 'ttfb(med)', 'total(med)', 'bytes(med)', 'budgets', 'result']
  const epRows = results.map(r => [
    r.name,
    r.method,
    r.status ?? '-',
    fmtMs(r.median_ttfb_ms),
    fmtMs(r.median_total_ms),
    fmtKB(r.median_bytes),
    `ttfb<=${TTFB_BUDGET_MS}ms size<=${(r.payload_budget_bytes / KB).toFixed(0)}KB`,
    statusLabel(r),
  ])
  console.log(renderTable(epHeaders, epRows))

  // Per-endpoint diagnostics for failures
  const failed = results.filter(r => !r.ok)
  if (failed.length) {
    console.log('')
    console.log('Failures:')
    for (const r of failed) {
      if (!r.reachable) {
        console.log(`  - ${r.name}: unreachable (${r.error || 'no_response'})`)
      } else if (!r.ttfb_ok && !r.payload_ok) {
        console.log(`  - ${r.name}: ttfb ${fmtMs(r.median_ttfb_ms)} > ${TTFB_BUDGET_MS}ms AND payload ${fmtKB(r.median_bytes)} > ${fmtKB(r.payload_budget_bytes)}`)
      } else if (!r.ttfb_ok) {
        console.log(`  - ${r.name}: ttfb ${fmtMs(r.median_ttfb_ms)} > ${TTFB_BUDGET_MS}ms`)
      } else if (!r.payload_ok) {
        console.log(`  - ${r.name}: payload ${fmtKB(r.median_bytes)} > ${fmtKB(r.payload_budget_bytes)}`)
      }
    }
  }

  // Bundle table
  console.log('')
  if (!bundle.available) {
    console.log(`[bundle] not walked (${bundle.reason})`)
  } else {
    const bHeaders = ['file', 'raw', 'gzip']
    const bRows = bundle.files.map(f => [f.file, fmtKB(f.raw), fmtKB(f.gz)])
    console.log(renderTable(bHeaders, bRows))
    console.log('')
    console.log(`[bundle] total raw=${fmtKB(bundle.total_raw)}  gzip=${fmtKB(bundle.total_gz)}  files=${bundle.files.length}`)
    console.log('[bundle] reported only — see scripts/check-bundle-budget.mjs for enforcement.')
  }

  console.log('')
  if (anyFailed) {
    console.log(`[perf-audit] FAIL — ${failed.length} endpoint(s) over budget or unreachable.`)
  } else {
    console.log('[perf-audit] PASS — all endpoints under TTFB + payload budgets.')
  }
  process.exit(exitCode)
}

main().catch(err => {
  console.error('[perf-audit] fatal:', err?.stack || err)
  process.exit(2)
})
