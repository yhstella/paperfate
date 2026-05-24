#!/usr/bin/env node
// EMPA-REG cold-start smoke test: no target journal, no post-publication fields.

import { forecastManuscriptDeterministic } from '../src/server/deterministicExtract.js'
import { loadFateCore, predictFromExtraction } from '../src/server/fatecoreInference.js'

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=').slice(1).join('=')
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) return ARGS[i + 1]
  return def
}

const versionTag = arg('version-tag', process.env.FATECORE_VERSION || 'v0.3-prepub')

const manuscript = {
  title: 'Empagliflozin, cardiovascular outcomes, and mortality in type 2 diabetes',
  abstract: `Background: Patients with type 2 diabetes are at high risk for cardiovascular events.
Methods: In this randomized, double-blind, placebo-controlled trial, we assigned 7020 patients with type 2
diabetes and established cardiovascular disease to receive empagliflozin 10 mg or 25 mg or placebo once daily.
The primary composite outcome was death from cardiovascular causes, nonfatal myocardial infarction, or
nonfatal stroke. Median observation time was 3.1 years.
Results: The primary outcome occurred in 10.5% of patients in the empagliflozin group and 12.1% in the
placebo group (hazard ratio 0.86, 95% CI 0.74 to 0.99; P=0.04 for superiority). Empagliflozin reduced death
from cardiovascular causes, hospitalization for heart failure, and death from any cause.
Conclusions: Empagliflozin reduced cardiovascular events and mortality among patients with type 2 diabetes
and established cardiovascular disease.`,
  authors: ['B. Zinman', 'C. Wanner', 'J. Lachin', 'D. Fitchett'],
  year: new Date().getFullYear(),
}

const extraction = forecastManuscriptDeterministic(manuscript, 'RCT', { mode: 'Q100' })
const model = loadFateCore({ versionTag })
const forecast = predictFromExtraction(manuscript, extraction, { model })

console.log(JSON.stringify({
  sample: {
    title: manuscript.title,
    cold_start: true,
    requested_version_tag: versionTag,
    target_journal_supplied: false,
    post_publication_fields_supplied: false,
    article_type: extraction.article_type,
    overall_score: extraction.overall_score,
  },
  fatecore: forecast.fatecore,
  predictions: forecast.predictions,
  confidence: forecast.confidence,
}, null, 2))
