// PaperFate · Past-forecast history (client-side).
//
// Stores up to 20 most-recent successful forecasts in localStorage under
// 'paperfate.forecast.history' so the user can revisit prior runs without
// re-paying for the LLM extraction. Manuscript text is intentionally NOT
// persisted — we keep only the title and the first 100 chars of the
// abstract, enough to seed a re-run if they want to repeat it.
//
// generateShareUrl returns a URL pointing to the current origin with a
// ?forecast=<id> query string. The receiving side reads the same local
// store; this is NOT a real cross-device share (main session can later
// wire a server-side hash store onto the same URL shape).
//
// All public functions are SSR-safe: they no-op when window is undefined
// and they swallow any storage / quota errors.

const STORAGE_KEY = 'paperfate.forecast.history'
const MAX_ENTRIES = 20
const ABSTRACT_PREVIEW_LEN = 100

function hasWindow() {
  return typeof window !== 'undefined' && !!window.localStorage
}

function safeUuid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* ignore */ }
  // Fallback — not RFC-4122 compliant but unique enough for a 20-slot
  // local cache. Uses time + two random ints.
  const a = Date.now().toString(36)
  const b = Math.floor(Math.random() * 1e9).toString(36)
  const c = Math.floor(Math.random() * 1e9).toString(36)
  return `pf-${a}-${b}${c}`
}

function readStore() {
  if (!hasWindow()) return { entries: [] }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { entries: [] }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { entries: [] }
    if (!Array.isArray(parsed.entries)) return { entries: [] }
    return { entries: parsed.entries }
  } catch {
    return { entries: [] }
  }
}

function writeStore(store) {
  if (!hasWindow()) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Quota / private mode — swallow.
  }
}

function pickPrediction(predictions) {
  // Keep the minimum needed to render a useful row in the history panel.
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

export function saveForecast(input) {
  if (!hasWindow()) return null
  if (!input || typeof input !== 'object') return null
  try {
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
      id: safeUuid(),
      ts: Date.now(),
      title,
      abstract_preview: abstractPreview,
      mode,
      predictions,
      extractor_used,
      request_id,
      wall_ms,
    }

    const store = readStore()
    // Newest-first, capped.
    const next = [entry, ...store.entries].slice(0, MAX_ENTRIES)
    writeStore({ entries: next })
    return entry
  } catch {
    return null
  }
}

export function getForecasts() {
  if (!hasWindow()) return []
  try {
    const store = readStore()
    return Array.isArray(store.entries) ? store.entries.slice(0, MAX_ENTRIES) : []
  } catch {
    return []
  }
}

export function getForecast(id) {
  if (!hasWindow()) return null
  if (typeof id !== 'string' || !id) return null
  try {
    const store = readStore()
    return store.entries.find(e => e && e.id === id) || null
  } catch {
    return null
  }
}

export function clearAll() {
  if (!hasWindow()) return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function generateShareUrl(entryId) {
  if (typeof entryId !== 'string' || !entryId) return ''
  let origin = ''
  try {
    if (typeof location !== 'undefined' && location && location.origin) {
      origin = String(location.origin)
    }
  } catch { /* ignore */ }
  if (!origin) return `/?forecast=${encodeURIComponent(entryId)}`
  return `${origin}/?forecast=${encodeURIComponent(entryId)}`
}
