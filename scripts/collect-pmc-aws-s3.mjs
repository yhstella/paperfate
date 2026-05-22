#!/usr/bin/env node
// PaperFate · PMC AWS S3 Open Data harvester
//
// NCBI mirrors the PMC Open Access subset on AWS S3:
//   https://pmc-oa-opendata.s3.amazonaws.com/{PMCID}.{ver}/{PMCID}.{ver}.xml
//
// AWS S3 is dramatically faster and more reliable than ftp.ncbi.nlm.nih.gov
// (which from this network averages ~25 KB/s with TLS resets).
//
// Strategy:
//   * Reads PMCIDs from paperfate.db without pmc_body_word_count
//   * Tries versions 1..3 (most papers are .1; amendments bump version)
//   * 20-way parallel fetch + 10/s polite rate
//   * Parses JATS XML into the same shape as collect-pmc-fulltext.mjs
//   * Output: data/pmc-fulltext/aws-s3-{date}.jsonl (auto-ingested via ingestPmcFulltext)
//
// Usage:
//   node scripts/collect-pmc-aws-s3.mjs [--parallel=20] [--rps=15] [--limit=N]

import Database from 'better-sqlite3'
import {
  appendFileSync, createReadStream, existsSync, mkdirSync,
  readdirSync, statSync,
} from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const OUT_DIR = join(DATA_ROOT, 'pmc-fulltext')
const S3_BASE = 'https://pmc-oa-opendata.s3.amazonaws.com'

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const PARALLEL = Number(arg('parallel', '20'))
const RPS = Number(arg('rps', '15'))
const LIMIT = Number(arg('limit', '0'))
const MAX_VERSION = Number(arg('max-version', '3'))

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function decodeEntities(s) { return String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'") }
function stripTags(s) { return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }

mkdirSync(OUT_DIR, { recursive: true })
const OUT_PATH = join(OUT_DIR, `aws-s3-${todayStamp()}.jsonl`)

class TokenBucket {
  constructor(rps) { this.rps = rps; this.tokens = rps; this.last = Date.now() }
  async take() {
    while (true) {
      const now = Date.now()
      this.tokens = Math.min(this.rps, this.tokens + (now - this.last) * this.rps / 1000)
      this.last = now
      if (this.tokens >= 1) { this.tokens--; return }
      await sleep(50)
    }
  }
}

async function loadAlreadyDone() {
  const done = new Set()
  for (const name of readdirSync(OUT_DIR)) {
    if (!name.endsWith('.jsonl') || name.startsWith('_')) continue
    const p = join(OUT_DIR, name)
    const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      const m = line.match(/"pmcid"\s*:\s*"([^"]+)"/)
      if (m) done.add(m[1].toUpperCase())
    }
  }
  console.log(`already extracted in pmc-fulltext outputs: ${done.size.toLocaleString()}`)
  return done
}

function loadQueue(done) {
  console.log('Querying DB for PMCIDs without pmc_body_word_count...')
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  const rows = db.prepare(`
    SELECT doi, pmid, pmcid
    FROM papers
    WHERE pmcid IS NOT NULL AND pmcid != ''
      AND (pmc_body_word_count IS NULL OR pmc_body_word_count <= 0)
    ORDER BY pmcid
  `).all()
  db.close()
  const queue = []
  let skipped = 0
  for (const r of rows) {
    const pmcid = String(r.pmcid).toUpperCase()
    if (!pmcid.startsWith('PMC')) continue
    if (done.has(pmcid)) { skipped++; continue }
    queue.push({ doi: r.doi || null, pmid: r.pmid || null, pmcid })
    if (LIMIT > 0 && queue.length >= LIMIT) break
  }
  console.log(`  candidates ${rows.length.toLocaleString()}  skipped(already-done) ${skipped.toLocaleString()}  queued ${queue.length.toLocaleString()}`)
  return queue
}

async function fetchXml(pmcid, limiter) {
  for (let ver = 1; ver <= MAX_VERSION; ver++) {
    await limiter.take()
    const url = `${S3_BASE}/${pmcid}.${ver}/${pmcid}.${ver}.xml`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (res.status === 200) {
        const txt = await res.text()
        if (txt.length > 200) return { xml: txt, version: ver }
      }
      // 404 or empty: try next version
    } catch {
      // network error: retry next version
    }
  }
  return null
}

function parseJats(xml) {
  const article = xml.match(/<article[^>]*>[\s\S]*?<\/article>/)?.[0] || xml
  const pmidMatch = article.match(/<article-id\s+pub-id-type="pmid"[^>]*>(\d+)<\/article-id>/i)
  const pmid = pmidMatch ? pmidMatch[1] : null
  const doiMatch = article.match(/<article-id\s+pub-id-type="doi"[^>]*>([^<]+)<\/article-id>/i)
  const doi = doiMatch ? doiMatch[1].trim().toLowerCase() : null
  const titleRaw = article.match(/<article-title>([\s\S]*?)<\/article-title>/)?.[1]
  const title = titleRaw ? stripTags(decodeEntities(titleRaw)) : null
  const absBlock = article.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/)?.[1]
  const abstract = absBlock ? stripTags(decodeEntities(absBlock)) : null
  const bodyBlock = article.match(/<body>([\s\S]*?)<\/body>/)?.[1] || ''
  const sections = []
  let methodsText = '', resultsText = '', discussionText = ''
  const secRe = /<sec[^>]*>([\s\S]*?)<\/sec>/g
  let sm
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
    pmid, doi, title,
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
      const res = await fetchXml(item.pmcid, limiter)
      if (!res) {
        counters.miss++
      } else {
        const parsed = parseJats(res.xml)
        if (parsed.body_word_count > 100) {
          appendFileSync(OUT_PATH, JSON.stringify({
            pmcid: item.pmcid,
            source: 'pmc_aws_s3',
            version: res.version,
            ...parsed,
            fetched_at: new Date().toISOString(),
          }) + '\n')
          counters.ok++
        } else {
          counters.short++
        }
      }
    } catch {
      counters.fail++
    }
    counters.done++
    if (counters.done % 250 === 0) {
      const elapsed = (Date.now() - counters.t0) / 1000
      const rate = (counters.done / Math.max(1, elapsed)).toFixed(1)
      const eta = ((counters.total - counters.done) / Math.max(1, rate) / 60).toFixed(0)
      console.log(`  ${counters.done.toLocaleString()}/${counters.total.toLocaleString()} ok=${counters.ok.toLocaleString()} miss=${counters.miss.toLocaleString()} short=${counters.short} fail=${counters.fail} ${rate}/s eta=${eta}m`)
    }
  }
}

async function main() {
  console.log('PaperFate · PMC AWS S3 harvester')
  console.log(`DB: ${DB_PATH}`)
  console.log(`Output: ${OUT_PATH}`)
  console.log(`Args: parallel=${PARALLEL} rps=${RPS} limit=${LIMIT || 'none'} max_version=${MAX_VERSION}`)
  console.log('')
  const done = await loadAlreadyDone()
  const queue = loadQueue(done)
  if (queue.length === 0) { console.log('nothing to do'); return }
  const limiter = new TokenBucket(RPS)
  const counters = { done: 0, ok: 0, miss: 0, short: 0, fail: 0, total: queue.length, t0: Date.now() }
  await Promise.all(Array.from({ length: PARALLEL }, () => worker(queue, limiter, counters)))
  console.log(`\nDone in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`ok=${counters.ok.toLocaleString()}  miss=${counters.miss.toLocaleString()}  short=${counters.short}  fail=${counters.fail}`)
  if (existsSync(OUT_PATH)) console.log(`output: ${OUT_PATH} (${(statSync(OUT_PATH).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch(e => { console.error(e); process.exit(1) })
