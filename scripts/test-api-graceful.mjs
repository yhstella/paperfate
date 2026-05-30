#!/usr/bin/env node
// Unit tests for the API graceful-degradation flow in api/forecast.js.
//
// The /api/forecast handler's POST-PROCESS step has several pure helper
// functions plus an inline llm_health / auto-mode branch that together decide
// whether a partially-failed LLM run is surfaced as healthy ('ok'), degraded
// (but kept), or replaced by a deterministic rule_fallback. This file
// REPRODUCES those pure pieces inline (sanitizeItems, detectFailureReason,
// llm_health assembly, auto-mode short-body heuristic, rule_fallback
// confidence cap) and locks in their contract — independent of the live
// handler so we don't need to spin up a request.
//
// IMPORTANT: do not import api/forecast.js. The whole point is to exercise
// these tiny pure functions without dragging the extractor/network/env into
// the test. If api/forecast.js drifts, update the copies here in lockstep.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── Copied verbatim from api/forecast.js ──────────────────────────────────
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

function detectFailureReason(failedItems) {
  for (const it of failedItems) {
    const msg = String(it?._error_detail || it?.rationale_short || '')
    if (/API key not valid/i.test(msg)) return 'gemini_400_invalid_key'
  }
  for (const it of failedItems) {
    const msg = String(it?._error_detail || it?.rationale_short || '')
    if (/429|quota|rate.?limit/i.test(msg)) return 'rate_limited'
  }
  return 'unknown'
}

// Inline branch from api/forecast.js POST-PROCESS — decides whether the LLM
// run is reported as 'ok' or 'degraded'. We isolate the decision into a pure
// function for assertion. Matches the handler's failedRatio > 0.5 threshold
// (heavilyDegraded path).
function buildLlmHealth(extraction, failed, attempted) {
  const failedRatio = attempted > 0 ? failed.length / Math.max(1, attempted) : 0
  const scored = Number(extraction?.items_scored)
  const heavilyDegraded = (failedRatio > 0.5) || scored === 0
  if (heavilyDegraded) {
    return {
      status: 'degraded',
      failed: failed.length,
      attempted,
      reason: detectFailureReason(failed),
    }
  }
  return {
    status: 'ok',
    failed: failed.length,
    attempted,
  }
}

// rule_fallback confidence cap (post-inference, from api/forecast.js).
function applyFallbackCap(extraction, fatecore) {
  if (extraction?.extractor_used === 'rule_fallback' && fatecore && Number.isFinite(fatecore.confidence)) {
    fatecore.confidence = Math.min(fatecore.confidence, 0.30)
  }
  return fatecore
}

// Auto-mode short-body heuristic (from api/forecast.js):
//   if (mode === 'auto' && totalBodyChars < 1500) {
//     normalizedMode = 'Q100'
//     autoDecision = 'Q100_short_body'
//   }
function resolveAutoMode(mode, totalBodyChars) {
  let normalizedMode = mode === 'abstract' ? 'Q100' : mode === 'full' ? 'Q500' : mode
  let autoDecision = null
  if (mode === 'auto' && totalBodyChars < 1500) {
    normalizedMode = 'Q100'
    autoDecision = 'Q100_short_body'
  }
  return { normalizedMode, autoDecision }
}

// Successful response shape (from api/forecast.js handler return):
//   res.status(200).json({ ...extraction, ...fatecore, counterfactual_suggestions,
//     joint_counterfactual, wall_ms, server_version, request_id })
function buildSuccessResponse({ extraction, fatecore, suggestions, joint, wallMs, requestId }) {
  return {
    ...extraction,
    ...fatecore,
    counterfactual_suggestions: suggestions,
    joint_counterfactual: joint,
    wall_ms: wallMs,
    server_version: '0.4.0',
    request_id: requestId,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('sanitizeItems: 0 failed items → failed=[], errorMessages=[]', () => {
  const extraction = {
    items: [
      { id: 'q1', rationale_short: 'Sound design with prespecified outcomes.' },
      { id: 'q2', rationale_short: 'Adequate sample size justification.' },
      { id: 'q3', rationale_short: 'Replication-friendly methods reporting.' },
    ],
  }
  const { failed, errorMessages } = sanitizeItems(extraction)
  assert.deepEqual(failed, [])
  assert.deepEqual(errorMessages, [])
  // Original rationales preserved untouched.
  assert.equal(extraction.items[0].rationale_short, 'Sound design with prespecified outcomes.')
  assert.equal(extraction.items[2].rationale_short, 'Replication-friendly methods reporting.')
})

test('sanitizeItems: flags items with "API key not valid" rationale', () => {
  const extraction = {
    items: [
      { id: 'q1', rationale_short: 'API key not valid. Please pass a valid API key.' },
      { id: 'q2', rationale_short: 'Healthy item' },
    ],
  }
  const { failed, errorMessages } = sanitizeItems(extraction)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, 'q1')
  assert.equal(failed[0]._error_detail, 'API key not valid. Please pass a valid API key.')
  assert.equal(errorMessages.length, 1)
  assert.ok(/API key not valid/i.test(errorMessages[0]))
})

test('detectFailureReason: returns gemini_400_invalid_key for matching items', () => {
  const failed = [
    { rationale_short: 'API key not valid. Please pass a valid API key.' },
    { rationale_short: 'unrelated' },
  ]
  assert.equal(detectFailureReason(failed), 'gemini_400_invalid_key')
})

test('detectFailureReason: prefers gemini_400_invalid_key over rate_limited when both present', () => {
  // The handler's loop scans for API-key errors first, then rate-limit. Lock
  // that priority so a rate-limit signal in the same batch can't mask a more
  // actionable invalid-key failure.
  const failed = [
    { _error_detail: '429 Too Many Requests' },
    { _error_detail: 'API key not valid' },
  ]
  assert.equal(detectFailureReason(failed), 'gemini_400_invalid_key')
})

test('detectFailureReason: returns rate_limited for 429 items', () => {
  const failed = [{ rationale_short: 'HTTP 429: quota exceeded' }]
  assert.equal(detectFailureReason(failed), 'rate_limited')
  // Variant phrasings the regex /429|quota|rate.?limit/i should also catch.
  assert.equal(detectFailureReason([{ rationale_short: 'rate-limited by upstream' }]), 'rate_limited')
  assert.equal(detectFailureReason([{ rationale_short: 'quota for the day exhausted' }]), 'rate_limited')
})

test('detectFailureReason: returns unknown otherwise', () => {
  assert.equal(detectFailureReason([]), 'unknown')
  assert.equal(detectFailureReason([{ rationale_short: 'something else broke' }]), 'unknown')
  assert.equal(detectFailureReason([{ _error_detail: 'segfault in upstream worker' }]), 'unknown')
})

test('llm_health.status = "ok" when failed/attempted < 0.5', () => {
  // 2 / 10 = 0.2 → healthy.
  const extraction = { items_scored: 8, items_attempted: 10 }
  const failed = [{ id: 'q1' }, { id: 'q2' }]
  const health = buildLlmHealth(extraction, failed, 10)
  assert.equal(health.status, 'ok')
  assert.equal(health.failed, 2)
  assert.equal(health.attempted, 10)
  // Healthy path should NOT carry a `reason` field.
  assert.equal(health.reason, undefined)
})

test('llm_health.status = "degraded" when failed/attempted > 0.5', () => {
  // 6 / 10 = 0.6 → degraded. The handler's heavilyDegraded check also fires
  // when items_scored === 0, but here we hit the ratio branch directly.
  const extraction = { items_scored: 4, items_attempted: 10 }
  const failed = Array.from({ length: 6 }, (_, i) => ({
    id: `q${i}`,
    rationale_short: 'API key not valid.',
  }))
  const health = buildLlmHealth(extraction, failed, 10)
  assert.equal(health.status, 'degraded')
  assert.equal(health.failed, 6)
  assert.equal(health.attempted, 10)
  // Degraded path includes the inferred reason.
  assert.equal(health.reason, 'gemini_400_invalid_key')
})

test('rule_fallback cap: confidence > 0.30 is clamped to 0.30', () => {
  // Mirrors the post-inference cap in api/forecast.js. Rule fallback loses
  // access to the LLM's rubric judgement, so the surfaced confidence must
  // not exceed 0.30 regardless of what fatecoreInference returned.
  const extraction = { extractor_used: 'rule_fallback' }
  const fatecore = { confidence: 0.81 }
  applyFallbackCap(extraction, fatecore)
  assert.equal(fatecore.confidence, 0.30)
  // Already-low confidences stay put.
  const low = { confidence: 0.12 }
  applyFallbackCap(extraction, low)
  assert.equal(low.confidence, 0.12)
})

test('auto-mode: forces Q100 when totalBodyChars < 1500', () => {
  // Short body → Q100 with auto_decision tag.
  const short = resolveAutoMode('auto', 800)
  assert.equal(short.normalizedMode, 'Q100')
  assert.equal(short.autoDecision, 'Q100_short_body')
  // Threshold is strict (< 1500): exactly 1500 must NOT switch.
  const boundary = resolveAutoMode('auto', 1500)
  assert.equal(boundary.normalizedMode, 'auto')
  assert.equal(boundary.autoDecision, null)
  // Long body stays in auto (extractor decides).
  const longBody = resolveAutoMode('auto', 12000)
  assert.equal(longBody.normalizedMode, 'auto')
  assert.equal(longBody.autoDecision, null)
  // Aliases pass through without auto-decision.
  assert.deepEqual(resolveAutoMode('abstract', 0), { normalizedMode: 'Q100', autoDecision: null })
  assert.deepEqual(resolveAutoMode('full', 0),     { normalizedMode: 'Q500', autoDecision: null })
})

test('successful response shape: request_id present', () => {
  // Locks in the post-success response shape contract — request_id surfaced
  // in the JSON body in addition to the X-Request-Id header. UI relies on
  // this when a header-stripping proxy sits in front of the function.
  const requestId = 'req_test_abc123'
  const out = buildSuccessResponse({
    extraction: { items_attempted: 100, items_scored: 100, extractor_used: 'llm' },
    fatecore:   { confidence: 0.72, predicted_jif: 5.4 },
    suggestions: [],
    joint:       null,
    wallMs:      1234,
    requestId,
  })
  assert.equal(out.request_id, requestId)
  assert.equal(out.server_version, '0.4.0')
  assert.equal(out.wall_ms, 1234)
  // Extraction + fatecore fields spread through unchanged.
  assert.equal(out.items_attempted, 100)
  assert.equal(out.extractor_used, 'llm')
  assert.equal(out.confidence, 0.72)
  assert.deepEqual(out.counterfactual_suggestions, [])
  assert.equal(out.joint_counterfactual, null)
})
