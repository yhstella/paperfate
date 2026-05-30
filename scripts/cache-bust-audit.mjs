#!/usr/bin/env node
/**
 * cache-bust-audit.mjs
 *
 * After `vite build`, walk dist/assets/* and assert that every JS/CSS file
 * carries a content-hash in its filename (Vite default: name-<hash>.js).
 *
 * Also parse dist/index.html and verify every <script src> and
 * <link rel="stylesheet" href> in there points at an existing,
 * hashed asset under dist/assets/*.
 *
 * Path-stable allowlist (unhashed is fine + expected):
 *   - sw.js                  (service worker — must be at /sw.js so it can claim the scope)
 *   - manifest.webmanifest
 *   - offline.html
 *   - robots.txt
 *   - sitemap.xml
 *   - og-default.svg
 *
 * Anything else missing a hash => stray unhashed asset; we fail with exit 1.
 *
 * Usage:
 *   node scripts/cache-bust-audit.mjs [--dist dist] [--json]
 *
 * Exit codes:
 *   0  all hashed (or only allowlisted unhashed files present)
 *   1  stray unhashed asset OR index.html references a missing/unhashed file
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, basename, posix } from 'node:path'

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
const DIST = args.dist || 'dist'
const ASSETS_DIR = join(DIST, 'assets')
const INDEX_HTML = join(DIST, 'index.html')
const AS_JSON = !!args.json

// Path-stable files that Vite copies straight from public/ without hashing.
// These MUST stay at their stable URLs so browsers / SW registration work.
const UNHASHED_ALLOWLIST = new Set([
  'sw.js',
  'manifest.webmanifest',
  'offline.html',
  'robots.txt',
  'sitemap.xml',
  'og-default.svg',
])

if (!existsSync(DIST)) {
  console.error(`[cache-bust-audit] dist dir not found: ${DIST}`)
  console.error('Did you run `vite build` first?')
  process.exit(1)
}

if (!existsSync(ASSETS_DIR)) {
  console.error(`[cache-bust-audit] assets dir not found: ${ASSETS_DIR}`)
  console.error('Did you run `vite build` first?')
  process.exit(1)
}

if (!existsSync(INDEX_HTML)) {
  console.error(`[cache-bust-audit] index.html not found: ${INDEX_HTML}`)
  process.exit(1)
}

// ---------- Hash detection ----------
// Vite default: name-<hash>.ext  where hash is typically 8+ hex/base64-ish chars.
// We accept any -[A-Za-z0-9_]{6,} segment immediately before the final extension.
const HASH_RE = /-[A-Za-z0-9_-]{6,}\.(js|css|mjs|cjs)$/i

function isHashed(filename) {
  return HASH_RE.test(filename)
}

function isCodeAsset(filename) {
  return /\.(js|mjs|cjs|css)$/i.test(filename) && !/\.map$/i.test(filename)
}

// ---------- Scan dist/assets ----------
const warnings = []
const rows = []

function walk(dir, relBase = '') {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = relBase ? posix.join(relBase, entry) : entry
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, rel)
      continue
    }
    if (!st.isFile()) continue
    rows.push({ file: rel, base: basename(entry) })
  }
}

walk(ASSETS_DIR)

let hashedCount = 0
let unhashedCount = 0
const unhashedFiles = []

for (const row of rows) {
  if (!isCodeAsset(row.base)) {
    // Non-code assets (images, fonts) in /assets/ are typically hashed by Vite too,
    // but we don't enforce — they're not the cache-busting concern here.
    row.kind = 'other'
    row.hashed = HASH_RE.test(row.base) || /-[A-Za-z0-9_-]{6,}\./i.test(row.base)
    continue
  }
  row.kind = row.base.toLowerCase().endsWith('.css') ? 'css' : 'js'
  row.hashed = isHashed(row.base)
  if (row.hashed) {
    hashedCount++
  } else {
    unhashedCount++
    unhashedFiles.push(row.file)
    warnings.push(
      `Unhashed code asset under dist/assets/: ${row.file} — would break long-term caching.`,
    )
  }
}

// ---------- Verify path-stable files at dist root ----------
// sw.js MUST exist at dist/sw.js (not bundled into /assets/).
const swPath = join(DIST, 'sw.js')
if (!existsSync(swPath)) {
  warnings.push(
    `public/sw.js missing at dist/sw.js — service worker must be served from origin root.`,
  )
} else {
  // Make sure it wasn't also bundled into /assets/ with a hash.
  const bundledSW = rows.find(r => /(^|\/)sw-[A-Za-z0-9_-]{6,}\.js$/i.test(r.file))
  if (bundledSW) {
    warnings.push(
      `sw.js appears to have been bundled into assets (${bundledSW.file}) — it must remain at /sw.js path-stable.`,
    )
  }
}

// ---------- Parse index.html for asset references ----------
const html = readFileSync(INDEX_HTML, 'utf8')

const scriptRefs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
  .map(m => m[1])
const linkRefs = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)]
  .map(m => m[1])
// Also catch href-first stylesheet link form.
const linkRefsAlt = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)]
  .map(m => m[1])

const allRefs = [...new Set([...scriptRefs, ...linkRefs, ...linkRefsAlt])]

const htmlIssues = []

for (const ref of allRefs) {
  // Ignore absolute / external URLs.
  if (/^https?:\/\//i.test(ref) || ref.startsWith('//')) continue
  if (ref.startsWith('data:')) continue

  // Normalize to a dist-relative path. Vite emits absolute-origin paths like
  // "/assets/index-abcd1234.js". We strip the leading slash.
  const cleaned = ref.replace(/^\.?\//, '').split('?')[0].split('#')[0]
  const onDisk = join(DIST, cleaned)

  if (!existsSync(onDisk)) {
    htmlIssues.push(`index.html references missing file: ${ref} (looked at ${onDisk})`)
    warnings.push(`index.html references missing file: ${ref}`)
    continue
  }

  const refBase = basename(cleaned)
  const inAssets = cleaned.startsWith('assets/') || cleaned.includes('/assets/')

  if (UNHASHED_ALLOWLIST.has(refBase)) {
    // Path-stable file — fine, intentionally unhashed.
    continue
  }

  if (inAssets && !isHashed(refBase)) {
    htmlIssues.push(
      `index.html references unhashed asset in /assets/: ${ref} — cache busting will not work.`,
    )
    warnings.push(`index.html references unhashed asset: ${ref}`)
  }
}

// ---------- Render ----------
const summary = {
  dist: DIST,
  total_assets: rows.filter(r => isCodeAsset(r.base)).length,
  hashed_count: hashedCount,
  unhashed_count: unhashedCount,
  warnings: warnings.length,
  unhashed_files: unhashedFiles,
  html_issues: htmlIssues,
}

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  // Aligned table: list code assets and their hashed status.
  const codeRows = rows
    .filter(r => isCodeAsset(r.base))
    .sort((a, b) => (a.kind > b.kind ? 1 : a.kind < b.kind ? -1 : a.file.localeCompare(b.file)))

  const headers = ['asset', 'kind', 'hashed']
  const widths = headers.map(h => h.length)
  const tableRows = codeRows.map(r => [r.file, r.kind, r.hashed ? 'yes' : 'NO'])

  for (const row of tableRows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], String(row[i]).length)
    }
  }

  function pad(s, w) { return String(s).padEnd(w) }

  console.log(headers.map((h, i) => pad(h, widths[i])).join('  '))
  console.log(headers.map((_, i) => '-'.repeat(widths[i])).join('  '))
  for (const row of tableRows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join('  '))
  }

  console.log('')
  console.log(`total_assets:    ${summary.total_assets}`)
  console.log(`hashed_count:    ${summary.hashed_count}`)
  console.log(`unhashed_count:  ${summary.unhashed_count}`)
  console.log(`warnings:        ${summary.warnings}`)

  if (warnings.length) {
    console.log('\nWarnings:')
    for (const w of warnings) console.log(`  - ${w}`)
  }
}

const hardFailures = unhashedCount + htmlIssues.length

if (hardFailures > 0) {
  if (!AS_JSON) {
    console.log(`\n[cache-bust-audit] FAIL — ${hardFailures} issue(s).`)
  }
  process.exit(1)
}

if (!AS_JSON) {
  console.log('\n[cache-bust-audit] PASS — all code assets hashed, allowlisted files path-stable.')
}
process.exit(0)
