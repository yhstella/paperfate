#!/usr/bin/env node
// PaperFate Q500 full-text deterministic scorer (preparation script).
//
// This is intentionally conservative:
// - Default is dry-run: no paper_scores writes.
// - Rows without body_text are skipped, because legacy full-text collectors only
//   stored counts. New collector rows include body_text/methods/results text.
// - Production writes require --write --force.
//
// Usage:
//   DATA_ROOT=E:/paperfate/data node scripts/score-codex-q500-fulltext.mjs --limit 1000
//   DATA_ROOT=E:/paperfate/data node scripts/score-codex-q500-fulltext.mjs --write --force

import Database from 'better-sqlite3'
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applicable, inferArticleType } from './score-codex-batch-direct.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const RUBRIC_PATH = join(ROOT, 'docs', 'rubric', 'Q500.json')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const LIMIT = Number(arg('limit', '0'))
const SOURCE = arg('source', 'both') // both | europepmc | pmc
const MODE = arg('mode', 'codex_deterministic')
const WRITE = ARGS.includes('--write')
const FORCE = ARGS.includes('--force')
const SKIP_SCORED = !ARGS.includes('--no-skip-scored') && (WRITE || ARGS.includes('--skip-scored'))
const MIN_BODY_WORDS = Number(arg('min-body-words', '500'))

function listJsonl(subdir) {
  const dir = join(DATA_ROOT, subdir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))
    .map(f => join(dir, f))
}

async function* readJsonl(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (!line.trim()) continue
    try { yield JSON.parse(line) } catch {}
  }
}

function clip(s, n = 180) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
}

function textOf(row) {
  return [
    row.title,
    row.abstract_full,
    row.body_text,
    row.methods_text,
    row.results_text,
    row.discussion_text,
    Array.isArray(row.figure_captions) ? row.figure_captions.join(' ') : '',
    row.data_availability,
    row.ethics_statement,
    row.conflict_of_interest,
  ].filter(Boolean).join('\n')
}

function findEvidence(text, re, fallback = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ')
  const parts = normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9[(])/)
  const hit = parts.find(s => re.test(s))
  return clip(hit || fallback)
}

function has(text, re) {
  return re.test(String(text || ''))
}

function score(id, value, evidence, confidence = 0.72) {
  return {
    id,
    score: Math.max(0, Math.min(5, Math.round(value))),
    evidence: clip(evidence),
    confidence,
  }
}

function unknown(id, evidence = '') {
  return { id, unknown: true, evidence: clip(evidence), confidence: 0.45 }
}

function signalScore(id, text, signals, absentEvidence = 'no full-text signal found') {
  let hits = 0
  let evidence = ''
  for (const re of signals.strong || []) {
    if (has(text, re)) {
      hits += 2
      evidence ||= findEvidence(text, re)
    }
  }
  for (const re of signals.basic || []) {
    if (has(text, re)) {
      hits += 1
      evidence ||= findEvidence(text, re)
    }
  }
  if (hits >= 4) return score(id, 5, evidence, 0.82)
  if (hits >= 2) return score(id, 4, evidence, 0.78)
  if (hits === 1) return score(id, 3, evidence, 0.68)
  return score(id, signals.absentScore ?? 1, absentEvidence, 0.62)
}

function patternsFor(item) {
  const id = item.id
  const domain = id.split('_')[0]
  const name = String(item.name || '').toLowerCase()

  if (/pre.?spec|protocol|registered|registration/.test(name)) {
    return {
      strong: [/\b(NCT\d+|ISRCTN|UMIN|ChiCTR|pre-registered|preregistered|registered protocol|study protocol)\b/i],
      basic: [/\bprotocol|registration|pre-specified|prespecified\b/i],
    }
  }
  if (/primary|secondary/.test(name)) {
    return {
      strong: [/\bprimary (outcome|endpoint|objective)|secondary (outcome|endpoint|objective)\b/i],
      basic: [/\bendpoint|outcome measure|exploratory outcome\b/i],
    }
  }
  if (/sample size|power/.test(name)) {
    return {
      strong: [/\bsample size calculation|power calculation|statistical power|80% power|90% power\b/i],
      basic: [/\bpower\b|\bsample size\b/i],
    }
  }
  if (/missing/.test(name)) {
    return {
      strong: [/\bmultiple imputation|missing data|complete-case|inverse probability weighting\b/i],
      basic: [/\bimputed|missing\b/i],
    }
  }
  if (/sensitivity/.test(name)) {
    return {
      strong: [/\bsensitivity analys(?:is|es)|robustness check|leave-one-out|E-value\b/i],
      basic: [/\bsensitivity|robustness\b/i],
    }
  }
  if (/confound|adjust|covariate/.test(name)) {
    return {
      strong: [/\badjusted for|multivariable|multivariate|propensity score|inverse probability|covariates?\b/i],
      basic: [/\badjusted|covariate|confound/i],
    }
  }
  if (/blinding|masking/.test(name)) {
    return {
      strong: [/\bdouble-blind|single-blind|masked|blinded assessor|blinding\b/i],
      basic: [/\bblind|masking\b/i],
    }
  }
  if (/random/.test(name)) {
    return {
      strong: [/\brandomization|randomisation|randomized|randomly assigned|allocation concealment\b/i],
      basic: [/\brandom\b/i],
    }
  }
  if (/ethic|consent|irb/.test(name)) {
    return {
      strong: [/\bethics committee|ethical approval|institutional review board|IRB|informed consent\b/i],
      basic: [/\bethic|consent\b/i],
    }
  }
  if (/fund/.test(name)) {
    return {
      strong: [/\bfunding|funded by|supported by|grant\b/i],
      basic: [/\bfund|grant\b/i],
    }
  }
  if (/data availability|data sharing|code|software/.test(name)) {
    return {
      strong: [/\bdata availability|data sharing|available from|code availability|github|software|R version|Python|Stata|SAS|SPSS\b/i],
      basic: [/\bdata|code|software|package\b/i],
    }
  }
  if (/figure|table|caption|forest|kaplan|curve/.test(name)) {
    return {
      strong: [/\bforest plot|kaplan-meier|roc curve|calibration plot|figure \d+|table \d+\b/i],
      basic: [/\bfigure|table|plot|curve|caption\b/i],
    }
  }
  if (/external|validation|transport|generaliz/.test(name)) {
    return {
      strong: [/\bexternal validation|validated in|independent cohort|temporal validation|multicenter|multi-center|transportability|generalizability\b/i],
      basic: [/\bvalidation|external|setting|site|cohort\b/i],
    }
  }
  if (/calibration|discrimination|auroc|auc|decision curve|prediction/.test(name)) {
    return {
      strong: [/\bAUROC|AUC|C-index|calibration|decision curve|net benefit|train.*test|validation set|hyperparameter\b/i],
      basic: [/\bmodel|prediction|discrimination|calibrat/i],
    }
  }

  const byDomain = {
    QUEST: {
      strong: [/\brationale|hypothes(?:is|es)|objective|aim|conceptual framework|primary question\b/i],
      basic: [/\bquestion|assumption|guideline|practice|exploratory\b/i],
    },
    NOVEL: {
      strong: [/\bnovel|first|previous studies|literature gap|to our knowledge|unanswered\b/i],
      basic: [/\bnew|gap|limited|unknown|prior\b/i],
    },
    DESIGN: {
      strong: [/\bprospective|retrospective|cohort|case-control|randomized|multicenter|study design|eligibility criteria\b/i],
      basic: [/\bdesign|eligible|included|excluded|follow-up\b/i],
    },
    POPUL: {
      strong: [/\bage|sex|gender|race|ethnicity|baseline characteristics|inclusion criteria|exclusion criteria\b/i],
      basic: [/\bpopulation|participants|patients|characteristics\b/i],
    },
    EXPOS: {
      strong: [/\bintervention|exposure|dose|duration|comparator|control group|placebo\b/i],
      basic: [/\btreatment|therapy|exposed|comparison\b/i],
    },
    OUTCM: {
      strong: [/\bprimary outcome|secondary outcome|endpoint|adjudicated|follow-up\b/i],
      basic: [/\boutcome|measure|endpoint\b/i],
    },
    STATS: {
      strong: [/\bregression|cox|logistic|mixed-effects|confidence interval|p-value|multiple comparison|bootstrap\b/i],
      basic: [/\bstatistical|analysis|model\b/i],
    },
    BIAS: {
      strong: [/\bbias|confounding|sensitivity analysis|propensity|blinding|attrition|selection bias\b/i],
      basic: [/\badjust|limitation|missing\b/i],
    },
    EXTV: {
      strong: [/\bexternal validation|independent cohort|multicenter|population-based|generalizability\b/i],
      basic: [/\bsetting|site|country|cohort\b/i],
    },
    AIPRED: {
      strong: [/\btraining set|test set|validation set|AUROC|calibration|decision curve|hyperparameter|machine learning\b/i],
      basic: [/\bmodel|algorithm|prediction|validation\b/i],
    },
    REPRT: {
      strong: [/\bCONSORT|STROBE|PRISMA|TRIPOD|ethics|funding|data availability|supplementary\b/i],
      basic: [/\breported|checklist|protocol|software\b/i],
    },
    INTERP: {
      strong: [/\blimitation|clinical implications|future research|generalizability|caution\b/i],
      basic: [/\bconclusion|interpretation|suggests|may\b/i],
    },
    FIGS: {
      strong: [/\bfigure \d+|table \d+|forest plot|kaplan-meier|roc curve|calibration plot\b/i],
      basic: [/\bfigure|table|plot|curve\b/i],
    },
  }
  return byDomain[domain] || { basic: [/\bstudy|analysis|result\b/i] }
}

function scoreItem(item, paper, articleType, fulltext) {
  const id = item.id
  if (!applicable(item.types, articleType)) return { id, na: true }
  const bodyWords = Number(fulltext.body_word_count || 0)
  const text = textOf(fulltext)
  if (!fulltext.body_text || bodyWords < MIN_BODY_WORDS) return unknown(id, 'full text not available')
  return signalScore(id, text, patternsFor(item))
}

function rawFor(out) {
  if (out.na) return { score: null, raw_value: 'na' }
  if (out.unknown) return { score: null, raw_value: 'unknown' }
  return { score: out.score, raw_value: String(out.score) }
}

function updateCounts(counts, out) {
  if (out.na) counts.na++
  else if (out.unknown) counts.unknown++
  else {
    counts.scored++
    counts[`score_${out.score}`] = (counts[`score_${out.score}`] || 0) + 1
  }
}

function filesForSource() {
  const files = []
  if (SOURCE === 'both' || SOURCE === 'europepmc') files.push(...listJsonl('europepmc-fulltext'))
  if (SOURCE === 'both' || SOURCE === 'pmc') files.push(...listJsonl('pmc-fulltext'))
  return files
}

async function main() {
  if (WRITE && !FORCE) {
    throw new Error('Refusing production writes without --force. Use dry-run first, then --write --force deliberately.')
  }
  const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf8'))
  const items = rubric.items.filter(item => !item.Q100)
  const files = filesForSource()
  if (files.length === 0) throw new Error(`No fulltext JSONL files for source=${SOURCE}`)

  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 60000')

  const paperByPmid = db.prepare(`
    SELECT doi, pmid, title, abstract, publication_types_json
    FROM papers
    WHERE pmid = ?
  `)
  const paperByPmcid = db.prepare(`
    SELECT doi, pmid, title, abstract, publication_types_json
    FROM papers
    WHERE pmcid = ?
  `)
  const upsert = db.prepare(`
    INSERT INTO paper_scores (doi, item_id, score, raw_value, mode, confidence, evidence, scored_at)
    VALUES (@doi, @item_id, @score, @raw_value, @mode, @confidence, @evidence, datetime('now'))
    ON CONFLICT(doi, item_id, mode) DO UPDATE SET
      score = excluded.score,
      raw_value = excluded.raw_value,
      confidence = excluded.confidence,
      evidence = excluded.evidence,
      scored_at = excluded.scored_at
  `)
  const writeBatch = db.transaction((rows) => {
    for (const row of rows) upsert.run(row)
  })
  const firstItemId = items[0]?.id || null
  const alreadyScored = firstItemId
    ? db.prepare(`SELECT 1 FROM paper_scores WHERE doi = ? AND item_id = ? AND mode = ? LIMIT 1`)
    : null

  const counts = { papers: 0, skipped_no_text: 0, skipped_no_paper: 0, skipped_scored: 0, scored: 0, na: 0, unknown: 0 }
  console.log(`Q500 fulltext deterministic scorer`)
  console.log(`source=${SOURCE} items=${items.length} mode=${MODE} write=${WRITE && FORCE}`)
  console.log(`skip_scored=${SKIP_SCORED}`)
  console.log(`min_body_words=${MIN_BODY_WORDS} files=${files.length}`)

  for (const file of files) {
    let seen = 0
    for await (const ft of readJsonl(file)) {
      seen++
      if (LIMIT > 0 && counts.papers >= LIMIT) break
      if (!ft.body_text || Number(ft.body_word_count || 0) < MIN_BODY_WORDS) {
        counts.skipped_no_text++
        continue
      }
      const paper = ft.pmid ? paperByPmid.get(String(ft.pmid)) : (ft.pmcid ? paperByPmcid.get(String(ft.pmcid)) : null)
      if (!paper) {
        counts.skipped_no_paper++
        continue
      }
      if (SKIP_SCORED && alreadyScored?.get(paper.doi, firstItemId, MODE)) {
        counts.skipped_scored++
        continue
      }
      let publicationTypes = []
      try { publicationTypes = JSON.parse(paper.publication_types_json || '[]') } catch {}
      const paperForType = {
        title: paper.title,
        abstract: paper.abstract,
        publication_types: publicationTypes,
      }
      const articleType = inferArticleType(paperForType)
      const dbRows = []
      for (const item of items) {
        const out = scoreItem(item, paperForType, articleType, ft)
        updateCounts(counts, out)
        if (WRITE && FORCE) {
          const raw = rawFor(out)
          dbRows.push({
            doi: paper.doi,
            item_id: item.id,
            score: raw.score,
            raw_value: raw.raw_value,
            mode: MODE,
            confidence: out.confidence ?? null,
            evidence: out.evidence || '',
          })
        }
      }
      if (dbRows.length) writeBatch(dbRows)
      counts.papers++
      if (counts.papers % 100 === 0) {
        console.log(`  papers=${counts.papers} scored=${counts.scored} na=${counts.na} unknown=${counts.unknown}`)
      }
    }
    console.log(`  scanned ${file.split(/[\\/]/).pop()} rows=${seen}`)
    if (LIMIT > 0 && counts.papers >= LIMIT) break
  }

  console.log(JSON.stringify({
    papers_scored: counts.papers,
    skipped_no_text: counts.skipped_no_text,
    skipped_no_paper: counts.skipped_no_paper,
    skipped_scored: counts.skipped_scored,
    scored: counts.scored,
    na: counts.na,
    unknown: counts.unknown,
    dist: {
      0: counts.score_0 || 0,
      1: counts.score_1 || 0,
      2: counts.score_2 || 0,
      3: counts.score_3 || 0,
      4: counts.score_4 || 0,
      5: counts.score_5 || 0,
    },
    wrote: WRITE && FORCE,
  }, null, 2))
  db.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
