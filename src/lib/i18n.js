// PaperFate · Minimal i18n shim.
//
// Single export `t(key, vars)`:
//   - `key` is a dotted path, e.g. 'simulator.submit_button'.
//   - `vars` is an optional interpolation object, e.g. {n: 3} — any
//     occurrence of `{n}` in the message string is replaced by String(n).
//
// Locale detection:
//   - navigator.language.startsWith('ko') -> 'ko', else 'en'.
//   - localStorage 'paperfate.locale' overrides the above (must be 'ko'
//     or 'en' — anything else is ignored).
//   - SSR safe: locale detection runs lazily on first t() call, not at
//     module top, so importing this file never touches window/navigator.
//
// Fallback chain: ko -> en -> the raw key. Missing keys never throw;
// they degrade to the english string, then to the key itself.
//
// Reactivity:
//   - setLocale(locale) persists to localStorage and dispatches the
//     'paperfate:locale-changed' CustomEvent on window so subscribers
//     (e.g. useLocale) can re-render.
//   - useLocale() is a React hook returning the current locale; it
//     subscribes to the same event and re-renders consumers on change.
//
// This module is intentionally tiny — no third-party i18n runtime.

import { useEffect, useState } from 'react'
import koMessages from './messages-ko.json'
import enMessages from './messages-en.json'

const BUNDLES = { ko: koMessages, en: enMessages }
const DEFAULT_LOCALE = 'ko'
const STORAGE_KEY = 'paperfate.locale'
const EVENT_NAME = 'paperfate:locale-changed'

let cachedLocale = null

function detectLocale() {
  // SSR / non-browser: just return the default.
  if (typeof window === 'undefined') return DEFAULT_LOCALE

  // localStorage override.
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'ko' || stored === 'en') return stored
    }
  } catch { /* private mode etc. — ignore */ }

  // navigator.language sniff.
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
      if (navigator.language.toLowerCase().startsWith('ko')) return 'ko'
      return 'en'
    }
  } catch { /* ignore */ }

  return DEFAULT_LOCALE
}

export function getLocale() {
  if (cachedLocale) return cachedLocale
  cachedLocale = detectLocale()
  return cachedLocale
}

export function setLocale(locale) {
  if (locale !== 'ko' && locale !== 'en') return
  cachedLocale = locale

  // Persist (best-effort).
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, locale)
    }
  } catch { /* private mode etc. — ignore */ }

  // Notify subscribers.
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { locale } }))
    }
  } catch { /* ignore */ }
}

export function useLocale() {
  const [locale, setLocaleState] = useState(() => getLocale())

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const handler = (e) => {
      const next = (e && e.detail && e.detail.locale) || getLocale()
      setLocaleState(next)
    }
    window.addEventListener(EVENT_NAME, handler)
    return () => window.removeEventListener(EVENT_NAME, handler)
  }, [])

  return locale
}

function lookup(bundle, path) {
  if (!bundle || typeof bundle !== 'object') return undefined
  const parts = path.split('.')
  let cur = bundle
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) {
      cur = cur[p]
    } else {
      return undefined
    }
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

export function t(key, vars) {
  if (typeof key !== 'string' || !key) return ''
  const locale = getLocale()

  // Primary lookup in detected locale.
  let msg = lookup(BUNDLES[locale], key)

  // Fallback to English for missing keys (only if not already english).
  if (msg === undefined && locale !== 'en') {
    msg = lookup(BUNDLES.en, key)
  }

  // Last-resort fallback: return the key so missing strings are visible
  // in dev rather than rendering as empty.
  if (msg === undefined) return key

  return interpolate(msg, vars)
}

// Test / dev helper — resets the cached locale so a subsequent t() call
// re-detects. Not part of the public contract, but harmless if called.
export function _resetLocaleCache() {
  cachedLocale = null
}
