#!/usr/bin/env node
// PaperFate OpenAlex referenced_works collector.
//
// Selects high-value papers from the unified DB, fetches /works/{id} with only
// referenced_works fields, and writes idempotent JSONL under
// $DATA_ROOT/openalex-refs/refs-YYYY-MM-DD.jsonl.
//
// Usage:
//   DATA_ROOT=E:/paperfate/data OPENALEX_EMAIL=you@example.com node scripts/collect-openalex-references.mjs
//   node scripts/collect-openalex-references.mjs --dry-run --limit 20
//   node scripts/collect-openalex-references.mjs --limit 100000 --rps 25 --parallel 16

import Database from 'better-sqlite3'
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'openalex-refs')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const EMAIL = process.env.OPENALEX_EMAIL || process.env.NCBI_EMAIL || 'beta@paperfate.com'
const LIMIT = Number(arg('limit', process.env.OPENALEX_REFS_LIMIT || '100000'))
const REQ_PER_SEC = Number(arg('rps', process.env.OPENALEX_REFS_RPS || '25'))
const PARALLEL = Number(arg('parallel', process.env.OPENALEX_REFS_PARALLEL || '16'))
const DRY_RUN = ARGS.includes('--dry-run')
const RETRY_ERRORS = ARGS.includes('--retry-errors')
const API_BASE = 'https://api.openalex.org/works/'

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function normalizeDoi(doi) {
  if (!doi) return null
  return String(doi)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .toLowerCase()
}

function normalizeWorkId(id) {
  if (!id) return null
  const s = String(id).trim()
  const m = s.match(/(?:https?:\/\/openalex\.org\/)?(W\d+)/i)
  return m ? m[1].toUpperCase() : null
}

class Limiter {
  constructor(perSec) {
    this.gap = 1000 / Math.max(1, perSec)
    this.next = 0
  }
  async take() {
    const now = Date.now()
    const wait = Math.max(0, this.next - now)
    this.next = Math.max(now, this.next) + this.gap
    if (wait) await sleep(wait)
  }
}

async function fetchWorkRefs(openalexId, limiter, attempts = 5) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    await limiter.take()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const id = encodeURIComponent(openalexId)
      const params = new URLSearchParams({
        select: 'id,doi,referenced_works,referenced_works_count',
        mailto: EMAIL,
      })
      const res = await fetch(`${API_BASE}${id}?${params.toString()}`, {
        headers: { 'User-Agent': `paperfate/0.3 (mailto:${EMAIL})` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) return { id: openalexId, missing: true }
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return await res.json()
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      await sleep(1000 * Math.pow(2, i))
    }
  }
  throw lastErr
}

function compact(work, item) {
  const openalexId = normalizeWorkId(work?.id) || item.openalex_id
  if (!work || work.missing) {
    return {
      doi: item.doi,
      openalex_id: openalexId,
      missing: true,
      ref_openalex_ids: [],
      n_refs: 0,
      referenced_works_count: null,
      fetched_at: new Date().toISOString(),
    }
  }
  const refIds = Array.isArray(work.referenced_works)
    ? [...new Set(work.referenced_works.map(normalizeWorkId).filter(Boolean))]
    : []
  return {
    doi: normalizeDoi(work.doi) || item.doi,
    openalex_id: openalexId,
    ref_openalex_ids: refIds,
    n_refs: refIds.length,
    referenced_works_count: work.referenced_works_count ?? null,
    fetched_at: new Date().toISOString(),
  }
}

function addMetric(map, key, value) {
  if (!key || value == null || Number.isNaN(Number(value))) return
  const old = map.get(key)
  const n = Number(value)
  if (old == null || n > old) map.set(key, n)
}

function loadJournalJifMaps(db) {
  const byVenueYear = new Map()
  const byIssnYear = new Map()
  const rows = db.prepare(`
    SELECT openalex_id, issn, year, jcr_jif, jcr_jif_5yr
    FROM journal_year_metrics
    WHERE year IS NOT NULL AND (jcr_jif IS NOT NULL OR jcr_jif_5yr IS NOT NULL)
  `).iterate()
  let n = 0
  for (const r of rows) {
    n++
    const value = r.jcr_jif ?? r.jcr_jif_5yr
    addMetric(byVenueYear, `${r.openalex_id}|${r.year}`, value)
    addMetric(byIssnYear, `${r.issn}|${r.year}`, value)
  }
  return { byVenueYear, byIssnYear, rows: n }
}

function paperPriority(p) {
  const jif = p.jcr_jif ?? 0
  const fwci = p.fwci ?? 0
  const citations = Math.max(p.citations_openalex ?? 0, p.citations_s2 ?? 0)
  const refs = p.reference_count ?? 0

  if (jif >= 30) return 700000000 + jif * 100000 + fwci * 1000 + citations
  if (jif >= 10) return 600000000 + jif * 100000 + fwci * 1000 + citations
  if (fwci >= 10) return 500000000 + fwci * 100000 + citations
  if (fwci >= 5) return 400000000 + fwci * 100000 + citations
  if (citations >= 500) return 300000000 + citations * 1000 + refs
  if (citations >= 100) return 200000000 + citations * 1000 + refs
  return jif * 100000 + fwci * 1000 + citations + refs / 1000
}

function selectTargets() {
  if (!existsSync(DB_PATH)) throw new Error(`DB not found: ${DB_PATH}`)
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true, timeout: 60000 })
  db.pragma('busy_timeout = 60000')

  console.log('Loading journal JIF maps...')
  const jifMaps = loadJournalJifMaps(db)
  console.log(`  journal_year rows=${jifMaps.rows.toLocaleString()} venue-year=${jifMaps.byVenueYear.size.toLocaleString()} issn-year=${jifMaps.byIssnYear.size.toLocaleString()}`)

  const rows = db.prepare(`
    SELECT doi, openalex_id, venue_openalex_id, issn, year,
           fwci, citations_openalex, citations_s2, reference_count
    FROM papers
    WHERE doi IS NOT NULL AND doi != ''
      AND openalex_id IS NOT NULL AND openalex_id != ''
  `).iterate()

  const targets = []
  let scanned = 0
  let withJif = 0
  for (const r of rows) {
    scanned++
    const doi = normalizeDoi(r.doi)
    const openalexId = normalizeWorkId(r.openalex_id)
    if (!doi || !openalexId) continue
    const jif =
      jifMaps.byVenueYear.get(`${r.venue_openalex_id}|${r.year}`) ??
      jifMaps.byIssnYear.get(`${r.issn}|${r.year}`) ??
      null
    if (jif != null) withJif++
    const item = {
      doi,
      openalex_id: openalexId,
      year: r.year ?? null,
      jcr_jif: jif,
      fwci: r.fwci ?? null,
      citations_openalex: r.citations_openalex ?? null,
      citations_s2: r.citations_s2 ?? null,
      reference_count: r.reference_count ?? null,
    }
    item.priority = paperPriority(item)
    targets.push(item)
  }
  db.close()

  targets.sort((a, b) =>
    b.priority - a.priority ||
    (b.jcr_jif ?? -1) - (a.jcr_jif ?? -1) ||
    (b.fwci ?? -1) - (a.fwci ?? -1) ||
    Math.max(b.citations_openalex ?? 0, b.citations_s2 ?? 0) - Math.max(a.citations_openalex ?? 0, a.citations_s2 ?? 0) ||
    a.doi.localeCompare(b.doi)
  )

  const selected = LIMIT > 0 ? targets.slice(0, LIMIT) : targets
  const highJif = selected.filter(x => (x.jcr_jif ?? 0) >= 10).length
  const highFwci = selected.filter(x => (x.fwci ?? 0) >= 5).length
  const popular = selected.filter(x => Math.max(x.citations_openalex ?? 0, x.citations_s2 ?? 0) >= 100).length
  console.log(`Papers scanned: ${scanned.toLocaleString()}`)
  console.log(`Papers with JIF match: ${withJif.toLocaleString()}`)
  console.log(`Selected: ${selected.length.toLocaleString()} (JIF>=10 ${highJif.toLocaleString()}, FWCI>=5 ${highFwci.toLocaleString()}, citations>=100 ${popular.toLocaleString()})`)
  return selected
}

async function loadFetchedKeys() {
  const byDoi = new Set()
  const byOpenAlexId = new Set()
  if (!existsSync(OUT_DIR)) return { byDoi, byOpenAlexId, files: 0, rows: 0 }
  const files = readdirSync(OUT_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
    .map(f => join(OUT_DIR, f))
  let rows = 0
  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r.error && RETRY_ERRORS) continue
        const doi = normalizeDoi(r.doi)
        const openalexId = normalizeWorkId(r.openalex_id || r.id)
        if (doi) byDoi.add(doi)
        if (openalexId) byOpenAlexId.add(openalexId)
        rows++
      } catch {}
    }
    console.log(`  loaded ${basename(file)}; fetched works=${byOpenAlexId.size.toLocaleString()}`)
  }
  return { byDoi, byOpenAlexId, files: files.length, rows }
}

async function worker(queue, nextItem, limiter, outPath, counters) {
  while (true) {
    const item = nextItem()
    if (!item) break
    try {
      const raw = await fetchWorkRefs(item.openalex_id, limiter)
      const row = compact(raw, item)
      appendFileSync(outPath, JSON.stringify(row) + '\n')
      if (row.missing) counters.miss++
      else {
        counters.ok++
        counters.refs += row.n_refs
      }
    } catch (e) {
      counters.fail++
      appendFileSync(outPath, JSON.stringify({
        doi: item.doi,
        openalex_id: item.openalex_id,
        error: String(e.message || e),
        ref_openalex_ids: [],
        n_refs: 0,
        fetched_at: new Date().toISOString(),
      }) + '\n')
    }
    counters.done++
    if (counters.done % 100 === 0) {
      const elapsed = Math.max(1, (Date.now() - counters.t0) / 1000)
      const rate = counters.done / elapsed
      const etaMin = Math.round((counters.total - counters.done) / Math.max(1, rate) / 60)
      console.log(`  ${counters.done.toLocaleString()}/${counters.total.toLocaleString()} ok=${counters.ok.toLocaleString()} miss=${counters.miss} fail=${counters.fail} refs=${counters.refs.toLocaleString()} rate=${rate.toFixed(1)}/s eta=${etaMin}m`)
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `refs-${todayStamp()}.jsonl`)

  console.log('PaperFate OpenAlex References collector')
  console.log(`Email:       ${EMAIL}`)
  console.log(`DATA_ROOT:   ${DATA_ROOT}`)
  console.log(`DB:          ${DB_PATH}`)
  console.log(`Output:      ${outPath}`)
  console.log(`Limit:       ${LIMIT.toLocaleString()}`)
  console.log(`RPS/parallel:${REQ_PER_SEC}/${PARALLEL}`)

  const targets = selectTargets()
  const fetched = await loadFetchedKeys()
  let queue = targets.filter(x => !fetched.byDoi.has(x.doi) && !fetched.byOpenAlexId.has(x.openalex_id))

  console.log(`Fetched rows: ${fetched.rows.toLocaleString()} across ${fetched.files} file(s)`)
  console.log(`Queued:       ${queue.length.toLocaleString()}`)

  if (DRY_RUN || queue.length === 0) {
    console.log(DRY_RUN ? 'Dry run complete; no network calls.' : 'Nothing to do.')
    for (const x of queue.slice(0, 10)) {
      console.log(`  ${x.openalex_id} doi=${x.doi} jif=${x.jcr_jif ?? ''} fwci=${x.fwci ?? ''} citations=${Math.max(x.citations_openalex ?? 0, x.citations_s2 ?? 0)}`)
    }
    return
  }

  let cursor = 0
  const nextItem = () => queue[cursor++]
  const limiter = new Limiter(REQ_PER_SEC)
  const counters = { done: 0, ok: 0, miss: 0, fail: 0, refs: 0, total: queue.length, t0: Date.now() }
  const workers = Array.from({ length: Math.max(1, PARALLEL) }, () => worker(queue, nextItem, limiter, outPath, counters))
  await Promise.all(workers)

  const mb = existsSync(outPath) ? (statSync(outPath).size / 1024 / 1024).toFixed(1) : '0.0'
  console.log(`Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`ok=${counters.ok} missing=${counters.miss} failed=${counters.fail} refs=${counters.refs}`)
  console.log(`output=${outPath} (${mb} MB)`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
