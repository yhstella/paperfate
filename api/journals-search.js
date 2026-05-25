// PaperFate · GET /api/journals-search?q=<query>&limit=10
// In-memory fuzzy search over the 800-journal shortlist baked into deploy.
// Returns lightweight rows for use as a target-journal autocomplete.
//
// Match priority (descending):
//   1. Exact ISSN match
//   2. Title startsWith query
//   3. Title substring match
//   4. Category substring match
// Ties broken by JIF desc.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SHORTLIST_PATH = join(ROOT, 'weights', 'journals-shortlist.json')

export const config = { maxDuration: 10, runtime: 'nodejs' }

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

let _journals = null
function loadJournals() {
  if (_journals) return _journals
  if (!existsSync(SHORTLIST_PATH)) { _journals = []; return _journals }
  try {
    const data = JSON.parse(readFileSync(SHORTLIST_PATH, 'utf-8'))
    _journals = (data.journals || []).map(j => ({
      name: j.name,
      issn: j.issn || null,
      jif: Number.isFinite(+j.jif) ? +j.jif : null,
      tier: j.tier || null,
      category: j.category || null,
      publisher: j.publisher || null,
      is_oa: !!j.is_oa,
      _nameLower: String(j.name || '').toLowerCase(),
      _catLower: String(j.category || '').toLowerCase(),
    }))
  } catch { _journals = [] }
  return _journals
}

function rank(journal, qLower, qRaw) {
  // Exact ISSN match wins
  if (journal.issn && journal.issn === qRaw) return 1000
  if (!qLower) return 0
  const name = journal._nameLower
  const cat  = journal._catLower
  let score = 0
  if (name === qLower) score = 900
  else if (name.startsWith(qLower)) score = 700
  else if (name.includes(qLower)) score = 500
  else if (cat.includes(qLower)) score = 100
  // Tie-break by JIF (saturating at IF 200 → +199 max)
  if (score) score += Math.min(199, Math.round((journal.jif || 0) * 10) / 10)
  return score
}

export default function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const qRaw = String(url.searchParams.get('q') || '').trim()
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') || 10)))
  if (!qRaw || qRaw.length < 2) return res.status(200).json({ results: [] })

  const qLower = qRaw.toLowerCase()
  const journals = loadJournals()
  const scored = []
  for (const j of journals) {
    const s = rank(j, qLower, qRaw)
    if (s > 0) scored.push({ ...j, _score: s })
  }
  scored.sort((a, b) => b._score - a._score)
  const out = scored.slice(0, limit).map(j => ({
    name: j.name, issn: j.issn, jif: j.jif, tier: j.tier, category: j.category, publisher: j.publisher, is_oa: j.is_oa,
  }))
  return res.status(200).json({ results: out })
}
