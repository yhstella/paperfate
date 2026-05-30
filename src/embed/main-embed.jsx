import React from 'react'
import ReactDOM from 'react-dom/client'
import SimulatorEmbed from './SimulatorEmbed.jsx'

// Entry point for /embed.html — a slimmed PaperFate simulator suitable for
// iframe embedding on third-party blogs. No Nav, no tabs, no history. The
// React tree under #pf-embed-root is independent from the main App.

const rootEl = document.getElementById('pf-embed-root')
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <SimulatorEmbed />
    </React.StrictMode>,
  )
}
