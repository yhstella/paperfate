#!/usr/bin/env node
/**
 * db-backup.mjs — Hot online backup of paperfate.db
 *
 * Uses better-sqlite3's db.backup() to produce a consistent copy of the live
 * database without taking a write lock long enough to block writers. The
 * resulting .db file is then optionally gzipped (node:zlib streams, no shell
 * gzip dependency) and old backups beyond a retention limit are pruned.
 *
 * Usage:
 *   DATA_ROOT=./data node scripts/db-backup.mjs [options]
 *
 * Options:
 *   --keep N              Keep the N most recent .db.gz backups (default 7)
 *   --out PATH            Override output path
 *                         (default: E:/paperfate/backups/paperfate-<stamp>.db)
 *   --no-gzip             Skip gzip step; keep raw .db only
 *   --no-keep-original    Delete the uncompressed .db after gzipping
 *   --quiet               Suppress progress logs (still emits final summary)
 *
 * Exit 0 on success. Non-zero on failure (DB missing, copy failed, etc.).
 *
 * NB: do NOT execute against the live ~86 GB DB casually — the backup will
 *     produce a same-size file. Use only when target volume has headroom.
 */
import Database from 'better-sqlite3'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

// ---------------------------------------------------------------------------
// CLI parsing — tiny hand-rolled parser, no external deps.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    keep: 7,
    out: null,
    gzip: true,
    keepOriginal: true,
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--keep': {
        const n = Number(argv[++i])
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
          throw new Error(`--keep expects a non-negative integer, got ${argv[i]}`)
        }
        opts.keep = n
        break
      }
      case '--out':
        opts.out = argv[++i]
        if (!opts.out) throw new Error('--out expects a path')
        break
      case '--no-gzip':
        opts.gzip = false
        break
      case '--no-keep-original':
        opts.keepOriginal = false
        break
      case '--quiet':
        opts.quiet = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${a}`)
    }
  }
  return opts
}

function printHelp() {
  console.log(`Usage: node scripts/db-backup.mjs [options]

Options:
  --keep N              Retention count for .db.gz files (default 7)
  --out PATH            Explicit output path for the .db file
  --no-gzip             Do not gzip the backup
  --no-keep-original    Remove the .db after gzipping
  --quiet               Suppress progress logs
  -h, --help            Show this message`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stamp(d = new Date()) {
  // Local time. YYYY-MM-DD-HHMM.
  const pad = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes())
  )
}

function sizeMB(path) {
  try {
    return statSync(path).size / 1024 / 1024
  } catch {
    return null
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

async function gzipFile(src, dest) {
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dest))
}

// Find all `paperfate-*.db.gz` files in `dir`, sorted oldest -> newest.
function listExistingGzBackups(dir) {
  if (!existsSync(dir)) return []
  const entries = []
  for (const name of readdirSync(dir)) {
    if (!/^paperfate-.+\.db\.gz$/i.test(name)) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isFile()) continue
    entries.push({ path: p, name, mtimeMs: st.mtimeMs })
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return entries
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now()
  const opts = parseArgs(process.argv.slice(2))
  const log = opts.quiet ? () => {} : (...a) => console.log('[db-backup]', ...a)

  const DATA_ROOT = process.env.DATA_ROOT || './data'
  const DB_PATH = resolve(join(DATA_ROOT, 'paperfate.db'))

  if (!existsSync(DB_PATH)) {
    console.error(`[db-backup] DB not found at ${DB_PATH}`)
    process.exit(1)
  }

  const defaultDir = 'E:/paperfate/backups'
  const outPath = opts.out
    ? resolve(opts.out)
    : resolve(join(defaultDir, `paperfate-${stamp()}.db`))
  const outDir = dirname(outPath)
  ensureDir(outDir)

  log(`source: ${DB_PATH} (${(sizeMB(DB_PATH) ?? 0).toFixed(1)} MB)`)
  log(`target: ${outPath}`)

  // --- Step 1: online backup --------------------------------------------------
  // better-sqlite3 db.backup(destination) returns a Promise that resolves with
  // { totalPages, remainingPages }. It performs the SQLite online-backup API
  // under the hood, which yields to writers between page batches.
  const db = new Database(DB_PATH, { readonly: true })
  db.pragma('busy_timeout=60000')
  try {
    const backupT0 = Date.now()
    const result = await db.backup(outPath, {
      // Default progress callback is fine; we just await completion.
    })
    const backupSecs = (Date.now() - backupT0) / 1000
    log(`backup complete in ${backupSecs.toFixed(1)}s (totalPages=${result?.totalPages ?? '?'})`)
  } finally {
    db.close()
  }

  const dbSizeMB = sizeMB(outPath)
  if (dbSizeMB == null) {
    console.error(`[db-backup] backup file missing after copy: ${outPath}`)
    process.exit(1)
  }

  // --- Step 2: optional gzip --------------------------------------------------
  let gzPath = null
  let gzSizeMB = null
  if (opts.gzip) {
    gzPath = outPath + '.gz'
    log(`gzipping -> ${gzPath}`)
    const gzT0 = Date.now()
    try {
      await gzipFile(outPath, gzPath)
    } catch (e) {
      console.error(`[db-backup] gzip failed: ${e.message}`)
      process.exit(1)
    }
    gzSizeMB = sizeMB(gzPath)
    const gzSecs = (Date.now() - gzT0) / 1000
    log(`gzip done in ${gzSecs.toFixed(1)}s (${gzSizeMB?.toFixed(1)} MB)`)

    if (!opts.keepOriginal) {
      try {
        unlinkSync(outPath)
        log(`removed uncompressed copy ${outPath}`)
      } catch (e) {
        console.error(`[db-backup] failed to remove original: ${e.message}`)
        // Non-fatal: backup itself succeeded.
      }
    }
  }

  // --- Step 3: prune ----------------------------------------------------------
  // Only prune .db.gz files (compressed history) — never touches raw .db
  // outputs that the operator may be staging by hand.
  let keptCount = 0
  let deletedCount = 0
  if (opts.gzip) {
    const existing = listExistingGzBackups(outDir)
    // existing already includes the brand-new gz we just wrote (oldest -> newest).
    if (opts.keep === 0) {
      // Special case: keep none. Delete every .db.gz including this one.
      for (const e of existing) {
        try { unlinkSync(e.path); deletedCount++ } catch (err) {
          console.error(`[db-backup] failed to delete ${e.path}: ${err.message}`)
        }
      }
    } else if (existing.length > opts.keep) {
      const toDelete = existing.slice(0, existing.length - opts.keep)
      for (const e of toDelete) {
        try {
          unlinkSync(e.path)
          deletedCount++
          log(`pruned ${e.name}`)
        } catch (err) {
          console.error(`[db-backup] failed to delete ${e.path}: ${err.message}`)
        }
      }
      keptCount = opts.keep
    } else {
      keptCount = existing.length
    }
  }

  // --- Final summary ----------------------------------------------------------
  const totalWall = (Date.now() - t0) / 1000
  const summary = {
    backup_path: gzPath ?? outPath,
    size_mb: Number((dbSizeMB ?? 0).toFixed(2)),
    gzip_size_mb: gzSizeMB == null ? null : Number(gzSizeMB.toFixed(2)),
    kept_count: keptCount,
    deleted_count: deletedCount,
    total_wall_s: Number(totalWall.toFixed(2)),
  }
  // Always print summary JSON (even with --quiet) so the script is scriptable.
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

main().catch((e) => {
  console.error(`[db-backup] fatal: ${e.message}`)
  if (process.env.DEBUG) console.error(e.stack)
  process.exit(1)
})
