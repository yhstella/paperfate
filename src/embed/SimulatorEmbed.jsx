import { useEffect, useMemo, useState } from 'react'
import { abstractQuality, DOMAIN_COLORS, DOMAIN_NAMES } from '../lib/forecastClient.js'

// SimulatorEmbed — minimal, iframe-friendly version of the simulator.
// Designed to be dropped into third-party blog posts via:
//   <iframe src="https://paperfate.com/embed.html"></iframe>
//
// What ships here is intentionally tiny: title + abstract textarea + a single
// Submit button that calls /api/abstract-quality. The render is limited to
// the overall_score chip, a top-3 domain rollup, and a degraded banner when
// scoring falls back to the rule pipeline. No history, Compare, Nav, or tabs.
//
// Parent-window integration (postMessage):
//   { type: 'paperfate.embed.submit' }                       → user clicked Submit
//   { type: 'paperfate.embed.result', score, degraded }      → scoring resolved
//   { type: 'paperfate.embed.error', message }               → scoring failed
//
// Query parameters:
//   ?showLogo=false   → hides the small "PaperFate" wordmark (white-label).

const MIN_TITLE_CHARS = 8
const MIN_ABSTRACT_CHARS = 200

function postToParent(payload) {
  // Best-effort cross-frame notification. We don't restrict the target origin
  // because embedders can be any blog domain; the message body never contains
  // raw manuscript text — only the numeric score and a degraded flag — so the
  // privacy surface is small. Parents that care can filter on event.origin.
  if (typeof window === 'undefined') return
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, '*')
    }
  } catch { /* parent may be cross-origin and blocked; that's fine */ }
}

function readShowLogoFlag() {
  if (typeof window === 'undefined') return true
  try {
    const params = new URLSearchParams(window.location.search || '')
    const v = params.get('showLogo')
    if (v == null) return true
    return !(v === 'false' || v === '0' || v === 'no')
  } catch {
    return true
  }
}

export default function SimulatorEmbed() {
  const [title, setTitle] = useState('')
  const [abstract, setAbstract] = useState('')
  const [status, setStatus] = useState('idle')   // idle | running | done | error
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const showLogo = useMemo(() => readShowLogoFlag(), [])
  const titleOk = title.trim().length > MIN_TITLE_CHARS
  const absOk = abstract.length >= MIN_ABSTRACT_CHARS
  const canRun = titleOk && absOk && status !== 'running'

  // Tell the parent how tall we are so it can size the iframe without manual
  // height-juggling. We use ResizeObserver on document.body — re-emits on
  // every layout change (textarea grow, result expand, etc.).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return
    let last = 0
    const ro = new ResizeObserver(() => {
      const h = document.body?.scrollHeight || 0
      if (h && Math.abs(h - last) > 2) {
        last = h
        postToParent({ type: 'paperfate.embed.resize', height: h })
      }
    })
    if (document.body) ro.observe(document.body)
    return () => ro.disconnect()
  }, [])

  async function onSubmit(e) {
    e?.preventDefault?.()
    if (!canRun) return
    setStatus('running')
    setResult(null)
    setError(null)
    postToParent({ type: 'paperfate.embed.submit' })
    try {
      const r = await abstractQuality({
        title,
        abstract,
        article_type: '*',
      })
      const overall = Number.isFinite(+r?.overall_score) ? +r.overall_score : null
      const llmHealth = r?.llm_health || null
      const extractorUsed = r?.extractor_used || null
      const degraded =
        (llmHealth && llmHealth.status === 'degraded') ||
        extractorUsed === 'rule_fallback' ||
        extractorUsed === 'mock' ||
        extractorUsed === 'deterministic'
      setResult(r)
      setStatus('done')
      postToParent({
        type: 'paperfate.embed.result',
        score: overall,
        degraded: !!degraded,
      })
    } catch (err) {
      const msg = err?.message || 'Quick check failed'
      setError(msg)
      setStatus('error')
      postToParent({ type: 'paperfate.embed.error', message: String(msg).slice(0, 200) })
    }
  }

  const overall = Number.isFinite(+result?.overall_score) ? +result.overall_score : null
  const rollup = Array.isArray(result?.domain_rollup) ? result.domain_rollup.slice(0, 3) : []
  const llmHealth = result?.llm_health || null
  const extractorUsed = result?.extractor_used || null
  const degraded =
    (llmHealth && llmHealth.status === 'degraded') ||
    extractorUsed === 'rule_fallback' ||
    extractorUsed === 'mock' ||
    extractorUsed === 'deterministic'

  return (
    <div className="pf-embed">
      {showLogo && (
        <div className="pf-embed__brand">
          <a
            href="https://paperfate.com"
            target="_blank"
            rel="noopener noreferrer"
            className="pf-embed__brand-link"
          >
            PaperFate
          </a>
          <span className="pf-embed__brand-tag">abstract quick-check</span>
        </div>
      )}

      <form onSubmit={onSubmit} className="pf-embed__form" aria-label="Abstract quality check">
        <label className="pf-embed__label" htmlFor="pf-embed-title">Title</label>
        <input
          id="pf-embed-title"
          type="text"
          className="pf-embed__input"
          placeholder="Manuscript title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          aria-label="Manuscript title"
        />

        <label className="pf-embed__label" htmlFor="pf-embed-abstract">Abstract</label>
        <textarea
          id="pf-embed-abstract"
          rows={8}
          className="pf-embed__textarea"
          placeholder="Paste your abstract (≥ 200 chars). Structured Background / Methods / Results / Conclusions works best."
          value={abstract}
          onChange={e => setAbstract(e.target.value)}
          aria-label="Abstract text"
        />
        <div className="pf-embed__counter" aria-live="polite">
          {abstract.length.toLocaleString()} chars
          {abstract.length > 0 && abstract.length < MIN_ABSTRACT_CHARS && (
            <span className="pf-embed__counter-warn">
              {' '}— need {(MIN_ABSTRACT_CHARS - abstract.length).toLocaleString()} more
            </span>
          )}
        </div>

        <button
          type="submit"
          disabled={!canRun}
          aria-disabled={!canRun}
          className="pf-embed__btn"
        >
          {status === 'running' ? 'Checking…' : 'Run quick check'}
        </button>
      </form>

      {status === 'error' && (
        <div className="pf-embed__alert" role="alert">
          Quick check unavailable{error ? ` — ${String(error).slice(0, 120)}` : ''}.
        </div>
      )}

      {status === 'done' && result && (
        <div className="pf-embed__result" role="region" aria-label="Quick rubric result">
          {degraded && (
            <div className="pf-embed__degraded" role="status">
              Rubric scoring is running in degraded mode — results are heuristic only.
            </div>
          )}
          <div className="pf-embed__score-row">
            <div className="pf-embed__score-label">Overall</div>
            <div className="pf-embed__score-chip">
              {overall != null ? Math.round(overall) : '—'}
              <span className="pf-embed__score-suffix"> / 100</span>
            </div>
          </div>
          {rollup.length > 0 && (
            <div className="pf-embed__rollup">
              {rollup.map((d, i) => {
                const code = d.domain || d.code || ''
                const name = DOMAIN_NAMES[code] || code || '—'
                const color = DOMAIN_COLORS[code] || '#94a3b8'
                const score = Number.isFinite(+d.score)
                  ? +d.score
                  : (Number.isFinite(+d.mean) ? +d.mean : null)
                return (
                  <div
                    key={`${code}-${i}`}
                    className="pf-embed__rollup-chip"
                    style={{ borderColor: `${color}55`, color }}
                    title={name}
                  >
                    <span className="pf-embed__rollup-code">{code || '—'}</span>
                    <span className="pf-embed__rollup-name">{name}</span>
                    {score != null && (
                      <span className="pf-embed__rollup-score">{Math.round(score)}</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <div className="pf-embed__footnote">
            Top-3 of {Array.isArray(result?.domain_rollup) ? result.domain_rollup.length : 0} domains shown.
            Full forecast available at{' '}
            <a
              href="https://paperfate.com"
              target="_blank"
              rel="noopener noreferrer"
              className="pf-embed__footnote-link"
            >
              paperfate.com
            </a>.
          </div>
        </div>
      )}
    </div>
  )
}
