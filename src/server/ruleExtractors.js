// PaperFate · Rule-mode extractors for hybrid Q500 items
// Deterministic regex parsing — cheap, reproducible, called BEFORE the LLM
// for any item with mode === 'hybrid' (or 'rule'). If a rule returns null,
// the extract.js pipeline falls back to LLM scoring.
//
// Each extractor returns either null (no signal) or:
//   {
//     value,            // extracted value (number, string, boolean, or {...})
//     evidence_text,    // the verbatim span (≤80 chars)
//     evidence_section, // best guess section (informal)
//     confidence,       // 0..1
//   }
//
// Each extractor accepts the same input shape as the LLM:
//   manuscript = { title, abstract, methods?, results?, discussion?, full_text? }
// Section attribution is best-effort using simple section heuristics; callers
// can refine with explicit section text.

const SECTIONS = ['title', 'abstract', 'methods', 'results', 'discussion', 'full_text']

function joined(m) {
  return SECTIONS.map(s => m?.[s] || '').filter(Boolean).join('\n\n')
}

// Locate which named section a match index falls into.
function sectionAt(m, idx) {
  let cursor = 0
  for (const s of SECTIONS) {
    const len = (m?.[s] || '').length
    if (!len) continue
    if (idx < cursor + len) return s
    cursor += len + 2 // joined separator
  }
  return 'unknown'
}

function snippet(text, idx, len, span = 80) {
  const start = Math.max(0, idx - 20)
  const end   = Math.min(text.length, idx + len + 40)
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, span)
}

// ────────────────────────────────────────────────────────────────────────────
// SAMPLE SIZE  (item: any "sample size" / "Adequate for primary" probes)
// ────────────────────────────────────────────────────────────────────────────
const SAMPLE_SIZE_PATTERNS = [
  /\b[nN]\s*=\s*([\d,]{2,})\b/g,
  /\b([\d,]{2,})\s+(?:patients|participants|subjects|individuals|adults|children|women|men|cases|controls)\b/gi,
  /\bcohort of\s+([\d,]{2,})\b/gi,
  /\b(?:total of|enrolled|included|recruited|analyzed|analysed)\s+([\d,]{2,})\b/gi,
]
export function extractSampleSize(m) {
  const text = joined(m)
  const candidates = []
  for (const re of SAMPLE_SIZE_PATTERNS) {
    re.lastIndex = 0
    let mm
    while ((mm = re.exec(text)) !== null) {
      const n = Number(mm[1].replace(/,/g, ''))
      if (n >= 10 && n <= 100_000_000) {
        candidates.push({ n, idx: mm.index, raw: mm[0] })
      }
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.n - a.n)
  const top = candidates[0]
  return {
    value: top.n,
    evidence_text: snippet(text, top.idx, top.raw.length),
    evidence_section: sectionAt(m, top.idx),
    confidence: candidates.length >= 2 ? 0.9 : 0.7,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// AUROC / c-index
// ────────────────────────────────────────────────────────────────────────────
// Matches: AUROC 0.82, AUC = 0.872, c-statistic 0.91, c-index of 0.78
const AUC_RE = /\b(?:AUROC|AUC|c[-\s]?(?:index|statistic)|concordance(?:[-\s]index)?)[^.\n]{0,40}?(0?\.\d{2,4})\b/gi
export function extractAUC(m) {
  const text = joined(m)
  AUC_RE.lastIndex = 0
  const out = []
  let mm
  while ((mm = AUC_RE.exec(text)) !== null) {
    const v = Number(mm[1])
    if (v > 0.5 && v <= 1.0) out.push({ v, idx: mm.index, raw: mm[0] })
  }
  if (out.length === 0) return null
  const best = out.sort((a, b) => b.v - a.v)[0]
  return {
    value: best.v,
    evidence_text: snippet(text, best.idx, best.raw.length),
    evidence_section: sectionAt(m, best.idx),
    confidence: 0.9,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 95% CI presence (returns boolean + first instance)
// ────────────────────────────────────────────────────────────────────────────
const CI_RE = /\b(?:95\s*%\s*(?:CI|confidence\s*interval)|CI[:\s]*\(?[\d.]+[‐-―−\-]\s*[\d.]+)\b/i
export function extractCIPresence(m) {
  const text = joined(m)
  const mm = text.match(CI_RE)
  if (!mm) return null
  return {
    value: true,
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.95,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Exact p-values (vs. p<0.05 reporting)
// ────────────────────────────────────────────────────────────────────────────
// Match exact: P = 0.003, P=0.0001, p < 0.001 (last is conservative — counts)
const P_EXACT_RE  = /\b[Pp]\s*[=<>]\s*0?\.\d+\b/g
const P_THRESH_RE = /\b[Pp]\s*<\s*0?\.0?5\b/g  // p<0.05 only
export function extractPValueExact(m) {
  const text = joined(m)
  P_EXACT_RE.lastIndex = 0
  P_THRESH_RE.lastIndex = 0
  const allExact     = [...text.matchAll(P_EXACT_RE)]
  const threshOnly   = [...text.matchAll(P_THRESH_RE)]
  // "exact" = at least one non-threshold p
  const exactish = allExact.filter(mm => !/\b[Pp]\s*<\s*0?\.0?5\b/.test(mm[0]))
  if (allExact.length === 0) return null
  const first = exactish[0] || allExact[0]
  return {
    value: { exact_count: exactish.length, threshold_only_count: threshOnly.length, total: allExact.length },
    evidence_text: snippet(text, first.index, first[0].length),
    evidence_section: sectionAt(m, first.index),
    confidence: 0.9,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Trial registry IDs (NCT, ISRCTN, PROSPERO, OSF, EudraCT, ChiCTR, jRCT)
// ────────────────────────────────────────────────────────────────────────────
const REGISTRY_REs = [
  { re: /\bNCT\d{8}\b/g,              kind: 'ClinicalTrials.gov' },
  { re: /\bISRCTN\d{6,8}\b/g,         kind: 'ISRCTN' },
  { re: /\b(?:PROSPERO\s*)?CRD\d{8,12}\b/g, kind: 'PROSPERO' },
  { re: /\bosf\.io\/[a-z0-9]{4,8}\b/gi, kind: 'OSF' },
  { re: /\b\d{4}-\d{6}-\d{2}\b/g,     kind: 'EudraCT' },
  { re: /\bChiCTR-?[A-Z]{2,3}-?\d{6,10}\b/gi, kind: 'ChiCTR' },
  { re: /\bjRCTs?\d{9,10}\b/g,        kind: 'jRCT' },
  { re: /\bUMIN\d{9}\b/g,             kind: 'UMIN-CTR' },
]
export function extractRegistry(m) {
  const text = joined(m)
  for (const { re, kind } of REGISTRY_REs) {
    re.lastIndex = 0
    const mm = re.exec(text)
    if (mm) {
      return {
        value: { id: mm[0], registry: kind },
        evidence_text: snippet(text, mm.index, mm[0].length),
        evidence_section: sectionAt(m, mm.index),
        confidence: 0.98,
      }
    }
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// Kappa / ICC for inter-rater reliability
// ────────────────────────────────────────────────────────────────────────────
const KAPPA_RE = /\b(?:Cohen[''']?s\s*)?(?:[κk]appa|κ)\s*[=:]\s*(0?\.\d{2,3})\b/gi
const ICC_RE   = /\bICC\s*[=:]?\s*(0?\.\d{2,3})\b/gi
export function extractAgreement(m) {
  const text = joined(m)
  KAPPA_RE.lastIndex = 0
  ICC_RE.lastIndex = 0
  const k = KAPPA_RE.exec(text)
  if (k) {
    return {
      value: { metric: 'kappa', value: Number(k[1]) },
      evidence_text: snippet(text, k.index, k[0].length),
      evidence_section: sectionAt(m, k.index),
      confidence: 0.92,
    }
  }
  const i = ICC_RE.exec(text)
  if (i) {
    return {
      value: { metric: 'ICC', value: Number(i[1]) },
      evidence_text: snippet(text, i.index, i[0].length),
      evidence_section: sectionAt(m, i.index),
      confidence: 0.92,
    }
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// Follow-up duration
// ────────────────────────────────────────────────────────────────────────────
const FU_RE = /\b(?:median|mean|average)\s+follow[-\s]?up(?:\s+of)?\s+(?:was\s+)?(\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?|yr|mo)\b/i
const FU_ALT = /\bfollow[-\s]?up\s+(?:was\s+)?(?:from\s+\d+[-\s]?to[-\s]?\d+|of\s+\d+(?:\.\d+)?)\s*(years?|months?|weeks?)\b/i
export function extractFollowUp(m) {
  const text = joined(m)
  const mm = text.match(FU_RE) || text.match(FU_ALT)
  if (!mm) return null
  return {
    value: { raw: mm[0], unit: mm[2] || '' },
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.85,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Multicenter detection (number of centers / multi-country)
// ────────────────────────────────────────────────────────────────────────────
const MULTI_RE = /\b(?:multi[-\s]?cent(?:re|er)|(\d{1,2})\s+(?:tertiary\s+)?(?:medical\s+)?cent(?:re|er)s|across\s+(\d{1,2})\s+(?:countries|hospitals|sites))\b/i
export function extractMulticenter(m) {
  const text = joined(m)
  const mm = text.match(MULTI_RE)
  if (!mm) return null
  const count = Number(mm[1] || mm[2]) || null
  return {
    value: { multicenter: true, count },
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.9,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CONSORT/STROBE/TRIPOD/PRISMA/STARD guideline mention
// ────────────────────────────────────────────────────────────────────────────
const GUIDELINE_RE = /\b(CONSORT(?:-AI)?|STROBE|TRIPOD(?:-AI)?|PRISMA(?:[-\s]\d{4})?|STARD|PROBAST|ROBINS-?I|ARRIVE|CHEERS|CLAIM|MI-CLAIM|SPIRIT|AMSTAR(?:-?2)?|SAGER|RECORD)\b/gi
export function extractGuidelineMention(m) {
  const text = joined(m)
  GUIDELINE_RE.lastIndex = 0
  const out = new Set()
  let mm
  while ((mm = GUIDELINE_RE.exec(text)) !== null) {
    out.add(mm[1].toUpperCase().replace(/-?2$/, '-2'))
  }
  if (out.size === 0) return null
  const first = text.match(GUIDELINE_RE)
  return {
    value: [...out],
    evidence_text: snippet(text, text.indexOf(first[0]), first[0].length),
    evidence_section: sectionAt(m, text.indexOf(first[0])),
    confidence: 0.95,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Software / version
// ────────────────────────────────────────────────────────────────────────────
const SOFTWARE_RES = [
  /\b(R)\s+(?:version\s+)?(\d+\.\d+(?:\.\d+)?)\b/i,
  /\b(R)\s+(\d+\.\d+(?:\.\d+)?)\s+\(/i,
  /\b(Python)\s+(\d+\.\d+(?:\.\d+)?)\b/i,
  /\b(Stata)\s*\/?(?:SE|MP|IC)?\s+(\d+(?:\.\d+)?)\b/i,
  /\b(SAS)\s+(?:version\s+)?(\d+(?:\.\d+)?)\b/i,
  /\b(SPSS)\s+(?:version\s+|v)?(\d+(?:\.\d+)?)\b/i,
  /\b(MATLAB)\s+(?:version\s+|R)?([\d.]+[a-z]?)\b/i,
  /\b(PyTorch|TensorFlow|Keras|scikit[-\s]?learn|sklearn)\s+(\d+(?:\.\d+)?(?:\.\d+)?)\b/i,
]
export function extractSoftware(m) {
  const text = joined(m)
  const found = []
  for (const re of SOFTWARE_RES) {
    const mm = text.match(re)
    if (mm) found.push({ name: mm[1], version: mm[2], idx: mm.index, raw: mm[0] })
  }
  if (found.length === 0) return null
  return {
    value: found.map(f => ({ name: f.name, version: f.version })),
    evidence_text: snippet(text, found[0].idx, found[0].raw.length),
    evidence_section: sectionAt(m, found[0].idx),
    confidence: 0.9,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Ethics / IRB approval
// ────────────────────────────────────────────────────────────────────────────
const ETHICS_RE = /\b(?:(?:IRB|ethics?\s*(?:committee|board)|institutional\s+review\s+board)\s+(?:approval|approved|review)|approved\s+by\s+the\s+(?:IRB|ethics?\s*(?:committee|board)|institutional\s+review\s+board))\b/i
const ETHICS_NUM_RE = /\b(?:IRB|approval|protocol)[\s:#]+(\w{2,6}[-\s/]?\d{2,6}[-\s/]?\d{0,6})\b/i
export function extractEthics(m) {
  const text = joined(m)
  const mm = text.match(ETHICS_RE)
  if (!mm) return null
  const num = text.match(ETHICS_NUM_RE)
  return {
    value: { has_statement: true, number: num ? num[1] : null },
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.85,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// External validation phrase
// ────────────────────────────────────────────────────────────────────────────
const EXTERNAL_VALID_RE = /\bexternal(?:ly)?\s+valid(?:ated|ation)\b|\bvalidat(?:ed|ion)\s+in\s+(?:an?\s+)?(?:independent|external|separate)\s+(?:cohort|dataset|sample|population)/i
export function extractExternalValidation(m) {
  const text = joined(m)
  const mm = text.match(EXTERNAL_VALID_RE)
  if (!mm) return null
  // Try to count cohorts
  const cohortCount = text.match(/\b(?:two|three|2|3)\s+(?:independent|external)\s+cohorts?\b/i)
  return {
    value: { external: true, cohorts: cohortCount ? cohortCount[0] : 'unspecified' },
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.9,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Decision curve analysis / net benefit
// ────────────────────────────────────────────────────────────────────────────
const DCA_RE = /\b(?:decision\s+curve\s+analysis|net\s+benefit|DCA)\b/i
export function extractDCA(m) {
  const text = joined(m)
  const mm = text.match(DCA_RE)
  if (!mm) return null
  return {
    value: true,
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.95,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Funding / grant number
// ────────────────────────────────────────────────────────────────────────────
const FUNDING_RE = /\b(?:funded\s+by|funding\s+from|grant\s+(?:no\.|number)|supported\s+by\s+(?:a\s+grant\s+from)?)\b/i
const GRANT_NUM_RE = /\b(?:NIH|NRF|MRC|ERC|NSF|JSPS|Wellcome|NIHR|EU\sH2020|ISF)\s+(?:[A-Z]{1,4}[-\s]?)?[A-Z0-9-]{3,}\b/
export function extractFunding(m) {
  const text = joined(m)
  const mm = text.match(FUNDING_RE)
  if (!mm) return null
  const num = text.match(GRANT_NUM_RE)
  return {
    value: { has_funding_statement: true, grant_number: num ? num[0] : null },
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.85,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CRediT contributions
// ────────────────────────────────────────────────────────────────────────────
const CREDIT_RE = /\bCRediT\b|\bauthor(?:\s+contributions?)?[:.]\s*(?:[A-Z][a-zA-Z.\-]+\s+[A-Z][a-zA-Z.]+)?[:,]?\s*(?:conceptualization|data\s+curation|formal\s+analysis|investigation|methodology|writing[-\s]?(?:original|review))/i
export function extractCRediT(m) {
  const text = joined(m)
  const mm = text.match(CREDIT_RE)
  if (!mm) return null
  return {
    value: true,
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.85,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pre-registration phrase (without specific registry ID)
// ────────────────────────────────────────────────────────────────────────────
const PREREG_RE = /\bpre[-\s]?regist(?:ered|ration)\b|\bprospectively\s+regist(?:ered|ration)\b/i
export function extractPreregistration(m) {
  const text = joined(m)
  const mm = text.match(PREREG_RE)
  if (!mm) return null
  return {
    value: true,
    evidence_text: snippet(text, mm.index, mm[0].length),
    evidence_section: sectionAt(m, mm.index),
    confidence: 0.85,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Mapping: Q500 item.id  →  rule extractor
// extract.js consults this before LLM scoring for hybrid items.
// ────────────────────────────────────────────────────────────────────────────
export const RULE_BY_ITEM_ID = {
  // Sample size & adequacy items
  'POPUL_005':       extractSampleSize,
  'DESIGN_005':      extractSampleSize,
  'STATS_021':       extractSampleSize,
  // AUROC / discrimination
  'AIPRED_015':      extractAUC,
  'EXTV_008':        extractAUC,
  // Confidence intervals
  'OUTCM_038':       extractCIPresence,
  'STATS_006':       extractCIPresence,
  'AIPRED_024':      extractCIPresence,
  // Exact p-values
  'STATS_007':       extractPValueExact,
  // Trial registries / pre-reg
  'DESIGN_003':      extractRegistry,
  'REPRT_004':       extractRegistry,
  'QUEST_006':       extractPreregistration,
  // Agreement metrics
  'OUTCM_008':       extractAgreement,
  'EXPOS_017':       extractAgreement,
  // Follow-up duration
  'DESIGN_017':      extractFollowUp,
  // Multicenter
  'DESIGN_011':      extractMulticenter,
  'DESIGN_012':      extractMulticenter,
  // Reporting guidelines
  'REPRT_001':       extractGuidelineMention,
  // Software / version
  'STATS_050':       extractSoftware,
  'STATS_051':       extractSoftware,
  'REPRT_023':       extractSoftware,
  // Ethics / IRB
  'REPRT_015':       extractEthics,
  // External validation
  'EXTV_001':        extractExternalValidation,
  'AIPRED_026':      extractExternalValidation,
  // Decision curve / net benefit
  'AIPRED_019':      extractDCA,
  'AIPRED_020':      extractDCA,
  // Funding / CRediT
  'REPRT_013':       extractFunding,
  'BIAS_033':        extractFunding,
  'REPRT_011':       extractCRediT,
}

// Coverage report — how many Q500 items have a rule extractor wired
export function ruleCoverageSummary(q500items) {
  const ids = new Set(Object.keys(RULE_BY_ITEM_ID))
  const hybrid = q500items.filter(i => i.mode === 'hybrid' || i.mode === 'rule')
  const covered = hybrid.filter(i => ids.has(i.id))
  return {
    rule_extractors: ids.size,
    hybrid_items_in_q500: hybrid.length,
    hybrid_covered: covered.length,
    coverage_pct: hybrid.length ? +(covered.length / hybrid.length * 100).toFixed(1) : 0,
  }
}
