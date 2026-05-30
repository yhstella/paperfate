#!/usr/bin/env node
// Unit tests for sanitizeItems logic from api/forecast.js.
// We REPRODUCE the function inline (copy) rather than import — this lets us
// exercise it in isolation without spinning up the handler.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── Copied from api/forecast.js (sanitizeItems) ─────────────────────────────
function sanitizeItems(extraction) {
  if (!extraction || !Array.isArray(extraction.items)) return { failed: [], errorMessages: [] }
  const failed = []
  const errorMessages = []
  for (const it of extraction.items) {
    if (!it || typeof it !== 'object') continue
    const rationale = String(it.rationale_short || '')
    const isFailed = !!it._error || /Batch failed|API key not valid/i.test(rationale)
    if (isFailed) {
      failed.push(it)
      const original = it.rationale_short
      if (original && !it._error_detail) it._error_detail = original
      if (original) errorMessages.push(String(original))
      it.rationale_short = 'LLM scoring unavailable — fell back to rule pre-pass for this item.'
    }
  }
  // Dedupe + cap to 10
  const seen = new Set()
  const dedupedErrors = []
  for (const m of errorMessages) {
    if (seen.has(m)) continue
    seen.add(m)
    dedupedErrors.push(m)
    if (dedupedErrors.length >= 10) break
  }
  return { failed, errorMessages: dedupedErrors }
}

const CANONICAL_RATIONALE = 'LLM scoring unavailable — fell back to rule pre-pass for this item.'

test('sanitizeItems: handles null / non-array extraction', () => {
  assert.deepEqual(sanitizeItems(null), { failed: [], errorMessages: [] })
  assert.deepEqual(sanitizeItems({}), { failed: [], errorMessages: [] })
  assert.deepEqual(sanitizeItems({ items: 'not-array' }), { failed: [], errorMessages: [] })
})

test('sanitizeItems: rationale containing "API key not valid" is flagged failed', () => {
  const extraction = {
    items: [
      { id: 'q1', rationale_short: 'API key not valid. Please pass a valid API key.' },
      { id: 'q2', rationale_short: 'Sound methods, clear primary outcome.' },
    ],
  }
  const { failed, errorMessages } = sanitizeItems(extraction)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, 'q1')
  assert.equal(failed[0].rationale_short, CANONICAL_RATIONALE)
  assert.equal(failed[0]._error_detail, 'API key not valid. Please pass a valid API key.')
  assert.equal(errorMessages.length, 1)
  // Second item untouched
  assert.equal(extraction.items[1].rationale_short, 'Sound methods, clear primary outcome.')
})

test('sanitizeItems: items with _error:true are flagged failed', () => {
  const extraction = {
    items: [
      { id: 'q1', _error: true, rationale_short: 'Some upstream error message' },
      { id: 'q2', _error: false, rationale_short: 'Good item' },
    ],
  }
  const { failed, errorMessages } = sanitizeItems(extraction)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, 'q1')
  assert.equal(failed[0].rationale_short, CANONICAL_RATIONALE)
  assert.equal(failed[0]._error_detail, 'Some upstream error message')
  assert.equal(errorMessages[0], 'Some upstream error message')
})

test('sanitizeItems: "Batch failed" rationale is flagged failed', () => {
  const extraction = {
    items: [
      { id: 'q1', rationale_short: 'Batch failed: timeout after 30s' },
    ],
  }
  const { failed } = sanitizeItems(extraction)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].rationale_short, CANONICAL_RATIONALE)
})

test('sanitizeItems: canonical sanitised rationale string is exact', () => {
  const extraction = {
    items: [{ id: 'q1', _error: true, rationale_short: 'x' }],
  }
  sanitizeItems(extraction)
  assert.equal(extraction.items[0].rationale_short, CANONICAL_RATIONALE)
})

test('sanitizeItems: original error preserved in _error_detail', () => {
  const original = 'API key not valid. Please pass a valid API key.'
  const extraction = {
    items: [{ id: 'q1', rationale_short: original }],
  }
  sanitizeItems(extraction)
  assert.equal(extraction.items[0]._error_detail, original)
  // After sanitisation, rationale is canonical but _error_detail keeps the truth.
  assert.equal(extraction.items[0].rationale_short, CANONICAL_RATIONALE)
})

test('sanitizeItems: does not overwrite a pre-existing _error_detail', () => {
  const extraction = {
    items: [{ id: 'q1', _error: true, _error_detail: 'previously stored', rationale_short: 'newer message' }],
  }
  sanitizeItems(extraction)
  assert.equal(extraction.items[0]._error_detail, 'previously stored')
})

test('sanitizeItems: errorMessages deduped', () => {
  const extraction = {
    items: [
      { id: 'q1', _error: true, rationale_short: 'API key not valid.' },
      { id: 'q2', _error: true, rationale_short: 'API key not valid.' },
      { id: 'q3', _error: true, rationale_short: 'API key not valid.' },
      { id: 'q4', _error: true, rationale_short: 'Different error' },
    ],
  }
  const { errorMessages } = sanitizeItems(extraction)
  assert.equal(errorMessages.length, 2)
  assert.ok(errorMessages.includes('API key not valid.'))
  assert.ok(errorMessages.includes('Different error'))
})

test('sanitizeItems: errorMessages capped at 10', () => {
  const items = []
  for (let i = 0; i < 25; i++) {
    items.push({ id: `q${i}`, _error: true, rationale_short: `unique error ${i}` })
  }
  const { failed, errorMessages } = sanitizeItems({ items })
  assert.equal(failed.length, 25)
  assert.equal(errorMessages.length, 10)
})

test('sanitizeItems: skips non-object items gracefully', () => {
  const extraction = {
    items: [null, undefined, 'string', 42, { id: 'q1', _error: true, rationale_short: 'err' }],
  }
  const { failed } = sanitizeItems(extraction)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, 'q1')
})
