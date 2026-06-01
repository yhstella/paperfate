#!/usr/bin/env node
// PaperFate · extended deploy health check
//
// Goes beyond smoke-production-v2 by asserting:
//   1. Security headers from vercel.json (Round 6)
//   2. CDN Cache-Control on /api/journal-info (Round 4 W-F)
//   3. Rate-limit + request-id headers on /api/forecast (Round 8 W-III)
//   4. SEO markup in index.html (Round 6 W-V + Round 8 W-V)
//   5. PWA assets: manifest.webmanifest, sw.js, offline.html, og-default.svg
//   6. Reachability of every public endpoint (graceful 503 OK; 404 / 500 NOT OK)
//
// Degraded mode (Gemini key invalid / extractor=rule_fallback) is AMBER, not red.
//
// CLI:
//   node scripts/health-check.mjs
//   node scripts/health-check.mjs --base-url https://staging.example.com
//   node scripts/health-check.mjs --skip-pwa
//   node scripts/health-check.mjs --json
//
// Env:
//   BASE_URL overrides --base-url.
//
// Exit code: 0 if no RED; 1 otherwise.

const DEFAULT_BASE = 'https://paperfate.com'

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { baseUrl: DEFAULT_BASE, skipPwa: false, json: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base-url' && argv[i + 1]) { out.baseUrl = argv[++i]; continue }
    if (a.startsWith('--base-url=')) { out.baseUrl = a.slice('--base-url='.length); continue }
    if (a === '--skip-pwa') { out.skipPwa = true; continue }
    if (a === '--json') { out.json = true; continue }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/health-check.mjs [--base-url URL] [--skip-pwa] [--json]')
      process.exit(0)
    }
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '')
  return out
}

const ARGS = parseArgs(process.argv)
const BASE = (process.env.BASE_URL || ARGS.baseUrl).replace(/\/+$/, '')

// ─── HTTP helpers ───────────────────────────────────────────────────────────
async function httpFetch(method, path, { body, accept } = {}) {
  const t0 = Date.now()
  const url = `${BASE}${path}`
  const init = {
    method,
    headers: { 'Accept': accept || 'application/json,text/html,*/*' },
    redirect: 'follow',
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res, text, networkError = null
  try {
    res = await fetch(url, init)
    text = await res.text()
  } catch (e) {
    networkError = e
  }
  const ms = Date.now() - t0
  const headers = {}
  if (res) {
    for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v
  }
  let json = null
  if (text) {
    try { json = JSON.parse(text) } catch { /* leave null */ }
  }
  return {
    status: res?.status ?? 0,
    headers,
    json,
    text: text ?? '',
    ms,
    networkError,
  }
}

// ─── Results table ──────────────────────────────────────────────────────────
const ROWS = []  // { phase, check, status, detail }

function record(phase, check, status, detail = '') {
  ROWS.push({ phase, check, status, detail })
}

const GREEN = 'GREEN'
const AMBER = 'AMBER'
const RED   = 'RED'

// ─── Sample payload ─────────────────────────────────────────────────────────
const SAMPLE_TITLE = 'Empagliflozin, Cardiovascular Outcomes, and Mortality in Type 2 Diabetes'
const SAMPLE_ABSTRACT =
  'The effects of empagliflozin, an inhibitor of sodium-glucose cotransporter 2, in addition to standard care, ' +
  'on cardiovascular morbidity and mortality in patients with type 2 diabetes at high cardiovascular risk are not known. ' +
  'We randomly assigned 7020 patients to receive 10 mg or 25 mg of empagliflozin or placebo once daily.'

// ─── Phase 1: Security headers ──────────────────────────────────────────────
const REQUIRED_SECURITY_HEADERS = [
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'content-security-policy',
]

async function phaseSecurityHeaders() {
  const r = await httpFetch('GET', '/', { accept: 'text/html' })
  if (r.networkError) {
    record('1. Security', 'GET /', RED, `network: ${r.networkError.message}`)
    return
  }
  if (r.status !== 200) {
    record('1. Security', 'GET /', RED, `HTTP ${r.status}`)
    return
  }
  for (const h of REQUIRED_SECURITY_HEADERS) {
    const v = r.headers[h]
    if (!v) {
      record('1. Security', h, RED, 'missing')
    } else {
      record('1. Security', h, GREEN, truncate(v, 80))
    }
  }
}

// ─── Phase 2: Caching headers ───────────────────────────────────────────────
async function phaseCaching() {
  const path = '/api/journal-info?issn=0028-4793'
  const r = await httpFetch('GET', path)
  if (r.networkError) {
    record('2. Caching', `GET ${path}`, RED, `network: ${r.networkError.message}`)
    return
  }
  if (r.status !== 200) {
    record('2. Caching', `GET ${path}`, RED, `HTTP ${r.status}`)
    return
  }
  const cc = r.headers['cache-control'] || ''
  if (!cc) {
    record('2. Caching', 'Cache-Control', RED, 'missing')
  } else if (!/s-maxage/i.test(cc)) {
    record('2. Caching', 'Cache-Control', RED, `no s-maxage: ${truncate(cc, 80)}`)
  } else {
    record('2. Caching', 'Cache-Control', GREEN, truncate(cc, 80))
  }
}

// ─── Phase 3: Rate-limit headers ────────────────────────────────────────────
const REQUIRED_RATELIMIT_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
]

async function phaseRateLimitHeaders() {
  const path = '/api/forecast'
  // Tiny test — Q100 with minimal payload. Even a 4xx will carry the rate-limit
  // headers; only a network error or 5xx without them is a real fail.
  const r = await httpFetch('POST', path, {
    body: { title: SAMPLE_TITLE, abstract: SAMPLE_ABSTRACT, mode: 'Q100' },
  })
  if (r.networkError) {
    record('3. RateLimit', `POST ${path}`, RED, `network: ${r.networkError.message}`)
    return
  }
  // 200, 4xx (rate-limited / bad request), or graceful 503 all are acceptable
  // as long as the headers are emitted. Treat 5xx (other than 503) as red.
  if (r.status >= 500 && r.status !== 503) {
    record('3. RateLimit', `POST ${path}`, RED, `HTTP ${r.status}`)
    // still check headers below — they may be emitted
  }
  for (const h of REQUIRED_RATELIMIT_HEADERS) {
    const v = r.headers[h]
    if (!v) {
      record('3. RateLimit', h, RED, 'missing')
    } else {
      record('3. RateLimit', h, GREEN, truncate(v, 80))
    }
  }
}

// ─── Phase 4: SEO markup ────────────────────────────────────────────────────
async function phaseSeoMarkup() {
  const r = await httpFetch('GET', '/', { accept: 'text/html' })
  if (r.networkError) {
    record('4. SEO', 'GET /', RED, `network: ${r.networkError.message}`)
    return
  }
  if (r.status !== 200) {
    record('4. SEO', 'GET /', RED, `HTTP ${r.status}`)
    return
  }
  const html = r.text

  // <title>
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!titleM || !titleM[1].trim()) {
    record('4. SEO', '<title>', RED, 'missing or empty')
  } else {
    record('4. SEO', '<title>', GREEN, truncate(titleM[1].trim(), 60))
  }

  // <meta name="description">
  const descM = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)
  if (!descM) {
    record('4. SEO', 'meta description', RED, 'missing')
  } else {
    record('4. SEO', 'meta description', GREEN, truncate(descM[1], 60))
  }

  // og:title
  const ogM = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i)
  if (!ogM) {
    record('4. SEO', 'og:title', RED, 'missing')
  } else {
    record('4. SEO', 'og:title', GREEN, truncate(ogM[1], 60))
  }

  // canonical
  const canM = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i)
    || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i)
  if (!canM) {
    record('4. SEO', 'canonical', RED, 'missing')
  } else {
    record('4. SEO', 'canonical', GREEN, truncate(canM[1], 60))
  }

  // JSON-LD with @type SoftwareApplication
  // Find all application/ld+json scripts and check for SoftwareApplication.
  let foundSoftwareApp = false
  let ldDetail = ''
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = ldRe.exec(html)) !== null) {
    const body = m[1].trim()
    try {
      const obj = JSON.parse(body)
      const found = scanForType(obj, 'SoftwareApplication')
      if (found) { foundSoftwareApp = true; ldDetail = '@type=SoftwareApplication'; break }
    } catch {
      // tolerate malformed by also doing a text-scan fallback
      if (/"@type"\s*:\s*"SoftwareApplication"/.test(body)) {
        foundSoftwareApp = true; ldDetail = '@type=SoftwareApplication (text-match)'; break
      }
    }
  }
  if (!foundSoftwareApp) {
    record('4. SEO', 'JSON-LD SoftwareApplication', RED, 'missing')
  } else {
    record('4. SEO', 'JSON-LD SoftwareApplication', GREEN, ldDetail)
  }
}

function scanForType(node, wanted) {
  if (!node) return false
  if (Array.isArray(node)) return node.some(n => scanForType(n, wanted))
  if (typeof node !== 'object') return false
  const t = node['@type']
  if (typeof t === 'string' && t === wanted) return true
  if (Array.isArray(t) && t.includes(wanted)) return true
  for (const k of Object.keys(node)) {
    if (k === '@type') continue
    if (scanForType(node[k], wanted)) return true
  }
  return false
}

// ─── Phase 5: PWA assets ────────────────────────────────────────────────────
async function phasePwaAssets() {
  if (ARGS.skipPwa) {
    record('5. PWA', 'skipped', AMBER, '--skip-pwa')
    return
  }

  // manifest.webmanifest
  {
    const r = await httpFetch('GET', '/manifest.webmanifest', { accept: 'application/manifest+json' })
    if (r.networkError) {
      record('5. PWA', '/manifest.webmanifest', RED, `network: ${r.networkError.message}`)
    } else if (r.status !== 200) {
      record('5. PWA', '/manifest.webmanifest', RED, `HTTP ${r.status}`)
    } else {
      let parsed = null
      try { parsed = JSON.parse(r.text) } catch { /* */ }
      if (!parsed) {
        record('5. PWA', '/manifest.webmanifest', RED, 'invalid JSON')
      } else if (parsed.name !== 'PaperFate') {
        record('5. PWA', '/manifest.webmanifest', RED, `name=${parsed.name}`)
      } else {
        record('5. PWA', '/manifest.webmanifest', GREEN, `name=PaperFate`)
      }
    }
  }

  // sw.js
  {
    const r = await httpFetch('GET', '/sw.js', { accept: 'application/javascript' })
    if (r.networkError) {
      record('5. PWA', '/sw.js', RED, `network: ${r.networkError.message}`)
    } else if (r.status !== 200) {
      record('5. PWA', '/sw.js', RED, `HTTP ${r.status}`)
    } else {
      record('5. PWA', '/sw.js', GREEN, `${r.text.length} bytes`)
    }
  }

  // offline.html
  {
    const r = await httpFetch('GET', '/offline.html', { accept: 'text/html' })
    if (r.networkError) {
      record('5. PWA', '/offline.html', RED, `network: ${r.networkError.message}`)
    } else if (r.status !== 200) {
      record('5. PWA', '/offline.html', RED, `HTTP ${r.status}`)
    } else {
      record('5. PWA', '/offline.html', GREEN, `${r.text.length} bytes`)
    }
  }

  // og-default.svg
  {
    const r = await httpFetch('GET', '/og-default.svg', { accept: 'image/svg+xml' })
    if (r.networkError) {
      record('5. PWA', '/og-default.svg', RED, `network: ${r.networkError.message}`)
    } else if (r.status !== 200) {
      record('5. PWA', '/og-default.svg', RED, `HTTP ${r.status}`)
    } else {
      record('5. PWA', '/og-default.svg', GREEN, `${r.text.length} bytes`)
    }
  }
}

// ─── Phase 6: Endpoint reachability ─────────────────────────────────────────
// Endpoints intentionally moved to api-disabled/ to stay under the Vercel
// function-count limit. A 404 on these is EXPECTED — treat as AMBER
// ('disabled'), not RED. Matches smoke-production-v2.mjs. Compared against
// the leading path segment after /api/ so query strings don't matter.
const DISABLED_ENDPOINTS = new Set([
  'extras-lookup',
  'status-stream',
  'webhook-receive',
  'audit-log',
  'push-subscribe',
  'feedback',
])

function endpointName(path) {
  // '/api/extras-lookup?x=1' -> 'extras-lookup'
  return path.replace(/^\/api\//, '').split(/[?/]/)[0]
}

const ENDPOINTS = [
  { method: 'POST', path: '/api/forecast', body: { title: SAMPLE_TITLE, abstract: SAMPLE_ABSTRACT, mode: 'Q100' } },
  { method: 'POST', path: '/api/similar', body: { title: SAMPLE_TITLE, abstract: SAMPLE_ABSTRACT } },
  { method: 'GET',  path: '/api/journal-info?issn=0028-4793' },
  { method: 'GET',  path: '/api/journals-search?q=lancet&limit=5' },
  { method: 'POST', path: '/api/references', body: { dois: ['10.1056/NEJMoa1504720'] } },
  { method: 'POST', path: '/api/author-features', body: { authors: ['Bernard Zinman'] } },
  { method: 'POST', path: '/api/journal-compare', body: { names: ['New England Journal of Medicine', 'The Lancet'] } },
  { method: 'POST', path: '/api/abstract-quality', body: { title: SAMPLE_TITLE, abstract: SAMPLE_ABSTRACT, article_type: '*' } },
  { method: 'GET',  path: '/api/status' },
  { method: 'POST', path: '/api/extras-lookup', body: { doi: '10.1056/NEJMoa1504720' } },
  { method: 'POST', path: '/api/telemetry-beacon', body: { name: 'health_check', props: { from: 'health-check' } } },
]

async function phaseReachability() {
  for (const ep of ENDPOINTS) {
    const r = await httpFetch(ep.method, ep.path, { body: ep.body })
    const label = `${ep.method} ${ep.path.split('?')[0]}`
    if (r.networkError) {
      record('6. Endpoints', label, RED, `network: ${r.networkError.message}`)
      continue
    }
    // Acceptable: 200, 204, 503 (graceful)
    if (r.status === 200 || r.status === 204) {
      // Detect degraded mode from forecast / abstract-quality bodies
      const degraded = r.json?.extractor_used === 'rule_fallback'
        || r.json?.llm_health?.status === 'degraded'
      if (degraded) {
        record('6. Endpoints', label, AMBER, `${r.status} degraded`)
      } else {
        record('6. Endpoints', label, GREEN, `${r.status} ${r.ms}ms`)
      }
    } else if (r.status === 503) {
      // graceful unavailable — amber
      record('6. Endpoints', label, AMBER, `${r.status} (graceful)`)
    } else if (r.status === 404 && DISABLED_ENDPOINTS.has(endpointName(ep.path))) {
      // Intentionally retired to api-disabled/ — amber, not red.
      record('6. Endpoints', label, AMBER, `${r.status} disabled (api-disabled/)`)
    } else {
      // 404 (unexpected) or 500 etc — red
      record('6. Endpoints', label, RED, `HTTP ${r.status}`)
    }
  }
}

// ─── Output ─────────────────────────────────────────────────────────────────
function truncate(s, n) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function pad(s, w) {
  s = String(s ?? '')
  return s.length >= w ? s : s + ' '.repeat(w - s.length)
}

function printTable() {
  const cols = [
    { k: 'phase',  w: 14 },
    { k: 'check',  w: 38 },
    { k: 'status', w: 6 },
    { k: 'detail', w: 60 },
  ]
  console.log()
  console.log(cols.map(c => pad(c.k, c.w)).join(' | '))
  console.log(cols.map(c => '-'.repeat(c.w)).join('-+-'))
  let lastPhase = ''
  for (const row of ROWS) {
    const phase = row.phase === lastPhase ? '' : row.phase
    lastPhase = row.phase
    console.log([
      pad(phase, cols[0].w),
      pad(truncate(row.check, cols[1].w), cols[1].w),
      pad(row.status, cols[2].w),
      pad(truncate(row.detail, cols[3].w), cols[3].w),
    ].join(' | '))
  }
}

function printJson() {
  const summary = {
    base_url: BASE,
    skip_pwa: ARGS.skipPwa,
    counts: {
      green: ROWS.filter(r => r.status === GREEN).length,
      amber: ROWS.filter(r => r.status === AMBER).length,
      red:   ROWS.filter(r => r.status === RED).length,
    },
    rows: ROWS,
  }
  console.log(JSON.stringify(summary, null, 2))
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!ARGS.json) {
    console.log(`[health-check] base=${BASE}  skip_pwa=${ARGS.skipPwa}`)
  }

  await phaseSecurityHeaders()
  await phaseCaching()
  await phaseRateLimitHeaders()
  await phaseSeoMarkup()
  await phasePwaAssets()
  await phaseReachability()

  if (ARGS.json) {
    printJson()
  } else {
    printTable()
    const green = ROWS.filter(r => r.status === GREEN).length
    const amber = ROWS.filter(r => r.status === AMBER).length
    const red   = ROWS.filter(r => r.status === RED).length
    console.log()
    console.log(`Summary: ${green} GREEN, ${amber} AMBER, ${red} RED`)
  }

  const failed = ROWS.filter(r => r.status === RED).length
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[health-check] fatal:', err)
  process.exit(1)
})
