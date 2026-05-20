#!/usr/bin/env node
// PaperFate · Scrape historical JIF from web search engines  [EXPERIMENTAL]
//
// STATUS: tried in May 2026, ABANDONED. DuckDuckGo HTML returns empty
// snippets after ~10 queries (bot-detection), validation accuracy was
// 4% find / 2% within ±10%. Not viable for the 60K queries needed.
// Kept in repo as a reference; do not invoke for production data.
//
// User-supplied JCR xlsx only covers 2022/2024/2025. For older years
// (2005-2021), there's no free official source. This script searches
// DuckDuckGo HTML (no CAPTCHAs typically) for each (journal, year) pair
// and parses the result snippets for the IF value.
//
// IMPORTANT: this is heuristic — accuracy depends on snippet quality.
// We store results in a SEPARATE column (scraped_jif) so JCR ground
// truth is never overwritten. FateCore can be told to trust this
// column less than jcr_jif during training.
//
// USAGE
//   node scripts/scrape-jif-from-search.mjs --validate       # 50-row accuracy check
//   node scripts/scrape-jif-from-search.mjs --top 500        # top 500 IF journals
//   node scripts/scrape-jif-from-search.mjs --top 500 --years 2010-2021
//   node scripts/scrape-jif-from-search.mjs --journal "The Lancet" --years 2005-2025

import Database from 'better-sqlite3'
import { mkdirSync, appendFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'scraped-jif')

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
    validate: a.includes('--validate'),
    top: idx('--top') >= 0 ? Number(val('--top')) : 0,
    journal: val('--journal', null),
    years: val('--years', '2005-2025'),
    delayMs: Number(val('--delay-ms', 2200)),
    dryRun: a.includes('--dry-run'),
  }
}

function parseYearRange(s) {
  const m = s.match(/^(\d{4})-(\d{4})$/)
  if (!m) throw new Error(`Bad --years: ${s}`)
  const out = []
  for (let y = Number(m[1]); y <= Number(m[2]); y++) out.push(y)
  return out
}

// ───────────────────────── Snippet parsing ───────────────────────────
// Strip HTML tags + entities for clean text
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x?\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

// Pull `result__snippet` blocks out of DuckDuckGo HTML
function extractSnippets(html) {
  const out = []
  // DuckDuckGo HTML wraps snippets in <a class="result__snippet" ...>...</a>
  const re = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = re.exec(html)) !== null) {
    out.push(stripHtml(m[1]))
  }
  return out
}

// Score each candidate IF value found in a snippet text:
//  + 3 if "impact factor" within 30 chars before the number
//  + 2 if the target year appears within 50 chars of the number
//  + 1 if the value is in a plausible IF range (0.05–600)
//  − 5 if value is exactly 5, 10, 100 (placeholders / sample sizes)
//  − 3 if preceded by "n=" or "page" or "vol" (sample size / volume / page)
function scoreIfCandidates(text, year) {
  const result = []
  const tLower = text.toLowerCase()
  const numRe = /(?<![A-Za-z0-9.])([0-9]{1,3}\.\d{1,4})(?![0-9.])/g
  let m
  while ((m = numRe.exec(text)) !== null) {
    const num = Number(m[1])
    if (!Number.isFinite(num) || num < 0.05 || num > 600) continue
    const idx = m.index
    const before = tLower.slice(Math.max(0, idx - 40), idx)
    const after  = tLower.slice(idx + m[0].length, idx + m[0].length + 40)
    let score = 0
    if (/impact\s*factor[^a-z]{0,20}$/i.test(before) || /^[^a-z]{0,5}\)?\s*$/.test(before) && /^\s*\)?[^a-z]{0,5}(?:impact|factor)/i.test(after)) score += 3
    else if (/impact\s*factor/.test(tLower.slice(Math.max(0, idx - 80), idx + m[0].length + 5))) score += 2
    const yearStr = String(year)
    if ((before + after).includes(yearStr)) score += 2
    if (/n\s*=\s*$/.test(before)) score -= 4
    if (/(?:vol|page|pp|pmid|doi)\.?\s*$/.test(before)) score -= 4
    if (Number.isInteger(num) && (num === 5 || num === 10 || num === 100)) score -= 3
    score += 1   // baseline: it's a decimal number, candidate
    result.push({ value: num, score, context: text.slice(Math.max(0, idx - 30), idx + 25) })
  }
  return result
}

function pickBestIF(snippets, year) {
  const all = []
  for (const s of snippets) {
    for (const c of scoreIfCandidates(s, year)) all.push(c)
  }
  if (all.length === 0) return null
  // Group by value rounded to 1 decimal → cluster like-values
  const buckets = {}
  for (const c of all) {
    const k = Math.round(c.value * 10) / 10
    if (!buckets[k]) buckets[k] = { values: [], totalScore: 0, contexts: [] }
    buckets[k].values.push(c.value)
    buckets[k].totalScore += c.score
    buckets[k].contexts.push(c.context)
  }
  const ranked = Object.entries(buckets)
    .map(([k, v]) => ({ value: Number(k), totalScore: v.totalScore, agreement: v.values.length, contexts: v.contexts }))
    .sort((a, b) => (b.totalScore - a.totalScore) || (b.agreement - a.agreement))
  const best = ranked[0]
  // Confidence rough heuristic
  let confidence = 0.4 + Math.min(0.4, best.totalScore * 0.05) + Math.min(0.2, best.agreement * 0.05)
  return { value: best.value, confidence: +confidence.toFixed(2), candidates: ranked.slice(0, 3), evidence: best.contexts[0] }
}

// ───────────────────────── DDG search ───────────────────────────
async function searchDDG(journalName, year, { attempts = 3 } = {}) {
  const q = `"${journalName}" ${year} impact factor`
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 25000)
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      const snippets = extractSnippets(html)
      return snippets
    } catch (e) {
      lastErr = e
      await sleep(1500 * Math.pow(2, i))
    }
  }
  throw lastErr
}

// ───────────────────────── Validation mode ─────────────────────────
async function validate(db, delayMs) {
  // Pull 50 (journal, year) pairs from journal_year_metrics where jcr_jif is known.
  const pairs = db.prepare(`
    SELECT j.display_name AS name, jym.year AS year, jym.jcr_jif AS truth
    FROM journal_year_metrics jym
    JOIN journals j ON jym.openalex_id = j.openalex_id
    WHERE jym.jcr_jif IS NOT NULL AND jym.jcr_jif BETWEEN 1 AND 200
    ORDER BY RANDOM() LIMIT 50
  `).all()
  console.log(`Validating ${pairs.length} (journal, year) pairs against JCR ground truth …\n`)
  const errors = []
  let okWithin10 = 0, okWithin25 = 0, found = 0
  for (const p of pairs) {
    try {
      const snippets = await searchDDG(p.name, p.year)
      const r = pickBestIF(snippets, p.year)
      if (!r) {
        console.log(`  ${p.name.slice(0, 28).padEnd(28)} ${p.year}  no IF found            truth=${p.truth}`)
        continue
      }
      found++
      const absErr = Math.abs(r.value - p.truth)
      const pctErr = absErr / p.truth * 100
      if (pctErr <= 10) okWithin10++
      if (pctErr <= 25) okWithin25++
      errors.push({ pct: pctErr })
      const tag = pctErr <= 10 ? '✓' : pctErr <= 25 ? '~' : '✗'
      console.log(`  ${tag} ${p.name.slice(0, 28).padEnd(28)} ${p.year}  scraped=${String(r.value).padStart(6)}  truth=${String(p.truth).padStart(6)}  (${pctErr.toFixed(0)}% off, conf ${r.confidence})`)
    } catch (e) {
      console.log(`  ! ${p.name.slice(0, 28).padEnd(28)} ${p.year}  search failed: ${e.message}`)
    }
    await sleep(delayMs)
  }
  const meanPct = errors.length ? errors.reduce((s, e) => s + e.pct, 0) / errors.length : 0
  console.log(`\nValidation summary:`)
  console.log(`  total pairs:     ${pairs.length}`)
  console.log(`  IF found:        ${found}  (${(100 * found / pairs.length).toFixed(0)}%)`)
  console.log(`  within ±10%:     ${okWithin10}  (${(100 * okWithin10 / pairs.length).toFixed(0)}%)`)
  console.log(`  within ±25%:     ${okWithin25}  (${(100 * okWithin25 / pairs.length).toFixed(0)}%)`)
  console.log(`  mean % error:    ${meanPct.toFixed(1)}`)
  console.log(`  → if within-10% is ≥70%, this is good enough to scrape historical years.`)
}

// ───────────────────────── Full scrape mode ─────────────────────────
async function scrape(db, args) {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `scraped-jif-${todayStamp()}.jsonl`)
  // Build queue
  let journals
  if (args.journal) {
    journals = db.prepare(`SELECT openalex_id, display_name, two_yr_mean_citedness AS rank_score FROM journals WHERE display_name LIKE ?`).all(args.journal)
  } else {
    const top = args.top || 200
    journals = db.prepare(`
      SELECT openalex_id, display_name, two_yr_mean_citedness AS rank_score
      FROM journals
      WHERE two_yr_mean_citedness IS NOT NULL
      ORDER BY two_yr_mean_citedness DESC
      LIMIT ?
    `).all(top)
  }
  const years = parseYearRange(args.years)
  const already = loadAlreadyScraped(outPath)
  const queue = []
  for (const j of journals) {
    for (const y of years) {
      const key = `${j.openalex_id}|${y}`
      if (already.has(key)) continue
      queue.push({ ...j, year: y, key })
    }
  }
  console.log(`Scraping ${queue.length} (journal × year) pairs  (top=${journals.length}, years=${years[0]}–${years[years.length - 1]})`)
  console.log(`Output: ${outPath}  ·  already scraped: ${already.size}`)
  console.log(`Polite delay: ${args.delayMs}ms between queries  ·  ETA ~${((queue.length * args.delayMs) / 60000).toFixed(0)} min\n`)
  if (args.dryRun) { console.log('Dry-run, exiting.'); return }

  let done = 0, ok = 0, fail = 0
  const startedAt = Date.now()
  for (const item of queue) {
    try {
      const snippets = await searchDDG(item.display_name, item.year)
      const r = pickBestIF(snippets, item.year)
      if (r) {
        appendFileSync(outPath, JSON.stringify({
          openalex_id: item.openalex_id,
          display_name: item.display_name,
          year: item.year,
          scraped_jif: r.value,
          confidence: r.confidence,
          evidence: r.evidence,
          scraped_at: new Date().toISOString(),
        }) + '\n')
        ok++
      } else {
        appendFileSync(outPath, JSON.stringify({
          openalex_id: item.openalex_id,
          display_name: item.display_name,
          year: item.year,
          scraped_jif: null,
          confidence: 0,
          evidence: 'no IF candidate found',
          scraped_at: new Date().toISOString(),
        }) + '\n')
        fail++
      }
    } catch (e) {
      appendFileSync(outPath, JSON.stringify({
        openalex_id: item.openalex_id,
        display_name: item.display_name,
        year: item.year,
        error: e.message,
      }) + '\n')
      fail++
    }
    done++
    if (done % 25 === 0 || done === queue.length) {
      const rate = (done / ((Date.now() - startedAt) / 1000)).toFixed(2)
      console.log(`  ${done}/${queue.length}  ok=${ok} fail=${fail}  ${rate}/s`)
    }
    await sleep(args.delayMs)
  }
  console.log(`\n✓ Done in ${((Date.now() - startedAt) / 60000).toFixed(1)} min`)
  console.log(`  ok=${ok}  fail=${fail}`)
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

async function main() {
  const args = parseArgs()
  const db = new Database(DB_PATH, { readonly: !!args.validate })
  if (args.validate) return await validate(db, args.delayMs)
  return await scrape(db, args)
}

main().catch(e => { console.error(e); process.exit(1) })
