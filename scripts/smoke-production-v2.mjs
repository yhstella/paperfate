#!/usr/bin/env node
// PaperFate · production smoke v2
//
// Hits the 9 public API endpoints on paperfate.com (or a configurable base URL)
// with realistic payloads, asserts response shape + per-endpoint latency
// budgets, and prints a final table.
//
// Degraded mode (extractor_used='rule_fallback' or llm_health.status='degraded')
// is reported as ⚠ WARN — NOT FAIL — so the harness keeps green when Gemini is
// down but graceful degradation is intact.
//
// Usage:
//   node scripts/smoke-production-v2.mjs
//   node scripts/smoke-production-v2.mjs --base-url https://staging.example.com
//   node scripts/smoke-production-v2.mjs --quick           # skip Q500 (slow)
//   node scripts/smoke-production-v2.mjs --verbose
//
// Exit code: 0 if no FAIL, 1 if any FAIL.

const DEFAULT_BASE = 'https://paperfate.com'

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { baseUrl: DEFAULT_BASE, quick: false, verbose: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base-url' && argv[i + 1]) { out.baseUrl = argv[++i]; continue }
    if (a.startsWith('--base-url=')) { out.baseUrl = a.slice('--base-url='.length); continue }
    if (a === '--quick') { out.quick = true; continue }
    if (a === '--verbose' || a === '-v') { out.verbose = true; continue }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/smoke-production-v2.mjs [--base-url URL] [--quick] [--verbose]')
      process.exit(0)
    }
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '')
  return out
}

const ARGS = parseArgs(process.argv)
const BASE = process.env.BASE_URL || ARGS.baseUrl

// ─── Sample payloads ────────────────────────────────────────────────────────
const SAMPLE_TITLE = 'Empagliflozin, Cardiovascular Outcomes, and Mortality in Type 2 Diabetes'
const SAMPLE_ABSTRACT =
  'The effects of empagliflozin, an inhibitor of sodium-glucose cotransporter 2, in addition to standard care, ' +
  'on cardiovascular morbidity and mortality in patients with type 2 diabetes at high cardiovascular risk are not known. ' +
  'We randomly assigned 7020 patients to receive 10 mg or 25 mg of empagliflozin or placebo once daily. ' +
  'The primary composite outcome was death from cardiovascular causes, nonfatal myocardial infarction, or nonfatal stroke. ' +
  'The key secondary composite outcome was the primary outcome plus hospitalization for unstable angina. ' +
  'A total of 2997 patients were assigned to receive empagliflozin (4687) or placebo (2333) and were followed for a median ' +
  'of 3.1 years. The primary outcome occurred in 490 of 4687 patients (10.5%) in the pooled empagliflozin group and in ' +
  '282 of 2333 patients (12.1%) in the placebo group (hazard ratio in the empagliflozin group, 0.86; 95.02% confidence ' +
  'interval, 0.74 to 0.99; P=0.04 for superiority).'

const SAMPLE_METHODS =
  'We conducted a randomized, double-blind, placebo-controlled trial in 7020 patients with type 2 diabetes and ' +
  'established cardiovascular disease across 590 sites in 42 countries. Patients were randomly assigned in a 1:1:1 ratio ' +
  'to receive 10 mg of empagliflozin, 25 mg of empagliflozin, or placebo once daily in addition to standard care. ' +
  'The primary composite outcome was time to first occurrence of death from cardiovascular causes, nonfatal myocardial ' +
  'infarction (excluding silent myocardial infarction), or nonfatal stroke. Analyses were performed according to the ' +
  'intention-to-treat principle with Cox proportional-hazards models stratified by glycated hemoglobin, body-mass index, ' +
  'estimated glomerular filtration rate, region, and history of cardiovascular events.'

const SAMPLE_RESULTS =
  'A total of 7020 patients underwent randomization. Median follow-up was 3.1 years. The primary outcome occurred in ' +
  '490 of 4687 patients (10.5%) in the pooled empagliflozin group and in 282 of 2333 patients (12.1%) in the placebo ' +
  'group (hazard ratio, 0.86; 95.02% CI, 0.74 to 0.99; P=0.04 for superiority). There were no significant between-group ' +
  'differences in the rates of myocardial infarction or stroke, but in the empagliflozin group there were significantly ' +
  'lower rates of death from cardiovascular causes (3.7% vs 5.9%; 38% relative risk reduction), hospitalization for heart ' +
  'failure (2.7% vs 4.1%; 35% reduction), and death from any cause (5.7% vs 8.3%; 32% reduction).'

const SAMPLE_DISCUSSION =
  'In this trial involving patients with type 2 diabetes at high risk for cardiovascular events, empagliflozin reduced ' +
  'the primary composite cardiovascular outcome and death from any cause when added to standard care. The mechanism ' +
  'underlying the cardiovascular benefit of empagliflozin remains unclear and likely multifactorial, involving ' +
  'hemodynamic, metabolic, and direct cardiac effects. Limitations include the inclusion of only patients with ' +
  'established cardiovascular disease, which limits generalizability to primary-prevention populations.'

const FULL_TEXT = [SAMPLE_METHODS, SAMPLE_RESULTS, SAMPLE_DISCUSSION].join('\n\n')

// ─── HTTP helpers ───────────────────────────────────────────────────────────
async function httpJson(method, path, body) {
  const t0 = Date.now()
  const url = `${BASE}${path}`
  const init = {
    method,
    headers: { 'Accept': 'application/json' },
    redirect: 'follow',
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res, text, json = null, networkError = null
  try {
    res = await fetch(url, init)
    text = await res.text()
    try { json = JSON.parse(text) } catch { /* leave json null */ }
  } catch (e) {
    networkError = e
  }
  const ms = Date.now() - t0
  return {
    status: res?.status ?? 0,
    ms,
    json,
    text: text ?? '',
    networkError,
  }
}

// ─── Probe results table ────────────────────────────────────────────────────
const rows = []  // { endpoint, http, ms, extractor, status, fail_reason }

function record(endpoint, http, ms, extractor, status, fail_reason) {
  rows.push({ endpoint, http, ms, extractor, status, fail_reason })
}

function statusLabel(http, ms, budgetMs, ok, degraded) {
  if (!ok) return 'FAIL'
  if (degraded) return 'WARN'
  if (ms > budgetMs) return 'SLOW'
  return 'OK'
}

// ─── Probes ─────────────────────────────────────────────────────────────────

async function probeForecastQ100() {
  const path = '/api/forecast'
  const budget = 60_000
  const r = await httpJson('POST', path, {
    title: SAMPLE_TITLE,
    abstract: SAMPLE_ABSTRACT,
    mode: 'Q100',
  })
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (!r.json) { ok = false; fail_reason = 'non-json body' }
  else if (!Number.isFinite(r.json?.predictions?.jcr_jif?.point)) { ok = false; fail_reason = 'missing predictions.jcr_jif.point' }
  else if (r.json.server_version !== '0.4.0') { ok = false; fail_reason = `server_version=${r.json.server_version}` }
  else if (!r.json.request_id) { ok = false; fail_reason = 'missing request_id' }

  const extractor = r.json?.extractor_used || '?'
  const degraded = extractor === 'rule_fallback' || r.json?.llm_health?.status === 'degraded'
  const label = statusLabel(r.status, r.ms, budget, ok, degraded)
  record('forecast Q100', r.status, r.ms, extractor, label, fail_reason)
  if (ARGS.verbose) console.error(`[verbose] ${path} Q100 → ${r.status} in ${r.ms}ms, extractor=${extractor}, body[0:200]=${r.text.slice(0, 200)}`)
}

async function probeForecastQ500() {
  const path = '/api/forecast'
  const budget = 200_000
  const r = await httpJson('POST', path, {
    title: SAMPLE_TITLE,
    abstract: SAMPLE_ABSTRACT,
    methods: SAMPLE_METHODS,
    results: SAMPLE_RESULTS,
    discussion: SAMPLE_DISCUSSION,
    full_text: FULL_TEXT,
    mode: 'Q500',
  })
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (!r.json) { ok = false; fail_reason = 'non-json body' }
  else if (!Number.isFinite(r.json?.predictions?.jcr_jif?.point)) { ok = false; fail_reason = 'missing predictions.jcr_jif.point' }
  else if (!r.json.request_id) { ok = false; fail_reason = 'missing request_id' }

  const extractor = r.json?.extractor_used || '?'
  const degraded = extractor === 'rule_fallback' || r.json?.llm_health?.status === 'degraded'
  const label = statusLabel(r.status, r.ms, budget, ok, degraded)
  record('forecast Q500', r.status, r.ms, extractor, label, fail_reason)
  if (ARGS.verbose) console.error(`[verbose] ${path} Q500 → ${r.status} in ${r.ms}ms, extractor=${extractor}`)
}

async function probeSimilar() {
  const path = '/api/similar'
  const budget = 15_000
  const r = await httpJson('POST', path, { title: SAMPLE_TITLE, abstract: SAMPLE_ABSTRACT })
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (!Array.isArray(r.json?.similars)) { ok = false; fail_reason = 'similars not array' }
  else if (r.json.similars.length < 1) { ok = false; fail_reason = 'empty similars' }

  const label = statusLabel(r.status, r.ms, budget, ok, false)
  record('similar', r.status, r.ms, '-', label, fail_reason)
}

async function probeJournalInfo() {
  const path = '/api/journal-info?issn=0028-4793'
  const budget = 15_000
  const r = await httpJson('GET', path)
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (!r.json?.journal?.name) { ok = false; fail_reason = 'missing journal.name' }
  else if (!/new england/i.test(r.json.journal.name)) { ok = false; fail_reason = `unexpected name=${r.json.journal.name}` }
  else if (!Number.isFinite(+r.json.journal.jif)) { ok = false; fail_reason = `bad jif=${r.json.journal.jif}` }

  const label = statusLabel(r.status, r.ms, budget, ok, false)
  record('journal-info', r.status, r.ms, '-', label, fail_reason)
}

async function probeJournalsSearch() {
  const path = '/api/journals-search?q=lancet&limit=5'
  const budget = 15_000
  const r = await httpJson('GET', path)
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (!Array.isArray(r.json?.results)) { ok = false; fail_reason = 'results not array' }
  else if (r.json.results.length < 1) { ok = false; fail_reason = 'no results' }
  else if (!/lancet/i.test(r.json.results[0]?.name || '')) { ok = false; fail_reason = `top not lancet=${r.json.results[0]?.name}` }

  const label = statusLabel(r.status, r.ms, budget, ok, false)
  record('journals-search', r.status, r.ms, '-', label, fail_reason)
}

async function probeReferences() {
  const path = '/api/references'
  const budget = 15_000
  const r = await httpJson('POST', path, {
    dois: ['10.1056/NEJMoa1504720', '10.1056/NEJMoa1611925'],
  })
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (typeof r.json?.n_resolved !== 'number') { ok = false; fail_reason = 'missing n_resolved' }
  else if (r.json.n_resolved < 1) { ok = false; fail_reason = `resolved=${r.json.n_resolved}` }

  const label = statusLabel(r.status, r.ms, budget, ok, false)
  record('references', r.status, r.ms, '-', label, fail_reason)
}

async function probeAuthorFeatures() {
  const path = '/api/author-features'
  const budget = 15_000
  const r = await httpJson('POST', path, {
    authors: ['Bernard Zinman', 'David M Charytan'],
  })
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (!Array.isArray(r.json?.resolved)) { ok = false; fail_reason = 'resolved not array' }
  else if (!('first_author_h_index' in (r.json || {}))) { ok = false; fail_reason = 'missing first_author_h_index' }

  const label = statusLabel(r.status, r.ms, budget, ok, false)
  record('author-features', r.status, r.ms, '-', label, fail_reason)
}

async function probeJournalCompare() {
  const path = '/api/journal-compare'
  const budget = 15_000
  const r = await httpJson('POST', path, {
    names: ['New England Journal of Medicine', 'The Lancet', 'JAMA'],
  })
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (!Array.isArray(r.json?.journals)) { ok = false; fail_reason = 'journals not array' }
  else if (r.json.journals.length < 1) { ok = false; fail_reason = 'no journals resolved' }

  const label = statusLabel(r.status, r.ms, budget, ok, false)
  record('journal-compare', r.status, r.ms, '-', label, fail_reason)
}

async function probeAbstractQuality() {
  const path = '/api/abstract-quality'
  const budget = 60_000
  const r = await httpJson('POST', path, {
    title: SAMPLE_TITLE,
    abstract: SAMPLE_ABSTRACT,
    article_type: '*',
  })
  let ok = true, fail_reason = ''
  if (r.networkError) { ok = false; fail_reason = `network: ${r.networkError.message}` }
  else if (r.status !== 200) { ok = false; fail_reason = `HTTP ${r.status}` }
  else if (!r.json) { ok = false; fail_reason = 'non-json body' }
  else if (!('overall_score' in r.json) && !('domain_rollup' in r.json) && !Array.isArray(r.json?.items)) {
    ok = false; fail_reason = 'missing overall_score/domain_rollup/items'
  } else if (!r.json.request_id) { ok = false; fail_reason = 'missing request_id' }

  // abstract-quality always Q100 — use forecast's degraded heuristic if present
  const extractor = r.json?.extractor_used || '-'
  const degraded = extractor === 'rule_fallback' || r.json?.llm_health?.status === 'degraded'
  const label = statusLabel(r.status, r.ms, budget, ok, degraded)
  record('abstract-quality', r.status, r.ms, extractor, label, fail_reason)
}

// ─── Print final table ──────────────────────────────────────────────────────
function pad(s, w) {
  s = String(s ?? '')
  return s.length >= w ? s : s + ' '.repeat(w - s.length)
}

function printTable() {
  const cols = [
    { k: 'endpoint',  w: 22 },
    { k: 'http',      w: 5 },
    { k: 'ms',        w: 9 },
    { k: 'extractor', w: 16 },
    { k: 'status',    w: 6 },
  ]
  const header = cols.map(c => pad(c.k, c.w)).join(' | ')
  console.log()
  console.log(header)
  console.log(cols.map(c => '-'.repeat(c.w)).join('-+-'))
  for (const row of rows) {
    const ms = Number.isFinite(row.ms) ? `${row.ms}` : '-'
    const line = [
      pad(row.endpoint, cols[0].w),
      pad(row.http, cols[1].w),
      pad(ms, cols[2].w),
      pad(row.extractor, cols[3].w),
      pad(row.status, cols[4].w),
    ].join(' | ')
    console.log(line)
    if (row.fail_reason && row.status === 'FAIL') {
      console.log(`  └─ ${row.fail_reason}`)
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke v2] base=${BASE}  quick=${ARGS.quick}`)

  await probeForecastQ100()
  if (!ARGS.quick) await probeForecastQ500()
  else record('forecast Q500', '-', NaN, '-', 'SKIP', '--quick')
  await probeSimilar()
  await probeJournalInfo()
  await probeJournalsSearch()
  await probeReferences()
  await probeAuthorFeatures()
  await probeJournalCompare()
  await probeAbstractQuality()

  printTable()

  const failed = rows.filter(r => r.status === 'FAIL').length
  const warned = rows.filter(r => r.status === 'WARN').length
  const slow   = rows.filter(r => r.status === 'SLOW').length
  const passed = rows.filter(r => r.status === 'OK').length
  console.log()
  console.log(`Summary: ${passed} OK, ${warned} WARN, ${slow} SLOW, ${failed} FAIL`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[smoke v2] fatal:', err)
  process.exit(1)
})
