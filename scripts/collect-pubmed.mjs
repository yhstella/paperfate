#!/usr/bin/env node
// PaperFate · PubMed corpus collector
// Pulls PMIDs per seed query via esearch, then fetches metadata via efetch,
// streams JSONL to data/pubmed/<seed>-<YYYY-MM-DD>.jsonl.
//
// Usage:
//   node scripts/collect-pubmed.mjs                # all seeds
//   node scripts/collect-pubmed.mjs hepatology_hcc # one seed
//   NCBI_API_KEY=... node scripts/collect-pubmed.mjs   # 10 req/s instead of 3
//
// Notes:
// - No external deps. Uses Node 18+ built-in fetch.
// - Minimal XML parsing via regex — fine for PubMed's narrow schema.
// - Resumes nothing on rerun; deletes target file first. Tune RETMAX in seeds.json.

import { readFileSync, mkdirSync, createWriteStream, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SEEDS_PATH = join(HERE, 'seeds.json')
// DATA_ROOT env var allows pointing data dir to a large SSD without code changes
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const OUT_DIR = join(DATA_ROOT, 'pubmed')

const API_KEY = process.env.NCBI_API_KEY || ''
const REQ_PER_SEC = API_KEY ? 9 : 2.8       // stay under NCBI limits
const BATCH_FETCH = 200                      // PMIDs per efetch call
const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
const EFETCH  = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
const TOOL = 'paperfate'
const EMAIL = process.env.NCBI_EMAIL || 'beta@paperfate.com'

// ─────────────────────────────────────────────────────────────────────────────

function pad(n) { return n.toString().padStart(2, '0') }
function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class Limiter {
  constructor(perSec) { this.gap = 1000 / perSec; this.last = 0 }
  async take() {
    const now = Date.now()
    const wait = Math.max(0, this.last + this.gap - now)
    if (wait) await sleep(wait)
    this.last = Date.now()
  }
}

async function fetchWithRetry(url, params, { attempts = 5, timeoutMs = 30000 } = {}) {
  const u = new URL(url)
  Object.entries({ ...params, tool: TOOL, email: EMAIL, ...(API_KEY && { api_key: API_KEY }) })
    .forEach(([k, v]) => u.searchParams.set(k, v))
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(u, {
        headers: { 'User-Agent': `${TOOL}/0.1 (${EMAIL})` },
        signal: controller.signal,
      })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const body = await res.text()
      clearTimeout(timer)
      return body
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      const msg = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message
      const backoff = 800 * Math.pow(2, i)
      console.warn(`  retry ${i + 1}/${attempts} after ${backoff}ms (${msg})`)
      await sleep(backoff)
    }
  }
  throw lastErr
}

// ─────────────────── XML parsing helpers (regex, minimal) ───────────────────

function decodeEntities(s) {
  if (!s) return s
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function firstMatch(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return m ? stripTags(m[1]) : ''
}

function allMatches(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g')
  const out = []
  let m
  while ((m = re.exec(xml)) !== null) out.push(stripTags(m[1]))
  return out
}

function parsePubMedArticle(xml) {
  const pmid = firstMatch(xml, 'PMID')
  const title = firstMatch(xml, 'ArticleTitle')

  // Abstract may be structured with multiple <AbstractText Label="...">
  const absRe = /<AbstractText[^>]*?(?:Label="([^"]*)")?[^>]*>([\s\S]*?)<\/AbstractText>/g
  const absParts = []
  let am
  while ((am = absRe.exec(xml)) !== null) {
    const label = am[1] ? `${am[1]}: ` : ''
    absParts.push(label + stripTags(am[2]))
  }
  const abstract = absParts.join(' ')

  // Journal — prefer ISOAbbreviation, fallback to Title
  const journalBlock = xml.match(/<Journal>[\s\S]*?<\/Journal>/)?.[0] || ''
  const journal = firstMatch(journalBlock, 'ISOAbbreviation') || firstMatch(journalBlock, 'Title')
  const issn = firstMatch(journalBlock, 'ISSN')

  // Year — prefer ArticleDate, then PubDate
  const articleDate = xml.match(/<ArticleDate[^>]*>[\s\S]*?<\/ArticleDate>/)?.[0] || ''
  const pubDate = xml.match(/<PubDate>[\s\S]*?<\/PubDate>/)?.[0] || ''
  let year = firstMatch(articleDate, 'Year') || firstMatch(pubDate, 'Year')
  if (!year) {
    const medlineDate = firstMatch(pubDate, 'MedlineDate')
    const ym = medlineDate.match(/\b(19|20)\d{2}\b/)
    if (ym) year = ym[0]
  }
  year = year ? Number(year) : null

  // DOI
  const doi = (xml.match(/<ELocationID[^>]*EIdType="doi"[^>]*>([^<]+)<\/ELocationID>/i)
            || xml.match(/<ArticleId[^>]*IdType="doi"[^>]*>([^<]+)<\/ArticleId>/i))?.[1] || ''

  // PMCID (linked PMC full-text identifier, when available)
  const pmcid = xml.match(/<ArticleId[^>]*IdType="pmc"[^>]*>(PMC\d+)<\/ArticleId>/i)?.[1] || null

  // Publication types
  const pubTypes = []
  const ptRe = /<PublicationType[^>]*>([^<]+)<\/PublicationType>/g
  let pm
  while ((pm = ptRe.exec(xml)) !== null) pubTypes.push(decodeEntities(pm[1]))

  // MeSH terms (descriptor names only)
  const meshTerms = []
  const meshRe = /<MeshHeading>[\s\S]*?<DescriptorName[^>]*>([^<]+)<\/DescriptorName>[\s\S]*?<\/MeshHeading>/g
  let mm
  while ((mm = meshRe.exec(xml)) !== null) meshTerms.push(decodeEntities(mm[1]))

  // Authors — last names, capped 6
  const authors = []
  const authorRe = /<Author[^>]*>[\s\S]*?<LastName>([^<]+)<\/LastName>(?:[\s\S]*?<ForeName>([^<]+)<\/ForeName>)?[\s\S]*?<\/Author>/g
  let am2
  while ((am2 = authorRe.exec(xml)) !== null) {
    const last = decodeEntities(am2[1])
    const fore = am2[2] ? decodeEntities(am2[2]) : ''
    authors.push(fore ? `${last} ${fore[0]}` : last)
    if (authors.length >= 8) break
  }

  // Affiliations — first author affiliation as country/institution hint
  const affil = (xml.match(/<Affiliation>([^<]+)<\/Affiliation>/)?.[1]) || ''

  // Publication history dates (PubMedPubDate PubStatus="received|accepted|epublish|pubmed|entrez|pmc|aheadofprint|revised")
  // Format ISO YYYY-MM-DD if all parts present, else just YYYY or null.
  const history = {}
  const histRe = /<PubMedPubDate\s+PubStatus="([^"]+)"[^>]*>([\s\S]*?)<\/PubMedPubDate>/g
  let hm
  while ((hm = histRe.exec(xml)) !== null) {
    const status = hm[1]
    const block = hm[2]
    const y = firstMatch(block, 'Year')
    const mo = firstMatch(block, 'Month')
    const d = firstMatch(block, 'Day')
    if (!y) continue
    const iso = (y && mo && d) ? `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}` : (y && mo) ? `${y}-${mo.padStart(2,'0')}` : y
    history[status] = iso
  }
  // Trial registry IDs (ClinicalTrials.gov NCT etc.)
  const databankIds = []
  const dbRe = /<DataBank>[\s\S]*?<DataBankName>([^<]+)<\/DataBankName>[\s\S]*?<AccessionNumberList>([\s\S]*?)<\/AccessionNumberList>[\s\S]*?<\/DataBank>/g
  let dm
  while ((dm = dbRe.exec(xml)) !== null) {
    const dbName = decodeEntities(dm[1])
    const acRe = /<AccessionNumber>([^<]+)<\/AccessionNumber>/g
    let an
    while ((an = acRe.exec(dm[2])) !== null) {
      databankIds.push({ db: dbName, id: decodeEntities(an[1]) })
    }
  }
  // Grants / funders
  const grants = []
  const grantRe = /<Grant>[\s\S]*?<GrantID>([^<]+)<\/GrantID>(?:[\s\S]*?<Agency>([^<]+)<\/Agency>)?(?:[\s\S]*?<Country>([^<]+)<\/Country>)?[\s\S]*?<\/Grant>/g
  let gm
  while ((gm = grantRe.exec(xml)) !== null) {
    grants.push({
      id: decodeEntities(gm[1]),
      agency: gm[2] ? decodeEntities(gm[2]) : null,
      country: gm[3] ? decodeEntities(gm[3]) : null,
    })
    if (grants.length >= 6) break
  }

  return {
    pmid,
    pmcid,              // PMC full-text identifier (null if not in PMC)
    doi: doi || null,
    title,
    abstract,
    journal,
    issn: issn || null,
    year,
    publicationTypes: pubTypes,
    meshTerms: meshTerms.slice(0, 20),
    authors,
    firstAffiliation: stripTags(affil) || null,
    history,            // {received, accepted, epublish, pubmed, ...}
    databankIds,        // [{db: 'ClinicalTrials.gov', id: 'NCT...'}]
    grants,             // [{id, agency, country}]
  }
}

// ─────────────────────────────── pipeline ────────────────────────────────────

async function esearchPMIDs(query, retmax, retstart, limiter) {
  await limiter.take()
  const xml = await fetchWithRetry(ESEARCH, {
    db: 'pubmed', term: query, retmode: 'xml',
    retmax: String(retmax), retstart: String(retstart),
  })
  const ids = []
  const re = /<Id>(\d+)<\/Id>/g
  let m
  while ((m = re.exec(xml)) !== null) ids.push(m[1])
  const total = Number(xml.match(/<Count>(\d+)<\/Count>/)?.[1] || 0)
  return { ids, total }
}

async function efetchBatch(pmids, limiter) {
  await limiter.take()
  const xml = await fetchWithRetry(EFETCH, {
    db: 'pubmed', id: pmids.join(','), retmode: 'xml',
  })
  const articleXmls = []
  const re = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g
  let m
  while ((m = re.exec(xml)) !== null) articleXmls.push(m[1])
  return articleXmls.map(parsePubMedArticle)
}

async function collectSeed(key, query, opts) {
  const { retmax = 2000, yearLow = null, yearHigh = null } = opts
  const limiter = new Limiter(REQ_PER_SEC)

  // Append year filter if buckets are configured.
  const effectiveQuery = (yearLow && yearHigh)
    ? `(${query}) AND ("${yearLow}/01/01"[Date - Publication] : "${yearHigh}/12/31"[Date - Publication])`
    : query
  const bucketSuffix = (yearLow && yearHigh) ? `-${yearLow}-${yearHigh}` : ''

  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `${key}${bucketSuffix}-${todayStamp()}.jsonl`)
  // Skip if today's file exists OR any prior-day file exists for this seed×bucket
  // (avoids re-collection when seeds.json gets new entries while preserving idempotency)
  const prefix = `${key}${bucketSuffix}-`
  const existing = readdirSync(OUT_DIR).find(f =>
    f.startsWith(prefix) && /-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)
  )
  if (existing) {
    console.log(`▷ ${key}${bucketSuffix}: ${existing} exists, skipping (delete to refresh)`)
    return { key, written: 0, path: join(OUT_DIR, existing), skipped: true }
  }
  const stream = createWriteStream(outPath, { flags: 'w' })

  // 1) page through esearch to gather PMIDs
  console.log(`▶ ${key}${bucketSuffix}`)
  console.log(`  query: ${effectiveQuery}`)
  const allIds = []
  let cursor = 0
  let total = Infinity
  const page = Math.min(1000, retmax)
  while (cursor < retmax && cursor < total) {
    const { ids, total: t } = await esearchPMIDs(effectiveQuery, Math.min(page, retmax - cursor), cursor, limiter)
    if (t < total) total = t
    if (ids.length === 0) break
    allIds.push(...ids)
    cursor += ids.length
    console.log(`  esearch: ${allIds.length}/${Math.min(retmax, total)}`)
  }
  console.log(`  total in PubMed: ${total} · taking: ${allIds.length}`)

  // 2) efetch metadata in batches
  let written = 0
  for (let i = 0; i < allIds.length; i += BATCH_FETCH) {
    const batch = allIds.slice(i, i + BATCH_FETCH)
    const records = await efetchBatch(batch, limiter)
    for (const rec of records) {
      if (!rec.pmid || !rec.title) continue
      stream.write(JSON.stringify({ seed: key, ...rec }) + '\n')
      written++
    }
    console.log(`  efetch: ${Math.min(i + BATCH_FETCH, allIds.length)}/${allIds.length} · written ${written}`)
  }

  await new Promise(r => stream.end(r))
  const size = statSync(outPath).size
  console.log(`✓ ${key} → ${outPath} (${written} records, ${(size / 1024).toFixed(1)} KB)\n`)
  return { key, written, path: outPath }
}

// ─────────────────────────────── entrypoint ─────────────────────────────────

async function main() {
  const seedsCfg = JSON.parse(readFileSync(SEEDS_PATH, 'utf-8'))
  const filter = process.argv.slice(2)
  const entries = Object.entries(seedsCfg.seeds)
    .filter(([k]) => filter.length === 0 || filter.includes(k))

  if (entries.length === 0) {
    console.error('No matching seed. Available:')
    for (const k of Object.keys(seedsCfg.seeds)) console.error(`  ${k}`)
    process.exit(1)
  }

  console.log(`PaperFate · PubMed collector`)
  console.log(`API key: ${API_KEY ? 'yes (10 req/s)' : 'no (≈3 req/s, set NCBI_API_KEY for faster)'}`)
  console.log(`Output : ${OUT_DIR}`)
  console.log(`Seeds  : ${entries.length}`)
  console.log('')

  const summary = []
  const startedAt = Date.now()
  // PFT_YEAR_BUCKETS env override (JSON), e.g. '[[2015,2015],[2016,2016],...]'
  // — used for one-year-bucket re-collection to fix year-distribution imbalance.
  const overrideBuckets = process.env.PFT_YEAR_BUCKETS
    ? JSON.parse(process.env.PFT_YEAR_BUCKETS)
    : null
  const buckets = overrideBuckets
    || (seedsCfg._yearBuckets && seedsCfg._yearBuckets.length
        ? seedsCfg._yearBuckets
        : [[null, null]])
  console.log(`Year buckets : ${buckets.map(b => b[0] ? `${b[0]}-${b[1]}` : 'none').join(', ')}`)
  console.log('')

  for (const [key, query] of entries) {
    for (const [yearLow, yearHigh] of buckets) {
      try {
        const r = await collectSeed(key, query, {
          retmax: seedsCfg._retmaxPerSeed || 2000,
          yearLow, yearHigh,
        })
        summary.push(r)
      } catch (e) {
        console.error(`✗ ${key} ${yearLow ?? ''}-${yearHigh ?? ''} failed:`, e.message)
        summary.push({ key, error: e.message })
      }
    }
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1)
  console.log('───────────────────────────────────────')
  console.log('Summary')
  for (const s of summary) {
    if (s.error) console.log(`  ${s.key}: ERROR ${s.error}`)
    else        console.log(`  ${s.key}: ${s.written} records`)
  }
  console.log(`Done in ${mins} min`)
}

main().catch(err => { console.error(err); process.exit(1) })
