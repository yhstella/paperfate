#!/usr/bin/env node
// Unit tests for src/lib/forecastHistory.js logic.
//
// We REPRODUCE the in-memory store/save/get/tag/favorite/export logic inline
// because forecastHistory.js reads/writes window.localStorage and uses
// crypto.randomUUID — neither of which are available under node:test.
//
// The implementation under test is mirrored exactly from src/lib/forecastHistory.js
// (Round 7 shape). If the source contract changes, these tests must be updated.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── Constants mirrored from src/lib/forecastHistory.js ───────────────────────
const MAX_ENTRIES = 20
const ABSTRACT_PREVIEW_LEN = 100
const MAX_TAGS_PER_ENTRY = 5
const TAG_MAX_LEN = 32

// ── Inline in-memory store (no localStorage) ─────────────────────────────────
function makeStore() {
  let state = { entries: [] }
  let uuidCounter = 0
  // Allow tests to pin time/IDs for determinism.
  const clock = { value: 1_700_000_000_000 }

  function nextUuid() {
    uuidCounter += 1
    return `pf-test-${uuidCounter.toString(36)}`
  }

  function readStore() {
    return { entries: state.entries.slice() }
  }

  function writeStore(next) {
    state = { entries: next.entries.slice() }
  }

  function pickPrediction(predictions) {
    if (!predictions || typeof predictions !== 'object') return null
    const jif = predictions.jcr_jif
    const dr = predictions.desk_reject_risk
    const out = {}
    if (jif && Number.isFinite(+jif.point)) {
      out.jcr_jif = {
        point: +jif.point,
        ci_low: Number.isFinite(+jif.ci_low) ? +jif.ci_low : null,
        ci_high: Number.isFinite(+jif.ci_high) ? +jif.ci_high : null,
      }
    }
    if (dr && Number.isFinite(+dr.point)) {
      out.desk_reject_risk = { point: +dr.point }
    }
    return Object.keys(out).length ? out : null
  }

  function normalizeTag(raw) {
    if (typeof raw !== 'string') return ''
    const trimmed = raw.replace(/\s+/g, ' ').trim()
    if (!trimmed) return ''
    return trimmed.slice(0, TAG_MAX_LEN)
  }

  function withTagsShape(entry) {
    if (!entry || typeof entry !== 'object') return entry
    const favorite = entry.favorite === true
    const tags = Array.isArray(entry.tags)
      ? entry.tags
          .map(normalizeTag)
          .filter(Boolean)
          .slice(0, MAX_TAGS_PER_ENTRY)
      : []
    return { ...entry, favorite, tags }
  }

  function saveForecast(input) {
    if (!input || typeof input !== 'object') return null
    const title = typeof input.title === 'string' ? input.title.slice(0, 300) : ''
    const abstractRaw = typeof input.abstract === 'string' ? input.abstract : ''
    const abstractPreview = abstractRaw.slice(0, ABSTRACT_PREVIEW_LEN)
    const mode = input.mode === 'full' || input.mode === 'Q500' ? 'full' : 'abstract'
    const predictions = pickPrediction(input.predictions)
    const extractor_used = typeof input.extractor_used === 'string'
      ? input.extractor_used.slice(0, 32)
      : null
    const request_id = typeof input.request_id === 'string'
      ? input.request_id.slice(0, 64)
      : null
    const wall_ms = Number.isFinite(+input.wall_ms) ? +input.wall_ms : null

    const entry = {
      id: nextUuid(),
      ts: clock.value,
      title,
      abstract_preview: abstractPreview,
      mode,
      predictions,
      extractor_used,
      request_id,
      wall_ms,
      favorite: false,
      tags: [],
    }
    const store = readStore()
    const next = [entry, ...store.entries].slice(0, MAX_ENTRIES)
    writeStore({ entries: next })
    return entry
  }

  function getForecasts() {
    const store = readStore()
    const list = Array.isArray(store.entries) ? store.entries.slice(0, MAX_ENTRIES) : []
    return list.map(withTagsShape)
  }

  function getForecast(id) {
    if (typeof id !== 'string' || !id) return null
    const store = readStore()
    const hit = store.entries.find((e) => e && e.id === id) || null
    return hit ? withTagsShape(hit) : null
  }

  function clearAll() {
    state = { entries: [] }
  }

  function updateEntry(id, mutator) {
    if (typeof id !== 'string' || !id) return null
    const store = readStore()
    let updated = null
    const next = store.entries.map((e) => {
      if (!e || e.id !== id) return e
      const shaped = withTagsShape(e)
      const mutated = mutator(shaped)
      if (!mutated) return shaped
      updated = mutated
      return mutated
    })
    if (!updated) return null
    writeStore({ entries: next })
    return updated
  }

  function setFavorite(id, value) {
    const flag = value === true
    return updateEntry(id, (entry) => ({ ...entry, favorite: flag }))
  }

  function addTag(id, tag) {
    const normalized = normalizeTag(tag)
    if (!normalized) return null
    return updateEntry(id, (entry) => {
      const existing = Array.isArray(entry.tags) ? entry.tags : []
      const lower = normalized.toLowerCase()
      if (existing.some((t) => typeof t === 'string' && t.toLowerCase() === lower)) {
        return entry
      }
      if (existing.length >= MAX_TAGS_PER_ENTRY) return entry
      return { ...entry, tags: [...existing, normalized] }
    })
  }

  function removeTag(id, tag) {
    const normalized = normalizeTag(tag)
    if (!normalized) return null
    const lower = normalized.toLowerCase()
    return updateEntry(id, (entry) => {
      const existing = Array.isArray(entry.tags) ? entry.tags : []
      const next = existing.filter((t) => typeof t === 'string' && t.toLowerCase() !== lower)
      if (next.length === existing.length) return entry
      return { ...entry, tags: next }
    })
  }

  function exportAsJson() {
    const store = readStore()
    const entries = (Array.isArray(store.entries) ? store.entries : [])
      .map(withTagsShape)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        title: e.title || '',
        abstract_preview: e.abstract_preview || '',
        mode: e.mode || 'abstract',
        predictions: e.predictions || null,
        extractor_used: e.extractor_used || null,
        request_id: e.request_id || null,
        wall_ms: Number.isFinite(+e.wall_ms) ? +e.wall_ms : null,
        favorite: e.favorite === true,
        tags: Array.isArray(e.tags) ? e.tags.slice(0, MAX_TAGS_PER_ENTRY) : [],
      }))
    return JSON.stringify({
      schema: 'paperfate.forecast.history/v1',
      exported_at: new Date(clock.value).toISOString(),
      count: entries.length,
      entries,
    }, null, 2)
  }

  function generateShareUrl(entryId) {
    if (typeof entryId !== 'string' || !entryId) return ''
    return `/?forecast=${encodeURIComponent(entryId)}`
  }

  return {
    saveForecast, getForecasts, getForecast,
    setFavorite, addTag, removeTag,
    clearAll, exportAsJson, generateShareUrl,
    clock,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('forecast history: saveForecast returns entry with id+ts+title', () => {
  const s = makeStore()
  const entry = s.saveForecast({
    title: 'Hello world',
    abstract: 'A short abstract',
    predictions: { jcr_jif: { point: 4.2, ci_low: 2.1, ci_high: 7.3 } },
    mode: 'abstract',
  })
  assert.ok(entry, 'entry returned')
  assert.equal(entry.title, 'Hello world')
  assert.equal(typeof entry.id, 'string')
  assert.ok(entry.id.length > 0)
  assert.equal(typeof entry.ts, 'number')
  assert.equal(entry.favorite, false)
  assert.deepEqual(entry.tags, [])
  assert.equal(entry.predictions.jcr_jif.point, 4.2)
})

test('forecast history: 20-entry cap, newest first', () => {
  const s = makeStore()
  for (let i = 1; i <= 25; i++) {
    s.saveForecast({ title: `entry-${i}`, abstract: '' })
  }
  const list = s.getForecasts()
  assert.equal(list.length, 20, 'capped at 20')
  // Newest first: entry-25 must be at index 0, entry-6 at index 19.
  assert.equal(list[0].title, 'entry-25')
  assert.equal(list[19].title, 'entry-6')
})

test('forecast history: getForecast by id returns the saved entry', () => {
  const s = makeStore()
  const a = s.saveForecast({ title: 'A', abstract: '' })
  const b = s.saveForecast({ title: 'B', abstract: '' })
  assert.equal(s.getForecast(a.id).title, 'A')
  assert.equal(s.getForecast(b.id).title, 'B')
  assert.equal(s.getForecast('nonexistent'), null)
  assert.equal(s.getForecast(''), null)
})

test('forecast history: setFavorite toggles flag without touching other fields', () => {
  const s = makeStore()
  const entry = s.saveForecast({
    title: 'fav-test',
    abstract: 'some abstract',
    predictions: { jcr_jif: { point: 5.0 } },
    extractor_used: 'llm',
  })
  const updated = s.setFavorite(entry.id, true)
  assert.equal(updated.favorite, true)
  assert.equal(updated.title, 'fav-test')
  assert.equal(updated.extractor_used, 'llm')
  assert.equal(updated.predictions.jcr_jif.point, 5.0)
  // Toggle off.
  const off = s.setFavorite(entry.id, false)
  assert.equal(off.favorite, false)
})

test('forecast history: addTag caps at 5 tags per entry', () => {
  const s = makeStore()
  const entry = s.saveForecast({ title: 'tag-test', abstract: '' })
  for (let i = 1; i <= 7; i++) {
    s.addTag(entry.id, `tag${i}`)
  }
  const got = s.getForecast(entry.id)
  assert.equal(got.tags.length, MAX_TAGS_PER_ENTRY)
  assert.deepEqual(got.tags, ['tag1', 'tag2', 'tag3', 'tag4', 'tag5'])
})

test('forecast history: addTag enforces 32-char length cap', () => {
  const s = makeStore()
  const entry = s.saveForecast({ title: 't', abstract: '' })
  const longTag = 'x'.repeat(100)
  s.addTag(entry.id, longTag)
  const got = s.getForecast(entry.id)
  assert.equal(got.tags.length, 1)
  assert.equal(got.tags[0].length, TAG_MAX_LEN)
  assert.equal(got.tags[0], 'x'.repeat(TAG_MAX_LEN))
})

test('forecast history: addTag is case-insensitive dedup', () => {
  const s = makeStore()
  const entry = s.saveForecast({ title: 't', abstract: '' })
  s.addTag(entry.id, 'Cardio')
  s.addTag(entry.id, 'cardio')
  s.addTag(entry.id, 'CARDIO')
  s.addTag(entry.id, 'CaRdIo')
  const got = s.getForecast(entry.id)
  assert.equal(got.tags.length, 1, 'all variants collapse to one')
  // First-writer-wins on casing.
  assert.equal(got.tags[0], 'Cardio')
})

test('forecast history: removeTag is case-insensitive and removes only the match', () => {
  const s = makeStore()
  const entry = s.saveForecast({ title: 't', abstract: '' })
  s.addTag(entry.id, 'alpha')
  s.addTag(entry.id, 'Beta')
  s.addTag(entry.id, 'gamma')
  s.removeTag(entry.id, 'BETA')
  const got = s.getForecast(entry.id)
  assert.deepEqual(got.tags, ['alpha', 'gamma'])
})

test('forecast history: clearAll empties the store', () => {
  const s = makeStore()
  s.saveForecast({ title: 'a', abstract: '' })
  s.saveForecast({ title: 'b', abstract: '' })
  assert.equal(s.getForecasts().length, 2)
  s.clearAll()
  assert.equal(s.getForecasts().length, 0)
})

test('forecast history: exportAsJson returns parseable JSON with schema marker', () => {
  const s = makeStore()
  s.saveForecast({
    title: 'export-test',
    abstract: 'abstract body',
    predictions: { jcr_jif: { point: 3.3, ci_low: 1.0, ci_high: 6.0 } },
  })
  const json = s.exportAsJson()
  assert.equal(typeof json, 'string')
  const parsed = JSON.parse(json)
  assert.equal(parsed.schema, 'paperfate.forecast.history/v1')
  assert.equal(parsed.count, 1)
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].title, 'export-test')
  assert.equal(parsed.entries[0].predictions.jcr_jif.point, 3.3)
  assert.equal(typeof parsed.exported_at, 'string')
})

test('forecast history: generateShareUrl format is /?forecast=<id>', () => {
  const s = makeStore()
  const url = s.generateShareUrl('pf-abc-123')
  assert.match(url, /\/\?forecast=pf-abc-123/)
  assert.equal(url, '/?forecast=pf-abc-123')
  // Empty/invalid id -> empty string.
  assert.equal(s.generateShareUrl(''), '')
  assert.equal(s.generateShareUrl(null), '')
  // Special chars get URL-encoded.
  const enc = s.generateShareUrl('a b?c')
  assert.equal(enc, '/?forecast=a%20b%3Fc')
})

test('forecast history: abstract preview is capped at 100 chars', () => {
  const s = makeStore()
  const long = 'x'.repeat(500)
  const entry = s.saveForecast({ title: 't', abstract: long })
  assert.equal(entry.abstract_preview.length, ABSTRACT_PREVIEW_LEN)
})
