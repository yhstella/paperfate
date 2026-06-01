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
import { corsHeaders as guardCors, blockDisallowedOrigin, createRateLimiter, applyRateLimit } from '../src/server/apiGuard.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SHORTLIST_PATH = join(ROOT, 'weights', 'journals-shortlist.json')

export const config = { maxDuration: 60, runtime: 'nodejs' }

const MAX_DOIS = 50
const PARALLEL = 6
const MAILTO = process.env.PAPERFATE_OPENALEX_MAILTO || 'beta@paperfate.com'

// Live OpenAlex DOI resolution is heavier → tighter inbound cap.
const limiter = createRateLimiter(60)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function retryDelayMs(headers) {
  const ra = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null
  const n = ra ? parseInt(ra, 10) : NaN
  const ms = Number.isFinite(n) && n > 0 ? n * 1000 : 1500
  return Math.min(ms, 4000)
}

// Publisher sanity checks keyed by DOI prefix. If a DOI says it's NEJM but
// OpenAlex returns a different venue (or vice versa), the metadata is stale
// or wrong — drop the venue/issn/jif so we don't report a wrong tier.
const DOI_VENUE_RULES = [
  { doi: /^10\.1056\/nejm/i,            venue: /new england|nejm/i },
  { doi: /^10\.1016\/s0140-6736/i,      venue: /lancet/i },
  { doi: /^10\.1001\/jama/i,            venue: /jama/i },
  { doi: /^10\.1038\/(nature|s41586)/i, venue: /nature/i },
  { doi: /^10\.1126\/science/i,         venue: /science/i },
]

function venueMismatchForDoi(doi, venue) {
  if (!doi) return false
  for (const rule of DOI_VENUE_RULES) {
    if (rule.doi.test(doi)) {
      if (!venue || !rule.venue.test(String(venue))) return true
      return false
    }
  }
  return false
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

// fetchOpenAlex: returns {ok:true, w} on success, {ok:false, code} on failure.
// code ∈ '404' | 'timeout' | 'aborted' | 'http_<status>' | 'http_500' | 'network'
async function fetchOpenAlex(doi) {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=id,doi,title,publication_year,cited_by_count,primary_location&mailto=${MAILTO}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const r = await fetch(url, { headers: { 'User-Agent': `paperfate/0.3 (mailto:${MAILTO})` }, signal: ctrl.signal })
      clearTimeout(timer)
      if (r.status === 429 && attempt === 0) {
        await sleep(retryDelayMs(r.headers))
        continue
      }
      if (r.status === 404) return { ok: false, code: '404' }
      if (!r.ok) return { ok: false, code: `http_${r.status}` }
      const w = await r.json()
      return { ok: true, w }
    } catch (e) {
      clearTimeout(timer)
      const code = e && e.name === 'AbortError' ? 'timeout' : 'network'
      return { ok: false, code }
    }
  }
  return { ok: false, code: 'network' }
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
  for (const [k, v] of Object.entries(guardCors(origin, 'POST, OPTIONS'))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed')

  if (blockDisallowedOrigin(req, res)) return
  if (applyRateLimit(req, res, limiter)) return

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
  let nNotFound = 0
  let nLookupErrors = 0
  let nVenueMismatch = 0
  async function worker() {
    while (cursor < dois.length) {
      const idx = cursor++
      const doi = dois[idx]
      const r = await fetchOpenAlex(doi)
      if (r.ok) {
        const shaped = shapeWork(r.w, issnIndex)
        if (shaped && venueMismatchForDoi(shaped.doi || doi, shaped.venue)) {
          nVenueMismatch++
          shaped.venue = null
          shaped.issn = null
          shaped.jif = null
          shaped.warning = 'doi_metadata_mismatch'
        }
        out[idx] = shaped
      } else {
        if (r.code === '404') nNotFound++
        else nLookupErrors++
        out[idx] = { doi, _missing: true, error_code: r.code }
      }
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
    n_not_found: nNotFound,
    n_lookup_errors: nLookupErrors,
    n_venue_mismatch: nVenueMismatch,
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
