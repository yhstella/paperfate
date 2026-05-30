#!/usr/bin/env node
// PaperFate · regression-50 cross-date summary aggregator
//
// Scans E:/paperfate/data/_regression50_<date>.jsonl files (output of
// scripts/regression-50.mjs) and produces a time series so we can track
// v0.5 deploy-gate progress over time.
//
// Each input file's last line is the summary record (see
// scripts/regression-50.mjs — `kind: 'summary'`) with shape:
//   {
//     kind: 'summary',
//     perTier: { top|high|mid|low: {
//       n, n_with_q, n_with_pred,
//       q_score_mean, predicted_jif_mean, real_jcr_jif_mean, mae_vs_real_jif
//     } },
//     delta_q_top_minus_mid,
//     tier_match_rate,
//     tier_match_n,
//     tier_comparable_n
//   }
//
// v0.5 deploy gate (from regression-50.mjs):
//   tier_match_rate >= 0.5 AND top-tier MAE < 30
//
// Usage:
//   node scripts/regression-summary.mjs
//   node scripts/regression-summary.mjs --since 2026-05-20
//   node scripts/regression-summary.mjs --format json
//   node scripts/regression-summary.mjs --format both
//
// Output:
//   - text table to stdout (default)
//   - E:/paperfate/data/_regression_summary.json (json/both modes)

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    dataDir: 'E:/paperfate/data',
    outJson: 'E:/paperfate/data/_regression_summary.json',
    since: null,
    until: null,
    format: 'text', // text | json | both
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const eat = () => argv[++i]
    if (a === '--since') { out.since = eat(); continue }
    if (a.startsWith('--since=')) { out.since = a.slice('--since='.length); continue }
    if (a === '--until') { out.until = eat(); continue }
    if (a.startsWith('--until=')) { out.until = a.slice('--until='.length); continue }
    if (a === '--format') { out.format = eat(); continue }
    if (a.startsWith('--format=')) { out.format = a.slice('--format='.length); continue }
    if (a === '--data-dir') { out.dataDir = eat(); continue }
    if (a.startsWith('--data-dir=')) { out.dataDir = a.slice('--data-dir='.length); continue }
    if (a === '--out-json') { out.outJson = eat(); continue }
    if (a.startsWith('--out-json=')) { out.outJson = a.slice('--out-json='.length); continue }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/regression-summary.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--format text|json|both]')
      console.log('       [--data-dir DIR] [--out-json PATH]')
      process.exit(0)
    }
  }
  const okFmt = new Set(['text', 'json', 'both'])
  if (!okFmt.has(out.format)) {
    console.error(`[regression-summary] unknown --format=${out.format}, falling back to "text"`)
    out.format = 'text'
  }
  return out
}

const ARGS = parseArgs(process.argv)

// ─── Gate thresholds (mirrors regression-50.mjs meta line) ──────────────────
const GATE = {
  tier_match_rate_threshold: 0.5,
  top_tier_mae_threshold: 30,
}

const TIERS = ['top', 'high', 'mid', 'low']
const FNAME_RE = /^_regression50_(\d{4}-\d{2}-\d{2})\.jsonl$/

// ─── Helpers ────────────────────────────────────────────────────────────────
function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v) }

function cmpDate(a, b) {
  // YYYY-MM-DD lexical compare == chronological compare
  return a < b ? -1 : a > b ? 1 : 0
}

function readLastJsonLine(path) {
  // Read the file, split on newlines, walk backward to find the last non-empty
  // line that parses as JSON with kind === 'summary'. Falls back to last
  // non-empty parseable line otherwise (defensive).
  let text
  try { text = readFileSync(path, 'utf-8') } catch (e) {
    return { ok: false, reason: `read failed: ${e.message}` }
  }
  if (!text.trim()) return { ok: false, reason: 'empty file' }
  const lines = text.split(/\r?\n/)
  let fallback = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec && rec.kind === 'summary') return { ok: true, record: rec }
    if (!fallback) fallback = rec
  }
  if (fallback) return { ok: false, reason: 'no kind=summary line', record: fallback }
  return { ok: false, reason: 'no parseable JSON line' }
}

function fmtNum(v, digits = 2) {
  if (!isFiniteNum(v)) return '-'
  return v.toFixed(digits)
}

function fmtPct(v, digits = 1) {
  if (!isFiniteNum(v)) return '-'
  return (100 * v).toFixed(digits) + '%'
}

function gateStatus(summary) {
  const topMae = summary?.perTier?.top?.mae_vs_real_jif
  const tmr = summary?.tier_match_rate
  const tmrPass = isFiniteNum(tmr) && tmr >= GATE.tier_match_rate_threshold
  const maePass = isFiniteNum(topMae) && topMae < GATE.top_tier_mae_threshold
  const pass = tmrPass && maePass
  return {
    pass,
    tier_match_rate_pass: tmrPass,
    top_tier_mae_pass: maePass,
    tier_match_rate: isFiniteNum(tmr) ? tmr : null,
    top_tier_mae: isFiniteNum(topMae) ? topMae : null,
  }
}

// ─── Discovery + parse ──────────────────────────────────────────────────────
function discoverFiles(dir, since, until) {
  if (!existsSync(dir)) {
    console.error(`[regression-summary] data dir not found: ${dir}`)
    return []
  }
  const entries = []
  for (const name of readdirSync(dir)) {
    const m = name.match(FNAME_RE)
    if (!m) continue
    const date = m[1]
    if (since && cmpDate(date, since) < 0) continue
    if (until && cmpDate(date, until) > 0) continue
    const path = join(dir, name)
    let mtime = 0
    try { mtime = statSync(path).mtimeMs } catch {}
    entries.push({ date, path, name, mtime })
  }
  entries.sort((a, b) => cmpDate(a.date, b.date))
  return entries
}

function buildSeries(files) {
  const series = []
  for (const f of files) {
    const parsed = readLastJsonLine(f.path)
    if (!parsed.ok) {
      series.push({
        date: f.date,
        file: basename(f.path),
        ok: false,
        reason: parsed.reason,
      })
      continue
    }
    const s = parsed.record
    const perTier = {}
    for (const t of TIERS) {
      const row = s.perTier?.[t] || {}
      perTier[t] = {
        n: isFiniteNum(row.n) ? row.n : null,
        n_with_q: isFiniteNum(row.n_with_q) ? row.n_with_q : null,
        n_with_pred: isFiniteNum(row.n_with_pred) ? row.n_with_pred : null,
        q_score_mean: isFiniteNum(row.q_score_mean) ? row.q_score_mean : null,
        predicted_jif_mean: isFiniteNum(row.predicted_jif_mean) ? row.predicted_jif_mean : null,
        real_jcr_jif_mean: isFiniteNum(row.real_jcr_jif_mean) ? row.real_jcr_jif_mean : null,
        mae_vs_real_jif: isFiniteNum(row.mae_vs_real_jif) ? row.mae_vs_real_jif : null,
      }
    }
    const gate = gateStatus(s)
    series.push({
      date: f.date,
      file: basename(f.path),
      ok: true,
      perTier,
      delta_q_top_minus_mid: isFiniteNum(s.delta_q_top_minus_mid) ? s.delta_q_top_minus_mid : null,
      tier_match_rate: isFiniteNum(s.tier_match_rate) ? s.tier_match_rate : null,
      tier_match_n: isFiniteNum(s.tier_match_n) ? s.tier_match_n : null,
      tier_comparable_n: isFiniteNum(s.tier_comparable_n) ? s.tier_comparable_n : null,
      gate,
    })
  }
  return series
}

// ─── Text table ─────────────────────────────────────────────────────────────
function padR(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length) }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s }

function printTable(series) {
  if (!series.length) {
    console.log('(no regression-50 files found)')
    return
  }
  const header = [
    'date      ',
    'gate ',
    'tier_match',
    'top_MAE',
    'top_q ',
    'mid_q ',
    'Δq    ',
    'top_pjif',
    'top_rjif',
    'high_MAE',
    'mid_MAE',
    'low_MAE',
  ]
  const widths = header.map(h => h.length)
  const lines = []
  lines.push(header.join('  '))
  lines.push(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of series) {
    if (!row.ok) {
      const cells = [
        padR(row.date, widths[0]),
        padR('N/A', widths[1]),
        padR(row.reason || 'parse error', widths.slice(2).reduce((a, b) => a + b + 2, -2)),
      ]
      lines.push(cells.join('  '))
      continue
    }
    const t = row.perTier
    const gateMark = row.gate.pass ? 'PASS' : 'FAIL'
    const cells = [
      padR(row.date, widths[0]),
      padR(gateMark, widths[1]),
      padL(fmtPct(row.tier_match_rate), widths[2]),
      padL(fmtNum(t.top.mae_vs_real_jif), widths[3]),
      padL(fmtNum(t.top.q_score_mean), widths[4]),
      padL(fmtNum(t.mid.q_score_mean), widths[5]),
      padL(fmtNum(row.delta_q_top_minus_mid, 3), widths[6]),
      padL(fmtNum(t.top.predicted_jif_mean), widths[7]),
      padL(fmtNum(t.top.real_jcr_jif_mean), widths[8]),
      padL(fmtNum(t.high.mae_vs_real_jif), widths[9]),
      padL(fmtNum(t.mid.mae_vs_real_jif), widths[10]),
      padL(fmtNum(t.low.mae_vs_real_jif), widths[11]),
    ]
    lines.push(cells.join('  '))
  }
  console.log(lines.join('\n'))

  // Per-row gate detail (verbose footer for any failing rows)
  const failures = series.filter(r => r.ok && !r.gate.pass)
  if (failures.length) {
    console.log('\nGate failures:')
    for (const r of failures) {
      const reasons = []
      if (!r.gate.tier_match_rate_pass) reasons.push(`tier_match=${fmtPct(r.gate.tier_match_rate)} < ${fmtPct(GATE.tier_match_rate_threshold)}`)
      if (!r.gate.top_tier_mae_pass)    reasons.push(`top_MAE=${fmtNum(r.gate.top_tier_mae)} ≥ ${GATE.top_tier_mae_threshold}`)
      console.log(`  ${r.date}: ${reasons.join('; ') || '(unknown)'}`)
    }
  }
  console.log(`\nGate: tier_match_rate ≥ ${fmtPct(GATE.tier_match_rate_threshold)} AND top-tier MAE < ${GATE.top_tier_mae_threshold}`)
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  const files = discoverFiles(ARGS.dataDir, ARGS.since, ARGS.until)
  const series = buildSeries(files)

  const ok = series.filter(r => r.ok)
  const bad = series.filter(r => !r.ok)
  const passCount = ok.filter(r => r.gate.pass).length

  if (ARGS.format === 'text' || ARGS.format === 'both') {
    console.log(`[regression-summary] dir=${ARGS.dataDir} files=${series.length} ok=${ok.length} bad=${bad.length} gate_pass=${passCount}`)
    if (ARGS.since) console.log(`[regression-summary] since=${ARGS.since}`)
    if (ARGS.until) console.log(`[regression-summary] until=${ARGS.until}`)
    console.log('')
    printTable(series)
  }

  if (ARGS.format === 'json' || ARGS.format === 'both') {
    const payload = {
      generated_at: new Date().toISOString(),
      data_dir: ARGS.dataDir,
      since: ARGS.since,
      until: ARGS.until,
      gate: {
        tier_match_rate_threshold: GATE.tier_match_rate_threshold,
        top_tier_mae_threshold: GATE.top_tier_mae_threshold,
      },
      counts: {
        files: series.length,
        ok: ok.length,
        bad: bad.length,
        gate_pass: passCount,
      },
      series,
    }
    try {
      writeFileSync(ARGS.outJson, JSON.stringify(payload, null, 2), 'utf-8')
      if (ARGS.format !== 'json') {
        console.log(`\nWrote ${ARGS.outJson}`)
      } else {
        console.log(JSON.stringify(payload, null, 2))
        console.error(`[regression-summary] wrote ${ARGS.outJson}`)
      }
    } catch (e) {
      console.error(`[regression-summary] failed to write ${ARGS.outJson}: ${e.message}`)
      process.exitCode = 1
    }
  }
}

main()
