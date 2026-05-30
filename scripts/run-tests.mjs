#!/usr/bin/env node
// Test runner for PaperFate lightweight unit tests.
// Runs the three node:test files sequentially via the built-in node test runner,
// prints a summary, and exits non-zero on any failure.
//
// Usage:  node scripts/run-tests.mjs

import { run } from 'node:test'
import { spec } from 'node:test/reporters'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FILES = [
  join(__dirname, 'test-sanitizer.mjs'),
  join(__dirname, 'test-confidence-cap.mjs'),
  join(__dirname, 'test-rate-limiter.mjs'),
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
  process.exit(failed > 0 ? 1 : 0)
})
