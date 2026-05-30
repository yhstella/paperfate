// PaperFate · Anthropic API wrapper for Q500 extraction
// - Single-item scoring (scoreItem)
// - Batched parallel scoring with concurrency cap (batchScore)
// - Retry with exponential backoff on 429 / 5xx / network
// - In-process cost tracking
// - Model selection: Haiku default, Sonnet upgrade on low confidence

import Anthropic from '@anthropic-ai/sdk'
import { buildItemPrompt, getSystemPrompt, estimateTokens } from './extractionPrompt.js'

// Pricing per million tokens (verify against current Anthropic pricing).
// Cost tracking is best-effort; treat as estimates.
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00,  output: 5.00 },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':           { input: 15.00, output: 75.00 },
}

const DEFAULT_MODEL  = 'claude-haiku-4-5-20251001'
const FALLBACK_MODEL = 'claude-sonnet-4-6'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export class PaperFateExtractor {
  constructor({ apiKey, model = DEFAULT_MODEL, fallbackModel = FALLBACK_MODEL, lowConfidenceThreshold = 0.5 } = {}) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('ANTHROPIC_API_KEY missing. Set the env var or pass {apiKey}.')
    this.client = new Anthropic({ apiKey: key })
    this.model = model
    this.fallbackModel = fallbackModel
    this.lowConfidenceThreshold = lowConfidenceThreshold
    this.cost = { input: 0, output: 0, calls: 0, retries: 0, fallbacks: 0, byModel: {} }
  }

  _accumulateCost(model, usage) {
    if (!usage) return
    const p = PRICING[model] || { input: 0, output: 0 }
    const inUsd  = (usage.input_tokens  || 0) / 1e6 * p.input
    const outUsd = (usage.output_tokens || 0) / 1e6 * p.output
    this.cost.input  += inUsd
    this.cost.output += outUsd
    this.cost.calls  += 1
    if (!this.cost.byModel[model]) this.cost.byModel[model] = { calls: 0, input: 0, output: 0 }
    this.cost.byModel[model].calls += 1
    this.cost.byModel[model].input  += inUsd
    this.cost.byModel[model].output += outUsd
  }

  async _callOnce(model, system, user, { maxTokens = 600, temperature = 0 } = {}) {
    const res = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    })
    this._accumulateCost(model, res.usage)
    // Concatenate text blocks (rare to be multiple for our use case)
    const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    return { text, raw: res, model }
  }

  async _callWithRetry(model, system, user, opts = {}, { attempts = 5, baseDelay = 800 } = {}) {
    let lastErr
    for (let i = 0; i < attempts; i++) {
      try {
        return await this._callOnce(model, system, user, opts)
      } catch (e) {
        lastErr = e
        const status = e?.status || e?.response?.status
        const transient = !status || status === 429 || (status >= 500 && status < 600)
        if (!transient) throw e
        const wait = baseDelay * Math.pow(2, i) + Math.floor(Math.random() * 200)
        this.cost.retries += 1
        await sleep(wait)
      }
    }
    throw lastErr
  }

  // Parse the model's JSON output. Robust to small wrapping mistakes.
  _parseScored(text, itemId) {
    let raw = (text || '').trim()
    // Strip code fences if present
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    // Try direct parse first
    try {
      const obj = JSON.parse(raw)
      return this._normalizeScored(obj, itemId)
    } catch {}
    // Fallback: extract the first {...} substring
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) {
      return this._fallbackBadJson(itemId, raw)
    }
    try {
      const obj = JSON.parse(m[0])
      return this._normalizeScored(obj, itemId)
    } catch {
      return this._fallbackBadJson(itemId, raw)
    }
  }

  _normalizeScored(obj, itemId) {
    // Ensure required fields exist and have plausible types
    const out = {
      id:               obj.id ?? itemId,
      score:            obj.score,
      applicability:    obj.applicability || (obj.score === 'NA' ? 'not_applicable' : obj.score === 'UNK' ? 'indeterminate' : 'applicable'),
      confidence:       typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
      evidence_text:    obj.evidence_text ?? '',
      evidence_section: obj.evidence_section ?? '',
      rationale_short:  obj.rationale_short ?? '',
      scoring_mode:     obj.scoring_mode || 'llm',
    }
    // Coerce numeric scores to int 0..5; keep NA/UNK as strings
    if (typeof out.score === 'number') out.score = Math.max(0, Math.min(5, Math.round(out.score)))
    else if (out.score !== 'NA' && out.score !== 'UNK') {
      const n = Number(out.score)
      if (Number.isFinite(n)) out.score = Math.max(0, Math.min(5, Math.round(n)))
      else out.score = 'UNK'
    }
    return out
  }

  _fallbackBadJson(itemId, rawText) {
    return {
      id: itemId,
      score: 'UNK',
      applicability: 'indeterminate',
      confidence: 0.0,
      evidence_text: '',
      evidence_section: '',
      rationale_short: `Could not parse model output as JSON: ${rawText.slice(0, 120)}`,
      scoring_mode: 'llm',
      _parse_error: true,
    }
  }

  // Score one Q500 item. Returns the normalized extraction_output_schema object.
  async scoreItem(item, manuscript, articleType, { upgradeOnLowConfidence = true } = {}) {
    const system = getSystemPrompt()
    const user = buildItemPrompt(item, manuscript, articleType)
    const { text } = await this._callWithRetry(this.model, system, user)
    const parsed = this._parseScored(text, item.id)

    // Upgrade-on-low-confidence: re-score with the bigger model
    if (upgradeOnLowConfidence
        && this.fallbackModel
        && parsed.applicability === 'applicable'
        && typeof parsed.confidence === 'number'
        && parsed.confidence < this.lowConfidenceThreshold) {
      this.cost.fallbacks += 1
      const { text: text2 } = await this._callWithRetry(this.fallbackModel, system, user)
      const upgraded = this._parseScored(text2, item.id)
      upgraded.upgraded_from = this.model
      upgraded.scoring_mode = 'llm'
      return upgraded
    }
    return parsed
  }

  // Score many items in parallel with a concurrency cap.
  async batchScore(items, manuscript, articleType, { concurrency = 10, onItem } = {}) {
    const results = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const idx = next++
        if (idx >= items.length) return
        try {
          results[idx] = await this.scoreItem(items[idx], manuscript, articleType)
        } catch (e) {
          const detail = `Extraction failed: ${e.message || String(e)}`
          results[idx] = {
            id: items[idx].id,
            score: 'UNK',
            applicability: 'indeterminate',
            confidence: 0.0,
            evidence_text: '',
            evidence_section: '',
            rationale_short: 'LLM scoring unavailable — fell back to rule pre-pass for this item.',
            scoring_mode: 'llm',
            _error: true,
            _error_detail: detail,
          }
        }
        if (onItem) {
          try { onItem(results[idx], idx, items.length) } catch {}
        }
      }
    })
    await Promise.all(workers)
    return results
  }

  // Filter a Q500 array to only items applicable at the given input level + article type.
  // - lvlMax: 1 (abstract-only) … 4 (everything). Items with item.lvl > lvlMax are skipped.
  // - articleType: '*' matches all
  // - q100Only: if true, restrict to Q100 subset
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
      total_usd: +(this.cost.input + this.cost.output).toFixed(4),
      input_usd: +this.cost.input.toFixed(4),
      output_usd: +this.cost.output.toFixed(4),
      calls: this.cost.calls,
      retries: this.cost.retries,
      fallbacks: this.cost.fallbacks,
      by_model: Object.fromEntries(
        Object.entries(this.cost.byModel).map(([m, v]) => [m, {
          calls: v.calls,
          usd: +(v.input + v.output).toFixed(4),
        }])
      ),
    }
  }
}
