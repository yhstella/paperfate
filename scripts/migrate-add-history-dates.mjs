#!/usr/bin/env node
// Idempotently add PubMed publication-history date columns to paperfate.db.

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = process.env.PAPERFATE_DB || join(DATA_ROOT, 'paperfate.db')

const HISTORY_COLUMNS = [
  ['history_received_date', 'TEXT'],
  ['history_accepted_date', 'TEXT'],
  ['history_epublish_date', 'TEXT'],
  ['history_pubmed_date', 'TEXT'],
  ['history_revised_date', 'TEXT'],
  ['review_days_received_to_accepted', 'INTEGER'],
]

function main() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`DB not found: ${DB_PATH}`)
  }

  const db = new Database(DB_PATH, { timeout: 60000 })
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 60000')

  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='papers'").get()
  if (!table) throw new Error('papers table not found')

  const existing = new Set(db.prepare('PRAGMA table_info(papers)').all().map(r => r.name))
  for (const [name, type] of HISTORY_COLUMNS) {
    if (existing.has(name)) {
      console.log(`exists: papers.${name}`)
      continue
    }
    db.exec(`ALTER TABLE papers ADD COLUMN ${name} ${type}`)
    console.log(`added: papers.${name} ${type}`)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_history_received ON papers(history_received_date);
    CREATE INDEX IF NOT EXISTS idx_review_days_received_to_accepted ON papers(review_days_received_to_accepted);
  `)

  const coverage = db.prepare(`
    SELECT
      COUNT(*) AS papers,
      SUM(history_received_date IS NOT NULL) AS with_received,
      SUM(history_accepted_date IS NOT NULL) AS with_accepted,
      SUM(review_days_received_to_accepted IS NOT NULL) AS with_review_days
    FROM papers
  `).get()
  console.log(JSON.stringify(coverage, null, 2))
  db.close()
}

main()
