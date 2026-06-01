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
import { corsHeaders as guardCors, blockDisallowedOrigin, createRateLimiter, applyRateLimit } from '../src/server/apiGuard.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SHORTLIST_PATH = join(ROOT, 'weights', 'journals-shortlist.json')

export const config = { maxDuration: 10, runtime: 'nodejs' }

// Cheap in-memory shortlist search → generous inbound cap.
const limiter = createRateLimiter(120)

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
  for (const [k, v] of Object.entries(guardCors(origin, 'GET, OPTIONS'))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  if (blockDisallowedOrigin(req, res)) return
  if (applyRateLimit(req, res, limiter)) return

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const qRaw = String(url.searchParams.get('q') || '').trim()
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') || 10)))
  const tierFilter = String(url.searchParams.get('tier') || '').trim().toUpperCase()
  if (!qRaw || qRaw.length < 2) {
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
    return res.status(200).json({ results: [] })
  }

  const qLower = qRaw.toLowerCase()
  const journals = loadJournals()
  const scored = []
  for (const j of journals) {
    if (tierFilter && String(j.tier || '').toUpperCase() !== tierFilter) continue
    const s = rank(j, qLower, qRaw)
    if (s > 0) scored.push({ ...j, _score: s })
  }
  scored.sort((a, b) => b._score - a._score)

  // Tier blending: take top 7 by raw score, then reserve up to 3 slots for
  // Q2/Q3 journals (above the min top-7 score) so users see realistic mid-tier
  // targets alongside flagship matches.
  let chosen
  if (tierFilter || scored.length <= limit) {
    chosen = scored.slice(0, limit)
  } else {
    const top = scored.slice(0, Math.min(7, limit))
    const seen = new Set(top.map(j => j.issn || j.name))
    const minScore = top.length ? top[top.length - 1]._score : 0
    const midSlots = Math.max(0, limit - top.length)
    const mid = []
    for (const j of scored) {
      if (mid.length >= midSlots) break
      const key = j.issn || j.name
      if (seen.has(key)) continue
      const q = String(j.tier || '').toUpperCase()
      if ((q === 'Q2' || q === 'Q3') && j._score >= minScore) {
        mid.push(j)
        seen.add(key)
      }
    }
    chosen = [...top, ...mid]
    // Fill remainder with next-highest unseen by score if mid pool ran short.
    if (chosen.length < limit) {
      for (const j of scored) {
        if (chosen.length >= limit) break
        const key = j.issn || j.name
        if (seen.has(key)) continue
        chosen.push(j)
        seen.add(key)
      }
    }
  }

  const out = chosen.map(j => ({
    name: j.name, issn: j.issn, jif: j.jif, tier: j.tier, category: j.category, publisher: j.publisher, is_oa: j.is_oa,
  }))
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
  return res.status(200).json({ results: out })
}
