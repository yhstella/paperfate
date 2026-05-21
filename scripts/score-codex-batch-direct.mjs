#!/usr/bin/env node
// PaperFate Codex-direct scoring pass.
//
// This is intentionally local and deterministic: no external LLM/API calls.
// It converts scripts/export-papers-for-llm-scoring.mjs output into the same
// ingest-compatible JSON shape expected by ingest-llm-scores.mjs.
//
// Usage:
//   node scripts/score-codex-batch-direct.mjs --in codex-batch.json --out codex-response.json

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

function clip(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function sentences(paper) {
  const text = `${paper.title || ''}. ${paper.abstract || ''}`
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9[(])/)
    .map(s => s.trim())
    .filter(Boolean)
}

function findSentence(paper, re, fallback = '') {
  const hit = sentences(paper).find(s => re.test(s))
  return clip(hit || fallback)
}

function textOf(paper) {
  return `${paper.title || ''} ${paper.abstract || ''}`.toLowerCase()
}

function has(paper, re) {
  return re.test(textOf(paper))
}

function extractN(paper) {
  const text = `${paper.title || ''} ${paper.abstract || ''}`
  const values = []
  for (const m of text.matchAll(/\b(?:N\s*=\s*|n\s*=\s*|included|enrolled|recruited|selected|from|among|of)\s*(\d{2,7})\b/gi)) {
    values.push(Number(m[1]))
  }
  for (const m of text.matchAll(/\b(\d{2,7})\s+(?:patients?|participants?|infants?|children|women|men|subjects?|samples?|studies|cases|controls)\b/gi)) {
    values.push(Number(m[1]))
  }
  return values.length ? Math.max(...values.filter(Number.isFinite)) : null
}

function sampleScore(n) {
  if (!n) return 1
  if (n < 30) return 1
  if (n < 100) return 2
  if (n < 500) return 3
  if (n < 2000) return 4
  return 5
}

function inferArticleType(paper) {
  const types = paper.publication_types || []
  const text = textOf(paper)

  if (types.some(t => /Randomized Controlled Trial/i.test(t))) return 'RCT'
  if (types.some(t => /Meta-?Analysis/i.test(t)) || /\bmeta-analysis\b/.test(text)) return 'meta_analysis'
  if (types.some(t => /Systematic Review/i.test(t)) || /\bsystematic review\b/.test(text)) return 'systematic_review'
  if (types.some(t => /^Review$/i.test(t)) || /\bthis review\b|\breview addresses\b|\bnarrative review\b/.test(text)) return 'review'
  if (/deep learning|neural network|convolutional|artificial intelligence|machine learning/.test(text) && /imag|radiolog|ct\b|mri|x-ray|ultrasound/.test(text)) return 'ai_imaging'
  if (/(prediction|risk) (model|score)|\bauroc\b|\bc-index\b|calibration/.test(text)) return 'prediction_model'
  if (/diagnostic accuracy|sensitivity.*specificity|specificity.*sensitivity/.test(text)) return 'diagnostic_accuracy'
  if (/\bcase report\b|\bcase presentation\b|initial clinical presentation/.test(text)) return 'case_report'
  if (/in vitro|murine|mouse|mice|rat\b|rats\b|cell lines?|apoptotic|western blot|substrates?/.test(text)) return 'basic_translational'
  if (/case.?control/.test(text)) return 'case_control'
  if (
    /cohort|follow.?up|prospective|retrospective|observational|comparative study|multicenter study|cross-sectional|population-based|prevalence|epidemiology|\bpatients?\b|\bparticipants?\b|\bchildren\b|\bwomen\b|\bmen\b|\bhospital\b|emergency department|costs? of illness/.test(text) ||
    types.some(t => /Comparative Study|Multicenter Study|Observational Study/i.test(t))
  ) return 'clinical_cohort'
  if (/simulation|mathematical model|computational model/.test(text)) return 'modeling_simulation'
  return 'other'
}

function applicable(types, articleType) {
  if (types === '*' || types == null) return true
  const arr = Array.isArray(types) ? types : String(types).split(/[,\s]+/).filter(Boolean)
  return arr.includes(articleType)
}

function scored(id, score, evidence, confidence = 0.75) {
  return {
    id,
    score: Math.max(0, Math.min(5, Math.round(score))),
    evidence: clip(evidence),
    confidence,
  }
}

function unknown(id) {
  return { id, unknown: true }
}

function absent(id, what, score = 1, confidence = 0.7) {
  return scored(id, score, `no ${what} mentioned`, confidence)
}

function objectiveEvidence(paper) {
  return findSentence(
    paper,
    /\b(aim|aimed|objective|purpose|to assess|to evaluate|to determine|to investigate|to compare|to estimate|to explore|to examine|we evaluated|we investigated)\b/i,
    sentences(paper)[0] || '',
  )
}

function conclusionEvidence(paper) {
  return findSentence(
    paper,
    /\b(conclusion|conclude|suggest|indicate|show|demonstrate|found|appears?|remains essential)\b/i,
    sentences(paper).at(-1) || '',
  )
}

function scoreItem(item, paper, articleType) {
  const id = item.id
  if (!applicable(item.types, articleType)) return { id, na: true }

  const n = extractN(paper)
  const text = textOf(paper)
  const objective = objectiveEvidence(paper)
  const result = findSentence(paper, /\b(result|showed|found|associated|estimated|increased|decreased|reduced|higher|lower|significant|95%\s*ci|p\s*[<=>])/i, conclusionEvidence(paper))
  const hasObjective = /\b(aim|aimed|objective|purpose|to assess|to evaluate|to determine|to investigate|to compare|to estimate|to explore|to examine|we evaluated|we investigated)\b/i.test(objective)
  const hasCI = /95%\s*ci|confidence interval|\bci[,:\s]/i.test(`${paper.abstract || ''}`)
  const hasExactP = /\bp\s*[=]\s*(?:0?\.\d+|\.\d+)|\bp\s*[<>]\s*(?:0?\.\d+|\.\d+)/i.test(`${paper.abstract || ''}`)
  const hasAnyP = /\bp\s*[<=>]/i.test(`${paper.abstract || ''}`)
  const hasEffect = /\b(hr|or|rr|odds ratio|risk ratio|hazard ratio|mean difference|effectiveness|reduced|increased|associated|higher|lower|%|fold)\b/i.test(`${paper.abstract || ''}`)
  const hasComparator = /\b(vs\.?|versus|compared with|compared to|control|placebo|comparator|case-control|cases|controls|between .* groups)\b/i.test(`${paper.abstract || ''}`)
  const hasDesign = /\b(randomized|double-blind|case-control|cohort|cross-sectional|prospective|retrospective|multicenter|population-based|systematic review|meta-analysis|clinical trial|observational|test-negative)\b/i.test(`${paper.abstract || ''} ${paper.title || ''}`)
  const hasClinical = /\b(patient|patients|infant|infants|children|women|men|disease|cancer|treatment|therapy|clinical|hospital|emergency|mortality|symptom)\b/i.test(`${paper.abstract || ''} ${paper.title || ''}`)

  switch (id) {
    case 'QUEST_001':
      return scored(id, hasObjective ? 4 : 2, objective, hasObjective ? 0.9 : 0.65)
    case 'QUEST_002':
      return has(paper, /\b(no recent studies|unknown|unclear|limited|controversial|not well|gap|however|few studies|lack)\b/i)
        ? scored(id, 3, findSentence(paper, /\b(no recent studies|unknown|unclear|limited|controversial|few studies|lack|however)\b/i), 0.75)
        : absent(id, 'explicit literature gap', 1, 0.7)
    case 'QUEST_003':
      return scored(id, hasObjective && (n || hasEffect || hasComparator) ? 4 : 2, objective, 0.75)
    case 'QUEST_005':
      return scored(id, n && hasComparator && /outcome|status|mortality|effectiveness|risk|association|prevalence|score|level/i.test(text) ? 4 : n ? 3 : 2, objective, 0.75)
    case 'QUEST_006':
      return has(paper, /\b(pre-registered|preregistered|registration|registered|protocol|NCT\d+|ISRCTN|UMIN|ChiCTR)\b/i)
        ? scored(id, 4, findSentence(paper, /\b(pre-registered|preregistered|registration|registered|protocol|NCT\d+|ISRCTN|UMIN|ChiCTR)\b/i), 0.85)
        : absent(id, 'pre-specification', 1, 0.75)
    case 'QUEST_007':
      return has(paper, /\b(novel|first|no recent studies|unknown|unclear|limited|new)\b/i)
        ? scored(id, 3, findSentence(paper, /\b(novel|first|no recent studies|unknown|unclear|limited|new)\b/i), 0.7)
        : scored(id, 2, objective, 0.6)
    case 'QUEST_010':
      return scored(id, hasClinical ? 3 : 1, findSentence(paper, /\b(burden|disease|patients?|clinical|mortality|morbidity|symptom|treatment|therapy)\b/i, objective), 0.7)
    case 'QUEST_013':
      return scored(id, hasObjective && (hasDesign || n) ? 4 : hasObjective ? 3 : 2, objective, 0.8)

    case 'NOVEL_001':
      return has(paper, /\b(novel|first|new|no recent studies|unknown|unclear|limited)\b/i)
        ? scored(id, 3, findSentence(paper, /\b(novel|first|new|no recent studies|unknown|unclear|limited)\b/i), 0.7)
        : absent(id, 'explicit novelty claim', 1, 0.7)
    case 'NOVEL_002':
      return has(paper, /\b(no recent studies|unknown|unclear|limited|controversial|few studies|lack)\b/i)
        ? scored(id, 3, findSentence(paper, /\b(no recent studies|unknown|unclear|limited|controversial|few studies|lack)\b/i), 0.7)
        : absent(id, 'gap substantiating novelty', 1, 0.7)
    case 'NOVEL_009':
      return scored(id, hasObjective ? 4 : 2, objective, hasObjective ? 0.85 : 0.6)
    case 'NOVEL_010':
      return /\bfirst\b/i.test(text)
        ? scored(id, has(paper, /\b(first|novel|unknown|no recent studies)\b/i) ? 3 : 2, findSentence(paper, /\bfirst\b/i), 0.65)
        : scored(id, 5, 'no unverifiable first-to claim in abstract', 0.8)
    case 'NOVEL_018':
      return scored(id, hasEffect && /\b(clinical|mortality|symptom|treatment|therapy|effectiveness|risk|visits?)\b/i.test(text) ? 3 : 1, result, 0.65)
    case 'NOVEL_019':
      return scored(id, hasEffect ? (hasCI || /%/.test(result) ? 3 : 2) : 1, hasEffect ? result : 'no quantified effect size', 0.7)

    case 'RELEV_001':
      return has(paper, /\b(prevalence|incidence|mortality|burden|common|epidemic|million|%|rate)\b/i)
        ? scored(id, /%|\bmillion\b|\brate\b/i.test(result + text) ? 3 : 2, findSentence(paper, /\b(prevalence|incidence|mortality|burden|common|epidemic|million|%|rate)\b/i), 0.7)
        : absent(id, 'disease burden quantification', 1, 0.7)
    case 'RELEV_002':
      return scored(id, hasClinical ? 4 : 2, findSentence(paper, /\b(mortality|morbidity|symptom|visits?|diagnosis|outcome|risk|quality|cost)\b/i, objective), 0.75)
    case 'RELEV_005':
      return scored(id, /\b(management|treatment|therapy|clinical consequences|practice|screening|monitoring|prevention)\b/i.test(text) ? 3 : 1, conclusionEvidence(paper), 0.65)
    case 'RELEV_006':
      return scored(id, hasEffect ? (hasCI ? 4 : 3) : 1, hasEffect ? result : 'no effect size reported', 0.7)
    case 'RELEV_007':
      return has(paper, /\bNNT|NNH|number needed/i) ? scored(id, 5, findSentence(paper, /\bNNT|NNH|number needed/i), 0.95) : absent(id, 'NNT or NNH', 0, 0.85)
    case 'RELEV_028':
      return scored(id, /\b\d+(\.\d+)?%|\b\d+\s+of\s+\d+|\bmean\b|\bmedian\b|95%\s*ci/i.test(`${paper.abstract || ''}`) ? 4 : 1, result, 0.75)

    case 'DESIGN_001':
      return scored(id, hasDesign ? 5 : /\bstudy\b/i.test(text) ? 3 : 1, findSentence(paper, /\b(randomized|double-blind|case-control|cohort|cross-sectional|prospective|retrospective|multicenter|population-based|systematic review|meta-analysis|clinical trial|observational|test-negative|study)\b/i, objective), 0.85)
    case 'DESIGN_003':
      return has(paper, /\b(pre-registered|preregistered|registered|registration|protocol|NCT\d+|ISRCTN|UMIN|ChiCTR)\b/i)
        ? scored(id, 5, findSentence(paper, /\b(pre-registered|preregistered|registered|registration|protocol|NCT\d+|ISRCTN|UMIN|ChiCTR)\b/i), 0.9)
        : absent(id, 'pre-registration', 1, 0.8)
    case 'DESIGN_005':
      return n ? scored(id, sampleScore(n), findSentence(paper, /\b(N\s*=|n\s*=|included|enrolled|participants?|patients?|infants?|children|women|men)\b/i), 0.8) : absent(id, 'sample size', 1, 0.8)
    case 'DESIGN_011':
      return has(paper, /\bmulticenter|multi-center|multiple centers|nationwide|national|countries|sites\b/i)
        ? scored(id, 5, findSentence(paper, /\bmulticenter|multi-center|multiple centers|nationwide|national|countries|sites\b/i), 0.9)
        : absent(id, 'multicenter or geographic spread', 1, 0.75)
    case 'DESIGN_013':
      return has(paper, /\bprospective|retrospective|follow-up|longitudinal\b/i)
        ? scored(id, 5, findSentence(paper, /\bprospective|retrospective|follow-up|longitudinal\b/i), 0.9)
        : scored(id, hasDesign ? 2 : 1, findSentence(paper, /\bstudy\b/i, objective), 0.65)
    case 'DESIGN_014':
      return has(paper, /\bincluded|eligible|aged|diagnosed|with\b/i)
        ? scored(id, n ? 4 : 3, findSentence(paper, /\bincluded|eligible|aged|diagnosed|with\b/i), 0.75)
        : absent(id, 'inclusion criteria', 1, 0.75)
    case 'DESIGN_017':
      return has(paper, /\bfollow-up|from .* to |months?|years?|days?|season\b/i)
        ? scored(id, 4, findSentence(paper, /\bfollow-up|from .* to |months?|years?|days?|season\b/i), 0.75)
        : absent(id, 'follow-up duration', 1, 0.75)
    case 'DESIGN_026':
      return hasComparator ? scored(id, 4, findSentence(paper, /\b(vs\.?|versus|compared with|compared to|control|placebo|case-control|cases|controls)\b/i), 0.8) : absent(id, 'comparator group', 1, 0.8)
    case 'DESIGN_030':
      return has(paper, /\bintention-to-treat|ITT|per-protocol\b/i) ? scored(id, 5, findSentence(paper, /\bintention-to-treat|ITT|per-protocol\b/i), 0.95) : absent(id, 'ITT or per-protocol analysis', 1, 0.85)
    case 'DESIGN_045':
      return unknown(id)

    case 'POPUL_005':
      return n ? scored(id, sampleScore(n), findSentence(paper, /\b(N\s*=|n\s*=|included|enrolled|participants?|patients?|infants?|children|women|men)\b/i), 0.8) : absent(id, 'sample size', 1, 0.8)
    case 'POPUL_007':
      return has(paper, /\bsex|gender|male|female|boys|girls|women|men\b/i) ? scored(id, 4, findSentence(paper, /\bsex|gender|male|female|boys|girls|women|men\b/i), 0.85) : absent(id, 'sex or gender distribution', 1, 0.75)
    case 'POPUL_008':
      return has(paper, /\bage|aged|years old|months|median age|mean age\b/i) ? scored(id, 4, findSentence(paper, /\bage|aged|years old|months|median age|mean age\b/i), 0.85) : absent(id, 'age distribution', 1, 0.75)
    case 'POPUL_009':
      return has(paper, /\brace|ethnicity|ethnic|asian|black|white|hispanic\b/i) ? scored(id, 4, findSentence(paper, /\brace|ethnicity|ethnic|asian|black|white|hispanic\b/i), 0.85) : absent(id, 'race or ethnicity distribution', 1, 0.75)
    case 'POPUL_012':
      return has(paper, /\bcomorbid|risk factors?|diabetes|hypertension|BMI|body mass|severity|fibrosis|cirrhosis\b/i) ? scored(id, 3, findSentence(paper, /\bcomorbid|risk factors?|diabetes|hypertension|BMI|body mass|severity|fibrosis|cirrhosis\b/i), 0.7) : absent(id, 'comorbidity distribution', 1, 0.7)
    case 'POPUL_013':
      return has(paper, /\bseverity|stage|grade|mild|moderate|severe|risk factors?|baseline\b/i) ? scored(id, 3, findSentence(paper, /\bseverity|stage|grade|mild|moderate|severe|risk factors?|baseline\b/i), 0.7) : absent(id, 'disease severity distribution', 1, 0.7)
    case 'POPUL_017':
      return has(paper, /\bnationwide|population-based|community-based|multicenter|representative|national\b/i) ? scored(id, 4, findSentence(paper, /\bnationwide|population-based|community-based|multicenter|representative|national\b/i), 0.8) : absent(id, 'representativeness assessment', 1, 0.7)
    case 'POPUL_025':
      return has(paper, /\bbaseline|randomized|adjusted|matched|similar age|similar .* distribution\b/i) ? scored(id, 3, findSentence(paper, /\bbaseline|randomized|adjusted|matched|similar age|similar .* distribution\b/i), 0.7) : absent(id, 'baseline balance', 1, 0.7)

    case 'EXPOS_001':
      return has(paper, /\b(intervention|treatment|therapy|vaccine|drug|exposure|polymorphism|test|label|diet|inhibitor|immunized)\b/i) ? scored(id, 4, findSentence(paper, /\b(intervention|treatment|therapy|vaccine|drug|exposure|polymorphism|test|label|diet|inhibitor|immunized)\b/i), 0.8) : absent(id, 'intervention or exposure definition', 1, 0.7)
    case 'EXPOS_003':
      return has(paper, /\b\d+(\.\d+)?\s*(mg|g|ml|iu|days?|weeks?|months?)|dose|portion|intensity\b/i) ? scored(id, 4, findSentence(paper, /\b\d+(\.\d+)?\s*(mg|g|ml|iu|days?|weeks?|months?)|dose|portion|intensity\b/i), 0.8) : absent(id, 'dose or intensity', 1, 0.75)
    case 'EXPOS_008':
      return hasComparator ? scored(id, 4, findSentence(paper, /\b(vs\.?|versus|compared with|compared to|control|placebo|cases|controls)\b/i), 0.8) : absent(id, 'comparator definition', 1, 0.8)
    case 'EXPOS_009':
      return hasComparator ? scored(id, 3, findSentence(paper, /\b(vs\.?|versus|compared with|compared to|control|placebo|cases|controls)\b/i), 0.65) : absent(id, 'appropriate comparator', 1, 0.7)
    case 'EXPOS_010':
      return has(paper, /\badherence|compliance|received|immunized|uptake\b/i) ? scored(id, 3, findSentence(paper, /\badherence|compliance|received|immunized|uptake\b/i), 0.7) : absent(id, 'adherence measurement', 1, 0.75)

    case 'OUTCM_001':
      return has(paper, /\bprimary outcome|main outcome|endpoint|outcome|served to identify|measured\b/i) ? scored(id, 4, findSentence(paper, /\bprimary outcome|main outcome|endpoint|outcome|served to identify|measured\b/i), 0.8) : scored(id, 2, result || objective, 0.6)
    case 'OUTCM_002':
      return scored(id, hasClinical ? 4 : 2, findSentence(paper, /\b(outcome|mortality|symptom|visits?|diagnosis|risk|cost|effectiveness|knowledge|attitude)\b/i, result), 0.7)
    case 'OUTCM_004':
      return has(paper, /\bsecondary|subgroup|sensitivity analyses|additional outcomes\b/i) ? scored(id, 3, findSentence(paper, /\bsecondary|subgroup|sensitivity analyses|additional outcomes\b/i), 0.7) : absent(id, 'secondary outcomes', 1, 0.75)
    case 'OUTCM_011':
      return has(paper, /\bcomposite\b/i) ? scored(id, has(paper, /\bcomponents?|decomposed|individual\b/i) ? 4 : 2, findSentence(paper, /\bcomposite|components?|individual\b/i), 0.7) : scored(id, 4, 'no composite outcome mentioned', 0.7)
    case 'OUTCM_014':
      return has(paper, /\bsurrogate|biomarker|marker\b/i) ? scored(id, 2, findSentence(paper, /\bsurrogate|biomarker|marker\b/i), 0.65) : scored(id, 4, 'no surrogate outcome flagged in abstract', 0.7)
    case 'OUTCM_037':
    case 'STATS_005':
      return hasEffect ? scored(id, hasCI ? 5 : 3, result, 0.8) : absent(id, 'primary effect size', 1, 0.75)
    case 'OUTCM_038':
    case 'STATS_006':
      return hasCI ? scored(id, 5, findSentence(paper, /95%\s*ci|confidence interval|\bci[,:\s]/i), 0.95) : absent(id, 'confidence intervals', 1, 0.85)
    case 'OUTCM_039':
      return has(paper, /\bNNT|NNH|number needed/i) ? scored(id, 5, findSentence(paper, /\bNNT|NNH|number needed/i), 0.95) : absent(id, 'NNT or NNH', 0, 0.85)
    case 'OUTCM_040':
    case 'AIPRED_016':
      return has(paper, /\bcalibration|Brier|Hosmer|calibration slope\b/i) ? scored(id, 5, findSentence(paper, /\bcalibration|Brier|Hosmer|calibration slope\b/i), 0.9) : absent(id, 'calibration metric', 1, 0.8)

    case 'STATS_002':
      return has(paper, /\b(primary analysis|multivariable|regression|Cox|ANOVA|likelihood ratio|pre-specified)\b/i) ? scored(id, 3, findSentence(paper, /\b(primary analysis|multivariable|regression|Cox|ANOVA|likelihood ratio|pre-specified)\b/i), 0.7) : absent(id, 'primary analysis specification', 1, 0.75)
    case 'STATS_007':
      return hasExactP ? scored(id, 5, findSentence(paper, /\bp\s*[=<>]\s*(?:0?\.\d+|\.\d+)/i), 0.95) : hasAnyP ? scored(id, 3, findSentence(paper, /\bp\s*[<=>]/i), 0.8) : absent(id, 'p-values', 1, 0.85)
    case 'STATS_015':
      return has(paper, /\bmissing|lost to follow-up|dropout|excluded|attrition\b/i) ? scored(id, 3, findSentence(paper, /\bmissing|lost to follow-up|dropout|excluded|attrition\b/i), 0.7) : absent(id, 'missing data quantification', 1, 0.75)
    case 'STATS_021':
      return has(paper, /\bpower|sample size calculation|sample size was calculated|adequate power\b/i) ? scored(id, 5, findSentence(paper, /\bpower|sample size calculation|sample size was calculated|adequate power\b/i), 0.9) : n ? scored(id, 2, findSentence(paper, /\b(N\s*=|n\s*=|included|enrolled|participants?|patients?)\b/i), 0.7) : absent(id, 'sample size justification', 1, 0.75)
    case 'STATS_026':
      return has(paper, /\binteraction|subgroup|likelihood ratio test\b/i) ? scored(id, /interaction|likelihood ratio test/i.test(text) ? 4 : 2, findSentence(paper, /\binteraction|subgroup|likelihood ratio test\b/i), 0.75) : absent(id, 'subgroup interaction test', 1, 0.75)
    case 'STATS_050':
      return has(paper, /\bsoftware|R version|SAS|SPSS|Stata|code|github\b/i) ? scored(id, 4, findSentence(paper, /\bsoftware|R version|SAS|SPSS|Stata|code|github\b/i), 0.85) : unknown(id)
    case 'STATS_055':
      return scored(id, hasCI || /no statistically significant|may|suggest|associated|appeared|estimated/i.test(text) ? 4 : 2, conclusionEvidence(paper), 0.7)

    case 'BIAS_001':
      return has(paper, /\badjusted|matched|selection bias|multivariable|included|eligible\b/i) ? scored(id, 3, findSentence(paper, /\badjusted|matched|selection bias|multivariable|included|eligible\b/i), 0.65) : absent(id, 'selection bias handling', 1, 0.7)
    case 'BIAS_015':
      return has(paper, /\bconfound|adjusted|multivariable|propensity|matched\b/i) ? scored(id, 4, findSentence(paper, /\bconfound|adjusted|multivariable|propensity|matched\b/i), 0.8) : absent(id, 'unmeasured confounding discussion', 1, 0.75)
    case 'BIAS_023':
      return has(paper, /\bimmortal time|time-dependent|time varying\b/i) ? scored(id, 5, findSentence(paper, /\bimmortal time|time-dependent|time varying\b/i), 0.9) : unknown(id)
    case 'BIAS_029':
      return has(paper, /\ballocation conceal|concealed|double-blind|randomized\b/i) ? scored(id, /conceal/i.test(text) ? 5 : 3, findSentence(paper, /\ballocation conceal|concealed|double-blind|randomized\b/i), 0.8) : absent(id, 'allocation concealment', 1, 0.8)
    case 'BIAS_033':
      return has(paper, /\bfunding|funded|supported by|industry|sponsor|grant\b/i) ? scored(id, 4, findSentence(paper, /\bfunding|funded|supported by|industry|sponsor|grant\b/i), 0.8) : unknown(id)
    case 'BIAS_034':
      return has(paper, /\bconflict of interest|competing interest|COI\b/i) ? scored(id, 5, findSentence(paper, /\bconflict of interest|competing interest|COI\b/i), 0.9) : unknown(id)

    case 'EXTV_001':
    case 'AIPRED_026':
      return has(paper, /\bexternal validation|validated in an external|independent validation|external cohort\b/i) ? scored(id, 5, findSentence(paper, /\bexternal validation|validated in an external|independent validation|external cohort\b/i), 0.9) : absent(id, 'external validation', 1, 0.8)
    case 'EXTV_002':
      return has(paper, /\bcountry|countries|external cohort|national|multicenter\b/i) ? scored(id, 3, findSentence(paper, /\bcountry|countries|external cohort|national|multicenter\b/i), 0.7) : absent(id, 'external cohort country', 1, 0.75)
    case 'EXTV_005':
      return has(paper, /\bindependent|external cohort|separate cohort\b/i) ? scored(id, 4, findSentence(paper, /\bindependent|external cohort|separate cohort\b/i), 0.8) : absent(id, 'external independence', 1, 0.75)
    case 'EXTV_008':
    case 'AIPRED_015':
      return has(paper, /\bAUROC|AUC|C-index|discrimination\b/i) ? scored(id, 5, findSentence(paper, /\bAUROC|AUC|C-index|discrimination\b/i), 0.9) : absent(id, 'discrimination metric', 1, 0.8)
    case 'EXTV_009':
    case 'EXTV_014':
    case 'AIPRED_028':
      return has(paper, /\bsubgroup|by age|by sex|by setting|fairness|groups\b/i) ? scored(id, 3, findSentence(paper, /\bsubgroup|by age|by sex|by setting|fairness|groups\b/i), 0.7) : absent(id, 'subgroup or setting performance', 1, 0.75)
    case 'EXTV_015':
      return has(paper, /\btemporal validation|later cohort|season|year\b/i) ? scored(id, 3, findSentence(paper, /\btemporal validation|later cohort|season|year\b/i), 0.7) : absent(id, 'temporal validation', 1, 0.75)
    case 'AIPRED_001':
      return has(paper, /\btrain|test split|training|validation set|test set\b/i) ? scored(id, 4, findSentence(paper, /\btrain|test split|training|validation set|test set\b/i), 0.8) : absent(id, 'train/test split', 1, 0.8)
    case 'AIPRED_019':
      return has(paper, /\bdecision curve|DCA|net benefit\b/i) ? scored(id, 5, findSentence(paper, /\bdecision curve|DCA|net benefit\b/i), 0.9) : absent(id, 'decision curve analysis', 1, 0.8)
    case 'AIPRED_023':
      return has(paper, /\bPPV|NPV|positive predictive|negative predictive\b/i) ? scored(id, 5, findSentence(paper, /\bPPV|NPV|positive predictive|negative predictive\b/i), 0.9) : absent(id, 'PPV or NPV', 1, 0.8)
    case 'AIPRED_033':
      return has(paper, /\bTRIPOD|CONSORT-AI|SPIRIT-AI\b/i) ? scored(id, 5, findSentence(paper, /\bTRIPOD|CONSORT-AI|SPIRIT-AI\b/i), 0.9) : unknown(id)

    case 'REPRT_001':
      return has(paper, /\bCONSORT|STROBE|PRISMA|TRIPOD|ARRIVE|reporting guideline\b/i) ? scored(id, 5, findSentence(paper, /\bCONSORT|STROBE|PRISMA|TRIPOD|ARRIVE|reporting guideline\b/i), 0.9) : unknown(id)
    case 'REPRT_003':
      return has(paper, /\bprotocol|registered|registration|NCT\d+|ISRCTN|UMIN|ChiCTR\b/i) ? scored(id, 4, findSentence(paper, /\bprotocol|registered|registration|NCT\d+|ISRCTN|UMIN|ChiCTR\b/i), 0.85) : unknown(id)
    case 'REPRT_004':
      return has(paper, /\bNCT\d+|ISRCTN|UMIN|ChiCTR|registration\b/i) ? scored(id, /NCT\d+|ISRCTN|UMIN|ChiCTR/i.test(text) ? 5 : 3, findSentence(paper, /\bNCT\d+|ISRCTN|UMIN|ChiCTR|registration\b/i), 0.85) : unknown(id)
    case 'REPRT_011':
      return has(paper, /\bCRediT|contributorship|author contributions\b/i) ? scored(id, 5, findSentence(paper, /\bCRediT|contributorship|author contributions\b/i), 0.9) : unknown(id)
    case 'REPRT_013':
      return has(paper, /\bfunding|funded|supported by|grant\b/i) ? scored(id, 4, findSentence(paper, /\bfunding|funded|supported by|grant\b/i), 0.8) : unknown(id)
    case 'REPRT_015':
      return has(paper, /\bethics|ethical approval|IRB|institutional review|informed consent\b/i) ? scored(id, 5, findSentence(paper, /\bethics|ethical approval|IRB|institutional review|informed consent\b/i), 0.9) : unknown(id)
    case 'REPRT_020':
      return has(paper, /\bflow diagram|PRISMA flow|participant flow\b/i) ? scored(id, 5, findSentence(paper, /\bflow diagram|PRISMA flow|participant flow\b/i), 0.9) : unknown(id)
    case 'REPRT_023':
      return has(paper, /\bsoftware|R version|SAS|SPSS|Stata|Python|package\b/i) ? scored(id, 4, findSentence(paper, /\bsoftware|R version|SAS|SPSS|Stata|Python|package\b/i), 0.8) : unknown(id)

    case 'INTERP_001':
      return scored(id, 4, conclusionEvidence(paper), 0.75)
    case 'INTERP_002':
      return /\bprove|definitively|always|never\b/i.test(text)
        ? scored(id, 2, conclusionEvidence(paper), 0.65)
        : scored(id, /may|suggest|associated|appears?|no statistically significant|estimated/i.test(text) ? 4 : 3, conclusionEvidence(paper), 0.7)
    case 'INTERP_003':
      return /\bcaus|effect of|impact of\b/i.test(text)
        ? scored(id, articleType === 'RCT' || /suggest|associated|may/i.test(text) ? 3 : 1, conclusionEvidence(paper), 0.65)
        : scored(id, 4, conclusionEvidence(paper), 0.7)
    case 'INTERP_005':
      return has(paper, /\blimitation|limited|caution|however|although\b/i) ? scored(id, 3, findSentence(paper, /\blimitation|limited|caution|however|although\b/i), 0.65) : absent(id, 'limitations', 1, 0.75)
    case 'INTERP_009':
      return has(paper, /\bin .* (france|china|iran|malawi|ethiopia|spain|korea)|single|multicenter|population-based|community-based|setting|country\b/i) ? scored(id, 3, findSentence(paper, /\bin .* (france|china|iran|malawi|ethiopia|spain|korea)|single|multicenter|population-based|community-based|setting|country\b/i), 0.7) : absent(id, 'generalizability boundary', 1, 0.7)
    case 'INTERP_016':
      return has(paper, /\bfuture|further|continued|remain|warranted|needed\b/i) ? scored(id, 3, findSentence(paper, /\bfuture|further|continued|remain|warranted|needed\b/i), 0.7) : absent(id, 'specific future research', 1, 0.75)
    case 'INTERP_029':
      return scored(id, 4, conclusionEvidence(paper), 0.7)

    case 'FIGS_001':
    case 'FIGS_005':
    case 'FIGS_007':
      return unknown(id)
    default:
      return scored(id, 2, objective || conclusionEvidence(paper), 0.5)
  }
}

export {
  clip,
  inferArticleType,
  applicable,
  scoreItem,
}

function main() {
  const IN = arg('in', 'codex-batch.json')
  const OUT = arg('out', 'codex-response.json')
  const batch = JSON.parse(readFileSync(IN, 'utf8'))
  const response = { scores: [] }
  const counts = { scored: 0, na: 0, unknown: 0 }

  for (const paper of batch.papers) {
    const articleType = inferArticleType(paper)
    const items = batch.rubric_items.map(item => {
      const out = scoreItem(item, paper, articleType)
      if (out.na) counts.na++
      else if (out.unknown) counts.unknown++
      else counts.scored++
      return out
    })
    response.scores.push({ doi: paper.doi, items })
  }

  writeFileSync(OUT, JSON.stringify(response, null, 2))
  console.log(`Wrote ${OUT}`)
  console.log(`  papers: ${response.scores.length}`)
  console.log(`  items/paper: ${batch.rubric_items.length}`)
  console.log(`  scored: ${counts.scored}`)
  console.log(`  N/A: ${counts.na}`)
  console.log(`  unknown: ${counts.unknown}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
