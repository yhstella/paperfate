#!/usr/bin/env node
// Ingest OpenAlex referenced_works JSONL into paper_references.
//
// Usage:
//   DATA_ROOT=E:/paperfate/data node scripts/ingest-paper-references.mjs
//   node scripts/ingest-paper-references.mjs --file E:/paperfate/data/openalex-refs/refs-2026-05-24.jsonl
//   node scripts/ingest-paper-references.mjs --limit 10000

import Database from 'better-sqlite3'
import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const SRC_DIR = join(DATA_ROOT, 'openalex-refs')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const FILE = arg('file', null)
const LIMIT = Number(arg('limit', '0'))

function normalizeDoi(doi) {
  if (!doi) return null
  return String(doi)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .toLowerCase()
}

function normalizeWorkId(id) {
  if (!id) return null
  const s = String(id).trim()
  const m = s.match(/(?:https?:\/\/openalex\.org\/)?(W\d+)/i)
  return m ? m[1].toUpperCase() : null
}

function sourceFiles() {
  if (FILE) return [FILE]
  if (!existsSync(SRC_DIR)) return []
  return readdirSync(SRC_DIR)
    .filter(n => n.endsWith('.jsonl') && !n.startsWith('_'))
    .sort()
    .map(n => join(SRC_DIR, n))
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_references (
      doi             TEXT NOT NULL COLLATE NOCASE,
      ref_openalex_id TEXT NOT NULL,
      PRIMARY KEY (doi, ref_openalex_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pr_doi ON paper_references(doi);
    CREATE INDEX IF NOT EXISTS idx_pr_ref ON paper_references(ref_openalex_id);
  `)
}

async function ingestFile(db, file, insertRef) {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const batch = []
  let lines = 0
  let rows = 0
  let refs = 0
  let skipped = 0
  const flush = () => {
    if (!batch.length) return
    db.transaction((items) => {
      for (const item of items) insertRef.run(item)
    })(batch.splice(0))
  }

  for await (const line of rl) {
    if (!line.trim()) continue
    lines++
    if (LIMIT > 0 && lines > LIMIT) break
    let rec
    try { rec = JSON.parse(line) } catch { skipped++; continue }
    if (rec.error || rec.missing) { skipped++; continue }
    const doi = normalizeDoi(rec.doi)
    if (!doi || !Array.isArray(rec.ref_openalex_ids)) { skipped++; continue }
    const uniqueRefs = [...new Set(rec.ref_openalex_ids.map(normalizeWorkId).filter(Boolean))]
    for (const refOpenAlexId of uniqueRefs) {
      batch.push({ doi, ref_openalex_id: refOpenAlexId })
      refs++
      if (batch.length >= 50000) flush()
    }
    rows++
  }
  flush()
  return { file, lines, rows, refs, skipped }
}

async function main() {
  console.log('PaperFate paper_references ingest')
  console.log(`DB:  ${DB_PATH}`)
  console.log(`Src: ${FILE || SRC_DIR}`)

  const files = sourceFiles()
  if (!files.length) {
    console.log('No JSONL files found.')
    return
  }

  const db = new Database(DB_PATH, { fileMustExist: true, timeout: 60000 })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 60000')
  ensureSchema(db)

  const insertRef = db.prepare(`
    INSERT OR IGNORE INTO paper_references (doi, ref_openalex_id)
    VALUES (@doi, @ref_openalex_id)
  `)

  let totalLines = 0
  let totalRows = 0
  let totalRefs = 0
  let totalSkipped = 0
  for (const file of files) {
    console.log(`\nScanning ${basename(file)}...`)
    const r = await ingestFile(db, file, insertRef)
    totalLines += r.lines
    totalRows += r.rows
    totalRefs += r.refs
    totalSkipped += r.skipped
    console.log(`  lines=${r.lines.toLocaleString()} rows=${r.rows.toLocaleString()} refs_seen=${r.refs.toLocaleString()} skipped=${r.skipped.toLocaleString()}`)
  }

  const tableRows = db.prepare('SELECT COUNT(*) n FROM paper_references').get().n
  const sourcePapers = db.prepare('SELECT COUNT(DISTINCT doi) n FROM paper_references').get().n
  const refWorks = db.prepare('SELECT COUNT(DISTINCT ref_openalex_id) n FROM paper_references').get().n
  console.log('\nFinal coverage:')
  console.log(`  input lines:       ${totalLines.toLocaleString()}`)
  console.log(`  source rows:       ${totalRows.toLocaleString()}`)
  console.log(`  refs seen:         ${totalRefs.toLocaleString()}`)
  console.log(`  skipped rows:      ${totalSkipped.toLocaleString()}`)
  console.log(`  paper_references:  ${tableRows.toLocaleString()}`)
  console.log(`  source papers:     ${sourcePapers.toLocaleString()}`)
  console.log(`  unique ref works:  ${refWorks.toLocaleString()}`)
  db.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
