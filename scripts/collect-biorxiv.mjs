#!/usr/bin/env node
// PaperFate · bioRxiv + medRxiv preprint collector
//
// Two-phase:
//   Phase A: bulk download bioRxiv + medRxiv preprint metadata via API
//            (/details/{server}/{interval}/{cursor})
//   Phase B: for each preprint, capture published DOI (if any), and
//            optionally fetch fullTextXML via bioRxiv API
//
// Output: data/biorxiv/preprints-<date>.jsonl
//
// Useful for:
//   - preprint-to-publication gap (days between posting and journal publication)
//   - preprint version count (revisions)
//   - field-frontier coverage (latest unpublished work)
//
// API: https://api.biorxiv.org/details/{server}/{interval}/{cursor}
// Free, no key. ~5 req/sec.

import { mkdirSync, existsSync, statSync, appendFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const OUT_DIR = join(DATA_ROOT, 'biorxiv')

const REQ_PER_SEC = 5
const API_BASE = 'https://api.biorxiv.org/details/'
const SERVERS = ['biorxiv', 'medrxiv']
const INTERVAL = process.env.BIORXIV_INTERVAL || '2018-01-01/2025-12-31'   // start/end

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

async function fetchPage(server, interval, cursor, limiter, attempts = 3) {
  await limiter.take()
  const url = `${API_BASE}${server}/${interval}/${cursor}`
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
      return await res.json()
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      const wait = 2000 * Math.pow(2, i)
      await sleep(wait)
    }
  }
  throw lastErr
}

function compact(p) {
  return {
    server: p.server,
    doi: p.doi,
    title: p.title,
    abstract: p.abstract,
    authors: p.authors,
    author_corresponding: p.author_corresponding,
    author_corresponding_institution: p.author_corresponding_institution,
    date: p.date,
    version: p.version,
    type: p.type,                  // new | revised
    license: p.license,
    category: p.category,
    jatsxml: p.jatsxml,            // URL to JATS XML if available
    // Published-version linkage (when present)
    published_journal: p.published_journal || null,
    published_doi: p.published_doi || null,
    published_date: p.published_date || null,
    // Compute gap if possible
    preprint_to_publication_days: (p.date && p.published_date)
      ? Math.round((new Date(p.published_date) - new Date(p.date)) / 86400000)
      : null,
  }
}

function loadAlreadyFetched(file) {
  const done = new Set()
  if (!existsSync(file)) return done
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line); if (r.doi && r.version) done.add(`${r.doi}|${r.version}`) } catch {}
  }
  return done
}

async function collectServer(server, interval, outPath, limiter, already, counters) {
  console.log(`\n[${server}] interval ${interval}`)
  let cursor = 0
  let total = Infinity
  while (cursor < total) {
    try {
      const j = await fetchPage(server, interval, cursor, limiter)
      const records = j?.collection || []
      const msg = j?.messages?.[0] || {}
      if (total === Infinity) total = Number(msg.total || records.length)
      if (records.length === 0) break
      let written = 0
      for (const p of records) {
        const key = `${p.doi}|${p.version}`
        if (already.has(key)) continue
        appendFileSync(outPath, JSON.stringify(compact(p)) + '\n')
        already.add(key)
        written++
      }
      counters.ok += written
      cursor += records.length
      console.log(`  cursor=${cursor}/${total}  +${written} new (total in file: ${counters.ok})`)
    } catch (e) {
      console.warn(`  fetch failed at cursor ${cursor}: ${e.message}`)
      cursor += 100  // skip page on failure
      counters.fail++
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `preprints-${todayStamp()}.jsonl`)
  const already = loadAlreadyFetched(outPath)

  console.log(`PaperFate · bioRxiv + medRxiv collector`)
  console.log(`Output: ${outPath}`)
  console.log(`Interval: ${INTERVAL}`)
  console.log(`Already cached entries: ${already.size}`)

  const limiter = new Limiter(REQ_PER_SEC)
  const counters = { ok: 0, fail: 0, t0: Date.now() }
  for (const server of SERVERS) {
    await collectServer(server, INTERVAL, outPath, limiter, already, counters)
  }
  console.log(`\n✓ Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`  new entries: ${counters.ok}, fail pages: ${counters.fail}`)
  if (existsSync(outPath)) {
    console.log(`  output: ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
