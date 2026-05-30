#!/usr/bin/env node
// Unit tests for the two confidence caps applied around fatecore inference:
//   (1) hard cap to 0.20 when items_scored < 5 (Worker B Round 1, applied
//       inside fatecoreInference.js via `if (itemsScored < 5) ...`)
//   (2) cap to 0.30 when extractor_used === 'rule_fallback' (Round 1
//       follow-up, applied in api/forecast.js after fatecore prediction).
//
// We REPRODUCE both cap formulas inline so the test exercises the rule, not
// the LightGBM model. The point is to lock in the contract.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

// Approximation of fatecoreInference confidence assembly (rule-only, no model)
// — copied/distilled from src/server/fatecoreInference.js predictFromExtraction
// confidence path. We only model the bits that drive the < 5 cap.
function computeConfidence({ itemsAttempted, itemsScored, applicableItems = null, modelTargets = false, q = 0.6 }) {
  const extractionConfidence = itemsAttempted
    ? clamp((itemsScored || 0) / itemsAttempted, 0.2, 1)
    : 0.6
  const denomForCoverage = Math.max(8, applicableItems || itemsAttempted || 0)
  const coverageRatio = clamp(itemsScored / denomForCoverage, 0, 1)
  let rawConfidence = (modelTargets ? 0.72 : 0.45) + 0.18 * extractionConfidence + 0.08 * q
  rawConfidence *= coverageRatio
  // Hard cap: if fewer than 5 items were scored, confidence is capped at 0.20.
  if (itemsScored < 5) rawConfidence = Math.min(rawConfidence, 0.20)
  return +clamp(rawConfidence, 0, 0.95).toFixed(3)
}

// Rule-fallback cap from api/forecast.js (post-inference):
//   if (extraction?.extractor_used === 'rule_fallback' && fatecore && Number.isFinite(fatecore.confidence)) {
//     fatecore.confidence = Math.min(fatecore.confidence, 0.30)
//   }
function applyFallbackCap(extraction, fatecore) {
  if (extraction?.extractor_used === 'rule_fallback' && fatecore && Number.isFinite(fatecore.confidence)) {
    fatecore.confidence = Math.min(fatecore.confidence, 0.30)
  }
  return fatecore
}

// ── (1) items_scored < 5 → confidence < 0.20 ───────────────────────────────
test('confidence cap: items_scored = 0 → confidence ≤ 0.20', () => {
  const c = computeConfidence({ itemsAttempted: 100, itemsScored: 0 })
  assert.ok(c <= 0.20, `expected ≤ 0.20, got ${c}`)
})

test('confidence cap: items_scored = 4 → confidence ≤ 0.20', () => {
  const c = computeConfidence({ itemsAttempted: 100, itemsScored: 4 })
  assert.ok(c <= 0.20, `expected ≤ 0.20, got ${c}`)
})

test('confidence cap: items_scored = 5 → cap does NOT apply', () => {
  // With 5 items scored, the < 5 cap shouldn't fire. With model + high coverage
  // we'd expect a higher number; with rule-only and tiny coverage it might
  // still be small, so only assert: the explicit 0.20 cap didn't snap us down.
  const c = computeConfidence({ itemsAttempted: 5, itemsScored: 5, applicableItems: 5, modelTargets: true })
  // Coverage denom is max(8, 5) = 8, ratio = 5/8 = 0.625.
  // raw = (0.72 + 0.18*1.0 + 0.08*0.6) * 0.625 = (0.948) * 0.625 = 0.5925
  // No < 5 cap; final clamp 0..0.95 → 0.593 (rounded).
  assert.ok(c > 0.20, `expected > 0.20 (cap not applied), got ${c}`)
})

test('confidence cap: items_scored < 5 strictly less than threshold', () => {
  for (const scored of [0, 1, 2, 3, 4]) {
    const c = computeConfidence({ itemsAttempted: 50, itemsScored: scored })
    assert.ok(c < 0.20 || c === 0.20, `scored=${scored} → ${c}, expected ≤ 0.20`)
  }
})

// ── (2) extractor_used = 'rule_fallback' → confidence ≤ 0.30 ───────────────
test('rule_fallback cap: clamps a high confidence down to 0.30', () => {
  const extraction = { extractor_used: 'rule_fallback' }
  const fatecore = { confidence: 0.81 }
  applyFallbackCap(extraction, fatecore)
  assert.equal(fatecore.confidence, 0.30)
})

test('rule_fallback cap: leaves lower confidences alone', () => {
  const extraction = { extractor_used: 'rule_fallback' }
  const fatecore = { confidence: 0.15 }
  applyFallbackCap(extraction, fatecore)
  assert.equal(fatecore.confidence, 0.15)
})

test('rule_fallback cap: does NOT trigger for non-fallback extractor', () => {
  const extraction = { extractor_used: 'llm' }
  const fatecore = { confidence: 0.78 }
  applyFallbackCap(extraction, fatecore)
  assert.equal(fatecore.confidence, 0.78)
})

test('rule_fallback cap: handles missing fatecore / NaN gracefully', () => {
  const extraction = { extractor_used: 'rule_fallback' }
  assert.doesNotThrow(() => applyFallbackCap(extraction, null))
  const fatecore = { confidence: NaN }
  applyFallbackCap(extraction, fatecore)
  assert.ok(Number.isNaN(fatecore.confidence), 'NaN confidence left alone')
})

test('combined caps: rule_fallback with itemsScored<5 → confidence ≤ 0.20', () => {
  const c0 = computeConfidence({ itemsAttempted: 100, itemsScored: 2 })
  const fatecore = { confidence: c0 }
  applyFallbackCap({ extractor_used: 'rule_fallback' }, fatecore)
  // The < 5 cap already pulled it to ≤ 0.20; rule_fallback cap (0.30) is
  // satisfied trivially, and the stricter < 5 cap wins.
  assert.ok(fatecore.confidence <= 0.20, `expected ≤ 0.20, got ${fatecore.confidence}`)
})
