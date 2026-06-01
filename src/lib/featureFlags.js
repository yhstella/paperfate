// PaperFate · Feature flags library.
//
// Lightweight client-side feature-flag store backed by localStorage. The
// flag set is intentionally small — these are operator-facing toggles
// surfaced in the Admin panel, not a full A/B framework.
//
// Storage:
//   - localStorage key 'paperfate.flags' holds a JSON object mapping
//     flag-name -> boolean. Unknown keys are ignored on read so removing
//     a flag from DEFAULT_FLAGS doesn't break older persisted state.
//
// API:
//   - DEFAULT_FLAGS               — canonical flag set + ship-defaults.
//   - getAllFlags()               — { name -> bool }, merged over defaults.
//   - isEnabled(name)             — bool for a single flag (defaults if
//                                   unknown / unset).
//   - setFlag(name, value)        — persists + dispatches the change
//                                   event. No-op for unknown names.
//   - resetFlags()                — clears the override, dispatches a
//                                   single change event covering all
//                                   flags reverting to defaults.
//   - useFlag(name)               — React hook returning the current
//                                   boolean and subscribing to changes
//                                   (custom event + cross-tab storage).
//
// Reactivity event: 'paperfate:flag-changed' CustomEvent on window.
//   detail shape: { name, value, all }
//   where 'name' is null for bulk events (reset / cross-tab refresh) and
//   'all' is the freshly-merged flag map.
//
// SSR safety: importing this module never touches window. All browser
// access is guarded — calls return defaults when window/localStorage are
// unavailable.

import { useEffect, useState, useCallback } from 'react'

export const STORAGE_KEY = 'paperfate.flags'
export const EVENT_NAME = 'paperfate:flag-changed'

// Canonical default flag set. Adding a flag here automatically exposes
// it through getAllFlags() / the Admin UI. Keep keys camelCase.
export const DEFAULT_FLAGS = Object.freeze({
  experimentalAdjustedBlend: false,
  showCmdKHint: true,
  enableFeedbackWidget: false,
  useNewProgressBar: false,
})

// Frozen list of valid flag names — used for cheap membership checks
// without exposing a mutable Set.
const FLAG_NAMES = Object.freeze(Object.keys(DEFAULT_FLAGS))

function isKnown(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_FLAGS, name)
}

// Defensive localStorage read. Returns an empty object for any error
// (private mode, quota, JSON corruption, SSR). Filters out unknown keys
// and coerces values to strict booleans so downstream code can treat
// the map as { string -> bool }.
function readStored() {
  if (typeof window === 'undefined') return {}
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out = {}
    for (const key of FLAG_NAMES) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        out[key] = parsed[key] === true
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeStored(map) {
  if (typeof window === 'undefined') return
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch { /* private mode / quota — ignore */ }
}

function dispatchChange(name, value, all) {
  if (typeof window === 'undefined') return
  if (typeof CustomEvent !== 'function') return
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: { name, value, all },
    }))
  } catch { /* ignore */ }
}

// Returns the fully-merged flag map: defaults overlaid with persisted
// overrides. The returned object is a fresh copy — callers may mutate
// without affecting future reads.
export function getAllFlags() {
  const overrides = readStored()
  const out = {}
  for (const key of FLAG_NAMES) {
    out[key] = Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : DEFAULT_FLAGS[key]
  }
  return out
}

export function isEnabled(name) {
  if (!isKnown(name)) return false
  const overrides = readStored()
  if (Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name] === true
  }
  return DEFAULT_FLAGS[name] === true
}

export function setFlag(name, value) {
  if (!isKnown(name)) return
  const next = value === true
  // Read the raw override map (not merged-with-defaults) so we only
  // persist explicit user choices. This keeps the stored object minimal
  // and lets DEFAULT_FLAGS evolve without orphaning stale values.
  const overrides = readStored()
  overrides[name] = next
  writeStored(overrides)
  const all = getAllFlags()
  dispatchChange(name, next, all)
}

// Clears every override so all flags revert to DEFAULT_FLAGS. Emits one
// bulk event (name === null) which subscribers treat as 'recompute'.
export function resetFlags() {
  if (typeof window !== 'undefined') {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch { /* ignore */ }
  }
  const all = getAllFlags()
  dispatchChange(null, null, all)
}

// React hook: subscribe to a single flag. Re-renders on
// 'paperfate:flag-changed' (same-tab) and the native 'storage' event
// (cross-tab). SSR-safe — initial state falls back to the default.
export function useFlag(name) {
  const [value, setValue] = useState(() => isEnabled(name))

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!isKnown(name)) return undefined

    const refresh = () => setValue(isEnabled(name))

    const onCustom = (e) => {
      const detail = e && e.detail
      // Bulk event (reset / cross-tab refresh) — always recompute.
      if (!detail || detail.name == null) {
        if (detail && detail.all && Object.prototype.hasOwnProperty.call(detail.all, name)) {
          setValue(detail.all[name] === true)
        } else {
          refresh()
        }
        return
      }
      if (detail.name === name) {
        setValue(detail.value === true)
      }
    }
    window.addEventListener(EVENT_NAME, onCustom)

    const onStorage = (e) => {
      if (!e || e.key !== STORAGE_KEY) return
      refresh()
    }
    window.addEventListener('storage', onStorage)

    // Pick up any value that drifted between initial useState and the
    // effect attaching (e.g. another tab flipping the flag mid-mount).
    refresh()

    return () => {
      window.removeEventListener(EVENT_NAME, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [name])

  return value
}
