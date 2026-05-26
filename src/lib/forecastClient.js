// PaperFate · frontend client for /api/forecast
// Pure presentation logic — calls the server endpoint, optionally falls
// back to the local mock engine if the server is unreachable.

import { simulate as mockSimulate } from './mockEngine.js'

const API_PATH = '/api/forecast'
const SIMILAR_PATH = '/api/similar'
const JOURNAL_INFO_PATH = '/api/journal-info'
const REFERENCES_PATH = '/api/references'
const AUTHOR_FEATURES_PATH = '/api/author-features'

export async function fetchAuthorFeatures(authors, { signal } = {}) {
  const clean = Array.isArray(authors)
    ? authors.map(s => String(s || '').trim()).filter(s => s.length >= 3)
    : []
  if (!clean.length) return null
  try {
    const res = await fetch(AUTHOR_FEATURES_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authors: clean.slice(0, 25) }),
      signal,
    })
    if (!res.ok) throw new Error(`/api/author-features HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.warn('fetchAuthorFeatures failed:', err.message)
    return null
  }
}

export async function fetchReferencesSummary(dois, { signal } = {}) {
  const clean = Array.isArray(dois)
    ? [...new Set(dois.map(s => String(s || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, ''))
        .filter(d => /^10\./.test(d)))]
    : []
  if (!clean.length) return null
  try {
    const res = await fetch(REFERENCES_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dois: clean.slice(0, 50) }),
      signal,
    })
    if (!res.ok) throw new Error(`/api/references HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.warn('fetchReferencesSummary failed:', err.message)
    return null
  }
}

export async function fetchJournalInfo(queryRaw, { signal } = {}) {
  const q = String(queryRaw || '').trim()
  if (q.length < 3) return null
  const isIssn = /^\d{4}-?\d{3}[\dxX]$/.test(q.replace(/\s+/g, ''))
  const url = `${JOURNAL_INFO_PATH}?${isIssn ? 'issn' : 'name'}=${encodeURIComponent(q)}`
  try {
    const res = await fetch(url, { signal })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`/api/journal-info HTTP ${res.status}`)
    const json = await res.json()
    return json.journal || null
  } catch (err) {
    console.warn('fetchJournalInfo failed:', err.message)
    return null
  }
}

export async function fetchSimilar({ title, abstract }, { signal } = {}) {
  try {
    const res = await fetch(SIMILAR_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, abstract }),
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`/api/similar HTTP ${res.status}: ${detail.slice(0, 200)}`)
    }
    const json = await res.json()
    return Array.isArray(json.similars) ? json.similars : []
  } catch (err) {
    console.warn('fetchSimilar failed:', err.message)
    return []
  }
}

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
    ...(input.author_features && typeof input.author_features === 'object' && { author_features: input.author_features }),
    ...(input.target_journal && { target_journal: input.target_journal }),
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
