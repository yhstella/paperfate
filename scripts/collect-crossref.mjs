#!/usr/bin/env node
// PaperFate · Crossref enrichment
// Reads DOIs from $DATA_ROOT/pubmed/*.jsonl, fetches Crossref /works/{doi},
// streams JSONL to $DATA_ROOT/crossref/all-<YYYY-MM-DD>.jsonl.
//
// API:   https://api.crossref.org/works/{doi}
// Polite pool: identify via User-Agent mailto, gets faster lane.
//
// Usage:
//   node scripts/collect-crossref.mjs                # all
//   node scripts/collect-crossref.mjs cardiology_hf  # one seed
//   CROSSREF_EMAIL=you@x.com ...                     # polite pool

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'pubmed')
const OUT_DIR = join(DATA_ROOT, 'crossref')

const EMAIL = process.env.CROSSREF_EMAIL || process.env.OPENALEX_EMAIL || 'beta@paperfate.com'
const REQ_PER_SEC = 25      // polite-pool friendly
const PARALLEL = 8
const API_BASE = 'https://api.crossref.org/works/'

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

async function fetchWork(doi, limiter, attempts = 4) {
  await limiter.take()
  const url = `${API_BASE}${encodeURIComponent(doi)}`
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
      const wait = 1000 * Math.pow(2, i)
      await sleep(wait)
    }
  }
  throw lastErr
}

function flatDate(dateParts) {
  if (!dateParts || !dateParts['date-parts']) return null
  const d = dateParts['date-parts'][0] || []
  if (!d[0]) return null
  return [d[0], d[1] || 1, d[2] || 1].map(n => String(n).padStart(2, '0')).join('-').replace(/^(\d{4})-/, '$1-')
}

function compact(payload) {
  if (!payload || payload._missing) return null
  const w = payload.message
  if (!w) return null
  return {
    doi: (w.DOI || '').toLowerCase(),
    title: Array.isArray(w.title) ? w.title[0] : w.title,
    type: w.type,
    subject: w.subject || [],
    container_title: Array.isArray(w['container-title']) ? w['container-title'][0] : null,
    short_container_title: Array.isArray(w['short-container-title']) ? w['short-container-title'][0] : null,
    issn: w.ISSN || [],
    publisher: w.publisher,
    published_print:  flatDate(w['published-print']),
    published_online: flatDate(w['published-online']),
    issued:           flatDate(w.issued),
    is_referenced_by_count: w['is-referenced-by-count'] ?? null,
    references_count:       w['references-count'] ?? null,
    score: w.score ?? null,
    license: (w.license || []).map(l => ({
      url: l.URL,
      content_version: l['content-version'],
      delay_in_days: l['delay-in-days'],
    })),
    funder: (w.funder || []).map(f => ({
      doi: f.DOI,
      name: f.name,
      awards: f.award || [],
    })),
    abstract: w.abstract || null,            // JATS XML — may include tags
    update_policy: w['update-policy'] || null,
    update_to: w['update-to'] || null,
    relation: w.relation || null,
    fetched_at: new Date().toISOString(),
  }
}

function* iterPubMedDois(filter) {
  const files = readdirSync(IN_DIR).filter(f => f.endsWith('.jsonl'))
  for (const f of files) {
    const seed = f.replace(/-\d{4}-\d{2}-\d{2}\.jsonl$/, '')
    if (filter && filter.length && !filter.includes(seed)) continue
    const lines = readFileSync(join(IN_DIR, f), 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (!rec.doi) continue
      yield { seed, doi: String(rec.doi).toLowerCase(), pmid: rec.pmid }
    }
  }
}

async function loadAlreadyFetched(outFile) {
  const { createReadStream, readdirSync } = await import('node:fs')
  const { createInterface } = await import('node:readline')
  const done = new Set()
  const files = readdirSync(OUT_DIR).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
  for (const fname of files) {
    const rl = createInterface({ input: createReadStream(join(OUT_DIR, fname), { encoding: 'utf8' }), crlfDelay: Infinity })
    let n = 0
    for await (const line of rl) {
      if (!line) continue
      const m = line.match(/"doi"\s*:\s*"([^"]+)"/)
      if (m) done.add(m[1].toLowerCase())
      n++
    }
    console.log(`  loaded ${fname}: ${n} rows, cumulative ${done.size}`)
  }
  return done
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const filter = process.argv.slice(2)
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)
  const already = await loadAlreadyFetched(outPath)

  const queue = []
  const seen = new Set(already)
  for (const item of iterPubMedDois(filter)) {
    if (seen.has(item.doi)) continue
    seen.add(item.doi)
    queue.push(item)
  }

  console.log(`PaperFate · Crossref collector`)
  console.log(`Polite pool: mailto=${EMAIL}`)
  console.log(`Input dir:   ${IN_DIR}`)
  console.log(`Output:      ${outPath}`)
  console.log(`Total DOIs:  ${queue.length}  (already fetched: ${already.size})`)
  if (queue.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const limiter = new Limiter(REQ_PER_SEC)
  let done = 0, ok = 0, miss = 0, fail = 0
  const startedAt = Date.now()
  let cursor = 0

  const workers = Array.from({ length: PARALLEL }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= queue.length) return
      const { doi, seed, pmid } = queue[idx]
      try {
        const payload = await fetchWork(doi, limiter)
        const c = compact(payload)
        if (c) {
          appendFileSync(outPath, JSON.stringify({ source_seed: seed, source_pmid: pmid, ...c }) + '\n')
          ok++
        } else {
          miss++
        }
      } catch (e) {
        fail++
        appendFileSync(outPath + '.errors', JSON.stringify({ doi, seed, pmid, error: e.message }) + '\n')
      }
      done++
      if (done % 50 === 0 || done === queue.length) {
        const rate = (done / ((Date.now() - startedAt) / 1000)).toFixed(1)
        console.log(`  ${done}/${queue.length}  ok=${ok} miss=${miss} fail=${fail}  ${rate}/s`)
      }
    }
  })

  await Promise.all(workers)

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1)
  const size = existsSync(outPath) ? statSync(outPath).size : 0
  console.log(`\n✓ Done in ${mins} min`)
  console.log(`  ok=${ok}   missing=${miss}   failed=${fail}`)
  console.log(`  output: ${outPath} (${(size / 1024 / 1024).toFixed(2)} MB)`)
}

main().catch(err => { console.error(err); process.exit(1) })
