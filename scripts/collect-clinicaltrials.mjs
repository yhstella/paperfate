#!/usr/bin/env node
// PaperFate · ClinicalTrials.gov collector
//
// Two paths to NCT IDs:
//   1) Records in data/pubmed/*.jsonl with `databankIds` (new parser format)
//   2) Regex scan of title+abstract text for "NCT\d{8}" pattern (old + new)
// Both unioned, deduped, then fetched from ClinicalTrials.gov v2 API.
//
// Captures per study:
//   - NCT ID, study type, phase, enrollment, primary completion date
//   - intervention type/names, conditions, sponsor (class)
//   - primary outcome measures, secondary outcomes
//   - results posted flag
//   - registration → completion → publication lag (computed offline later)
//
// API: https://clinicaltrials.gov/api/v2/studies/{NCT}?format=json
// Free, no key. ~50 req/min recommended.

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'pubmed')
const OUT_DIR = join(DATA_ROOT, 'clinicaltrials')

const REQ_PER_SEC = 5
const PARALLEL = 3
const API_BASE = 'https://clinicaltrials.gov/api/v2/studies/'
const NCT_RE = /\bNCT\d{8}\b/g

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class Limiter {
  constructor(perSec) { this.gap = 1000 / perSec; this.last = 0 }
  async take() {
    const now = Date.now()
    const wait = Math.max(0, this.last + this.gap - now)
    if (wait) await sleep(wait)
    this.last = Date.now()
  }
}

async function fetchStudy(nct, limiter, attempts = 3) {
  await limiter.take()
  const url = `${API_BASE}${nct}?format=json`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'paperfate/0.3 (mailto:beta@paperfate.com)' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) return { _missing: true }
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return await res.json()
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      const wait = 1500 * Math.pow(2, i)
      await sleep(wait)
    }
  }
  throw lastErr
}

function compact(j) {
  if (!j || j._missing) return null
  const ps = j.protocolSection || {}
  const id = ps.identificationModule || {}
  const status = ps.statusModule || {}
  const design = ps.designModule || {}
  const interventions = (ps.armsInterventionsModule?.interventions || []).slice(0, 6).map(i => ({
    type: i.type, name: i.name,
  }))
  const conditions = ps.conditionsModule?.conditions || []
  const sponsor = ps.sponsorCollaboratorsModule?.leadSponsor || {}
  const primary = (ps.outcomesModule?.primaryOutcomes || []).slice(0, 5).map(o => ({
    measure: o.measure, timeFrame: o.timeFrame,
  }))
  const secondary = (ps.outcomesModule?.secondaryOutcomes || []).slice(0, 5).map(o => ({
    measure: o.measure,
  }))
  return {
    nct_id: id.nctId,
    brief_title: id.briefTitle,
    study_type: design.studyType,                  // INTERVENTIONAL, OBSERVATIONAL, etc.
    phases: design.phases,                         // ['PHASE3', ...]
    enrollment: design.enrollmentInfo?.count,
    enrollment_type: design.enrollmentInfo?.type,  // ACTUAL, ESTIMATED
    allocation: design.designInfo?.allocation,     // RANDOMIZED
    intervention_model: design.designInfo?.interventionModel,
    masking: design.designInfo?.maskingInfo?.masking,
    overall_status: status.overallStatus,          // COMPLETED, RECRUITING, ...
    start_date: status.startDateStruct?.date,
    primary_completion_date: status.primaryCompletionDateStruct?.date,
    completion_date: status.completionDateStruct?.date,
    last_update_post_date: status.lastUpdatePostDateStruct?.date,
    has_results: !!j.hasResults,
    sponsor_name: sponsor.name,
    sponsor_class: sponsor.class,                  // INDUSTRY, NIH, OTHER_GOV, ACADEMIC, etc.
    conditions,
    interventions,
    primary_outcomes: primary,
    secondary_outcomes: secondary,
  }
}

function* extractNctIds() {
  if (!existsSync(IN_DIR)) return
  const files = readdirSync(IN_DIR).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
  const seen = new Set()
  for (const f of files) {
    const fpath = join(IN_DIR, f)
    if (statSync(fpath).size === 0) continue
    const lines = readFileSync(fpath, 'utf-8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        // Path 1: databankIds (new parser format)
        if (Array.isArray(r.databankIds)) {
          for (const d of r.databankIds) {
            if (d?.id && /^NCT\d{8}$/.test(d.id) && !seen.has(d.id)) {
              seen.add(d.id); yield d.id
            }
          }
        }
        // Path 2: regex on title+abstract
        const text = `${r.title || ''} ${r.abstract || ''}`
        const matches = text.match(NCT_RE) || []
        for (const m of matches) {
          if (!seen.has(m)) { seen.add(m); yield m }
        }
      } catch {}
    }
  }
}

function loadAlreadyFetched(file) {
  const done = new Set()
  if (!existsSync(file)) return done
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line); if (r.nct_id) done.add(r.nct_id) } catch {}
  }
  return done
}

async function worker(queue, limiter, outPath, counters) {
  while (queue.length) {
    const nct = queue.shift()
    if (!nct) break
    try {
      const j = await fetchStudy(nct, limiter)
      const c = compact(j)
      if (c) {
        appendFileSync(outPath, JSON.stringify(c) + '\n')
        counters.ok++
      } else counters.miss++
    } catch {
      counters.fail++
    }
    counters.done++
    if (counters.done % 100 === 0) {
      const rate = (counters.done / ((Date.now() - counters.t0) / 1000)).toFixed(1)
      console.log(`  ${counters.done}/${counters.total}  ok=${counters.ok} miss=${counters.miss} fail=${counters.fail}  ${rate}/s`)
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)
  const already = loadAlreadyFetched(outPath)

  console.log(`PaperFate · ClinicalTrials.gov collector`)
  console.log(`Input dir: ${IN_DIR}`)
  console.log(`Output: ${outPath}`)

  console.log(`\nScanning NCT IDs from PubMed JSONLs …`)
  const all = [...extractNctIds()]
  const queue = all.filter(n => !already.has(n))
  console.log(`  unique NCTs: ${all.length}, already fetched: ${already.size}, queued: ${queue.length}\n`)
  if (queue.length === 0) { console.log('nothing to do'); return }

  const limiter = new Limiter(REQ_PER_SEC)
  const counters = { done: 0, ok: 0, miss: 0, fail: 0, total: queue.length, t0: Date.now() }
  const workers = Array.from({ length: PARALLEL }, () => worker(queue, limiter, outPath, counters))
  await Promise.all(workers)

  console.log(`\n✓ Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`  ok=${counters.ok}  miss=${counters.miss}  fail=${counters.fail}`)
  console.log(`  output: ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch(e => { console.error(e); process.exit(1) })
