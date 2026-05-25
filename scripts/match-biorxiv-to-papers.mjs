#!/usr/bin/env node
// Match bioRxiv/medRxiv preprints to published papers in paperfate.db.
//
// Matching order:
//   1. published_doi already present in the bioRxiv metadata
//   2. local title exact/fuzzy match against papers.title
//   3. Crossref relation: works/{preprint_doi} -> is-preprint-of
//   4. bioRxiv pubs API fallback
//
// The script is resumable. It writes one JSONL result per unique preprint DOI
// under data/biorxiv-matches and skips already checked preprints by default.

import Database from 'better-sqlite3'
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'biorxiv-matches')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const LIMIT = Number(arg('limit', '0'))
const RPS = Number(arg('rps', '10'))
const WRITE = ARGS.includes('--write')
const CROSSREF = ARGS.includes('--crossref')
const BIORXIV_PUBS = ARGS.includes('--biorxiv-pubs')
const LOCAL_ONLY = ARGS.includes('--local-only')
const RECHECK_UNMATCHED = ARGS.includes('--recheck-unmatched')
const MIN_TITLE_SCORE = Number(arg('min-title-score', '0.94'))
const API_ORDER = arg('api-order', 'crossref,biorxiv-pubs').split(',').map(s => s.trim()).filter(Boolean)
const OUT_PATH = arg('out', join(OUT_DIR, `matches-${new Date().toISOString().slice(0, 10)}.jsonl`))

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

class Limiter {
  constructor(rps) {
    this.gapMs = Math.max(1, Math.ceil(1000 / Math.max(1, rps)))
    this.nextAt = 0
  }
  async take() {
    const now = Date.now()
    const wait = Math.max(0, this.nextAt - now)
    if (wait) await sleep(wait)
    this.nextAt = Date.now() + this.gapMs
  }
}

function listJsonl(subdir) {
  const dir = join(DATA_ROOT, subdir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl') && !name.startsWith('_'))
    .map(name => join(dir, name))
}

function* readJsonlSync(path) {
  const fd = openSync(path, 'r')
  const decoder = new StringDecoder('utf8')
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
  let pending = ''
  try {
    while (true) {
      const bytes = readSync(fd, buf, 0, buf.length, null)
      if (!bytes) break
      pending += decoder.write(buf.subarray(0, bytes))
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try { yield JSON.parse(line) } catch {}
      }
    }
    pending += decoder.end()
    if (pending.trim()) {
      try { yield JSON.parse(pending) } catch {}
    }
  } finally {
    closeSync(fd)
  }
}

async function* readJsonl(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (!line.trim()) continue
    try { yield JSON.parse(line) } catch {}
  }
}

function normalizeDoi(doi) {
  if (!doi) return null
  const s = String(doi)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
  return s || null
}

const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'of', 'on', 'or', 'the', 'to', 'using', 'via', 'with'])

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleTokens(title) {
  return normalizeTitle(title)
    .split(' ')
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
}

function titleBlock(title) {
  return titleTokens(title).slice(0, 4).join(' ')
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (s) => {
    const xs = []
    const padded = ` ${s} `
    for (let i = 0; i < padded.length - 1; i++) xs.push(padded.slice(i, i + 2))
    return xs
  }
  const aa = grams(a)
  const counts = new Map()
  for (const g of aa) counts.set(g, (counts.get(g) || 0) + 1)
  let overlap = 0
  for (const g of grams(b)) {
    const n = counts.get(g) || 0
    if (n > 0) {
      overlap++
      counts.set(g, n - 1)
    }
  }
  return (2 * overlap) / (aa.length + grams(b).length)
}

function loadChecked(path) {
  const checked = new Set()
  if (!existsSync(path)) return checked
  for (const rec of readJsonlSync(path)) {
    const doi = normalizeDoi(rec.preprint_doi)
    if (!doi) continue
    if (RECHECK_UNMATCHED && rec.status !== 'matched') continue
    checked.add(doi)
  }
  return checked
}

function buildPaperIndex(db) {
  console.log('Building local paper title/DOI index...')
  const doiSet = new Set()
  const exactTitle = new Map()
  const blockTitle = new Map()
  let rows = 0
  const q = db.prepare(`
    SELECT doi, title
    FROM papers
    WHERE doi IS NOT NULL AND title IS NOT NULL AND length(trim(title)) >= 20
  `)
  for (const row of q.iterate()) {
    rows++
    const doi = normalizeDoi(row.doi)
    if (!doi) continue
    doiSet.add(doi)
    const key = normalizeTitle(row.title)
    if (key.length >= 20) {
      if (exactTitle.has(key) && exactTitle.get(key)?.doi !== doi) exactTitle.set(key, null)
      else exactTitle.set(key, { doi, title: row.title })
      const block = titleBlock(row.title)
      if (block) {
        const list = blockTitle.get(block) || []
        if (list.length < 250) list.push({ doi, title: row.title, key })
        blockTitle.set(block, list)
      }
    }
    if (rows % 250000 === 0) console.log(`  indexed ${rows.toLocaleString()} papers`)
  }
  console.log(`  index ready: papers=${rows.toLocaleString()} doi=${doiSet.size.toLocaleString()} exact_titles=${exactTitle.size.toLocaleString()} blocks=${blockTitle.size.toLocaleString()}`)
  return { doiSet, exactTitle, blockTitle }
}

function localTitleMatch(preprint, index) {
  const key = normalizeTitle(preprint.title)
  if (key.length < 20) return null
  const exact = index.exactTitle.get(key)
  if (exact) {
    return {
      status: 'matched',
      method: 'title_exact',
      paper_doi: exact.doi,
      published_doi: exact.doi,
      title_score: 1,
      evidence: 'normalized title exact match',
    }
  }
  const candidates = index.blockTitle.get(titleBlock(preprint.title)) || []
  let best = null
  for (const c of candidates) {
    const score = diceCoefficient(key, c.key)
    if (!best || score > best.title_score) {
      best = {
        status: 'matched',
        method: 'title_fuzzy',
        paper_doi: c.doi,
        published_doi: c.doi,
        title_score: +score.toFixed(4),
        evidence: c.title,
      }
    }
  }
  return best && best.title_score >= MIN_TITLE_SCORE ? best : null
}

async function fetchJson(url, limiter, attempts = 3) {
  let lastErr = null
  for (let i = 0; i < attempts; i++) {
    await limiter.take()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'paperfate/0.3 (mailto:beta@paperfate.com)' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) return null
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

function relationDoi(crossref) {
  const rel = crossref?.message?.relation || {}
  for (const key of ['is-preprint-of', 'is-version-of']) {
    const xs = rel[key]
    if (!Array.isArray(xs)) continue
    const hit = xs.find(x => String(x?.['id-type'] || '').toLowerCase() === 'doi' && x.id)
    if (hit) return normalizeDoi(hit.id)
  }
  return null
}

async function crossrefMatch(preprintDoi, index, limiter) {
  if (!CROSSREF || LOCAL_ONLY) return null
  const url = `https://api.crossref.org/works/${encodeURIComponent(preprintDoi)}`
  const json = await fetchJson(url, limiter)
  const doi = relationDoi(json)
  if (!doi) return null
  return {
    status: index.doiSet.has(doi) ? 'matched' : 'unmatched',
    method: 'crossref_relation',
    paper_doi: index.doiSet.has(doi) ? doi : null,
    published_doi: doi,
    evidence: 'Crossref relation is-preprint-of',
  }
}

function pubsDoi(json) {
  const records = json?.collection || json?.messages || []
  if (!Array.isArray(records)) return null
  for (const rec of records) {
    const doi = normalizeDoi(rec.published_doi || rec.doi_published || rec.article_doi)
    if (doi) return doi
  }
  return null
}

async function biorxivPubsMatch(server, preprintDoi, index, limiter) {
  if (!BIORXIV_PUBS || LOCAL_ONLY) return null
  const source = String(server || 'biorxiv').toLowerCase().includes('med') ? 'medrxiv' : 'biorxiv'
  const url = `https://api.biorxiv.org/pubs/${source}/${preprintDoi}`
  const json = await fetchJson(url, limiter)
  const doi = pubsDoi(json)
  if (!doi) return null
  return {
    status: index.doiSet.has(doi) ? 'matched' : 'unmatched',
    method: 'biorxiv_pubs',
    paper_doi: index.doiSet.has(doi) ? doi : null,
    published_doi: doi,
    evidence: 'bioRxiv pubs endpoint',
  }
}

function preprintBase(rec) {
  return {
    server: rec.server || 'bioRxiv',
    preprint_doi: normalizeDoi(rec.doi),
    preprint_title: rec.title || null,
    preprint_date: rec.date || null,
    preprint_version: rec.version || null,
    preprint_category: rec.category || null,
    published_date: rec.published_date || null,
  }
}

function recordResult(base, match) {
  return {
    ...base,
    checked_at: new Date().toISOString(),
    status: match?.status || 'unmatched',
    method: match?.method || 'none',
    paper_doi: match?.paper_doi || null,
    published_doi: normalizeDoi(match?.published_doi) || null,
    title_score: match?.title_score ?? null,
    evidence: match?.evidence || null,
  }
}

function updateDb(updateStmt, result) {
  if (!WRITE || result.status !== 'matched' || !result.paper_doi || !result.preprint_doi) return 0
  return updateStmt.run({
    paper_doi: result.paper_doi,
    server: result.server,
    preprint_doi: result.preprint_doi,
    preprint_date: result.preprint_date,
    checked_at: result.checked_at,
  }).changes
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const files = listJsonl('biorxiv')
  if (!files.length) throw new Error(`No bioRxiv JSONL files under ${join(DATA_ROOT, 'biorxiv')}`)

  const checked = loadChecked(OUT_PATH)
  const db = new Database(DB_PATH, { timeout: 60000 })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 60000')
  const index = buildPaperIndex(db)
  const updateStmt = db.prepare(`
    UPDATE papers SET
      preprint_server = @server,
      preprint_doi = @preprint_doi,
      preprint_published_date = @preprint_date,
      preprint_pub_gap_days = CASE
        WHEN @preprint_date IS NOT NULL
         AND (cr_published_print IS NOT NULL OR cr_published_online IS NOT NULL OR oa_publication_date IS NOT NULL)
        THEN CAST(julianday(COALESCE(cr_published_print, cr_published_online, oa_publication_date)) - julianday(@preprint_date) AS INTEGER)
        ELSE preprint_pub_gap_days
      END,
      fetched_preprint_at = @checked_at
    WHERE doi = @paper_doi
      AND (
        preprint_doi IS NULL
        OR preprint_doi = @preprint_doi
        OR preprint_published_date IS NULL
        OR (@preprint_date IS NOT NULL AND julianday(@preprint_date) < julianday(preprint_published_date))
      )
  `)
  const limiter = new Limiter(RPS)
  const seenThisRun = new Set()
  const counts = { seen: 0, unique: 0, skipped_checked: 0, matched: 0, unmatched: 0, db_updated: 0, errors: 0 }

  console.log('bioRxiv matcher')
  console.log(`files=${files.length} out=${OUT_PATH}`)
  console.log(`write=${WRITE} local_only=${LOCAL_ONLY} crossref=${CROSSREF} biorxiv_pubs=${BIORXIV_PUBS} rps=${RPS}`)
  console.log(`checked_cache=${checked.size}`)

  for (const file of files) {
    for await (const rec of readJsonl(file)) {
      counts.seen++
      if (LIMIT > 0 && counts.unique >= LIMIT) break
      const base = preprintBase(rec)
      if (!base.preprint_doi || seenThisRun.has(base.preprint_doi)) continue
      seenThisRun.add(base.preprint_doi)
      if (checked.has(base.preprint_doi)) {
        counts.skipped_checked++
        continue
      }
      counts.unique++

      let result
      try {
        const published = normalizeDoi(rec.published_doi)
        if (published) {
          const exists = index.doiSet.has(published)
          result = recordResult(base, {
            status: exists ? 'matched' : 'unmatched',
            method: 'biorxiv_metadata_published_doi',
            paper_doi: exists ? published : null,
            published_doi: published,
            evidence: 'published_doi in bioRxiv metadata',
          })
        } else {
          const local = localTitleMatch(rec, index)
          result = local ? recordResult(base, local) : null
          for (const api of API_ORDER) {
            if (result?.status === 'matched' || result?.published_doi) break
            if (api === 'crossref') {
              const cr = await crossrefMatch(base.preprint_doi, index, limiter)
              if (cr) result = recordResult(base, cr)
            } else if (api === 'biorxiv-pubs' || api === 'pubs') {
              const pubs = await biorxivPubsMatch(base.server, base.preprint_doi, index, limiter)
              if (pubs) result = recordResult(base, pubs)
            }
          }
          if (!result) result = recordResult(base, null)
        }
        appendFileSync(OUT_PATH, JSON.stringify(result) + '\n')
        if (result.status === 'matched') {
          counts.matched++
          counts.db_updated += updateDb(updateStmt, result)
        } else {
          counts.unmatched++
        }
      } catch (e) {
        counts.errors++
        const errorResult = recordResult(base, { status: 'error', method: 'error', evidence: String(e.message || e) })
        appendFileSync(OUT_PATH, JSON.stringify(errorResult) + '\n')
      }

      if (counts.unique % 100 === 0) {
        console.log(`  unique=${counts.unique} matched=${counts.matched} unmatched=${counts.unmatched} db_updated=${counts.db_updated} errors=${counts.errors}`)
      }
    }
    if (LIMIT > 0 && counts.unique >= LIMIT) break
  }

  console.log(JSON.stringify(counts, null, 2))
  if (existsSync(OUT_PATH)) {
    console.log(`output=${OUT_PATH} size_mb=${(statSync(OUT_PATH).size / 1024 / 1024).toFixed(1)}`)
  }
  db.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
