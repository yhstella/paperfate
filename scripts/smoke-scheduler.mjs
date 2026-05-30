#!/usr/bin/env node
// PaperFate · scheduled smoke runner (cron-style)
//
// Long-running supervisor that fires `node scripts/smoke-production-v2.mjs --quick`
// every N minutes and appends each run's outcome to a rolling JSONL log.
//
// Usage:
//   node scripts/smoke-scheduler.mjs
//   node scripts/smoke-scheduler.mjs --interval-min 15
//   node scripts/smoke-scheduler.mjs --base-url https://staging.example.com
//   node scripts/smoke-scheduler.mjs --log-path D:/logs/_smoke_schedule.jsonl
//   node scripts/smoke-scheduler.mjs --stop-after-runs 4
//
// Ctrl+C (SIGINT) or SIGTERM: finishes the current run, prints summary, exits 0.
//
// Each tick appends one JSONL line:
//   { ts, exit_code, duration_s, run_n, summary_table_first_line }

import { spawn } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULTS = {
  intervalMin: 30,
  baseUrl: 'https://paperfate.com',
  logPath: 'E:/paperfate/data/_smoke_schedule.jsonl',
  stopAfterRuns: Infinity,
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    const eatNext = () => { i++; return next }
    const kv = (flag) => {
      if (a === flag && next !== undefined) return eatNext()
      if (a.startsWith(flag + '=')) return a.slice(flag.length + 1)
      return undefined
    }
    let v
    if ((v = kv('--interval-min')) !== undefined) { out.intervalMin = Number(v); continue }
    if ((v = kv('--base-url')) !== undefined)     { out.baseUrl = v; continue }
    if ((v = kv('--log-path')) !== undefined)     { out.logPath = v; continue }
    if ((v = kv('--stop-after-runs')) !== undefined) {
      const n = Number(v)
      out.stopAfterRuns = Number.isFinite(n) && n > 0 ? n : Infinity
      continue
    }
    if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/smoke-scheduler.mjs ' +
        '[--interval-min M] [--base-url URL] [--log-path PATH] [--stop-after-runs N]'
      )
      process.exit(0)
    }
    console.error(`[scheduler] unknown arg: ${a}`)
    process.exit(2)
  }
  if (!Number.isFinite(out.intervalMin) || out.intervalMin <= 0) {
    console.error(`[scheduler] --interval-min must be a positive number (got ${out.intervalMin})`)
    process.exit(2)
  }
  out.baseUrl = String(out.baseUrl).replace(/\/+$/, '')
  return out
}

const ARGS = parseArgs(process.argv)

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
  startedAt: new Date(),
  runs: 0,
  ok: 0,         // exit_code === 0
  fail: 0,       // exit_code !== 0
  durations: [], // seconds
  stopping: false,
  inFlight: false,
  exitRequested: false,
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const SMOKE_SCRIPT = resolve(__dirname, 'smoke-production-v2.mjs')

function nowIso() {
  return new Date().toISOString()
}

function fmtDuration(s) {
  if (!Number.isFinite(s)) return '-'
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}m${r.toFixed(0).padStart(2, '0')}s`
}

async function ensureLogDir() {
  try { await mkdir(dirname(ARGS.logPath), { recursive: true }) }
  catch (e) {
    if (e && e.code !== 'EEXIST') {
      console.error(`[scheduler] could not create log dir: ${e.message}`)
    }
  }
}

async function appendJsonl(obj) {
  try {
    await appendFile(ARGS.logPath, JSON.stringify(obj) + '\n', 'utf8')
  } catch (e) {
    console.error(`[scheduler] log write failed: ${e.message}`)
  }
}

// ─── Single smoke run ───────────────────────────────────────────────────────
function runSmokeOnce(runN) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now()
    const ts = nowIso()
    let stdoutBuf = ''
    let firstSummary = ''

    const child = spawn(
      process.execPath,
      [SMOKE_SCRIPT, '--quick', '--base-url', ARGS.baseUrl],
      { cwd: resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] }
    )

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8')
      if (!firstSummary) {
        const m = stdoutBuf.match(/^Summary \(.*$/m)
        if (m) firstSummary = m[0].trim()
      }
    })
    // Drain stderr so the pipe doesn't backpressure-deadlock the child.
    child.stderr.on('data', () => {})

    const onClose = async (code, signal) => {
      const duration_s = (Date.now() - startedAt) / 1000
      const exit_code = code == null ? (signal ? 130 : 1) : code
      const summary_table_first_line = firstSummary || extractFallbackSummary(stdoutBuf)

      const record = {
        ts,
        exit_code,
        duration_s: Number(duration_s.toFixed(2)),
        run_n: runN,
        summary_table_first_line,
      }

      await appendJsonl(record)
      state.runs++
      if (exit_code === 0) state.ok++; else state.fail++
      state.durations.push(duration_s)

      const tag = exit_code === 0 ? 'OK' : `FAIL(${exit_code})`
      console.log(
        `[scheduler] run ${runN} ${tag} dur=${fmtDuration(duration_s)} ` +
        `at ${ts} :: ${summary_table_first_line || '(no summary)'}`
      )
      resolveRun(record)
    }

    child.on('close', onClose)
    child.on('error', async (err) => {
      const duration_s = (Date.now() - startedAt) / 1000
      const record = {
        ts,
        exit_code: -1,
        duration_s: Number(duration_s.toFixed(2)),
        run_n: runN,
        summary_table_first_line: `spawn_error: ${err.message}`,
      }
      await appendJsonl(record)
      state.runs++
      state.fail++
      state.durations.push(duration_s)
      console.error(`[scheduler] run ${runN} spawn error: ${err.message}`)
      resolveRun(record)
    })
  })
}

function extractFallbackSummary(buf) {
  if (!buf) return ''
  const lines = buf.split(/\r?\n/).filter(Boolean)
  return lines.length ? lines[lines.length - 1].trim().slice(0, 240) : ''
}

// ─── Sleep that respects shutdown ───────────────────────────────────────────
function sleepInterruptible(ms) {
  return new Promise((resolveSleep) => {
    if (state.stopping) return resolveSleep()
    const timer = setTimeout(() => {
      cleanup()
      resolveSleep()
    }, ms)
    const onSignal = () => {
      clearTimeout(timer)
      cleanup()
      resolveSleep()
    }
    function cleanup() {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
}

// ─── Main loop ──────────────────────────────────────────────────────────────
async function main() {
  await ensureLogDir()

  const intervalMs = ARGS.intervalMin * 60 * 1000
  console.log(
    `[scheduler] starting :: interval=${ARGS.intervalMin}min  base=${ARGS.baseUrl}  ` +
    `log=${ARGS.logPath}  stop_after=${Number.isFinite(ARGS.stopAfterRuns) ? ARGS.stopAfterRuns : '∞'}`
  )
  console.log(`[scheduler] smoke script: ${SMOKE_SCRIPT}`)

  installSignalHandlers()

  let runN = 0
  while (!state.stopping && runN < ARGS.stopAfterRuns) {
    runN++
    state.inFlight = true
    await runSmokeOnce(runN)
    state.inFlight = false

    if (state.stopping) break
    if (runN >= ARGS.stopAfterRuns) break

    const nextAt = new Date(Date.now() + intervalMs).toISOString()
    console.log(`[scheduler] sleeping ${ARGS.intervalMin}min  next≈${nextAt}`)
    await sleepInterruptible(intervalMs)
  }

  printSummary()
  process.exit(0)
}

function installSignalHandlers() {
  const handle = (sig) => {
    if (state.exitRequested) return
    state.exitRequested = true
    state.stopping = true
    if (state.inFlight) {
      console.log(`\n[scheduler] ${sig} received :: finishing current run, then exiting...`)
    } else {
      console.log(`\n[scheduler] ${sig} received :: exiting...`)
    }
  }
  process.on('SIGINT', () => handle('SIGINT'))
  process.on('SIGTERM', () => handle('SIGTERM'))
}

function printSummary() {
  const elapsedS = (Date.now() - state.startedAt.getTime()) / 1000
  const avg = state.durations.length
    ? state.durations.reduce((a, b) => a + b, 0) / state.durations.length
    : 0
  console.log()
  console.log('─── scheduler summary ─────────────────────────')
  console.log(`  started      : ${state.startedAt.toISOString()}`)
  console.log(`  ended        : ${nowIso()}`)
  console.log(`  elapsed      : ${fmtDuration(elapsedS)}`)
  console.log(`  runs         : ${state.runs}`)
  console.log(`  ok / fail    : ${state.ok} / ${state.fail}`)
  console.log(`  avg run dur  : ${fmtDuration(avg)}`)
  console.log(`  log          : ${ARGS.logPath}`)
  console.log('───────────────────────────────────────────────')
}

main().catch((err) => {
  console.error('[scheduler] fatal:', err)
  process.exit(1)
})
