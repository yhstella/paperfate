// FateCore-v0.1 mock engine.
// Frontend heuristic so the demo feels alive before the real backend.
// Replace each scoring branch with the OpenAlex/Semantic Scholar pipeline output.

const KEYWORDS = {
  novelty:  ['novel', 'first', 'unprecedented', 'breakthrough', 'discover', 'establishes'],
  strength: ['multicenter', 'external valid', 'prospective', 'randomi', 'meta-analysis', 'cohort', 'longitudinal', 'double-blind', 'placebo-controlled'],
  ai:       ['deep learning', 'machine learning', 'neural', 'transformer', 'foundation model', 'large language', 'radiomic'],
  endpoint: ['mortality', 'survival', 'mace', 'cardiovascular events', 'cancer', 'incidence', 'hospitalization', 'progression', 'recurrence'],
  weak:     ['single-center', 'single center', 'pilot', 'preliminary', 'small sample'],
}

const TIERS = [
  { label: 'IF <5',         lo: 1,  hi: 4,  bestFit: 'Specialty journal',                  stretch: 'Mid-tier subspecialty',     weeksLo: 4,  weeksHi: 8  },
  { label: 'IF 5–10',       lo: 5,  hi: 10, bestFit: 'Q1 subspecialty journal',            stretch: 'Top subspecialty',          weeksLo: 6,  weeksHi: 12 },
  { label: 'IF 10–15',      lo: 10, hi: 15, bestFit: 'Top subspecialty (field-leading)',   stretch: 'General medicine journal',  weeksLo: 8,  weeksHi: 14 },
  { label: 'IF 15–25',      lo: 15, hi: 25, bestFit: 'General medicine',                   stretch: 'NEJM / Lancet / JAMA',      weeksLo: 10, weeksHi: 18 },
  { label: 'IF >25 (top)',  lo: 25, hi: 70, bestFit: 'NEJM / Lancet / JAMA',               stretch: 'Top-of-field',              weeksLo: 12, weeksHi: 22 },
]

// Field-aware example similars. Real backend will compute these from embeddings.
const SIMILARS_BY_FIELD = {
  Cardiology: [
    { title: 'Empagliflozin in patients with heart failure and reduced ejection fraction', venue: 'N Engl J Med', if: 158.5, year: 2020, citations: 3120 },
    { title: 'Dapagliflozin in patients with chronic kidney disease',                       venue: 'N Engl J Med', if: 158.5, year: 2020, citations: 2840 },
    { title: 'Polygenic risk scores for coronary artery disease',                           venue: 'Eur Heart J',  if: 39.3,  year: 2022, citations: 412 },
    { title: 'AI-ECG for detection of paroxysmal atrial fibrillation',                      venue: 'Lancet',       if: 168.9, year: 2021, citations: 880 },
  ],
  Oncology: [
    { title: 'Pembrolizumab plus chemotherapy in metastatic NSCLC',                         venue: 'N Engl J Med', if: 158.5, year: 2018, citations: 4210 },
    { title: 'Trastuzumab deruxtecan in HER2-low breast cancer',                            venue: 'N Engl J Med', if: 158.5, year: 2022, citations: 1620 },
    { title: 'Deep learning for survival prediction across tumor types',                    venue: 'Nat Med',      if: 87.2,  year: 2023, citations: 240 },
    { title: 'Circulating tumor DNA for minimal residual disease detection',                venue: 'JAMA Oncol',   if: 30.8,  year: 2022, citations: 380 },
  ],
  Neurology: [
    { title: 'Lecanemab in early Alzheimer disease',                                        venue: 'N Engl J Med', if: 158.5, year: 2023, citations: 1140 },
    { title: 'Endovascular thrombectomy for large-core stroke',                             venue: 'N Engl J Med', if: 158.5, year: 2023, citations: 720 },
    { title: 'Plasma p-tau217 for Alzheimer biomarker detection',                           venue: 'JAMA',         if: 120.7, year: 2024, citations: 210 },
  ],
  Endocrinology: [
    { title: 'Semaglutide and cardiovascular outcomes in obesity without diabetes',         venue: 'N Engl J Med', if: 158.5, year: 2023, citations: 1980 },
    { title: 'Tirzepatide once weekly for the treatment of obesity',                        venue: 'N Engl J Med', if: 158.5, year: 2022, citations: 2410 },
    { title: 'Bariatric surgery vs medical therapy in obesity with diabetes',               venue: 'JAMA',         if: 120.7, year: 2021, citations: 470 },
  ],
  'Infectious disease': [
    { title: 'Nirmatrelvir for high-risk nonhospitalized patients with COVID-19',           venue: 'N Engl J Med', if: 158.5, year: 2022, citations: 2950 },
    { title: 'Long-term outcomes after acute SARS-CoV-2 infection',                         venue: 'Lancet',       if: 168.9, year: 2022, citations: 1880 },
    { title: 'Universal antibiotic prophylaxis for sepsis: a meta-analysis',                venue: 'JAMA',         if: 120.7, year: 2021, citations: 290 },
  ],
  Hepatology: [
    { title: 'External validation of a deep-learning HCC risk model in chronic hepatitis B', venue: 'Hepatology',                               if: 13.5, year: 2023, citations: 71 },
    { title: 'PAGE-B and mPAGE-B for HCC risk stratification: a multicenter cohort',          venue: 'J Hepatol',                                if: 26.8, year: 2022, citations: 188 },
    { title: 'Resmetirom for MASH with liver fibrosis',                                       venue: 'N Engl J Med',                             if: 158.5, year: 2024, citations: 240 },
    { title: 'Risk-stratified surveillance for HCC: decision-curve analysis',                 venue: 'J Hepatol',                                if: 26.8, year: 2023, citations: 96 },
  ],
  Gastroenterology: [
    { title: 'Mirikizumab in moderate-to-severe ulcerative colitis',                         venue: 'N Engl J Med', if: 158.5, year: 2023, citations: 380 },
    { title: 'AI-assisted colonoscopy for adenoma detection: a multicenter RCT',             venue: 'Gut',          if: 23.0,  year: 2022, citations: 510 },
  ],
  Surgery: [
    { title: 'Robotic vs laparoscopic gastrectomy: long-term outcomes',                      venue: 'JAMA Surg',    if: 16.9,  year: 2022, citations: 220 },
    { title: 'Enhanced recovery after surgery in colorectal resection',                      venue: 'Ann Surg',     if: 13.7,  year: 2021, citations: 410 },
  ],
  Radiology: [
    { title: 'Deep learning for breast cancer screening: external validation',               venue: 'Lancet Digit Health', if: 36.6, year: 2022, citations: 690 },
    { title: 'Generative AI for radiology report drafting',                                  venue: 'Radiology',           if: 20.6, year: 2024, citations: 130 },
  ],
  default: [
    { title: 'External validation of a clinical prediction model: a multicenter cohort',    venue: 'JAMA Intern Med', if: 36.4,  year: 2022, citations: 280 },
    { title: 'Population-based prospective study of risk factors',                           venue: 'BMJ',             if: 105.7, year: 2021, citations: 420 },
    { title: 'Decision-curve analysis for clinical utility of a prediction model',           venue: 'Ann Intern Med',  if: 51.6,  year: 2023, citations: 190 },
    { title: 'Meta-analysis of randomized trials: methodological review',                    venue: 'BMJ',             if: 105.7, year: 2022, citations: 360 },
  ],
}

// Studies where "validation" is not a meaningful axis — skip the penalty
const NO_VALIDATION_TYPES = new Set([
  'Meta-analysis / systematic review',
  'Randomized controlled trial',
  'Basic / translational',
  'Case-control',
  'Cross-sectional',
])

export function simulate(input) {
  const text = `${input.title} ${input.abstract}`.toLowerCase()
  const tierIndexInput = TIERS.findIndex(t => t.label === input.target)
  const sampleSize = Number(input.sampleSize) || 0
  const validationApplies = !NO_VALIDATION_TYPES.has(input.studyType)

  // novelty 0-25
  let novelty = 9 + score(text, KEYWORDS.novelty) * 3 + score(text, KEYWORDS.ai) * 2
  novelty = Math.min(25, novelty)

  // methods strength 0-25
  let methods = 6 + score(text, KEYWORDS.strength) * 3
  if (/external valid/.test(text)) methods += 4
  if (input.studyType?.includes('Randomized')) methods += 6
  if (input.studyType?.includes('Multicenter')) methods += 3
  if (input.studyType?.includes('Meta-analysis')) methods += 5
  if (input.studyType?.includes('Prospective')) methods += 2
  if (input.multicenter) methods += 2
  if (sampleSize > 5000) methods += 3
  else if (sampleSize > 1000) methods += 2
  methods = Math.min(25, methods)

  // clinical relevance 0-25
  let clinical = 8 + score(text, KEYWORDS.endpoint) * 3
  if (/clinical|decision|surveillance|guideline|management|practice/.test(text)) clinical += 4
  clinical = Math.min(25, clinical)

  // field momentum 0-15
  let momentum = 6 + score(text, KEYWORDS.ai) * 2
  momentum += score(text, ['glp-1', 'semaglutide', 'tirzepatide', 'mrna', 'immunotherapy', 'crispr', 'organoid', 'biomarker']) * 2
  momentum = Math.min(15, momentum)

  // generalizability 0-10
  let gen = 3
  if (input.validation?.includes('External')) gen += 4
  if (input.validation?.includes('≥3')) gen += 2
  if (input.multicenter || input.studyType?.includes('Multicenter')) gen += 2
  if (!validationApplies) gen += 3   // not penalized for not having validation
  gen = Math.min(10, gen)

  // weak penalty (skip if multicenter)
  const weakHits = input.multicenter ? 0 : score(text, KEYWORDS.weak)
  const score100 = clamp(novelty + methods + clinical + momentum + gen - weakHits * 4, 12, 96)

  // tier shift relative to user target (or auto-recommend)
  const baseTierIndex = tierIndexInput >= 0 ? tierIndexInput : pickAutoTier(score100)
  const shift =
    score100 > 80 ? +1 :
    score100 > 65 ? 0 :
    score100 > 45 ? -1 : -2
  const tierIndex = clamp(baseTierIndex + shift, 0, TIERS.length - 1)
  const tier = TIERS[tierIndex]

  const reachGap = baseTierIndex - tierIndex
  const deskPct = clamp(Math.round(70 - score100 * 0.6 + reachGap * 12), 3, 92)

  const peerMedian = Math.round(8 + tier.lo * 2.4 + tier.hi * 0.6)
  const citLo = Math.round(peerMedian * (0.5 + score100 / 250))
  const citHi = Math.round(peerMedian * (1.4 + score100 / 110))
  const percentile = clamp(Math.round(100 - score100 * 0.85), 5, 80)

  const weeks = `${tier.weeksLo}–${tier.weeksHi}`

  const weakness = pickWeakness({
    sampleSize, validation: input.validation, validationApplies,
    studyType: input.studyType, text, multicenter: input.multicenter,
    momentum, gen, novelty, methods, clinical,
  })

  const suggestions = buildSuggestions({ text, input, score100, novelty, gen, clinical, validationApplies, baseTierIndex })

  const similars = pickSimilars(input.field, text).slice(0, 4)
  const journey = buildJourney({ field: input.field, tier, tierIndex, similars })

  return {
    score: Math.round(score100),
    tier: { range: tier.label, bestFit: tier.bestFit, stretch: tier.stretch },
    deskReject: { pct: deskPct, label: deskPct > 60 ? 'High' : deskPct > 35 ? 'Moderate' : 'Low' },
    timeline: { weeks, note: `Typical for ${tier.label} venues in ${(input.field || 'this field').toLowerCase()}` },
    citation: { range: `${citLo}–${citHi}`, percentile, peerMedian },
    weakness,
    suggestions,
    similars,
    journey,
  }
}

// Mock journey: 3-stop sequence, descending tier, with reasoning about
// formatting/checklist overlap. Real algorithm (post-SSD) will use the
// `journal_submission_style` table and pairwise switch costs.
function buildJourney({ field, tier, tierIndex, similars }) {
  const STEPS_BY_FIELD = {
    Cardiology: [
      { venue: 'Circulation',          if: 39.9,  publisher: 'Wolters Kluwer',     style: 'Vancouver / structured abstract' },
      { venue: 'European Heart Journal', if: 39.3, publisher: 'Oxford Univ Press',   style: 'Vancouver / structured abstract' },
      { venue: 'JACC',                  if: 24.0,  publisher: 'Elsevier',           style: 'Vancouver / structured abstract' },
      { venue: 'Heart',                 if: 5.1,   publisher: 'BMJ',                style: 'Vancouver / structured abstract' },
    ],
    Oncology: [
      { venue: 'Lancet Oncology',       if: 51.1,  publisher: 'Elsevier',           style: 'Vancouver / structured abstract' },
      { venue: 'Annals of Oncology',    if: 51.8,  publisher: 'Elsevier',           style: 'Vancouver / structured abstract' },
      { venue: 'JAMA Oncology',         if: 30.8,  publisher: 'AMA',                style: 'AMA / structured abstract' },
      { venue: 'Clinical Cancer Research', if: 11.5, publisher: 'AACR',             style: 'Numbered / structured abstract' },
    ],
    Hepatology: [
      { venue: 'Journal of Hepatology', if: 26.8,  publisher: 'Elsevier',           style: 'Vancouver / structured abstract' },
      { venue: 'Hepatology',            if: 13.5,  publisher: 'Wolters Kluwer',     style: 'Vancouver / structured abstract' },
      { venue: 'Clin Gastroenterol Hepatol', if: 11.6, publisher: 'Elsevier',       style: 'Vancouver / structured abstract' },
      { venue: 'Liver International',   if: 6.7,   publisher: 'Wiley',              style: 'Vancouver / structured abstract' },
    ],
    Endocrinology: [
      { venue: 'Lancet Diabetes Endocrinol', if: 44.0, publisher: 'Elsevier',       style: 'Vancouver / structured abstract' },
      { venue: 'Diabetes Care',         if: 16.2,  publisher: 'ADA',                style: 'Vancouver / structured abstract' },
      { venue: 'JCEM',                  if: 5.8,   publisher: 'Oxford Univ Press',   style: 'Vancouver / structured abstract' },
      { venue: 'Diabetologia',          if: 8.4,   publisher: 'Springer',           style: 'Vancouver / structured abstract' },
    ],
    Neurology: [
      { venue: 'Lancet Neurology',      if: 48.0,  publisher: 'Elsevier',           style: 'Vancouver / structured abstract' },
      { venue: 'JAMA Neurology',        if: 25.0,  publisher: 'AMA',                style: 'AMA / structured abstract' },
      { venue: 'Neurology',             if: 9.9,   publisher: 'Wolters Kluwer',     style: 'Vancouver / structured abstract' },
      { venue: 'Annals of Neurology',   if: 10.6,  publisher: 'Wiley',              style: 'Vancouver / structured abstract' },
    ],
    default: [
      { venue: 'Lancet',                if: 168.9, publisher: 'Elsevier',           style: 'Vancouver / structured abstract' },
      { venue: 'BMJ',                   if: 105.7, publisher: 'BMJ',                style: 'Vancouver / structured abstract' },
      { venue: 'JAMA',                  if: 120.7, publisher: 'AMA',                style: 'AMA / structured abstract' },
      { venue: 'JAMA Internal Medicine', if: 36.4, publisher: 'AMA',                style: 'AMA / structured abstract' },
    ],
  }
  const pool = STEPS_BY_FIELD[field] || STEPS_BY_FIELD.default
  // Pick a start journal near the user's tier, then descend; assemble 3 steps
  // and tag each transition with a switch-cost label.
  const sorted = [...pool].sort((a, b) => b.if - a.if)
  // For each step, mark switch-cost vs previous (lower if same publisher or style)
  return sorted.slice(0, 3).map((step, i, arr) => {
    const prev = arr[i - 1]
    let switchCost = i === 0 ? 'first submission' : 'low'
    let switchReason = i === 0 ? 'highest-impact target in scope' : ''
    if (prev) {
      const samePub = prev.publisher === step.publisher
      const sameStyle = prev.style === step.style
      if (samePub && sameStyle) { switchCost = 'minimal'; switchReason = 'same publisher · same reference style — almost no rework' }
      else if (sameStyle) { switchCost = 'low'; switchReason = 'shared structured-abstract format and reference style' }
      else if (samePub) { switchCost = 'low'; switchReason = 'same publisher — submission system carries over' }
      else { switchCost = 'medium'; switchReason = `switch reference style to ${step.style.split(' ')[0]}` }
    }
    return {
      step: i + 1,
      venue: step.venue,
      if: step.if,
      publisher: step.publisher,
      style: step.style,
      switchCost,
      switchReason,
    }
  })
}

function score(text, words) {
  let s = 0
  for (const w of words) if (text.includes(w)) s++
  return s
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }

function pickAutoTier(score100) {
  if (score100 >= 82) return 4
  if (score100 >= 70) return 3
  if (score100 >= 55) return 2
  if (score100 >= 38) return 1
  return 0
}

function pickWeakness({ sampleSize, validation, validationApplies, studyType, text, multicenter, momentum, gen, methods, clinical, novelty }) {
  if (validationApplies && (validation === 'Internal only' || validation === 'None' || !validation || validation === 'Auto-detect')) {
    return 'No external validation detected. For prediction/risk models, reviewers at top journals treat this as the single biggest gap. Even a small external cohort dramatically improves acceptance odds.'
  }
  if (sampleSize && sampleSize < 500 && !studyType?.includes('Basic'))
    return `Sample size (${sampleSize.toLocaleString()}) is modest for the claim. Consider pooling with a registry or framing as a feasibility/discovery study.`
  if (studyType?.includes('Retrospective') && !multicenter && !studyType?.includes('Multicenter'))
    return 'Single-center retrospective design limits generalizability. Pre-registering the analysis or adding a second site can lift tier by ~1 step.'
  if (gen < 6)
    return 'Generalizability is the bottleneck — population, setting, or workflow appears narrow. Frame applicability explicitly in the discussion.'
  if (momentum < 8)
    return 'Topic momentum is moderate in the recent literature. Connect the work to an active controversy or guideline gap to lift early citation velocity.'
  if (clinical < 14)
    return 'Clinical relevance is implied but not operationalized. Add a decision-curve or net-benefit analysis to convert the result into actionable guidance.'
  if (novelty < 13)
    return 'Novelty signal in the abstract is faint. Lead with what the field could not do before this paper.'
  return 'Methodological reporting could be tightened (CONSORT/STROBE/TRIPOD as applicable). Most reviewer pushback on comparable work clusters here.'
}

function buildSuggestions({ text, input, score100, novelty, gen, clinical, validationApplies, baseTierIndex }) {
  const out = []
  if (novelty < 16)
    out.push('Rewrite the first sentence of the abstract to lead with the gap your paper closes — not the disease background.')
  if (validationApplies && !/external valid/.test(text) && input.validation === 'Internal only')
    out.push('If any external cohort exists (even small, even partial), surface it in the methods abstract line — it materially lifts tier.')
  if (clinical < 18)
    out.push('Add one sentence quantifying clinical decision impact: "would change management in X% of patients."')
  if (gen < 7)
    out.push('Explicitly state population, setting, and applicability constraints — top journals reward honesty about scope.')
  if (!/decision|net benefit|surveillance|guideline|management/.test(text))
    out.push('Frame the endpoint as a clinical action (e.g., "personalized surveillance interval", "earlier escalation") rather than a purely statistical event.')
  if (score100 < 60 && baseTierIndex > 1) {
    out.push(`Your target is a reach. Realistic best-fit is ${TIERS[baseTierIndex - 1].bestFit}.`)
  }
  if (out.length === 0)
    out.push('The abstract is well-positioned. Tighten the title to a single strong noun phrase that captures the contribution.')
  return out.slice(0, 5)
}

function pickSimilars(field, text) {
  const pool = SIMILARS_BY_FIELD[field] || SIMILARS_BY_FIELD.default
  // For demo: trivial deterministic ranking by keyword overlap within field pool.
  const tokens = text.split(/\W+/).filter(w => w.length > 4)
  const scored = pool.map(p => {
    const t = (p.title + ' ' + p.venue).toLowerCase()
    let s = 0
    for (const w of tokens) if (t.includes(w)) s++
    return { ...p, _s: s }
  })
  scored.sort((a, b) => b._s - a._s)
  return scored
}
