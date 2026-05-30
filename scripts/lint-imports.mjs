#!/usr/bin/env node
// lint-imports.mjs
// Worker VI — Import lint: circular dependency + unused export + unresolved import detection.
// Zero deps. Pure fs + regex.
//
// Usage:
//   node scripts/lint-imports.mjs                  # scan src/**/*.{js,jsx}
//   node scripts/lint-imports.mjs --include-api    # also scan api/*.js
//   node scripts/lint-imports.mjs --include-scripts# also scan scripts/*.mjs
//   node scripts/lint-imports.mjs --root PATH      # custom root (default C:/Users/R/paperfate/src)
//   node scripts/lint-imports.mjs --json           # machine-readable JSON output
//
// Exit code: 0 if no cycles, 1 if cycles found. Unused exports = warning only.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const opts = {
    root: join(REPO_ROOT, 'src'),
    includeApi: false,
    includeScripts: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) {
      opts.root = resolve(argv[++i]);
    } else if (a === '--include-api') {
      opts.includeApi = true;
    } else if (a === '--include-scripts') {
      opts.includeScripts = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--help' || a === '-h') {
      // Print help via stdout and exit 0.
      process.stdout.write(
        'Usage: node scripts/lint-imports.mjs [--root PATH] [--include-api] [--include-scripts] [--json]\n',
      );
      process.exit(0);
    }
  }
  return opts;
}

// ---------- File collection ----------
const TEST_PATTERN = /(^|[\\/])(test-[^\\/]*|run-tests)\.(mjs|js|jsx)$/i;

function isTestFile(p) {
  return TEST_PATTERN.test(p);
}

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, exts, out);
    } else if (st.isFile()) {
      const e = extname(name).toLowerCase();
      if (exts.includes(e) && !isTestFile(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

function collectFiles(opts) {
  const files = new Set();
  for (const f of walk(opts.root, ['.js', '.jsx', '.mjs'])) files.add(f);
  if (opts.includeApi) {
    const apiDir = join(REPO_ROOT, 'api');
    for (const f of walk(apiDir, ['.js', '.mjs'])) files.add(f);
  }
  if (opts.includeScripts) {
    const scriptsDir = join(REPO_ROOT, 'scripts');
    // Only top-level files (no recursion below scripts/, to match "scripts/*.mjs").
    if (existsSync(scriptsDir)) {
      for (const name of readdirSync(scriptsDir)) {
        const full = join(scriptsDir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const e = extname(name).toLowerCase();
        if ((e === '.mjs' || e === '.js') && !isTestFile(full)) {
          files.add(full);
        }
      }
    }
  }
  return [...files];
}

// ---------- Parsing helpers ----------
// Strip block & line comments so regex doesn't match inside them.
// String contents are preserved — we need them to read import/export specifiers.
// We do skip over strings character-by-character so comment-like sequences inside
// strings (e.g. "//" in a URL) don't trip up the line-comment scanner.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // Line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // Strings — preserve literally, but consume as a unit so embedded `//` or
    // `/*` doesn't fool the comment scanner. Template-literal ${...} expressions
    // are not recursively scanned — a rare false-negative is acceptable since
    // imports/exports are never written inside backtick expressions.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < n) {
          out += ch;
          out += src[i + 1];
          i += 2;
          continue;
        }
        out += ch;
        i++;
        if (ch === quote) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const RE_IMPORT_FROM = /(?:^|\n|;)\s*import\s+(?:[\s\S]*?)\s+from\s+(['"])([^'"]+)\1/g;
const RE_IMPORT_BARE = /(?:^|\n|;)\s*import\s+(['"])([^'"]+)\1/g;
const RE_EXPORT_FROM = /(?:^|\n|;)\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+(['"])([^'"]+)\1/g;
const RE_DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

// Named imports specifiers: capture inside { ... } from RE_IMPORT_FROM matches.
// We re-scan import statements separately for names.
const RE_IMPORT_STMT =
  /(?:^|\n|;)\s*import\s+([^'";]+?)\s+from\s+(['"])([^'"]+)\2/g;

function parseImportClause(clause) {
  // clause examples:
  //   Default
  //   Default, { a, b as c }
  //   { a, b as c }
  //   * as ns
  //   Default, * as ns
  const result = { default: null, named: [], namespace: null };
  const parts = clause.trim();
  // Split into segments by top-level comma (no nested objects to worry about beyond {}).
  const segments = [];
  let depth = 0;
  let buf = '';
  for (const ch of parts) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      segments.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) segments.push(buf);
  for (const segRaw of segments) {
    const seg = segRaw.trim();
    if (!seg) continue;
    if (seg.startsWith('{')) {
      const inner = seg.replace(/^\{|\}$/g, '');
      for (const nameRaw of inner.split(',')) {
        const name = nameRaw.trim();
        if (!name) continue;
        // "a as b" -> we want imported name "a"
        const m = name.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (m) result.named.push(m[1]);
      }
    } else if (seg.startsWith('*')) {
      const m = seg.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (m) result.namespace = m[1];
    } else {
      const m = seg.match(/^([A-Za-z_$][\w$]*)$/);
      if (m) result.default = m[1];
    }
  }
  return result;
}

// Export parsing.
const RE_EXPORT_DEFAULT = /(?:^|\n|;)\s*export\s+default\b/g;
const RE_EXPORT_NAMED_DECL =
  /(?:^|\n|;)\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
const RE_EXPORT_NAMED_LIST = /(?:^|\n|;)\s*export\s*\{([^}]+)\}/g;
const RE_EXPORT_STAR_FROM = /(?:^|\n|;)\s*export\s*\*\s*from\s+(['"])([^'"]+)\1/g;

function parseExports(src) {
  const exports = new Set();
  let hasDefault = false;
  let reexportAll = []; // list of source specifiers for export * from

  if (RE_EXPORT_DEFAULT.test(src)) hasDefault = true;
  RE_EXPORT_DEFAULT.lastIndex = 0;

  let m;
  while ((m = RE_EXPORT_NAMED_DECL.exec(src))) {
    exports.add(m[1]);
  }
  while ((m = RE_EXPORT_NAMED_LIST.exec(src))) {
    const inner = m[1];
    for (const part of inner.split(',')) {
      const name = part.trim();
      if (!name) continue;
      // "x as y" -> exported name is y
      const mm = name.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (mm) exports.add(mm[2] || mm[1]);
    }
  }
  while ((m = RE_EXPORT_STAR_FROM.exec(src))) {
    reexportAll.push(m[2]);
  }
  return { named: [...exports], hasDefault, reexportAll };
}

function parseImports(src) {
  const imports = []; // { spec, default, namespace, named[] }
  let m;
  while ((m = RE_IMPORT_STMT.exec(src))) {
    const clause = m[1];
    const spec = m[3];
    const parsed = parseImportClause(clause);
    imports.push({ spec, ...parsed, kind: 'static' });
  }
  // Bare imports: import 'foo'
  while ((m = RE_IMPORT_BARE.exec(src))) {
    imports.push({ spec: m[2], default: null, namespace: null, named: [], kind: 'bare' });
  }
  // export { x } from './y' — counts as an import edge.
  while ((m = RE_EXPORT_FROM.exec(src))) {
    imports.push({ spec: m[2], default: null, namespace: null, named: [], kind: 'reexport' });
  }
  // Dynamic imports: edges only, no name usage tracking.
  while ((m = RE_DYNAMIC_IMPORT.exec(src))) {
    imports.push({ spec: m[2], default: null, namespace: null, named: [], kind: 'dynamic' });
  }
  return imports;
}

// ---------- Specifier resolution ----------
const RESOLVE_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];

function isRelativeOrAbs(spec) {
  return spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);
}

function tryResolve(baseFile, spec) {
  if (!isRelativeOrAbs(spec)) return null; // package import — not in our graph
  const baseDir = dirname(baseFile);
  const target = resolve(baseDir, spec);
  // 1. Exact file
  if (existsSync(target) && statSync(target).isFile()) return target;
  // 2. With extension
  for (const ext of RESOLVE_EXTS) {
    const cand = target + ext;
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  // 3. Directory index
  if (existsSync(target) && statSync(target).isDirectory()) {
    for (const ext of RESOLVE_EXTS) {
      const cand = join(target, 'index' + ext);
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
  }
  return null;
}

// ---------- Cycle detection (iterative Tarjan-ish via DFS) ----------
function findCycles(graph) {
  // graph: Map<node, Set<node>>
  const cycles = [];
  const indexMap = new Map();
  const lowlinkMap = new Map();
  const onStack = new Set();
  const stack = [];
  let index = 0;

  function strongconnect(v) {
    // Iterative Tarjan to avoid stack overflow on deep graphs.
    const work = [{ node: v, iter: null }];
    while (work.length) {
      const frame = work[work.length - 1];
      const node = frame.node;
      if (frame.iter === null) {
        indexMap.set(node, index);
        lowlinkMap.set(node, index);
        index++;
        stack.push(node);
        onStack.add(node);
        frame.iter = (graph.get(node) || new Set()).values();
      }
      const next = frame.iter.next();
      if (next.done) {
        if (lowlinkMap.get(node) === indexMap.get(node)) {
          const scc = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            scc.push(w);
          } while (w !== node);
          if (scc.length > 1) {
            cycles.push(scc);
          } else if (scc.length === 1) {
            // Self-loop?
            const only = scc[0];
            if ((graph.get(only) || new Set()).has(only)) cycles.push(scc);
          }
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].node;
          lowlinkMap.set(parent, Math.min(lowlinkMap.get(parent), lowlinkMap.get(node)));
        }
        continue;
      }
      const w = next.value;
      if (!indexMap.has(w)) {
        work.push({ node: w, iter: null });
      } else if (onStack.has(w)) {
        lowlinkMap.set(node, Math.min(lowlinkMap.get(node), indexMap.get(w)));
      }
    }
  }

  for (const v of graph.keys()) {
    if (!indexMap.has(v)) strongconnect(v);
  }
  return cycles;
}

// ---------- Main ----------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = collectFiles(opts);
  const fileSet = new Set(files);

  // Parse every file.
  const parsed = new Map(); // file -> { imports, exports }
  for (const f of files) {
    let raw;
    try {
      raw = readFileSync(f, 'utf8');
    } catch (e) {
      continue;
    }
    const clean = stripComments(raw);
    const imports = parseImports(clean);
    const exports = parseExports(clean);
    parsed.set(f, { imports, exports });
  }

  // Build graph + collect unresolved.
  const graph = new Map();
  const unresolved = []; // { file, spec }
  for (const [file, { imports }] of parsed) {
    const edges = new Set();
    for (const imp of imports) {
      if (!isRelativeOrAbs(imp.spec)) continue; // external pkg
      const resolved = tryResolve(file, imp.spec);
      if (!resolved) {
        unresolved.push({ file, spec: imp.spec, kind: imp.kind });
        continue;
      }
      edges.add(resolved);
    }
    graph.set(file, edges);
  }
  // Ensure every node is in graph (even leaves).
  for (const f of files) if (!graph.has(f)) graph.set(f, new Set());

  // Cycle detection.
  const cycles = findCycles(graph);

  // Unused export detection.
  // Build a usage map: for every (resolvedFile, importedName) record usage.
  const used = new Map(); // file -> Set<name> (named imports) plus markers 'default' and '*'
  function mark(file, name) {
    if (!used.has(file)) used.set(file, new Set());
    used.get(file).add(name);
  }
  for (const [file, { imports }] of parsed) {
    for (const imp of imports) {
      if (!isRelativeOrAbs(imp.spec)) continue;
      const resolved = tryResolve(file, imp.spec);
      if (!resolved) continue;
      if (imp.default) mark(resolved, '__default__');
      if (imp.namespace) mark(resolved, '__namespace__');
      for (const n of imp.named) mark(resolved, n);
      if (imp.kind === 'bare') mark(resolved, '__bare__');
      if (imp.kind === 'reexport' || imp.kind === 'dynamic') {
        // Treat re-exports and dynamic imports as full-namespace usage.
        mark(resolved, '__namespace__');
      }
    }
  }
  // Propagate `export * from './x'` usage: if file A re-exports * from B and A's
  // named exports are consumed, we can't tell which came from B. Conservatively,
  // if A is imported at all, treat B's named exports as used.
  for (const [file, { exports }] of parsed) {
    if (!exports.reexportAll.length) continue;
    const fileUsed = used.get(file);
    if (!fileUsed || fileUsed.size === 0) continue;
    for (const spec of exports.reexportAll) {
      const target = tryResolve(file, spec);
      if (!target) continue;
      mark(target, '__namespace__');
    }
  }

  const unusedExports = []; // { file, name }
  // Entry files are roots — App.jsx, main.jsx, api/*.js, scripts/*.mjs etc.
  // We don't flag default exports of entry-like files.
  function isEntryFile(f) {
    const rel = relative(REPO_ROOT, f).split(sep).join('/');
    if (rel.endsWith('/main.jsx') || rel.endsWith('/App.jsx')) return true;
    if (rel.startsWith('api/')) return true;
    if (rel.startsWith('scripts/')) return true;
    if (rel === 'main.jsx' || rel === 'App.jsx') return true;
    return false;
  }

  for (const [file, { exports }] of parsed) {
    if (isEntryFile(file)) continue;
    const usage = used.get(file) || new Set();
    if (usage.has('__namespace__') || usage.has('__bare__')) continue;
    for (const name of exports.named) {
      if (!usage.has(name)) unusedExports.push({ file, name });
    }
    if (exports.hasDefault && !usage.has('__default__')) {
      unusedExports.push({ file, name: 'default' });
    }
  }

  // ---------- Output ----------
  const rel = (f) => relative(REPO_ROOT, f).split(sep).join('/');
  const report = {
    scanned: files.length,
    roots: {
      src: opts.root,
      includeApi: opts.includeApi,
      includeScripts: opts.includeScripts,
    },
    cycles: cycles.map((scc) => scc.map(rel).sort()),
    unresolved: unresolved.map((u) => ({ file: rel(u.file), spec: u.spec, kind: u.kind })),
    unusedExports: unusedExports.map((u) => ({ file: rel(u.file), name: u.name })),
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const lines = [];
    lines.push(`lint-imports: scanned ${report.scanned} files`);
    lines.push(`  root: ${report.roots.src}`);
    lines.push(`  include-api: ${report.roots.includeApi}  include-scripts: ${report.roots.includeScripts}`);
    lines.push('');
    if (report.cycles.length === 0) {
      lines.push('[OK] no circular imports');
    } else {
      lines.push(`[FAIL] ${report.cycles.length} circular import group(s):`);
      for (const scc of report.cycles) {
        lines.push('  - cycle:');
        for (const f of scc) lines.push(`      ${f}`);
      }
    }
    lines.push('');
    if (report.unresolved.length === 0) {
      lines.push('[OK] all relative imports resolve');
    } else {
      lines.push(`[FAIL] ${report.unresolved.length} unresolved import(s):`);
      for (const u of report.unresolved) {
        lines.push(`  - ${u.file}  ->  ${u.spec}  [${u.kind}]`);
      }
    }
    lines.push('');
    if (report.unusedExports.length === 0) {
      lines.push('[OK] no unused exports');
    } else {
      lines.push(`[WARN] ${report.unusedExports.length} unused export(s):`);
      for (const u of report.unusedExports) {
        lines.push(`  - ${u.file}  ::  ${u.name}`);
      }
    }
    process.stdout.write(lines.join('\n') + '\n');
  }

  // Exit code: cycles or unresolved imports = failure. Unused exports = warning only.
  const hardFail = report.cycles.length > 0 || report.unresolved.length > 0;
  process.exit(hardFail ? 1 : 0);
}

main();
