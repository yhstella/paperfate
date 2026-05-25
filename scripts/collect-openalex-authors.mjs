#!/usr/bin/env node
// PaperFate OpenAlex author enrichment collector.
//
// Extracts OpenAlex author IDs from existing OpenAlex work enrichment and the
// SQLite papers.authorships_json column, then fetches /authors/{id}. Output is
// idempotent JSONL under $DATA_ROOT/openalex-authors/all-YYYY-MM-DD.jsonl.
//
// Usage:
//   DATA_ROOT=E:/paperfate/data OPENALEX_EMAIL=you@example.com node scripts/collect-openalex-authors.mjs
//   node scripts/collect-openalex-authors.mjs --dry-run --max-source-lines 10000
//   node scripts/collect-openalex-authors.mjs --rps 10 --parallel 8 --limit 100000

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
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OPENALEX_DIR = join(DATA_ROOT, 'openalex')
const OUT_DIR = join(DATA_ROOT, 'openalex-authors')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const EMAIL = process.env.OPENALEX_EMAIL || process.env.NCBI_EMAIL || 'beta@paperfate.com'
const REQ_PER_SEC = Number(arg('rps', process.env.OPENALEX_AUTHOR_RPS || process.env.OPENALEX_RPS || '25'))
const PARALLEL = Number(arg('parallel', process.env.OPENALEX_AUTHOR_PARALLEL || '12'))
const LIMIT = Number(arg('limit', '0'))
const MAX_SOURCE_LINES = Number(arg('max-source-lines', '0'))
const DRY_RUN = ARGS.includes('--dry-run')
const SOURCE = arg('source', 'both') // both | jsonl | db
const API_BASE = 'https://api.openalex.org/authors/'

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function normalizeAuthorId(id) {
  if (!id) return null
  const s = String(id).trim()
  const m = s.match(/(?:https?:\/\/openalex\.org\/)?(A\d+)/i)
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

async function fetchAuthor(id, limiter, attempts = 5) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    await limiter.take()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const url = `${API_BASE}${encodeURIComponent(id)}?mailto=${encodeURIComponent(EMAIL)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': `paperfate/0.3 (mailto:${EMAIL})` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) return { id, missing: true }
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

function compact(a, requestedId) {
  if (!a || a.missing) {
    return {
      openalex_id: requestedId,
      missing: true,
      fetched_at: new Date().toISOString(),
    }
  }
  const affiliations = (a.affiliations || []).slice(0, 5).map(x => ({
    institution_id: x.institution?.id || null,
    institution_name: x.institution?.display_name || null,
    country_code: x.institution?.country_code || null,
    years: x.years || [],
  }))
  const last = a.last_known_institution || {}
  return {
    openalex_id: normalizeAuthorId(a.id) || requestedId,
    openalex_url: a.id || null,
    orcid: a.orcid || null,
    display_name: a.display_name || null,
    works_count: a.works_count ?? null,
    cited_by_count: a.cited_by_count ?? null,
    h_index: a.summary_stats?.h_index ?? null,
    i10_index: a.summary_stats?.i10_index ?? null,
    two_yr_mean_citedness: a.summary_stats?.['2yr_mean_citedness'] ?? null,
    affiliations,
    last_known_country: last.country_code || null,
    last_known_institution: last.id ? {
      id: last.id,
      display_name: last.display_name || null,
      country_code: last.country_code || null,
      type: last.type || null,
    } : null,
    top_concepts: (a.x_concepts || []).slice(0, 8).map(c => ({
      id: c.id,
      name: c.display_name,
      level: c.level,
      score: c.score,
    })),
    counts_by_year: a.counts_by_year || [],
    fetched_at: new Date().toISOString(),
  }
}

function addAuthorId(ids, id, priority) {
  const normalized = normalizeAuthorId(id)
  if (!normalized) return
  const old = ids.get(normalized)
  if (old == null || priority < old) ids.set(normalized, priority)
}

function addAuthorshipIds(authorships, ids) {
  if (!Array.isArray(authorships)) return
  for (let i = 0; i < authorships.length; i++) {
    const au = authorships[i]
    const isPriority = i === 0 || i === authorships.length - 1 || au?.is_corresponding
    addAuthorId(ids, au?.author_id || au?.author?.id || au?.id, isPriority ? 0 : 1)
  }
}

async function extractIdsFromJsonl(ids) {
  if (!existsSync(OPENALEX_DIR)) return { files: 0, lines: 0 }
  const files = readdirSync(OPENALEX_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => join(OPENALEX_DIR, f))
  let lines = 0
  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      lines++
      try {
        const rec = JSON.parse(line)
        addAuthorshipIds(rec.authorships, ids)
      } catch {}
      if (MAX_SOURCE_LINES > 0 && lines >= MAX_SOURCE_LINES) return { files: files.length, lines }
    }
    console.log(`  scanned ${basename(file)}; author_ids=${ids.size.toLocaleString()}`)
  }
  return { files: files.length, lines }
}

function extractIdsFromDb(ids) {
  if (!existsSync(DB_PATH)) return { rows: 0 }
  const db = new Database(DB_PATH, { readonly: true })
  const rows = db.prepare(`
    SELECT authorships_json
    FROM papers
    WHERE authorships_json IS NOT NULL AND authorships_json != ''
  `).iterate()
  let n = 0
  for (const row of rows) {
    n++
    try { addAuthorshipIds(JSON.parse(row.authorships_json), ids) } catch {}
  }
  db.close()
  return { rows: n }
}

async function loadFetchedIds() {
  const done = new Set()
  if (!existsSync(OUT_DIR)) return done
  for (const f of readdirSync(OUT_DIR).filter(x => x.endsWith('.jsonl'))) {
    const path = join(OUT_DIR, f)
    const rl = createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        const id = normalizeAuthorId(r.openalex_id || r.openalex_url || r.id)
        if (id) done.add(id)
      } catch {}
    }
  }
  return done
}

async function worker(queue, limiter, outPath, counters) {
  while (true) {
    const id = queue.shift()
    if (!id) break
    try {
      const raw = await fetchAuthor(id, limiter)
      const row = compact(raw, id)
      appendFileSync(outPath, JSON.stringify(row) + '\n')
      if (row.missing) counters.miss++
      else counters.ok++
    } catch (e) {
      counters.fail++
      appendFileSync(outPath, JSON.stringify({
        openalex_id: id,
        error: String(e.message || e),
        fetched_at: new Date().toISOString(),
      }) + '\n')
    }
    counters.done++
    if (counters.done % 100 === 0) {
      const elapsed = Math.max(1, (Date.now() - counters.t0) / 1000)
      const rate = counters.done / elapsed
      const etaMin = Math.round((counters.total - counters.done) / Math.max(1, rate) / 60)
      console.log(`  ${counters.done.toLocaleString()}/${counters.total.toLocaleString()} ok=${counters.ok.toLocaleString()} miss=${counters.miss} fail=${counters.fail} rate=${rate.toFixed(1)}/s eta=${etaMin}m`)
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)

  console.log('PaperFate OpenAlex Authors collector')
  console.log(`Email:       ${EMAIL}`)
  console.log(`DATA_ROOT:   ${DATA_ROOT}`)
  console.log(`Output:      ${outPath}`)
  console.log(`RPS/parallel:${REQ_PER_SEC}/${PARALLEL}`)

  const ids = new Map()
  if (SOURCE === 'both' || SOURCE === 'jsonl') {
    const s = await extractIdsFromJsonl(ids)
    console.log(`JSONL scan:  ${s.lines.toLocaleString()} rows across ${s.files} file(s)`)
  }
  if (SOURCE === 'both' || SOURCE === 'db') {
    const s = extractIdsFromDb(ids)
    console.log(`DB scan:     ${s.rows.toLocaleString()} papers with authorships_json`)
  }

  const done = await loadFetchedIds()
  const priorityCount = [...ids.values()].filter(p => p === 0).length
  let queue = [...ids.entries()]
    .filter(([id]) => !done.has(id))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id)
  if (LIMIT > 0) queue = queue.slice(0, LIMIT)

  console.log(`Unique IDs:  ${ids.size.toLocaleString()}`)
  console.log(`Priority IDs:${priorityCount.toLocaleString()} (first/last/corresponding authors)`)
  console.log(`Fetched IDs: ${done.size.toLocaleString()}`)
  console.log(`Queued:      ${queue.length.toLocaleString()}`)

  if (DRY_RUN || queue.length === 0) {
    console.log(DRY_RUN ? 'Dry run complete; no network calls.' : 'Nothing to do.')
    return
  }

  const limiter = new Limiter(REQ_PER_SEC)
  const counters = { done: 0, ok: 0, miss: 0, fail: 0, total: queue.length, t0: Date.now() }
  const workers = Array.from({ length: Math.max(1, PARALLEL) }, () => worker(queue, limiter, outPath, counters))
  await Promise.all(workers)

  const mb = existsSync(outPath) ? (statSync(outPath).size / 1024 / 1024).toFixed(1) : '0.0'
  console.log(`Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`ok=${counters.ok} missing=${counters.miss} failed=${counters.fail}`)
  console.log(`output=${outPath} (${mb} MB)`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
