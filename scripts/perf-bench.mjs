#!/usr/bin/env node
// PaperFate · performance benchmark
//
// Sequentially hits each public API endpoint N times (default 20), capturing
// wall-clock latency per request. The first sample is treated as the
// cold-start measurement and the remaining samples as warm. Reports per
// endpoint cold / median / p95 / max, prints an aligned table sorted by p95
// descending, and enforces per-endpoint p95 budgets.
//
// Usage:
//   node scripts/perf-bench.mjs
//   node scripts/perf-bench.mjs --base-url https://staging.example.com
//   node scripts/perf-bench.mjs --requests 30
//   node scripts/perf-bench.mjs --json
//
// Exit code: 0 if every endpoint is under its p95 budget, 1 otherwise.

const DEFAULT_BASE = 'https://paperfate.com'
const DEFAULT_REQUESTS = 20

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { baseUrl: DEFAULT_BASE, json: false, requests: DEFAULT_REQUESTS }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base-url' && argv[i + 1]) { out.baseUrl = argv[++i]; continue }
    if (a.startsWith('--base-url=')) { out.baseUrl = a.slice('--base-url='.length); continue }
    if (a === '--requests' && argv[i + 1]) { out.requests = Number(argv[++i]); continue }
    if (a.startsWith('--requests=')) { out.requests = Number(a.slice('--requests='.length)); continue }
    if (a === '--json') { out.json = true; continue }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/perf-bench.mjs [--base-url URL] [--requests N] [--json]')
      process.exit(0)
    }
  }
  out.baseUrl = String(out.baseUrl).replace(/\/+$/, '')
  if (!Number.isFinite(out.requests) || out.requests < 2) {
    console.error(`[perf-bench] --requests must be >= 2 (got ${out.requests}); using ${DEFAULT_REQUESTS}`)
    out.requests = DEFAULT_REQUESTS
  }
  return out
}

const ARGS = parseArgs(process.argv)
const BASE = (process.env.BASE_URL || ARGS.baseUrl).replace(/\/+$/, '')
const N = Math.floor(ARGS.requests)

// ─── Sample payloads (mirrors smoke-production-v2.mjs) ──────────────────────
const SAMPLE_TITLE = 'Empagliflozin, Cardiovascular Outcomes, and Mortality in Type 2 Diabetes'
const SAMPLE_ABSTRACT =
  'The effects of empagliflozin, an inhibitor of sodium-glucose cotransporter 2, in addition to standard care, ' +
  'on cardiovascular morbidity and mortality in patients with type 2 diabetes at high cardiovascular risk are not known. ' +
  'We randomly assigned 7020 patients to receive 10 mg or 25 mg of empagliflozin or placebo once daily. ' +
  'The primary composite outcome was death from cardiovascular causes, nonfatal myocardial infarction, or nonfatal stroke. ' +
  'The key secondary composite outcome was the primary outcome plus hospitalization for unstable angina. ' +
  'A total of 2997 patients were assigned to receive empagliflozin (4687) or placebo (2333) and were followed for a median ' +
  'of 3.1 years.'

// ─── Endpoint definitions ───────────────────────────────────────────────────
// budget = p95 budget in ms (per task spec).
const ENDPOINTS = [
  {
    name: 'forecast Q100',
    method: 'POST',
    path: '/api/forecast',
    body: { title: SAMPLE_TITLE, abstract: SAMPLE_ABSTRACT, mode: 'Q100' },
    budget: 8000,
  },
  {
    name: 'abstract-quality',
    method: 'POST',
    path: '/api/abstract-quality',
    body: { title: SAMPLE_TITLE, abstract: SAMPLE_ABSTRACT, article_type: '*' },
    // No explicit budget given in the spec → treat as forecast-class (8000ms).
    budget: 8000,
  },
  {
    name: 'similar',
    method: 'POST',
    path: '/api/similar',
    body: { title: SAMPLE_TITLE, abstract: SAMPLE_ABSTRACT },
    budget: 2000,
  },
  {
    name: 'journal-info',
    method: 'GET',
    path: '/api/journal-info?issn=0028-4793',
    budget: 2000,
  },
  {
    name: 'journals-search',
    method: 'GET',
    path: '/api/journals-search?q=lancet&limit=5',
    budget: 2000,
  },
  {
    name: 'references',
    method: 'POST',
    path: '/api/references',
    body: { dois: ['10.1056/NEJMoa1504720', '10.1056/NEJMoa1611925'] },
    budget: 2000,
  },
  {
    name: 'author-features',
    method: 'POST',
    path: '/api/author-features',
    body: { authors: ['Bernard Zinman', 'David M Charytan'] },
    budget: 2000,
  },
  {
    name: 'journal-compare',
    method: 'POST',
    path: '/api/journal-compare',
    body: { names: ['New England Journal of Medicine', 'The Lancet', 'JAMA'] },
    budget: 2000,
  },
  {
    name: 'status',
    method: 'GET',
    path: '/api/status',
    budget: 500,
  },
  {
    name: 'extras-lookup',
    method: 'POST',
    path: '/api/extras-lookup',
    body: { doi: '10.1056/NEJMoa1504720' },
    budget: 1000,
  },
  {
    name: 'telemetry-beacon',
    method: 'POST',
    path: '/api/telemetry-beacon',
    body: { name: 'perf_bench', props: { from: 'perf-bench' } },
    budget: 500,
  },
]

// ─── HTTP helper ────────────────────────────────────────────────────────────
async function timedRequest(endpoint) {
  const url = `${BASE}${endpoint.path}`
  const init = {
    method: endpoint.method,
    headers: { Accept: 'application/json' },
    redirect: 'follow',
  }
  if (endpoint.body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(endpoint.body)
  }
  const t0 = Date.now()
  let status = 0
  let err = null
  try {
    const res = await fetch(url, init)
    // Drain body so timing covers full response, not just headers.
    await res.arrayBuffer().catch(() => {})
    status = res.status
  } catch (e) {
    err = e
  }
  const ms = Date.now() - t0
  return { ms, status, err }
}

// ─── Stats ──────────────────────────────────────────────────────────────────
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return NaN
  if (sortedAsc.length === 1) return sortedAsc[0]
  // Linear interpolation between closest ranks.
  const rank = (p / 100) * (sortedAsc.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]
  const frac = rank - lo
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac
}

function summarise(samples) {
  const cold = samples[0]
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    cold,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    samples,
  }
}

// ─── Table printing ─────────────────────────────────────────────────────────
function pad(s, w, align = 'left') {
  s = String(s ?? '')
  if (s.length >= w) return s
  const padding = ' '.repeat(w - s.length)
  return align === 'right' ? padding + s : s + padding
}

function fmt(ms) {
  return Number.isFinite(ms) ? Math.round(ms).toString() : '-'
}

function printTable(results) {
  const cols = [
    { k: 'endpoint',     w: 22, align: 'left'  },
    { k: 'cold (ms)',    w: 11, align: 'right' },
    { k: 'median (ms)',  w: 12, align: 'right' },
    { k: 'p95 (ms)',     w: 10, align: 'right' },
    { k: 'max (ms)',     w: 10, align: 'right' },
    { k: 'budget (ms)',  w: 12, align: 'right' },
    { k: 'status',       w: 6,  align: 'left'  },
  ]
  const header = cols.map(c => pad(c.k, c.w, c.align)).join(' | ')
  console.log(header)
  console.log(cols.map(c => '-'.repeat(c.w)).join('-+-'))
  for (const r of results) {
    const status = Number.isFinite(r.p95) && r.p95 <= r.budget ? 'OK' : 'FAIL'
    const line = [
      pad(r.name, cols[0].w, cols[0].align),
      pad(fmt(r.cold),   cols[1].w, cols[1].align),
      pad(fmt(r.median), cols[2].w, cols[2].align),
      pad(fmt(r.p95),    cols[3].w, cols[3].align),
      pad(fmt(r.max),    cols[4].w, cols[4].align),
      pad(r.budget,      cols[5].w, cols[5].align),
      pad(status,        cols[6].w, cols[6].align),
    ].join(' | ')
    console.log(line)
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!ARGS.json) {
    console.log(`[perf-bench] base=${BASE}  requests=${N}  endpoints=${ENDPOINTS.length}`)
  }

  const results = []
  for (const ep of ENDPOINTS) {
    const samples = []
    const errors = []
    const statuses = []
    for (let i = 0; i < N; i++) {
      const { ms, status, err } = await timedRequest(ep)
      samples.push(ms)
      statuses.push(status)
      if (err) errors.push(err.message)
    }
    const stats = summarise(samples)
    results.push({
      name: ep.name,
      method: ep.method,
      path: ep.path,
      budget: ep.budget,
      cold: stats.cold,
      median: stats.median,
      p95: stats.p95,
      max: stats.max,
      samples: stats.samples,
      statuses,
      errors,
    })
    if (!ARGS.json) {
      const warm = samples.slice(1)
      const warmMedian = warm.length ? percentile([...warm].sort((a, b) => a - b), 50) : NaN
      console.log(
        `  ${pad(ep.name, 22)} cold=${fmt(stats.cold)}ms  warm_median=${fmt(warmMedian)}ms  ` +
        `p95=${fmt(stats.p95)}ms  max=${fmt(stats.max)}ms`
      )
    }
  }

  // Sort by p95 descending for the final table.
  const sorted = [...results].sort((a, b) => (b.p95 || 0) - (a.p95 || 0))

  if (ARGS.json) {
    const failed = sorted.filter(r => !(r.p95 <= r.budget)).map(r => r.name)
    const payload = {
      base_url: BASE,
      requests: N,
      generated_at: new Date().toISOString(),
      results: sorted.map(r => ({
        endpoint: r.name,
        method: r.method,
        path: r.path,
        budget_ms: r.budget,
        cold_ms: r.cold,
        median_ms: r.median,
        p95_ms: r.p95,
        max_ms: r.max,
        samples_ms: r.samples,
        statuses: r.statuses,
        errors: r.errors,
        within_budget: r.p95 <= r.budget,
      })),
      failed,
      passed: failed.length === 0,
    }
    console.log(JSON.stringify(payload, null, 2))
    process.exit(failed.length === 0 ? 0 : 1)
  }

  console.log()
  console.log('Results (sorted by p95 desc):')
  printTable(sorted)

  const failed = sorted.filter(r => !(r.p95 <= r.budget))
  console.log()
  if (failed.length === 0) {
    console.log(`All ${sorted.length} endpoints within p95 budget.`)
    process.exit(0)
  } else {
    console.log(`${failed.length}/${sorted.length} endpoint(s) exceeded p95 budget:`)
    for (const r of failed) {
      console.log(`  - ${r.name}: p95=${fmt(r.p95)}ms > budget=${r.budget}ms`)
    }
    process.exit(1)
  }
}

main().catch(err => {
  console.error('[perf-bench] fatal:', err)
  process.exit(1)
})
