// PaperFate · Global keyboard shortcuts.
//
// Single export `registerShortcuts()`. Attaches a window-level keydown
// listener. On Cmd+K (Mac) or Ctrl+K (Windows / Linux) it dispatches
// the 'paperfate:open-command-palette' CustomEvent on `window`. Returns
// an unregister function that detaches the listener.
//
// Why an event, not a callback:
//   - keeps shortcut registration decoupled from React mount order
//   - any component that mounts the palette can subscribe
//   - SSR-safe: if window is undefined we register nothing and the
//     returned unregister is a no-op
//
// We intentionally do NOT swallow Cmd+K when the user is currently
// typing in a non-editable element only — when an editable target has
// focus (input, textarea, contenteditable), we still preventDefault and
// open the palette, because that matches the convention every other
// command palette uses (Slack, GitHub, Linear, VS Code). Browser
// default for Cmd+K varies (Firefox = search bar), and we want a
// predictable in-app behaviour.

export const OPEN_EVENT = 'paperfate:open-command-palette'

function isOpenCombo(e) {
  // Match either modifier so Mac users (metaKey) and Windows/Linux
  // users (ctrlKey) both get the same binding. Ignore shift/alt so a
  // stray modifier doesn't swallow the shortcut.
  if (!e || typeof e.key !== 'string') return false
  if (e.key.toLowerCase() !== 'k') return false
  return !!(e.metaKey || e.ctrlKey)
}

export function registerShortcuts() {
  if (typeof window === 'undefined') {
    return () => {}
  }
  const onKey = (e) => {
    if (!isOpenCombo(e)) return
    // Avoid double-fire when both Ctrl and Meta are held (rare).
    e.preventDefault()
    e.stopPropagation()
    try {
      window.dispatchEvent(new CustomEvent(OPEN_EVENT))
    } catch {
      // CustomEvent constructor missing (very old browsers) — fall
      // back to a plain Event so we still notify subscribers.
      try {
        const ev = document.createEvent('Event')
        ev.initEvent(OPEN_EVENT, false, false)
        window.dispatchEvent(ev)
      } catch { /* give up silently */ }
    }
  }
  window.addEventListener('keydown', onKey)
  return () => {
    try { window.removeEventListener('keydown', onKey) } catch { /* ignore */ }
  }
}
