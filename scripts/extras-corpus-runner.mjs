#!/usr/bin/env node
// PaperFate extras corpus runner.
//
// Resilient wrapper around scripts/run-extras-pipeline.mjs. Spawns the
// pipeline as a child `node` process, streams its output with line buffering,
// and retries up to N times with exponential backoff if the child exits
// non-zero.
//
// Usage:
//   node scripts/extras-corpus-runner.mjs [--max-attempts N]
//                                          [--initial-backoff-ms M]
//                                          [-- <forward args to pipeline>]
//
// CLI:
//   --max-attempts N        max attempts including the first (default 3)
//   --initial-backoff-ms M  base backoff in ms; doubles each retry (default 30000)
//   --help, -h              print help and exit
//
// Any args after `--` are forwarded verbatim to run-extras-pipeline.mjs.
//
// Env:
//   DATA_ROOT               forwarded to the child untouched.
//
// Exit code:
//   0 if any attempt succeeded.
//   1 (or the child's last non-zero code) if all attempts failed.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PIPELINE_SCRIPT = join(HERE, 'run-extras-pipeline.mjs')

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = {
    maxAttempts: 3,
    initialBackoffMs: 30000,
    forwarded: [],
  }
  let i = 2
  while (i < argv.length) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--') {
      out.forwarded = argv.slice(i + 1)
      break
    } else if (a === '--max-attempts' && next != null) {
      const n = Number(next)
      if (!Number.isFinite(n) || n < 1) {
        console.error(`Invalid --max-attempts: ${next}`)
        process.exit(2)
      }
      out.maxAttempts = Math.floor(n)
      i += 2
    } else if (a === '--initial-backoff-ms' && next != null) {
      const m = Number(next)
      if (!Number.isFinite(m) || m < 0) {
        console.error(`Invalid --initial-backoff-ms: ${next}`)
        process.exit(2)
      }
      out.initialBackoffMs = Math.floor(m)
      i += 2
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/extras-corpus-runner.mjs ' +
          '[--max-attempts N] [--initial-backoff-ms M] [-- <pipeline args>]',
      )
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${a}`)
      process.exit(2)
    }
  }
  return out
}

// ---------- child runner ----------
// Stream stdout/stderr line-by-line with a [pipeline] prefix. Returns the
// child's exit code (0 on success) without rejecting on non-zero — the retry
// loop is in main().
function runPipeline(extraArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const t0 = Date.now()
    let spawnError = null
    const child = spawn(process.execPath, [PIPELINE_SCRIPT, ...extraArgs], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    function attachStream(stream, isErr) {
      stream.setEncoding('utf8')
      let buf = ''
      stream.on('data', chunk => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          const out = `[pipeline] ${line}`
          if (isErr) process.stderr.write(out + '\n')
          else process.stdout.write(out + '\n')
        }
      })
      stream.on('end', () => {
        if (buf.length) {
          const out = `[pipeline] ${buf}`
          if (isErr) process.stderr.write(out + '\n')
          else process.stdout.write(out + '\n')
        }
      })
    }

    attachStream(child.stdout, false)
    attachStream(child.stderr, true)

    child.on('error', err => {
      // e.g. ENOENT / EACCES on the node binary; surface to caller and let it
      // count as a failed attempt.
      spawnError = err
    })
    child.on('close', code => {
      const elapsedMs = Date.now() - t0
      if (spawnError) {
        rejectPromise(Object.assign(spawnError, { elapsedMs }))
        return
      }
      resolvePromise({ code: code == null ? 1 : code, elapsedMs })
    })
  })
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv)
  const tRunner0 = Date.now()

  console.log('PaperFate extras corpus runner')
  console.log(`  root              : ${ROOT}`)
  console.log(`  pipeline_script   : ${PIPELINE_SCRIPT}`)
  console.log(`  DATA_ROOT         : ${process.env.DATA_ROOT || '(default: <root>/data)'}`)
  console.log(`  max_attempts      : ${args.maxAttempts}`)
  console.log(`  initial_backoff_ms: ${args.initialBackoffMs}`)
  console.log(`  forwarded_args    : ${args.forwarded.length ? args.forwarded.join(' ') : '(none)'}`)
  console.log('')

  let lastExitCode = 1
  let success = false
  let successAttempt = null
  let totalAttempts = 0

  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    totalAttempts = attempt
    console.log(`\n>> attempt ${attempt}/${args.maxAttempts}`)
    let result
    try {
      result = await runPipeline(args.forwarded)
    } catch (err) {
      console.error(`!! attempt ${attempt} spawn error: ${err.message}`)
      lastExitCode = 1
      if (attempt < args.maxAttempts) {
        const backoff = args.initialBackoffMs * Math.pow(2, attempt - 1)
        console.log(`   sleeping ${(backoff / 1000).toFixed(1)}s before next attempt`)
        await sleep(backoff)
      }
      continue
    }
    lastExitCode = result.code
    if (result.code === 0) {
      console.log(
        `   attempt ${attempt} succeeded in ${(result.elapsedMs / 1000).toFixed(1)}s`,
      )
      success = true
      successAttempt = attempt
      break
    }
    console.error(
      `!! attempt ${attempt} failed with exit code ${result.code} ` +
        `(elapsed ${(result.elapsedMs / 1000).toFixed(1)}s)`,
    )
    if (attempt < args.maxAttempts) {
      const backoff = args.initialBackoffMs * Math.pow(2, attempt - 1)
      console.log(`   sleeping ${(backoff / 1000).toFixed(1)}s before next attempt`)
      await sleep(backoff)
    }
  }

  const totalWallSec = (Date.now() - tRunner0) / 1000

  console.log('\n=== extras corpus runner summary ===')
  console.log(`  total_attempts      : ${totalAttempts}`)
  console.log(`  success             : ${success}`)
  console.log(`  success_on_attempt  : ${successAttempt ?? 'n/a'}`)
  console.log(`  last_exit_code      : ${lastExitCode}`)
  console.log(`  total_wall_s        : ${totalWallSec.toFixed(1)}`)

  if (!success) {
    process.exitCode = lastExitCode || 1
  }
}

main().catch(err => {
  console.error('extras-corpus-runner crashed:', err && err.stack ? err.stack : err)
  process.exitCode = 1
})
