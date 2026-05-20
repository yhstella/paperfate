#!/usr/bin/env node
// PaperFate · OpenAlex Sources (venue/journal) collector
//
// Reads unique venue_openalex_id values from $DATA_ROOT/openalex/all-*.jsonl
// (i.e. journals our corpus papers were published in), fetches the full
// /sources/{id} record per venue, and streams JSONL to
// $DATA_ROOT/openalex-sources/sources-<YYYY-MM-DD>.jsonl.
//
// Captures (per venue):
//   - works_count, cited_by_count, h_index, i10_index
//   - summary_stats.2yr_mean_citedness       ← IF proxy (single number)
//   - counts_by_year[]                       ← works+citations PER YEAR
//     (IF-like time series: cited_by_count[Y] / (works[Y-1]+works[Y-2]))
//   - country_code, type, is_oa, host_organization
//   - topics[] (OpenAlex subject classification — for venue scope)
//   - first/last publication year
//   - ISSN-L + ISSNs (join key for Scimago + JCR)
//
// Usage:  node scripts/collect-openalex-sources.mjs

import { readFileSync, readdirSync, mkdirSync, createWriteStream, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'openalex')
const OUT_DIR = join(DATA_ROOT, 'openalex-sources')

const EMAIL = process.env.OPENALEX_EMAIL || process.env.NCBI_EMAIL || 'beta@paperfate.com'
const REQ_PER_SEC = 9
const BATCH_PARALLEL = 4
const API_BASE = 'https://api.openalex.org/sources/'

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
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

async function fetchSource(id, limiter, attempts = 4) {
  await limiter.take()
  const shortId = id.replace(/^https?:\/\/openalex\.org\//, '')
  const url = `${API_BASE}${encodeURIComponent(shortId)}?mailto=${encodeURIComponent(EMAIL)}`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(url, {
        headers: { 'User-Agent': `paperfate/0.2 (mailto:${EMAIL})` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) return { _missing: true }
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return await res.json()
    } catch (e) {
      lastErr = e
      const wait = 800 * Math.pow(2, i)
      await sleep(wait)
    }
  }
  throw lastErr
}

function compact(v) {
  if (!v || v._missing) return null
  const ss = v.summary_stats || {}
  // Approximate yearly IF: citations_in_year_Y / (works_published_in_Y-1 + Y-2)
  // Sort counts_by_year for that
  const byYear = (v.counts_by_year || []).slice().sort((a, b) => a.year - b.year)
  const yearMap = Object.fromEntries(byYear.map(c => [c.year, c]))
  const yearlyIF = []
  for (const c of byYear) {
    const y = c.year
    const wY1 = yearMap[y - 1]?.works_count || 0
    const wY2 = yearMap[y - 2]?.works_count || 0
    const denom = wY1 + wY2
    yearlyIF.push({
      year: y,
      works:    c.works_count,
      cited_by: c.cited_by_count,
      if_proxy: denom > 0 ? +(c.cited_by_count / denom).toFixed(3) : null,
    })
  }
  return {
    openalex_id:           v.id,
    issn_l:                v.issn_l,
    issn:                  v.issn || [],
    display_name:          v.display_name,
    alternate_titles:      v.alternate_titles || [],
    type:                  v.type,
    country_code:          v.country_code,
    host_organization:     v.host_organization,
    host_organization_name:v.host_organization_name,
    homepage_url:          v.homepage_url,
    works_count:           v.works_count,
    cited_by_count:        v.cited_by_count,
    first_publication_year:v.first_publication_year,
    last_publication_year: v.last_publication_year,
    is_oa:                 !!v.is_oa,
    is_in_doaj:            !!v.is_in_doaj,
    is_core:               !!v.is_core,
    apc_usd:               v.apc_usd,
    // Snapshot metrics
    h_index:               ss.h_index ?? null,
    i10_index:             ss.i10_index ?? null,
    two_yr_mean_citedness: ss['2yr_mean_citedness'] ?? null,  // IF proxy
    // Per-year time series
    counts_by_year:        byYear,
    yearly_if_proxy:       yearlyIF,
    // Subject scope
    topics: (v.topics || []).slice(0, 10).map(t => ({
      id: t.id,
      name: t.display_name,
      count: t.count,
      subfield: t.subfield?.display_name,
      field:    t.field?.display_name,
      domain:   t.domain?.display_name,
    })),
    fetched_at: new Date().toISOString(),
  }
}

function* iterVenueIds() {
  if (!existsSync(IN_DIR)) return
  const files = readdirSync(IN_DIR).filter(f => f.endsWith('.jsonl'))
  for (const f of files) {
    const lines = readFileSync(join(IN_DIR, f), 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      const vid = rec.venue?.id
      if (vid) yield vid
    }
  }
}

function loadAlreadyFetched(outFile) {
  if (!existsSync(outFile)) return new Set()
  const text = readFileSync(outFile, 'utf-8')
  const done = new Set()
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line)
      if (r.openalex_id) done.add(r.openalex_id)
    } catch {}
  }
  return done
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `sources-${todayStamp()}.jsonl`)
  const already = loadAlreadyFetched(outPath)

  // Dedup venue IDs across all corpus papers
  const queue = []
  const seen = new Set(already)
  for (const id of iterVenueIds()) {
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(id)
  }

  console.log(`PaperFate · OpenAlex Sources collector`)
  console.log(`Polite pool email: ${EMAIL}`)
  console.log(`Input dir:         ${IN_DIR}`)
  console.log(`Output:            ${outPath}`)
  console.log(`Unique venues:     ${queue.length}  (already fetched: ${already.size})`)
  if (queue.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const limiter = new Limiter(REQ_PER_SEC)
  let done = 0, ok = 0, miss = 0, fail = 0
  const startedAt = Date.now()
  let cursor = 0

  const workers = Array.from({ length: BATCH_PARALLEL }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= queue.length) return
      const vid = queue[idx]
      try {
        const v = await fetchSource(vid, limiter)
        const c = compact(v)
        if (c) {
          appendFileSync(outPath, JSON.stringify(c) + '\n')
          ok++
        } else {
          miss++
        }
      } catch (e) {
        fail++
        appendFileSync(outPath + '.errors', JSON.stringify({ vid, error: e.message }) + '\n')
      }
      done++
      if (done % 25 === 0 || done === queue.length) {
        const rate = (done / ((Date.now() - startedAt) / 1000)).toFixed(1)
        console.log(`  ${done}/${queue.length}  ok=${ok} miss=${miss} fail=${fail}  ${rate}/s`)
      }
    }
  })
  await Promise.all(workers)

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1)
  const size = statSync(outPath).size
  console.log(`\n✓ Done in ${mins} min`)
  console.log(`  ok=${ok}   missing=${miss}   failed=${fail}`)
  console.log(`  output: ${outPath} (${(size / 1024).toFixed(1)} KB)`)
}

main().catch(err => { console.error(err); process.exit(1) })
