// PaperFate · Gemini API wrapper for Q500 extraction
//
// Same public interface as PaperFateExtractor (scoreItem, batchScore, costSummary).
// Designed for the free tier of Gemini 2.5 Flash:
//   - 10 RPM, 1,500 RPD, 1M tokens/day
//   - Score N items per request (default 8) to fit under the RPM cap
//     and still finish a Q100 forecast in ~60 seconds.
//
// JSON output is enforced via responseMimeType + responseSchema.

import { buildItemPrompt, getSystemPrompt } from './extractionPrompt.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// Free-tier pricing is $0/M tokens. Track usage anyway for visibility.
// Paid tier (when upgraded): roughly 1$/M input + 4$/M output for 2.5 Flash.
const PRICING = {
  'gemini-2.5-flash':         { input: 0.0,  output: 0.0,  free: true },
  'gemini-2.5-flash-paid':    { input: 1.0,  output: 4.0,  free: false },
  'gemini-2.5-pro':           { input: 7.0,  output: 21.0, free: false },
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

class RpmLimiter {
  constructor(rpm) {
    this.gap = 60_000 / rpm
    this.last = 0
  }
  async take() {
    const now = Date.now()
    const wait = Math.max(0, this.last + this.gap - now)
    if (wait) await sleep(wait)
    this.last = Date.now()
  }
}

// One JSON-object schema per scored item — Gemini enforces it.
const PER_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id:               { type: 'string' },
    score:            { type: 'string', description: 'integer 0..5, or "NA", or "UNK". Always a string for JSON-mode safety.' },
    applicability:    { type: 'string', enum: ['applicable', 'not_applicable', 'indeterminate'] },
    confidence:       { type: 'number' },
    evidence_text:    { type: 'string' },
    evidence_section: { type: 'string' },
    rationale_short:  { type: 'string' },
  },
  required: ['id', 'score', 'applicability', 'confidence', 'evidence_text', 'rationale_short'],
}

const BATCH_SCHEMA = {
  type: 'array',
  items: PER_ITEM_SCHEMA,
}

function buildBatchPrompt(items, manuscript, articleType) {
  const sections = []
  if (manuscript.title)      sections.push(`TITLE: ${manuscript.title}`)
  if (manuscript.abstract)   sections.push(`ABSTRACT:\n${manuscript.abstract}`)
  if (manuscript.methods)    sections.push(`METHODS:\n${manuscript.methods}`)
  if (manuscript.results)    sections.push(`RESULTS:\n${manuscript.results}`)
  if (manuscript.discussion) sections.push(`DISCUSSION:\n${manuscript.discussion}`)
  if (manuscript.full_text)  sections.push(`FULL TEXT:\n${manuscript.full_text}`)
  const ms = sections.join('\n\n')

  const itemsText = items.map((it, i) => {
    const rubricStr = (it.rubric || []).map((a, k) => {
      // 6-anchor full, or 4-anchor compact mapped 0/2/4/5
      if (it.rubric.length === 6) return `  ${k}: ${a}`
      const idx = [0, 2, 4, 5][k]
      return `  ${idx}: ${a}`
    }).join('\n')
    const naLine = it.NA ? `  NA condition: ${it.NA}` : ''
    const types = it.types === '*' ? 'ALL article types' : (Array.isArray(it.types) ? it.types.join(', ') : String(it.types))
    const ev = (it.evidence || []).map(e => `    - ${e}`).join('\n') || '    - (no specific cues)'
    return `[ITEM ${i + 1}] id=${it.id}  name=${it.name}
  question: ${it.q}
  applicable_types: ${types}
${naLine}
  evidence_required:
${ev}
  rubric:
${rubricStr}
`
  }).join('\n')

  return `You are scoring ${items.length} PaperFate Q500 rubric items against ONE manuscript.

Article type of this manuscript: ${articleType}

For EACH item, follow this procedure strictly:
1. If article type is not in applicable_types and applicable_types is not 'ALL', emit applicability="not_applicable" and score="NA".
2. Search the manuscript for evidence matching evidence_required. If none, emit applicability="indeterminate" and score="UNK".
3. Quote the most relevant ≤30-word verbatim span as evidence_text. Tag evidence_section as one of: title, abstract, methods, results, discussion, tables, figures, supplement, unknown.
4. Pick the rubric anchor that best matches the evidence. Score = the integer index (as a string "0".."5").
5. confidence: 0.85+ for explicit quote, 0.6–0.8 for inferred, <0.5 → prefer UNK.
6. rationale_short: 1 sentence referencing the chosen rubric anchor.

Return a JSON array of EXACTLY ${items.length} objects in the same order as the items above. No prose, no markdown.

──────────── MANUSCRIPT ────────────
${ms}
────────────────────────────────────

ITEMS TO SCORE:
${itemsText}`
}

export class GeminiExtractor {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    rpm = 9,
    batchSize = 8,
    isFreeTier = true,
  } = {}) {
    const key = apiKey || process.env.GEMINI_API_KEY
    if (!key) throw new Error('GEMINI_API_KEY missing. Set the env var or pass {apiKey}.')
    this.apiKey = key
    this.model = model
    this.batchSize = batchSize
    this.limiter = new RpmLimiter(rpm)
    this.pricingKey = isFreeTier ? model : `${model}-paid`
    this.cost = { input: 0, output: 0, calls: 0, retries: 0, byModel: {}, items_in: 0, items_out: 0, parse_errors: 0 }
  }

  _accumulateCost(usage, count = 1) {
    const p = PRICING[this.pricingKey] || PRICING[this.model] || { input: 0, output: 0 }
    const inUsd  = (usage?.promptTokenCount     || 0) / 1e6 * p.input
    const outUsd = (usage?.candidatesTokenCount || 0) / 1e6 * p.output
    this.cost.input  += inUsd
    this.cost.output += outUsd
    this.cost.calls  += 1
    if (!this.cost.byModel[this.model]) this.cost.byModel[this.model] = { calls: 0, input: 0, output: 0 }
    this.cost.byModel[this.model].calls += 1
    this.cost.byModel[this.model].input  += inUsd
    this.cost.byModel[this.model].output += outUsd
  }

  async _callOnce(systemText, userText) {
    await this.limiter.take()
    const url = `${API_BASE}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`
    const body = {
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: systemText }] },
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: BATCH_SCHEMA,
        temperature: 0,
        maxOutputTokens: 8192,
      },
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const err = new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 200)}`)
      err.status = res.status
      throw err
    }
    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
    this._accumulateCost(data.usageMetadata)
    return { text, raw: data }
  }

  async _callWithRetry(systemText, userText, { attempts = 3, baseDelay = 2000 } = {}) {
    let lastErr
    for (let i = 0; i < attempts; i++) {
      try {
        return await this._callOnce(systemText, userText)
      } catch (e) {
        lastErr = e
        const transient = !e.status || e.status === 429 || (e.status >= 500 && e.status < 600) || e.name === 'AbortError'
        if (!transient) throw e
        this.cost.retries += 1
        const wait = baseDelay * Math.pow(2, i) + Math.floor(Math.random() * 300)
        await sleep(wait)
      }
    }
    throw lastErr
  }

  _normalizeScored(obj, expectedId) {
    const out = {
      id:               obj.id ?? expectedId,
      score:            obj.score,
      applicability:    obj.applicability || (obj.score === 'NA' ? 'not_applicable' : obj.score === 'UNK' ? 'indeterminate' : 'applicable'),
      confidence:       typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
      evidence_text:    obj.evidence_text ?? '',
      evidence_section: obj.evidence_section ?? '',
      rationale_short:  obj.rationale_short ?? '',
      scoring_mode:     'llm',
    }
    // Score may be a string (from JSON-mode); coerce to int 0..5 or keep NA/UNK
    if (typeof out.score === 'string') {
      if (out.score === 'NA' || out.score === 'UNK') {
        // leave as is
      } else {
        const n = Number(out.score)
        if (Number.isFinite(n)) out.score = Math.max(0, Math.min(5, Math.round(n)))
        else out.score = 'UNK'
      }
    } else if (typeof out.score === 'number') {
      out.score = Math.max(0, Math.min(5, Math.round(out.score)))
    } else {
      out.score = 'UNK'
    }
    return out
  }

  _parseBatch(text, items) {
    let raw = (text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    let arr
    try {
      arr = JSON.parse(raw)
    } catch {
      const m = raw.match(/\[[\s\S]*\]/)
      if (!m) {
        this.cost.parse_errors += items.length
        return items.map(it => ({
          id: it.id, score: 'UNK', applicability: 'indeterminate', confidence: 0.0,
          evidence_text: '', evidence_section: '', rationale_short: 'Parse error: no JSON array found.',
          scoring_mode: 'llm', _parse_error: true,
        }))
      }
      try { arr = JSON.parse(m[0]) } catch {
        this.cost.parse_errors += items.length
        return items.map(it => ({
          id: it.id, score: 'UNK', applicability: 'indeterminate', confidence: 0.0,
          evidence_text: '', evidence_section: '', rationale_short: 'Parse error: invalid JSON.',
          scoring_mode: 'llm', _parse_error: true,
        }))
      }
    }
    if (!Array.isArray(arr)) {
      this.cost.parse_errors += items.length
      return items.map(it => ({
        id: it.id, score: 'UNK', applicability: 'indeterminate', confidence: 0.0,
        evidence_text: '', evidence_section: '', rationale_short: 'Parse error: not an array.',
        scoring_mode: 'llm', _parse_error: true,
      }))
    }
    // Match by id if present, else by position
    const byId = new Map(arr.map(o => [o.id, o]))
    return items.map((it, i) => {
      const candidate = byId.get(it.id) || arr[i]
      if (!candidate) {
        return {
          id: it.id, score: 'UNK', applicability: 'indeterminate', confidence: 0.0,
          evidence_text: '', evidence_section: '', rationale_short: 'Item missing from model response.',
          scoring_mode: 'llm', _parse_error: true,
        }
      }
      return this._normalizeScored(candidate, it.id)
    })
  }

  // Score a single item — used by extract.js for per-item paths. Wraps batch of 1.
  async scoreItem(item, manuscript, articleType) {
    const arr = await this.batchScore([item], manuscript, articleType, { concurrency: 1 })
    return arr[0]
  }

  // Score many items. concurrency must be 1 to respect Gemini RPM cap.
  async batchScore(items, manuscript, articleType, { concurrency = 1, onItem } = {}) {
    // Slice into batches of this.batchSize
    const batches = []
    for (let i = 0; i < items.length; i += this.batchSize) {
      batches.push(items.slice(i, i + this.batchSize))
    }
    this.cost.items_in += items.length
    const results = new Array(items.length).fill(null)

    const systemText = getSystemPrompt()
      + '\n\nThis run scores MULTIPLE items per request. Always return a JSON ARRAY.'

    let written = 0
    for (const batch of batches) {
      const userText = buildBatchPrompt(batch, manuscript, articleType)
      let parsed
      try {
        const { text } = await this._callWithRetry(systemText, userText)
        parsed = this._parseBatch(text, batch)
      } catch (e) {
        parsed = batch.map(it => ({
          id: it.id, score: 'UNK', applicability: 'indeterminate', confidence: 0.0,
          evidence_text: '', evidence_section: '', rationale_short: `Batch failed: ${e.message || String(e)}`,
          scoring_mode: 'llm', _error: true,
        }))
      }
      // Place into results array at the same offsets
      for (let j = 0; j < batch.length; j++) {
        const globalIdx = items.indexOf(batch[j])
        results[globalIdx] = parsed[j]
        this.cost.items_out += 1
        if (onItem) {
          try { onItem(parsed[j], written + j, items.length) } catch {}
        }
      }
      written += batch.length
    }
    return results
  }

  // Mirrors PaperFateExtractor.filterItems for symmetry
  static filterItems(allItems, { lvlMax = 1, articleType = '*', q100Only = false } = {}) {
    return allItems.filter(it => {
      if (it.lvl > lvlMax) return false
      if (q100Only && !it.Q100) return false
      if (it.types !== '*' && Array.isArray(it.types) && articleType !== '*' && !it.types.includes(articleType)) return false
      return true
    })
  }

  costSummary() {
    return {
      provider: 'gemini',
      model: this.model,
      total_usd: +(this.cost.input + this.cost.output).toFixed(4),
      input_usd: +this.cost.input.toFixed(4),
      output_usd: +this.cost.output.toFixed(4),
      calls: this.cost.calls,
      retries: this.cost.retries,
      items_in: this.cost.items_in,
      items_out: this.cost.items_out,
      parse_errors: this.cost.parse_errors,
      by_model: Object.fromEntries(
        Object.entries(this.cost.byModel).map(([m, v]) => [m, {
          calls: v.calls,
          usd: +(v.input + v.output).toFixed(4),
        }])
      ),
    }
  }
}
