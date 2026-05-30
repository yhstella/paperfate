#!/usr/bin/env node
/**
 * check-bundle-budget.mjs
 *
 * After `vite build`, scan dist/assets/* and assert per-chunk size budgets.
 * Used in CI to fail PRs that bloat the bundle.
 *
 * Usage:
 *   node scripts/check-bundle-budget.mjs [--dist dist] \
 *     [--main-raw 400] [--main-gz 120] \
 *     [--vendor-raw 300] [--vendor-gz 95] \
 *     [--async-raw 80] [--async-gz 28] \
 *     [--css-raw 60]
 *
 * Budgets are in KB. Exit 0 = all good, Exit 1 = at least one chunk over.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
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

const DIST = args.dist || 'dist'
const ASSETS_DIR = join(DIST, 'assets')

if (!existsSync(ASSETS_DIR)) {
  console.error(`[bundle-budget] assets dir not found: ${ASSETS_DIR}`)
  console.error('Did you run `vite build` first?')
  process.exit(1)
}

// ---------- Classify chunks ----------
function classify(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.css')) return 'css'
  if (!lower.endsWith('.js')) return null
  // Vite default naming patterns
  if (/(^|[-./])index([-.]|$)/.test(lower)) return 'main'
  if (/(^|[-./])vendor([-.]|$)/.test(lower)) return 'vendor'
  if (/(^|[-./])react([-.]|$)/.test(lower)) return 'vendor'
  if (/(^|[-./])main([-.]|$)/.test(lower)) return 'main'
  return 'async'
}

// ---------- Scan ----------
const files = readdirSync(ASSETS_DIR)
  .filter(f => /\.(js|css)$/i.test(f))
  .filter(f => !/\.map$/i.test(f))

const rows = []
let cssTotalRaw = 0
let mainCount = 0
let vendorCount = 0

for (const f of files) {
  const full = join(ASSETS_DIR, f)
  const st = statSync(full)
  if (!st.isFile()) continue
  const buf = readFileSync(full)
  const raw = buf.length
  const gz = gzipSync(buf).length
  const kind = classify(f)
  if (!kind) continue
  if (kind === 'css') cssTotalRaw += raw
  if (kind === 'main') mainCount++
  if (kind === 'vendor') vendorCount++
  rows.push({ file: f, kind, raw, gz })
}

// ---------- Evaluate against budgets ----------
let failed = 0
const tips = []

function statusFor(row) {
  const b = BUDGETS[row.kind]
  if (!b) return { ok: true, budgetStr: '-' }
  let ok = true
  let budgetStr = ''
  if (b.raw != null) {
    if (row.raw > b.raw) ok = false
    budgetStr += `raw<=${(b.raw / KB).toFixed(0)}KB`
  }
  if (b.gz != null) {
    if (row.gz > b.gz) ok = false
    if (budgetStr) budgetStr += ' '
    budgetStr += `gz<=${(b.gz / KB).toFixed(0)}KB`
  }
  return { ok, budgetStr }
}

const evaluated = rows.map(r => ({ ...r, ...statusFor(r) }))

// CSS total budget is special — sum across all CSS files.
let cssTotalOk = true
if (BUDGETS.css?.raw != null && cssTotalRaw > BUDGETS.css.raw) {
  cssTotalOk = false
}

// ---------- Render table ----------
function fmtKB(n) { return `${(n / KB).toFixed(1)}KB` }

const headers = ['chunk', 'kind', 'raw', 'gzip', 'budget', 'status']
const widths = headers.map(h => h.length)
const tableRows = evaluated
  .sort((a, b) => (a.kind > b.kind ? 1 : a.kind < b.kind ? -1 : b.raw - a.raw))
  .map(r => [
    r.file,
    r.kind,
    fmtKB(r.raw),
    fmtKB(r.gz),
    r.budgetStr,
    r.ok ? 'OK' : 'OVER',
  ])

for (const row of tableRows) {
  for (let i = 0; i < row.length; i++) {
    widths[i] = Math.max(widths[i], String(row[i]).length)
  }
}

function pad(s, w) { return String(s).padEnd(w) }

const line = headers.map((h, i) => pad(h, widths[i])).join('  ')
console.log(line)
console.log(headers.map((_, i) => '-'.repeat(widths[i])).join('  '))
for (const row of tableRows) {
  console.log(row.map((c, i) => pad(c, widths[i])).join('  '))
}

// CSS total line
console.log('')
const cssTotalBudgetStr = BUDGETS.css?.raw != null
  ? `raw<=${(BUDGETS.css.raw / KB).toFixed(0)}KB`
  : '-'
console.log(
  `CSS total: ${fmtKB(cssTotalRaw)}   budget: ${cssTotalBudgetStr}   ${cssTotalOk ? 'OK' : 'OVER'}`
)

// ---------- Tips ----------
for (const r of evaluated) {
  if (r.ok) continue
  failed++
  if (r.kind === 'main') {
    tips.push(`Main chunk ${r.file} over budget — move heavy modules to async (React.lazy / dynamic import).`)
  } else if (r.kind === 'vendor') {
    tips.push(`Vendor chunk ${r.file} over budget — split vendor: configure Vite manualChunks to separate heavy deps (charts, pdf, markdown) into their own async chunks.`)
  } else if (r.kind === 'async') {
    tips.push(`Async chunk ${r.file} over budget — split further: dynamic import sub-features or tree-shake unused exports.`)
  } else if (r.kind === 'css') {
    tips.push(`CSS file ${r.file} over budget — purge unused Tailwind utilities or lazy-load route-specific styles.`)
  }
}
if (!cssTotalOk) {
  failed++
  tips.push(`CSS total over budget — audit Tailwind safelist and remove unused @layer rules.`)
}

if (mainCount === 0) {
  console.log('\n[warn] no chunk classified as `main` — check Vite output naming or pass --main-* flags.')
}
if (vendorCount === 0) {
  console.log('\n[warn] no chunk classified as `vendor` — if you have not configured manualChunks, this may be expected.')
}

if (tips.length) {
  console.log('\nTips:')
  for (const t of tips) console.log(`  - ${t}`)
}

if (failed > 0) {
  console.log(`\n[bundle-budget] FAIL — ${failed} chunk(s) over budget.`)
  process.exit(1)
}

console.log('\n[bundle-budget] PASS — all chunks within budget.')
process.exit(0)
