#!/usr/bin/env node
// Test runner for PaperFate lightweight unit tests.
// Runs the registered node:test files sequentially via the built-in node test
// runner, prints a summary, then runs scripts/lint-imports.mjs as a final
// guard. Exits non-zero on any failure (test fail OR lint exit != 0).
//
// Usage:  node scripts/run-tests.mjs

import { run } from 'node:test'
import { spec } from 'node:test/reporters'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FILES = [
  join(__dirname, 'test-sanitizer.mjs'),
  join(__dirname, 'test-confidence-cap.mjs'),
  join(__dirname, 'test-rate-limiter.mjs'),
  join(__dirname, 'test-forecast-history.mjs'),
  join(__dirname, 'test-i18n.mjs'),
  join(__dirname, 'test-import-lint.mjs'),
]

let passed = 0
let failed = 0
const failures = []

const stream = run({
  files: FILES,
  concurrency: false,
})

stream.on('test:pass', (e) => {
  // node:test emits test:pass for both individual tests and the file-level
  // top-level test. Count only the leaf-level tests (skip suite wrappers).
  if (!e.todo && !e.skip && e.details && Number.isFinite(e.details.duration_ms)) {
    passed++
  }
})

stream.on('test:fail', (e) => {
  if (!e.todo && !e.skip) {
    failed++
    failures.push({
      name: e.name,
      file: e.file,
      error: e.details?.error?.message || String(e.details?.error || 'unknown'),
    })
  }
})

// Also pipe a human-readable reporter to stdout so devs see progress.
stream.compose(spec).pipe(process.stdout)

stream.on('end', () => {
  console.log('\n──────────────────────────────────────────────')
  console.log(`PaperFate unit tests: ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('Failures:')
    for (const f of failures) {
      console.log(`  ✗ ${f.name}  (${f.file})`)
      console.log(`    ${f.error}`)
    }
  }
  console.log('──────────────────────────────────────────────')

  if (failed > 0) {
    process.exit(1)
  }

  // Final guard: run lint-imports.mjs (non-json human format). Any non-zero
  // exit fails the whole test run.
  const linter = join(__dirname, 'lint-imports.mjs')
  console.log('\nRunning import lint guard...')
  const child = spawn(process.execPath, [linter], {
    stdio: 'inherit',
  })
  child.on('error', (err) => {
    console.error(`lint-imports.mjs failed to spawn: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`lint-imports.mjs exited with code ${code}`)
      process.exit(1)
    }
    console.log('Import lint guard passed.')
    process.exit(0)
  })
})
