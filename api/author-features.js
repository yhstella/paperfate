// PaperFate · POST /api/author-features
//
// Looks up h-index for each author name via OpenAlex /authors?search=<name>
// (top result, disambiguated by relevance score) and returns the
// first/last/max/median h-index that the FateCore feature vector consumes.
//
// Request body: { authors: string[] }   // ≤25 names
// Response:
//   {
//     first_author_h_index, last_author_h_index,
//     max_team_h_index, median_team_h_index,
//     team_size_with_id,
//     resolved: [{ name, matched, h_index, works_count }]
//   }
//
// Used by the Simulator to pre-fill author_features without asking the user
// to type h-index manually. Helps v0.2-prod escape its mid-tier prior for
// high-impact teams.

export const config = { maxDuration: 30, runtime: 'nodejs' }

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

const MAX_AUTHORS = 25
const PARALLEL = 5
const MAILTO = process.env.PAPERFATE_OPENALEX_MAILTO || 'beta@paperfate.com'

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

function normalizeName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

async function lookupAuthor(name) {
  const q = normalizeName(name)
  if (!q || q.length < 3) return null
  const url = `https://api.openalex.org/authors?search=${encodeURIComponent(q)}&per-page=1&mailto=${MAILTO}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': `paperfate/0.3 (mailto:${MAILTO})` }, signal: ctrl.signal })
    clearTimeout(timer)
    if (!r.ok) return null
    const json = await r.json()
    const top = json?.results?.[0]
    if (!top) return null
    const h = top.summary_stats?.h_index
    return {
      name: q,
      matched: top.display_name || null,
      h_index: Number.isFinite(+h) ? +h : null,
      works_count: top.works_count ?? null,
      openalex_id: top.id || null,
    }
  } catch { clearTimeout(timer); return null }
}

function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed')

  let body
  try { body = await readBody(req) } catch (e) { return bad(res, 400, 'invalid_json', String(e.message || e)) }

  const names = Array.isArray(body?.authors)
    ? [...new Set(body.authors.map(normalizeName).filter(Boolean))]
    : []
  if (!names.length) return bad(res, 400, 'no_authors')
  if (names.length > MAX_AUTHORS) return bad(res, 400, 'too_many_authors', `max ${MAX_AUTHORS}`)

  // Parallel-pool lookups, PARALLEL at a time, preserving input order
  const resolved = new Array(names.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < names.length) {
      const idx = cursor++
      resolved[idx] = await lookupAuthor(names[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, names.length) }, () => worker()))

  const hits = resolved.filter(r => r && Number.isFinite(r.h_index))
  const hs = hits.map(r => r.h_index)
  const firstH = resolved[0] && Number.isFinite(resolved[0].h_index) ? resolved[0].h_index : null
  const lastH = resolved.length > 1
    ? (resolved[resolved.length - 1] && Number.isFinite(resolved[resolved.length - 1].h_index)
        ? resolved[resolved.length - 1].h_index : null)
    : firstH

  return res.status(200).json({
    first_author_h_index: firstH,
    last_author_h_index: lastH,
    max_team_h_index: hs.length ? Math.max(...hs) : null,
    median_team_h_index: hs.length ? Math.round(median(hs)) : null,
    team_size_with_id: hits.length,
    resolved: resolved.map((r, i) => r ? r : { name: names[i], matched: null, h_index: null }),
  })
}
