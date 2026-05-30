// PaperFate · GET /api/status
//
// Tiny public status endpoint. Reports server version, deploy commit,
// and the list of public endpoints. Stateless — no per-process uptime
// counter is meaningful on Vercel serverless, so we return a sentinel
// string for runtime_seconds_uptime_estimate instead of pretending.
//
// Response (200):
//   {
//     ok: true,
//     server_version: '0.4.0',
//     deploy_time: <commit-sha7 or 'local'>,
//     endpoints: [ ... ],
//     runtime_seconds_uptime_estimate: 'unavailable (stateless)',
//   }

export const config = { maxDuration: 5, runtime: 'nodejs' }

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

// Kept inline per the worker brief (no shared module). Status doesn't
// actually need to parse a body, but we mirror the readBody pattern so
// the file is symmetrical with the rest of /api/* and future-proof in
// case the endpoint grows a POST variant.
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
// touch so esbuild doesn't drop the import-less helper if tree-shaken
void readBody

export default function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  const deploy_time = (sha && typeof sha === 'string' && sha.length >= 7)
    ? sha.slice(0, 7)
    : 'local'

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({
    ok: true,
    server_version: '0.4.0',
    deploy_time,
    endpoints: [
      'forecast',
      'similar',
      'journal-info',
      'journals-search',
      'references',
      'author-features',
      'journal-compare',
      'abstract-quality',
    ],
    runtime_seconds_uptime_estimate: 'unavailable (stateless)',
  })
}
