#!/usr/bin/env node
// PaperFate · PMID → PMCID expansion via NCBI ID Converter API
//
// We have ~2M PMIDs without PMCID, but a fraction of those *do* have PMCIDs
// that were never mapped in our initial collection. Discovering them widens
// the PMC AWS S3 fulltext fetch pool.
//
// API: https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/
//      ?ids=PMID1,PMID2,...&format=json
// Batch size: up to 200 IDs per request. 10/s with API key.
//
// Output: data/pmcid-expansion/expansion-{date}.jsonl
//   one row per discovered PMID with PMCID: {pmid, pmcid, doi}
//
// Usage:
//   NCBI_API_KEY=... node scripts/expand-pmid-to-pmcid.mjs [--limit=N] [--batch=200] [--rps=8]

import Database from 'better-sqlite3'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'pmcid-expansion')
const API_BASE = 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/'
const NCBI_KEY = process.env.NCBI_API_KEY || ''

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const BATCH = Math.min(Number(arg('batch', '200')), 200)
const RPS = Number(arg('rps', '8'))
const LIMIT = Number(arg('limit', '0'))

mkdirSync(OUT_DIR, { recursive: true })
function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
const OUT_PATH = join(OUT_DIR, `expansion-${todayStamp()}.jsonl`)

async function loadAlreadyDone() {
  const seen = new Set()
  for (const name of readdirSync(OUT_DIR)) {
    if (!name.endsWith('.jsonl') || name.startsWith('_')) continue
    const p = join(OUT_DIR, name)
    const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      // store both hits and misses to skip re-querying
      const m = line.match(/"pmid"\s*:\s*"?(\d+)"?/)
      if (m) seen.add(m[1])
    }
  }
  console.log(`already queried: ${seen.size.toLocaleString()}`)
  return seen
}

function loadQueue(done) {
  console.log('Querying DB for PMIDs without PMCID...')
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  const rows = db.prepare(`
    SELECT pmid FROM papers
    WHERE pmid IS NOT NULL AND pmid != ''
      AND (pmcid IS NULL OR pmcid = '')
  `).all()
  db.close()
  const queue = []
  let skipped = 0
  for (const r of rows) {
    const pmid = String(r.pmid)
    if (done.has(pmid)) { skipped++; continue }
    queue.push(pmid)
    if (LIMIT > 0 && queue.length >= LIMIT) break
  }
  console.log(`  candidates ${rows.length.toLocaleString()}  skipped(queried) ${skipped.toLocaleString()}  queue ${queue.length.toLocaleString()}`)
  return queue
}

async function callConverter(ids) {
  const params = new URLSearchParams({
    ids: ids.join(','),
    format: 'json',
    tool: 'paperfate',
    email: 'beta@paperfate.com',
  })
  if (NCBI_KEY) params.set('api_key', NCBI_KEY)
  const url = API_BASE + '?' + params.toString()
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function main() {
  console.log('PaperFate · PMID → PMCID expander')
  console.log(`DB:       ${DB_PATH}`)
  console.log(`Output:   ${OUT_PATH}`)
  console.log(`API key:  ${NCBI_KEY ? 'yes' : 'NO (3/s)'}`)
  console.log(`Args:     batch=${BATCH} rps=${RPS} limit=${LIMIT || 'none'}`)
  console.log('')

  const done = await loadAlreadyDone()
  const queue = loadQueue(done)
  if (queue.length === 0) { console.log('nothing to do'); return }

  const t0 = Date.now()
  let queried = 0, found = 0, errors = 0
  const minDelayMs = Math.ceil(1000 / RPS)

  for (let i = 0; i < queue.length; i += BATCH) {
    const ids = queue.slice(i, i + BATCH)
    const tCallStart = Date.now()
    try {
      const json = await callConverter(ids)
      const records = json?.records || []
      for (const rec of records) {
        const pmid = String(rec.pmid || rec['requested-id'] || '')
        // Always log (hit or miss) so resume can skip
        const row = { pmid, pmcid: rec.pmcid || null, doi: rec.doi || null }
        appendFileSync(OUT_PATH, JSON.stringify(row) + '\n')
        if (rec.pmcid) found++
      }
      queried += ids.length
    } catch (e) {
      errors++
      console.log(`  batch ${i / BATCH} ERROR: ${e.message}`)
      await sleep(5000)
    }

    if ((i / BATCH) % 10 === 0) {
      const elapsed = (Date.now() - t0) / 1000
      const rate = (queried / Math.max(1, elapsed)).toFixed(0)
      const eta = ((queue.length - queried) / Math.max(1, rate) / 60).toFixed(0)
      console.log(`  ${queried.toLocaleString()}/${queue.length.toLocaleString()}  PMC found=${found.toLocaleString()} (${(found * 100 / Math.max(1, queried)).toFixed(1)}%)  ${rate}/s  eta=${eta}m  err=${errors}`)
    }

    const elapsed = Date.now() - tCallStart
    if (elapsed < minDelayMs) await sleep(minDelayMs - elapsed)
  }

  console.log(`\nDone in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  console.log(`  queried=${queried.toLocaleString()}  PMC found=${found.toLocaleString()}  errors=${errors}`)
}

main().catch(e => { console.error(e); process.exit(1) })
