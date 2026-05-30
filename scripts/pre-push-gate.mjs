#!/usr/bin/env node
// Pre-push quality gate.
// Runs local quality checks sequentially. Non-zero exit on first hard failure.
// Soft steps (responsive audit) log to stderr but never fail the gate.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

/**
 * Run a child process to completion. Returns { code, ms }.
 * stdio is inherited so the user sees live output.
 * On Windows, npm is a .cmd shim — use shell: true so spawn finds it.
 */
function runStep(cmd, args, { cwd = repoRoot } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, ms: Date.now() - started });
    });
    child.on('error', (err) => {
      process.stderr.write(`\n[pre-push-gate] spawn error: ${err.message}\n`);
      resolvePromise({ code: 1, ms: Date.now() - started });
    });
  });
}

const steps = [
  {
    name: 'tests',
    label: 'Tests + lint guard',
    cmd: 'node',
    args: ['scripts/run-tests.mjs'],
    soft: false,
  },
  {
    name: 'responsive',
    label: 'Responsive audit (report-only)',
    cmd: 'node',
    args: ['scripts/responsive-audit.mjs'],
    soft: true,
  },
  {
    name: 'a11y',
    label: 'A11y audit',
    cmd: 'node',
    args: ['scripts/a11y-audit.mjs'],
    soft: false,
  },
  {
    name: 'lint-imports',
    label: 'Import graph (cycles + unresolved)',
    cmd: 'node',
    args: ['scripts/lint-imports.mjs'],
    soft: false,
  },
  {
    name: 'build',
    label: 'Production build',
    cmd: 'npm',
    args: ['run', 'build'],
    soft: false,
  },
  {
    name: 'bundle-budget',
    label: 'Bundle budget',
    cmd: 'node',
    args: ['scripts/check-bundle-budget.mjs'],
    soft: false,
  },
  {
    name: 'cache-bust',
    label: 'Cache-bust audit',
    cmd: 'node',
    args: ['scripts/cache-bust-audit.mjs'],
    soft: false,
  },
];

const results = [];
let hardFailed = false;

const startedAll = Date.now();

for (const step of steps) {
  if (hardFailed) {
    results.push({ ...step, code: -1, ms: 0, skipped: true });
    continue;
  }
  process.stdout.write(`\n[pre-push-gate] -> ${step.label}\n`);
  const { code, ms } = await runStep(step.cmd, step.args);
  results.push({ ...step, code, ms, skipped: false });
  if (code !== 0) {
    if (step.soft) {
      process.stderr.write(
        `[pre-push-gate] ${step.label} reported issues (soft, continuing).\n`,
      );
    } else {
      hardFailed = true;
      process.stderr.write(
        `[pre-push-gate] HARD FAIL: ${step.label} (exit ${code}).\n`,
      );
    }
  }
}

const totalMs = Date.now() - startedAll;

// Aligned summary table.
const nameWidth = Math.max(...results.map((r) => r.label.length), 'Step'.length);
const statusFor = (r) => {
  if (r.skipped) return 'SKIP';
  if (r.code === 0) return 'PASS';
  if (r.soft) return 'WARN';
  return 'FAIL';
};

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
const fmtMs = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

process.stdout.write('\n');
process.stdout.write('======== pre-push-gate summary ========\n');
process.stdout.write(
  `${pad('Step', nameWidth)}  ${pad('Status', 6)}  ${pad('Time', 8)}\n`,
);
process.stdout.write(`${'-'.repeat(nameWidth)}  ------  --------\n`);
for (const r of results) {
  process.stdout.write(
    `${pad(r.label, nameWidth)}  ${pad(statusFor(r), 6)}  ${pad(
      r.skipped ? '-' : fmtMs(r.ms),
      8,
    )}\n`,
  );
}
process.stdout.write(`${'-'.repeat(nameWidth)}  ------  --------\n`);
process.stdout.write(
  `${pad('TOTAL', nameWidth)}  ${pad(hardFailed ? 'FAIL' : 'PASS', 6)}  ${pad(
    fmtMs(totalMs),
    8,
  )}\n`,
);
process.stdout.write('=======================================\n');

process.exit(hardFailed ? 1 : 0);
