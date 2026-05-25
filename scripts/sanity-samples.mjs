#!/usr/bin/env node
// PaperFate · production sanity check across the four sample manuscripts.
// Confirms predictions are reasonable for very different study types.

const BASE = process.env.PAPERFATE_BASE || 'https://paperfate.com'

const SAMPLES = [
  {
    label: 'RCT · cardiometabolic',
    title: 'Empagliflozin and major adverse cardiovascular events in adults with chronic kidney disease',
    abstract: 'Background: SGLT2 inhibitors reduce cardiovascular events in patients with type 2 diabetes, but their effect in adults with chronic kidney disease (CKD) without diabetes is uncertain. Methods: In this international, multicenter, double-blind, placebo-controlled trial, we randomly assigned 6609 adults with CKD to empagliflozin 10 mg daily or matching placebo. The primary composite outcome was progression of kidney disease or death from cardiovascular causes. Results: Median follow-up was 2.0 years. The primary outcome occurred in 432 of 3304 participants in the empagliflozin group and 558 of 3305 in the placebo group (HR 0.72, 95% CI 0.64-0.82, P<0.001). Effects were consistent across pre-specified subgroups including patients without diabetes. Conclusions: Empagliflozin reduced the risk of kidney-disease progression or cardiovascular death in adults with CKD.',
    expected_jif_range: [1, 100],
  },
  {
    label: 'Meta · oncology',
    title: 'Immune checkpoint inhibitors versus chemotherapy in advanced non-small-cell lung cancer: a meta-analysis of randomized trials',
    abstract: 'Background: First-line therapy for advanced NSCLC has shifted toward immune checkpoint inhibitors (ICIs), but comparative effectiveness across PD-L1 expression subgroups remains debated. Methods: We systematically searched PubMed, Embase, and Cochrane CENTRAL through December 2024 for phase III randomized trials comparing first-line ICI-based regimens with platinum-doublet chemotherapy in advanced NSCLC without targetable driver alterations. Two reviewers independently extracted data using Cochrane RoB 2. We pooled hazard ratios using random-effects models stratified by PD-L1 tumor proportion score. Results: Fourteen trials including 8742 patients met inclusion criteria. ICI-based regimens improved overall survival over chemotherapy alone (HR 0.74, 95% CI 0.69-0.80, I-squared=42%). The OS benefit was largest in PD-L1 TPS at least 50% (HR 0.66, 95% CI 0.57-0.76). Grade 3 or higher immune-related events occurred in 17.4% of ICI recipients versus 4.2% with chemotherapy. Conclusions: First-line ICI-based therapy improves OS in advanced NSCLC across PD-L1 strata.',
    expected_jif_range: [1, 80],
  },
  {
    label: 'Cohort · pediatrics',
    title: 'Early antibiotic exposure and incident childhood asthma in a population-based birth cohort',
    abstract: 'Background: Early-life antibiotic exposure has been hypothesized to perturb the developing microbiome and increase asthma risk, but evidence from large cohorts with confounding control is inconsistent. Methods: We assembled a population-based birth cohort of 412,098 children born between 2008 and 2018 from linked national health registries in Denmark. Antibiotic dispensations during the first year of life were classified by spectrum and indication. The outcome was a recorded diagnosis of asthma between ages 2 and 10. We used Cox proportional hazards models adjusted for maternal asthma, mode of delivery, gestational age, breastfeeding duration, household smoking, and socioeconomic indicators. Sibling-pair analyses addressed shared familial confounding. Results: 89,431 children received at least one antibiotic course in year 1. Asthma was diagnosed in 36,219 children over median 6.4 years of follow-up. Year-1 antibiotic exposure was associated with incident asthma (HR 1.27, 95% CI 1.24-1.31). The association attenuated but remained in sibling-pair analyses (HR 1.11). Conclusions: Early antibiotic exposure was modestly associated with childhood asthma.',
    expected_jif_range: [1, 50],
  },
  {
    label: 'AI · radiology',
    title: 'A deep-learning model for detection of incidental pulmonary embolism on routine chest CT',
    abstract: 'Background: Incidental pulmonary embolism (iPE) on chest CT performed for other indications is underdiagnosed. We developed and externally validated a deep-learning model to flag suspected iPE in real time at the point of imaging. Methods: Training data comprised 47,302 contrast-enhanced chest CT studies from three academic centers (2014-2022), with iPE labels established by adjudicated radiologist re-read. We trained a 3D convolutional neural network with attention pooling, using only routine chest-CT studies. External validation was performed prospectively on 8914 consecutive chest CTs from a fourth, geographically distinct center. Primary outcome was AUROC; secondary outcomes included sensitivity, specificity, and time-to-flag. Results: External iPE prevalence was 1.8%. The model achieved AUROC 0.962 (95% CI 0.954-0.970) with sensitivity 92.4% and specificity 96.1% at the prespecified threshold. Median time from acquisition to flag was 41 seconds. Calibration was preserved across scanner vendor, slice thickness, and BMI. Conclusions: A deep-learning model accurately and rapidly detected iPE on routine chest CT.',
    expected_jif_range: [1, 50],
  },
]

async function probe(sample) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/forecast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: sample.title, abstract: sample.abstract, mode: 'Q100' }),
    redirect: 'follow',
  })
  const ms = Date.now() - t0
  if (!res.ok) return { sample, ok: false, status: res.status, ms }
  const json = await res.json()
  const jif = json?.predictions?.jcr_jif
  const timeline = json?.predictions?.review_timeline_days
  const journey = json?.journey
  return {
    sample,
    ok: true,
    status: res.status,
    ms,
    jif,
    timeline,
    journeyVenues: journey?.map(s => s.venue),
    journeySwitchCosts: journey?.map(s => s.switchCostValue),
    suggestionsCount: json?.counterfactual_suggestions?.length || 0,
    confidence: json?.confidence,
    fatecore: json?.fatecore,
  }
}

const results = []
for (const s of SAMPLES) {
  process.stdout.write(`  ${s.label} ...`)
  const r = await probe(s)
  results.push(r)
  process.stdout.write(` ${r.ok ? '✓' : '✗'}  ${r.ms}ms\n`)
}

console.log('\n─── Summary ───')
for (const r of results) {
  console.log(`\n${r.sample.label}`)
  if (!r.ok) { console.log('  HTTP', r.status); continue }
  const [lo, hi] = r.sample.expected_jif_range
  const jifPoint = r.jif?.point
  const inRange = Number.isFinite(jifPoint) && jifPoint >= lo && jifPoint <= hi
  console.log(`  JIF:      ${jifPoint?.toFixed(2)} (CI ${r.jif?.ci_low?.toFixed(2)}-${r.jif?.ci_high?.toFixed(2)})  ${inRange ? '✓ in expected range' : '⚠ out of range'}`)
  console.log(`  Timeline: ${r.timeline?.point}d (CI ${r.timeline?.ci_low}-${r.timeline?.ci_high})`)
  console.log(`  Journey:  ${(r.journeyVenues || []).map((v, i) => v).join(' → ')}`)
  if (r.journeySwitchCosts) console.log(`  Costs:    ${r.journeySwitchCosts.map(c => Number.isFinite(c) ? c.toFixed(2) : 'n/a').join(', ')}`)
  console.log(`  Suggestions: ${r.suggestionsCount}, confidence ${(r.confidence * 100).toFixed(0)}%, model ${r.fatecore?.version}, timeline ${r.fatecore?.timeline_model}`)
}
const fails = results.filter(r => !r.ok).length
const oob = results.filter(r => r.ok && (() => { const [lo, hi] = r.sample.expected_jif_range; const p = r.jif?.point; return !(Number.isFinite(p) && p >= lo && p <= hi) })()).length
console.log(`\n[${fails === 0 && oob === 0 ? 'PASS' : 'WARN'}] ${results.length - fails - oob}/${results.length} samples in expected range (${fails} HTTP fail, ${oob} out-of-range)`)
process.exit(fails === 0 ? 0 : 1)
