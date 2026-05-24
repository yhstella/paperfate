#!/usr/bin/env node
// PaperFate PMC AWS S3 Open Data harvester.
//
// NCBI mirrors the PMC Open Access subset on AWS S3:
//   https://pmc-oa-opendata.s3.amazonaws.com/{PMCID}.{ver}/{PMCID}.{ver}.xml
//
// Strategy:
//   * Reads PMCIDs from paperfate.db without pmc_body_word_count.
//   * Tries versions 1..MAX_VERSION, usually .1.
//   * Parallel fetch with a process-wide polite rate limiter.
//   * Parses JATS XML into the same shape as collect-pmc-fulltext.mjs.
//   * Appends JSONL to data/pmc-fulltext/aws-s3-{date}.jsonl.
//
// Usage:
//   node --expose-gc scripts/collect-pmc-aws-s3.mjs --parallel=20 --rps=20

import Database from 'better-sqlite3'
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeSync,
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
const HEARTBEAT_SEC = Number(arg('heartbeat-sec', '300'))
const GC_SEC = Number(arg('gc-sec', '60'))
const FSYNC_EVERY = Number(arg('fsync-every', '500'))

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function timeStamp() {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}
function stripTags(s) {
  return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

mkdirSync(OUT_DIR, { recursive: true })
const OUT_PATH = join(OUT_DIR, `aws-s3-${todayStamp()}.jsonl`)
const OUT_FD = openSync(OUT_PATH, 'a')
let writesSinceFsync = 0
let shutdownRequested = false

function logError(prefix, e) {
  console.error(`[${prefix} ${new Date().toISOString()}]`, e?.stack || e)
}

process.on('unhandledRejection', e => {
  logError('UNHANDLED', e)
})

process.on('uncaughtException', e => {
  logError('UNCAUGHT', e)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`[${sig} ${new Date().toISOString()}] graceful shutdown requested`)
    shutdownRequested = true
  })
}

class TokenBucket {
  constructor(rps) {
    this.gapMs = Math.max(1, 1000 / Math.max(1, rps))
    this.nextAt = 0
    this.chain = Promise.resolve()
  }

  async take() {
    const prior = this.chain
    let release
    this.chain = new Promise(resolve => { release = resolve })
    await prior
    const wait = Math.max(0, this.nextAt - Date.now())
    if (wait) await sleep(wait)
    this.nextAt = Date.now() + this.gapMs
    release()
  }
}

async function loadAlreadyDone() {
  const done = new Set()
  for (const name of readdirSync(OUT_DIR)) {
    if (!name.endsWith('.jsonl') || name.startsWith('_')) continue
    const p = join(OUT_DIR, name)
    const rl = createInterface({
      input: createReadStream(p, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
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
  db.pragma('busy_timeout = 60000')

  const rows = db.prepare(`
    SELECT doi, pmid, pmcid
    FROM papers
    WHERE pmcid IS NOT NULL AND pmcid != ''
      AND (pmc_body_word_count IS NULL OR pmc_body_word_count <= 0)
    ORDER BY pmcid
  `).iterate()

  const queue = []
  let candidates = 0
  let skipped = 0
  for (const r of rows) {
    candidates++
    const pmcid = String(r.pmcid).toUpperCase()
    if (!pmcid.startsWith('PMC')) continue
    if (done.has(pmcid)) {
      skipped++
      continue
    }
    queue.push({ doi: r.doi || null, pmid: r.pmid || null, pmcid })
    if (LIMIT > 0 && queue.length >= LIMIT) break
  }
  db.close()

  console.log(`  candidates ${candidates.toLocaleString()}  skipped(already-done) ${skipped.toLocaleString()}  queued ${queue.length.toLocaleString()}`)
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
    } catch (e) {
      logError(`FETCH ${pmcid} v${ver}`, e)
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
  const bodyBlock = article.match(/<body\b[^>]*>([\s\S]*?)<\/body>/)?.[1] || ''
  const sections = []
  let methodsText = ''
  let resultsText = ''
  let discussionText = ''
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
    pmid,
    doi,
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

function appendJsonl(row) {
  writeSync(OUT_FD, JSON.stringify(row) + '\n')
  writesSinceFsync++
  if (FSYNC_EVERY > 0 && writesSinceFsync >= FSYNC_EVERY) {
    fsyncSync(OUT_FD)
    writesSinceFsync = 0
  }
}

function progressLine(queue, counters, prefix = '  ') {
  const elapsed = (Date.now() - counters.t0) / 1000
  const rateNum = counters.done / Math.max(1, elapsed)
  const rate = rateNum.toFixed(1)
  const eta = ((counters.total - counters.done) / Math.max(0.001, rateNum) / 60).toFixed(0)
  return `${prefix}${counters.done.toLocaleString()}/${counters.total.toLocaleString()} queue=${queue.length.toLocaleString()} ok=${counters.ok.toLocaleString()} miss=${counters.miss.toLocaleString()} short=${counters.short} fail=${counters.fail} worker_fail=${counters.worker_fail} ${rate}/s eta=${eta}m`
}

async function worker(workerId, queue, limiter, counters) {
  try {
    while (queue.length && !shutdownRequested) {
      const item = queue.shift()
      if (!item) break
      try {
        const res = await fetchXml(item.pmcid, limiter)
        if (!res) {
          counters.miss++
        } else {
          const parsed = parseJats(res.xml)
          if (parsed.body_word_count > 100) {
            appendJsonl({
              pmcid: item.pmcid,
              source: 'pmc_aws_s3',
              version: res.version,
              ...parsed,
              fetched_at: new Date().toISOString(),
            })
            counters.ok++
          } else {
            counters.short++
          }
        }
      } catch (e) {
        counters.fail++
        logError(`WORKER ${workerId} ITEM ${item?.pmcid || 'unknown'}`, e)
      }
      counters.done++
      if (counters.done % 250 === 0) console.log(progressLine(queue, counters))
    }
  } catch (e) {
    counters.worker_fail++
    logError(`WORKER ${workerId} FATAL`, e)
  }
}

function startHeartbeat(queue, counters) {
  if (HEARTBEAT_SEC <= 0) return null
  const timer = setInterval(() => {
    const mem = process.memoryUsage()
    const rss = (mem.rss / 1024 / 1024).toFixed(0)
    const heap = (mem.heapUsed / 1024 / 1024).toFixed(0)
    console.log(`[HEARTBEAT ${timeStamp()}] ${progressLine(queue, counters, '')} rss=${rss}MB heap=${heap}MB`)
  }, HEARTBEAT_SEC * 1000)
  timer.unref?.()
  return timer
}

function startGcTimer() {
  if (GC_SEC <= 0 || typeof global.gc !== 'function') return null
  const timer = setInterval(() => {
    try {
      global.gc()
      console.log(`[GC ${timeStamp()}] explicit global.gc() completed`)
    } catch (e) {
      logError('GC', e)
    }
  }, GC_SEC * 1000)
  timer.unref?.()
  return timer
}

async function main() {
  console.log('PaperFate PMC AWS S3 harvester')
  console.log(`DB: ${DB_PATH}`)
  console.log(`Output: ${OUT_PATH}`)
  console.log(`Args: parallel=${PARALLEL} rps=${RPS} limit=${LIMIT || 'none'} max_version=${MAX_VERSION} heartbeat_sec=${HEARTBEAT_SEC} gc_sec=${GC_SEC} fsync_every=${FSYNC_EVERY}`)
  console.log(`GC: ${typeof global.gc === 'function' ? 'available' : 'not available; run node with --expose-gc for explicit GC'}`)
  console.log('')

  const done = await loadAlreadyDone()
  const queue = loadQueue(done)
  if (queue.length === 0) {
    console.log('nothing to do')
    return
  }

  const limiter = new TokenBucket(RPS)
  const counters = {
    done: 0,
    ok: 0,
    miss: 0,
    short: 0,
    fail: 0,
    worker_fail: 0,
    total: queue.length,
    t0: Date.now(),
  }
  const heartbeat = startHeartbeat(queue, counters)
  const gcTimer = startGcTimer()
  const settled = await Promise.allSettled(
    Array.from({ length: PARALLEL }, (_, i) => worker(i + 1, queue, limiter, counters)),
  )

  heartbeat && clearInterval(heartbeat)
  gcTimer && clearInterval(gcTimer)
  for (const [i, result] of settled.entries()) {
    if (result.status === 'rejected') logError(`WORKER_PROMISE ${i + 1}`, result.reason)
  }
  if (writesSinceFsync > 0) fsyncSync(OUT_FD)

  console.log(`\nDone in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`ok=${counters.ok.toLocaleString()}  miss=${counters.miss.toLocaleString()}  short=${counters.short}  fail=${counters.fail}  worker_fail=${counters.worker_fail}`)
  if (existsSync(OUT_PATH)) console.log(`output: ${OUT_PATH} (${(statSync(OUT_PATH).size / 1024 / 1024).toFixed(1)} MB)`)
}

main()
  .catch(e => {
    logError('MAIN', e)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      if (writesSinceFsync > 0) fsyncSync(OUT_FD)
      closeSync(OUT_FD)
    } catch (e) {
      logError('CLOSE', e)
    }
  })
