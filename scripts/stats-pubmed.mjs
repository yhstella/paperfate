#!/usr/bin/env node
// Quick stats over collected PubMed JSONL files.
// Usage: node scripts/stats-pubmed.mjs

import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, '..', 'data', 'pubmed')

function pct(n, total) { return total ? `${((n / total) * 100).toFixed(1)}%` : '—' }

let files
try { files = readdirSync(DIR).filter(f => f.endsWith('.jsonl')) }
catch { console.error('No data/pubmed yet. Run: npm run collect'); process.exit(1) }

if (files.length === 0) { console.error('No JSONL files in data/pubmed'); process.exit(1) }

const bySeed = {}
const byYear = {}
const byJournal = {}
let total = 0
let withAbs = 0, withDoi = 0, withMesh = 0

for (const f of files) {
  const lines = readFileSync(join(DIR, f), 'utf-8').split('\n').filter(Boolean)
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line) } catch { continue }
    total++
    bySeed[rec.seed] = (bySeed[rec.seed] || 0) + 1
    if (rec.year) byYear[rec.year] = (byYear[rec.year] || 0) + 1
    if (rec.journal) byJournal[rec.journal] = (byJournal[rec.journal] || 0) + 1
    if (rec.abstract) withAbs++
    if (rec.doi) withDoi++
    if (rec.meshTerms?.length) withMesh++
  }
}

console.log(`Records: ${total}`)
console.log(`  with abstract: ${withAbs} (${pct(withAbs, total)})`)
console.log(`  with DOI:      ${withDoi} (${pct(withDoi, total)})`)
console.log(`  with MeSH:     ${withMesh} (${pct(withMesh, total)})`)

console.log('\nBy seed:')
for (const [k, v] of Object.entries(bySeed).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${v}`)
}

console.log('\nTop 10 journals:')
Object.entries(byJournal).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) =>
  console.log(`  ${String(v).padStart(5)}  ${k}`))

console.log('\nBy year:')
Object.entries(byYear).sort(([a], [b]) => Number(a) - Number(b)).forEach(([y, n]) =>
  console.log(`  ${y}: ${'█'.repeat(Math.round(n / 50))} ${n}`))
