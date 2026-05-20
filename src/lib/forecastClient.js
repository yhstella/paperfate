// PaperFate · frontend client for /api/forecast
// Pure presentation logic — calls the server endpoint, optionally falls
// back to the local mock engine if the server is unreachable.

import { simulate as mockSimulate } from './mockEngine.js'

const API_PATH = '/api/forecast'

// Map the legacy mock-engine output to the new server schema so the UI
// can render both interchangeably. The server returns the canonical
// extract.js shape; the mock returns the older Simulator.jsx shape.
function adaptMockToServer(mockResult, input) {
  return {
    mode: 'mock',
    article_type: input.field || '*',
    items_attempted: 0,
    items_scored: 0,
    overall_score: mockResult.score,
    domain_rollup: [],
    strongest_domains: [],
    weakest_domains: [],
    key_weaknesses: [],
    items: [],
    legacy: {
      score:      mockResult.score,
      tier:       mockResult.tier,
      deskReject: mockResult.deskReject,
      timeline:   mockResult.timeline,
      citation:   mockResult.citation,
      weakness:   mockResult.weakness,
      suggestions: mockResult.suggestions,
      similars:   mockResult.similars,
      journey:    mockResult.journey,
    },
    rubric_version: 'mock',
  }
}

/**
 * forecast — calls the server. If the server is unreachable AND
 * fallbackMock is true, returns the local mock result wrapped in the
 * server schema. Otherwise throws.
 */
export async function forecast(input, opts = {}) {
  const { signal, fallbackMock = true, useMock = false } = opts

  if (useMock) {
    return adaptMockToServer(mockSimulate({
      title: input.title,
      abstract: input.abstract,
      field: input.field || 'Other',
      studyType: input.studyType || 'Other',
      sampleSize: input.sampleSize || 0,
      validation: input.validation || 'Not applicable',
      target: input.target || 'IF 5–10',
      multicenter: input.multicenter || false,
      endpoints: input.endpoints || [],
    }), input)
  }

  const body = {
    title: input.title,
    abstract: input.abstract,
    methods: input.methods,
    results: input.results,
    discussion: input.discussion,
    full_text: input.full_text,
    article_type: input.article_type || '*',
    mode: input.mode || 'auto',
  }

  try {
    const res = await fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`/api/forecast HTTP ${res.status}: ${detail.slice(0, 200)}`)
    }
    return await res.json()
  } catch (err) {
    if (fallbackMock) {
      console.warn('forecast: falling back to mock engine —', err.message)
      const wrapped = adaptMockToServer(mockSimulate({
        title: input.title,
        abstract: input.abstract,
        field: input.field || 'Other',
        studyType: input.studyType || 'Other',
        sampleSize: input.sampleSize || 0,
        validation: input.validation || 'Not applicable',
        target: input.target || 'IF 5–10',
        multicenter: input.multicenter || false,
        endpoints: input.endpoints || [],
      }), input)
      wrapped.mock_fallback_reason = err.message
      return wrapped
    }
    throw err
  }
}

// Domain colour map used by the rollup chart
export const DOMAIN_COLORS = {
  QUEST:  '#a78bfa', NOVEL:  '#f472b6', RELEV:  '#34d399', DESIGN: '#60a5fa',
  POPUL:  '#fbbf24', EXPOS:  '#fb923c', OUTCM:  '#22d3ee', STATS:  '#8b5cf6',
  BIAS:   '#f87171', EXTV:   '#10b981', AIPRED: '#c084fc', REPRT:  '#94a3b8',
  INTERP: '#facc15', FIGS:   '#7dd3fc',
}

export const DOMAIN_NAMES = {
  QUEST:  'Research question',
  NOVEL:  'Novelty',
  RELEV:  'Relevance',
  DESIGN: 'Study design',
  POPUL:  'Population',
  EXPOS:  'Exposure/intervention',
  OUTCM:  'Outcomes',
  STATS:  'Statistical rigor',
  BIAS:   'Bias / internal validity',
  EXTV:   'External validity',
  AIPRED: 'AI / prediction',
  REPRT:  'Reporting',
  INTERP: 'Interpretation',
  FIGS:   'Figures',
}
