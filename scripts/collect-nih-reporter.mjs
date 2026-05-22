#!/usr/bin/env node
// PaperFate · NIH RePORTER publication→grant linker
//
// For each PMID in paperfate.db, query the NIH RePORTER v2 API to discover
// which NIH grants funded the publication. Output one JSONL row per (pmid,
// coreproject) link to data/nih-reporter/links-{date}.jsonl.
//
// API: https://api.reporter.nih.gov/v2/publications/search
//   POST {"criteria": {"pmids": [123, 456, ...]}, "limit": 1000}
//
// PMID batch size: tested up to 1000 — API accepts. Returns one row per
// (pmid, coreproject) pair. ~25% of biomedical PMIDs have NIH funding.

import Database from 'better-sqlite3'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'nih-reporter')
const API = 'https://api.reporter.nih.gov/v2/publications/search'

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const BATCH = Math.min(Number(arg('batch', '500')), 1000)
const RPS = Number(arg('rps', '5'))
const LIMIT = Number(arg('limit', '0'))

mkdirSync(OUT_DIR, { recursive: true })
function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
const OUT_PATH = join(OUT_DIR, `links-${todayStamp()}.jsonl`)

async function loadAlreadyQueried() {
  const seen = new Set()
  for (const name of readdirSync(OUT_DIR)) {
    if (!name.endsWith('.jsonl') || name.startsWith('_')) continue
    const p = join(OUT_DIR, name)
    const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      // Each row is either a link {pmid, coreproject} or a NO-GRANT marker {pmid, no_grant: true}
      const m = line.match(/"pmid"\s*:\s*"?(\d+)"?/)
      if (m) seen.add(m[1])
    }
  }
  console.log(`  already-queried PMIDs: ${seen.size.toLocaleString()}`)
  return seen
}

function loadQueue(done) {
  console.log('Querying DB for PMIDs...')
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  const rows = db.prepare(`SELECT pmid FROM papers WHERE pmid IS NOT NULL AND pmid != '' ORDER BY pmid`).all()
  db.close()
  const queue = []
  let skipped = 0
  for (const r of rows) {
    const pmid = String(r.pmid)
    if (done.has(pmid)) { skipped++; continue }
    queue.push(pmid)
    if (LIMIT > 0 && queue.length >= LIMIT) break
  }
  console.log(`  candidates ${rows.length.toLocaleString()}  skipped(done) ${skipped.toLocaleString()}  queued ${queue.length.toLocaleString()}`)
  return queue
}

async function callApi(pmids) {
  const body = { criteria: { pmids: pmids.map(Number) }, limit: 500 }
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'paperfate/0.3 (beta@paperfate.com)' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function main() {
  console.log('PaperFate · NIH RePORTER publication→grant linker')
  console.log(`DB:     ${DB_PATH}`)
  console.log(`Output: ${OUT_PATH}`)
  console.log(`Args:   batch=${BATCH} rps=${RPS} limit=${LIMIT || 'none'}`)
  console.log('')
  const done = await loadAlreadyQueried()
  const queue = loadQueue(done)
  if (queue.length === 0) { console.log('nothing to do'); return }

  const t0 = Date.now()
  let queried = 0, withGrant = 0, links = 0, errors = 0
  const minDelay = Math.ceil(1000 / RPS)

  for (let i = 0; i < queue.length; i += BATCH) {
    const ids = queue.slice(i, i + BATCH)
    const tCall = Date.now()
    try {
      const json = await callApi(ids)
      const results = json?.results || []
      // Track which PMIDs got at least one grant
      const pmidsWithGrants = new Set()
      for (const r of results) {
        const row = { pmid: String(r.pmid), coreproject: r.coreproject, applid: r.applid }
        appendFileSync(OUT_PATH, JSON.stringify(row) + '\n')
        links++
        pmidsWithGrants.add(String(r.pmid))
      }
      withGrant += pmidsWithGrants.size
      // Mark queried PMIDs without grants so we skip them on resume
      for (const pmid of ids) {
        if (!pmidsWithGrants.has(String(pmid))) {
          appendFileSync(OUT_PATH, JSON.stringify({ pmid: String(pmid), no_grant: true }) + '\n')
        }
      }
      queried += ids.length
    } catch (e) {
      errors++
      console.log(`  batch ${i / BATCH} ERR: ${e.message}`)
      await sleep(5000)
    }
    if ((i / BATCH) % 10 === 0) {
      const elapsed = (Date.now() - t0) / 1000
      const rate = (queried / Math.max(1, elapsed)).toFixed(0)
      const eta = ((queue.length - queried) / Math.max(1, rate) / 60).toFixed(0)
      console.log(`  ${queried.toLocaleString()}/${queue.length.toLocaleString()}  withGrant=${withGrant.toLocaleString()} (${(withGrant * 100 / Math.max(1, queried)).toFixed(1)}%)  links=${links.toLocaleString()}  ${rate}/s  eta=${eta}m  err=${errors}`)
    }
    const elapsed = Date.now() - tCall
    if (elapsed < minDelay) await sleep(minDelay - elapsed)
  }
  console.log(`\nDone in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  console.log(`queried=${queried.toLocaleString()}  withGrant=${withGrant.toLocaleString()}  links=${links.toLocaleString()}  errors=${errors}`)
}

main().catch(e => { console.error(e); process.exit(1) })
