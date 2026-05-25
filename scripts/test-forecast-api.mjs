#!/usr/bin/env node
// Local smoke test for api/forecast.js without starting Vite/Vercel.

import handler from '../api/forecast.js'

const body = {
  title: 'External validation of a machine-learning model for early detection of sepsis',
  abstract: `Background: Early recognition of sepsis remains challenging in emergency departments.
Objective: To externally validate a machine-learning risk model for sepsis onset within 24 hours.
Methods: We performed a retrospective multicenter cohort study of 18,420 adult emergency department visits
from four hospitals between 2021 and 2024. Model discrimination, calibration, and clinical utility were
assessed using AUROC, calibration plots, and decision-curve analysis.
Results: The model achieved an AUROC of 0.87 with good calibration after intercept updating.
Conclusions: The externally validated model may support earlier sepsis recognition, although prospective
impact evaluation is warranted before deployment.`,
  authors: ['A. Kim', 'B. Lee', 'C. Park', 'D. Smith'],
  year: 2025,
  first_affiliation: 'Department of Emergency Medicine, Seoul, Korea',
  funding: 'Supported by an institutional research grant.',
  author_features: {
    first_author_h_index: 12,
    last_author_h_index: 44,
    max_team_h_index: 44,
    median_team_h_index: 18,
    team_size_with_id: 4,
    international_collab: 1,
  },
}

const req = {
  method: 'POST',
  headers: { origin: 'http://localhost:5180' },
  body,
}

const res = {
  statusCode: 200,
  headers: {},
  payload: null,
  setHeader(key, value) {
    this.headers[key] = value
  },
  status(code) {
    this.statusCode = code
    return this
  },
  json(payload) {
    this.payload = payload
    return this
  },
  end() {
    return this
  },
}

await handler(req, res)

const summary = {
  statusCode: res.statusCode,
  error: res.payload?.error,
  model_status: res.payload?.fatecore?.model_status,
  loaded_targets: res.payload?.fatecore?.loaded_targets,
  feature_count: res.payload?.fatecore?.feature_count,
  cost_usd: res.payload?.cost_usd,
  llm_items: res.payload?.pipeline?.llm_items,
  deterministic: res.payload?.pipeline?.deterministic,
  predictions: Object.fromEntries(
    Object.entries(res.payload?.predictions || {}).map(([k, v]) => [k, v.point])
  ),
}

console.log(JSON.stringify(summary, null, 2))
if (res.statusCode >= 400) process.exit(1)
