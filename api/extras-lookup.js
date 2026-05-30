// PaperFate · POST /api/extras-lookup
//
// Look up the paper_extras_v2 row for a single DOI.
//
// Request body:
//   { doi: string }                     // required, ≥4 chars
//
// Response:
//   200 → {
//     doi,
//     found: boolean,
//     features: { ...row } | null,
//     source: 'subset' | 'unavailable',
//   }
//   400 → { error: 'invalid_json' | 'missing_doi' }
//   405 → { error: 'method_not_allowed' }
//   503 → {
//     doi,
//     found: false,
//     features: null,
//     source: 'unavailable',
//     error: 'lookup_unavailable_in_production',
//   }
//
// Why a stub:
//   Vercel serverless functions cannot ship the full 80GB paperfate.db.
//   The intended deployment story is a small JSON subset of
//   recently-computed paper_extras_v2 rows exported by a separate
//   pipeline and bundled at weights/paper_extras_v2_subset.json.
//   Until that file exists, this endpoint surfaces a real contract
//   and degrades cleanly to 503 instead of erroring 500.
//
// Subset file shape (when present):
//   {
//     "version": "v2",
//     "generated_at": "2026-05-30T00:00:00Z",
//     "rows": [
//       { "doi": "10.xxxx/yyyy", "<feature>": <value>, ... },
//       ...
//     ]
//   }
//
//   ─ OR ─  a bare array of row objects (each must contain a `doi` field).
//
// Notes:
//   • CORS + readBody follow the journal-info.js / abstract-quality.js
//     pattern; no rate-limit since this is a cheap in-memory lookup.
//   • DOI match is case-insensitive and tolerates a leading
//     "https://doi.org/" or "doi:" prefix.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SUBSET_PATH = join(ROOT, 'weights', 'paper_extras_v2_subset.json')

export const config = { maxDuration: 5, runtime: 'nodejs' }

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : null
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
  if (allow) h['Access-Control-Allow-Origin'] = allow
  return h
}

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

function normalizeDoi(s) {
  if (!s || typeof s !== 'string') return ''
  let v = s.trim().toLowerCase()
  if (v.startsWith('https://doi.org/')) v = v.slice('https://doi.org/'.length)
  else if (v.startsWith('http://doi.org/')) v = v.slice('http://doi.org/'.length)
  else if (v.startsWith('doi:')) v = v.slice(4).trim()
  return v
}

// Subset cache: lazy-loaded, invalidated when the file mtime changes.
let _subsetIndex = null   // Map<normalizedDoi, row>
let _subsetMtimeMs = 0
let _subsetMissing = false

function loadSubset() {
  if (_subsetMissing && !existsSync(SUBSET_PATH)) return null
  if (!existsSync(SUBSET_PATH)) { _subsetMissing = true; _subsetIndex = null; return null }
  _subsetMissing = false
  try {
    const stat = statSync(SUBSET_PATH)
    if (_subsetIndex && stat.mtimeMs === _subsetMtimeMs) return _subsetIndex
    const raw = JSON.parse(readFileSync(SUBSET_PATH, 'utf-8'))
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : []
    const idx = new Map()
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const key = normalizeDoi(row.doi)
      if (key) idx.set(key, row)
    }
    _subsetIndex = idx
    _subsetMtimeMs = stat.mtimeMs
    return _subsetIndex
  } catch {
    _subsetIndex = null
    return null
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')   return bad(res, 405, 'method_not_allowed')

  let body
  try { body = await readBody(req) } catch (e) { return bad(res, 400, 'invalid_json', String(e.message || e)) }

  const rawDoi = body?.doi
  if (!rawDoi || typeof rawDoi !== 'string' || rawDoi.trim().length < 4)
    return bad(res, 400, 'missing_doi')

  const doi = normalizeDoi(rawDoi)
  const index = loadSubset()

  if (!index) {
    return res.status(503).json({
      doi,
      found: false,
      features: null,
      source: 'unavailable',
      error: 'lookup_unavailable_in_production',
    })
  }

  const row = index.get(doi) || null
  return res.status(200).json({
    doi,
    found: !!row,
    features: row,
    source: 'subset',
  })
}
