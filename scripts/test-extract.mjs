#!/usr/bin/env node
// PaperFate · A1.4 test harness for Q500 extraction
//
// Two modes:
//   --dry-run      Build prompts for first N items and print them. No API call.
//   (default)      Call Anthropic API; requires ANTHROPIC_API_KEY env var.
//
// Examples:
//   node scripts/test-extract.mjs --dry-run               # show first 3 prompts
//   node scripts/test-extract.mjs --dry-run --n 5         # show first 5 prompts
//   ANTHROPIC_API_KEY=sk-... node scripts/test-extract.mjs --q100        # full Q100 run
//   ANTHROPIC_API_KEY=sk-... node scripts/test-extract.mjs --items 3     # first 3 items only

import { loadQ500, forecastManuscript } from '../src/server/extract.js'
import { PaperFateExtractor } from '../src/server/anthropicClient.js'
import { buildItemPrompt, getSystemPrompt } from '../src/server/extractionPrompt.js'

// Sample manuscript — Empagliflozin CKD trial (matches the simulator's loaded sample).
// Designed to be Cardiology / Nephrology RCT, multicenter, large n.
const SAMPLE = {
  title: 'Empagliflozin and major adverse cardiovascular events in adults with chronic kidney disease',
  abstract: `Background: SGLT2 inhibitors reduce cardiovascular events in patients with type 2 diabetes, but their effect in adults with chronic kidney disease (CKD) without diabetes is uncertain.
Methods: In this international, multicenter, double-blind, placebo-controlled trial, we randomly assigned 6,609 adults with CKD (eGFR 20–45 ml/min/1.73 m^2 or eGFR 45–90 with albuminuria) to empagliflozin 10 mg daily or matching placebo. The primary composite outcome was progression of kidney disease or death from cardiovascular causes. Secondary outcomes included hospitalization for heart failure and all-cause mortality.
Results: Median follow-up was 2.0 years. The primary outcome occurred in 432 of 3,304 participants (13.1%) in the empagliflozin group and in 558 of 3,305 (16.9%) in the placebo group (hazard ratio 0.72, 95% CI 0.64–0.82, P<0.001). Effects were consistent across pre-specified subgroups including patients without diabetes and those with the lowest baseline eGFR.
Conclusions: Empagliflozin reduced the risk of kidney-disease progression or cardiovascular death in adults with CKD, with and without diabetes.`,
}

const ARTICLE_TYPE = 'RCT'

function parseArgs() {
  const a = process.argv.slice(2)
  const has = (f) => a.includes(f)
  const val = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d }
  return {
    dryRun:  has('--dry-run'),
    q100:    has('--q100'),
    n:       Number(val('--n', 3)),
    items:   Number(val('--items', 0)),
    fullSet: has('--full'),
  }
}

async function main() {
  const args = parseArgs()
  const q500 = loadQ500()

  // Filter to Q100 + RCT-applicable + lvl=1
  const applicable = PaperFateExtractor.filterItems(q500.items, {
    lvlMax: 1,
    articleType: ARTICLE_TYPE,
    q100Only: args.q100 || !args.fullSet,
  })

  console.log(`\nPaperFate · test-extract`)
  console.log(`Sample: ${SAMPLE.title.slice(0, 70)}…`)
  console.log(`Article type: ${ARTICLE_TYPE}`)
  console.log(`Q500 items applicable: ${applicable.length} (of ${q500.items.length} total in rubric)`)
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE Anthropic API'}\n`)

  if (args.dryRun) {
    console.log(`--- SYSTEM PROMPT (shared by all items) ---\n`)
    console.log(getSystemPrompt())
    console.log(`\n\n--- USER PROMPTS (first ${args.n} items) ---\n`)
    for (const item of applicable.slice(0, args.n)) {
      console.log(`\n═══════════════════════════════════════════════════════════════`)
      console.log(`${item.id} — ${item.name}`)
      console.log(`Q100: ${item.Q100 ? 'yes' : 'no'} · lvl: ${item.lvl} · mode: ${item.mode}`)
      console.log(`═══════════════════════════════════════════════════════════════`)
      const prompt = buildItemPrompt(item, SAMPLE, ARTICLE_TYPE)
      console.log(prompt)
    }
    console.log(`\n\nDone. ${args.n} prompts printed.`)
    return
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY is not set.')
    console.error('Either set it or run with --dry-run to inspect prompts without calling the API.')
    process.exit(1)
  }

  const limit = args.items > 0 ? args.items : applicable.length
  const subset = applicable.slice(0, limit)
  console.log(`Calling Anthropic on ${subset.length} items …\n`)

  const extractor = new PaperFateExtractor()
  let lastPrintedAt = 0
  const startedAt = Date.now()

  const scored = await extractor.batchScore(subset, SAMPLE, ARTICLE_TYPE, {
    concurrency: 5,
    onItem: (res, idx, total) => {
      const now = Date.now()
      if (now - lastPrintedAt > 1500 || idx === 0 || idx === total - 1) {
        console.log(`  [${idx + 1}/${total}] ${res.id}: score=${res.score} conf=${(res.confidence * 100).toFixed(0)}%`)
        lastPrintedAt = now
      }
    },
  })

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  const applicableScored = scored.filter(s => s.applicability === 'applicable' && typeof s.score === 'number')
  const meanScore = applicableScored.length ? (applicableScored.reduce((a, s) => a + s.score, 0) / applicableScored.length).toFixed(2) : 'n/a'
  const nUNK = scored.filter(s => s.score === 'UNK').length
  const nNA  = scored.filter(s => s.score === 'NA').length
  const nErr = scored.filter(s => s._error || s._parse_error).length

  console.log(`\n────────────────────────────────────────────────`)
  console.log(`Done in ${elapsedSec}s`)
  console.log(`  Items scored:     ${scored.length}`)
  console.log(`  Mean score:       ${meanScore} / 5  (applicable=${applicableScored.length})`)
  console.log(`  UNK:              ${nUNK}`)
  console.log(`  NA:               ${nNA}`)
  console.log(`  Errors:           ${nErr}`)
  console.log(`  Cost:             ${JSON.stringify(extractor.costSummary())}`)

  if (args.fullSet) {
    console.log(`\nRunning full forecastManuscript() to test rollup …`)
    const f = await forecastManuscript(SAMPLE, ARTICLE_TYPE, { extractor })
    console.log(`  Overall score:    ${f.overall_score}/100`)
    console.log(`  Strongest:        ${JSON.stringify(f.strongest_domains)}`)
    console.log(`  Weakest:          ${JSON.stringify(f.weakest_domains)}`)
    console.log(`  Key weaknesses:`)
    for (const w of f.key_weaknesses) console.log(`    - ${w.id} (${w.name}): score ${w.score} — ${w.rationale}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
