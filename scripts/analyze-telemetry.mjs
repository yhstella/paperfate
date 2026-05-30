#!/usr/bin/env node
// Parse a local Vercel log export and summarise PaperFate telemetry beacons.
//
// Usage:
//   node scripts/analyze-telemetry.mjs
//   node scripts/analyze-telemetry.mjs --file E:/paperfate/data/_vercel_telemetry.log --date 2026-05-30
//
// Input format: any text file containing lines that include '[telemetry]'
// followed by a JSON object describing the event, e.g.
//   2026-05-30T12:00:01.123Z  GET 200 /  [telemetry] {"name":"sim_forecast_result_ok","props":{"wall_ms":482,"degraded":false},"ts":"...","url":"https://paperfate.com/simulator"}
//
// Output:
//   - Aligned plain-text summary tables to stdout.
//   - JSON summary written to E:/paperfate/data/_telemetry_summary_<date>.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------- CLI args ----------

const DEFAULT_FILE = 'E:/paperfate/data/_vercel_telemetry.log'
const DEFAULT_DATE = '2026-05-30'

function parseArgs(argv) {
  const out = { file: DEFAULT_FILE, date: DEFAULT_DATE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file' && argv[i + 1]) {
      out.file = argv[++i]
    } else if (a.startsWith('--file=')) {
      out.file = a.slice('--file='.length)
    } else if (a === '--date' && argv[i + 1]) {
      out.date = argv[++i]
    } else if (a.startsWith('--date=')) {
      out.date = a.slice('--date='.length)
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/analyze-telemetry.mjs [--file PATH] [--date YYYY-MM-DD]')
      process.exit(0)
    }
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))

if (!existsSync(ARGS.file)) {
  console.error(
    `No telemetry log found at ${ARGS.file}. ` +
      `Use vercel logs <deploy_url> > ${ARGS.file} first.`,
  )
  process.exit(1)
}

// ---------- Parse ----------

const TAG = '[telemetry]'

function extractJsonAfterTag(line) {
  const idx = line.indexOf(TAG)
  if (idx === -1) return null
  const rest = line.slice(idx + TAG.length)
  const start = rest.indexOf('{')
  if (start === -1) return null
  // Walk braces respecting strings so we tolerate trailing text after the JSON.
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i]
    if (inStr) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inStr = false
      }
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const raw = rest.slice(start, i + 1)
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function userAgentFingerprint(ua) {
  if (!ua || typeof ua !== 'string') return 'unknown-ua'
  // Cheap, stable bucket: collapse to lowercased browser/os family tokens.
  const lower = ua.toLowerCase()
  const tokens = []
  for (const family of ['chrome', 'firefox', 'safari', 'edg', 'opera', 'crios', 'fxios']) {
    if (lower.includes(family)) {
      tokens.push(family)
      break
    }
  }
  for (const os of ['windows', 'macintosh', 'mac os', 'linux', 'android', 'iphone', 'ipad']) {
    if (lower.includes(os)) {
      tokens.push(os.replace(' ', ''))
      break
    }
  }
  return tokens.length ? tokens.join('-') : 'other-ua'
}

const raw = readFileSync(ARGS.file, 'utf8')
const lines = raw.split(/\r?\n/)

let totalLines = 0
let parsedEvents = 0
let skippedTelemetryLines = 0

const events = []
for (const line of lines) {
  if (!line) continue
  totalLines++
  if (!line.includes(TAG)) continue
  const ev = extractJsonAfterTag(line)
  if (!ev || typeof ev !== 'object') {
    skippedTelemetryLines++
    continue
  }
  if (!ev.name || typeof ev.name !== 'string') {
    skippedTelemetryLines++
    continue
  }
  parsedEvents++
  events.push(ev)
}

// ---------- Aggregate ----------

const eventCounts = Object.create(null)
const forecastRuns = { count: 0, wall_ms_sum: 0, wall_ms_samples: [], degraded: 0, extractors: {} }
const quickRuns = { count: 0, wall_ms_sum: 0, wall_ms_samples: [], degraded: 0, extractors: {} }
const compareRuns = { count: 0, wall_ms_sum: 0, wall_ms_samples: [] }
const errorSummary = Object.create(null) // event_name -> { count, http_or_code: {code -> count} }
const byLocale = Object.create(null)
const sessionKeys = new Set()

function getProp(props, key) {
  if (!props || typeof props !== 'object') return undefined
  return props[key]
}

function bumpExtractor(bucket, value) {
  const key = value == null ? 'unknown' : String(value)
  bucket[key] = (bucket[key] || 0) + 1
}

function recordRun(bucket, props) {
  bucket.count++
  const wall = Number(getProp(props, 'wall_ms'))
  if (Number.isFinite(wall)) {
    bucket.wall_ms_sum += wall
    bucket.wall_ms_samples.push(wall)
  }
  if (getProp(props, 'degraded') === true || getProp(props, 'degraded') === 'true') {
    bucket.degraded++
  }
  if ('extractor_used' in (props || {})) {
    bumpExtractor(bucket.extractors, getProp(props, 'extractor_used'))
  }
}

function recordError(name, props) {
  const slot = errorSummary[name] || { count: 0, http_or_code: Object.create(null) }
  slot.count++
  const code = getProp(props, 'http_or_code') ?? getProp(props, 'http') ?? getProp(props, 'code')
  const key = code == null ? 'unknown' : String(code)
  slot.http_or_code[key] = (slot.http_or_code[key] || 0) + 1
  errorSummary[name] = slot
}

for (const ev of events) {
  const name = ev.name
  eventCounts[name] = (eventCounts[name] || 0) + 1

  const props = (ev.props && typeof ev.props === 'object') ? ev.props : {}

  if (name === 'sim_forecast_result_ok') {
    recordRun(forecastRuns, props)
  } else if (name === 'sim_quick_result_ok') {
    recordRun(quickRuns, props)
  } else if (name === 'compare_result_ok') {
    compareRuns.count++
    const wall = Number(getProp(props, 'wall_ms'))
    if (Number.isFinite(wall)) {
      compareRuns.wall_ms_sum += wall
      compareRuns.wall_ms_samples.push(wall)
    }
  } else if (/^sim_.*_result_error$/.test(name)) {
    recordError(name, props)
  }

  const locale = getProp(props, 'locale') ?? getProp(ev, 'locale')
  if (locale != null) {
    const key = String(locale)
    byLocale[key] = (byLocale[key] || 0) + 1
  }

  // Approximate session = (url path) + (UA fingerprint) + (date bucket).
  const url = ev.url || getProp(props, 'url') || ''
  const ua = getProp(props, 'ua') ?? getProp(props, 'user_agent') ?? ev.ua ?? ''
  const ts = ev.ts || getProp(props, 'ts') || ''
  const day = typeof ts === 'string' ? ts.slice(0, 10) : ''
  sessionKeys.add(`${url}|${userAgentFingerprint(ua)}|${day}`)
}

function summariseRun(bucket) {
  const mean = bucket.count
    ? +(bucket.wall_ms_sum / Math.max(1, bucket.wall_ms_samples.length)).toFixed(1)
    : null
  return {
    count: bucket.count,
    mean_wall_ms: mean,
    degraded_count: bucket.degraded,
    degraded_fraction: bucket.count ? +(bucket.degraded / bucket.count).toFixed(4) : 0,
    extractor_used: bucket.extractors,
  }
}

function summariseCompare(bucket) {
  const mean = bucket.wall_ms_samples.length
    ? +(bucket.wall_ms_sum / bucket.wall_ms_samples.length).toFixed(1)
    : null
  return { count: bucket.count, mean_wall_ms: mean }
}

const summary = {
  generated_at: new Date().toISOString(),
  date: ARGS.date,
  source_file: ARGS.file,
  totals: {
    lines_scanned: totalLines,
    telemetry_lines_skipped: skippedTelemetryLines,
    events_parsed: parsedEvents,
    unique_events: Object.keys(eventCounts).length,
    approx_sessions: sessionKeys.size,
  },
  event_counts: eventCounts,
  forecast_runs: summariseRun(forecastRuns),
  quick_runs: summariseRun(quickRuns),
  compare_runs: summariseCompare(compareRuns),
  error_summary: errorSummary,
  by_locale: byLocale,
}

// ---------- Render ----------

function pad(str, width) {
  const s = String(str)
  if (s.length >= width) return s
  return s + ' '.repeat(width - s.length)
}

function padLeft(str, width) {
  const s = String(str)
  if (s.length >= width) return s
  return ' '.repeat(width - s.length) + s
}

function renderTable(rows) {
  if (!rows.length) return '  (none)'
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)))
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === 0 ? pad(cell, widths[i]) : padLeft(cell, widths[i])))
        .join('  '),
    )
    .join('\n')
}

const out = []
out.push('PaperFate telemetry summary')
out.push('='.repeat(60))
out.push(`source           : ${ARGS.file}`)
out.push(`date label       : ${ARGS.date}`)
out.push(`generated_at     : ${summary.generated_at}`)
out.push('')
out.push('Totals')
out.push('-'.repeat(60))
out.push(
  renderTable([
    ['lines_scanned', String(summary.totals.lines_scanned)],
    ['events_parsed', String(summary.totals.events_parsed)],
    ['telemetry_lines_skipped', String(summary.totals.telemetry_lines_skipped)],
    ['unique_events', String(summary.totals.unique_events)],
    ['approx_sessions', String(summary.totals.approx_sessions)],
  ]),
)

out.push('')
out.push('Event counts')
out.push('-'.repeat(60))
const eventRows = Object.entries(eventCounts).sort((a, b) => b[1] - a[1])
out.push(renderTable(eventRows.length ? eventRows.map(([k, v]) => [k, String(v)]) : [['(no events)', '']]))

function renderRun(label, run) {
  out.push('')
  out.push(label)
  out.push('-'.repeat(60))
  if (!run.count) {
    out.push('  (no events)')
    return
  }
  out.push(
    renderTable([
      ['count', String(run.count)],
      ['mean_wall_ms', String(run.mean_wall_ms ?? 'n/a')],
      ['degraded_count', String(run.degraded_count)],
      ['degraded_fraction', String(run.degraded_fraction)],
    ]),
  )
  const ext = Object.entries(run.extractor_used || {}).sort((a, b) => b[1] - a[1])
  if (ext.length) {
    out.push('  extractor_used:')
    out.push(
      ext
        .map(([k, v]) => `    ${pad(k, 24)}  ${padLeft(String(v), 6)}`)
        .join('\n'),
    )
  }
}

renderRun('Forecast runs (sim_forecast_result_ok)', summary.forecast_runs)
renderRun('Quick runs (sim_quick_result_ok)', summary.quick_runs)

out.push('')
out.push('Compare runs (compare_result_ok)')
out.push('-'.repeat(60))
if (summary.compare_runs.count) {
  out.push(
    renderTable([
      ['count', String(summary.compare_runs.count)],
      ['mean_wall_ms', String(summary.compare_runs.mean_wall_ms ?? 'n/a')],
    ]),
  )
} else {
  out.push('  (no events)')
}

out.push('')
out.push('Error summary (sim_*_result_error)')
out.push('-'.repeat(60))
const errorNames = Object.keys(errorSummary)
if (errorNames.length) {
  for (const name of errorNames) {
    const slot = errorSummary[name]
    out.push(`  ${name}  (count=${slot.count})`)
    const codeRows = Object.entries(slot.http_or_code).sort((a, b) => b[1] - a[1])
    if (codeRows.length) {
      out.push(
        codeRows
          .map(([code, n]) => `    ${pad(code, 16)}  ${padLeft(String(n), 6)}`)
          .join('\n'),
      )
    } else {
      out.push('    (no http_or_code values)')
    }
  }
} else {
  out.push('  (no errors)')
}

out.push('')
out.push('By locale')
out.push('-'.repeat(60))
const localeRows = Object.entries(byLocale).sort((a, b) => b[1] - a[1])
out.push(
  renderTable(localeRows.length ? localeRows.map(([k, v]) => [k, String(v)]) : [['(no locale prop)', '']]),
)

out.push('')
out.push('Approx sessions: ' + summary.totals.approx_sessions)

console.log(out.join('\n'))

// ---------- Write JSON summary ----------

const outPath = `E:/paperfate/data/_telemetry_summary_${ARGS.date}.json`
try {
  const outDir = dirname(outPath)
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true })
  }
  writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8')
  console.log('')
  console.log(`Wrote ${outPath}`)
} catch (err) {
  console.error(`Failed to write summary JSON to ${outPath}: ${err && err.message ? err.message : err}`)
  process.exitCode = 2
}
