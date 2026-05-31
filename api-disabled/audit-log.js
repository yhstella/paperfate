// PaperFate · GET /api/audit-log
//
// Internal-only read endpoint that returns the last N entries of the
// server-side audit log (a JSONL file on disk). The log itself is
// expected to be written by an upcoming sprint — this file only
// provides the *retrieval* contract so tooling and the admin surface
// can be wired up in advance.
//
// Production-safe by default:
//   - If PAPERFATE_AUDIT_LOG_PATH is unset, returns 503 'audit_disabled'.
//   - Otherwise requires header `x-paperfate-internal` matching
//     PAPERFATE_INTERNAL_TOKEN.
//
// Query params:
//   limit=N   (default 100, clamped to [1, 1000])
//
// Responses:
//   200 { entries: [...], n_requested, n_returned }
//   401 unauthorized
//   405 method_not_allowed
//   500 read_failed
//   503 audit_disabled

import * as fs from 'node:fs'

export const config = { maxDuration: 10, runtime: 'nodejs' }

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
// Cap the on-disk read to avoid OOM on a huge log. 8 MiB is plenty for
// the last 1000 audit lines under normal payload sizes (~1KB each).
const READ_TAIL_BYTES = 8 * 1024 * 1024

const ALLOWED_ORIGINS = (process.env.PAPERFATE_ALLOWED_ORIGINS || 'https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180')
  .split(',').map(s => s.trim())

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-paperfate-internal',
    'Vary': 'Origin',
  }
}

function bad(res, status, error, detail = undefined) {
  return res.status(status).json({ error, ...(detail !== undefined && { detail }) })
}

function parseLimit(raw) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  if (n > MAX_LIMIT) return MAX_LIMIT
  return n
}

// Read the tail of a JSONL file efficiently — open, seek to (size -
// READ_TAIL_BYTES), read forward, then split on newlines. The first
// fragment may be a partial line so we discard it whenever we didn't
// start from the file head.
function readTailLines(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const { size } = fs.fstatSync(fd)
    const start = size > maxBytes ? size - maxBytes : 0
    const length = size - start
    if (length <= 0) return { lines: [], startedAtZero: start === 0 }
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, start)
    const text = buf.toString('utf8')
    const rawLines = text.split('\n')
    // If we didn't start at byte 0, the first segment is likely a
    // truncated line — drop it so we never hand back malformed JSON.
    const lines = start === 0 ? rawLines : rawLines.slice(1)
    return { lines, startedAtZero: start === 0 }
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

function tailEntries(filePath, limit) {
  const { lines } = readTailLines(filePath, READ_TAIL_BYTES)
  const out = []
  // Walk from the end so we can stop after `limit` valid entries.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      out.push(parsed)
    } catch {
      // Skip malformed lines silently — partial writes happen.
    }
  }
  return out.reverse()
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return bad(res, 405, 'method_not_allowed')

  const logPath = process.env.PAPERFATE_AUDIT_LOG_PATH
  if (!logPath || typeof logPath !== 'string' || logPath.length === 0) {
    return bad(res, 503, 'audit_disabled')
  }

  const expected = process.env.PAPERFATE_INTERNAL_TOKEN
  const provided = req.headers['x-paperfate-internal']
  if (!expected || typeof expected !== 'string' || provided !== expected) {
    return bad(res, 401, 'unauthorized')
  }

  // Vercel surfaces query params on req.query; in plain Node we fall
  // back to URL parsing so this is portable to local harnesses too.
  let limitRaw
  if (req.query && typeof req.query === 'object') {
    limitRaw = req.query.limit
  } else {
    try {
      const u = new URL(req.url, 'http://localhost')
      limitRaw = u.searchParams.get('limit')
    } catch {
      limitRaw = undefined
    }
  }
  const n_requested = parseLimit(limitRaw)

  let entries
  try {
    if (!fs.existsSync(logPath)) {
      entries = []
    } else {
      entries = tailEntries(logPath, n_requested)
    }
  } catch (e) {
    return bad(res, 500, 'read_failed', String((e && e.message) || e))
  }

  return res.status(200).json({
    entries,
    n_requested,
    n_returned: entries.length,
  })
}
