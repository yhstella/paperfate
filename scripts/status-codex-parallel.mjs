#!/usr/bin/env node
// Read-only status snapshot for the Codex parallel PaperFate tasks.
//
// Usage:
//   DATA_ROOT=E:/paperfate/data node scripts/status-codex-parallel.mjs
//   DATA_ROOT=E:/paperfate/data node scripts/status-codex-parallel.mjs --deep --json

import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const ARGS = new Set(process.argv.slice(2))
const DEEP = ARGS.has('--deep')
const JSON_OUT = ARGS.has('--json')

function pct(n, d) {
  if (!d) return null
  return +(Number(n || 0) / Number(d) * 100).toFixed(2)
}

function mb(bytes) {
  return +(bytes / 1024 / 1024).toFixed(1)
}

function safe(fn, fallback = null) {
  try { return fn() } catch { return fallback }
}

function scalar(db, sql, params = []) {
  return safe(() => Object.values(db.prepare(sql).get(...params))[0], null)
}

function row(db, sql, params = []) {
  return safe(() => db.prepare(sql).get(...params), {})
}

function all(db, sql, params = []) {
  return safe(() => db.prepare(sql).all(...params), [])
}

function tail(path, n = 20) {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/)
  return lines.slice(-n)
}

function parseProgress(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const head = line.match(/([\d,]+)\/([\d,]+)/)
    if (!head) continue
    const value = (key) => {
      const m = line.match(new RegExp(`${key}=([\\d,]+)`))
      return m ? Number(m[1].replace(/,/g, '')) : 0
    }
    const rate = line.match(/rate=([\d.]+)\/s/) || line.match(/fail=[\d,]+\s+([\d.]+)\/s/)
    return {
      done: Number(head[1].replace(/,/g, '')),
      total: Number(head[2].replace(/,/g, '')),
      ok: value('ok'),
      miss: value('miss'),
      fail: value('fail'),
      rate_per_s: Number(rate?.[1] || 0),
      raw: line,
    }
  }
  return null
}

function newestJsonl(subdir) {
  const dir = join(DATA_ROOT, subdir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl') && !name.startsWith('_'))
    .map(name => {
      const path = join(dir, name)
      const st = statSync(path)
      return { name, path, size_mb: mb(st.size), mtime: st.mtime.toISOString() }
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, 5)
}

function processSnapshot() {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\"",
    "Where-Object { $_.CommandLine -like '*collect-openalex-authors*' -or $_.CommandLine -like '*collect-openalex.mjs*' -or $_.CommandLine -like '*collect-crossref*' -or $_.CommandLine -like '*collect-europepmc-fulltext*' -or $_.CommandLine -like '*collect-pmc-via-epmc*' -or $_.CommandLine -like '*collect-pdf-fulltext*' -or $_.CommandLine -like '*collect-pubmed*' -or $_.CommandLine -like '*collect-pmc-fulltext*' -or $_.CommandLine -like '*score-codex-q500-fulltext*' -or $_.CommandLine -like '*match-biorxiv-to-papers*' -or $_.CommandLine -like '*auto-ingest-watcher*' }",
    "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
  ].join(' | ')
  const out = safe(() => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }), '')
  return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [pid, ...cmd] = line.split('\t')
    return { pid: Number(pid), command: cmd.join('\t') }
  })
}

const status = {
  generated_at: new Date().toISOString(),
  data_root: DATA_ROOT,
  db_path: DB_PATH,
  db_size_mb: existsSync(DB_PATH) ? mb(statSync(DB_PATH).size) : null,
  processes: processSnapshot(),
  collectors: {
    openalex_authors: {
      progress: parseProgress(tail(join(DATA_ROOT, 'openalex-authors', 'collector-stdout.log'))),
      jsonl: newestJsonl('openalex-authors'),
    },
    europepmc_fulltext: {
      progress: parseProgress(tail(join(DATA_ROOT, 'europepmc-fulltext', '_codex-restart.log'))),
      jsonl: newestJsonl('europepmc-fulltext'),
    },
    pmc_via_epmc: {
      progress: parseProgress(tail(join(DATA_ROOT, '_pmc_via_epmc_2026-05-22.log'), 200)),
      jsonl: newestJsonl('europepmc-fulltext'),
    },
    pdf_fulltext: {
      progress: parseProgress(tail(join(DATA_ROOT, '_pdf_fulltext_2026-05-22.log'), 200)),
      jsonl: newestJsonl('pdf-fulltext'),
    },
    pmc_fulltext: {
      progress: parseProgress(tail(join(DATA_ROOT, 'pmc-fulltext', '_codex-restart.log'))),
      jsonl: newestJsonl('pmc-fulltext'),
    },
  },
}

if (existsSync(DB_PATH)) {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')

  status.db = {
    papers: row(db, `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN abstract IS NOT NULL AND length(trim(abstract)) > 0 THEN 1 ELSE 0 END) AS with_abstract,
        SUM(CASE WHEN openalex_id IS NOT NULL THEN 1 ELSE 0 END) AS with_openalex,
        SUM(CASE WHEN s2_id IS NOT NULL THEN 1 ELSE 0 END) AS with_s2,
        SUM(CASE WHEN embedding_dim IS NOT NULL THEN 1 ELSE 0 END) AS with_embedding,
        SUM(CASE WHEN citations_crossref IS NOT NULL THEN 1 ELSE 0 END) AS with_crossref,
        SUM(CASE WHEN icite_rcr IS NOT NULL THEN 1 ELSE 0 END) AS with_icite,
        SUM(CASE WHEN unpaywall_is_oa IS NOT NULL THEN 1 ELSE 0 END) AS with_unpaywall,
        SUM(CASE WHEN preprint_doi IS NOT NULL THEN 1 ELSE 0 END) AS with_preprint,
        SUM(CASE WHEN first_author_h_index IS NOT NULL THEN 1 ELSE 0 END) AS first_author_h,
        SUM(CASE WHEN last_author_h_index IS NOT NULL THEN 1 ELSE 0 END) AS last_author_h,
        SUM(CASE WHEN max_team_h_index IS NOT NULL THEN 1 ELSE 0 END) AS max_team_h,
        SUM(CASE WHEN team_size_with_id IS NOT NULL THEN 1 ELSE 0 END) AS team_size_with_id,
        SUM(CASE WHEN international_collab IS NOT NULL THEN 1 ELSE 0 END) AS international_collab_known,
        SUM(CASE WHEN international_collab = 1 THEN 1 ELSE 0 END) AS international_collab_true,
        SUM(CASE WHEN pmc_body_word_count IS NOT NULL THEN 1 ELSE 0 END) AS with_pmc_fulltext,
        SUM(CASE WHEN epmc_body_word_count IS NOT NULL THEN 1 ELSE 0 END) AS with_epmc_fulltext,
        SUM(CASE WHEN pdf_body_words IS NOT NULL THEN 1 ELSE 0 END) AS with_pdf_text
      FROM papers
    `),
    authors: row(db, `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN h_index IS NOT NULL THEN 1 ELSE 0 END) AS with_h_index,
        ROUND(AVG(h_index), 2) AS avg_h_index,
        MAX(h_index) AS max_h_index
      FROM authors
    `),
    q100_expected: null,
  }

  status.db.coverage = {
    abstract_papers_pct: pct(status.db.papers.with_abstract, status.db.papers.total),
    openalex_pct_all: pct(status.db.papers.with_openalex, status.db.papers.total),
    s2_pct_all: pct(status.db.papers.with_s2, status.db.papers.total),
    embedding_pct_all: pct(status.db.papers.with_embedding, status.db.papers.total),
    crossref_pct_all: pct(status.db.papers.with_crossref, status.db.papers.total),
    icite_pct_all: pct(status.db.papers.with_icite, status.db.papers.total),
    unpaywall_pct_all: pct(status.db.papers.with_unpaywall, status.db.papers.total),
    preprint_pct_all: pct(status.db.papers.with_preprint, status.db.papers.total),
    first_author_h_pct_all: pct(status.db.papers.first_author_h, status.db.papers.total),
    first_author_h_pct_abstracts: pct(status.db.papers.first_author_h, status.db.papers.with_abstract),
    max_team_h_pct_all: pct(status.db.papers.max_team_h, status.db.papers.total),
    team_size_with_id_pct_all: pct(status.db.papers.team_size_with_id, status.db.papers.total),
    epmc_fulltext_pct_all: pct(status.db.papers.with_epmc_fulltext, status.db.papers.total),
    pmc_fulltext_pct_all: pct(status.db.papers.with_pmc_fulltext, status.db.papers.total),
    pdf_fulltext_pct_all: pct(status.db.papers.with_pdf_text, status.db.papers.total),
  }

  if (DEEP) {
    status.db.score_modes = all(db, `
      SELECT mode, COUNT(*) AS rows, COUNT(DISTINCT item_id) AS items
      FROM paper_scores
      GROUP BY mode
      ORDER BY rows DESC
    `)
    const codex = status.db.score_modes.find(m => m.mode === 'codex_deterministic')
    const qItems = codex?.items || 0
    status.db.q100_expected = qItems ? Number(status.db.papers.with_abstract) * Number(qItems) : null
  }

  db.close()
}

if (JSON_OUT) {
  console.log(JSON.stringify(status, null, 2))
} else {
  const p = status.db?.papers || {}
  const a = status.db?.authors || {}
  console.log(`PaperFate Codex status @ ${status.generated_at}`)
  console.log(`DATA_ROOT: ${status.data_root}`)
  console.log(`DB: ${status.db_path} (${status.db_size_mb ?? 'missing'} MB)`)
  console.log('')
  console.log('Processes')
  for (const proc of status.processes) console.log(`  ${proc.pid}  ${proc.command}`)
  if (!status.processes.length) console.log('  none')
  console.log('')
  console.log('DB coverage')
  console.log(`  papers total:             ${p.total ?? 'n/a'}`)
  console.log(`  papers with abstract:     ${p.with_abstract ?? 'n/a'} (${status.db?.coverage?.abstract_papers_pct ?? 'n/a'}%)`)
  console.log(`  OpenAlex:                 ${p.with_openalex ?? 'n/a'} (${status.db?.coverage?.openalex_pct_all ?? 'n/a'}%)`)
  console.log(`  Semantic Scholar:         ${p.with_s2 ?? 'n/a'} (${status.db?.coverage?.s2_pct_all ?? 'n/a'}%)`)
  console.log(`  SPECTER2 embeddings:      ${p.with_embedding ?? 'n/a'} (${status.db?.coverage?.embedding_pct_all ?? 'n/a'}%)`)
  console.log(`  Crossref:                 ${p.with_crossref ?? 'n/a'} (${status.db?.coverage?.crossref_pct_all ?? 'n/a'}%)`)
  console.log(`  iCite RCR:                ${p.with_icite ?? 'n/a'} (${status.db?.coverage?.icite_pct_all ?? 'n/a'}%)`)
  console.log(`  Unpaywall:                ${p.with_unpaywall ?? 'n/a'} (${status.db?.coverage?.unpaywall_pct_all ?? 'n/a'}%)`)
  console.log(`  bioRxiv/medRxiv linked:   ${p.with_preprint ?? 'n/a'} (${status.db?.coverage?.preprint_pct_all ?? 'n/a'}%)`)
  console.log(`  authors table:            ${a.total ?? 'n/a'} rows (${a.with_h_index ?? 'n/a'} with h_index)`)
  console.log(`  first_author_h_index:     ${p.first_author_h ?? 'n/a'} (${status.db?.coverage?.first_author_h_pct_abstracts ?? 'n/a'}% of abstract papers)`)
  console.log(`  max_team_h_index:         ${p.max_team_h ?? 'n/a'} (${status.db?.coverage?.max_team_h_pct_all ?? 'n/a'}% of all papers)`)
  console.log(`  EuropePMC fulltext rows:  ${p.with_epmc_fulltext ?? 'n/a'} (${status.db?.coverage?.epmc_fulltext_pct_all ?? 'n/a'}%)`)
  console.log(`  PMC fulltext rows:        ${p.with_pmc_fulltext ?? 'n/a'} (${status.db?.coverage?.pmc_fulltext_pct_all ?? 'n/a'}%)`)
  console.log(`  PDF fulltext rows:        ${p.with_pdf_text ?? 'n/a'} (${status.db?.coverage?.pdf_fulltext_pct_all ?? 'n/a'}%)`)
  if (DEEP) {
    console.log('')
    console.log('Score modes')
    for (const mode of status.db.score_modes) console.log(`  ${mode.mode}: ${mode.rows} rows, ${mode.items} items`)
  }
  console.log('')
  console.log('Collectors')
  for (const [name, info] of Object.entries(status.collectors)) {
    const prog = info.progress
    console.log(`  ${name}: ${prog ? `${prog.done}/${prog.total} ok=${prog.ok} miss=${prog.miss} fail=${prog.fail} rate=${prog.rate_per_s}/s` : 'no progress log'}`)
    for (const f of info.jsonl.slice(0, 2)) console.log(`    ${f.name} ${f.size_mb} MB mtime=${f.mtime}`)
  }
}
