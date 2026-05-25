#!/usr/bin/env node
// PaperFate · PMC Open Access full-text collector
//
// Two-stage workflow:
//   STAGE A: elink — given PMIDs, get PMID→PMCID mapping (free, batched)
//   STAGE B: efetch (db=pmc) — given PMCIDs, get JATS XML full text
//            Parse <body><sec>, figures, references, statements
//
// Output: data/pmc-fulltext/all-<date>.jsonl, idempotent.
// Note: NCBI rate limit shared with other E-utilities — set NCBI_API_KEY
// for 10 req/s (vs 3 without). Stage A is fast (200 PMIDs/call); stage B is
// per-PMCID, ~10/sec with key.

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const IN_DIR  = join(DATA_ROOT, 'pubmed')
const OUT_DIR = join(DATA_ROOT, 'pmc-fulltext')
const MAP_PATH = join(OUT_DIR, '_pmid_to_pmcid.json')

const NCBI_API_KEY = process.env.NCBI_API_KEY || ''
const NCBI_EMAIL = process.env.NCBI_EMAIL || 'beta@paperfate.com'
const REQ_PER_SEC = NCBI_API_KEY ? 10 : 3
const PARALLEL = 4
const ELINK = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi'
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'

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

function ncbiParams(extra = {}) {
  const p = { ...extra, tool: 'paperfate', email: NCBI_EMAIL }
  if (NCBI_API_KEY) p.api_key = NCBI_API_KEY
  return p
}

const DEBUG = process.env.PFT_DEBUG === '1'
async function fetchUrl(base, params, limiter, attempts = 6, timeoutMs = 30000) {
  // Build query string supporting array values (multiple &id=X params)
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const vv of v) usp.append(k, vv)
    else usp.append(k, v)
  }
  const qs = usp.toString()
  // Use POST for very long query strings (elink with 100+ ids easily exceeds URL limits)
  const usePost = qs.length > 2000
  const url = usePost ? base : `${base}?${qs}`
  let lastErr
  for (let i = 0; i < attempts; i++) {
    await limiter.take()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const t0 = Date.now()
    try {
      const res = await fetch(url, {
        method: usePost ? 'POST' : 'GET',
        headers: {
          'User-Agent': `paperfate/0.3 (mailto:${NCBI_EMAIL})`,
          'Connection': 'close',
          ...(usePost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: usePost ? qs : undefined,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const txt = await res.text()
      if (DEBUG) console.log(`    [fetch ok ${i+1}/${attempts}] ${Date.now()-t0}ms ${txt.length}b`)
      return txt
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (DEBUG) console.log(`    [fetch fail ${i+1}/${attempts}] ${Date.now()-t0}ms ${e.message}`)
      await sleep(1500)
    }
  }
  throw lastErr
}

// STAGE A: PMID → PMCID
// Primary path uses Europe PMC search API: ~6x faster than NCBI elink, same
// coverage. Batches of 100 PMIDs per call, returns PMCID directly.
// Falls back to NCBI elink only if EPMC is unreachable.
const EPMC_SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'

async function epmcMapBatch(pmids, limiter) {
  // EPMC accepts up to ~100 PMIDs in OR query
  await limiter.take()
  const q = pmids.map(p => 'EXT_ID:' + p).join(' OR ')
  const params = new URLSearchParams({ query: q, format: 'json', pageSize: '200', resultType: 'lite' })
  let lastErr
  for (let i = 0; i < 4; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 30000)
    try {
      const res = await fetch(EPMC_SEARCH + '?' + params.toString(), { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const out = {}
      for (const r of (data.resultList?.result || [])) {
        if (r.pmid) out[r.pmid] = r.pmcid || null
      }
      // PMIDs that didn't come back in resultList — record as known-null
      for (const p of pmids) if (!(p in out)) out[p] = null
      return out
    } catch (e) { clearTimeout(timer); lastErr = e; await sleep(1500) }
  }
  throw lastErr
}

async function elinkBatch(pmids, limiter) {
  // NCBI fallback (kept for completeness, but EPMC is primary).
  const xml = await fetchUrl(ELINK, ncbiParams({
    dbfrom: 'pubmed', db: 'pmc', linkname: 'pubmed_pmc',
    id: pmids,
  }), limiter)
  const mapping = {}
  const linkSetRe = /<LinkSet>[\s\S]*?<\/LinkSet>/g
  let m
  while ((m = linkSetRe.exec(xml)) !== null) {
    const ls = m[0]
    const srcMatch = ls.match(/<IdList>\s*<Id>(\d+)<\/Id>\s*<\/IdList>/)
    const srcPmid = srcMatch?.[1]
    if (!srcPmid) continue
    const linkMatch = ls.match(/<LinkSetDb>[\s\S]*?<LinkName>pubmed_pmc<\/LinkName>[\s\S]*?<Link>\s*<Id>(\d+)<\/Id>/)
    const pmcid = linkMatch?.[1]
    if (pmcid) mapping[srcPmid] = `PMC${pmcid}`
  }
  return mapping
}

// STAGE B: PMC full text via efetch
async function efetchPmcXml(pmcid, limiter) {
  // pmcid is like "PMC1234567"; strip the PMC prefix for efetch
  const numericId = pmcid.replace(/^PMC/i, '')
  return await fetchUrl(EFETCH, ncbiParams({
    db: 'pmc', id: numericId, rettype: 'xml', retmode: 'xml',
  }), limiter)
}

function parsePmcJats(xml) {
  // Compact extraction. Sections, figures captions, table captions, reference count.
  const article = xml.match(/<article[^>]*>[\s\S]*?<\/article>/)?.[0] || xml
  // Front matter
  const titleRaw = article.match(/<article-title>([\s\S]*?)<\/article-title>/)?.[1]
  const title = titleRaw ? stripTags(decodeEntities(titleRaw)) : null
  // Abstract (may be structured)
  const absBlock = article.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/)?.[1]
  const abstract = absBlock ? stripTags(decodeEntities(absBlock)) : null
  // Body sections
  const sections = []
  const bodyBlock = article.match(/<body>([\s\S]*?)<\/body>/)?.[1] || ''
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
  // Figures + tables
  const figureCount = (article.match(/<fig\b/g) || []).length
  const tableCount = (article.match(/<table-wrap\b/g) || []).length
  const figureCaptions = []
  const figRe = /<fig\b[^>]*>[\s\S]*?<caption>([\s\S]*?)<\/caption>[\s\S]*?<\/fig>/g
  let fm
  while ((fm = figRe.exec(article)) !== null) {
    figureCaptions.push(stripTags(decodeEntities(fm[1])).slice(0, 300))
    if (figureCaptions.length >= 20) break
  }
  // References
  const refCount = (article.match(/<ref\b/g) || []).length
  // Statements (data availability, ethics, COI)
  const dataStatement = stripTags(decodeEntities(article.match(/<custom-meta[^>]*>\s*<meta-name>data-availability[\s\S]*?<meta-value>([\s\S]*?)<\/meta-value>/i)?.[1] || article.match(/<sec[^>]*sec-type="[^"]*data[\s\S]*?<\/sec>/i)?.[0] || ''))?.slice(0, 500) || null
  const ethics = stripTags(decodeEntities(article.match(/<sec[^>]*sec-type="[^"]*ethics[\s\S]*?<\/sec>/i)?.[0] || ''))?.slice(0, 500) || null
  const coi = stripTags(decodeEntities(article.match(/<fn-group[^>]*>[\s\S]*?coi-statement[\s\S]*?<\/fn-group>/i)?.[0] || article.match(/<sec[^>]*sec-type="[^"]*coi[\s\S]*?<\/sec>/i)?.[0] || ''))?.slice(0, 300) || null
  // Total body text length
  const bodyText = stripTags(decodeEntities(bodyBlock))
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0

  return {
    title,
    abstract_full: abstract,
    sections,                  // [{heading, length}]
    section_count: sections.length,
    figure_count: figureCount,
    figure_captions: figureCaptions,
    table_count: tableCount,
    ref_count: refCount,
    body_word_count: wordCount,
    body_text: bodyText.slice(0, 120000),
    methods_text: methodsText.trim().slice(0, 30000) || null,
    results_text: resultsText.trim().slice(0, 30000) || null,
    discussion_text: discussionText.trim().slice(0, 30000) || null,
    data_availability: dataStatement,
    ethics_statement: ethics,
    conflict_of_interest: coi,
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

function loadMap() {
  if (existsSync(MAP_PATH)) {
    try { return JSON.parse(readFileSync(MAP_PATH, 'utf-8')) } catch {}
  }
  return {}
}

function saveMap(map) {
  writeFileSync(MAP_PATH, JSON.stringify(map))
}

function loadFetched(file) {
  const done = new Set()
  if (!existsSync(file)) return done
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line); if (r.pmcid) done.add(r.pmcid) } catch {}
  }
  return done
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `all-${todayStamp()}.jsonl`)
  const limiter = new Limiter(REQ_PER_SEC)

  console.log(`PaperFate · PMC OA full-text collector`)
  console.log(`NCBI key: ${NCBI_API_KEY ? 'yes (' + REQ_PER_SEC + ' req/s)' : 'no (~3 req/s)'}`)
  console.log(`Input dir: ${IN_DIR}`)
  console.log(`Output: ${outPath}`)
  console.log(`Mapping cache: ${MAP_PATH}`)

  // ── STAGE A: PMID → PMCID
  console.log('\n[A] Scanning PMIDs from PubMed JSONLs …')
  const allPmids = [...iterPmids()]
  console.log(`  unique PMIDs: ${allPmids.length}`)

  let map = loadMap()
  const knownPmids = new Set(Object.keys(map))
  const pmidsToLink = allPmids.filter(p => !knownPmids.has(p))
  console.log(`  cached mappings: ${knownPmids.size}, need elink: ${pmidsToLink.length}`)

  if (pmidsToLink.length > 0) {
    // EPMC search batch — 100 PMIDs per call (vs NCBI elink's 20), single-pass JSON.
    const BATCH = 100
    const PARALLEL = 4
    const PROGRESS_EVERY = 5000

    const batches = []
    for (let i = 0; i < pmidsToLink.length; i += BATCH) {
      batches.push(pmidsToLink.slice(i, i + BATCH))
    }
    let linked = 0, batchFail = 0, lastSaved = 0
    const t0 = Date.now()
    // EPMC has no published rate limit; ~5 req/s is polite
    const epmcLimiter = new Limiter(5)

    async function worker() {
      while (batches.length) {
        const batch = batches.shift()
        if (!batch) break
        try {
          const m = await epmcMapBatch(batch, epmcLimiter)
          Object.assign(map, m)
          for (const p of batch) if (!(p in map)) map[p] = null
          linked += batch.length
        } catch (e) {
          batchFail++
          if (DEBUG || batchFail % 50 === 1) {
            console.warn(`  epmc batch failed (${batch[0]}..${batch[batch.length-1]}): ${e.message}`)
          }
        }
        if (linked - lastSaved >= PROGRESS_EVERY) {
          lastSaved = linked
          const mapped = Object.values(map).filter(v => v).length
          const rate = (linked / ((Date.now() - t0) / 1000)).toFixed(1)
          const eta = Math.round((pmidsToLink.length - linked) / Number(rate || 1) / 60)
          console.log(`  epmc-map: ${linked}/${pmidsToLink.length}  mapped=${mapped}  fails=${batchFail}  ${rate}/s  eta ${eta}m`)
          saveMap(map)
        }
      }
    }

    await Promise.all(Array.from({ length: PARALLEL }, () => worker()))
    saveMap(map)
    console.log(`  epmc-map complete: ${linked} queried, ${batchFail} batches failed`)
  }
  const pmcidsAll = [...new Set(Object.values(map).filter(v => v))]
  console.log(`  total PMCIDs available: ${pmcidsAll.length} (${(100 * pmcidsAll.length / allPmids.length).toFixed(1)}% of PMIDs have PMC)`)

  // ── STAGE B: efetch PMC XML
  console.log('\n[B] Fetching PMC full-text XML …')
  const fetched = loadFetched(outPath)
  const queue = pmcidsAll.filter(p => !fetched.has(p))
  console.log(`  already fetched: ${fetched.size}, queued: ${queue.length}`)
  if (queue.length === 0) { console.log('nothing to do'); return }

  const counters = { done: 0, ok: 0, miss: 0, fail: 0, total: queue.length, t0: Date.now() }
  async function worker() {
    while (queue.length) {
      const pmcid = queue.shift()
      if (!pmcid) break
      try {
        const xml = await efetchPmcXml(pmcid, limiter)
        const parsed = parsePmcJats(xml)
        if (parsed && parsed.body_word_count > 100) {
          appendFileSync(outPath, JSON.stringify({ pmcid, ...parsed }) + '\n')
          counters.ok++
        } else counters.miss++
      } catch {
        counters.fail++
      }
      counters.done++
      if (counters.done % 50 === 0) {
        const rate = (counters.done / ((Date.now() - counters.t0) / 1000)).toFixed(1)
        const eta = ((queue.length / Number(rate || 1)) / 60).toFixed(1)
        console.log(`  ${counters.done}/${counters.total}  ok=${counters.ok} miss=${counters.miss} fail=${counters.fail}  ${rate}/s  eta ${eta}m`)
      }
    }
  }
  const workers = Array.from({ length: PARALLEL }, () => worker())
  await Promise.all(workers)

  console.log(`\n✓ Done in ${((Date.now() - counters.t0) / 60000).toFixed(1)} min`)
  console.log(`  ok=${counters.ok}  miss=${counters.miss}  fail=${counters.fail}`)
  console.log(`  output: ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch(e => { console.error(e); process.exit(1) })
