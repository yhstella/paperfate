// PaperFate · POST /api/abstract-quality
//
// Pure Q100 abstract-only scorer. Forces mode='Q100' regardless of caller
// hints and strips everything except the rollup the abstract surface
// actually needs (no FateCore, no suggestions, no counterfactual).
//
// Request body:
//   {
//     title:        string,   // required (≥5 chars)
//     abstract:     string,   // required (≥200 chars)
//     article_type: string?,  // schema.json article_types, default "*"
//   }
//
// Response:
//   200 → {
//     overall_score,
//     domain_rollup,
//     key_weaknesses,
//     items,
//     items_attempted,
//     items_scored,
//     elapsed_ms,
//     server_version,
//     request_id,
//   }
//   4xx / 5xx → { error, detail }

import { forecastManuscript } from '../src/server/extract.js'

export const config = { maxDuration: 60, runtime: 'nodejs' }

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
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

function newRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {}
  // Fallback: timestamp + random hex
  const rnd = Math.random().toString(16).slice(2, 10)
  return `req_${Date.now().toString(16)}_${rnd}`
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')   return bad(res, 405, 'method_not_allowed')

  let body
  try { body = await readBody(req) } catch (e) { return bad(res, 400, 'invalid_json', String(e.message || e)) }

  const { title, abstract, article_type = '*' } = body || {}

  if (!title || typeof title !== 'string' || title.trim().length < 5)
    return bad(res, 400, 'missing_or_short_title')
  if (!abstract || typeof abstract !== 'string' || abstract.trim().length < 200)
    return bad(res, 400, 'missing_or_short_abstract', 'abstract must be ≥200 chars')

  const manuscript = {
    title: title.trim(),
    abstract: abstract.trim(),
  }

  const request_id = newRequestId()
  const t0 = Date.now()
  try {
    // Paid-tier Gemini: 120 RPM, batchSize 25.
    const geminiOpts = { rpm: 120, batchSize: 25, isFreeTier: false }
    const extraction = await forecastManuscript(manuscript, article_type, {
      mode: 'Q100',
      concurrency: Number(process.env.PAPERFATE_CONCURRENCY) || 35,
      geminiOpts,
    })
    const elapsed_ms = Date.now() - t0
    return res.status(200).json({
      overall_score:    extraction?.overall_score    ?? null,
      domain_rollup:    extraction?.domain_rollup    ?? null,
      key_weaknesses:   extraction?.key_weaknesses   ?? [],
      items:            extraction?.items            ?? [],
      items_attempted:  extraction?.items_attempted  ?? null,
      items_scored:     extraction?.items_scored     ?? null,
      elapsed_ms,
      server_version: '0.3.1',
      request_id,
    })
  } catch (e) {
    return bad(res, 500, 'extraction_failed', String(e.message || e))
  }
}
