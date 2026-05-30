// PaperFate · ErrorBoundary
//
// Standard React class ErrorBoundary. Renders a centered card with a
// friendly message + Reload button when a child subtree throws. Also
// stamps an 'app_error' telemetry event with the component name and
// first 60 chars of the error message.
//
// Props:
//   - children: subtree to guard
//   - name: optional string label for the boundary (used in telemetry)

import { Component } from 'react'
import { trackEvent } from '../lib/telemetry.js'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
    this.handleReload = this.handleReload.bind(this)
  }

  static getDerivedStateFromError(error) {
    const message = error && error.message ? String(error.message) : 'Unknown error'
    return { hasError: true, message }
  }

  componentDidCatch(error, _info) {
    try {
      const raw = error && error.message ? String(error.message) : 'Unknown error'
      const first60 = raw.length > 60 ? raw.slice(0, 60) : raw
      trackEvent('app_error', {
        component: this.props && this.props.name ? String(this.props.name) : 'unknown',
        message_first_60_chars: first60,
      })
    } catch {
      // Never let telemetry break the fallback UI.
    }
  }

  handleReload() {
    try {
      if (typeof location !== 'undefined' && typeof location.reload === 'function') {
        location.reload()
      }
    } catch {
      // no-op
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mx-auto max-w-md px-4 py-12">
          <div className="rounded-xl border border-white/10 bg-ink-900 p-6 text-center shadow-lg">
            <p className="text-sm text-slate-200">
              Something went wrong on this page. Try reloading.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-4 inline-flex items-center justify-center rounded-md bg-fate-600 px-4 py-2 text-sm font-medium text-white hover:bg-fate-500 focus:outline-none focus:ring-2 focus:ring-fate-400"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
