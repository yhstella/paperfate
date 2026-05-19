#!/usr/bin/env node
// PaperFate · Semantic Scholar enrichment (batch endpoint)
// Reads DOIs from $DATA_ROOT/pubmed/*.jsonl, fetches S2 paper records in
// batches of up to 500 DOIs each, streams JSONL to
// $DATA_ROOT/semantic-scholar/<batch>-<YYYY-MM-DD>.jsonl.
//
// Why batch: S2 caps single-DOI requests at ~1/s without an API key, but
// the /paper/batch endpoint accepts up to 500 IDs per call. So 45K DOIs
// becomes ~90 batches ≈ 90 seconds at 1/s, instead of 12 hours.
//
// Usage:
//   node scripts/collect-semantic-scholar.mjs               # all
//   node scripts/collect-semantic-scholar.mjs cardiology_hf # one seed
//   S2_API_KEY=... node scripts/...                         # higher rate limit
//
// API: POST https://api.semanticscholar.org/graph/v1/paper/batch
//   body:   { ids: ["DOI:...", "DOI:..."] }
//   query:  ?fields=citationCount,influentialCitationCount,embedding,...

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'pubmed')
const OUT_DIR = join(DATA_ROOT, 'semantic-scholar')

const API_KEY = process.env.S2_API_KEY || ''
const BATCH_URL = 'https://api.semanticscholar.org/graph/v1/paper/batch'
const FIELDS = [
  'externalIds',
  'title',
  'year',
  'venue',
  'publicationVenue',
  'citationCount',
  'influentialCitationCount',
  'referenceCount',
  'fieldsOfStudy',
  's2FieldsOfStudy',
  'tldr',
  'embedding',          // SPECTER2 768-d
  'openAccessPdf',
  'publicationDate',
  'publicationTypes',
].join(',')

const BATCH_SIZE = 500
const REQ_GAP_MS = API_KEY ? 100 : 1100   // 10/s with key, ~1/s without

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function postBatch(ids, attempts = 5) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'paperfate/0.2' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const url = `${BATCH_URL}?fields=${FIELDS}`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60000)
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: ids.map(d => `DOI:${d}`) }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`)
      return await res.json()
    } catch (e) {
      lastErr = e
      const wait = 1500 * Math.pow(2, i)
      await sleep(wait)
    }
  }
  throw lastErr
}

function compact(p, sourceDoi) {
  if (!p) return null
  return {
    s2_id: p.paperId,
    doi: (p.externalIds?.DOI || sourceDoi || '').toLowerCase(),
    pmid: p.externalIds?.PubMed,
    arxiv: p.externalIds?.ArXiv,
    title: p.title,
    year: p.year,
    publication_date: p.publicationDate,
    venue: p.venue || p.publicationVenue?.name,
    publication_venue_id: p.publicationVenue?.id,
    publication_types: p.publicationTypes,
    citation_count: p.citationCount ?? null,
    influential_citation_count: p.influentialCitationCount ?? null,
    reference_count: p.referenceCount ?? null,
    fields_of_study: p.fieldsOfStudy || [],
    s2_fields_of_study: (p.s2FieldsOfStudy || []).map(f => ({ category: f.category, source: f.source })),
    tldr: p.tldr?.text || null,
    embedding: p.embedding ? { model: p.embedding.model, vector: p.embedding.vector } : null,
    open_access_pdf: p.openAccessPdf?.url || null,
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

function loadAlreadyFetched(outFile) {
  if (!existsSync(outFile)) return new Set()
  const text = readFileSync(outFile, 'utf-8')
  const done = new Set()
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line)
      if (r.doi) done.add(String(r.doi).toLowerCase())
    } catch {}
  }
  return done
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const filter = process.argv.slice(2)
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)
  const already = loadAlreadyFetched(outPath)

  // Dedup queue
  const queue = []
  const seen = new Set(already)
  for (const item of iterPubMedDois(filter)) {
    if (seen.has(item.doi)) continue
    seen.add(item.doi)
    queue.push(item)
  }

  console.log(`PaperFate · Semantic Scholar collector`)
  console.log(`API key:    ${API_KEY ? 'yes (10 req/s)' : 'no (~1 req/s) — set S2_API_KEY for faster'}`)
  console.log(`Input dir:  ${IN_DIR}`)
  console.log(`Output:     ${outPath}`)
  console.log(`Batch size: ${BATCH_SIZE}  · already fetched: ${already.size}  · queued: ${queue.length}`)
  console.log(`Estimated:  ~${Math.ceil(queue.length / BATCH_SIZE * (REQ_GAP_MS / 1000) / 60)} minutes`)
  if (queue.length === 0) {
    console.log('Nothing to do.')
    return
  }

  let done = 0, ok = 0, miss = 0, fail = 0
  const startedAt = Date.now()

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE)
    const ids = batch.map(b => b.doi)
    try {
      const results = await postBatch(ids)
      for (let j = 0; j < results.length; j++) {
        const r = results[j]
        const src = batch[j]
        if (r == null) {
          miss++
          continue
        }
        const compactRec = compact(r, src.doi)
        if (compactRec) {
          appendFileSync(outPath, JSON.stringify({ source_seed: src.seed, source_pmid: src.pmid, ...compactRec }) + '\n')
          ok++
        } else {
          miss++
        }
      }
    } catch (e) {
      fail += batch.length
      appendFileSync(outPath + '.errors', JSON.stringify({ batch_start: i, batch_size: batch.length, error: e.message }) + '\n')
    }
    done += batch.length
    const rate = (done / ((Date.now() - startedAt) / 1000)).toFixed(1)
    console.log(`  ${done}/${queue.length}  ok=${ok} miss=${miss} fail=${fail}  ${rate}/s`)
    await sleep(REQ_GAP_MS)
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1)
  const size = existsSync(outPath) ? statSync(outPath).size : 0
  console.log(`\n✓ Done in ${mins} min`)
  console.log(`  ok=${ok}   missing=${miss}   failed=${fail}`)
  console.log(`  output: ${outPath} (${(size / 1024 / 1024).toFixed(2)} MB)`)
}

main().catch(err => { console.error(err); process.exit(1) })
