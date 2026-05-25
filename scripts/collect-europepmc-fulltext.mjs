#!/usr/bin/env node
// PaperFate · Europe PMC fullTextXML collector
//
// Europe PMC mirrors many PMC OA papers and adds its own text-mined entities.
//
// Correct endpoint (verified 2026-05-21):
//   https://www.ebi.ac.uk/europepmc/webservices/rest/{PMCID}/fullTextXML
//   (e.g. .../PMC12900525/fullTextXML — no MED/ or PMC/ source prefix)
//
// Input strategy:
//   - Prefers PMID→PMCID mapping built by collect-pmc-fulltext.mjs
//     (data/pmc-fulltext/_pmid_to_pmcid.json)
//   - Falls back to EPMC search per PMID if no mapping yet
//
// Free, no key. Be polite (~5 req/s).

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'pubmed')
const OUT_DIR = join(DATA_ROOT, 'europepmc-fulltext')
const PMC_MAP = join(DATA_ROOT, 'pmc-fulltext', '_pmid_to_pmcid.json')

const REQ_PER_SEC = 4
const PARALLEL = 3
const API_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/'

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function decodeEntities(s) { return String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'") }
function stripTags(s) { return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }

class Limiter {
  constructor(perSec) { this.gap = 1000 / perSec; this.last = 0 }
  async take() {
    const now = Date.now()
    const wait = Math.max(0, this.last + this.gap - now)
    if (wait) await sleep(wait)
    this.last = Date.now()
  }
}

async function fetchFullTextByPmcid(pmcid, limiter, attempts = 3) {
  await limiter.take()
  // URL form: {API_BASE}{PMCID}/fullTextXML where PMCID includes the "PMC" prefix
  const url = `${API_BASE}${pmcid}/fullTextXML`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'paperfate/0.3 (mailto:beta@paperfate.com)' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) return { _missing: true }
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const txt = await res.text()
      if (txt.length < 200) return { _missing: true }
      return txt
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      const wait = 1500 * Math.pow(2, i)
      await sleep(wait)
    }
  }
  throw lastErr
}

// Reuse JATS parsing logic similar to PMC collector
function parseJats(xml) {
  const article = xml.match(/<article[^>]*>[\s\S]*?<\/article>/)?.[0] || xml
  const titleRaw = article.match(/<article-title>([\s\S]*?)<\/article-title>/)?.[1]
  const title = titleRaw ? stripTags(decodeEntities(titleRaw)) : null
  const absBlock = article.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/)?.[1]
  const abstract = absBlock ? stripTags(decodeEntities(absBlock)) : null
  const sections = []
  const bodyBlock = article.match(/<body\b[^>]*>([\s\S]*?)<\/body>/)?.[1] || ''
  const secRe = /<sec[^>]*>([\s\S]*?)<\/sec>/g
  let sm
  let methodsText = ''
  let resultsText = ''
  let discussionText = ''
  while ((sm = secRe.exec(bodyBlock)) !== null) {
    const sec = sm[1]
    const heading = sec.match(/<title>([^<]+)<\/title>/)?.[1] || null
    const text = stripTags(decodeEntities(sec))
    const decodedHeading = heading ? decodeEntities(heading) : null
    sections.push({ heading: decodedHeading, length: text.length })
    const h = String(decodedHeading || '').toLowerCase()
    if (/method|material|participant|patient|study design|statistical/.test(h)) methodsText += `\n${text}`
    else if (/result|finding/.test(h)) resultsText += `\n${text}`
    else if (/discussion|conclusion|interpret/.test(h)) discussionText += `\n${text}`
  }
  const figureCount = (article.match(/<fig\b/g) || []).length
  const tableCount = (article.match(/<table-wrap\b/g) || []).length
  const refCount = (article.match(/<ref\b/g) || []).length
  const bodyText = stripTags(decodeEntities(bodyBlock))
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0
  const figureCaptions = []
  const figRe = /<fig\b[^>]*>[\s\S]*?<caption>([\s\S]*?)<\/caption>[\s\S]*?<\/fig>/g
  let fm
  while ((fm = figRe.exec(article)) !== null) {
    figureCaptions.push(stripTags(decodeEntities(fm[1])).slice(0, 300))
    if (figureCaptions.length >= 20) break
  }
  // Funding / data availability hints
  const dataAvail = stripTags(decodeEntities(article.match(/<sec[^>]*sec-type="[^"]*data[\s\S]*?<\/sec>/i)?.[0] || ''))?.slice(0, 400) || null
  return {
    title,
    abstract_full: abstract,
    section_count: sections.length,
    sections,
    figure_count: figureCount,
    figure_captions: figureCaptions,
    table_count: tableCount,
    ref_count: refCount,
    body_word_count: wordCount,
    body_text: bodyText.slice(0, 120000),
    methods_text: methodsText.trim().slice(0, 30000) || null,
    results_text: resultsText.trim().slice(0, 30000) || null,
    discussion_text: discussionText.trim().slice(0, 30000) || null,
    data_availability: dataAvail,
  }
}

function* iterPmids() {
  if (!existsSync(IN_DIR)) return
  const files = readdirSync(IN_DIR).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
  const seen = new Set()
  for (const f of files) {
    const fpath = join(IN_DIR, f)
    if (statSync(fpath).size === 0) continue
    const lines = readFileSync(fpath, 'utf-8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        const pmid = String(r.pmid || '')
        if (!pmid || !/^\d+$/.test(pmid)) continue
        if (seen.has(pmid)) continue
        seen.add(pmid)
        yield pmid
      } catch {}
    }
  }
}

function loadFetched(file) {
  const done = new Set()
  if (!existsSync(file)) return done
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line); if (r.pmcid) done.add(String(r.pmcid)) } catch {}
  }
  return done
}

function loadPmidPmcidMap() {
  if (existsSync(PMC_MAP)) {
    try { return JSON.parse(readFileSync(PMC_MAP, 'utf-8')) } catch {}
  }
  return {}
}

async function worker(queue, limiter, outPath, counters) {
  while (queue.length) {
    const item = queue.shift()
    if (!item) break
    const { pmid, pmcid } = item
    try {
      const xml = await fetchFullTextByPmcid(pmcid, limiter)
      if (xml && !xml._missing) {
        const parsed = parseJats(xml)
        if (parsed && parsed.body_word_count > 100) {
          appendFileSync(outPath, JSON.stringify({ pmid, pmcid, source: 'europepmc', ...parsed }) + '\n')
          counters.ok++
        } else {
          counters.miss++
        }
      } else {
        counters.miss++
      }
    } catch {
      counters.fail++
    }
    counters.done++
    if (counters.done % 100 === 0) {
      const rate = (counters.done / ((Date.now() - counters.t0) / 1000)).toFixed(1)
      const eta = ((counters.total - counters.done) / Number(rate || 1) / 60).toFixed(0)
      console.log(`  ${counters.done}/${counters.total}  ok=${counters.ok} miss=${counters.miss} fail=${counters.fail}  ${rate}/s  eta ${eta}m`)
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)
  const already = loadFetched(outPath)
  const pmidMap = loadPmidPmcidMap()

  console.log(`PaperFate · Europe PMC fullTextXML collector (PMCID mode)`)
  console.log(`Input dir: ${IN_DIR}`)
  console.log(`PMID→PMCID map: ${PMC_MAP}`)
  console.log(`  mappings: ${Object.keys(pmidMap).length} (with PMCID: ${Object.values(pmidMap).filter(v => v).length})`)
  console.log(`Output: ${outPath}`)

  if (Object.keys(pmidMap).length === 0) {
    console.error('\n[ERR] No PMID→PMCID map found. Run collect-pmc-fulltext.mjs first to build the elink cache.')
    process.exit(1)
  }

  console.log(`\nBuilding queue from corpus PMIDs ∩ PMCID map …`)
  const corpusPmids = new Set(iterPmids())
  const queue = []
  for (const [pmid, pmcid] of Object.entries(pmidMap)) {
    if (!pmcid) continue
    if (!corpusPmids.has(pmid)) continue
    if (already.has(pmcid)) continue
    queue.push({ pmid, pmcid })
  }
  console.log(`  corpus PMIDs: ${corpusPmids.size}, already fetched: ${already.size}, queued: ${queue.length}\n`)
  if (queue.length === 0) { console.log('nothing to do'); return }

  const limiter = new Limiter(REQ_PER_SEC)
  const counters = { done: 0, ok: 0, miss: 0, fail: 0, total: queue.length, t0: Date.now() }
  const workers = Array.from({ length: PARALLEL }, () => worker(queue, limiter, outPath, counters))
  await Promise.all(workers)

  console.log(`\n✓ Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`  ok=${counters.ok}  miss=${counters.miss}  fail=${counters.fail}`)
  console.log(`  output: ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch(e => { console.error(e); process.exit(1) })
