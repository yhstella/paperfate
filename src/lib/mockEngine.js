// FateCore-v0.1 mock engine
// Pure-frontend heuristic so the UX feels alive before the real backend lands.
// Replace each scoring branch with the OpenAlex/Semantic Scholar pipeline output.

const KEYWORDS = {
  novelty: ['novel', 'first', 'unprecedented', 'breakthrough', 'discover'],
  strength: ['multicenter', 'external valid', 'prospective', 'randomi', 'meta-analysis', 'cohort', 'longitudinal'],
  ai: ['deep learning', 'machine learning', 'neural', 'transformer', 'foundation model', 'large language'],
  endpoint: ['mortality', 'survival', 'hcc', 'cancer', 'incidence', 'hospitalization'],
  weak: ['single-center', 'pilot', 'preliminary', 'small sample'],
}

const TIERS = [
  { label: 'IF <5',         lo: 1,  hi: 4,  bestFit: 'Specialty journal',                stretch: 'Mid-tier subspecialty',     weeksLo: 4,  weeksHi: 8  },
  { label: 'IF 5–10',       lo: 5,  hi: 10, bestFit: 'Q1 subspecialty journal',          stretch: 'Top subspecialty',          weeksLo: 6,  weeksHi: 12 },
  { label: 'IF 10–15',      lo: 10, hi: 15, bestFit: 'Top subspecialty (e.g., Hepatology)', stretch: 'General medicine (e.g., Lancet RM)', weeksLo: 8,  weeksHi: 14 },
  { label: 'IF 15–25',      lo: 15, hi: 25, bestFit: 'General medicine',                 stretch: 'NEJM / Lancet / JAMA',       weeksLo: 10, weeksHi: 18 },
  { label: 'IF >25 (top)',  lo: 25, hi: 70, bestFit: 'NEJM / Lancet / JAMA',             stretch: 'Top-of-field',               weeksLo: 12, weeksHi: 22 },
]

const SAMPLE_SIMILARS = [
  { title: 'External validation of a deep-learning HCC risk model in chronic hepatitis B', venue: 'Hepatology',                       if: 13.5, year: 2023, citations: 71 },
  { title: 'PAGE-B and mPAGE-B for HCC risk stratification: a multicenter cohort',          venue: 'J Hepatology',                     if: 26.8, year: 2022, citations: 188 },
  { title: 'Machine learning surveillance strategies in chronic liver disease',             venue: 'Clinical Gastroenterology and Hepatology', if: 11.2, year: 2024, citations: 24 },
  { title: 'Liver stiffness and HCC incidence in NAFLD: a prospective study',               venue: 'Gut',                              if: 23.0, year: 2021, citations: 142 },
  { title: 'Risk-stratified surveillance for HCC: decision-curve analysis',                 venue: 'Journal of Hepatology',            if: 26.8, year: 2023, citations: 96 },
]

export function simulate(input) {
  const text = `${input.title} ${input.abstract}`.toLowerCase()
  const tierIndexInput = TIERS.findIndex(t => t.label === input.target)
  const sampleSize = Number(input.sampleSize) || 0

  // novelty 0-25
  let novelty = 9 + score(text, KEYWORDS.novelty) * 3 + score(text, KEYWORDS.ai) * 2
  novelty = Math.min(25, novelty)

  // methods strength 0-25
  let methods = 6 + score(text, KEYWORDS.strength) * 3
  if (/external valid/.test(text)) methods += 4
  if (input.studyType.includes('RCT')) methods += 5
  if (input.studyType.includes('Multicenter')) methods += 3
  if (input.studyType.includes('Meta-analysis')) methods += 4
  if (input.studyType.includes('Prospective')) methods += 2
  if (sampleSize > 5000) methods += 3
  else if (sampleSize > 1000) methods += 2
  methods = Math.min(25, methods)

  // clinical relevance 0-25
  let clinical = 8 + score(text, KEYWORDS.endpoint) * 3
  if (/clinical|decision|surveillance|guideline/.test(text)) clinical += 4
  clinical = Math.min(25, clinical)

  // field momentum 0-15
  let momentum = 6 + score(text, KEYWORDS.ai) * 2 + score(text, ['biomarker','organoid','glp-1','immunotherapy']) * 2
  momentum = Math.min(15, momentum)

  // generalizability 0-10
  let gen = 3
  if (input.validation.includes('External')) gen += 4
  if (input.validation.includes('≥3')) gen += 2
  if (input.studyType.includes('Multicenter')) gen += 2
  gen = Math.min(10, gen)

  // weak penalty
  const weakHits = score(text, KEYWORDS.weak)
  const score100 = clamp(novelty + methods + clinical + momentum + gen - weakHits * 4, 12, 96)

  // tier shift relative to user target
  const shift =
    score100 > 80 ? +1 :
    score100 > 65 ? 0 :
    score100 > 45 ? -1 : -2
  const tierIndex = clamp((tierIndexInput >= 0 ? tierIndexInput : 1) + shift, 0, TIERS.length - 1)
  const tier = TIERS[tierIndex]

  // desk reject inversely related to score, modulated by target reach
  const reachGap = (tierIndexInput >= 0 ? tierIndexInput : 1) - tierIndex
  const deskPct = clamp(Math.round(70 - score100 * 0.6 + reachGap * 12), 3, 92)

  // citations: peer median tied to tier, range to score
  const peerMedian = Math.round(8 + tier.lo * 2.4 + tier.hi * 0.6)
  const citLo = Math.round(peerMedian * (0.5 + score100 / 250))
  const citHi = Math.round(peerMedian * (1.4 + score100 / 110))
  const percentile = clamp(Math.round(100 - score100 * 0.85), 5, 80)

  // timeline
  const weeks = `${tier.weeksLo}–${tier.weeksHi}`

  // weakness pick
  const weakness = pickWeakness({
    sampleSize, validation: input.validation, studyType: input.studyType,
    text, momentum, gen, novelty, methods, clinical,
  })

  // suggestions: rule-based, fairly grounded
  const suggestions = buildSuggestions({ text, input, score100, novelty, gen, clinical })

  // similars: pick 3 by simple keyword overlap (deterministic, demo-grade)
  const similars = rankSimilars(text).slice(0, 4)

  return {
    score: Math.round(score100),
    tier: { range: tier.label, bestFit: tier.bestFit, stretch: tier.stretch },
    deskReject: { pct: deskPct, label: deskPct > 60 ? 'High' : deskPct > 35 ? 'Moderate' : 'Low' },
    timeline: { weeks, note: `Typical for ${tier.label} venues in ${input.field.toLowerCase()}` },
    citation: { range: `${citLo}–${citHi}`, percentile, peerMedian },
    weakness,
    suggestions,
    similars,
  }
}

function score(text, words) {
  let s = 0
  for (const w of words) if (text.includes(w)) s++
  return s
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }

function pickWeakness({ sampleSize, validation, studyType, text, momentum, gen, methods, clinical, novelty }) {
  if (validation === 'Internal only' || validation === 'None')
    return 'No external validation. Reviewers at top journals will treat this as the single biggest gap — even a small external cohort dramatically improves acceptance odds.'
  if (sampleSize && sampleSize < 500)
    return `Sample size (${sampleSize}) is modest for the claim. Consider pooling with a registry or framing as a feasibility/discovery study.`
  if (studyType.includes('Retrospective') && !studyType.includes('Multicenter'))
    return 'Single-center retrospective design limits generalizability. Pre-register the analysis or add a second center to lift tier by ~1 step.'
  if (gen < 6)
    return 'Generalizability is the bottleneck — population, setting, or workflow appears narrow. Frame applicability explicitly in the discussion.'
  if (momentum < 8)
    return 'Topic momentum is moderate. Connect the work to an active controversy or guideline gap to lift early citation velocity.'
  if (clinical < 14)
    return 'Clinical relevance is implied but not operationalized. Add a decision-curve or net-benefit analysis to convert the result into actionable guidance.'
  if (novelty < 13)
    return 'Novelty signal in the abstract is faint. Lead with what the field could not do before this paper.'
  return 'Methodological reporting could be tightened (TRIPOD/STARD/CONSORT items). Most reviewer pushback on comparable work clusters here.'
}

function buildSuggestions({ text, input, score100, novelty, gen, clinical }) {
  const out = []
  if (novelty < 16)
    out.push('Rewrite the first sentence of the abstract to lead with the gap your paper closes — not the disease background.')
  if (!/external valid/.test(text) && input.validation === 'Internal only')
    out.push('If any external cohort exists (even small, even partial), surface it in the methods abstract line — it materially lifts tier.')
  if (clinical < 18)
    out.push('Add one sentence quantifying clinical decision impact: "would change management in X% of patients."')
  if (gen < 7)
    out.push('Explicitly state population, setting, and applicability constraints — top journals reward honesty about scope.')
  if (!/decision|net benefit|surveillance|guideline/.test(text))
    out.push('Frame the endpoint as a clinical action (e.g., "personalized surveillance interval") rather than a statistical event.')
  if (score100 < 60)
    out.push(`Your target (${input.target}) is a reach. Realistic best-fit is ${TIERS[Math.max(0, (TIERS.findIndex(t => t.label === input.target)) - 1)].bestFit}.`)
  if (out.length === 0)
    out.push('The abstract is well-positioned. Optimize title for one strong noun phrase that captures the contribution.')
  return out.slice(0, 5)
}

function rankSimilars(text) {
  // Trivial deterministic ranking for demo.
  const scored = SAMPLE_SIMILARS.map(p => {
    const t = (p.title + ' ' + p.venue).toLowerCase()
    let s = 0
    for (const w of ['hcc','hepatitis','liver','validation','model','deep','surveillance','cohort']) {
      if (text.includes(w) && t.includes(w)) s++
    }
    return { ...p, _s: s }
  })
  scored.sort((a, b) => b._s - a._s)
  return scored
}
