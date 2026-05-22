#!/usr/bin/env node
// PaperFate · Unpaywall enrichment
//
// Reads DOIs from $DATA_ROOT/pubmed/*.jsonl (or openalex/*.jsonl), fetches
// /v2/{doi}?email=... from Unpaywall, writes a compact per-DOI record to
// data/unpaywall/all-<date>.jsonl.
//
// Captures (per DOI):
//   - is_oa, oa_status (gold/green/hybrid/bronze/closed)
//   - best_oa_location: url_for_pdf, host_type, license, version
//   - oa_locations[] count
//   - journal_is_oa, journal_is_in_doaj, journal_issn_l
//   - published_date
//   - has_repository_copy
//
// Idempotent — skips DOIs already in output.
//
// Unpaywall is free with email identification. Sustained ~5-10 req/s is fine,
// 100K/day soft limit. Set UNPAYWALL_EMAIL env var (or NCBI_EMAIL fallback).

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'pubmed')
const OUT_DIR = join(DATA_ROOT, 'unpaywall')

const EMAIL = process.env.UNPAYWALL_EMAIL || process.env.NCBI_EMAIL || 'beta@paperfate.com'
const REQ_PER_SEC = 8
const PARALLEL = 6
const API_BASE = 'https://api.unpaywall.org/v2/'

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

async function fetchUnpaywall(doi, limiter, attempts = 3) {
  await limiter.take()
  const url = `${API_BASE}${encodeURIComponent(doi)}?email=${encodeURIComponent(EMAIL)}`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': `paperfate/0.3 (mailto:${EMAIL})` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) return { _missing: true }
      if (res.status === 422) return { _missing: true } // invalid DOI format
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

function compact(u) {
  if (!u || u._missing) return null
  const best = u.best_oa_location || {}
  return {
    doi: u.doi,
    is_oa: !!u.is_oa,
    oa_status: u.oa_status || null,
    journal_is_oa: !!u.journal_is_oa,
    journal_is_in_doaj: !!u.journal_is_in_doaj,
    journal_issn_l: u.journal_issn_l || null,
    journal_name: u.journal_name || null,
    publisher: u.publisher || null,
    published_date: u.published_date || null,
    year: u.year || null,
    genre: u.genre || null,
    best_oa_url_for_pdf: best.url_for_pdf || null,
    best_oa_host_type: best.host_type || null,         // publisher | repository
    best_oa_version: best.version || null,             // publishedVersion | acceptedVersion | submittedVersion
    best_oa_license: best.license || null,
    has_repository_copy: !!u.has_repository_copy,
    oa_locations_count: (u.oa_locations || []).length,
  }
}

function* iterDois() {
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
        const doi = (r.doi || '').toLowerCase().trim()
        if (!doi || !doi.startsWith('10.')) continue
        if (seen.has(doi)) continue
        seen.add(doi)
        yield doi
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
      const m = line.match(/"doi"\s*:\s*"([^"]+)"/)
      if (m) done.add(m[1].toLowerCase())
      n++
    }
    console.log(`  loaded ${fname}: ${n} rows, cumulative ${done.size}`)
  }
  return done
}

async function worker(queue, limiter, outPath, counters) {
  while (queue.length) {
    const doi = queue.shift()
    if (!doi) break
    try {
      const u = await fetchUnpaywall(doi, limiter)
      const c = compact(u)
      if (c) {
        appendFileSync(outPath, JSON.stringify(c) + '\n')
        counters.ok++
      } else counters.miss++
    } catch {
      counters.fail++
    }
    counters.done++
    if (counters.done % 250 === 0) {
      const rate = (counters.done / ((Date.now() - counters.t0) / 1000)).toFixed(1)
      console.log(`  ${counters.done}/${counters.total}  ok=${counters.ok} miss=${counters.miss} fail=${counters.fail}  ${rate}/s`)
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)
  const already = await loadAlreadyFetched(outPath)

  console.log(`PaperFate · Unpaywall collector`)
  console.log(`Email: ${EMAIL}`)
  console.log(`Input dir: ${IN_DIR}`)
  console.log(`Output: ${outPath}`)

  console.log(`\nScanning DOIs from PubMed JSONLs …`)
  const allDois = [...iterDois()]
  const queue = allDois.filter(d => !already.has(d))
  console.log(`  unique DOIs: ${allDois.length}, already fetched: ${already.size}, queued: ${queue.length}\n`)

  if (queue.length === 0) {
    console.log('nothing to do')
    return
  }

  const limiter = new Limiter(REQ_PER_SEC)
  const counters = { done: 0, ok: 0, miss: 0, fail: 0, total: queue.length, t0: Date.now() }
  const workers = Array.from({ length: PARALLEL }, () => worker(queue, limiter, outPath, counters))
  await Promise.all(workers)

  console.log(`\n✓ Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`  ok=${counters.ok}  miss=${counters.miss}  fail=${counters.fail}`)
  console.log(`  output: ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch(e => { console.error(e); process.exit(1) })
