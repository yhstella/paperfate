// PaperFate · POST /api/references
//
// Summarises a user-supplied reference list by looking each DOI up through
// OpenAlex and joining ISSN-L → JIF from the 800-journal shortlist.
//
// Body: { dois: string[] }   // up to 50 DOIs accepted
// Returns: {
//   n_input, n_resolved, n_with_jif,
//   mean_jif, median_jif,
//   top_journals: [{ name, issn, count, jif }],
//   top_categories: [{ category, count }],
//   year_median, year_iqr,
//   references: [{ doi, title?, venue?, issn?, jif?, year?, citations? }]
// }
//
// Per Codex Round 5 Task 2 recommendation, this is the cold-start
// fact-based feature the UI can use to anchor the journey/tier card
// when a user pastes their actual reference list. Independent of any
// trained model — purely descriptive of the user's bibliography.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SHORTLIST_PATH = join(ROOT, 'weights', 'journals-shortlist.json')

export const config = { maxDuration: 60, runtime: 'nodejs' }

const MAX_DOIS = 50
const PARALLEL = 6
const MAILTO = process.env.PAPERFATE_OPENALEX_MAILTO || 'beta@paperfate.com'

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

function bad(res, status, error, detail) {
  return res.status(status).json({ error, ...(detail !== undefined && { detail }) })
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', c => { buf += c })
    req.on('end', () => { if (!buf) return resolve({}); try { resolve(JSON.parse(buf)) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

let _issnIndex = null
function loadIssnIndex() {
  if (_issnIndex) return _issnIndex
  _issnIndex = new Map()
  if (!existsSync(SHORTLIST_PATH)) return _issnIndex
  try {
    const data = JSON.parse(readFileSync(SHORTLIST_PATH, 'utf-8'))
    for (const j of data.journals || []) {
      if (j.issn) _issnIndex.set(String(j.issn).trim(), j)
    }
  } catch {}
  return _issnIndex
}

function normalizeDoi(s) {
  return String(s || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '')
}

async function fetchOpenAlex(doi) {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=id,doi,title,publication_year,cited_by_count,primary_location&mailto=${MAILTO}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': `paperfate/0.3 (mailto:${MAILTO})` }, signal: ctrl.signal })
    clearTimeout(timer)
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`openalex ${r.status}`)
    return await r.json()
  } catch { clearTimeout(timer); return null }
}

function shapeWork(w, issnIndex) {
  if (!w) return null
  const loc = w.primary_location || {}
  const src = loc.source || {}
  const issnL = src.issn_l || (Array.isArray(src.issn) ? src.issn[0] : null)
  const hit = issnL ? issnIndex.get(issnL) : null
  return {
    doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : null,
    title: w.title || null,
    venue: src.display_name || hit?.name || null,
    issn: issnL,
    jif: Number.isFinite(+hit?.jif) ? +hit.jif : null,
    category: hit?.category || null,
    year: w.publication_year || null,
    citations: w.cited_by_count ?? null,
  }
}

function median(arr) {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function topCounts(items, key, limit = 5) {
  const tally = new Map()
  for (const it of items) {
    const k = it[key]
    if (!k) continue
    tally.set(k, (tally.get(k) || 0) + 1)
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed')

  let body
  try { body = await readBody(req) } catch (e) { return bad(res, 400, 'invalid_json', String(e.message || e)) }

  const dois = Array.isArray(body?.dois)
    ? [...new Set(body.dois.map(normalizeDoi).filter(d => /^10\./.test(d)))]
    : []
  if (!dois.length) return bad(res, 400, 'no_valid_dois', 'expected { dois: ["10.xxx/..."] }')
  if (dois.length > MAX_DOIS) return bad(res, 400, 'too_many_dois', `max ${MAX_DOIS} per request`)

  const issnIndex = loadIssnIndex()

  // Parallel-pool OpenAlex lookups, PARALLEL at a time
  const out = []
  let cursor = 0
  async function worker() {
    while (cursor < dois.length) {
      const idx = cursor++
      const doi = dois[idx]
      const w = await fetchOpenAlex(doi)
      out[idx] = w ? shapeWork(w, issnIndex) : { doi, _missing: true }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, dois.length) }, () => worker()))

  const resolved = out.filter(x => x && !x._missing)
  const withJif = resolved.filter(x => Number.isFinite(x.jif))
  const jifs = withJif.map(x => x.jif)
  const years = resolved.map(x => x.year).filter(y => Number.isFinite(y))

  return res.status(200).json({
    n_input: dois.length,
    n_resolved: resolved.length,
    n_with_jif: withJif.length,
    mean_jif: jifs.length ? +(jifs.reduce((a, b) => a + b, 0) / jifs.length).toFixed(2) : null,
    median_jif: jifs.length ? +median(jifs).toFixed(2) : null,
    top_journals: topCounts(resolved, 'venue').map(([name, count]) => {
      const sample = resolved.find(r => r.venue === name) || {}
      return { name, count, issn: sample.issn || null, jif: sample.jif ?? null }
    }),
    top_categories: topCounts(resolved, 'category').map(([category, count]) => ({ category, count })),
    year_median: years.length ? Math.round(median(years)) : null,
    year_min: years.length ? Math.min(...years) : null,
    year_max: years.length ? Math.max(...years) : null,
    references: out,
  })
}
