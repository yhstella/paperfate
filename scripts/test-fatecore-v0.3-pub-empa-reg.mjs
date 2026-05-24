#!/usr/bin/env node
// EMPA-REG smoke scenarios for FateCore v0.3-pub.

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

const versionTag = arg('version-tag', process.env.FATECORE_VERSION || 'v0.3-pub')

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

const targetJournals = {
  cold_start: null,
  nejm: {
    name: 'New England Journal of Medicine',
    j_hist_metric_age: 1,
    j_hist_jcr_jif: 96.2,
    j_hist_jcr_jif_5yr: 91.5,
    j_hist_jci: 24.0,
    j_hist_article_influence: 28.0,
    j_hist_eigenfactor: 0.6,
  },
  saudi_heart: {
    name: 'Saudi Heart Association Journal',
    j_hist_metric_age: 1,
    j_hist_jcr_jif: 1.4,
    j_hist_jcr_jif_5yr: 1.6,
    j_hist_jci: 0.35,
    j_hist_article_influence: 0.2,
    j_hist_eigenfactor: 0.002,
  },
}

const extraction = forecastManuscriptDeterministic(manuscript, 'RCT', { mode: 'Q100' })
const model = loadFateCore({ versionTag })
const scenarios = {}
for (const [name, targetJournal] of Object.entries(targetJournals)) {
  const forecast = predictFromExtraction(manuscript, extraction, { model, targetJournal: targetJournal || {} })
  scenarios[name] = {
    target_journal: targetJournal?.name || null,
    jcr_jif: forecast.predictions.jcr_jif,
    icite_rcr: forecast.predictions.icite_rcr,
    citations_5yr: forecast.predictions.citations_5yr,
    confidence: forecast.confidence,
  }
}

console.log(JSON.stringify({
  sample: {
    title: manuscript.title,
    requested_version_tag: versionTag,
    article_type: extraction.article_type,
    overall_score: extraction.overall_score,
  },
  fatecore: {
    version: model.version,
    loaded_targets: model.loadedTargets,
    missing_targets: model.missingTargets,
    feature_count: model.featureNames.length,
  },
  scenarios,
}, null, 2))
