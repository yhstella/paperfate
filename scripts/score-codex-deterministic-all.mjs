#!/usr/bin/env node
// PaperFate full-corpus deterministic baseline scorer.
//
// Phase 1:
//   DATA_ROOT=E:/paperfate/data node scripts/score-codex-deterministic-all.mjs --phase Q100
//
// Sanity check without DB writes:
//   DATA_ROOT=E:/paperfate/data node scripts/score-codex-deterministic-all.mjs --phase Q100 --limit 1000 --dry-run

import Database from 'better-sqlite3'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inferArticleType, scoreItem } from './score-codex-batch-direct.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const RUBRIC_PATH = join(ROOT, 'docs/rubric/Q500.json')
const LOG_PATH = join(DATA_ROOT, '_codex-all-progress.log')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const PHASE = arg('phase', 'Q100').toUpperCase()
const MODE = arg('mode', 'codex_deterministic')
const PAGE_SIZE = Number(arg('page-size', '1000'))
const LIMIT = Number(arg('limit', '0'))
const DRY_RUN = ARGS.includes('--dry-run')
const NO_RESUME = ARGS.includes('--no-resume')
const ALLOW_Q500_FALLBACK = ARGS.includes('--allow-q500-fallback')

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`
  console.log(msg)
  try { appendFileSync(LOG_PATH, msg + '\n') } catch {}
}

function loadItems() {
  const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf8'))
  const all = Array.isArray(rubric.items) ? rubric.items : Object.values(rubric)
  if (PHASE === 'Q100') return all.filter(i => i.Q100)
  if (PHASE === 'Q500_EXTRA') return all.filter(i => !i.Q100)
  if (PHASE === 'Q500') return all
  throw new Error(`Unknown --phase ${PHASE}; use Q100, Q500_EXTRA, or Q500`)
}

function modeAwarePaperScores(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='paper_scores'`).get()
  if (!row) return false
  const pkCols = db.prepare(`PRAGMA table_info(paper_scores)`).all()
    .filter(c => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map(c => c.name)
  return pkCols.join(',') === 'doi,item_id,mode'
}

function ensureModeAwarePaperScores(db) {
  if (modeAwarePaperScores(db)) return

  log('Migrating paper_scores primary key from (doi,item_id) to (doi,item_id,mode)')
  db.transaction(() => {
    db.exec(`
      ALTER TABLE paper_scores RENAME TO paper_scores__old_mode_key;
      CREATE TABLE paper_scores (
        doi          TEXT NOT NULL,
        item_id      TEXT NOT NULL,
        score        REAL,
        raw_value    TEXT,
        mode         TEXT NOT NULL,
        confidence   REAL,
        evidence     TEXT,
        scored_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (doi, item_id, mode)
      );
      INSERT INTO paper_scores (doi, item_id, score, raw_value, mode, confidence, evidence, scored_at)
      SELECT doi, item_id, score, raw_value, mode, confidence, evidence, scored_at
      FROM paper_scores__old_mode_key;
      DROP TABLE paper_scores__old_mode_key;
      CREATE INDEX IF NOT EXISTS idx_scores_doi ON paper_scores(doi);
      CREATE INDEX IF NOT EXISTS idx_scores_item ON paper_scores(item_id);
      CREATE INDEX IF NOT EXISTS idx_scores_mode ON paper_scores(mode);
    `)
  })()
  log('paper_scores migration complete')
}

function parseJsonArray(text) {
  if (!text) return []
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function toPaper(row) {
  return {
    doi: row.doi,
    pmid: row.pmid,
    year: row.year,
    journal: row.journal,
    title: row.title || '',
    abstract: row.abstract || '',
    publication_types: parseJsonArray(row.publication_types_json),
    mesh_terms: parseJsonArray(row.mesh_terms_json),
  }
}

function rawFor(out) {
  if (out.na) return { score: null, raw_value: 'na' }
  if (out.unknown) return { score: null, raw_value: 'unknown' }
  return { score: out.score, raw_value: String(out.score) }
}

function updateCounts(counts, out) {
  if (out.na) counts.na++
  else if (out.unknown) counts.unknown++
  else {
    counts.scored++
    counts[`score_${out.score}`] = (counts[`score_${out.score}`] || 0) + 1
  }
}

function printCounts(counts) {
  return `scores=${counts.scored} na=${counts.na} unknown=${counts.unknown}` +
    ` dist=[0:${counts.score_0 || 0},1:${counts.score_1 || 0},2:${counts.score_2 || 0},3:${counts.score_3 || 0},4:${counts.score_4 || 0},5:${counts.score_5 || 0}]`
}

function main() {
  const items = loadItems()
  if (items.length === 0) throw new Error(`No rubric items selected for phase ${PHASE}`)
  if (PHASE !== 'Q100' && !ALLOW_Q500_FALLBACK) {
    throw new Error(
      `Phase ${PHASE} includes Q500 items that still need item-specific deterministic rules. ` +
      `Use --allow-q500-fallback only for deliberate exploratory dry runs, not production upserts.`,
    )
  }
  const firstItemId = items[0].id

  log(`Starting codex deterministic scoring phase=${PHASE} mode=${MODE} items=${items.length} dry_run=${DRY_RUN}`)
  log(`DB=${DB_PATH}`)

  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('busy_timeout = 60000')

  if (!DRY_RUN) ensureModeAwarePaperScores(db)

  const totalWhere = NO_RESUME || DRY_RUN
    ? `abstract IS NOT NULL AND abstract != ''`
    : `abstract IS NOT NULL AND abstract != ''
       AND NOT EXISTS (
         SELECT 1 FROM paper_scores s
         WHERE s.doi = papers.doi AND s.item_id = ? AND s.mode = ?
       )`
  const totalParams = NO_RESUME || DRY_RUN ? [] : [firstItemId, MODE]
  const total = db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE ${totalWhere}`).get(...totalParams).n
  const target = LIMIT > 0 ? Math.min(LIMIT, total) : total
  log(`Target papers=${target} available=${total} page_size=${PAGE_SIZE} first_item=${firstItemId}`)

  const selectSql = NO_RESUME || DRY_RUN
    ? `SELECT doi, pmid, title, abstract, journal, year, publication_types_json, mesh_terms_json
       FROM papers
       WHERE abstract IS NOT NULL AND abstract != '' AND doi > ?
       ORDER BY doi
       LIMIT ?`
    : `SELECT doi, pmid, title, abstract, journal, year, publication_types_json, mesh_terms_json
       FROM papers
       WHERE abstract IS NOT NULL AND abstract != '' AND doi > ?
         AND NOT EXISTS (
           SELECT 1 FROM paper_scores s
           WHERE s.doi = papers.doi AND s.item_id = ? AND s.mode = ?
         )
       ORDER BY doi
       LIMIT ?`
  const selectPage = db.prepare(selectSql)

  const upsert = DRY_RUN ? null : db.prepare(`
    INSERT INTO paper_scores (doi, item_id, score, raw_value, mode, confidence, evidence, scored_at)
    VALUES (@doi, @item_id, @score, @raw_value, @mode, @confidence, @evidence, datetime('now'))
    ON CONFLICT(doi, item_id, mode) DO UPDATE SET
      score = excluded.score,
      raw_value = excluded.raw_value,
      confidence = excluded.confidence,
      evidence = excluded.evidence,
      scored_at = excluded.scored_at
  `)

  const writePaperRows = db.transaction((paperRows) => {
    for (const row of paperRows) upsert.run(row)
  })

  const counts = { papers: 0, scored: 0, na: 0, unknown: 0 }
  const byType = new Map()
  const started = Date.now()
  let lastDoi = ''

  while (counts.papers < target) {
    const remaining = target - counts.papers
    const pageLimit = Math.min(PAGE_SIZE, remaining)
    const rows = NO_RESUME || DRY_RUN
      ? selectPage.all(lastDoi, pageLimit)
      : selectPage.all(lastDoi, firstItemId, MODE, pageLimit)
    if (rows.length === 0) break

    const dbRows = []
    for (const row of rows) {
      const paper = toPaper(row)
      const articleType = inferArticleType(paper)
      byType.set(articleType, (byType.get(articleType) || 0) + 1)
      for (const item of items) {
        const out = scoreItem(item, paper, articleType)
        updateCounts(counts, out)
        if (!DRY_RUN) {
          const raw = rawFor(out)
          dbRows.push({
            doi: paper.doi.toLowerCase(),
            item_id: item.id,
            score: raw.score,
            raw_value: raw.raw_value,
            mode: MODE,
            confidence: out.confidence ?? null,
            evidence: (out.evidence || '').slice(0, 200),
          })
        }
      }
      counts.papers++
      lastDoi = row.doi
    }

    if (!DRY_RUN && dbRows.length) writePaperRows(dbRows)

    const elapsed = (Date.now() - started) / 1000
    const rate = counts.papers / Math.max(elapsed, 1)
    const etaMin = Math.round((target - counts.papers) / Math.max(rate, 1) / 60)
    log(`${counts.papers}/${target} papers rate=${rate.toFixed(1)}/s eta=${etaMin}m ${printCounts(counts)}`)
  }

  const typeSummary = Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1]))
  log(`Completed phase=${PHASE} papers=${counts.papers} ${printCounts(counts)}`)
  log(`Article types: ${JSON.stringify(typeSummary)}`)
  if (!DRY_RUN) {
    const rows = db.prepare(`
      SELECT raw_value, COUNT(*) AS n
      FROM paper_scores
      WHERE mode = ? AND item_id IN (${items.map(() => '?').join(',')})
      GROUP BY raw_value
      ORDER BY raw_value
    `).all(MODE, ...items.map(i => i.id))
    log(`DB mode=${MODE} selected-item distribution: ${JSON.stringify(rows)}`)
  }
  db.close()
}

main()
