#!/usr/bin/env node
// PaperFate · Verify top-100 journals with Wayback Machine + Wikipedia
//
// Strategy: most major biomedical journals have a Wikipedia page with an
// infobox containing impact_factor + impact_factor_year. The CURRENT
// Wikipedia page shows the latest IF. The Wayback Machine has snapshots
// going back years — fetching a snapshot from year Y often gives us the
// IF as it was reported on Wikipedia in year Y.
//
// Per-journal flow:
//   1. find_wikipedia_url() — search Wikipedia API for journal title
//   2. For each target year (2010..2024):
//        wayback availability lookup → snapshot URL
//        fetch snapshot HTML
//        parse infobox & body for IF value
//   3. Save (journal, year, scraped_jif, source_url) to data/wayback-jif/
//
// Output is loaded into journal_year_metrics.wayback_jif column for
// cross-checking against the calibration model.
//
// Rate limits: Wayback can throttle aggressively. Default 3 sec/request
// → ~75 min for 100 journals × 15 years.

import Database from 'better-sqlite3'
import { mkdirSync, appendFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = process.env.DATA_ROOT || join(HERE, '..', 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'wayback-jif')

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function parseArgs() {
  const a = process.argv.slice(2)
  const idx = (f) => a.indexOf(f)
  const val = (f, d) => idx(f) >= 0 ? a[idx(f) + 1] : d
  return {
    top:    Number(val('--top', 100)),
    years:  val('--years', '2010-2024'),
    delay:  Number(val('--delay-ms', 3000)),
    dryRun: a.includes('--dry-run'),
  }
}
function parseYearRange(s) {
  const m = s.match(/^(\d{4})-(\d{4})$/)
  const out = []
  for (let y = Number(m[1]); y <= Number(m[2]); y++) out.push(y)
  return out
}

// ───────────────────────── Wikipedia lookup ─────────────────────────
// Improved: tries the "(journal)" qualified title first (handles ambiguous
// names like "Cell" or "Science" that resolve to non-journal pages).
async function findWikipediaPage(journalName) {
  const candidates = [
    `${journalName} (journal)`,
    `${journalName} journal`,
    journalName,
  ]
  for (const candidate of candidates) {
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=5&search=${encodeURIComponent(candidate)}`
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'paperfate/0.2 (mailto:beta@paperfate.com)' } })
      if (!res.ok) continue
      const j = await res.json()
      const titles = j[1] || []
      const urls = j[3] || []
      // Score each candidate page
      let best = null, bestScore = -Infinity
      for (let i = 0; i < titles.length; i++) {
        const t = titles[i]
        let score = 0
        const tl = t.toLowerCase()
        if (tl.includes('(journal)')) score += 4
        if (tl.includes('journal'))    score += 1
        if (tl === journalName.toLowerCase()) score += 3
        const start = journalName.toLowerCase().slice(0, 12)
        if (tl.startsWith(start)) score += 2
        if (score > bestScore) { bestScore = score; best = { title: t, url: urls[i] } }
      }
      if (best && bestScore >= 2) return best
      if (candidate === journalName && best) return best   // last-resort
    } catch {}
    await sleep(400)
  }
  return null
}

async function waybackSnapshot(url, year, attempts = 3) {
  const ts = `${year}0601`   // mid-year snapshot preferred
  const apiUrl = `http://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${ts}`
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(apiUrl, { headers: { 'User-Agent': 'paperfate/0.2 (mailto:beta@paperfate.com)' } })
      if (res.status === 429) { await sleep(5000 * (i + 1)); continue }
      if (!res.ok) return null
      const j = await res.json()
      const c = j?.archived_snapshots?.closest
      if (!c || !c.available) return null
      // Only accept snapshots within ±2 years of target year
      const snapYear = Number(c.timestamp?.slice(0, 4))
      if (Math.abs(snapYear - year) > 2) return null
      return c.url
    } catch (e) {
      await sleep(1500 * (i + 1))
    }
  }
  return null
}

async function fetchSnapshotIF(snapshotUrl, year) {
  const res = await fetch(snapshotUrl, { headers: { 'User-Agent': 'paperfate/0.2 (mailto:beta@paperfate.com)' } })
  if (!res.ok) return null
  const html = await res.text()

  // 1) Infobox parsing — search for impact_factor=<value> or IF table cell
  const candidates = []

  // Wikipedia infobox: "<span ...>Impact factor</span>...<td...>X.YZ</td>"
  // Best parse: text-stripped, then look for "Impact factor" followed by a number within ~120 chars.
  const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  // Pattern A: "Impact factor (YYYY) 12.34"
  const reA = /[Ii]mpact\s+factor[^0-9]{0,30}\(?\s*(\d{4})\s*\)?[^0-9]{0,15}(\d{1,3}\.\d{1,4})/g
  let m
  while ((m = reA.exec(stripped)) !== null) {
    const yr = Number(m[1])
    const val = Number(m[2])
    if (val > 0.05 && val < 600 && Math.abs(yr - year) <= 2) {
      candidates.push({ value: val, score: 5, year_in_text: yr, src: 'A_yearparen' })
    }
  }
  // Pattern B: "2015 impact factor [was/of/is] 12.34"
  const reB = /(\d{4})\s+[Ii]mpact\s+factor\s*(?:was|of|is|=|:)?\s*(\d{1,3}\.\d{1,4})/g
  while ((m = reB.exec(stripped)) !== null) {
    const yr = Number(m[1])
    const val = Number(m[2])
    if (val > 0.05 && val < 600 && Math.abs(yr - year) <= 2) {
      candidates.push({ value: val, score: 5, year_in_text: yr, src: 'B_yearprefix' })
    }
  }
  // Pattern C: "impact factor of 12.34" without year — only accept if no other candidate
  const reC = /[Ii]mpact\s+factor\s+(?:of\s+|was\s+|is\s+|=\s*|:\s*)(\d{1,3}\.\d{1,4})/g
  while ((m = reC.exec(stripped)) !== null) {
    const val = Number(m[1])
    if (val > 0.05 && val < 600) {
      candidates.push({ value: val, score: 2, year_in_text: null, src: 'C_generic' })
    }
  }

  if (candidates.length === 0) return null

  // Rank by score, prefer year-tagged hits matching the target year exactly
  candidates.sort((a, b) => {
    const ta = a.year_in_text === year ? 1 : 0
    const tb = b.year_in_text === year ? 1 : 0
    if (tb - ta !== 0) return tb - ta
    return b.score - a.score
  })
  return {
    value: candidates[0].value,
    confidence: candidates[0].year_in_text === year ? 0.9 : (candidates[0].score >= 5 ? 0.7 : 0.4),
    candidates: candidates.slice(0, 3),
    snapshot_url: snapshotUrl,
  }
}

// ───────────────────────── Main ─────────────────────────
async function main() {
  const args = parseArgs()
  const years = parseYearRange(args.years)
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `wayback-jif-${todayStamp()}.jsonl`)
  const already = loadAlreadyScraped(outPath)

  const db = new Database(DB_PATH, { readonly: true })
  // Top N journals: pick by 2yr_mean_citedness (snapshot IF proxy) descending
  const journals = db.prepare(`
    SELECT openalex_id, display_name
    FROM journals
    WHERE two_yr_mean_citedness IS NOT NULL
    ORDER BY two_yr_mean_citedness DESC
    LIMIT ?
  `).all(args.top)
  db.close()
  console.log(`PaperFate · top-${journals.length} JIF verifier`)
  console.log(`Years: ${years[0]}–${years[years.length - 1]}`)
  console.log(`Output: ${outPath}  (already scraped: ${already.size})`)
  console.log(`Delay: ${args.delay}ms/request\n`)

  if (args.dryRun) {
    for (const j of journals.slice(0, 10)) console.log('  ', j.display_name)
    console.log(`(dry-run, ${journals.length - 10} more not shown)`)
    return
  }

  // Cache wikipedia URL per journal (one lookup per journal, not per year)
  const wikiCache = new Map()

  let total = journals.length * years.length, done = 0, ok = 0, miss = 0
  const startedAt = Date.now()
  for (const j of journals) {
    let wiki = wikiCache.get(j.openalex_id)
    if (!wiki) {
      wiki = await findWikipediaPage(j.display_name)
      wikiCache.set(j.openalex_id, wiki)
      await sleep(800)   // gentle to Wikipedia API
    }
    if (!wiki) {
      done += years.length
      console.log(`  ${j.display_name.slice(0, 40).padEnd(40)}  no Wikipedia page`)
      continue
    }
    for (const year of years) {
      const key = `${j.openalex_id}|${year}`
      if (already.has(key)) { done++; continue }
      let snap = null, parsed = null
      try {
        snap = await waybackSnapshot(wiki.url, year)
        if (snap) parsed = await fetchSnapshotIF(snap, year)
      } catch (e) {
        appendFileSync(outPath, JSON.stringify({
          openalex_id: j.openalex_id, display_name: j.display_name,
          year, error: e.message,
        }) + '\n')
        done++; miss++
        await sleep(args.delay)
        continue
      }
      if (parsed) {
        appendFileSync(outPath, JSON.stringify({
          openalex_id: j.openalex_id,
          display_name: j.display_name,
          year,
          wayback_jif: parsed.value,
          confidence: parsed.confidence,
          snapshot_url: parsed.snapshot_url,
          wiki_url: wiki.url,
          scraped_at: new Date().toISOString(),
        }) + '\n')
        ok++
      } else {
        appendFileSync(outPath, JSON.stringify({
          openalex_id: j.openalex_id, display_name: j.display_name,
          year, wayback_jif: null, wiki_url: wiki.url, snapshot_url: snap,
        }) + '\n')
        miss++
      }
      done++
      if (done % 25 === 0) {
        const rate = (done / ((Date.now() - startedAt) / 1000)).toFixed(2)
        console.log(`  ${done}/${total}  ok=${ok} miss=${miss}  ${rate}/s`)
      }
      await sleep(args.delay)
    }
  }
  console.log(`\n✓ Done in ${((Date.now() - startedAt) / 60000).toFixed(1)} min`)
  console.log(`  ok=${ok}  miss=${miss}`)
  console.log(`  output: ${outPath}  (${(statSync(outPath).size / 1024).toFixed(1)} KB)`)
}

function loadAlreadyScraped(outFile) {
  if (!existsSync(outFile)) return new Set()
  const done = new Set()
  for (const line of readFileSync(outFile, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.openalex_id && r.year != null) done.add(`${r.openalex_id}|${r.year}`)
    } catch {}
  }
  return done
}

main().catch(e => { console.error(e); process.exit(1) })
