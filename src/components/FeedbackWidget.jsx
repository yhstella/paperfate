import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { trackEvent } from '../lib/telemetry.js'

// Small floating "Feedback" button (bottom-right, above the SWUpdateToast
// pill at bottom-4 right-4). Clicking it opens a modal dialog with:
//   - 1–5 star rating
//   - free-form textarea (max 2000 chars)
//   - optional email
//
// Submit POSTs /api/feedback. Success surfaces a transient "Thanks!"
// toast. Errors keep the modal open and show an inline message.
//
// Telemetry: feedback_open + feedback_submit (with rating + length).
// Accessibility: role=dialog + aria-modal=true; ESC and backdrop close;
// focus moves to the textarea on open, returns to the trigger on close.
//
// SSR / no-window safe: every browser-only access happens inside an
// effect or a handler.

const TEXT_MAX = 2000
const THANKS_TOAST_MS = 3500

function StarRow({ value, onChange, disabled }) {
  // 5 buttons. Each acts like a radio — selecting one updates `value`.
  // Keyboard: arrow left/right cycles, 1–5 jumps directly.
  const handleKeyDown = (ev, n) => {
    if (disabled) return
    if (ev.key === 'ArrowRight') {
      ev.preventDefault()
      onChange(Math.min(5, (value || 0) + 1) || 1)
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault()
      onChange(Math.max(1, (value || 1) - 1))
    } else if (/^[1-5]$/.test(ev.key)) {
      ev.preventDefault()
      onChange(Number(ev.key))
    }
  }
  return (
    <div role="radiogroup" aria-label="Rating" className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map(n => {
        const selected = value === n
        const filled = value >= n
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            tabIndex={selected || (!value && n === 1) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(n)}
            onKeyDown={(ev) => handleKeyDown(ev, n)}
            className={`text-2xl leading-none transition ${filled ? 'text-amber-400' : 'text-slate-500 hover:text-slate-300'} disabled:opacity-50`}
          >
            <span aria-hidden="true">{filled ? '★' : '☆'}</span>
          </button>
        )
      })}
      <span className="ml-2 text-xs text-slate-400" aria-live="polite">
        {value ? `${value}/5` : 'No rating'}
      </span>
    </div>
  )
}

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false)
  const [rating, setRating] = useState(0)
  const [text, setText] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [showThanks, setShowThanks] = useState(false)

  const triggerRef = useRef(null)
  const dialogRef = useRef(null)
  const textareaRef = useRef(null)
  const thanksTimerRef = useRef(0)

  const titleId = useId()
  const descId = useId()
  const textareaId = useId()
  const emailId = useId()
  const errorId = useId()

  const closeModal = useCallback(() => {
    setOpen(false)
    setErrorMsg('')
    // Return focus to the trigger so keyboard users don't lose their place.
    try { triggerRef.current?.focus?.() } catch { /* ignore */ }
  }, [])

  const openModal = useCallback(() => {
    setOpen(true)
    setErrorMsg('')
    try { trackEvent('feedback_open', {}) } catch { /* ignore */ }
  }, [])

  // ESC to close while modal is open.
  useEffect(() => {
    if (!open) return undefined
    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        closeModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeModal])

  // Move focus into the textarea on open.
  useEffect(() => {
    if (!open) return
    // Defer one frame so the dialog is in the DOM before focusing.
    const id = window.setTimeout(() => {
      try { textareaRef.current?.focus?.() } catch { /* ignore */ }
    }, 0)
    return () => window.clearTimeout(id)
  }, [open])

  // Cleanup the thanks-toast timer on unmount.
  useEffect(() => {
    return () => {
      if (thanksTimerRef.current) {
        try { window.clearTimeout(thanksTimerRef.current) } catch { /* ignore */ }
      }
    }
  }, [])

  async function handleSubmit(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
    if (submitting) return
    setErrorMsg('')

    if (!rating || rating < 1 || rating > 5) {
      setErrorMsg('Please choose a rating from 1 to 5.')
      return
    }
    const trimmed = text.trim()
    if (trimmed.length < 1) {
      setErrorMsg('Please write a short note before submitting.')
      return
    }
    if (text.length > TEXT_MAX) {
      setErrorMsg(`Please keep your note under ${TEXT_MAX} characters.`)
      return
    }

    const payload = {
      rating,
      text,
      page_url: (() => {
        try { return typeof window !== 'undefined' ? window.location.href : '' }
        catch { return '' }
      })(),
    }
    if (email && email.trim()) payload.email = email.trim()

    setSubmitting(true)
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        let detail = ''
        try {
          const j = await res.json()
          detail = (j && (j.error || j.detail)) ? String(j.error || j.detail) : ''
        } catch { /* ignore */ }
        if (res.status === 429) {
          setErrorMsg('You have sent a lot of feedback recently. Please try again in a bit.')
        } else if (res.status === 400 && detail) {
          setErrorMsg(`We could not accept that submission (${detail}).`)
        } else {
          setErrorMsg('Something went wrong. Please try again.')
        }
        return
      }
      try {
        trackEvent('feedback_submit', { rating, text_length: text.length, has_email: Boolean(email && email.trim()) })
      } catch { /* ignore */ }
      // Reset form, close modal, surface thanks toast.
      setRating(0)
      setText('')
      setEmail('')
      setOpen(false)
      try { triggerRef.current?.focus?.() } catch { /* ignore */ }
      setShowThanks(true)
      if (thanksTimerRef.current) {
        try { window.clearTimeout(thanksTimerRef.current) } catch { /* ignore */ }
      }
      thanksTimerRef.current = window.setTimeout(() => {
        setShowThanks(false)
      }, THANKS_TOAST_MS)
    } catch {
      setErrorMsg('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // The trigger button sits at bottom-20 right-4. SWUpdateToast lives at
  // bottom-4 right-4 (with at most a 1–2 line pill, ~40px tall), so a
  // 64px gap keeps us clear without overlap on either side.
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openModal}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="fixed bottom-20 right-4 z-40 rounded-full border border-white/10 bg-ink-800/90 px-3.5 py-2 text-xs font-medium text-slate-100 shadow-lg backdrop-blur transition hover:bg-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-fate-500"
      >
        <span aria-hidden="true" className="mr-1.5">💬</span>
        Feedback
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="presentation"
        >
          {/* Backdrop. Click closes. */}
          <button
            type="button"
            aria-label="Close feedback dialog"
            onClick={closeModal}
            className="absolute inset-0 h-full w-full cursor-default bg-ink-950/70 backdrop-blur-sm"
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            className="relative w-full max-w-md rounded-xl border border-white/10 bg-ink-900 p-5 text-slate-100 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id={titleId} className="text-base font-semibold">
                  Send feedback
                </h2>
                <p id={descId} className="mt-1 text-xs text-slate-400">
                  Tell us what worked or what tripped you up. We read every note.
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="rounded-full px-2 py-0.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-300">
                  How was it?
                </label>
                <div className="mt-1">
                  <StarRow value={rating} onChange={setRating} disabled={submitting} />
                </div>
              </div>

              <div>
                <label htmlFor={textareaId} className="block text-xs font-medium text-slate-300">
                  Your note
                </label>
                <textarea
                  ref={textareaRef}
                  id={textareaId}
                  value={text}
                  onChange={(ev) => setText(ev.target.value.slice(0, TEXT_MAX))}
                  maxLength={TEXT_MAX}
                  rows={5}
                  disabled={submitting}
                  required
                  placeholder="What's on your mind?"
                  className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-fate-500 focus:outline-none focus:ring-1 focus:ring-fate-500 disabled:opacity-60"
                />
                <div className="mt-1 text-right text-[11px] text-slate-500">
                  {text.length}/{TEXT_MAX}
                </div>
              </div>

              <div>
                <label htmlFor={emailId} className="block text-xs font-medium text-slate-300">
                  Email <span className="text-slate-500">(optional, if you want a reply)</span>
                </label>
                <input
                  id={emailId}
                  type="email"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  disabled={submitting}
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-fate-500 focus:outline-none focus:ring-1 focus:ring-fate-500 disabled:opacity-60"
                />
              </div>

              {errorMsg && (
                <div
                  id={errorId}
                  role="alert"
                  className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
                >
                  {errorMsg}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={submitting}
                  className="rounded-md px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/5 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !rating || !text.trim()}
                  className="rounded-md bg-fate-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-fate-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? 'Sending…' : 'Send feedback'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showThanks && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-20 right-4 z-50 max-w-xs"
        >
          <div className="flex items-center gap-2 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-4 py-2 text-xs text-emerald-100 shadow-lg backdrop-blur">
            <span aria-hidden="true">✓</span>
            <span className="font-medium">Thanks! Feedback received.</span>
          </div>
        </div>
      )}
    </>
  )
}
