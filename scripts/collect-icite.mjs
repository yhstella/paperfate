#!/usr/bin/env node
// PaperFate · NIH iCite enrichment
//
// Fetches per-PMID metrics from NIH iCite API:
//   https://icite.od.nih.gov/api/pubs?pmids=PMID1,PMID2,...
// Returns ≤200 PMIDs per call. No key. Free, public.
//
// Captures (per PMID):
//   - relative_citation_ratio (RCR)         — field-normalized citation impact
//   - citation_count, citations_per_year
//   - field_citation_rate                   — denominator used in RCR
//   - is_research_article, is_clinical
//   - cited_by_clin                         — # of clinical guidelines/papers citing
//   - expected_citations_per_year
//   - apt (Approximate Potential to Translate, 0-1)
//   - x_coord, y_coord                      — Triangle of Biomedicine position
//
// Output: data/icite/all-<date>.jsonl, idempotent.

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'pubmed')
const OUT_DIR = join(DATA_ROOT, 'icite')

const REQ_PER_SEC = 5
const PARALLEL = 3
const BATCH_PMIDS = 200    // iCite hard limit
const API_BASE = 'https://icite.od.nih.gov/api/pubs'

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

async function fetchBatch(pmids, limiter, attempts = 3) {
  await limiter.take()
  const url = `${API_BASE}?pmids=${pmids.join(',')}&format=json`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'paperfate/0.3 (mailto:beta@paperfate.com)' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const j = await res.json()
      return j?.data || []
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      const wait = 1500 * Math.pow(2, i)
      await sleep(wait)
    }
  }
  throw lastErr
}

function compact(r) {
  return {
    pmid: String(r.pmid),
    year: r.year || null,
    rcr: r.relative_citation_ratio ?? null,
    citation_count: r.citation_count ?? null,
    citations_per_year: r.citations_per_year ?? null,
    expected_citations_per_year: r.expected_citations_per_year ?? null,
    field_citation_rate: r.field_citation_rate ?? null,
    is_research_article: !!r.is_research_article,
    is_clinical: !!r.is_clinical,
    cited_by_clin: r.cited_by_clin ?? null,
    apt: r.apt ?? null,
    x_coord: r.x_coord ?? null,
    y_coord: r.y_coord ?? null,
    nih_percentile: r.nih_percentile ?? null,
    journal: r.journal || null,
  }
}

function* iterPmids() {
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
        const pmid = String(r.pmid || '')
        if (!pmid || !/^\d+$/.test(pmid)) continue
        if (seen.has(pmid)) continue
        seen.add(pmid)
        yield pmid
      } catch {}
    }
  }
}

async function loadAlreadyFetched(file) {
  const { createReadStream, readdirSync } = await import('node:fs')
  const { createInterface } = await import('node:readline')
  const done = new Set()
  const files = readdirSync(OUT_DIR).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
  for (const fname of files) {
    const rl = createInterface({ input: createReadStream(join(OUT_DIR, fname), { encoding: 'utf8' }), crlfDelay: Infinity })
    let n = 0
    for await (const line of rl) {
      if (!line.trim()) continue
      const m = line.match(/"pmid"\s*:\s*"?(\d+)"?/)
      if (m) done.add(m[1])
      n++
    }
    console.log(`  loaded ${fname}: ${n} rows, cumulative ${done.size}`)
  }
  return done
}

async function worker(batches, limiter, outPath, counters) {
  while (batches.length) {
    const batch = batches.shift()
    if (!batch) break
    try {
      const records = await fetchBatch(batch, limiter)
      const lines = records.map(r => JSON.stringify(compact(r))).join('\n') + (records.length ? '\n' : '')
      if (lines) appendFileSync(outPath, lines)
      counters.ok += records.length
      counters.miss += (batch.length - records.length)
    } catch {
      counters.fail += batch.length
    }
    counters.done += batch.length
    if (counters.done % 5000 < BATCH_PMIDS) {
      const rate = (counters.done / ((Date.now() - counters.t0) / 1000)).toFixed(1)
      console.log(`  ${counters.done}/${counters.total}  ok=${counters.ok} miss=${counters.miss} fail=${counters.fail}  ${rate}/s`)
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)
  const already = await loadAlreadyFetched(outPath)

  console.log(`PaperFate · NIH iCite collector`)
  console.log(`Input dir: ${IN_DIR}`)
  console.log(`Output: ${outPath}`)

  console.log(`\nScanning PMIDs from PubMed JSONLs …`)
  const all = [...iterPmids()]
  const queue = all.filter(p => !already.has(p))
  console.log(`  unique PMIDs: ${all.length}, already fetched: ${already.size}, queued: ${queue.length}\n`)

  if (queue.length === 0) { console.log('nothing to do'); return }

  // Group into batches of 200
  const batches = []
  for (let i = 0; i < queue.length; i += BATCH_PMIDS) batches.push(queue.slice(i, i + BATCH_PMIDS))
  console.log(`  batches: ${batches.length}\n`)

  const limiter = new Limiter(REQ_PER_SEC)
  const counters = { done: 0, ok: 0, miss: 0, fail: 0, total: queue.length, t0: Date.now() }
  const workers = Array.from({ length: PARALLEL }, () => worker(batches, limiter, outPath, counters))
  await Promise.all(workers)

  console.log(`\n✓ Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`  ok=${counters.ok}  miss=${counters.miss}  fail=${counters.fail}`)
  console.log(`  output: ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch(e => { console.error(e); process.exit(1) })
