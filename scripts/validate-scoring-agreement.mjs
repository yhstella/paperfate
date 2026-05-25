#!/usr/bin/env node
// PaperFate scoring agreement validation.
//
// Summarizes agreement among paper_scores modes and writes a Markdown report.
// Designed for large DBs: comparisons are mode-pair joins over existing indexed
// paper_scores rows, and top disagreement tables are capped.
//
// Usage:
//   DATA_ROOT=E:/paperfate/data node scripts/validate-scoring-agreement.mjs
//   node scripts/validate-scoring-agreement.mjs --out docs/EVAL_SCORING_v0.1.md

import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const OUT = arg('out', join(ROOT, 'docs', 'EVAL_SCORING_v0.1.md'))
const BASE = arg('base', 'codex_deterministic')
const COMPARE = arg('compare', 'rule,external,llm').split(',').map(s => s.trim()).filter(Boolean)
const TOP = Number(arg('top', '15'))

function pct(x, digits = 1) {
  if (x == null || !Number.isFinite(Number(x))) return ''
  return `${(Number(x) * 100).toFixed(digits)}%`
}

function num(x, digits = 2) {
  if (x == null || !Number.isFinite(Number(x))) return ''
  return Number(x).toFixed(digits)
}

function int(x) {
  if (x == null) return ''
  return Number(x).toLocaleString()
}

function mdTable(headers, rows) {
  const lines = []
  lines.push(`| ${headers.join(' | ')} |`)
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
  for (const row of rows) lines.push(`| ${row.map(v => String(v ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)
  return lines.join('\n')
}

function modeSummary(db) {
  return db.prepare(`
    SELECT
      mode,
      COUNT(*) AS rows,
      COUNT(DISTINCT doi) AS papers,
      COUNT(DISTINCT item_id) AS items,
      SUM(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END) AS numeric_scores,
      SUM(CASE WHEN raw_value = 'na' THEN 1 ELSE 0 END) AS na_rows,
      SUM(CASE WHEN raw_value = 'unknown' THEN 1 ELSE 0 END) AS unknown_rows,
      ROUND(AVG(CASE WHEN score IS NOT NULL THEN score END), 3) AS mean_score,
      ROUND(AVG(confidence), 3) AS mean_confidence
    FROM paper_scores
    GROUP BY mode
    ORDER BY rows DESC
  `).all()
}

function rawDistribution(db, mode) {
  return db.prepare(`
    SELECT raw_value, COUNT(*) AS n
    FROM paper_scores
    WHERE mode = ?
    GROUP BY raw_value
    ORDER BY
      CASE raw_value
        WHEN '0' THEN 0 WHEN '1' THEN 1 WHEN '2' THEN 2
        WHEN '3' THEN 3 WHEN '4' THEN 4 WHEN '5' THEN 5
        WHEN 'na' THEN 6 WHEN 'unknown' THEN 7 ELSE 8
      END
  `).all(mode)
}

function confidenceDistribution(db) {
  return db.prepare(`
    SELECT
      mode,
      COUNT(*) AS n,
      ROUND(AVG(confidence), 3) AS mean_conf,
      ROUND(MIN(confidence), 3) AS min_conf,
      ROUND(MAX(confidence), 3) AS max_conf,
      SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END) AS low_conf,
      SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) AS high_conf
    FROM paper_scores
    WHERE confidence IS NOT NULL
    GROUP BY mode
    ORDER BY n DESC
  `).all()
}

function pairAgreement(db, a, b) {
  return db.prepare(`
    SELECT
      COUNT(*) AS overlap,
      ROUND(AVG(ABS(a.score - b.score)), 3) AS mean_abs_diff,
      SUM(CASE WHEN a.score = b.score THEN 1 ELSE 0 END) AS exact,
      SUM(CASE WHEN ABS(a.score - b.score) <= 1 THEN 1 ELSE 0 END) AS within_one,
      ROUND(AVG(a.score), 3) AS mean_a,
      ROUND(AVG(b.score), 3) AS mean_b
    FROM paper_scores b
    JOIN paper_scores a
      ON a.doi = b.doi AND a.item_id = b.item_id AND a.mode = ?
    WHERE b.mode = ?
      AND a.score IS NOT NULL
      AND b.score IS NOT NULL
  `).get(a, b)
}

function itemDisagreements(db, a, b, limit) {
  return db.prepare(`
    SELECT
      b.item_id,
      COUNT(*) AS overlap,
      ROUND(AVG(ABS(a.score - b.score)), 3) AS mean_abs_diff,
      ROUND(AVG(a.score), 3) AS mean_a,
      ROUND(AVG(b.score), 3) AS mean_b,
      SUM(CASE WHEN a.score = b.score THEN 1 ELSE 0 END) AS exact
    FROM paper_scores b
    JOIN paper_scores a
      ON a.doi = b.doi AND a.item_id = b.item_id AND a.mode = ?
    WHERE b.mode = ?
      AND a.score IS NOT NULL
      AND b.score IS NOT NULL
    GROUP BY b.item_id
    HAVING overlap >= 10
    ORDER BY mean_abs_diff DESC, overlap DESC
    LIMIT ?
  `).all(a, b, limit)
}

function codexBinaryTendency(db, mode) {
  const rows = db.prepare(`
    SELECT score, COUNT(*) AS n
    FROM paper_scores
    WHERE mode = ? AND score IS NOT NULL
    GROUP BY score
    ORDER BY score
  `).all(mode)
  const total = rows.reduce((s, r) => s + r.n, 0)
  const byScore = Object.fromEntries(rows.map(r => [String(r.score), r.n]))
  const peak14 = ((byScore['1'] || 0) + (byScore['4'] || 0)) / Math.max(1, total)
  const edges05 = ((byScore['0'] || 0) + (byScore['5'] || 0)) / Math.max(1, total)
  return { rows, total, peak14, edges05 }
}

async function readMetricsFile() {
  try {
    const { readFileSync } = await import('node:fs')
    return JSON.parse(readFileSync(join(ROOT, 'weights', 'fatecore-v0.1-metrics.json'), 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true })
  db.pragma('busy_timeout = 60000')

  const modes = modeSummary(db)
  const conf = confidenceDistribution(db)
  const raw = rawDistribution(db, BASE)
  const tendency = codexBinaryTendency(db, BASE)

  const pairRows = []
  const topDisagreements = {}
  for (const other of COMPARE) {
    const p = pairAgreement(db, BASE, other)
    pairRows.push({ mode: other, ...p })
    topDisagreements[other] = itemDisagreements(db, BASE, other, TOP)
  }

  const metrics = await readMetricsFile()

  const lines = []
  lines.push('# Scoring Agreement Evaluation v0.1')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`DB: ${DB_PATH}`)
  lines.push(`Base mode: \`${BASE}\``)
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push(mdTable(
    ['Mode', 'Rows', 'Papers', 'Items', 'Numeric', 'NA', 'Unknown', 'Mean score', 'Mean confidence'],
    modes.map(r => [
      r.mode, int(r.rows), int(r.papers), int(r.items), int(r.numeric_scores),
      int(r.na_rows), int(r.unknown_rows), num(r.mean_score, 3), num(r.mean_confidence, 3),
    ]),
  ))
  lines.push('')

  lines.push('## Codex Deterministic Distribution')
  lines.push('')
  lines.push(mdTable(
    ['Raw value', 'Rows', 'Share'],
    raw.map(r => [r.raw_value, int(r.n), pct(r.n / raw.reduce((s, x) => s + x.n, 0))]),
  ))
  lines.push('')
  lines.push(`Numeric score rows: ${int(tendency.total)}`)
  lines.push(`Score 1 + 4 share: ${pct(tendency.peak14)} (binary tendency check)`)
  lines.push(`Score 0 + 5 share: ${pct(tendency.edges05)} (edge-score usage check)`)
  lines.push('')

  lines.push('## Confidence')
  lines.push('')
  lines.push(mdTable(
    ['Mode', 'Rows', 'Mean', 'Min', 'Max', '<0.6', '>=0.8'],
    conf.map(r => [
      r.mode, int(r.n), num(r.mean_conf, 3), num(r.min_conf, 3), num(r.max_conf, 3),
      int(r.low_conf), int(r.high_conf),
    ]),
  ))
  lines.push('')

  lines.push('## Pairwise Agreement vs Codex')
  lines.push('')
  lines.push(mdTable(
    ['Other mode', 'Overlap', 'Mean abs diff', 'Exact', 'Within 1', 'Codex mean', 'Other mean'],
    pairRows.map(r => [
      r.mode,
      int(r.overlap),
      num(r.mean_abs_diff, 3),
      `${int(r.exact)} (${pct(r.exact / Math.max(1, r.overlap))})`,
      `${int(r.within_one)} (${pct(r.within_one / Math.max(1, r.overlap))})`,
      num(r.mean_a, 3),
      num(r.mean_b, 3),
    ]),
  ))
  lines.push('')

  for (const other of COMPARE) {
    lines.push(`## Top Disagreements: Codex vs ${other}`)
    lines.push('')
    lines.push(mdTable(
      ['Item', 'Overlap', 'Mean abs diff', 'Codex mean', `${other} mean`, 'Exact %'],
      topDisagreements[other].map(r => [
        r.item_id,
        int(r.overlap),
        num(r.mean_abs_diff, 3),
        num(r.mean_a, 3),
        num(r.mean_b, 3),
        pct(r.exact / Math.max(1, r.overlap)),
      ]),
    ))
    lines.push('')
  }

  if (metrics) {
    lines.push('## FateCore v0.1 Metrics Snapshot')
    lines.push('')
    const targetRows = ['y_jcr_jif', 'y_icite_rcr', 'y_citations_log']
      .filter(k => metrics[k] && !metrics[k].skipped)
      .map(k => {
        const m = metrics[k]
        return [k, int(m.n_train), int(m.n_test), num(m.mae, 3), num(m.mae_cal, 3), num(m.r2, 3), num(m.conformal_q90, 3), int(m.best_iter)]
      })
    lines.push(mdTable(['Target', 'Train', 'Test', 'MAE', 'MAE cal', 'R2', 'Q90 interval', 'Best iter'], targetRows))
    lines.push('')
    if (metrics.features_used) {
      const authorFeatures = metrics.features_used.filter(c => /author_h|team_|international/.test(c))
      lines.push(`Features used: ${metrics.features_used.length}`)
      lines.push(`Author features included: ${authorFeatures.length ? authorFeatures.map(x => `\`${x}\``).join(', ') : 'no'}`)
      lines.push('')
    }
  }

  lines.push('## Interpretation')
  lines.push('')
  lines.push('- `codex_deterministic` is the only complete Q100 coverage layer, so it should remain the production-safe baseline for FateCore v0.1.')
  lines.push('- Rule/external/llm rows are useful audit overlays but have much lower coverage; compare them by item rather than by global row count.')
  lines.push('- A high score 1+4 share is expected for regex-style deterministic scoring, but items with large pairwise disagreement should be prioritized for rule refinement or LLM adjudication.')
  lines.push('')

  writeFileSync(OUT, lines.join('\n'))
  console.log(`Wrote ${OUT}`)
  db.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
