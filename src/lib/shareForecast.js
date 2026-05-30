// PaperFate · Share a past forecast entry via the Web Share API.
//
// shareForecast(entry) tries navigator.share() first (best UX on mobile and
// browsers that expose the share sheet). When the platform does not expose
// the Web Share API, we fall back to copying the share URL to the clipboard
// so the user still has something to paste into a chat / email / DM.
//
// Returns { ok: boolean, method: 'share' | 'clipboard' | 'none' }.
// Never throws — telemetry / clipboard / share errors are swallowed.
//
// Telemetry: emits 'share_native_used' when navigator.share succeeded or
// failed, and 'share_clipboard_used' on the fallback path. The `ok` flag
// records whether the underlying call resolved without throwing.

import { trackEvent } from './telemetry.js'
import { generateShareUrl } from './forecastHistory.js'

const TITLE_MAX = 80

function safeTitle(entry) {
  const raw = typeof entry?.title === 'string' ? entry.title : ''
  const trimmed = raw.trim()
  if (!trimmed) return 'PaperFate forecast'
  return trimmed.length > TITLE_MAX ? trimmed.slice(0, TITLE_MAX) : trimmed
}

function safeShareText(entry) {
  // Keep this terse — share-sheet UI on mobile truncates aggressively. We
  // surface the headline JIF prediction and which extractor produced it.
  const pt = entry?.predictions?.jcr_jif?.point
  const jifStr = Number.isFinite(+pt) ? (+pt).toFixed(1) : '—'
  const extractor = typeof entry?.extractor_used === 'string' && entry.extractor_used
    ? entry.extractor_used
    : 'unknown'
  return `PaperFate forecast: JIF ~${jifStr}, ${extractor} run`
}

function hasNavigatorShare() {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  } catch {
    return false
  }
}

function hasClipboardWrite() {
  try {
    return (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    )
  } catch {
    return false
  }
}

export function canShareForecast() {
  return hasNavigatorShare() || hasClipboardWrite()
}

export async function shareForecast(entry) {
  if (!entry || typeof entry !== 'object' || !entry.id) {
    return { ok: false, method: 'none' }
  }

  const title = safeTitle(entry)
  const text = safeShareText(entry)
  const url = generateShareUrl(entry.id)

  if (hasNavigatorShare()) {
    try {
      await navigator.share({ title, text, url })
      try { trackEvent('share_native_used', { ok: true }) } catch { /* ignore */ }
      return { ok: true, method: 'share' }
    } catch (err) {
      // AbortError fires when the user dismisses the sheet — that's not a
      // bug, but we still record it so the metric reflects reality. We do
      // NOT fall back to clipboard on AbortError: the user explicitly chose
      // to back out of the share sheet.
      const name = err && err.name
      try { trackEvent('share_native_used', { ok: false }) } catch { /* ignore */ }
      if (name === 'AbortError') {
        return { ok: false, method: 'share' }
      }
      // Any other failure (NotAllowedError, TypeError on weird payloads,
      // etc.) — fall through to the clipboard path below.
    }
  }

  if (hasClipboardWrite()) {
    try {
      await navigator.clipboard.writeText(url)
      try { trackEvent('share_clipboard_used', { ok: true }) } catch { /* ignore */ }
      return { ok: true, method: 'clipboard' }
    } catch {
      try { trackEvent('share_clipboard_used', { ok: false }) } catch { /* ignore */ }
      return { ok: false, method: 'clipboard' }
    }
  }

  return { ok: false, method: 'none' }
}
