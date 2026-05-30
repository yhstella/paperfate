// PaperFate · Theme switcher infrastructure.
//
// Three theme values: 'light' | 'dark' | 'system'. 'system' tracks the
// OS-level prefers-color-scheme and updates live when the user changes
// their system theme.
//
// Storage:
//   - localStorage key 'paperfate.theme' holds the user's explicit
//     preference. Absence (or any invalid value) is treated as 'system'.
//
// API:
//   - getTheme() returns the currently-stored theme value
//     ('light' | 'dark' | 'system'). Defaults to 'system'.
//   - resolveTheme(theme) returns the *effective* theme that should be
//     painted: 'light' or 'dark'. For 'system' this consults
//     window.matchMedia('(prefers-color-scheme: dark)').
//   - applyTheme(theme) writes the resolved value to
//     document.documentElement's `data-theme` attribute so CSS / Tailwind
//     can react. Idempotent and SSR-safe.
//   - setTheme(theme) persists, applies, and notifies subscribers.
//   - useTheme() React hook returns { theme, resolved, setTheme } and
//     subscribes to both the storage event (cross-tab) and the
//     matchMedia change event (live OS theme follow when in 'system').
//
// Reactivity event: 'paperfate:theme-changed' CustomEvent on window.
// Detail shape: { theme, resolved }.
//
// SSR safety: importing this module never touches window. All browser
// access is guarded.

import { useEffect, useState, useCallback } from 'react'

export const THEME_VALUES = ['light', 'dark', 'system']
const THEME_SET = new Set(THEME_VALUES)
export const DEFAULT_THEME = 'system'
export const STORAGE_KEY = 'paperfate.theme'
export const EVENT_NAME = 'paperfate:theme-changed'
const MEDIA_QUERY = '(prefers-color-scheme: dark)'

function isValid(theme) {
  return typeof theme === 'string' && THEME_SET.has(theme)
}

export function getTheme() {
  if (typeof window === 'undefined') return DEFAULT_THEME
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (isValid(stored)) return stored
    }
  } catch { /* private mode / disabled storage — ignore */ }
  return DEFAULT_THEME
}

export function resolveTheme(theme) {
  const t = isValid(theme) ? theme : DEFAULT_THEME
  if (t === 'light' || t === 'dark') return t
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark'
  }
  try {
    return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme) {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(theme)
  try {
    document.documentElement.setAttribute('data-theme', resolved)
  } catch { /* ignore */ }
}

export function setTheme(theme) {
  if (!isValid(theme)) return
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, theme)
    }
  } catch { /* ignore */ }
  applyTheme(theme)
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      const resolved = resolveTheme(theme)
      window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: { theme, resolved },
      }))
    }
  } catch { /* ignore */ }
}

export function useTheme() {
  const [theme, setThemeState] = useState(() => getTheme())
  const [resolved, setResolvedState] = useState(() => resolveTheme(getTheme()))

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const refresh = () => {
      const next = getTheme()
      setThemeState(next)
      setResolvedState(resolveTheme(next))
    }

    // Cross-tab + same-tab via our custom event.
    const onCustom = (e) => {
      const detail = e && e.detail
      if (detail && isValid(detail.theme)) {
        setThemeState(detail.theme)
        setResolvedState(
          detail.resolved === 'light' || detail.resolved === 'dark'
            ? detail.resolved
            : resolveTheme(detail.theme)
        )
      } else {
        refresh()
      }
    }
    window.addEventListener(EVENT_NAME, onCustom)

    // Cross-tab via the native storage event.
    const onStorage = (e) => {
      if (!e || e.key !== STORAGE_KEY) return
      refresh()
    }
    window.addEventListener('storage', onStorage)

    // Live OS-theme follow when the stored preference is 'system'.
    let mql = null
    let onMqlChange = null
    if (typeof window.matchMedia === 'function') {
      try {
        mql = window.matchMedia(MEDIA_QUERY)
        onMqlChange = () => {
          // Only matters when in system mode — but cheap to recompute
          // either way so we always refresh the resolved value.
          setResolvedState(resolveTheme(getTheme()))
        }
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', onMqlChange)
        } else if (typeof mql.addListener === 'function') {
          // Safari < 14 fallback.
          mql.addListener(onMqlChange)
        }
      } catch { /* ignore */ }
    }

    return () => {
      window.removeEventListener(EVENT_NAME, onCustom)
      window.removeEventListener('storage', onStorage)
      if (mql && onMqlChange) {
        try {
          if (typeof mql.removeEventListener === 'function') {
            mql.removeEventListener('change', onMqlChange)
          } else if (typeof mql.removeListener === 'function') {
            mql.removeListener(onMqlChange)
          }
        } catch { /* ignore */ }
      }
    }
  }, [])

  const set = useCallback((next) => {
    if (!isValid(next)) return
    setTheme(next)
  }, [])

  return { theme, resolved, setTheme: set }
}
