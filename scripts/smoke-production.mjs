#!/usr/bin/env node
// PaperFate · production smoke
//
// Hits paperfate.com /api/similar and /api/forecast with a known sample and
// verifies the response shape + a few numeric sanity bounds. Exits non-zero
// on any failure so it can be wired into a post-deploy gate (or simply run
// after `git push`).
//
// Usage:
//   node scripts/smoke-production.mjs               # uses paperfate.com
//   PAPERFATE_BASE=http://localhost:3000 node ...   # local Vercel dev

const BASE = process.env.PAPERFATE_BASE || 'https://paperfate.com'
const SAMPLE = {
  title: 'Empagliflozin, Cardiovascular Outcomes, and Mortality in Type 2 Diabetes',
  abstract:
    'The effects of empagliflozin, an inhibitor of sodium-glucose cotransporter 2, in addition to standard care, ' +
    'on cardiovascular morbidity and mortality in patients with type 2 diabetes at high cardiovascular risk are not known. ' +
    'We randomly assigned 7020 patients to receive 10 mg or 25 mg of empagliflozin or placebo once daily. ' +
    'The primary composite outcome was death from cardiovascular causes, nonfatal myocardial infarction, or nonfatal stroke. ' +
    'The key secondary composite outcome was the primary outcome plus hospitalization for unstable angina.',
}

const checks = []
function pass(name, detail) { checks.push({ name, ok: true, detail }) }
function fail(name, detail) { checks.push({ name, ok: false, detail }) }

async function postJson(path, body) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
  })
  const ms = Date.now() - t0
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, ms, json, text }
}

async function getJson(path) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, { redirect: 'follow' })
  const ms = Date.now() - t0
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, ms, json, text }
}

async function probeSimilar() {
  const r = await postJson('/api/similar', { title: SAMPLE.title, abstract: SAMPLE.abstract })
  if (r.status !== 200) return fail('similar.status', `HTTP ${r.status}`)
  pass('similar.status', `${r.status} in ${r.ms}ms`)
  const list = r.json?.similars
  if (!Array.isArray(list)) return fail('similar.shape', 'similars not array')
  if (list.length < 1) return fail('similar.nonempty', `length=${list.length}`)
  pass('similar.nonempty', `${list.length} results`)
  const hasJif = list.some(s => Number.isFinite(s.if))
  if (!hasJif) fail('similar.has_jif', 'no IF values resolved')
  else pass('similar.has_jif', `min IF ${Math.min(...list.filter(s => Number.isFinite(s.if)).map(s => s.if))}`)
}

async function probeForecast() {
  const r = await postJson('/api/forecast', { title: SAMPLE.title, abstract: SAMPLE.abstract, mode: 'Q100' })
  if (r.status !== 200) return fail('forecast.status', `HTTP ${r.status}: ${r.text.slice(0, 200)}`)
  pass('forecast.status', `${r.status} in ${r.ms}ms`)
  const jif = r.json?.predictions?.jcr_jif
  if (!jif || !Number.isFinite(jif.point)) return fail('forecast.jcr_jif', 'missing predictions.jcr_jif.point')
  if (jif.point < 0.1 || jif.point > 300) return fail('forecast.jif_bounds', `point=${jif.point}`)
  pass('forecast.jif', `point ${jif.point.toFixed(2)} (CI ${jif.ci_low?.toFixed?.(2)}–${jif.ci_high?.toFixed?.(2)})`)

  const j = r.json?.journey || []
  if (j.length < 3) fail('forecast.journey_count', `length=${j.length}`)
  else pass('forecast.journey', `${j.length} steps`)
  const hasCostValue = j.some(s => Number.isFinite(s.switchCostValue))
  if (!hasCostValue) fail('forecast.switch_cost_value', 'no switchCostValue (real-cost matrix may not be live)')
  else pass('forecast.switch_cost', 'switchCostValue present')

  const sug = r.json?.counterfactual_suggestions
  if (!Array.isArray(sug)) fail('forecast.suggestions_shape', 'counterfactual_suggestions not array')
  else pass('forecast.suggestions', `${sug.length} suggestions`)
}

async function probeJournalsSearch() {
  const r = await getJson('/api/journals-search?q=lancet&limit=3')
  if (r.status !== 200) return fail('journals.status', `HTTP ${r.status}`)
  pass('journals.status', `${r.status} in ${r.ms}ms`)
  const arr = r.json?.results
  if (!Array.isArray(arr) || arr.length < 1) return fail('journals.results', `length=${arr?.length}`)
  if (!arr[0].name?.toLowerCase().includes('lancet')) return fail('journals.relevance', `top=${arr[0].name}`)
  pass('journals.results', `top: ${arr[0].name} (IF ${arr[0].jif})`)
}

async function probeJournalInfo() {
  const r = await getJson('/api/journal-info?issn=0028-4793')
  if (r.status !== 200) return fail('journal_info.status', `HTTP ${r.status}`)
  const j = r.json?.journal
  if (!j) return fail('journal_info.shape', 'no journal key')
  if (!j.name?.toLowerCase().includes('new england')) return fail('journal_info.match', `name=${j.name}`)
  if (!Number.isFinite(+j.jif)) return fail('journal_info.jif', `jif=${j.jif}`)
  pass('journal_info.match', `${j.name} (IF ${j.jif}, ${j.tier})`)
}

async function probeReferences() {
  const r = await postJson('/api/references', { dois: ['10.1056/NEJMoa1504720', '10.1016/S0140-6736(18)32590-X', '10.1001/jama.2020.6019'] })
  if (r.status !== 200) return fail('references.status', `HTTP ${r.status}: ${r.text.slice(0, 200)}`)
  pass('references.status', `${r.status} in ${r.ms}ms`)
  const s = r.json
  if (!s || typeof s.n_resolved !== 'number') return fail('references.shape', 'missing n_resolved')
  if (s.n_resolved < 1) return fail('references.resolved', `${s.n_resolved}/${s.n_input} resolved`)
  pass('references.resolved', `${s.n_resolved}/${s.n_input} resolved, median IF ${s.median_jif}`)
}

await probeSimilar()
await probeForecast()
await probeJournalsSearch()
await probeJournalInfo()
await probeReferences()

const passed = checks.filter(c => c.ok).length
const failed = checks.filter(c => !c.ok).length
const tag = failed === 0 ? 'PASS' : 'FAIL'
console.log(`\n[${tag}] ${BASE}  —  ${passed} pass / ${failed} fail`)
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
process.exit(failed === 0 ? 0 : 1)
