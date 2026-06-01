// PaperFate · GET /api/journal-info?issn=... or ?name=...
//
// Returns a fact-based snapshot for a single target journal:
//   { issn, name, jif, jif_5yr, tier, category, publisher, country, is_oa,
//     is_in_doaj, apc, h_index }
//
// Backed by the 800-journal shortlist already shipped under weights/.
// Per Codex Round 5 Task 2 diagnosis (v0.3-pub target-aware path was
// trivial j_hist_jcr_jif autocorrelation), this endpoint provides a
// direct prior-year JIF lookup so the UI can render an explicit
// "if you submit to {journal}, prior-year IF was X" card without
// deploying a leak-prone target-aware model.
//
// Match priority:
//   1. ?issn= exact (case-insensitive, hyphen-tolerant)
//   2. ?name= exact (lowercase comparison)
//   3. ?name= substring (returns highest-JIF match)

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corsHeaders as guardCors, blockDisallowedOrigin, createRateLimiter, applyRateLimit } from '../src/server/apiGuard.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SHORTLIST_PATH = join(ROOT, 'weights', 'journals-shortlist.json')

export const config = { maxDuration: 10, runtime: 'nodejs' }

// Data endpoints are cheap; be generous with the per-IP cap.
const limiter = createRateLimiter(120)

let _journals = null
function loadJournals() {
  if (_journals) return _journals
  if (!existsSync(SHORTLIST_PATH)) { _journals = []; return _journals }
  try {
    const data = JSON.parse(readFileSync(SHORTLIST_PATH, 'utf-8'))
    _journals = data.journals || []
  } catch { _journals = [] }
  return _journals
}

function normalizeIssn(s) {
  return String(s || '').replace(/[^0-9xX]/gi, '').toUpperCase()
}

function shape(j) {
  return {
    name: j.name,
    issn: j.issn || null,
    jif: Number.isFinite(+j.jif) ? +j.jif : null,
    jif_5yr: Number.isFinite(+j.jif_5yr) ? +j.jif_5yr : null,
    tier: j.tier || null,
    category: j.category || null,
    quartile: j.quartile || null,
    publisher: j.publisher || null,
    country: j.country || null,
    is_oa: !!j.is_oa,
    is_in_doaj: !!j.is_in_doaj,
    apc: j.apc != null ? j.apc : null,
    h_index: j.h_index != null ? j.h_index : null,
  }
}

export default function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(guardCors(origin, 'GET, OPTIONS'))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  if (blockDisallowedOrigin(req, res)) return
  if (applyRateLimit(req, res, limiter)) return

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const issnRaw = url.searchParams.get('issn')
  const nameRaw = url.searchParams.get('name')

  const journals = loadJournals()
  let hit = null
  let match_type = null
  let match_score = 0

  if (issnRaw) {
    const want = normalizeIssn(issnRaw)
    hit = journals.find(j => normalizeIssn(j.issn) === want) || null
    if (hit) { match_type = 'exact'; match_score = 1000 }
  }
  if (!hit && nameRaw) {
    const wantLower = String(nameRaw).trim().toLowerCase()
    if (wantLower.length >= 3) {
      const exact = journals.find(j => String(j.name || '').toLowerCase() === wantLower)
      if (exact) { hit = exact; match_type = 'exact'; match_score = 1000 }
      else {
        const startsWith = journals
          .filter(j => String(j.name || '').toLowerCase().startsWith(wantLower))
          .sort((a, b) => (+(b.jif || 0)) - (+(a.jif || 0)))
        if (startsWith.length) {
          hit = startsWith[0]
          match_type = 'startsWith'
          match_score = 700
        } else if (wantLower.length >= 6) {
          const matches = journals
            .filter(j => String(j.name || '').toLowerCase().includes(wantLower))
            .sort((a, b) => (+(b.jif || 0)) - (+(a.jif || 0)))
          if (matches.length) {
            hit = matches[0]
            match_type = 'substring'
            match_score = 500
          }
        }
      }
    }
  }

  if (!hit) return res.status(404).json({ error: 'journal_not_found', query: { issn: issnRaw, name: nameRaw } })
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
  return res.status(200).json({ journal: shape(hit), match_type, match_score })
}
