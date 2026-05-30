#!/usr/bin/env node
/**
 * a11y-audit.mjs — static accessibility audit for src/components/*.jsx
 *
 * No browser. No axe-core. Pure regex/AST-lite scanning.
 *
 * CLI:
 *   node scripts/a11y-audit.mjs [--src DIR] [--json] [--strict]
 *
 * Exit:
 *   0 if zero ERROR findings (in strict mode, zero ERROR+WARN)
 *   1 otherwise
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    src: 'src/components',
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') {
      opts.src = argv[++i];
    } else if (a.startsWith('--src=')) {
      opts.src = a.slice('--src='.length);
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--strict') {
      opts.strict = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  const msg = [
    'a11y-audit.mjs — static accessibility audit',
    '',
    'Usage:',
    '  node scripts/a11y-audit.mjs [options]',
    '',
    'Options:',
    '  --src DIR      directory to scan (default: src/components)',
    '  --json         emit findings as JSON',
    '  --strict       treat WARN as ERROR for exit code',
    '  --help, -h     show this help',
  ].join('\n');
  process.stdout.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function walkJsx(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // skip node_modules / hidden dirs defensively
      if (name === 'node_modules' || name.startsWith('.')) continue;
      out.push(...walkJsx(full));
    } else if (st.isFile() && name.endsWith('.jsx')) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSX tag extraction (AST-lite)
// ---------------------------------------------------------------------------
// We scan for opening tags: <Name ...>, <Name ... />, including <Name>
// Self-closing and paired forms are both captured. We treat the inner body
// (between matching paired open/close, naive: until the next </Name>) as
// "children" for text-content checks.
//
// Notes:
//  - Attribute values can be "..." or '...' or {expr}.
//  - We ignore JSX fragments (<> ... </>) and comments.
//  - We do not fully parse balanced JSX trees; we only need enough to
//    detect whether <button>X</button> has non-empty text/children.

const TAG_RE = /<([A-Za-z][A-Za-z0-9.:_-]*)\b([^<>]*?)(\/?)>/g;

// Attribute regex: name=("..."|'...'|{...}) | name (boolean)
const ATTR_RE =
  /([:A-Za-z_][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;

function parseAttrs(attrText) {
  const attrs = {};
  if (!attrText) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrText)) !== null) {
    const name = m[1];
    if (!name) continue;
    let value;
    let valueKind;
    if (m[2] !== undefined) {
      value = m[2];
      valueKind = 'string';
    } else if (m[3] !== undefined) {
      value = m[3];
      valueKind = 'string';
    } else if (m[4] !== undefined) {
      value = m[4].trim();
      valueKind = 'expr';
    } else {
      value = true;
      valueKind = 'bool';
    }
    attrs[name] = { value, kind: valueKind };
  }
  return attrs;
}

function lineOf(source, index) {
  // 1-indexed line number for an absolute char index
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

// Find children text for a paired open tag. Returns concatenated raw text
// (including {expr}) between <name ...> and the next </name>. Naive — does
// not handle nested same-name tags — sufficient for common button cases.
function findChildrenSlice(source, tagName, openEndIdx) {
  const closeRe = new RegExp(`</\\s*${tagName}\\s*>`, 'g');
  closeRe.lastIndex = openEndIdx;
  const m = closeRe.exec(source);
  if (!m) return '';
  return source.slice(openEndIdx, m.index);
}

// Strip JSX expression braces / whitespace to see if "real" text exists.
function hasMeaningfulChildren(rawSlice) {
  if (!rawSlice) return false;
  // Remove JSX comments {/* ... */}
  let s = rawSlice.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
  // Heuristic: any non-whitespace, non-tag content counts.
  // Drop tags: keep their inner text by removing < ... >
  s = s.replace(/<[^>]+>/g, '');
  // {expr} — treat as content if non-empty (could resolve to text at runtime).
  s = s.replace(/\{([\s\S]*?)\}/g, (_full, expr) =>
    expr && expr.trim() ? 'X' : '',
  );
  return /\S/.test(s);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
const SEV = { ERROR: 'ERROR', WARN: 'WARN' };

function auditFile(absPath, source) {
  const findings = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(source)) !== null) {
    const tagStart = m.index;
    const tagName = m[1];
    const attrText = m[2] || '';
    const selfClose = m[3] === '/';
    const openEndIdx = TAG_RE.lastIndex;
    const line = lineOf(source, tagStart);
    const attrs = parseAttrs(attrText);
    const lowerTag = tagName.toLowerCase();
    const role = attrs.role && attrs.role.kind === 'string' ? attrs.role.value : null;

    const has = (k) => Object.prototype.hasOwnProperty.call(attrs, k);
    const strAttr = (k) =>
      has(k) && attrs[k].kind === 'string' ? attrs[k].value : null;

    // 1. <img> must have alt
    if (lowerTag === 'img') {
      if (!has('alt')) {
        findings.push({
          file: absPath,
          line,
          check: 'img-alt',
          severity: SEV.ERROR,
          message: '<img> missing alt attribute',
        });
      }
    }

    // 2. <button> should have child text OR aria-label
    if (lowerTag === 'button') {
      const hasAriaLabel =
        has('aria-label') ||
        has('aria-labelledby') ||
        (has('title') && attrs.title.kind === 'string');
      let hasText = false;
      if (!selfClose) {
        const slice = findChildrenSlice(source, tagName, openEndIdx);
        hasText = hasMeaningfulChildren(slice);
      }
      if (!hasAriaLabel && !hasText) {
        findings.push({
          file: absPath,
          line,
          check: 'button-name',
          severity: SEV.WARN,
          message:
            '<button> has no visible text or aria-label/aria-labelledby',
        });
      }
    }

    // 3. inputs / textarea / select labelling
    if (
      lowerTag === 'input' ||
      lowerTag === 'textarea' ||
      lowerTag === 'select'
    ) {
      // skip hidden / submit / button input types — those don't need labels
      const type = strAttr('type');
      const skipType =
        lowerTag === 'input' &&
        type &&
        ['hidden', 'submit', 'button', 'image', 'reset'].includes(
          type.toLowerCase(),
        );
      if (!skipType) {
        const id = strAttr('id') || (has('id') && attrs.id.kind === 'expr' ? '*expr*' : null);
        const ariaLabel = has('aria-label');
        const ariaLabelledby = has('aria-labelledby');
        const placeholder = strAttr('placeholder');
        const title = has('title');

        // Look up a matching <label htmlFor="id"> anywhere in the source.
        let hasLabelFor = false;
        if (id && id !== '*expr*') {
          const labelRe = new RegExp(
            `<label[^>]*\\bhtmlFor\\s*=\\s*["']${id.replace(
              /[.*+?^${}()|[\]\\]/g,
              '\\$&',
            )}["']`,
          );
          hasLabelFor = labelRe.test(source);
        } else if (id === '*expr*') {
          // can't statically resolve — assume linked if there's any
          // <label htmlFor={...}> in the file.
          hasLabelFor = /<label[^>]*\bhtmlFor\s*=\s*\{/.test(source);
        }

        const labelled =
          hasLabelFor || ariaLabel || ariaLabelledby || title;

        if (!labelled) {
          // Placeholder-only inputs get a WARN (not full ERROR) since
          // they're often intentional in search boxes.
          findings.push({
            file: absPath,
            line,
            check: 'input-label',
            severity: placeholder ? SEV.WARN : SEV.ERROR,
            message: `<${lowerTag}> missing label / aria-label / aria-labelledby`,
          });
        }
      }
    }

    // 4. role="dialog" must have aria-modal AND (aria-label OR aria-labelledby)
    if (role === 'dialog' || role === 'alertdialog') {
      const ariaModal = has('aria-modal');
      const labelled = has('aria-label') || has('aria-labelledby');
      if (!ariaModal) {
        findings.push({
          file: absPath,
          line,
          check: 'dialog-aria-modal',
          severity: SEV.ERROR,
          message: `role="${role}" missing aria-modal`,
        });
      }
      if (!labelled) {
        findings.push({
          file: absPath,
          line,
          check: 'dialog-label',
          severity: SEV.ERROR,
          message: `role="${role}" missing aria-label or aria-labelledby`,
        });
      }
    }

    // 5. role="button" on non-button tag needs tabIndex
    if (role === 'button' && lowerTag !== 'button') {
      const tabIndex = has('tabIndex')
        ? attrs.tabIndex
        : has('tabindex')
        ? attrs.tabindex
        : null;
      let ok = false;
      if (tabIndex) {
        if (tabIndex.kind === 'string' && tabIndex.value === '0') ok = true;
        if (tabIndex.kind === 'expr' && tabIndex.value === '0') ok = true;
      }
      if (!ok) {
        findings.push({
          file: absPath,
          line,
          check: 'role-button-tabindex',
          severity: SEV.WARN,
          message: `role="button" on <${tagName}> should have tabIndex="0" or {0}`,
        });
      }
    }

    // 6. onClick on a <div> without role/button raises a warning
    if (lowerTag === 'div' && has('onClick')) {
      const r = role;
      const isButtonish =
        r === 'button' ||
        r === 'link' ||
        r === 'menuitem' ||
        r === 'tab' ||
        r === 'switch' ||
        r === 'checkbox' ||
        r === 'option';
      if (!isButtonish) {
        findings.push({
          file: absPath,
          line,
          check: 'div-onclick',
          severity: SEV.WARN,
          message:
            '<div onClick> without an interactive role — consider <button> or role="button"',
        });
      }
    }

    // 7. <a> without href
    if (lowerTag === 'a') {
      if (!has('href')) {
        findings.push({
          file: absPath,
          line,
          check: 'anchor-href',
          severity: SEV.WARN,
          message: '<a> without href is not a real link',
        });
      }
    }

    // 8. role="img" must have aria-label
    if (role === 'img') {
      if (!has('aria-label') && !has('aria-labelledby')) {
        findings.push({
          file: absPath,
          line,
          check: 'role-img-label',
          severity: SEV.ERROR,
          message: 'role="img" missing aria-label or aria-labelledby',
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function pad(s, n) {
  s = String(s);
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function renderText(findingsByFile, totals, srcDir) {
  const out = [];
  out.push(`a11y-audit — scanned: ${srcDir}`);
  out.push('');
  if (Object.keys(findingsByFile).length === 0) {
    out.push('No issues found.');
  } else {
    for (const file of Object.keys(findingsByFile).sort()) {
      const rel = relative(process.cwd(), file).split(sep).join('/');
      out.push(`# ${rel}`);
      const rows = findingsByFile[file];
      // Column widths
      const checkW = Math.max(5, ...rows.map((r) => r.check.length));
      const sevW = 5; // ERROR / WARN
      const lineW = Math.max(4, ...rows.map((r) => String(r.line).length));
      for (const r of rows) {
        out.push(
          `  ${pad(r.severity, sevW)}  ${pad('L' + r.line, lineW + 1)}  ${pad(
            r.check,
            checkW,
          )}  ${r.message}`,
        );
      }
      out.push('');
    }
  }
  out.push('---');
  out.push(`Total ERROR: ${totals.error}`);
  out.push(`Total WARN:  ${totals.warn}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const srcDir = resolve(opts.src);
  const files = walkJsx(srcDir);

  const all = [];
  for (const f of files) {
    let source;
    try {
      source = readFileSync(f, 'utf8');
    } catch (e) {
      process.stderr.write(`a11y-audit: cannot read ${f}: ${e.message}\n`);
      continue;
    }
    const findings = auditFile(f, source);
    all.push(...findings);
  }

  const findingsByFile = {};
  let errorCount = 0;
  let warnCount = 0;
  for (const r of all) {
    if (r.severity === SEV.ERROR) errorCount++;
    else warnCount++;
    (findingsByFile[r.file] ||= []).push(r);
  }
  for (const k of Object.keys(findingsByFile)) {
    findingsByFile[k].sort((a, b) => a.line - b.line);
  }

  const totals = { error: errorCount, warn: warnCount };

  if (opts.json) {
    const payload = {
      src: srcDir,
      filesScanned: files.length,
      totals,
      findings: all.map((r) => ({
        file: r.file,
        line: r.line,
        check: r.check,
        severity: r.severity,
        message: r.message,
      })),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(findingsByFile, totals, srcDir) + '\n');
  }

  const failing = opts.strict ? errorCount + warnCount : errorCount;
  process.exit(failing > 0 ? 1 : 0);
}

main();
