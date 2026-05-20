#!/usr/bin/env node
// PaperFate · Vector similarity prototype
//
// Demonstrates: given a paper (by DOI or random sample), find the top-K
// most similar papers in the local corpus using SPECTER2 embeddings stored
// in the SQLite BLOB column.
//
// Why this matters: this is the "Most similar published papers" feature
// the frontend will show. For a published query paper we can fetch its
// SPECTER2 embedding from Semantic Scholar; for a novel user manuscript
// we'll need to embed it ourselves (S2 has no public embed-arbitrary-text
// endpoint, so future work: local SPECTER2 ONNX or a Gemini-embedding
// re-embed of the corpus).
//
// Usage:
//   node scripts/similarity-prototype.mjs                    # random sample
//   node scripts/similarity-prototype.mjs --doi 10.1056/...  # specific paper
//   node scripts/similarity-prototype.mjs --k 20             # top 20 neighbors

import Database from 'better-sqlite3'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

function parseArgs() {
  const a = process.argv.slice(2)
  const idx = (f) => a.indexOf(f)
  return {
    doi: idx('--doi') >= 0 ? a[idx('--doi') + 1] : null,
    k:   idx('--k')   >= 0 ? Number(a[idx('--k') + 1]) : 10,
  }
}

function bufToFloat32(buf) {
  if (!buf) return null
  // better-sqlite3 returns a Buffer; share underlying ArrayBuffer slice
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function norm(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

function dot(a, b, len) {
  let s = 0
  for (let i = 0; i < len; i++) s += a[i] * b[i]
  return s
}

function cosine(a, b, normA, normB) {
  if (!normA || !normB) return 0
  return dot(a, b, a.length) / (normA * normB)
}

async function main() {
  const args = parseArgs()
  const db = new Database(DB_PATH, { readonly: true })
  console.log(`PaperFate · similarity prototype  (DB: ${DB_PATH})`)

  // Load ALL embeddings + minimal metadata into memory.
  // 31K × 768 × 4 bytes = ~95 MB Float32 — fits easily.
  console.log(`Loading embeddings into memory…`)
  const t0 = Date.now()
  const rows = db.prepare(`
    SELECT
      doi, pmid, title, journal, venue_name, year,
      citations_openalex, citations_s2, embedding_dim, embedding
    FROM papers
    WHERE embedding IS NOT NULL AND embedding_dim IS NOT NULL
  `).all()
  const corpus = rows.map(r => ({
    doi: r.doi,
    pmid: r.pmid,
    title: r.title,
    journal: r.venue_name || r.journal,
    year: r.year,
    citations: r.citations_openalex ?? r.citations_s2 ?? 0,
    dim: r.embedding_dim,
    vec: bufToFloat32(r.embedding),
  }))
  for (const c of corpus) c.norm = norm(c.vec)
  console.log(`Loaded ${corpus.length} embeddings (${corpus[0]?.dim}-d) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (corpus.length === 0) {
    console.error('No embeddings in DB. Run collect-semantic-scholar.mjs + build-unified-db.mjs first.')
    process.exit(1)
  }

  // Pick the query
  let query
  if (args.doi) {
    query = corpus.find(c => c.doi.toLowerCase() === args.doi.toLowerCase())
    if (!query) {
      console.error(`DOI ${args.doi} not in corpus (or missing embedding).`)
      process.exit(1)
    }
  } else {
    query = corpus[Math.floor(Math.random() * corpus.length)]
  }
  console.log(`\nQUERY PAPER:`)
  console.log(`  ${query.title}`)
  console.log(`  ${query.journal || '?'} · ${query.year || '?'} · ${query.citations} citations · DOI ${query.doi}`)

  // Compute cosine similarity to every other paper
  console.log(`\nComputing similarities…`)
  const t1 = Date.now()
  const len = query.dim
  const scored = []
  for (const c of corpus) {
    if (c.doi === query.doi) continue
    if (c.dim !== len) continue
    const sim = cosine(query.vec, c.vec, query.norm, c.norm)
    scored.push({ ...c, sim })
  }
  scored.sort((a, b) => b.sim - a.sim)
  const elapsed = ((Date.now() - t1) / 1000).toFixed(1)
  console.log(`Scored ${scored.length} candidates in ${elapsed}s (${(scored.length / Number(elapsed)).toFixed(0)} dot-products/sec)`)

  // Top K
  console.log(`\nTop ${args.k} most similar:`)
  console.log(`${'sim'.padEnd(7)}  ${'cite'.padEnd(6)}  ${'year'.padEnd(4)}  journal · title`)
  for (const r of scored.slice(0, args.k)) {
    const cite = String(r.citations).padStart(5)
    const year = String(r.year || '?').padEnd(4)
    const j = (r.journal || '?').slice(0, 24).padEnd(24)
    const t = (r.title || '').slice(0, 70)
    console.log(`${r.sim.toFixed(4)}  ${cite}  ${year}  ${j}  ${t}`)
  }

  // Aggregate: where do similar papers tend to be published?
  console.log(`\nVenue distribution of top-${args.k} similar:`)
  const venues = {}
  for (const r of scored.slice(0, args.k)) {
    const v = r.journal || '?'
    venues[v] = (venues[v] || 0) + 1
  }
  for (const [v, n] of Object.entries(venues).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(2)}  ${v}`)
  }

  // Aggregate: citation distribution
  const cits = scored.slice(0, args.k).map(r => r.citations).filter(Number.isFinite)
  cits.sort((a, b) => a - b)
  if (cits.length) {
    const median = cits[Math.floor(cits.length / 2)]
    const min = cits[0]
    const max = cits[cits.length - 1]
    const mean = +(cits.reduce((s, x) => s + x, 0) / cits.length).toFixed(1)
    console.log(`\nCitation stats of top-${args.k}: min=${min} median=${median} mean=${mean} max=${max}`)
  }

  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
