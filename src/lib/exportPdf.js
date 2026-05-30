// PaperFate · Forecast PDF export via the browser Print API.
//
// exportForecastPdf({ title, summary, predictions, journey, similar,
// manuscript_title }) opens a new browser window with a print-ready HTML
// document and triggers window.print(). The user then chooses 'Save as
// PDF' in the browser's print dialog — no third-party PDF library, no
// extra bundle weight, no server round-trip.
//
// The popup uses ONLY inline <style> and inline SVG; no external assets,
// fonts, or scripts. That guarantees the print dialog can render even on
// air-gapped browsers and keeps the popup CSP-safe.
//
// Layout (top → bottom):
//   1. Manuscript title in serif italic
//   2. Hero block: predicted JIF point + CI, score, desk-reject risk
//   3. Plain-text summary paragraph (if provided)
//   4. Journey table (step / venue / IF / switch cost)
//   5. Similar papers list (title · venue · year · IF · citations)
//   6. Footer with the PaperFate wordmark and an ISO timestamp
//
// Telemetry: emits 'export_pdf' with a tiny shape descriptor so we can
// see which sections users actually print. Errors are swallowed — a
// failing popup must not crash the host app.
//
// SSR-safe: no-ops when `window` is undefined. Pop-up blockers return
// a null window from window.open(); we detect that and report
// { ok: false, reason: 'popup_blocked' } so the caller can surface a
// hint if it wants.

import { trackEvent } from './telemetry.js'

const TITLE_MAX = 200
const SUMMARY_MAX = 4000
const JOURNEY_MAX = 30
const SIMILAR_MAX = 30

// HTML-escape any string we drop into the print document. The popup is
// fully under our control, but the manuscript title, journey venues,
// and similar-paper titles all originate from user input or external
// APIs — escape everything to keep the printed page safe.
function esc(value) {
  if (value == null) return ''
  const s = String(value)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function trim(s, max) {
  if (typeof s !== 'string') return ''
  const t = s.trim()
  if (!t) return ''
  return t.length > max ? t.slice(0, max) + '…' : t
}

function safeNumber(value, digits) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return typeof digits === 'number' ? n.toFixed(digits) : String(n)
}

function formatTimestamp(date) {
  try {
    const d = date instanceof Date ? date : new Date()
    // Locale-neutral ISO-ish stamp; the print dialog inherits the OS
    // locale anyway, this footer is just provenance.
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  } catch {
    return ''
  }
}

function renderHeroBlock(predictions) {
  const jif = predictions && typeof predictions === 'object' ? predictions.jcr_jif : null
  const dr = predictions && typeof predictions === 'object' ? predictions.desk_reject_risk : null
  const score = predictions && typeof predictions === 'object' ? predictions.score : null

  const point = jif && safeNumber(jif.point, 2)
  const ciLow = jif && safeNumber(jif.ci_low, 2)
  const ciHigh = jif && safeNumber(jif.ci_high, 2)
  const ciRange = ciLow && ciHigh ? `${ciLow}–${ciHigh}` : null

  const drPct = dr && Number.isFinite(+dr.point) ? Math.round(+dr.point) : null
  const drLabel = dr && typeof dr.label === 'string' ? dr.label : null

  const scoreVal = Number.isFinite(+score) ? Math.round(+score) : null

  const tiles = []
  tiles.push(`
    <div class="hero-tile hero-primary">
      <div class="hero-label">Predicted JIF</div>
      <div class="hero-value">${point ? esc(point) : '—'}</div>
      ${ciRange ? `<div class="hero-sub">90% CI ${esc(ciRange)}</div>` : ''}
    </div>`)
  if (scoreVal != null) {
    tiles.push(`
      <div class="hero-tile">
        <div class="hero-label">Impact score</div>
        <div class="hero-value">${esc(String(scoreVal))}<span class="hero-unit">/100</span></div>
      </div>`)
  }
  if (drPct != null || drLabel) {
    tiles.push(`
      <div class="hero-tile">
        <div class="hero-label">Desk-reject risk</div>
        <div class="hero-value">${drPct != null ? esc(String(drPct)) + '<span class="hero-unit">%</span>' : '—'}</div>
        ${drLabel ? `<div class="hero-sub">${esc(drLabel)}</div>` : ''}
      </div>`)
  }
  return `<section class="hero">${tiles.join('')}</section>`
}

function renderJourneyTable(journey) {
  if (!Array.isArray(journey) || journey.length === 0) return ''
  const rows = journey.slice(0, JOURNEY_MAX).map((j, i) => {
    const step = Number.isFinite(+j?.step) ? +j.step : i + 1
    const venue = trim(j?.venue, 120) || '—'
    const publisher = trim(j?.publisher, 80)
    const ifStr = safeNumber(j?.if, 2) || (j?.if ? String(j.if) : '—')
    const switchCost = trim(j?.switchCost, 40)
    const switchReason = trim(j?.switchReason, 200)
    return `
      <tr>
        <td class="cell-step">${esc(String(step))}</td>
        <td>
          <div class="cell-venue">${esc(venue)}</div>
          ${publisher ? `<div class="cell-sub">${esc(publisher)}</div>` : ''}
          ${switchReason ? `<div class="cell-sub">${esc(switchReason)}</div>` : ''}
        </td>
        <td class="cell-num">${esc(ifStr)}</td>
        <td class="cell-cost">${switchCost ? esc(switchCost) : (i === 0 ? 'start' : '—')}</td>
      </tr>`
  }).join('')
  return `
    <section class="block">
      <h2>Submission journey</h2>
      <table class="journey">
        <thead>
          <tr><th>Step</th><th>Venue</th><th>IF</th><th>Switch cost</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`
}

function renderSimilarList(similar) {
  if (!Array.isArray(similar) || similar.length === 0) return ''
  const items = similar.slice(0, SIMILAR_MAX).map((p) => {
    const title = trim(p?.title, 240) || '—'
    const venue = trim(p?.venue, 120)
    const year = Number.isFinite(+p?.year) ? String(+p.year) : ''
    const ifStr = safeNumber(p?.if, 2) || (p?.if ? String(p.if) : '')
    const citations = Number.isFinite(+p?.citations) ? `${+p.citations}× cited` : ''
    const meta = [venue, year ? `Year ${year}` : '', ifStr ? `IF ${ifStr}` : '', citations]
      .filter(Boolean)
      .map(esc)
      .join(' · ')
    return `
      <li>
        <div class="similar-title">${esc(title)}</div>
        ${meta ? `<div class="similar-meta">${meta}</div>` : ''}
      </li>`
  }).join('')
  return `
    <section class="block">
      <h2>Similar papers</h2>
      <ul class="similar">${items}</ul>
    </section>`
}

function buildHtml({ title, summary, predictions, journey, similar, manuscript_title }) {
  const safeTitle = trim(title || manuscript_title || 'PaperFate forecast', TITLE_MAX)
  const safeSummary = trim(summary, SUMMARY_MAX)
  const stamp = formatTimestamp(new Date())
  const docTitle = `PaperFate · ${safeTitle}`

  // Inline CSS only — popups inherit no styles, and we explicitly want
  // the print output to look identical regardless of host page CSS.
  const styles = `
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #0f172a; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                   'Helvetica Neue', Arial, sans-serif;
      font-size: 12pt;
      line-height: 1.45;
      padding: 28px 32px 40px;
      max-width: 780px;
      margin: 0 auto;
    }
    h1 {
      font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
      font-style: italic;
      font-weight: 400;
      font-size: 22pt;
      margin: 0 0 4px;
      color: #0f172a;
    }
    h2 {
      font-size: 11pt;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #475569;
      margin: 24px 0 8px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 4px;
    }
    .subtitle {
      font-size: 9.5pt;
      color: #64748b;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 0 0 18px;
    }
    .hero {
      display: flex;
      gap: 12px;
      margin: 18px 0 6px;
      flex-wrap: wrap;
    }
    .hero-tile {
      flex: 1 1 160px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 12px 14px;
      background: #f8fafc;
    }
    .hero-primary {
      border-color: #7c3aed;
      background: #f5f3ff;
    }
    .hero-label {
      font-size: 9pt;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .hero-value {
      font-size: 22pt;
      font-weight: 600;
      margin-top: 4px;
      color: #0f172a;
    }
    .hero-unit {
      font-size: 12pt;
      font-weight: 400;
      color: #64748b;
      margin-left: 4px;
    }
    .hero-sub {
      font-size: 9.5pt;
      color: #64748b;
      margin-top: 2px;
    }
    .summary {
      font-size: 11pt;
      color: #1e293b;
      margin: 14px 0 4px;
      white-space: pre-wrap;
    }
    table.journey {
      width: 100%;
      border-collapse: collapse;
      font-size: 10.5pt;
    }
    table.journey th, table.journey td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: top;
    }
    table.journey th {
      font-size: 9pt;
      font-weight: 600;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: #f8fafc;
    }
    .cell-step {
      width: 44px;
      font-weight: 600;
      color: #7c3aed;
    }
    .cell-venue { font-weight: 600; }
    .cell-sub {
      font-size: 9.5pt;
      color: #64748b;
      margin-top: 2px;
    }
    .cell-num {
      width: 64px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .cell-cost {
      width: 110px;
      font-size: 9.5pt;
      color: #475569;
    }
    ul.similar {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    ul.similar li {
      padding: 8px 0;
      border-bottom: 1px solid #e2e8f0;
    }
    .similar-title { font-size: 10.5pt; color: #0f172a; }
    .similar-meta {
      font-size: 9.5pt;
      color: #64748b;
      margin-top: 3px;
    }
    footer {
      margin-top: 36px;
      padding-top: 12px;
      border-top: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-size: 9pt;
      color: #64748b;
    }
    .logo {
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #7c3aed;
    }
    @page {
      size: A4;
      margin: 16mm;
    }
    @media print {
      body { padding: 0; max-width: none; }
      .no-print { display: none; }
    }
  `

  const hero = renderHeroBlock(predictions)
  const journeyHtml = renderJourneyTable(journey)
  const similarHtml = renderSimilarList(similar)
  const summaryHtml = safeSummary
    ? `<section class="block"><h2>Forecast summary</h2><div class="summary">${esc(safeSummary)}</div></section>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(docTitle)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>${styles}</style>
</head>
<body>
  <div class="subtitle">PaperFate forecast</div>
  <h1>${esc(safeTitle)}</h1>
  ${hero}
  ${summaryHtml}
  ${journeyHtml}
  ${similarHtml}
  <footer>
    <span class="logo">PaperFate</span>
    <span>${esc(stamp)}</span>
  </footer>
</body>
</html>`
}

function safePopup() {
  try {
    if (typeof window === 'undefined' || typeof window.open !== 'function') return null
    // 'noopener' would null out the returned window reference, which we
    // need to call document.write + window.print on. The popup is
    // same-origin and we control its content fully.
    const w = window.open('', '_blank', 'noopener=no,noreferrer=no,width=820,height=900')
    return w || null
  } catch {
    return null
  }
}

export function exportForecastPdf(input) {
  const safe = input && typeof input === 'object' ? input : {}
  const journeyLen = Array.isArray(safe.journey) ? safe.journey.length : 0
  const similarLen = Array.isArray(safe.similar) ? safe.similar.length : 0
  const hasSummary = typeof safe.summary === 'string' && safe.summary.trim().length > 0
  const hasPredictions = !!(safe.predictions && typeof safe.predictions === 'object')

  try {
    trackEvent('export_pdf', {
      journey_len: journeyLen,
      similar_len: similarLen,
      has_summary: hasSummary,
      has_predictions: hasPredictions,
    })
  } catch { /* telemetry must never throw */ }

  if (typeof window === 'undefined') {
    return { ok: false, reason: 'no_window' }
  }

  const popup = safePopup()
  if (!popup) {
    return { ok: false, reason: 'popup_blocked' }
  }

  let html
  try {
    html = buildHtml(safe)
  } catch {
    try { popup.close() } catch { /* ignore */ }
    return { ok: false, reason: 'render_error' }
  }

  try {
    popup.document.open()
    popup.document.write(html)
    popup.document.close()
  } catch {
    try { popup.close() } catch { /* ignore */ }
    return { ok: false, reason: 'write_error' }
  }

  // Defer the print() call until after the popup has had a chance to
  // lay out the document. Some browsers (Safari, older Chrome) race
  // against window.print() if it fires before the document is fully
  // parsed. We use the popup's own setTimeout so we don't tie the host
  // page to the popup's event loop.
  try {
    popup.focus()
    if (typeof popup.setTimeout === 'function') {
      popup.setTimeout(() => {
        try { popup.print() } catch { /* user can still File→Print */ }
      }, 250)
    } else {
      try { popup.print() } catch { /* user can still File→Print */ }
    }
  } catch { /* ignore — popup still readable */ }

  return { ok: true, reason: 'opened' }
}

// Exported only for unit testing — not part of the public surface.
export const __internal = { buildHtml, esc, trim, formatTimestamp }
