#!/usr/bin/env node
// PaperFate · OpenAlex enrichment
// Reads DOIs from $DATA_ROOT/pubmed/*.jsonl, fetches OpenAlex /works metadata,
// streams JSONL to $DATA_ROOT/openalex/<batch>-<YYYY-MM-DD>.jsonl.
//
// Usage:
//   node scripts/collect-openalex.mjs                # all PubMed JSONL files
//   node scripts/collect-openalex.mjs cardiology_hf  # one PubMed seed
//   OPENALEX_EMAIL=you@x.com node scripts/...        # polite-pool, 10 req/s
//
// API: https://api.openalex.org/works/doi:{doi}
// Polite pool: append ?mailto={email} → up to 10 req/sec, 100K req/day

import { readFileSync, readdirSync, mkdirSync, createWriteStream, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'pubmed')
const OUT_DIR = join(DATA_ROOT, 'openalex')

const EMAIL = process.env.OPENALEX_EMAIL || process.env.NCBI_EMAIL || 'beta@paperfate.com'
const REQ_PER_SEC = 9       // stay safely under the 10/s polite-pool cap
const BATCH_PARALLEL = 4    // how many fetches in flight simultaneously
const API_BASE = 'https://api.openalex.org/works/doi:'

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
  const url = `${API_BASE}${encodeURIComponent(doi)}?mailto=${encodeURIComponent(EMAIL)}`
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

function compact(work) {
  if (!work || work._missing) return null
  const concepts = (work.concepts || []).slice(0, 8).map(c => ({
    id: c.id, name: c.display_name, level: c.level, score: c.score,
  }))
  const venue = work.primary_location?.source || work.host_venue || {}
  const oa = work.open_access || {}
  return {
    openalex_id: work.id,
    doi: work.doi,
    title: work.title,
    publication_year: work.publication_year,
    publication_date: work.publication_date,
    type: work.type,
    cited_by_count: work.cited_by_count,
    fwci: work.fwci ?? work.normalized_percentile?.value ?? null,
    counts_by_year: work.counts_by_year || [],
    referenced_works_count: work.referenced_works_count ?? null,
    related_works_count: (work.related_works || []).length || null,
    concepts,
    primary_topic: work.primary_topic ? {
      id: work.primary_topic.id,
      name: work.primary_topic.display_name,
      domain: work.primary_topic.domain?.display_name,
      field: work.primary_topic.field?.display_name,
      subfield: work.primary_topic.subfield?.display_name,
      score: work.primary_topic.score,
    } : null,
    venue: {
      id: venue.id,
      name: venue.display_name,
      issn_l: venue.issn_l,
      type: venue.type,
      host_organization: venue.host_organization_name,
    },
    open_access: {
      is_oa: !!oa.is_oa,
      status: oa.oa_status,
      oa_url: oa.oa_url,
    },
    authorships: (work.authorships || []).slice(0, 8).map(a => ({
      author_id: a.author?.id,
      author: a.author?.display_name,
      orcid: a.author?.orcid,
      first_inst_id: a.institutions?.[0]?.id,
      first_inst: a.institutions?.[0]?.display_name,
      first_country: a.institutions?.[0]?.country_code,
      is_corresponding: a.is_corresponding,
    })),
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
      yield { seed, doi: String(rec.doi).toLowerCase(), pmid: rec.pmid, title: rec.title }
    }
  }
}

async function loadAlreadyFetched(outFile) {
  // Glob ALL historical JSONL files in OUT_DIR (not just today's) — papers
  // grew across days and we don't want to re-fetch what's already in any
  // previous run's output.
  const done = new Set()
  const files = readdirSync(OUT_DIR).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
  for (const fname of files) {
    const fpath = join(OUT_DIR, fname)
    const { createReadStream } = await import('node:fs')
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: createReadStream(fpath, { encoding: 'utf8' }), crlfDelay: Infinity })
    let n = 0
    for await (const line of rl) {
      if (!line) continue
      // Quick DOI extract without full JSON parse (faster on huge files)
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

  // Build dedup'd queue of DOIs (across all PubMed JSONL files)
  const queue = []
  const seenDoi = new Set(already)
  for (const item of iterPubMedDois(filter)) {
    if (seenDoi.has(item.doi)) continue
    seenDoi.add(item.doi)
    queue.push(item)
  }

  console.log(`PaperFate · OpenAlex collector`)
  console.log(`Email (polite pool): ${EMAIL}`)
  console.log(`Input dir:           ${IN_DIR}`)
  console.log(`Output:              ${outPath}`)
  console.log(`Total DOIs to fetch: ${queue.length}  (already fetched: ${already.size})`)
  if (queue.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const limiter = new Limiter(REQ_PER_SEC)
  let done = 0, ok = 0, miss = 0, fail = 0
  const startedAt = Date.now()

  // Simple worker pool
  let cursor = 0
  const workers = Array.from({ length: BATCH_PARALLEL }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= queue.length) return
      const { doi, seed, pmid } = queue[idx]
      try {
        const work = await fetchWork(doi, limiter)
        const compactRec = compact(work)
        if (compactRec) {
          appendFileSync(outPath, JSON.stringify({ source_seed: seed, source_pmid: pmid, ...compactRec }) + '\n')
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
  const size = statSync(outPath).size
  console.log(`\n✓ Done in ${mins} min`)
  console.log(`  ok=${ok}   missing=${miss}   failed=${fail}`)
  console.log(`  output: ${outPath} (${(size / 1024 / 1024).toFixed(2)} MB)`)
}

main().catch(err => { console.error(err); process.exit(1) })
