#!/usr/bin/env node
/**
 * responsive-audit.mjs — static Tailwind responsive-class audit.
 *
 * Walks src/components/*.jsx and src/App.jsx, parses className attribute
 * string values, counts responsive prefix usage (sm:/md:/lg:/xl:/2xl:),
 * and flags files with heavy fixed-width usage (w-[XX], px-XX) lacking
 * any sm: breakpoint as potential mobile-layout risks.
 *
 * Report-only — always exits 0.
 *
 * CLI:
 *   node scripts/responsive-audit.mjs [--src DIR] [--json]
 *
 * --src DIR  base directory; the script will scan <DIR>/components/*.jsx
 *            and <DIR>/App.jsx. Default: "src".
 * --json     emit machine-readable JSON instead of the aligned table.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    src: 'src',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') {
      opts.src = argv[++i];
    } else if (a.startsWith('--src=')) {
      opts.src = a.slice('--src='.length);
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      'responsive-audit.mjs — Tailwind responsive-class audit',
      '',
      'Usage:',
      '  node scripts/responsive-audit.mjs [--src DIR] [--json]',
      '',
      'Options:',
      '  --src DIR   base source dir (scans <DIR>/components/*.jsx + <DIR>/App.jsx)',
      '              default: src',
      '  --json      emit JSON report instead of aligned text table',
      '  -h, --help  show this help',
      '',
      'Always exits 0 (report-only).',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function collectTargets(srcDir) {
  const files = [];
  const componentsDir = join(srcDir, 'components');
  if (existsSync(componentsDir) && statSync(componentsDir).isDirectory()) {
    for (const name of readdirSync(componentsDir)) {
      if (!name.endsWith('.jsx')) continue;
      const full = join(componentsDir, name);
      try {
        if (statSync(full).isFile()) files.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  const appJsx = join(srcDir, 'App.jsx');
  if (existsSync(appJsx) && statSync(appJsx).isFile()) {
    files.push(appJsx);
  }
  files.sort();
  return files;
}

// ---------------------------------------------------------------------------
// className extraction
// ---------------------------------------------------------------------------
// Capture className="..." and className='...'. Template literals and
// expressions are best-effort: we additionally pick up any quoted string
// fragments inside className={...} blocks via a secondary pass.
const CLASSNAME_DQ = /className\s*=\s*"([^"]*)"/g;
const CLASSNAME_SQ = /className\s*=\s*'([^']*)'/g;
const CLASSNAME_EXPR = /className\s*=\s*\{([\s\S]*?)\}/g;
// Strings inside an expression: "...", '...', or `...` (no nested ${})
const STRING_LITERAL = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`$\\]*(?:\\.[^`$\\]*)*)`/g;

function extractClassNameStrings(source) {
  const out = [];
  let m;
  CLASSNAME_DQ.lastIndex = 0;
  while ((m = CLASSNAME_DQ.exec(source)) !== null) out.push(m[1]);
  CLASSNAME_SQ.lastIndex = 0;
  while ((m = CLASSNAME_SQ.exec(source)) !== null) out.push(m[1]);
  CLASSNAME_EXPR.lastIndex = 0;
  while ((m = CLASSNAME_EXPR.exec(source)) !== null) {
    const inner = m[1];
    STRING_LITERAL.lastIndex = 0;
    let sm;
    while ((sm = STRING_LITERAL.exec(inner)) !== null) {
      const v = sm[1] ?? sm[2] ?? sm[3];
      if (v != null) out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Class tokenization / counting
// ---------------------------------------------------------------------------
const BREAKPOINTS = ['sm:', 'md:', 'lg:', 'xl:', '2xl:'];

// A token is "responsive" if any of its colon-segments (before the final
// utility) equals one of the breakpoints. Tailwind allows stacked variants
// like "md:hover:bg-blue-500" or "dark:md:px-4".
function classifyToken(token) {
  if (!token) return { breakpoint: null, base: token };
  // Strip leading "!" important prefix
  const t = token.startsWith('!') ? token.slice(1) : token;
  // Split on ":" but be careful about arbitrary-value brackets containing ":"
  // e.g. md:bg-[url(https://...)] — we only need the variant prefix(es).
  // Find the last ":" that's outside [ ... ].
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) lastColon = i;
  }
  if (lastColon < 0) return { breakpoint: null, base: t };
  const variants = t.slice(0, lastColon + 1); // includes trailing colon
  const base = t.slice(lastColon + 1);
  for (const bp of BREAKPOINTS) {
    if (variants.includes(bp)) return { breakpoint: bp, base };
  }
  return { breakpoint: null, base };
}

// Fixed-width-ish utilities we want to flag when unaccompanied by sm: anywhere.
//   w-[<arbitrary>] / min-w-[..] / max-w-[..]
//   w-<n> px-<n> where n is a Tailwind numeric step (digits, optional .5)
const FIXED_WIDTH_ARBITRARY = /^(?:min-|max-)?w-\[[^\]]+\]$/;
const FIXED_WIDTH_NUMERIC = /^w-(?:\d+(?:\.5)?|px)$/;
const PX_NUMERIC = /^px-(?:\d+(?:\.5)?|px)$/;

function isFixedWidthish(base) {
  return (
    FIXED_WIDTH_ARBITRARY.test(base) ||
    FIXED_WIDTH_NUMERIC.test(base) ||
    PX_NUMERIC.test(base)
  );
}

function analyzeFile(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const classStrings = extractClassNameStrings(source);
  const stats = {
    totalClasses: 0,
    breakpoints: { 'sm:': 0, 'md:': 0, 'lg:': 0, 'xl:': 0, '2xl:': 0 },
    fixedWidthTokens: 0,
    fixedWidthTokensWithBreakpoint: 0,
  };
  for (const cs of classStrings) {
    // Split on whitespace; Tailwind classes don't contain spaces (arbitrary
    // values disallow them too).
    const tokens = cs.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      stats.totalClasses++;
      const { breakpoint, base } = classifyToken(tok);
      if (breakpoint) stats.breakpoints[breakpoint]++;
      if (isFixedWidthish(base)) {
        stats.fixedWidthTokens++;
        if (breakpoint) stats.fixedWidthTokensWithBreakpoint++;
      }
    }
  }
  const responsiveTotal =
    stats.breakpoints['sm:'] +
    stats.breakpoints['md:'] +
    stats.breakpoints['lg:'] +
    stats.breakpoints['xl:'] +
    stats.breakpoints['2xl:'];
  const responsiveRatio =
    stats.totalClasses > 0 ? responsiveTotal / stats.totalClasses : 0;
  const fixedWidthWithoutBreakpoint =
    stats.fixedWidthTokens - stats.fixedWidthTokensWithBreakpoint;
  // Flag: many fixed widths but no sm: at all — likely fixed desktop layout.
  const flagged =
    stats.breakpoints['sm:'] === 0 && fixedWidthWithoutBreakpoint >= 3;
  return {
    file: filePath,
    totalClasses: stats.totalClasses,
    sm: stats.breakpoints['sm:'],
    md: stats.breakpoints['md:'],
    lg: stats.breakpoints['lg:'],
    xl: stats.breakpoints['xl:'],
    xl2: stats.breakpoints['2xl:'],
    responsiveTotal,
    responsiveRatio,
    fixedWidthTokens: stats.fixedWidthTokens,
    fixedWidthWithoutBreakpoint,
    flagged,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function pad(s, n, align = 'left') {
  const str = String(s);
  if (str.length >= n) return str;
  const fill = ' '.repeat(n - str.length);
  return align === 'right' ? fill + str : str + fill;
}

function renderTextReport(rows, summary, baseDir) {
  const headers = {
    file: 'file',
    total: 'total',
    sm: 'sm:',
    md: 'md:',
    lg: 'lg:',
    xl: 'xl:',
    xl2: '2xl:',
    fw: 'fw_no_bp',
    flag: 'flag',
  };
  const fileCol = Math.max(
    headers.file.length,
    ...rows.map((r) => relative(baseDir, r.file).split(sep).join('/').length),
  );
  const numCols = {
    total: Math.max(headers.total.length, 5),
    sm: Math.max(headers.sm.length, 4),
    md: Math.max(headers.md.length, 4),
    lg: Math.max(headers.lg.length, 4),
    xl: Math.max(headers.xl.length, 4),
    xl2: Math.max(headers.xl2.length, 4),
    fw: Math.max(headers.fw.length, 8),
    flag: Math.max(headers.flag.length, 4),
  };
  const lines = [];
  lines.push(
    [
      pad(headers.file, fileCol),
      pad(headers.total, numCols.total, 'right'),
      pad(headers.sm, numCols.sm, 'right'),
      pad(headers.md, numCols.md, 'right'),
      pad(headers.lg, numCols.lg, 'right'),
      pad(headers.xl, numCols.xl, 'right'),
      pad(headers.xl2, numCols.xl2, 'right'),
      pad(headers.fw, numCols.fw, 'right'),
      pad(headers.flag, numCols.flag, 'right'),
    ].join('  '),
  );
  lines.push(
    [
      '-'.repeat(fileCol),
      '-'.repeat(numCols.total),
      '-'.repeat(numCols.sm),
      '-'.repeat(numCols.md),
      '-'.repeat(numCols.lg),
      '-'.repeat(numCols.xl),
      '-'.repeat(numCols.xl2),
      '-'.repeat(numCols.fw),
      '-'.repeat(numCols.flag),
    ].join('  '),
  );
  for (const r of rows) {
    const rel = relative(baseDir, r.file).split(sep).join('/');
    lines.push(
      [
        pad(rel, fileCol),
        pad(r.totalClasses, numCols.total, 'right'),
        pad(r.sm, numCols.sm, 'right'),
        pad(r.md, numCols.md, 'right'),
        pad(r.lg, numCols.lg, 'right'),
        pad(r.xl, numCols.xl, 'right'),
        pad(r.xl2, numCols.xl2, 'right'),
        pad(r.fixedWidthWithoutBreakpoint, numCols.fw, 'right'),
        pad(r.flagged ? 'YES' : '', numCols.flag, 'right'),
      ].join('  '),
    );
  }
  lines.push('');
  lines.push(`Total components scanned: ${summary.totalComponents}`);
  lines.push(
    `Average responsive ratio: ${(summary.avgResponsiveRatio * 100).toFixed(1)}%  ` +
      `(${summary.totalResponsive}/${summary.totalClasses} classes)`,
  );
  lines.push(`Files flagged (fixed widths, no sm:): ${summary.flaggedCount}`);
  if (summary.flaggedFiles.length > 0) {
    for (const f of summary.flaggedFiles) {
      const rel = relative(baseDir, f).split(sep).join('/');
      lines.push(`  - ${rel}`);
    }
  }
  return lines.join('\n') + '\n';
}

function buildSummary(rows) {
  const totalComponents = rows.length;
  let totalClasses = 0;
  let totalResponsive = 0;
  const flaggedFiles = [];
  for (const r of rows) {
    totalClasses += r.totalClasses;
    totalResponsive += r.responsiveTotal;
    if (r.flagged) flaggedFiles.push(r.file);
  }
  const avgResponsiveRatio =
    totalClasses > 0 ? totalResponsive / totalClasses : 0;
  return {
    totalComponents,
    totalClasses,
    totalResponsive,
    avgResponsiveRatio,
    flaggedCount: flaggedFiles.length,
    flaggedFiles,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseDir = process.cwd();
  const srcDir = resolve(baseDir, opts.src);

  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    const msg = `responsive-audit: source directory not found: ${srcDir}`;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ error: msg, files: [], summary: null }, null, 2) + '\n',
      );
    } else {
      process.stderr.write(msg + '\n');
    }
    process.exit(0);
  }

  const targets = collectTargets(srcDir);
  const rows = targets.map(analyzeFile);
  const summary = buildSummary(rows);

  if (opts.json) {
    const payload = {
      src: srcDir,
      breakpoints: BREAKPOINTS,
      files: rows.map((r) => ({
        file: r.file,
        relPath: relative(baseDir, r.file).split(sep).join('/'),
        totalClasses: r.totalClasses,
        responsive: {
          'sm:': r.sm,
          'md:': r.md,
          'lg:': r.lg,
          'xl:': r.xl,
          '2xl:': r.xl2,
          total: r.responsiveTotal,
          ratio: Number(r.responsiveRatio.toFixed(4)),
        },
        fixedWidthTokens: r.fixedWidthTokens,
        fixedWidthWithoutBreakpoint: r.fixedWidthWithoutBreakpoint,
        flagged: r.flagged,
      })),
      summary: {
        totalComponents: summary.totalComponents,
        totalClasses: summary.totalClasses,
        totalResponsive: summary.totalResponsive,
        avgResponsiveRatio: Number(summary.avgResponsiveRatio.toFixed(4)),
        flaggedCount: summary.flaggedCount,
        flaggedFiles: summary.flaggedFiles.map((f) =>
          relative(baseDir, f).split(sep).join('/'),
        ),
      },
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(renderTextReport(rows, summary, baseDir));
  }

  process.exit(0);
}

main();
