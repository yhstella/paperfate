// Auto-extract structured metadata from raw manuscript text (abstract or full).
// Heuristic / regex layer — replaced later by a small LLM call. Designed so the
// simulator can run on text-only input and only surface a "Correct anything?" UI
// for fields it could not confidently detect.

// Each detector returns { value, confidence: 0..1, evidence: string }

const N_PATTERNS = [
  // n = 1,234 / N=1234 / (n = 1234)
  /\b[nN]\s*=\s*([\d,]{2,})\b/g,
  // 1,234 patients / 1234 participants / 1234 subjects / 1234 individuals
  /\b([\d,]{2,})\s+(patients|participants|subjects|individuals|adults|children|women|men|cases|controls)\b/gi,
  // a cohort of 1,234
  /\bcohort of\s+([\d,]{2,})\b/gi,
  // total of 1,234 / enrolled 1,234
  /\b(?:total of|enrolled|included|recruited|analyzed|analysed)\s+([\d,]{2,})\b/gi,
]

export function extractSampleSize(text) {
  if (!text) return null
  const counts = []
  for (const re of N_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1].replace(/,/g, ''))
      if (n >= 10 && n <= 100_000_000) {
        counts.push({ n, ctx: text.slice(Math.max(0, m.index - 30), m.index + 50) })
      }
    }
  }
  if (counts.length === 0) return null
  // Heuristic: take the largest plausible number — usually the total enrolled
  counts.sort((a, b) => b.n - a.n)
  const top = counts[0]
  return {
    value: top.n,
    confidence: counts.length >= 2 ? 0.85 : 0.65,
    evidence: top.ctx.trim(),
  }
}

const STUDY_TYPE_RULES = [
  { type: 'Meta-analysis / systematic review', patterns: [/\bmeta[- ]?analysis\b/i, /\bsystematic review\b/i], score: 3 },
  { type: 'Randomized controlled trial',       patterns: [/\brandomi[sz]ed\b/i, /\bRCT\b/, /\bdouble[- ]blind\b/i, /\bplacebo[- ]controlled\b/i], score: 3 },
  { type: 'Multicenter retrospective cohort',  patterns: [/\bmulti[- ]?cent(re|er)\b/i, /\bretrospective\b/i], score: 2, both: true },
  { type: 'Prospective cohort',                patterns: [/\bprospective(ly)?\b/i, /\bcohort\b/i], score: 2, both: true },
  { type: 'Retrospective cohort',              patterns: [/\bretrospective(ly)?\b/i], score: 1 },
  { type: 'Case-control',                      patterns: [/\bcase[- ]?control\b/i], score: 2 },
  { type: 'Cross-sectional',                   patterns: [/\bcross[- ]?sectional\b/i], score: 2 },
  { type: 'Modeling / AI',                     patterns: [/\b(deep learning|machine learning|neural network|transformer|foundation model)\b/i, /\b(prediction model|risk model|nomogram)\b/i], score: 2 },
  { type: 'Basic / translational',             patterns: [/\b(in vitro|in vivo|mouse|murine|knockout|transgenic|organoid)\b/i], score: 2 },
]

export function extractStudyType(text) {
  if (!text) return null
  let best = null
  for (const rule of STUDY_TYPE_RULES) {
    const hits = rule.patterns.filter(p => p.test(text)).length
    if (hits === 0) continue
    if (rule.both && hits < rule.patterns.length) continue
    if (!best || hits > best.hits) best = { type: rule.type, hits, score: rule.score }
  }
  if (!best) return null
  return {
    value: best.type,
    confidence: Math.min(0.95, 0.45 + best.hits * 0.2 + best.score * 0.05),
    evidence: '',
  }
}

const VALIDATION_RULES = [
  { value: 'External (≥3 cohorts)', re: /\bthree\s+(?:independent\s+)?(?:external\s+)?cohorts?\b/i },
  { value: 'External (2 cohorts)',  re: /\btwo\s+(?:independent\s+)?(?:external\s+)?cohorts?\b/i },
  { value: 'External (≥3 cohorts)', re: /\b3\s+(?:independent\s+)?(?:external\s+)?cohorts?\b/i },
  { value: 'External (2 cohorts)',  re: /\b2\s+(?:independent\s+)?(?:external\s+)?cohorts?\b/i },
  { value: 'External (1 cohort)',   re: /\bexternal(ly)?\s+valid/i },
  { value: 'External (1 cohort)',   re: /\bvalidat\w+\s+in\s+(?:an?\s+)?(?:independent|external)\b/i },
  { value: 'Internal only',         re: /\binternal valid|cross[- ]?validation|bootstrap/i },
]

export function extractValidation(text) {
  if (!text) return null
  for (const r of VALIDATION_RULES) {
    if (r.re.test(text)) return { value: r.value, confidence: 0.8, evidence: '' }
  }
  return null
}

// Field detection — broad and balanced, not biased to one specialty.
const FIELD_RULES = [
  { value: 'Oncology',          terms: ['cancer','tumor','tumour','carcinoma','chemotherapy','immunotherapy','metastas','oncolog','sarcoma','leukemi','lymphoma'] },
  { value: 'Cardiology',        terms: ['cardiac','cardiovascul','myocardial','coronary','heart failure','atrial fibrillation','arrhythmi','stent','statin'] },
  { value: 'Neurology',         terms: ['stroke','dement','alzheim','parkinson','multiple sclerosis','epilep','migraine','neurolog'] },
  { value: 'Endocrinology',     terms: ['diabetes','glucose','insulin','glp-1','thyroid','obesity','metabolic syndrome','endocrin'] },
  { value: 'Pulmonology',       terms: ['copd','asthma','pulmonary','pneumoni','tuberculos','respiratory'] },
  { value: 'Gastroenterology',  terms: ['gastric','colitis','ibd','crohn','colonoscopy','endoscop','gastrointestinal','pancreati'] },
  { value: 'Hepatology',        terms: ['hepatic','liver','hepatocellular','hcc','cirrho','hepatitis','nafld','masld','fibroscan'] },
  { value: 'Infectious disease',terms: ['hiv','sars-cov','covid-19','antibiotic','sepsis','infection','vaccin','antimicrob'] },
  { value: 'Nephrology',        terms: ['renal','kidney','dialysis','ckd','glomerul','nephro'] },
  { value: 'Rheumatology',      terms: ['rheumat','lupus','sle','arthritis','autoimmun','psoriasis'] },
  { value: 'Psychiatry',        terms: ['depress','schizophren','bipolar','anxiety','psychiat','antidepress'] },
  { value: 'Surgery',           terms: ['surger','surgical','laparoscop','perioperat','postoperat','resection'] },
  { value: 'Radiology',         terms: ['mri','ct scan','radiomic','ultrasound','imaging','radiolog','pet/ct'] },
  { value: 'Pediatrics',        terms: ['pediatric','paediatric','neonat','infant','adolescen','children with'] },
  { value: 'Public health',     terms: ['epidemiolog','public health','population-based','national registry','prevalence','incidence rate'] },
  { value: 'Basic / translational', terms: ['in vitro','in vivo','mouse','murine','knockout','organoid','transcriptom','single-cell'] },
]

export function extractField(text) {
  if (!text) return null
  const t = text.toLowerCase()
  const scored = FIELD_RULES.map(rule => ({
    value: rule.value,
    hits: rule.terms.filter(term => t.includes(term)).length,
  })).filter(r => r.hits > 0).sort((a, b) => b.hits - a.hits)
  if (scored.length === 0) return null
  const top = scored[0]
  return {
    value: top.value,
    confidence: Math.min(0.95, 0.45 + top.hits * 0.12),
    evidence: '',
  }
}

// Multicenter flag (separate from study-type detection)
export function extractMulticenter(text) {
  if (!text) return null
  if (/\bmulti[- ]?cent(re|er)\b/i.test(text)) {
    const m = text.match(/\b(\d{1,2})\s+(?:tertiary\s+)?(?:medical\s+)?cent(?:re|er)s\b/i)
    return { value: true, count: m ? Number(m[1]) : null, confidence: 0.9, evidence: '' }
  }
  return null
}

// Endpoint hint — used by suggestion engine, not a form field
export function extractEndpointHint(text) {
  if (!text) return null
  const hits = []
  const map = {
    'overall survival': /\boverall survival\b/i,
    'disease-free survival': /\b(disease|recurrence)[- ]free survival\b/i,
    'progression-free survival': /\bprogression[- ]free survival\b/i,
    'mortality': /\b(all[- ]cause )?mortality\b/i,
    'hospitalization': /\bhospitali[sz]ation\b/i,
    'incidence': /\bincidence\b/i,
    'cardiovascular events': /\b(MACE|cardiovascular events)\b/i,
    'AUC / discrimination': /\b(AUROC|AUC|c-index|c-statistic|concordance)\b/i,
    'net benefit': /\b(net benefit|decision curve)\b/i,
  }
  for (const [name, re] of Object.entries(map)) {
    if (re.test(text)) hits.push(name)
  }
  return hits.length ? { value: hits, confidence: 0.8 } : null
}

// One-shot wrapper — call this once and pass the result to the simulator.
export function extractAll(text) {
  return {
    sampleSize:  extractSampleSize(text),
    studyType:   extractStudyType(text),
    validation:  extractValidation(text),
    field:       extractField(text),
    multicenter: extractMulticenter(text),
    endpoints:   extractEndpointHint(text),
  }
}
