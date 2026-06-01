// PaperFate · POST /api/journal-compare
//
// Resolves up to 5 target journals at once (by ISSN and/or name) and
// returns the same fact-based snapshot shape as /api/journal-info so the
// UI can render a side-by-side comparison card without firing N
// sequential journal-info requests.
//
// Request body:
//   {
//     issns?: string[],   // ISSNs (case-insensitive, hyphen-tolerant)
//     names?: string[],   // journal display names
//   }
//   Total `issns.length + names.length` capped at 5.
//
// Response:
//   { journals: shape[] }   // unresolved entries are omitted; never throws

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corsHeaders as guardCors, blockDisallowedOrigin, createRateLimiter, applyRateLimit } from '../src/server/apiGuard.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SHORTLIST_PATH = join(ROOT, 'weights', 'journals-shortlist.json')

export const config = { maxDuration: 10, runtime: 'nodejs' }

// Cheap in-memory shortlist resolution → a more generous cap.
const limiter = createRateLimiter(120)

function bad(res, status, error, detail = undefined) {
  return res.status(status).json({ error, ...(detail !== undefined && { detail }) })
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      if (!buf) return resolve({})
      try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

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

function resolveByIssn(journals, issnRaw) {
  const want = normalizeIssn(issnRaw)
  if (!want) return null
  return journals.find(j => normalizeIssn(j.issn) === want) || null
}

function resolveByName(journals, nameRaw) {
  const wantLower = String(nameRaw || '').trim().toLowerCase()
  if (wantLower.length < 3) return null
  const exact = journals.find(j => String(j.name || '').toLowerCase() === wantLower)
  if (exact) return exact
  const matches = journals
    .filter(j => String(j.name || '').toLowerCase().includes(wantLower))
    .sort((a, b) => (+(b.jif || 0)) - (+(a.jif || 0)))
  return matches[0] || null
}

const MAX_TARGETS = 5

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(guardCors(origin, 'POST, OPTIONS'))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed')

  if (blockDisallowedOrigin(req, res)) return
  if (applyRateLimit(req, res, limiter)) return

  let body
  try { body = await readBody(req) } catch (e) { return bad(res, 400, 'invalid_json', String(e.message || e)) }

  const issns = Array.isArray(body?.issns) ? body.issns.filter(x => typeof x === 'string' && x.trim()) : []
  const names = Array.isArray(body?.names) ? body.names.filter(x => typeof x === 'string' && x.trim()) : []
  if (issns.length === 0 && names.length === 0) {
    return bad(res, 400, 'no_targets', 'expected { issns: [...] } and/or { names: [...] }')
  }
  if (issns.length + names.length > MAX_TARGETS) {
    return bad(res, 400, 'too_many_targets', `max ${MAX_TARGETS} combined issns+names per request`)
  }

  const journals = loadJournals()
  const out = []
  const seen = new Set()

  for (const issn of issns) {
    const hit = resolveByIssn(journals, issn)
    if (!hit) continue
    const key = normalizeIssn(hit.issn) || String(hit.name || '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(shape(hit))
  }
  for (const name of names) {
    const hit = resolveByName(journals, name)
    if (!hit) continue
    const key = normalizeIssn(hit.issn) || String(hit.name || '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(shape(hit))
  }

  return res.status(200).json({ journals: out })
}
