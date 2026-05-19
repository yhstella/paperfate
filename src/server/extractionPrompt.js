// PaperFate · Q500 item scoring prompt
// Evidence-first rubric application. Input: one Q500 item + manuscript + article type.
// Output (from LLM): a single JSON object matching extraction_output_schema in schema.json.

const SYSTEM = `You are a rigorous scientific reviewer scoring one PaperFate Q500 rubric item against a manuscript.

Hard rules:
1. EVIDENCE FIRST. Find the evidence in the manuscript before assigning a score.
2. Quote the most relevant span verbatim (≤30 words). Do not paraphrase.
3. If you cannot locate the required evidence anywhere in the supplied text, emit applicability="indeterminate" and score="UNK".
4. If the article type does not match the item's applicable types, emit applicability="not_applicable" and score="NA".
5. Confidence: 0.85+ for explicit verbatim quote; 0.6–0.8 for inferred from context; <0.5 for guesswork (avoid — prefer UNK).
6. Score = the index of the rubric anchor that best matches the evidence.
7. OUTPUT JSON ONLY. No prose, no markdown fences.

Output schema (strict):
{
  "id":               string,             // item id, echoed
  "score":            number | "NA" | "UNK",
  "applicability":    "applicable" | "not_applicable" | "indeterminate",
  "confidence":       number 0..1,
  "evidence_text":    string,             // verbatim quote, "" if UNK/NA
  "evidence_section": string,             // one of input_sections, "" if UNK/NA
  "rationale_short":  string,             // 1 sentence referencing the rubric anchor
  "scoring_mode":     "llm"
}`

// Rubric anchor labels for compact vs full
function formatRubric(rubric) {
  // Q100 items: 6 anchors (scores 0..5)
  // Compact: 4 anchors (scores 0/2/4/5; 1 and 3 are interpolations)
  if (rubric.length === 6) {
    return rubric.map((a, i) => `  ${i}: ${a}`).join('\n')
  }
  if (rubric.length === 4) {
    return [
      `  0: ${rubric[0]}`,
      `  1: (between 0 and 2)`,
      `  2: ${rubric[1]}`,
      `  3: (between 2 and 4)`,
      `  4: ${rubric[2]}`,
      `  5: ${rubric[3]}`,
    ].join('\n')
  }
  return rubric.map((a, i) => `  ${i}: ${a}`).join('\n')
}

function formatTypes(types) {
  if (types === '*') return 'ALL article types'
  if (Array.isArray(types)) return types.join(', ')
  return String(types)
}

function formatSections(input) {
  const parts = []
  if (input.title)      parts.push(`# TITLE\n${input.title}`)
  if (input.abstract)   parts.push(`# ABSTRACT\n${input.abstract}`)
  if (input.methods)    parts.push(`# METHODS\n${input.methods}`)
  if (input.results)    parts.push(`# RESULTS\n${input.results}`)
  if (input.discussion) parts.push(`# DISCUSSION\n${input.discussion}`)
  if (input.full_text)  parts.push(`# FULL TEXT\n${input.full_text}`)
  return parts.join('\n\n')
}

// Build the user message for one item.
// `manuscript` is { title, abstract, methods?, results?, discussion?, full_text? }
// `articleType` is one of schema.json `article_types`
export function buildItemPrompt(item, manuscript, articleType) {
  const rubricStr = formatRubric(item.rubric)
  const evidenceStr = (item.evidence || []).map(e => `- ${e}`).join('\n') || '- (no specific evidence cues; apply rubric to overall coverage)'
  const guidelineStr = (item.guideline || []).join(', ') || '(none)'
  const naCondition = item.NA ? `NA condition for this item: "${item.NA}"` : 'No special NA condition beyond article-type match.'
  const sections = formatSections(manuscript)

  return `ITEM: ${item.id} — ${item.name}
DOMAIN: ${item.id.split('_')[0]}
QUESTION: ${item.q}

RUBRIC ANCHORS (score → description):
${rubricStr}

REQUIRED EVIDENCE (look for these cues):
${evidenceStr}

APPLICABLE ARTICLE TYPES: ${formatTypes(item.types)}
THIS MANUSCRIPT'S ARTICLE TYPE: ${articleType}
RELATED REPORTING GUIDELINES: ${guidelineStr}
${naCondition}

──────────── MANUSCRIPT ────────────
${sections}
────────────────────────────────────

Now score this item. Output the JSON object only.`
}

export function getSystemPrompt() {
  return SYSTEM
}

// Cheap token estimator (chars/4). Good enough for budgeting.
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4)
}
