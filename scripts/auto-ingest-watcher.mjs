#!/usr/bin/env node
// Watch active collector outputs and trigger sequential DB ingest jobs.
//
// The watcher is conservative: by default it defers ingest while the Q500
// fulltext scorer is writing, and it records every decision to a JSONL log.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const STATE_PATH = join(DATA_ROOT, '_auto_ingest_state.json')
const LOG_PATH = join(DATA_ROOT, '_auto_ingest_log.jsonl')
const LOCK_PATH = join(DATA_ROOT, '_auto_ingest_watcher.lock')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const INTERVAL_SEC = Number(arg('interval-sec', '300'))
const MIN_INGEST_MIN = Number(arg('min-ingest-min', '60'))
const ONCE = ARGS.includes('--once')
const DEFER_WHILE_Q500 = !ARGS.includes('--no-defer-q500')
const DRY_RUN = ARGS.includes('--dry-run')

const WATCHERS = [
  {
    name: 'openalex',
    only: 'openalex',
    paths: [join(DATA_ROOT, 'openalex', 'all-2026-05-21.jsonl')],
    logs: [join(DATA_ROOT, 'openalex', '_enrich_resume3.log')],
    processPattern: 'collect-openalex.mjs',
    donePattern: /done|complete|finished/i,
    checkpoint: true,
    deferWhileQ500: true,
  },
  {
    name: 'crossref',
    only: 'crossref',
    paths: [join(DATA_ROOT, 'crossref', 'all-2026-05-21.jsonl')],
    logs: [join(DATA_ROOT, 'crossref', '_enrich_2026-05-21.log')],
    processPattern: 'collect-crossref.mjs',
    donePattern: /done|complete|finished/i,
    checkpoint: true,
    deferWhileQ500: true,
  },
  {
    name: 'pubmed',
    only: 'pubmed',
    paths: [join(DATA_ROOT, 'pubmed')],
    logs: [join(DATA_ROOT, 'pubmed', '_expand_new_seeds.log')],
    processPattern: 'collect-pubmed.mjs',
    donePattern: /done in/i,
    checkpoint: false,
    deferWhileQ500: true,
  },
  {
    name: 'openalex-authors',
    only: 'authors',
    paths: [join(DATA_ROOT, 'openalex-authors', 'all-2026-05-21.jsonl')],
    logs: [join(DATA_ROOT, 'openalex-authors', 'collector-stdout.log')],
    processPattern: 'collect-openalex-authors.mjs',
    donePattern: /done|complete|finished|941,090\/941,090/i,
    checkpoint: true,
    deferWhileQ500: true,
  },
  {
    name: 'europepmc-fulltext',
    only: 'epmc',
    paths: [join(DATA_ROOT, 'europepmc-fulltext')],
    logs: [
      join(DATA_ROOT, 'europepmc-fulltext', '_codex-restart.log'),
      join(DATA_ROOT, '_pmc_via_epmc_*.log'),
    ],
    processPatterns: ['collect-europepmc-fulltext.mjs', 'collect-pmc-via-epmc.mjs'],
    donePattern: /done|complete|finished|254145\/254145/i,
    checkpoint: true,
    deferWhileQ500: true,
  },
  {
    name: 'pdf-fulltext',
    only: 'pdf',
    paths: [join(DATA_ROOT, 'pdf-fulltext')],
    logs: [join(DATA_ROOT, '_pdf_fulltext_*.log')],
    processPatterns: ['collect-pdf-fulltext.mjs'],
    donePattern: /done|complete|finished|nothing to do/i,
    checkpoint: true,
    deferWhileQ500: true,
  },
]

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function saveJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function log(event, extra = {}) {
  const row = { ts: new Date().toISOString(), event, ...extra }
  appendFileSync(LOG_PATH, JSON.stringify(row) + '\n')
  console.log(JSON.stringify(row))
}

function pathMtime(path) {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  // Directory: find newest *.jsonl shard inside (non-recursive).
  let best = 0
  try {
    for (const name of readdirSync(path)) {
      if (!name.endsWith('.jsonl')) continue
      const child = join(path, name)
      try {
        const childSt = statSync(child)
        if (childSt.isFile() && childSt.mtimeMs > best) best = childSt.mtimeMs
      } catch {}
    }
  } catch {}
  // Fall back to directory mtime if no shards exist yet.
  return best || st.mtimeMs
}

function latestMtime(paths) {
  return Math.max(0, ...paths.map(pathMtime))
}

function expandLogPath(path) {
  // Glob expansion: if path contains '*' or '?', resolve against parent
  // directory and return newest matching file. Literal paths pass through.
  if (!path.includes('*') && !path.includes('?')) return path
  const dir = dirname(path)
  const pattern = path.slice(dir.length + 1)
  const regex = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$')
  if (!existsSync(dir)) return path
  let best = null
  let bestMtime = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!regex.test(name)) continue
      const child = join(dir, name)
      try {
        const st = statSync(child)
        if (st.isFile() && st.mtimeMs > bestMtime) {
          best = child
          bestMtime = st.mtimeMs
        }
      } catch {}
    }
  } catch {}
  return best || path
}

function tail(path, bytes = 65536) {
  const resolved = expandLogPath(path)
  if (!existsSync(resolved)) return ''
  const text = readFileSync(resolved, 'utf8')
  return text.slice(Math.max(0, text.length - bytes))
}

function logDone(watcher) {
  return watcher.logs.some(path => watcher.donePattern.test(tail(path)))
}

function powershellLines(script) {
  const res = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return (res.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}

function activeNodeProcesses() {
  const script = [
    'Get-CimInstance Win32_Process -Filter "name = \'node.exe\'"',
    'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
  ].join(' | ')
  const procs = powershellLines(script).map(line => {
    const [pid, ...rest] = line.split('\t')
    return { pid: Number(pid), command: rest.join('\t') }
  })
  // Watcher itself is a node process, so zero results means the snapshot is
  // bogus (powershell glitch, timeout, etc). Signal invalid to caller.
  if (procs.length === 0) return null
  return procs
}

function isActive(processes, pattern) {
  return processes.some(p => p.command.includes(pattern))
}

function watcherActive(processes, watcher) {
  const patterns = watcher.processPatterns || (watcher.processPattern ? [watcher.processPattern] : [])
  return patterns.some(pattern => isActive(processes, pattern))
}

function runIngest(only) {
  const args = ['scripts/build-unified-db.mjs', `--only=${only}`]
  log('ingest_start', { only, command: `node ${args.join(' ')}` })
  if (DRY_RUN) {
    log('ingest_dry_run', { only })
    return { status: 0 }
  }
  const res = spawnSync('node', args, {
    cwd: ROOT,
    env: { ...process.env, DATA_ROOT },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (res.stdout) appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), event: 'ingest_stdout', only, tail: res.stdout.slice(-8000) }) + '\n')
  if (res.stderr) appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), event: 'ingest_stderr', only, tail: res.stderr.slice(-8000) }) + '\n')
  log('ingest_finish', { only, status: res.status, signal: res.signal })
  return res
}

function acquireLock() {
  const current = { pid: process.pid, started_at: new Date().toISOString() }
  if (existsSync(LOCK_PATH)) {
    const old = loadJson(LOCK_PATH, null)
    if (old?.pid) {
      const snapshot = activeNodeProcesses()
      // If snapshot is null (powershell glitch), assume the lock might still
      // be held and refuse to start rather than racing the old process.
      if (snapshot === null) throw new Error(`auto-ingest watcher lock present (pid ${old.pid}); process snapshot unavailable, refusing to start`)
      const active = snapshot.some(p => p.pid === old.pid)
      if (active) throw new Error(`auto-ingest watcher already running with pid ${old.pid}`)
    }
  }
  saveJson(LOCK_PATH, current)
}

async function tick(state) {
  const processes = activeNodeProcesses()
  if (processes === null) {
    // Bogus snapshot — don't update `done` state or trigger ingest this tick.
    log('watch_skip_invalid_snapshot')
    return
  }
  const q500Active = isActive(processes, 'score-codex-q500-fulltext')
  for (const watcher of WATCHERS) {
    const mtime = latestMtime(watcher.paths)
    const prev = state.watchers[watcher.name] || {}
    const active = watcherActive(processes, watcher)
    const done = logDone(watcher) || !active
    const changed = mtime > Number(prev.last_ingested_mtime || 0)
    const elapsedMin = prev.last_ingest_at ? (Date.now() - new Date(prev.last_ingest_at).getTime()) / 60000 : Infinity
    const dueCheckpoint = watcher.checkpoint && changed && elapsedMin >= MIN_INGEST_MIN
    const dueDone = changed && done
    const due = dueCheckpoint || dueDone

    state.watchers[watcher.name] = {
      ...prev,
      last_seen_mtime: mtime,
      active,
      done,
      last_seen_at: new Date().toISOString(),
    }

    if (!due) {
      log('watch_skip_not_due', { name: watcher.name, active, done, changed, elapsed_min: +elapsedMin.toFixed(1) })
      continue
    }
    if (DEFER_WHILE_Q500 && watcher.deferWhileQ500 && q500Active) {
      log('watch_defer_q500_active', { name: watcher.name, active, done, changed })
      continue
    }

    const res = runIngest(watcher.only)
    if (res.status === 0) {
      state.watchers[watcher.name].last_ingested_mtime = mtime
      state.watchers[watcher.name].last_ingest_at = new Date().toISOString()
    }
    saveJson(STATE_PATH, state)
  }
}

async function main() {
  mkdirSync(DATA_ROOT, { recursive: true })
  acquireLock()
  const state = loadJson(STATE_PATH, { started_at: new Date().toISOString(), watchers: {} })
  log('watcher_start', { interval_sec: INTERVAL_SEC, min_ingest_min: MIN_INGEST_MIN, defer_while_q500: DEFER_WHILE_Q500, dry_run: DRY_RUN })
  while (true) {
    await tick(state)
    saveJson(STATE_PATH, state)
    if (ONCE) break
    await sleep(INTERVAL_SEC * 1000)
  }
  log('watcher_stop')
}

main().catch(e => {
  log('watcher_error', { error: String(e.message || e) })
  process.exit(1)
})
