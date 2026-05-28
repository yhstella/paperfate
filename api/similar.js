// PaperFate · POST /api/similar
// Returns up to 5 similar published papers for a manuscript abstract,
// using OpenAlex search + a static ISSN → JIF lookup baked into the deploy.
//
// Request body: { title: string, abstract: string }
// Response:     { similars: [{ title, venue, issn, if, year, citations, doi, openalex_id, score }] }

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SHORTLIST_PATH = join(ROOT, 'weights', 'journals-shortlist.json')

export const config = { maxDuration: 30, runtime: 'nodejs' }

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

function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function buildQuery(title, abstract) {
  const t = String(title || '').trim()
  const a = String(abstract || '').trim().split(/\s+/).slice(0, 25).join(' ')
  const q = [t, a].filter(Boolean).join(' ').slice(0, 400)
  return q
}

async function searchOpenAlex(query, mailto, limit = 10) {
  const url = new URL('https://api.openalex.org/works')
  url.searchParams.set('search', query)
  url.searchParams.set('per-page', String(limit))
  url.searchParams.set('select', 'id,doi,title,publication_year,cited_by_count,primary_location,relevance_score')
  url.searchParams.set('mailto', mailto)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': `paperfate/0.3 (mailto:${mailto})` }, signal: controller.signal })
    clearTimeout(timer)
    if (!r.ok) throw new Error(`openalex ${r.status}`)
    return await r.json()
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// Title-only search ranks landmark papers higher than reviews citing them.
// Used in parallel with the abstract-text search so we always cover the
// originating paper when the title alone is distinctive.
async function searchOpenAlexTitle(title, mailto, limit = 6) {
  const url = new URL('https://api.openalex.org/works')
  url.searchParams.set('search', String(title || '').slice(0, 200))
  url.searchParams.set('per-page', String(limit))
  url.searchParams.set('select', 'id,doi,title,publication_year,cited_by_count,primary_location,relevance_score')
  // Don't filter on citation count — newly-published landmark papers (NEJM
  // 2025/2026) haven't accumulated citations yet. OpenAlex relevance ordering
  // alone is enough to surface them when the title is distinctive.
  url.searchParams.set('sort', 'relevance_score:desc')
  url.searchParams.set('mailto', mailto)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': `paperfate/0.3 (mailto:${mailto})` }, signal: controller.signal })
    clearTimeout(timer)
    if (!r.ok) return null
    return await r.json()
  } catch { clearTimeout(timer); return null }
}

function shapeResult(work, issnIndex) {
  const loc = work.primary_location || {}
  const source = loc.source || {}
  const issnL = source.issn_l || (Array.isArray(source.issn) ? source.issn[0] : null)
  const shortlistHit = issnL ? issnIndex.get(issnL) : null
  const venue = source.display_name || shortlistHit?.name || null
  const jif = shortlistHit?.jif ?? null
  const doi = work.doi ? String(work.doi).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : null
  return {
    title: work.title || null,
    venue,
    issn: issnL,
    if: jif,
    year: work.publication_year || null,
    citations: work.cited_by_count ?? 0,
    doi,
    openalex_id: work.id || null,
    score: work.relevance_score ?? null,
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed')

  let body
  try { body = await readBody(req) } catch (e) { return bad(res, 400, 'invalid_json', String(e.message || e)) }

  const { title, abstract } = body || {}
  if (!title || typeof title !== 'string' || title.trim().length < 5)
    return bad(res, 400, 'missing_or_short_title')
  if (!abstract || typeof abstract !== 'string' || abstract.trim().length < 100)
    return bad(res, 400, 'missing_or_short_abstract')

  const issnIndex = loadIssnIndex()
  const query = buildQuery(title, abstract)
  const mailto = process.env.PAPERFATE_OPENALEX_MAILTO || 'beta@paperfate.com'

  // Parallel queries: abstract-text-broad + title-only-with-citation-filter.
  // The title query reliably surfaces landmark papers ranked above reviews
  // citing them; the abstract-text query catches papers without exact title
  // overlap. We interleave by relevance and dedup by normalised title.
  const [raw, titleHit] = await Promise.all([
    searchOpenAlex(query, mailto, 10).catch(e => { return { _error: String(e.message || e) } }),
    searchOpenAlexTitle(title, mailto, 6),
  ])
  if (raw?._error && !titleHit) {
    return bad(res, 502, 'openalex_search_failed', raw._error)
  }

  const ownTitleNorm = normalizeTitle(title)
  const seen = new Set()
  const filtered = []

  // First, drain the title-search results; these are most likely to include
  // the landmark paper itself (its venue anchors the tier blend downstream).
  for (const w of (titleHit?.results || [])) {
    const t = normalizeTitle(w.title)
    if (!t || seen.has(t) || t === ownTitleNorm) continue
    seen.add(t)
    filtered.push(w)
    if (filtered.length >= 5) break
  }
  // Then top up with abstract-search neighbours.
  for (const w of (raw?.results || [])) {
    if (filtered.length >= 5) break
    const t = normalizeTitle(w.title)
    if (!t || seen.has(t) || t === ownTitleNorm) continue
    seen.add(t)
    filtered.push(w)
  }

  const similars = filtered.map(w => shapeResult(w, issnIndex))
  return res.status(200).json({ similars, query_used: query.slice(0, 120) })
}
