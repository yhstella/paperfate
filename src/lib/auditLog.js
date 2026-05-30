// PaperFate · audit-log client-side parser
//
// Pure helper: parses a JSONL string of audit-log entries and returns
// aggregated counts by endpoint, status, and hour. No network access,
// no DOM access — safe to import from anywhere.
//
// Each input line is expected to be a JSON object roughly shaped like:
//   {
//     ts: <epoch ms>,      // when the request happened
//     path: <string>,      // request path, e.g. '/api/forecast'
//     status: <number>,    // HTTP status code, e.g. 200, 404, 503
//     ...                  // additional fields are passed through
//   }
//
// Malformed lines and lines missing required fields are skipped
// silently — partial writes are normal for an append-only JSONL.
//
// Output shape:
//   {
//     total: number,
//     parsed: number,        // lines that produced a usable record
//     skipped: number,       // lines that failed to parse or were empty
//     by_endpoint: { [path]: count },
//     by_status:   { [code]: count },
//     by_hour:     { [epoch_hour]: count }, // epoch_hour = floor(ts/3600000)
//   }

const MS_PER_HOUR = 60 * 60 * 1000

function bump(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1
}

function coerceHour(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n / MS_PER_HOUR)
}

export function parseAuditJsonl(text) {
  const out = {
    total: 0,
    parsed: 0,
    skipped: 0,
    by_endpoint: {},
    by_status: {},
    by_hour: {},
  }

  if (typeof text !== 'string' || text.length === 0) return out

  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    out.total += 1

    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      out.skipped += 1
      continue
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      out.skipped += 1
      continue
    }

    out.parsed += 1

    if (typeof rec.path === 'string' && rec.path.length > 0) {
      bump(out.by_endpoint, rec.path)
    }
    if (rec.status !== undefined && rec.status !== null) {
      const code = String(rec.status)
      bump(out.by_status, code)
    }
    const hour = coerceHour(rec.ts)
    if (hour !== null) {
      bump(out.by_hour, String(hour))
    }
  }

  return out
}

export default parseAuditJsonl
