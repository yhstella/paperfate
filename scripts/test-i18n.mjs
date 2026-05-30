#!/usr/bin/env node
// Unit tests for src/lib/i18n.js bundle shape + t() resolution logic.
//
// We CANNOT import i18n.js directly under node:test because it depends on
// React (useEffect/useState) and on window/navigator. Instead:
//
//   (1) Read messages-ko.json and messages-en.json via node:fs and check
//       structural symmetry (every leaf key in one exists in the other).
//   (2) Reproduce t() / lookup() / interpolate() logic inline and check
//       dotted-path resolution, fallback chain, {var} interpolation, and
//       missing-key behaviour.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const KO_PATH = join(REPO_ROOT, 'src', 'lib', 'messages-ko.json')
const EN_PATH = join(REPO_ROOT, 'src', 'lib', 'messages-en.json')

// ── Bundle loading ──────────────────────────────────────────────────────────
function loadBundle(path) {
  const raw = readFileSync(path, 'utf8')
  return { raw, parsed: JSON.parse(raw) }
}

const KO = loadBundle(KO_PATH)
const EN = loadBundle(EN_PATH)

// ── Leaf-key walker ─────────────────────────────────────────────────────────
function collectLeafKeys(obj, prefix = '', out = []) {
  if (obj == null) return out
  if (typeof obj !== 'object') {
    out.push(prefix)
    return out
  }
  for (const k of Object.keys(obj)) {
    const childPrefix = prefix ? `${prefix}.${k}` : k
    collectLeafKeys(obj[k], childPrefix, out)
  }
  return out
}

function getByPath(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
    else return undefined
  }
  return cur
}

// ── t() reproduced from src/lib/i18n.js ─────────────────────────────────────
function lookup(bundle, path) {
  if (!bundle || typeof bundle !== 'object') return undefined
  const parts = path.split('.')
  let cur = bundle
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
    else return undefined
  }
  return typeof cur === 'string' ? cur : undefined
}

function interpolate(template, vars) {
  if (!vars || typeof vars !== 'object') return template
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name]
      return v == null ? '' : String(v)
    }
    return match
  })
}

function makeT(locale, bundles) {
  return function t(key, vars) {
    if (typeof key !== 'string' || !key) return ''
    let msg = lookup(bundles[locale], key)
    if (msg === undefined && locale !== 'en') {
      msg = lookup(bundles.en, key)
    }
    if (msg === undefined) return key
    return interpolate(msg, vars)
  }
}

const BUNDLES = { ko: KO.parsed, en: EN.parsed }

// ── Tests ───────────────────────────────────────────────────────────────────

test('i18n: messages-ko.json parses as valid JSON', () => {
  assert.equal(typeof KO.parsed, 'object')
  assert.ok(KO.parsed && !Array.isArray(KO.parsed), 'top-level is object')
})

test('i18n: messages-en.json parses as valid JSON', () => {
  assert.equal(typeof EN.parsed, 'object')
  assert.ok(EN.parsed && !Array.isArray(EN.parsed), 'top-level is object')
})

test('i18n: every top-level group in ko exists in en (and vice versa)', () => {
  const koGroups = Object.keys(KO.parsed).sort()
  const enGroups = Object.keys(EN.parsed).sort()
  assert.deepEqual(koGroups, enGroups, 'top-level keys must match')
})

test('i18n: every leaf key in ko exists in en (shape symmetry)', () => {
  const koLeaves = collectLeafKeys(KO.parsed).sort()
  const enLeaves = collectLeafKeys(EN.parsed).sort()
  const missingInEn = koLeaves.filter((k) => !enLeaves.includes(k))
  assert.deepEqual(missingInEn, [], `Korean keys missing from English: ${missingInEn.join(', ')}`)
})

test('i18n: every leaf key in en exists in ko (shape symmetry)', () => {
  const koLeaves = collectLeafKeys(KO.parsed).sort()
  const enLeaves = collectLeafKeys(EN.parsed).sort()
  const missingInKo = enLeaves.filter((k) => !koLeaves.includes(k))
  assert.deepEqual(missingInKo, [], `English keys missing from Korean: ${missingInKo.join(', ')}`)
})

test('i18n: no leaf has empty string value (ko)', () => {
  const leaves = collectLeafKeys(KO.parsed)
  const empties = leaves.filter((k) => getByPath(KO.parsed, k) === '')
  assert.deepEqual(empties, [], `empty ko strings: ${empties.join(', ')}`)
})

test('i18n: no leaf has empty string value (en)', () => {
  const leaves = collectLeafKeys(EN.parsed)
  const empties = leaves.filter((k) => getByPath(EN.parsed, k) === '')
  assert.deepEqual(empties, [], `empty en strings: ${empties.join(', ')}`)
})

test('i18n: dotted-path resolution works for nested groups', () => {
  const tKo = makeT('ko', BUNDLES)
  const tEn = makeT('en', BUNDLES)
  // Compare columns.jif exists in both bundles.
  assert.equal(tKo('compare.columns.jif'), 'JIF')
  assert.equal(tEn('compare.columns.jif'), 'JIF')
  // simulator.title differs across locales — pick a key that exists.
  assert.ok(tKo('simulator.title').length > 0)
  assert.ok(tEn('simulator.title').length > 0)
})

test('i18n: missing-key fallback returns the key string itself', () => {
  const tKo = makeT('ko', BUNDLES)
  const tEn = makeT('en', BUNDLES)
  assert.equal(tKo('does.not.exist'), 'does.not.exist')
  assert.equal(tEn('also.missing.key'), 'also.missing.key')
  // Empty/invalid keys → empty string.
  assert.equal(tKo(''), '')
  assert.equal(tKo(null), '')
})

test('i18n: ko falls back to en when ko-only key is missing', () => {
  // Inject a synthetic bundle missing a key in ko but present in en.
  const synth = {
    ko: { ...KO.parsed, extra: { only_in_en: undefined } },
    en: { ...EN.parsed, extra: { only_in_en: 'English-only message' } },
  }
  const t = makeT('ko', synth)
  assert.equal(t('extra.only_in_en'), 'English-only message')
})

test('i18n: {var} interpolation substitutes placeholders', () => {
  // Build a tiny bundle for clean assertions.
  const synth = {
    ko: { greet: { hello: '안녕하세요, {name}님 ({count})' } },
    en: { greet: { hello: 'Hello, {name} ({count})' } },
  }
  const tKo = makeT('ko', synth)
  const tEn = makeT('en', synth)
  assert.equal(tKo('greet.hello', { name: '철수', count: 3 }), '안녕하세요, 철수님 (3)')
  assert.equal(tEn('greet.hello', { name: 'Alice', count: 7 }), 'Hello, Alice (7)')
  // Missing var leaves the placeholder intact.
  assert.equal(tEn('greet.hello', { name: 'Bob' }), 'Hello, Bob ({count})')
  // null/undefined var renders as empty string.
  assert.equal(tEn('greet.hello', { name: null, count: null }), 'Hello,  ()')
})

test('i18n: interpolation skips when no vars passed', () => {
  const synth = {
    ko: { msg: { x: 'plain {var}' } },
    en: { msg: { x: 'plain {var}' } },
  }
  const t = makeT('en', synth)
  // No vars argument -> template returned verbatim, braces left alone.
  assert.equal(t('msg.x'), 'plain {var}')
})
