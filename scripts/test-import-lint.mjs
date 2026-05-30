#!/usr/bin/env node
// Unit tests for scripts/lint-imports.mjs.
//
// We spawn the lint script as a child process and verify:
//   - Exit code 0 against the current `src/` tree.
//   - --json output is parseable and has empty cycles[] and unresolved[].
//   - --include-api --include-scripts also passes with empty cycles[] / unresolved[].
//   - Output hash is stable across two consecutive invocations (deterministic).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const LINTER = join(REPO_ROOT, 'scripts', 'lint-imports.mjs')
const SRC_ROOT = join(REPO_ROOT, 'src')

function runLint(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [LINTER, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr })
    })
  })
}

function hashOutput(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

test('lint-imports: exits 0 against src/ with --json', async () => {
  const r = await runLint(['--json', '--root', SRC_ROOT])
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr=${r.stderr}`)
  assert.ok(r.stdout.trim().length > 0, 'stdout has content')
})

test('lint-imports: --json output has cycles=[] and unresolved=[]', async () => {
  const r = await runLint(['--json', '--root', SRC_ROOT])
  assert.equal(r.code, 0)
  const report = JSON.parse(r.stdout)
  assert.ok(Array.isArray(report.cycles), 'cycles is an array')
  assert.deepEqual(report.cycles, [], `unexpected cycles: ${JSON.stringify(report.cycles)}`)
  assert.ok(Array.isArray(report.unresolved), 'unresolved is an array')
  assert.deepEqual(report.unresolved, [], `unexpected unresolved: ${JSON.stringify(report.unresolved)}`)
  assert.equal(typeof report.scanned, 'number')
  assert.ok(report.scanned > 0, 'scanned at least one file')
})

test('lint-imports: --include-api --include-scripts also passes cleanly', async () => {
  const r = await runLint([
    '--json',
    '--root', SRC_ROOT,
    '--include-api',
    '--include-scripts',
  ])
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr=${r.stderr}`)
  const report = JSON.parse(r.stdout)
  assert.deepEqual(report.cycles, [], `unexpected cycles: ${JSON.stringify(report.cycles)}`)
  assert.deepEqual(report.unresolved, [], `unexpected unresolved: ${JSON.stringify(report.unresolved)}`)
  assert.equal(report.roots.includeApi, true)
  assert.equal(report.roots.includeScripts, true)
})

test('lint-imports: output is stable across two consecutive runs', async () => {
  const a = await runLint(['--json', '--root', SRC_ROOT])
  const b = await runLint(['--json', '--root', SRC_ROOT])
  assert.equal(a.code, 0)
  assert.equal(b.code, 0)
  // Compare structured report rather than raw stdout, since key order in JSON
  // is stable for object-literal builds but we want the assertion to be
  // semantic. Raw stdout hash is also checked.
  const reportA = JSON.parse(a.stdout)
  const reportB = JSON.parse(b.stdout)
  assert.deepEqual(reportA, reportB, 'reports must be structurally identical')
  // Raw stdout hash check — guards against any nondeterministic ordering
  // creeping into the formatter.
  assert.equal(
    hashOutput(a.stdout),
    hashOutput(b.stdout),
    'stdout sha256 must be identical across runs'
  )
})

test('lint-imports: non-json mode also exits 0 and produces [OK] markers', async () => {
  const r = await runLint(['--root', SRC_ROOT])
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr=${r.stderr}`)
  assert.match(r.stdout, /\[OK\] no circular imports/)
  assert.match(r.stdout, /\[OK\] all relative imports resolve/)
})
