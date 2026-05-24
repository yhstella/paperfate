#!/usr/bin/env node
// Local FateCore v0.3 smoke test using an EMPA-REG style RCT sample.

import { forecastManuscriptDeterministic } from '../src/server/deterministicExtract.js'
import { loadFateCore, predictFromExtraction } from '../src/server/fatecoreInference.js'

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
  funding: 'Boehringer Ingelheim and Eli Lilly',
  author_features: {
    first_author_h_index: 80,
    last_author_h_index: 95,
    max_team_h_index: 120,
    median_team_h_index: 70,
    team_size_with_id: 8,
    international_collab: 1,
  },
}

const extraction = forecastManuscriptDeterministic(manuscript, 'RCT', { mode: 'Q100' })
const model = loadFateCore()
const forecast = predictFromExtraction(manuscript, extraction, {
  model,
  authorFeatures: manuscript.author_features,
  targetJournal: {
    name: 'New England Journal of Medicine',
    j_hist_metric_age: 1,
    j_hist_jcr_jif: 96.2,
    j_hist_jcr_jif_5yr: 91.5,
    j_hist_jci: 12.0,
    j_hist_article_influence: 28.0,
    j_hist_eigenfactor: 0.6,
  },
})

console.log(JSON.stringify({
  sample: {
    title: manuscript.title,
    article_type: extraction.article_type,
    overall_score: extraction.overall_score,
  },
  fatecore: forecast.fatecore,
  predictions: forecast.predictions,
  confidence: forecast.confidence,
}, null, 2))
