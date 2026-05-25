#!/usr/bin/env node
// PaperFate · PMCID-wide Europe PMC fullTextXML collector
//
// Uses the PMCID values already present in paperfate.db and fetches Europe PMC's
// fullTextXML mirror directly:
//   https://www.ebi.ac.uk/europepmc/webservices/rest/{PMCID}/fullTextXML
//
// This complements collect-europepmc-fulltext.mjs, which was built from the
// older PMID->PMCID map and does not necessarily cover every PMCID in the DB.

import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'europepmc-fulltext')
const API_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/'

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const RPS = Number(arg('rps', '5'))
const PARALLEL = Number(arg('parallel', '8'))
const LIMIT = Number(arg('limit', '0'))
const WAIT_EXISTING = ARGS.includes('--wait-existing')
const DRY_RUN = ARGS.includes('--dry-run')
const OUT_PATH = arg('out', join(OUT_DIR, `pmc-via-epmc-${todayStamp()}.jsonl`))

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function decodeEntities(s) { return String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'") }
function stripTags(s) { return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
function normalizePmcid(v) {
  const s = String(v || '').trim().toUpperCase()
  if (!s) return ''
  return s.startsWith('PMC') ? s : `PMC${s.replace(/^PMC/i, '')}`
}

class Limiter {
  constructor(perSec) {
    this.gap = 1000 / Math.max(0.1, perSec)
    this.last = 0
    this.queue = Promise.resolve()
  }
  async take() {
    const prev = this.queue
    let release
    this.queue = new Promise(resolve => { release = resolve })
    await prev
    const now = Date.now()
    const wait = Math.max(0, this.last + this.gap - now)
    if (wait) await sleep(wait)
    this.last = Date.now()
    release()
  }
}

function activeLegacyEpmcCollectors() {
  const script = [
    'Get-CimInstance Win32_Process -Filter "name = \'node.exe\'"',
    'Where-Object { $_.CommandLine -like "*collect-europepmc-fulltext.mjs*" }',
    'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
  ].join(' | ')
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function waitForLegacyCollectors() {
  if (!WAIT_EXISTING) return
  while (true) {
    const active = activeLegacyEpmcCollectors()
    if (!active.length) return
    console.log(`Waiting for existing collect-europepmc-fulltext.mjs process(es): ${active.map(x => x.split('\t')[0]).join(', ')}`)
    await sleep(5 * 60 * 1000)
  }
}

async function* readLines(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) yield line
}

function listJsonl(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl') && !name.startsWith('_'))
    .map(name => join(dir, name))
}

async function loadFetchedPmcids() {
  const done = new Set()
  const files = listJsonl(OUT_DIR)
  console.log(`Scanning existing Europe PMC outputs for resume skip (${files.length} files)`)
  for (const file of files) {
    let n = 0
    for await (const line of readLines(file)) {
      if (!line.trim()) continue
      const m = line.match(/"pmcid"\s*:\s*"([^"]+)"/)
      if (m) done.add(normalizePmcid(m[1]))
      n++
    }
    console.log(`  ${file.split(/[\\/]/).pop()} rows=${n} cumulative_pmcids=${done.size}`)
  }
  return done
}

function loadQueue(done) {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  const stmt = db.prepare(`
    SELECT doi, pmid, pmcid
    FROM papers
    WHERE pmcid IS NOT NULL
      AND pmcid != ''
      AND (epmc_body_word_count IS NULL OR epmc_body_word_count <= 0)
    ORDER BY pmcid
  `)
  const queue = []
  let total = 0
  let skippedDone = 0
  for (const row of stmt.iterate()) {
    total++
    const pmcid = normalizePmcid(row.pmcid)
    if (!pmcid) continue
    if (done.has(pmcid)) {
      skippedDone++
      continue
    }
    queue.push({ doi: row.doi || null, pmid: row.pmid || null, pmcid })
    if (LIMIT > 0 && queue.length >= LIMIT) break
  }
  db.close()
  console.log(`DB PMCID candidates without ingested EPMC: ${total}`)
  console.log(`Already present in JSONL outputs: ${skippedDone}`)
  console.log(`Queued: ${queue.length}`)
  return queue
}

async function fetchFullTextByPmcid(pmcid, limiter, attempts = 3) {
  await limiter.take()
  const url = `${API_BASE}${pmcid}/fullTextXML`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'paperfate/0.3 (mailto:beta@paperfate.com; +https://paperfate.com)' },
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
      await sleep(1500 * Math.pow(2, i))
    }
  }
  throw lastErr
}

function parseJats(xml) {
  const article = xml.match(/<article[^>]*>[\s\S]*?<\/article>/)?.[0] || xml
  const titleRaw = article.match(/<article-title>([\s\S]*?)<\/article-title>/)?.[1]
  const title = titleRaw ? stripTags(decodeEntities(titleRaw)) : null
  const absBlock = article.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/)?.[1]
  const abstract = absBlock ? stripTags(decodeEntities(absBlock)) : null
  const bodyBlock = article.match(/<body\b[^>]*>([\s\S]*?)<\/body>/)?.[1] || ''
  const sections = []
  const secRe = /<sec[^>]*>([\s\S]*?)<\/sec>/g
  let sm
  let methodsText = ''
  let resultsText = ''
  let discussionText = ''
  while ((sm = secRe.exec(bodyBlock)) !== null) {
    const sec = sm[1]
    const heading = sec.match(/<title>([^<]+)<\/title>/)?.[1] || null
    const decodedHeading = heading ? decodeEntities(heading) : null
    const text = stripTags(decodeEntities(sec))
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
  const dataAvail = stripTags(decodeEntities(article.match(/<sec[^>]*sec-type="[^"]*data[\s\S]*?<\/sec>/i)?.[0] || '')).slice(0, 400) || null
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

async function worker(queue, limiter, counters) {
  while (queue.length) {
    const item = queue.shift()
    if (!item) break
    try {
      const xml = await fetchFullTextByPmcid(item.pmcid, limiter)
      if (xml && !xml._missing) {
        const parsed = parseJats(xml)
        if (parsed.body_word_count > 100) {
          appendFileSync(OUT_PATH, JSON.stringify({ ...item, source: 'europepmc_pmcid', ...parsed, fetched_at: new Date().toISOString() }) + '\n')
          counters.ok++
        } else {
          counters.miss++
        }
      } else {
        counters.miss++
      }
    } catch (e) {
      counters.fail++
    }
    counters.done++
    if (counters.done % 100 === 0) {
      const rate = (counters.done / ((Date.now() - counters.t0) / 1000)).toFixed(1)
      const eta = ((counters.total - counters.done) / Number(rate || 1) / 60).toFixed(0)
      console.log(`  ${counters.done}/${counters.total} ok=${counters.ok} miss=${counters.miss} fail=${counters.fail} ${rate}/s eta=${eta}m`)
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log('PaperFate · PMCID-wide Europe PMC fullTextXML collector')
  console.log(`DB: ${DB_PATH}`)
  console.log(`Output: ${OUT_PATH}`)
  console.log(`Args: parallel=${PARALLEL} rps=${RPS} limit=${LIMIT || 'none'} wait_existing=${WAIT_EXISTING} dry_run=${DRY_RUN}`)
  await waitForLegacyCollectors()
  const done = await loadFetchedPmcids()
  const queue = loadQueue(done)
  if (DRY_RUN || queue.length === 0) {
    console.log(DRY_RUN ? 'dry-run complete' : 'nothing to do')
    return
  }
  const limiter = new Limiter(RPS)
  const counters = { done: 0, ok: 0, miss: 0, fail: 0, total: queue.length, t0: Date.now() }
  const workers = Array.from({ length: PARALLEL }, () => worker(queue, limiter, counters))
  await Promise.all(workers)
  console.log(`Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`ok=${counters.ok} miss=${counters.miss} fail=${counters.fail}`)
  if (existsSync(OUT_PATH)) console.log(`output: ${OUT_PATH} (${(statSync(OUT_PATH).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch(e => { console.error(e); process.exit(1) })
