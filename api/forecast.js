// PaperFate · POST /api/forecast
// Vercel serverless function. Receives a manuscript + (optional) article type,
// runs Q500 extraction via forecastManuscript, returns the rollup JSON.
//
// Request body:
//   {
//     title:        string,      // required
//     abstract:     string,      // required (≥200 chars)
//     methods:      string?,     // optional sections for full-text mode
//     results:      string?,
//     discussion:   string?,
//     full_text:    string?,     // concatenated full text fallback
//     authors:      string[]|string?,
//     year:         number?,
//     first_affiliation: string?,
//     author_features: {
//       first_author_h_index?: number,
//       last_author_h_index?: number,
//       max_team_h_index?: number,
//       median_team_h_index?: number,
//       team_size_with_id?: number,
//       international_collab?: 0|1
//     }?,
//     article_type: string?,     // schema.json article_types, default "*"
//     mode:         "Q100"|"Q500"|"auto"?,  // default "auto"
//   }
//
// Response:
//   200 → result of forecastManuscript() — see src/server/extract.js
//   4xx / 5xx → { error, detail }

import { forecastManuscript } from '../src/server/extract.js'
import { forecastManuscriptDeterministic } from '../src/server/deterministicExtract.js'
import { predictFromExtraction } from '../src/server/fatecoreInference.js'
import { generateSuggestions, generateJointCounterfactual } from '../src/server/suggestionEngine.js'

// Allow ~5 minutes for full Q500 runs. Vercel Pro plan needed for >60s functions;
// on hobby plan this is best-effort and may time out for large requests.
export const config = {
  maxDuration: 300,
  runtime: 'nodejs',
}

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180').split(',').map(s => s.trim())

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
  // Vercel parses JSON when content-type is application/json
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
  // Fallback: collect stream
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

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  const headers = corsHeaders(origin)
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')   return bad(res, 405, 'method_not_allowed')

  let body
  try { body = await readBody(req) } catch (e) { return bad(res, 400, 'invalid_json', String(e.message || e)) }

  const {
    title,
    abstract,
    methods,
    results,
    discussion,
    full_text,
    authors,
    year,
    first_affiliation,
    funder,
    funding,
    is_preprint,
    author_features,
    article_type = '*',
    mode = 'auto',
    target_journal,
  } = body || {}

  if (!title || typeof title !== 'string' || title.trim().length < 5)
    return bad(res, 400, 'missing_or_short_title')
  if (!abstract || typeof abstract !== 'string' || abstract.trim().length < 200)
    return bad(res, 400, 'missing_or_short_abstract', 'abstract must be ≥200 chars')

  const manuscript = {
    title: title.trim(),
    abstract: abstract.trim(),
    ...(methods    && { methods }),
    ...(results    && { results }),
    ...(discussion && { discussion }),
    ...(full_text  && { full_text }),
    ...((Array.isArray(authors) || typeof authors === 'string') && { authors }),
    ...(Number.isFinite(Number(year)) && { year: Number(year) }),
    ...(first_affiliation && { first_affiliation }),
    ...(funder && { funder }),
    ...(funding && { funding }),
    ...(typeof is_preprint === 'boolean' && { is_preprint }),
    ...(author_features && typeof author_features === 'object' && { author_features }),
  }

  const t0 = Date.now()
  try {
    const normalizedMode = mode === 'abstract' ? 'Q100' : mode === 'full' ? 'Q500' : mode
    const hasLlmKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY)
    // Prefer LLM whenever a key is present so top-tier abstracts get differentiated
    // Q-scoring; only fall back to the deterministic rule pre-pass when no key is
    // configured OR the operator explicitly forces it via PAPERFATE_EXTRACTOR.
    const explicitMode = process.env.PAPERFATE_EXTRACTOR
    const useDeterministic =
      !hasLlmKey ||
      explicitMode === 'deterministic' ||
      explicitMode === 'codex_deterministic'
    const extraction = useDeterministic
      ? forecastManuscriptDeterministic(manuscript, article_type, { mode: normalizedMode })
      : await forecastManuscript(manuscript, article_type, {
          mode: normalizedMode === 'auto' ? undefined : normalizedMode,
          concurrency: Number(process.env.PAPERFATE_CONCURRENCY) || 10,
        })
    if (extraction) extraction.extractor_used = useDeterministic ? 'deterministic' : 'llm'
    const inferenceOpts = {
      targetJournal: target_journal || {},
      authorFeatures: author_features || {},
    }
    const fatecore = predictFromExtraction(manuscript, extraction, inferenceOpts)
    const suggestions = generateSuggestions(extraction, manuscript, fatecore, inferenceOpts)
    const jointCounterfactual = generateJointCounterfactual(extraction, manuscript, fatecore, suggestions, inferenceOpts)
    const wallMs = Date.now() - t0
    return res.status(200).json({
      ...extraction,
      ...fatecore,
      counterfactual_suggestions: suggestions,
      joint_counterfactual: jointCounterfactual,
      wall_ms: wallMs,
      server_version: '0.3.1',
    })
  } catch (e) {
    return bad(res, 500, 'extraction_failed', String(e.message || e))
  }
}
