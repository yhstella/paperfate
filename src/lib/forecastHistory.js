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
const MAX_TAGS_PER_ENTRY = 5
const TAG_MAX_LEN = 32

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
      favorite: false,
      tags: [],
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
    const list = Array.isArray(store.entries) ? store.entries.slice(0, MAX_ENTRIES) : []
    return list.map(withTagsShape)
  } catch {
    return []
  }
}

export function getForecast(id) {
  if (!hasWindow()) return null
  if (typeof id !== 'string' || !id) return null
  try {
    const store = readStore()
    const hit = store.entries.find(e => e && e.id === id) || null
    return hit ? withTagsShape(hit) : null
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

// Normalize tag string: trim, collapse internal whitespace, cap length.
// Returns '' if the input is unusable.
function normalizeTag(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  if (!trimmed) return ''
  return trimmed.slice(0, TAG_MAX_LEN)
}

// Coerce any persisted entry into the favorite/tags schema. Old rows
// written before Round 7 lack these fields — we treat them as
// favorite:false / tags:[] without mutating the store on read.
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

function updateEntry(id, mutator) {
  if (!hasWindow()) return null
  if (typeof id !== 'string' || !id) return null
  try {
    const store = readStore()
    let updated = null
    const next = store.entries.map(e => {
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
  } catch {
    return null
  }
}

export function setFavorite(id, value) {
  const flag = value === true
  return updateEntry(id, entry => ({ ...entry, favorite: flag }))
}

export function addTag(id, tag) {
  const normalized = normalizeTag(tag)
  if (!normalized) return null
  return updateEntry(id, entry => {
    const existing = Array.isArray(entry.tags) ? entry.tags : []
    // Case-insensitive dedup; preserve the first-written casing.
    const lower = normalized.toLowerCase()
    if (existing.some(t => typeof t === 'string' && t.toLowerCase() === lower)) {
      return entry
    }
    if (existing.length >= MAX_TAGS_PER_ENTRY) return entry
    return { ...entry, tags: [...existing, normalized] }
  })
}

export function removeTag(id, tag) {
  const normalized = normalizeTag(tag)
  if (!normalized) return null
  const lower = normalized.toLowerCase()
  return updateEntry(id, entry => {
    const existing = Array.isArray(entry.tags) ? entry.tags : []
    const next = existing.filter(t => typeof t === 'string' && t.toLowerCase() !== lower)
    if (next.length === existing.length) return entry
    return { ...entry, tags: next }
  })
}

// Returns a pretty-printed JSON string of all entries in a stable shape
// suitable for download. We omit nothing sensitive (manuscript text is
// already not persisted), but normalize the field order so the file
// looks deterministic across runs.
export function exportAsJson() {
  if (!hasWindow()) return '{"exported_at":null,"entries":[]}'
  try {
    const store = readStore()
    const entries = (Array.isArray(store.entries) ? store.entries : [])
      .map(withTagsShape)
      .map(e => ({
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
      exported_at: new Date().toISOString(),
      count: entries.length,
      entries,
    }, null, 2)
  } catch {
    return '{"exported_at":null,"entries":[]}'
  }
}

// RFC 4180 field escape: wrap in double quotes if the value contains
// comma, quote, CR, or LF. Embedded double quotes are doubled.
function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s === '') return ''
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

// Returns a CSV string of all entries: a header row plus one row per
// entry. Columns: id, ts (ISO), title, mode, extractor_used,
// predicted_jif, request_id, wall_ms, favorite (true/false), tags
// (semicolon-joined). RFC 4180 escaping. CRLF line endings.
export function exportAsCsv() {
  const header = [
    'id',
    'ts',
    'title',
    'mode',
    'extractor_used',
    'predicted_jif',
    'request_id',
    'wall_ms',
    'favorite',
    'tags',
  ].join(',')
  if (!hasWindow()) return header + '\r\n'
  try {
    const store = readStore()
    const entries = (Array.isArray(store.entries) ? store.entries : []).map(withTagsShape)
    const rows = entries.map(e => {
      const tsIso = Number.isFinite(+e.ts)
        ? (() => { try { return new Date(+e.ts).toISOString() } catch { return '' } })()
        : ''
      const jifPoint = e?.predictions?.jcr_jif?.point
      const predictedJif = Number.isFinite(+jifPoint) ? String(+jifPoint) : ''
      const wallMs = Number.isFinite(+e.wall_ms) ? String(+e.wall_ms) : ''
      const tagsStr = Array.isArray(e.tags) ? e.tags.join(';') : ''
      return [
        csvEscape(e.id || ''),
        csvEscape(tsIso),
        csvEscape(e.title || ''),
        csvEscape(e.mode || ''),
        csvEscape(e.extractor_used || ''),
        csvEscape(predictedJif),
        csvEscape(e.request_id || ''),
        csvEscape(wallMs),
        csvEscape(e.favorite === true ? 'true' : 'false'),
        csvEscape(tagsStr),
      ].join(',')
    })
    return [header, ...rows].join('\r\n') + '\r\n'
  } catch {
    return header + '\r\n'
  }
}
