#!/usr/bin/env node
// PaperFate extras pipeline runner.
//
// One-shot wrapper that (1) populates paper_extras_v2 via
// scripts/build-extras-features-v2.mjs and (2) exports the runtime subset
// consumed by /api/extras-lookup via scripts/export-extras-subset.mjs.
//
// CLI:
//   --skip-build          run only the export step
//   --skip-export         run only the build step
//   --limit-build N       forward --limit=N to build-extras-features-v2.mjs
//   --limit-export N      forward --limit N to export-extras-subset.mjs
//   --min-jif F           forward --min-jif F to export-extras-subset.mjs
//
// Env:
//   DATA_ROOT             honored (forwarded to both children)
//
// Behaviour:
//   - Spawns each child as a separate `node` process.
//   - Streams stdout/stderr live with a '[build]' / '[export]' prefix.
//   - Aborts the whole pipeline if either child exits non-zero.
//   - Prints a final summary: build rows processed, export file size MB,
//     total wall time.

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const BUILD_SCRIPT = join(HERE, 'build-extras-features-v2.mjs')
const EXPORT_SCRIPT = join(HERE, 'export-extras-subset.mjs')
const DEFAULT_EXPORT_OUT = join(ROOT, 'weights', 'paper_extras_v2_subset.json')

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = {
    skipBuild: false,
    skipExport: false,
    limitBuild: null,
    limitExport: null,
    minJif: null,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--skip-build') {
      out.skipBuild = true
    } else if (a === '--skip-export') {
      out.skipExport = true
    } else if (a === '--limit-build' && next != null) {
      const n = Number(next)
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --limit-build: ${next}`)
        process.exit(2)
      }
      out.limitBuild = Math.floor(n)
      i++
    } else if (a === '--limit-export' && next != null) {
      const n = Number(next)
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --limit-export: ${next}`)
        process.exit(2)
      }
      out.limitExport = Math.floor(n)
      i++
    } else if (a === '--min-jif' && next != null) {
      const f = Number(next)
      if (!Number.isFinite(f) || f < 0) {
        console.error(`Invalid --min-jif: ${next}`)
        process.exit(2)
      }
      out.minJif = f
      i++
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/run-extras-pipeline.mjs ' +
          '[--skip-build] [--skip-export] [--limit-build N] [--limit-export N] [--min-jif F]',
      )
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${a}`)
      process.exit(2)
    }
  }
  if (out.skipBuild && out.skipExport) {
    console.error('Refusing to run: both --skip-build and --skip-export were given (nothing to do).')
    process.exit(2)
  }
  return out
}

const args = parseArgs(process.argv)

// ---------- child runner ----------
// Stream stdout/stderr line-by-line with a per-child prefix. Captures combined
// output so we can grep the build summary afterwards.
function runChild(prefix, scriptPath, extraArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let captured = ''
    const tag = `[${prefix}]`

    function attachStream(stream, isErr) {
      stream.setEncoding('utf8')
      let buf = ''
      stream.on('data', chunk => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          const out = `${tag} ${line}`
          if (isErr) process.stderr.write(out + '\n')
          else process.stdout.write(out + '\n')
          captured += line + '\n'
        }
      })
      stream.on('end', () => {
        if (buf.length) {
          const out = `${tag} ${buf}`
          if (isErr) process.stderr.write(out + '\n')
          else process.stdout.write(out + '\n')
          captured += buf + '\n'
        }
      })
    }

    attachStream(child.stdout, false)
    attachStream(child.stderr, true)

    child.on('error', err => {
      rejectPromise(err)
    })
    child.on('close', code => {
      const elapsedMs = Date.now() - t0
      if (code === 0) {
        resolvePromise({ captured, elapsedMs })
      } else {
        const err = new Error(`${prefix} child exited with code ${code}`)
        err.code = code
        err.captured = captured
        err.elapsedMs = elapsedMs
        rejectPromise(err)
      }
    })
  })
}

// ---------- summary parsers ----------
function parseBuildSummary(captured) {
  // build-extras-features-v2.mjs prints:
  //   seen:           N
  //   written:        N
  //   with_refs:      N
  //   with_coauthors: N
  //   table rows now: N
  function grab(label) {
    const re = new RegExp(`${label}\\s*:?\\s*([\\d,]+)`)
    const m = captured.match(re)
    if (!m) return null
    const n = Number(m[1].replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return {
    seen: grab('seen'),
    written: grab('written'),
    with_refs: grab('with_refs'),
    with_coauthors: grab('with_coauthors'),
    table_rows: grab('table rows now'),
  }
}

function fileSizeMb(path) {
  try {
    return statSync(path).size / (1024 * 1024)
  } catch {
    return null
  }
}

// ---------- main ----------
async function main() {
  const tPipeline0 = Date.now()
  console.log('PaperFate extras pipeline runner')
  console.log(`  root        : ${ROOT}`)
  console.log(`  DATA_ROOT   : ${process.env.DATA_ROOT || '(default: <root>/data)'}`)
  console.log(`  skip-build  : ${args.skipBuild}`)
  console.log(`  skip-export : ${args.skipExport}`)
  if (args.limitBuild != null) console.log(`  limit-build : ${args.limitBuild}`)
  if (args.limitExport != null) console.log(`  limit-export: ${args.limitExport}`)
  if (args.minJif != null) console.log(`  min-jif     : ${args.minJif}`)
  console.log('')

  let buildSummary = null
  let buildElapsedMs = 0
  let exportElapsedMs = 0

  // ---- build step ----
  if (!args.skipBuild) {
    const buildArgs = []
    if (args.limitBuild != null) buildArgs.push(`--limit=${args.limitBuild}`)
    console.log(`>> build: ${BUILD_SCRIPT} ${buildArgs.join(' ')}`)
    try {
      const { captured, elapsedMs } = await runChild('build', BUILD_SCRIPT, buildArgs)
      buildElapsedMs = elapsedMs
      buildSummary = parseBuildSummary(captured)
    } catch (err) {
      console.error(`\n!! build step failed: ${err.message}`)
      process.exitCode = err.code && err.code !== 0 ? err.code : 1
      return
    }
  } else {
    console.log('>> build: skipped (--skip-build)')
  }

  // ---- export step ----
  if (!args.skipExport) {
    const exportArgs = []
    if (args.limitExport != null) {
      exportArgs.push('--limit', String(args.limitExport))
    }
    if (args.minJif != null) {
      exportArgs.push('--min-jif', String(args.minJif))
    }
    console.log(`\n>> export: ${EXPORT_SCRIPT} ${exportArgs.join(' ')}`)
    try {
      const { elapsedMs } = await runChild('export', EXPORT_SCRIPT, exportArgs)
      exportElapsedMs = elapsedMs
    } catch (err) {
      console.error(`\n!! export step failed: ${err.message}`)
      process.exitCode = err.code && err.code !== 0 ? err.code : 1
      return
    }
  } else {
    console.log('>> export: skipped (--skip-export)')
  }

  // ---- summary ----
  const wallSec = (Date.now() - tPipeline0) / 1000
  const exportSizeMb = !args.skipExport ? fileSizeMb(DEFAULT_EXPORT_OUT) : null

  console.log('\n=== extras pipeline summary ===')
  if (buildSummary) {
    console.log(`  build.seen          : ${buildSummary.seen ?? 'n/a'}`)
    console.log(`  build.written       : ${buildSummary.written ?? 'n/a'}`)
    console.log(`  build.with_refs     : ${buildSummary.with_refs ?? 'n/a'}`)
    console.log(`  build.with_coauthors: ${buildSummary.with_coauthors ?? 'n/a'}`)
    console.log(`  build.table_rows    : ${buildSummary.table_rows ?? 'n/a'}`)
    console.log(`  build.elapsed_s     : ${(buildElapsedMs / 1000).toFixed(1)}`)
  } else {
    console.log('  build               : skipped')
  }
  if (!args.skipExport) {
    console.log(`  export.file         : ${DEFAULT_EXPORT_OUT}`)
    console.log(`  export.size_mb      : ${exportSizeMb != null ? exportSizeMb.toFixed(2) : 'n/a'}`)
    console.log(`  export.elapsed_s    : ${(exportElapsedMs / 1000).toFixed(1)}`)
  } else {
    console.log('  export              : skipped')
  }
  console.log(`  total_wall_s        : ${wallSec.toFixed(1)}`)
}

main().catch(err => {
  console.error('pipeline crashed:', err && err.stack ? err.stack : err)
  process.exitCode = 1
})
