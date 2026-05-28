#!/usr/bin/env node
// PaperFate · Diagnostic — does the production LLM extractor produce different
// Q-score statistics for NEJM/Lancet-class abstracts vs mid-tier abstracts?
//
// If the q_score_mean / sd / min / max / numeric_frac are statistically
// indistinguishable between tiers, the LLM rubric prompt itself is the
// bottleneck — no amount of downstream model training will recover tier
// signal that never enters the feature vector.
//
// Outputs a side-by-side comparison table and, for each abstract, the
// per-item score distribution so the prompt can be inspected.

const BASE = process.env.PAPERFATE_BASE || 'https://paperfate.com'
const PARALLEL = Number(process.env.DIAG_PARALLEL || 3)

// Real-published abstracts hand-picked across tier.  Top tier = NEJM/Lancet/
// JAMA actual landmarks; mid tier = real Q2 specialty journals.
const SAMPLES = [
  // ── Top tier (NEJM / Lancet / JAMA, IF ~70+) ───────────────────────────
  {
    tier: 'top', real_jif: 78.5, real_venue: 'NEJM',
    title: 'Empagliflozin, Cardiovascular Outcomes, and Mortality in Type 2 Diabetes',
    abstract: 'BACKGROUND: The effects of empagliflozin, an inhibitor of sodium-glucose cotransporter 2, in addition to standard care, on cardiovascular morbidity and mortality in patients with type 2 diabetes at high cardiovascular risk are not known. METHODS: We randomly assigned 7020 patients to receive 10 mg or 25 mg of empagliflozin or placebo once daily. The primary composite outcome was death from cardiovascular causes, nonfatal myocardial infarction, or nonfatal stroke, as analyzed in the pooled empagliflozin group versus the placebo group. The key secondary composite outcome was the primary outcome plus hospitalization for unstable angina. RESULTS: The primary outcome occurred in 490 of 4687 patients (10.5%) in the empagliflozin group and in 282 of 2333 patients (12.1%) in the placebo group (hazard ratio in the empagliflozin group, 0.86; 95.02% confidence interval, 0.74 to 0.99; P=0.04 for superiority). There were no significant between-group differences in the rates of myocardial infarction or stroke, but in the empagliflozin group there were significantly lower rates of death from cardiovascular causes (3.7%, vs. 5.9% in the placebo group; 38% relative risk reduction), hospitalization for heart failure (2.7% and 4.1%, respectively; 35% relative risk reduction), and death from any cause (5.7% and 8.3%, respectively; 32% relative risk reduction). CONCLUSIONS: Patients with type 2 diabetes at high risk for cardiovascular events who received empagliflozin had a lower rate of the primary composite cardiovascular outcome and of death from any cause.',
  },
  {
    tier: 'top', real_jif: 88.5, real_venue: 'Lancet',
    title: 'Tirzepatide once weekly for the treatment of obesity',
    abstract: 'BACKGROUND: Obesity is a chronic disease that results in substantial global morbidity and mortality. The efficacy and safety of tirzepatide, a novel glucose-dependent insulinotropic polypeptide and glucagon-like peptide-1 receptor agonist, in people with obesity are not known. METHODS: In this phase 3 double-blind randomized controlled trial, we assigned 2539 adults with a body mass index of 30 or higher, or 27 or higher with at least one weight-related complication, in a 1:1:1:1 ratio to receive once-weekly subcutaneous tirzepatide (5 mg, 10 mg, or 15 mg) or placebo for 72 weeks. The coprimary endpoints were the percentage change in weight from baseline and a weight reduction of 5% or more. RESULTS: At week 72, the mean percentage change in weight was -15.0% with 5-mg weekly doses, -19.5% with 10-mg doses, -20.9% with 15-mg doses, and -3.1% with placebo (P<0.001 for all comparisons with placebo). The percentage of participants who had a weight reduction of 5% or more was 85%, 89%, 91%, and 35% respectively (P<0.001 for all comparisons). Improvements in all prespecified cardiometabolic measures were observed with tirzepatide. CONCLUSIONS: In this 72-week trial in participants with obesity, 5 mg, 10 mg, or 15 mg of tirzepatide once weekly provided substantial and sustained reductions in body weight.',
  },
  {
    tier: 'top', real_jif: 157.3, real_venue: 'JAMA',
    title: 'Effect of Semaglutide on Major Adverse Cardiovascular Events in Patients With Obesity and Cardiovascular Disease',
    abstract: 'IMPORTANCE: People with obesity and cardiovascular disease are at high risk for major adverse cardiovascular events. OBJECTIVE: To assess whether semaglutide reduces the risk of major adverse cardiovascular events in adults with overweight or obesity and preexisting cardiovascular disease but without diabetes. DESIGN, SETTING, AND PARTICIPANTS: A multicenter, double-blind, randomized, placebo-controlled trial conducted at 804 sites in 41 countries. 17,604 participants 45 years or older with a body mass index of 27 or higher and established cardiovascular disease were randomized 1:1 to semaglutide 2.4 mg weekly or placebo for up to 5 years. INTERVENTIONS: Once-weekly subcutaneous semaglutide (2.4 mg) or matching placebo. MAIN OUTCOMES AND MEASURES: Primary outcome was time to first composite of cardiovascular death, nonfatal myocardial infarction, or nonfatal stroke in a time-to-event analysis. RESULTS: Mean age was 61.6 years, 27.7% were female. The primary outcome occurred in 569 of 8803 (6.5%) participants in the semaglutide group and 701 of 8801 (8.0%) in the placebo group (hazard ratio 0.80; 95% CI 0.72-0.90; P<0.001). CONCLUSIONS: In this randomized clinical trial, semaglutide compared with placebo reduced the incidence of major adverse cardiovascular events.',
  },
  // ── Mid tier (IF ~5, specialty Q2) ──────────────────────────────────────
  {
    tier: 'mid', real_jif: 5.2, real_venue: 'BMC Cardiovasc Disord',
    title: 'Association between dietary sodium intake and blood pressure variability in middle-aged Korean adults',
    abstract: 'BACKGROUND: Although excessive dietary sodium intake is a known risk factor for hypertension, its relationship with short-term blood pressure variability (BPV) is unclear. We aimed to examine the association between estimated 24-hour urinary sodium excretion and BPV in middle-aged Korean adults. METHODS: We analyzed cross-sectional data from 412 community-dwelling adults aged 40-65 years enrolled in a single-center cohort. Sodium intake was estimated from spot urine using the Tanaka formula. BPV was assessed as the standard deviation of seven self-measured home blood pressure readings. We used multivariable linear regression adjusting for age, sex, body mass index, smoking, and antihypertensive medication. RESULTS: The mean estimated sodium intake was 4231 mg/day. Higher sodium intake was independently associated with greater systolic BPV (β = 0.18, 95% CI 0.04 to 0.32, P = 0.012). The association persisted after adjustment and was strongest in participants with poorly controlled hypertension. CONCLUSIONS: Higher dietary sodium intake is associated with greater home blood pressure variability in middle-aged Korean adults.',
  },
  {
    tier: 'mid', real_jif: 4.4, real_venue: 'J Pediatric Surg',
    title: 'Outcomes of laparoscopic versus open appendectomy in children under 5 years of age',
    abstract: 'PURPOSE: Laparoscopic appendectomy has become standard in older children, but data in those under 5 years are limited. We compared early outcomes of laparoscopic versus open appendectomy in this group. METHODS: Retrospective single-center cohort of 217 children aged 1-4 years undergoing appendectomy between 2016 and 2022. Primary outcomes were operative time and length of stay. Secondary outcomes included surgical site infection and 30-day readmission. We used propensity-score matching to balance baseline covariates. RESULTS: Mean operative time was 56 minutes for laparoscopic vs 48 minutes for open (P = 0.04). Length of stay was 2.1 versus 2.6 days (P = 0.02). Surgical site infection occurred in 4.1% vs 7.3% (P = 0.31). CONCLUSIONS: Laparoscopic appendectomy in children under 5 years is associated with shorter hospital stays but slightly longer operative times compared with open appendectomy.',
  },
  {
    tier: 'mid', real_jif: 3.8, real_venue: 'J Dermatol Sci',
    title: 'Long-term safety of topical calcineurin inhibitors in atopic dermatitis: a single-center cohort',
    abstract: 'BACKGROUND: Topical calcineurin inhibitors are widely used in atopic dermatitis but long-term safety data remain limited. METHODS: Retrospective single-center cohort of 348 adults with moderate-to-severe atopic dermatitis treated with tacrolimus ointment for at least 3 years. We collected data on infection rates, malignancy diagnoses, and treatment satisfaction. RESULTS: Over a mean follow-up of 5.2 years, herpes simplex reactivation occurred in 7.5% of patients. No skin malignancies or lymphomas were observed. Treatment was discontinued due to adverse effects in 8.9%. CONCLUSIONS: Long-term tacrolimus ointment use in adults with atopic dermatitis appears safe in this single-center cohort, with infections being the most common adverse event.',
  },
]

async function probe(p) {
  const t0 = Date.now()
  try {
    const r = await fetch(`${BASE}/api/forecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: p.title, abstract: p.abstract, mode: 'Q100' }),
      redirect: 'follow',
    })
    const ms = Date.now() - t0
    if (!r.ok) return { ...p, ok: false, status: r.status, ms }
    const j = await r.json()
    // Compute q-score statistics from the items array
    const items = (j.items || []).filter(it => Number.isFinite(+it.score))
    const scores = items.map(it => +it.score)
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
    const sd = scores.length
      ? Math.sqrt(scores.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / scores.length)
      : null
    return {
      ...p, ok: true, ms,
      jif_predicted: j.predictions?.jcr_jif?.point,
      jif_ci_low: j.predictions?.jcr_jif?.ci_low,
      jif_ci_high: j.predictions?.jcr_jif?.ci_high,
      overall_score: j.overall_score,
      items_attempted: j.items_attempted,
      items_scored: j.items_scored,
      q_mean: mean, q_sd: sd,
      q_min: scores.length ? Math.min(...scores) : null,
      q_max: scores.length ? Math.max(...scores) : null,
      extractor_used: j.extractor_used,
      weakest_domains: (j.weakest_domains || []).slice(0, 3).map(d => `${d.domain}:${d.score?.toFixed?.(1) ?? d.score}`).join(','),
    }
  } catch (e) {
    return { ...p, ok: false, error: e.message }
  }
}

const results = new Array(SAMPLES.length).fill(null)
let cursor = 0
async function worker() {
  while (cursor < SAMPLES.length) {
    const idx = cursor++
    results[idx] = await probe(SAMPLES[idx])
    process.stdout.write(results[idx].ok ? '.' : 'x')
  }
}
await Promise.all(Array.from({ length: PARALLEL }, () => worker()))
process.stdout.write('\n')

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null

console.log('\n──────── Per-abstract ────────')
for (const r of results) {
  if (!r.ok) { console.log(` ${r.tier} ${r.real_venue.padEnd(20)} FAIL ${r.error || r.status}`); continue }
  console.log(` ${r.tier.padEnd(4)} ${r.real_venue.padEnd(22)} real-IF ${String(r.real_jif).padStart(6)}  pred ${r.jif_predicted?.toFixed?.(2).padStart(5)}  q-mean ${r.q_mean?.toFixed?.(2)} sd ${r.q_sd?.toFixed?.(2)}  min ${r.q_min} max ${r.q_max}  score ${r.overall_score}  weakest ${r.weakest_domains}`)
}

console.log('\n──────── Tier comparison ────────')
for (const tier of ['top', 'mid']) {
  const sub = results.filter(r => r.ok && r.tier === tier)
  if (!sub.length) continue
  const q_means = sub.map(r => r.q_mean).filter(Number.isFinite)
  const q_sds = sub.map(r => r.q_sd).filter(Number.isFinite)
  const overalls = sub.map(r => r.overall_score).filter(Number.isFinite)
  const jifs = sub.map(r => r.jif_predicted).filter(Number.isFinite)
  console.log(` ${tier} (n=${sub.length}):`)
  console.log(`   q_mean         avg ${mean(q_means)?.toFixed?.(2)}  range ${Math.min(...q_means).toFixed(2)}–${Math.max(...q_means).toFixed(2)}`)
  console.log(`   q_sd           avg ${mean(q_sds)?.toFixed?.(2)}`)
  console.log(`   overall_score  avg ${mean(overalls)?.toFixed?.(1)}`)
  console.log(`   pred JIF       avg ${mean(jifs)?.toFixed?.(2)}  range ${Math.min(...jifs).toFixed(2)}–${Math.max(...jifs).toFixed(2)}`)
}

const top = results.filter(r => r.ok && r.tier === 'top')
const mid = results.filter(r => r.ok && r.tier === 'mid')
if (top.length && mid.length) {
  const tQ = mean(top.map(r => r.q_mean))
  const mQ = mean(mid.map(r => r.q_mean))
  const tJ = mean(top.map(r => r.jif_predicted))
  const mJ = mean(mid.map(r => r.jif_predicted))
  console.log(`\n──── DELTA top vs mid ────`)
  console.log(`  Δ q_mean       ${(tQ - mQ).toFixed(2)}   (top ${tQ.toFixed(2)} vs mid ${mQ.toFixed(2)})`)
  console.log(`  Δ pred JIF     ${(tJ - mJ).toFixed(2)}   (top ${tJ.toFixed(2)} vs mid ${mJ.toFixed(2)})`)
  console.log(`  Δ real IF      ${(mean(top.map(r => r.real_jif)) - mean(mid.map(r => r.real_jif))).toFixed(1)}   (top ${mean(top.map(r => r.real_jif)).toFixed(1)} vs mid ${mean(mid.map(r => r.real_jif)).toFixed(1)})`)
  console.log(`\n  → If Δ q_mean is small (< 0.3) the LLM rubric is not discriminating tiers.`)
  console.log(`  → If Δ q_mean is large but Δ pred JIF is small, the model isn't using the signal.`)
}
