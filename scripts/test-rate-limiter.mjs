#!/usr/bin/env node
// Unit tests for the in-memory token-bucket rate limiter from api/forecast.js.
// We REPRODUCE the bucket inline so we can inject a fake clock and test the
// refill curve without waiting an hour.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── Copied from api/forecast.js (with `now` injected for testability) ──────
const RATE_LIMIT_PER_HOUR = 30
const RATE_WINDOW_MS = 60 * 60 * 1000
const RATE_REFILL_PER_SEC = RATE_LIMIT_PER_HOUR / 3600
const PRUNE_INTERVAL_MS = 60 * 1000

function makeLimiter({ nowRef }) {
  const buckets = new Map()
  let lastPruneTs = 0

  function pruneBuckets(now) {
    if (now - lastPruneTs < PRUNE_INTERVAL_MS) return
    lastPruneTs = now
    const cutoff = now - RATE_WINDOW_MS
    for (const [ip, b] of buckets) {
      if (b.lastRefillTs < cutoff) buckets.delete(ip)
    }
  }

  function takeToken(ip) {
    const now = nowRef.value
    pruneBuckets(now)
    let b = buckets.get(ip)
    if (!b) {
      b = { tokens: RATE_LIMIT_PER_HOUR, lastRefillTs: now }
      buckets.set(ip, b)
    } else {
      const elapsedSec = (now - b.lastRefillTs) / 1000
      if (elapsedSec > 0) {
        b.tokens = Math.min(RATE_LIMIT_PER_HOUR, b.tokens + elapsedSec * RATE_REFILL_PER_SEC)
        b.lastRefillTs = now
      }
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      return { ok: true }
    }
    const deficit = 1 - b.tokens
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / RATE_REFILL_PER_SEC))
    return { ok: false, retryAfterSeconds }
  }

  function bypass(req, envToken) {
    if (!envToken) return false
    const got = req.headers['x-paperfate-internal']
    return typeof got === 'string' && got === envToken
  }

  return { takeToken, bypass, buckets }
}

// ── Tests ──────────────────────────────────────────────────────────────────
test('rate limiter: first 30 requests for a single IP pass', () => {
  const nowRef = { value: 1_000_000 }
  const { takeToken } = makeLimiter({ nowRef })
  for (let i = 1; i <= 30; i++) {
    const r = takeToken('1.2.3.4')
    assert.equal(r.ok, true, `request #${i} should pass, got ${JSON.stringify(r)}`)
  }
})

test('rate limiter: 31st request returns retryAfter > 0', () => {
  const nowRef = { value: 1_000_000 }
  const { takeToken } = makeLimiter({ nowRef })
  for (let i = 1; i <= 30; i++) takeToken('1.2.3.4')
  const r = takeToken('1.2.3.4')
  assert.equal(r.ok, false)
  assert.ok(typeof r.retryAfterSeconds === 'number', 'retryAfterSeconds is a number')
  assert.ok(r.retryAfterSeconds > 0, `retryAfter > 0, got ${r.retryAfterSeconds}`)
})

test('rate limiter: after 2 minute synthetic clock advance, additional tokens accrue', () => {
  const nowRef = { value: 1_000_000 }
  const { takeToken } = makeLimiter({ nowRef })
  // Drain the bucket
  for (let i = 1; i <= 30; i++) takeToken('1.2.3.4')
  let r = takeToken('1.2.3.4')
  assert.equal(r.ok, false, 'should be exhausted')

  // Advance the clock 2 minutes (120s). Refill rate = 30/3600 = ~0.00833 tok/s.
  // 120 * 0.00833 ≈ 1.0 tokens → exactly 1 request becomes available.
  nowRef.value += 2 * 60 * 1000
  r = takeToken('1.2.3.4')
  assert.equal(r.ok, true, '1st post-advance request should pass')

  // After spending 1, bucket is ~0 again
  r = takeToken('1.2.3.4')
  assert.equal(r.ok, false, '2nd post-advance request should be rejected')
})

test('rate limiter: separate IPs do not share a bucket', () => {
  const nowRef = { value: 1_000_000 }
  const { takeToken } = makeLimiter({ nowRef })
  for (let i = 1; i <= 30; i++) takeToken('1.1.1.1')
  // 1.1.1.1 is drained; 2.2.2.2 must still have a fresh 30.
  for (let i = 1; i <= 30; i++) {
    const r = takeToken('2.2.2.2')
    assert.equal(r.ok, true, `IP 2.2.2.2 req #${i}`)
  }
  // And 2.2.2.2's 31st must fail
  const r = takeToken('2.2.2.2')
  assert.equal(r.ok, false)
})

test('rate limiter: bypass token works when env matches header', () => {
  const nowRef = { value: 1_000_000 }
  const { bypass } = makeLimiter({ nowRef })
  const envToken = 'secret-internal-token'
  const reqOk   = { headers: { 'x-paperfate-internal': 'secret-internal-token' } }
  const reqBad  = { headers: { 'x-paperfate-internal': 'wrong' } }
  const reqNone = { headers: {} }
  assert.equal(bypass(reqOk, envToken),   true)
  assert.equal(bypass(reqBad, envToken),  false)
  assert.equal(bypass(reqNone, envToken), false)
  // When env token is empty/undefined, bypass is always false.
  assert.equal(bypass(reqOk, undefined),  false)
  assert.equal(bypass(reqOk, ''),         false)
})

test('rate limiter: long advance fully refills (capped at RATE_LIMIT_PER_HOUR)', () => {
  const nowRef = { value: 1_000_000 }
  const { takeToken } = makeLimiter({ nowRef })
  for (let i = 1; i <= 30; i++) takeToken('1.2.3.4')
  // Advance 2 hours — bucket should refill but cap at 30.
  nowRef.value += 2 * 60 * 60 * 1000
  let passed = 0
  for (let i = 1; i <= 35; i++) {
    if (takeToken('1.2.3.4').ok) passed++
    else break
  }
  assert.equal(passed, 30, `bucket should cap at 30, got ${passed}`)
})
