#!/usr/bin/env node
/**
 * bundle-analyze.mjs
 *
 * After `vite build`, generate a per-chunk breakdown showing what modules
 * contribute to each chunk's size.
 *
 * For every dist/assets/*.js, this script:
 *   - reports raw + gzip size
 *   - if a sibling .js.map exists, parses the source-map's `sources[]`
 *     array and ranks them by character-count occurrences inside the
 *     chunk's source body (heuristic — bundlers reference each source
 *     path inside the comment-prefixed source-map references and module
 *     wrappers, so frequency loosely tracks contribution)
 *   - flags chunks that exceed the bundle-budget thresholds (mirrors
 *     scripts/check-bundle-budget.mjs so the two reports agree)
 *
 * Usage:
 *   node scripts/bundle-analyze.mjs [--dist dist] \
 *     [--main-raw 400] [--main-gz 120] \
 *     [--vendor-raw 300] [--vendor-gz 95] \
 *     [--async-raw 80]  [--async-gz 28] \
 *     [--css-raw 60] \
 *     [--top 10]
 *
 * No new dependencies — only node:fs, node:path, node:zlib.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const nxt = argv[i + 1]
    if (nxt && !nxt.startsWith('--')) { out[key] = nxt; i++ }
    else out[key] = true
  }
  return out
}

const args = parseArgs(process.argv)

const KB = 1024
const num = (v, fallback) => {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const BUDGETS = {
  main:   { raw: num(args['main-raw'],   400) * KB, gz: num(args['main-gz'],   120) * KB },
  vendor: { raw: num(args['vendor-raw'], 300) * KB, gz: num(args['vendor-gz'],  95) * KB },
  async:  { raw: num(args['async-raw'],   80) * KB, gz: num(args['async-gz'],   28) * KB },
  css:    { raw: num(args['css-raw'],     60) * KB },
}

const TOP_N = Math.max(1, num(args.top, 10))
const DIST = args.dist || 'dist'
const ASSETS_DIR = join(DIST, 'assets')

if (!existsSync(ASSETS_DIR)) {
  console.error(`[bundle-analyze] assets dir not found: ${ASSETS_DIR}`)
  console.error('Did you run `vite build` first?')
  process.exit(1)
}

// ---------- Classify chunks (must match check-bundle-budget.mjs) ----------
function classify(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.css')) return 'css'
  if (!lower.endsWith('.js')) return null
  if (/(^|[-./])index([-.]|$)/.test(lower)) return 'main'
  if (/(^|[-./])vendor([-.]|$)/.test(lower)) return 'vendor'
  if (/(^|[-./])react([-.]|$)/.test(lower)) return 'vendor'
  if (/(^|[-./])main([-.]|$)/.test(lower)) return 'main'
  return 'async'
}

function budgetStatus(kind, raw, gz) {
  const b = BUDGETS[kind]
  if (!b) return { over: false, budgetStr: '-' }
  let over = false
  let budgetStr = ''
  if (b.raw != null) {
    if (raw > b.raw) over = true
    budgetStr += `raw<=${(b.raw / KB).toFixed(0)}KB`
  }
  if (b.gz != null) {
    if (gz > b.gz) over = true
    if (budgetStr) budgetStr += ' '
    budgetStr += `gz<=${(b.gz / KB).toFixed(0)}KB`
  }
  return { over, budgetStr }
}

// ---------- Source map parsing ----------
function loadSourceMap(jsFullPath) {
  const mapPath = `${jsFullPath}.map`
  if (!existsSync(mapPath)) return null
  try {
    const text = readFileSync(mapPath, 'utf8')
    const json = JSON.parse(text)
    if (!Array.isArray(json.sources)) return null
    return json.sources.filter(s => typeof s === 'string')
  } catch (err) {
    console.warn(`[bundle-analyze] failed to parse ${mapPath}: ${err.message}`)
    return null
  }
}

/**
 * Heuristic contribution score: for each source path in the map, count
 * occurrences of the basename (or last two segments for disambiguation)
 * within the chunk body. The basename appears in any `//# sourceURL`
 * comments, debug strings, dev-mode module references, and — most
 * importantly — webpack/rollup-style module boundary comments that
 * Vite/Rollup emit during `vite build --sourcemap`. This is a rough
 * proxy, not byte-accurate, but it surfaces the heavy hitters.
 */
function scoreSources(chunkBody, sources) {
  // Dedup, but keep the original path as the display key.
  const scoreByPath = new Map()
  for (const src of sources) {
    if (!src) continue
    // Normalize slashes for matching
    const norm = src.replace(/\\/g, '/')
    // Use the last two segments (or full path if shorter) as the search key,
    // which avoids matching every short basename like `index.js`.
    const parts = norm.split('/').filter(Boolean)
    let key
    if (parts.length >= 2) key = parts.slice(-2).join('/')
    else key = parts[parts.length - 1] || norm
    if (!key) continue
    if (scoreByPath.has(src)) continue
    // Count plain occurrences. Use indexOf loop — avoids RegExp escaping.
    let count = 0
    let from = 0
    while (true) {
      const idx = chunkBody.indexOf(key, from)
      if (idx === -1) break
      count++
      from = idx + key.length
    }
    // Weight by key length so longer (more specific) paths dominate ties.
    const weight = count * key.length
    if (weight > 0) {
      scoreByPath.set(src, { occurrences: count, weight, displayKey: key })
    }
  }
  return [...scoreByPath.entries()]
    .map(([source, info]) => ({ source, ...info }))
    .sort((a, b) => b.weight - a.weight || b.occurrences - a.occurrences)
}

// ---------- Scan files ----------
const files = readdirSync(ASSETS_DIR)
  .filter(f => /\.(js|css)$/i.test(f))
  .filter(f => !/\.map$/i.test(f))
  .sort()

const reports = []
let cssTotalRaw = 0

for (const f of files) {
  const full = join(ASSETS_DIR, f)
  const st = statSync(full)
  if (!st.isFile()) continue
  const kind = classify(f)
  if (!kind) continue

  const buf = readFileSync(full)
  const raw = buf.length
  const gz = gzipSync(buf).length
  const { over, budgetStr } = budgetStatus(kind, raw, gz)
  if (kind === 'css') cssTotalRaw += raw

  let topSources = []
  let mapNote = ''
  if (kind !== 'css') {
    const sources = loadSourceMap(full)
    if (sources && sources.length) {
      const body = buf.toString('utf8')
      topSources = scoreSources(body, sources).slice(0, TOP_N)
      mapNote = `${sources.length} source(s) in map`
    } else {
      mapNote = 'no source-map (chunk size only)'
    }
  } else {
    mapNote = 'css file'
  }

  reports.push({ file: f, kind, raw, gz, over, budgetStr, topSources, mapNote })
}

// ---------- Render ----------
function fmtKB(n) { return `${(n / KB).toFixed(1)}KB` }
function pad(s, w) { return String(s).padEnd(w) }

reports.sort((a, b) => {
  if (a.kind !== b.kind) {
    const order = { main: 0, vendor: 1, async: 2, css: 3 }
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9)
  }
  return b.raw - a.raw
})

console.log(`[bundle-analyze] dist=${DIST}  top=${TOP_N}`)
console.log('')

let overCount = 0
for (const r of reports) {
  const flag = r.over ? '  OVER' : ''
  console.log(
    `=== ${r.file}  [${r.kind}]  raw=${fmtKB(r.raw)}  gzip=${fmtKB(r.gz)}  budget: ${r.budgetStr}${flag}`,
  )
  console.log(`    ${r.mapNote}`)
  if (r.over) overCount++

  if (r.topSources.length === 0) {
    console.log('')
    continue
  }

  // Per-chunk top-sources mini table
  const headers = ['rank', 'occ', 'weight', 'source']
  const rows = r.topSources.map((s, i) => [
    String(i + 1),
    String(s.occurrences),
    String(s.weight),
    s.source,
  ])
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(row => String(row[i]).length)),
  )
  console.log('    ' + headers.map((h, i) => pad(h, widths[i])).join('  '))
  console.log('    ' + headers.map((_, i) => '-'.repeat(widths[i])).join('  '))
  for (const row of rows) {
    console.log('    ' + row.map((c, i) => pad(c, widths[i])).join('  '))
  }
  console.log('')
}

// ---------- CSS total line ----------
const cssTotalOver =
  BUDGETS.css?.raw != null && cssTotalRaw > BUDGETS.css.raw
const cssTotalBudgetStr =
  BUDGETS.css?.raw != null ? `raw<=${(BUDGETS.css.raw / KB).toFixed(0)}KB` : '-'
console.log(
  `CSS total: ${fmtKB(cssTotalRaw)}   budget: ${cssTotalBudgetStr}   ${cssTotalOver ? 'OVER' : 'OK'}`,
)
if (cssTotalOver) overCount++

// ---------- Summary ----------
console.log('')
if (overCount > 0) {
  console.log(
    `[bundle-analyze] ${overCount} chunk(s) over budget — see check-bundle-budget.mjs for CI gating.`,
  )
} else {
  console.log('[bundle-analyze] all chunks within budget.')
}

// This script is a reporter, not a gate — always exit 0 so CI's separate
// check-bundle-budget.mjs run owns pass/fail semantics.
process.exit(0)
