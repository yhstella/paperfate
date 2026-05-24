#!/usr/bin/env node
// PaperFate · OA PDF text extractor
//
// Reads Unpaywall records (best_oa_url_for_pdf), downloads OA PDFs,
// extracts plain text + per-page text via pdfjs-dist.
//
// Strategy:
//   - Skip if PMC or Europe PMC already has full text for this paper
//   - Per-host throttling (max 2 req/s per host, 10 parallel across hosts)
//   - Save extracted text in JSONL; raw PDFs gzipped in subdir for re-extraction
//   - Idempotent — skip already-extracted DOIs
//
// CAUTION: scraping publisher sites at scale may trigger CAPTCHA or IP blocks.
// Start small (--limit N) to test. Defaults to 5000 papers per run.

import Database from 'better-sqlite3'
import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, appendFileSync, createReadStream, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const UNPAY_DIR = join(DATA_ROOT, 'unpaywall')
const OUT_DIR = join(DATA_ROOT, 'pdf-fulltext')
const PDF_CACHE_DIR = join(OUT_DIR, 'pdfs')

function parseArgs() {
  const a = process.argv.slice(2)
  const val = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i+1] : d }
  return {
    limit: Number(val('--limit', 5000)),
    parallel: Number(val('--parallel', 6)),
    perHostRps: Number(val('--per-host-rps', 1.5)),
    minBodyChars: Number(val('--min-body-chars', 500)),
    keepPdf: a.includes('--keep-pdf'),
    skipDbFulltext: !a.includes('--no-skip-db-fulltext'),
    hostBlockThreshold: Number(val('--host-block-threshold', 20)),
  }
}
const ARGS = parseArgs()

function pad(n) { return String(n).padStart(2, '0') }
function todayStamp() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function hostOf(u) { try { return new URL(u).host } catch { return 'unknown' } }
function doiSlug(doi) { return doi.replace(/[^\w.-]/g, '_').slice(0, 120) }

// Per-host limiter
class HostLimiter {
  constructor(perSec) { this.perSec = perSec; this.last = new Map() }
  async take(host) {
    const gap = 1000 / this.perSec
    const now = Date.now()
    const lastT = this.last.get(host) || 0
    const wait = Math.max(0, lastT + gap - now)
    if (wait) await sleep(wait)
    this.last.set(host, Date.now())
  }
}

async function* readLines(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) yield line
}

async function loadDoneDois() {
  const done = new Set()
  if (!existsSync(OUT_DIR)) return done
  const files = readdirSync(OUT_DIR).filter(f => /^(all|errors)-.*\.jsonl$/.test(f))
  for (const f of files) {
    for await (const line of readLines(join(OUT_DIR, f))) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line); if (r.doi) done.add(r.doi.toLowerCase()) } catch {}
    }
  }
  return done
}

function loadSkipDoisFromDb() {
  const skip = new Set()
  if (!ARGS.skipDbFulltext || !existsSync(DB_PATH)) return skip
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  const stmt = db.prepare(`
    SELECT lower(doi) AS doi
    FROM papers
    WHERE doi IS NOT NULL
      AND (
        pmc_body_word_count IS NOT NULL
        OR epmc_body_word_count IS NOT NULL
        OR pdf_body_words IS NOT NULL
      )
  `)
  for (const row of stmt.iterate()) {
    if (row.doi) skip.add(row.doi)
  }
  db.close()
  return skip
}

async function* iterUnpaywallTargets() {
  if (!existsSync(UNPAY_DIR)) return
  const { createReadStream } = await import('node:fs')
  const { createInterface } = await import('node:readline')
  const files = readdirSync(UNPAY_DIR).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
  const seen = new Set()
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(UNPAY_DIR, f), { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        const doi = (r.doi || '').toLowerCase().trim()
        const url = r.best_oa_url_for_pdf
        if (!doi || !url) continue
        if (seen.has(doi)) continue
        seen.add(doi)
        yield { doi, url, host: hostOf(url), is_oa: r.is_oa, oa_status: r.oa_status, version: r.best_oa_version, license: r.best_oa_license }
      } catch {}
    }
  }
}

async function fetchPdf(url, host, limiter, attempts = 2) {
  await limiter.take(host)
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'paperfate/0.3 (mailto:beta@paperfate.com; +https://paperfate.com)',
          'Accept': 'application/pdf,*/*;q=0.5',
        },
        redirect: 'follow',
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 404) return { _missing: true }
      if (res.status === 403 || res.status === 429) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const ct = res.headers.get('content-type') || ''
      if (!/pdf|octet-stream/i.test(ct) && !url.toLowerCase().endsWith('.pdf')) {
        return { _wrong_content_type: ct.slice(0, 80) }
      }
      const buf = await res.arrayBuffer()
      if (buf.byteLength < 5000) return { _too_small: buf.byteLength }
      return buf
    } catch (e) {
      clearTimeout(timer)
      if (i === attempts - 1) throw e
      await sleep(2000 * Math.pow(2, i))
    }
  }
}

async function extractPdfText(arrayBuffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    useSystemFonts: true,
    verbosity: pdfjsLib.VerbosityLevel?.ERRORS ?? 0,
  }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      pages.push(tc.items.map(it => ('str' in it ? it.str : '')).join(' '))
    } catch {
      pages.push('')
    }
  }
  await doc.cleanup()
  return { numPages: doc.numPages, pages }
}

async function savePdfGzipped(arrayBuffer, doi) {
  mkdirSync(PDF_CACHE_DIR, { recursive: true })
  const slug = doiSlug(doi)
  const path = join(PDF_CACHE_DIR, `${slug}.pdf.gz`)
  await pipeline(
    Readable.from(Buffer.from(arrayBuffer)),
    createGzip({ level: 6 }),
    createWriteStream(path)
  )
  return path
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)
  const errPath = join(OUT_DIR, `errors-${todayStamp()}.jsonl`)
  console.log(`PaperFate · OA PDF text extractor`)
  console.log(`Output: ${outPath}`)
  console.log(`Args:   limit=${ARGS.limit}  parallel=${ARGS.parallel}  per-host-rps=${ARGS.perHostRps}  keep-pdf=${ARGS.keepPdf}  skip-db-fulltext=${ARGS.skipDbFulltext}  host-block-threshold=${ARGS.hostBlockThreshold}`)
  console.log(`\nLoading already extracted PDF DOI set …`)
  const done = await loadDoneDois()
  console.log(`  ${done.size} DOI(s) already extracted in pdf-fulltext outputs`)
  console.log(`\nLoading DB skip set for PMC/EPMC/PDF-covered DOI(s) …`)
  const skipDois = loadSkipDoisFromDb()
  console.log(`  ${skipDois.size} DOI(s) skipped because DB already has PMC/EPMC/PDF fulltext coverage`)

  console.log(`\nScanning Unpaywall candidates …`)
  const all = []
  for await (const t of iterUnpaywallTargets()) all.push(t)
  const queue = all.filter(t => !done.has(t.doi) && !skipDois.has(t.doi)).slice(0, ARGS.limit)
  console.log(`  total Unpaywall PDFs: ${all.length}, already extracted: ${done.size}, db-skipped: ${skipDois.size}, queued (capped): ${queue.length}\n`)
  if (queue.length === 0) { console.log('nothing to do'); return }

  const limiter = new HostLimiter(ARGS.perHostRps)
  const hostFailures = new Map()
  const blockedHosts = new Set()
  const counters = { done: 0, ok: 0, miss: 0, fail: 0, t0: Date.now(), totalChars: 0, total: queue.length }
  function recordHostFailure(host, message) {
    if (!/^HTTP (403|429)\b/.test(String(message || ''))) return
    const n = (hostFailures.get(host) || 0) + 1
    hostFailures.set(host, n)
    if (n >= ARGS.hostBlockThreshold && !blockedHosts.has(host)) {
      blockedHosts.add(host)
      console.log(`  host-block ${host} after ${n} HTTP 403/429 failures`)
    }
  }
  async function worker() {
    while (queue.length) {
      const t = queue.shift()
      if (!t) break
      try {
        if (blockedHosts.has(t.host)) {
          appendFileSync(errPath, JSON.stringify({ doi: t.doi, url: t.url, host: t.host, error: 'host blocked after repeated HTTP 403/429' }) + '\n')
          counters.miss++
          counters.done++
          continue
        }
        const buf = await fetchPdf(t.url, t.host, limiter)
        if (!buf || buf._missing || buf._wrong_content_type || buf._too_small) {
          appendFileSync(errPath, JSON.stringify({ doi: t.doi, url: t.url, host: t.host, error: buf?._wrong_content_type ? `wrong ct ${buf._wrong_content_type}` : buf?._too_small ? `too small ${buf._too_small}` : '404' }) + '\n')
          counters.miss++
        } else {
          const { numPages, pages } = await extractPdfText(buf)
          const body = pages.join('\n\n')
          if (body.length < ARGS.minBodyChars) {
            counters.miss++
          } else {
            let pdfPath = null
            if (ARGS.keepPdf) pdfPath = await savePdfGzipped(buf, t.doi)
            appendFileSync(outPath, JSON.stringify({
              doi: t.doi, url: t.url, host: t.host, is_oa: t.is_oa, oa_status: t.oa_status, version: t.version, license: t.license,
              num_pages: numPages, body_chars: body.length, body_words: body.split(/\s+/).length,
              body, pdf_cache: pdfPath, extracted_at: new Date().toISOString(),
            }) + '\n')
            counters.ok++
            counters.totalChars += body.length
          }
        }
      } catch (e) {
        recordHostFailure(t.host, e.message)
        appendFileSync(errPath, JSON.stringify({ doi: t.doi, url: t.url, host: t.host, error: String(e.message).slice(0, 200) }) + '\n')
        counters.fail++
      }
      counters.done++
      if (counters.done % 25 === 0) {
        const rate = (counters.done / ((Date.now() - counters.t0) / 1000)).toFixed(2)
        const avgChars = counters.ok ? Math.round(counters.totalChars / counters.ok) : 0
        console.log(`  ${counters.done}/${counters.total}  ok=${counters.ok} miss=${counters.miss} fail=${counters.fail}  ${rate}/s  avg ${avgChars} chars/paper`)
      }
    }
  }
  const workers = Array.from({ length: ARGS.parallel }, () => worker())
  await Promise.all(workers)

  console.log(`\n✓ Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`  ok=${counters.ok}  miss=${counters.miss}  fail=${counters.fail}`)
  if (existsSync(outPath)) console.log(`  output: ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch(e => { console.error(e); process.exit(1) })
