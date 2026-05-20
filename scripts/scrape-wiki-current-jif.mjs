#!/usr/bin/env node
// PaperFate · Direct Wikipedia (current page) IF scraper
//
// Fast complement to verify-top100-jif.mjs (which goes via Wayback).
// Reads the CURRENT Wikipedia article for each top-N journal and pulls all
// "(YEAR) impact factor X.YZ" mentions in the body — many articles list the
// last 3-5 years inline. ~5 seconds per journal vs ~3 min for Wayback.
//
// Usage:
//   node scripts/scrape-wiki-current-jif.mjs --top 100
//   node scripts/scrape-wiki-current-jif.mjs --top 200 --delay-ms 800

import Database from 'better-sqlite3'
import { mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = process.env.DATA_ROOT || join(HERE, '..', 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'wiki-current-jif')

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function parseArgs() {
  const a = process.argv.slice(2)
  const val = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i+1] : d }
  return { top: Number(val('--top', 100)), delay: Number(val('--delay-ms', 800)) }
}

async function findWikiTitle(journalName) {
  const candidates = [`${journalName} (journal)`, `${journalName} journal`, journalName]
  for (const c of candidates) {
    const u = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=3&search=${encodeURIComponent(c)}`
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'paperfate/0.3 (mailto:beta@paperfate.com)' } })
      if (!r.ok) continue
      const j = await r.json()
      const titles = j[1] || [], urls = j[3] || []
      let best = null, bestScore = -Infinity
      for (let i = 0; i < titles.length; i++) {
        let s = 0
        const tl = titles[i].toLowerCase()
        if (tl.includes('(journal)')) s += 4
        if (tl.includes('journal')) s += 1
        if (tl === journalName.toLowerCase()) s += 3
        if (s > bestScore) { bestScore = s; best = { title: titles[i], url: urls[i] } }
      }
      if (best && bestScore >= 2) return best
      if (c === journalName && best) return best
    } catch {}
    await sleep(250)
  }
  return null
}

async function fetchWikiHtml(wikiUrl) {
  const r = await fetch(wikiUrl, { headers: { 'User-Agent': 'paperfate/0.3 (mailto:beta@paperfate.com)' } })
  if (!r.ok) return null
  return await r.text()
}

// Returns array of { year, value, source }
function extractIFMentions(html) {
  const stripped = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
  const out = []

  // Pattern A: "Impact factor (YYYY) X.YZ" or "impact factor of YYYY is X.YZ"
  const reA = /[Ii]mpact\s+factor[^0-9]{0,30}\(?\s*(\d{4})\s*\)?[^0-9]{0,15}(\d{1,3}\.\d{1,4})/g
  let m
  while ((m = reA.exec(stripped)) !== null) {
    const yr = Number(m[1]), v = Number(m[2])
    if (yr >= 2000 && yr <= 2030 && v > 0.05 && v < 600) {
      out.push({ year: yr, value: v, source: 'A_yearparen' })
    }
  }
  // Pattern B: "YYYY impact factor [was|of|is] X.YZ"
  const reB = /(\d{4})\s+[Ii]mpact\s+factor\s*(?:was|of|is|=|:)?\s*(\d{1,3}\.\d{1,4})/g
  while ((m = reB.exec(stripped)) !== null) {
    const yr = Number(m[1]), v = Number(m[2])
    if (yr >= 2000 && yr <= 2030 && v > 0.05 && v < 600) {
      out.push({ year: yr, value: v, source: 'B_yearprefix' })
    }
  }
  // Pattern C: "the YYYY journal impact factor was X.YZ"
  const reC = /[Tt]he\s+(\d{4})\s+(?:journal\s+)?impact\s+factor[^0-9]{0,15}(\d{1,3}\.\d{1,4})/g
  while ((m = reC.exec(stripped)) !== null) {
    const yr = Number(m[1]), v = Number(m[2])
    if (yr >= 2000 && yr <= 2030 && v > 0.05 && v < 600) {
      out.push({ year: yr, value: v, source: 'C_thy' })
    }
  }
  // Dedupe (year, value)
  const seen = new Set(), uniq = []
  for (const x of out) {
    const k = `${x.year}|${x.value}`
    if (!seen.has(k)) { seen.add(k); uniq.push(x) }
  }
  return uniq
}

async function main() {
  const args = parseArgs()
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `wiki-current-jif-${todayStamp()}.jsonl`)

  const db = new Database(DB_PATH, { readonly: true })
  const journals = db.prepare(`
    SELECT openalex_id, display_name
    FROM journals
    WHERE two_yr_mean_citedness IS NOT NULL
    ORDER BY two_yr_mean_citedness DESC
    LIMIT ?
  `).all(args.top)
  db.close()

  console.log(`PaperFate · wiki-current-jif (direct Wikipedia)`)
  console.log(`Top-${journals.length} journals`)
  console.log(`Output: ${outPath}`)
  console.log(`Delay: ${args.delay}ms/journal\n`)

  let totalIF = 0, journalsWithIF = 0
  const t0 = Date.now()
  for (let i = 0; i < journals.length; i++) {
    const j = journals[i]
    const wiki = await findWikiTitle(j.display_name)
    if (!wiki) {
      console.log(`  ${(i+1).toString().padStart(3)} ${j.display_name.slice(0,40).padEnd(40)} no wiki`)
      appendFileSync(outPath, JSON.stringify({ openalex_id: j.openalex_id, display_name: j.display_name, error: 'no_wikipedia' }) + '\n')
      await sleep(args.delay)
      continue
    }
    const html = await fetchWikiHtml(wiki.url)
    if (!html) {
      console.log(`  ${(i+1).toString().padStart(3)} ${j.display_name.slice(0,40).padEnd(40)} fetch fail`)
      await sleep(args.delay)
      continue
    }
    const mentions = extractIFMentions(html)
    if (mentions.length > 0) {
      journalsWithIF++
      totalIF += mentions.length
      // Keep MAX value per year (handles A and B finding same value)
      const byYear = new Map()
      for (const m of mentions) {
        const prev = byYear.get(m.year)
        if (!prev || m.value > prev.value) byYear.set(m.year, m)
      }
      for (const [yr, mn] of byYear) {
        appendFileSync(outPath, JSON.stringify({
          openalex_id: j.openalex_id,
          display_name: j.display_name,
          year: yr,
          wiki_current_jif: mn.value,
          wiki_url: wiki.url,
          source: mn.source,
          scraped_at: new Date().toISOString(),
        }) + '\n')
      }
      console.log(`  ${(i+1).toString().padStart(3)} ${j.display_name.slice(0,40).padEnd(40)} ${byYear.size} year(s): ${[...byYear.keys()].sort().join(',')}`)
    } else {
      console.log(`  ${(i+1).toString().padStart(3)} ${j.display_name.slice(0,40).padEnd(40)} no IF in text`)
    }
    await sleep(args.delay)
  }
  console.log(`\n✓ Done in ${((Date.now()-t0)/60000).toFixed(1)} min`)
  console.log(`  ${journalsWithIF}/${journals.length} journals yielded IF data (${totalIF} year-mentions total)`)
  console.log(`  Output: ${outPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
