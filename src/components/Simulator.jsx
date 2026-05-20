import { useMemo, useState } from 'react'
import { forecast } from '../lib/forecastClient.js'
import { extractAll } from '../lib/extractMeta.js'
import ResultPanel from './ResultPanel.jsx'
import DomainRollup from './DomainRollup.jsx'
import FileUpload from './FileUpload.jsx'

const FIELDS = [
  'Auto-detect',
  'Oncology', 'Cardiology', 'Neurology', 'Endocrinology',
  'Infectious disease', 'Pulmonology', 'Gastroenterology', 'Nephrology',
  'Rheumatology', 'Psychiatry', 'Surgery', 'Radiology', 'Pediatrics',
  'Public health', 'Hepatology', 'Basic / translational', 'Other',
]

const STUDY_TYPES = [
  'Auto-detect',
  'Randomized controlled trial',
  'Meta-analysis / systematic review',
  'Multicenter retrospective cohort',
  'Prospective cohort',
  'Retrospective cohort',
  'Case-control',
  'Cross-sectional',
  'Modeling / AI',
  'Basic / translational',
  'Other',
]

const TARGETS = ['Auto-recommend', 'IF <5', 'IF 5–10', 'IF 10–15', 'IF 15–25', 'IF >25 (top-tier)']

const SAMPLE = {
  title: 'Empagliflozin and major adverse cardiovascular events in adults with chronic kidney disease',
  text: `Background: SGLT2 inhibitors reduce cardiovascular events in patients with type 2 diabetes, but their effect in adults with chronic kidney disease (CKD) without diabetes is uncertain.
Methods: In this international, multicenter, double-blind, placebo-controlled trial, we randomly assigned 6,609 adults with CKD (eGFR 20–45 ml/min/1.73 m^2 or eGFR 45–90 with albuminuria) to empagliflozin 10 mg daily or matching placebo. The primary composite outcome was progression of kidney disease or death from cardiovascular causes. Secondary outcomes included hospitalization for heart failure and all-cause mortality.
Results: Median follow-up was 2.0 years. The primary outcome occurred in 432 of 3,304 participants (13.1%) in the empagliflozin group and in 558 of 3,305 (16.9%) in the placebo group (hazard ratio 0.72, 95% CI 0.64–0.82, P<0.001). Effects were consistent across pre-specified subgroups including patients without diabetes and those with the lowest baseline eGFR.
Conclusions: Empagliflozin reduced the risk of kidney-disease progression or cardiovascular death in adults with CKD, with and without diabetes.`,
  inputMode: 'abstract',
}

const PLACEHOLDER = `Paste your abstract here. PaperFate will read it and auto-detect study type, sample size, field, and endpoints — you can correct anything below before simulating.

Tip: structured abstracts (Background / Methods / Results / Conclusions) give the sharpest forecast.`

const STUDY_TYPE_TO_ARTICLE_TYPE = {
  'Randomized controlled trial':        'RCT',
  'Meta-analysis / systematic review':  'meta_analysis',
  'Multicenter retrospective cohort':   'clinical_cohort',
  'Prospective cohort':                 'clinical_cohort',
  'Retrospective cohort':               'clinical_cohort',
  'Case-control':                       'case_control',
  'Cross-sectional':                    'cross_sectional',
  'Modeling / AI':                      'prediction_model',
  'Basic / translational':              'basic_translational',
  'Other':                              '*',
}

export default function Simulator() {
  const [inputMode, setInputMode] = useState('abstract')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [overrides, setOverrides] = useState({})
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)

  const meta = useMemo(() => extractAll(`${title}\n${text}`), [title, text])
  const charCount = text.length
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0
  const minChars = inputMode === 'full' ? 1000 : 200
  const canRun = title.trim().length > 8 && charCount >= minChars

  function get(key, fallback) {
    if (overrides[key] && overrides[key] !== 'Auto-detect' && overrides[key] !== 'Auto-recommend') return overrides[key]
    if (meta[key]?.value) return meta[key].value
    return fallback
  }

  function loadSample() {
    setTitle(SAMPLE.title)
    setText(SAMPLE.text)
    setInputMode(SAMPLE.inputMode)
    setOverrides({})
    setStatus('idle')
    setResult(null)
  }

  async function onSubmit(e) {
    e.preventDefault()
    if (!canRun) return
    setStatus('running')
    setResult(null)
    const studyType = get('studyType', 'Other')
    const articleType = STUDY_TYPE_TO_ARTICLE_TYPE[studyType] || '*'
    const input = {
      title,
      abstract: text,
      field:       get('field', 'Other'),
      studyType,
      sampleSize:  get('sampleSize', 0),
      article_type: articleType,
      multicenter: meta.multicenter?.value || false,
      endpoints:   meta.endpoints?.value || [],
      target:      overrides.target && overrides.target !== 'Auto-recommend' ? overrides.target : 'IF 5–10',
      mode: inputMode === 'full' ? 'Q500' : 'Q100',
    }
    try {
      // Production: hit /api/forecast (server-side Gemini scoring).
      // Local dev (Vite preview has no /api): falls back to local mock engine
      // so the demo still works while you iterate on the UI.
      const r = await forecast(input, { fallbackMock: true })
      setResult(r)
      setStatus('done')
      setTimeout(() => {
        document.getElementById('result')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 60)
    } catch (err) {
      console.error('forecast failed:', err)
      setStatus('idle')
    }
  }

  return (
    <section id="simulator" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">The simulator</h2>
          <p className="mt-3 text-slate-400">
            Paste your title and abstract — or the full manuscript. PaperFate reads the text,
            auto-detects what it can (study type, sample size, field, endpoints), and returns
            a probabilistic forecast.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-slate-400">
            <Bullet>One text box. Structured fields are inferred, not asked.</Bullet>
            <Bullet>Embeddings + OpenAlex similarity (top-200)</Bullet>
            <Bullet>Field- and year-normalized citation percentiles</Bullet>
            <Bullet>LLM-graded novelty, methods, clinical relevance</Bullet>
          </ul>
          <button onClick={loadSample} type="button" className="mt-6 text-xs text-fate-300 underline-offset-4 hover:underline">
            ↳ Try a sample manuscript
          </button>
        </div>

        <form onSubmit={onSubmit} className="card p-5 sm:p-6 lg:col-span-3">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Tabs
                value={inputMode}
                onChange={setInputMode}
                options={[
                  { value: 'abstract', label: 'Abstract' },
                  { value: 'full', label: 'Full manuscript' },
                ]}
              />
              <div className="text-[11px] text-slate-500">
                {wordCount.toLocaleString()} words · {charCount.toLocaleString()} chars
                {charCount > 0 && charCount < minChars && (
                  <span className="ml-2 text-amber-300/80">need {(minChars - charCount).toLocaleString()} more</span>
                )}
              </div>
            </div>

            <Field label="Title">
              <input
                value={title} onChange={e => setTitle(e.target.value)}
                placeholder="Your manuscript title"
                className="input"
              />
            </Field>

            <Field label={inputMode === 'full' ? 'Full manuscript file' : 'Abstract'}>
              {inputMode === 'full' ? (
                <FileUpload
                  onText={setText}
                  currentTextLength={charCount}
                  hint="Headings, tables, and references are extracted as plain text. Figures are skipped."
                />
              ) : (
                <textarea
                  value={text} onChange={e => setText(e.target.value)}
                  rows={9}
                  placeholder={PLACEHOLDER}
                  className="input resize-y leading-relaxed"
                />
              )}
            </Field>

            <DetectedPanel
              meta={meta}
              overrides={overrides}
              setOverride={(k, v) => setOverrides(o => ({ ...o, [k]: v }))}
              targetValue={overrides.target || 'Auto-recommend'}
            />

            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-slate-500">
                Nothing is stored. All processing runs locally in your browser.
              </p>
              <button disabled={!canRun || status === 'running'} className="btn-primary">
                {status === 'running' ? <>Simulating<Dots /></> : 'Simulate fate'}
              </button>
            </div>
          </div>
        </form>
      </div>

      <div id="result" className="mt-10 scroll-mt-24">
        {status === 'running' && <SkeletonResult />}
        {status === 'done' && result && (
          <div className="space-y-6">
            <ResultPanel result={resultLegacyShape(result)} input={{ title, abstract: text }} />
            {result.domain_rollup?.length > 0 && (
              <div className="card p-6 animate-fade-up">
                <DomainRollup
                  rollup={result.domain_rollup}
                  keyWeaknesses={result.key_weaknesses}
                />
                {result.pipeline && (
                  <div className="mt-4 text-[11px] text-slate-500">
                    Rule pre-pass: {result.pipeline.rule_pre_pass_hits} items / LLM: {result.pipeline.llm_items} items
                    {result.pipeline.llm_cost_savings_pct > 0 && ` (${result.pipeline.llm_cost_savings_pct}% LLM cost saved)`}
                    {result.cost?.total_usd != null && ` · cost $${result.cost.total_usd}`}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// Adapts the new server schema back to the shape ResultPanel was originally
// designed for, so the existing 6-card layout still renders.
function resultLegacyShape(r) {
  if (r?.legacy) return r.legacy   // already the mock shape
  // Otherwise, derive a legacy-like view from the new schema
  return {
    score: r.overall_score ?? null,
    tier: { range: 'TBD', bestFit: 'TBD', stretch: 'TBD' },
    deskReject: { pct: null, label: '—' },
    timeline: { weeks: '—', note: 'Awaiting server-side forecast wiring' },
    citation: { range: '—', percentile: null, peerMedian: null },
    weakness: r.key_weaknesses?.[0]?.rationale || 'See domain rollup below.',
    suggestions: (r.key_weaknesses || []).slice(0, 5).map(w => `${w.name}: ${w.rationale}`),
    similars: [],
  }
}

function DetectedPanel({ meta, overrides, setOverride, targetValue }) {
  const items = [
    { key: 'field',      label: 'Field',       options: FIELDS,       detected: meta.field?.value,      confidence: meta.field?.confidence },
    { key: 'studyType',  label: 'Study type',  options: STUDY_TYPES,  detected: meta.studyType?.value,  confidence: meta.studyType?.confidence },
    { key: 'sampleSize', label: 'Sample size', input: true,           detected: meta.sampleSize?.value, confidence: meta.sampleSize?.confidence },
  ]
  return (
    <div className="rounded-xl border border-white/5 bg-ink-900/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          Auto-detected · correct anything that's off
        </div>
        <ConfidenceLegend />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map(it => (
          <DetectedRow key={it.key} item={it} value={overrides[it.key]} onChange={v => setOverride(it.key, v)} />
        ))}
        <DetectedRow
          item={{ key: 'target', label: 'Target tier', options: TARGETS, detected: null, confidence: null, hint: 'Leave on auto to let PaperFate pick the best fit.' }}
          value={targetValue}
          onChange={v => setOverride('target', v)}
        />
      </div>
      {meta.multicenter?.value && (
        <div className="mt-3 text-[11px] text-slate-500">
          Also detected: multicenter{meta.multicenter.count ? ` (${meta.multicenter.count} centers)` : ''}.
          {meta.endpoints?.value?.length ? ` Endpoints: ${meta.endpoints.value.join(', ')}.` : ''}
        </div>
      )}
    </div>
  )
}

function DetectedRow({ item, value, onChange }) {
  const detected = item.detected
  const conf = item.confidence
  const chipTone =
    !detected ? 'border-white/10 text-slate-500' :
    conf >= 0.8 ? 'border-emerald-400/30 text-emerald-300/90 bg-emerald-400/[0.06]' :
    conf >= 0.6 ? 'border-amber-400/30 text-amber-200/90 bg-amber-400/[0.06]' :
                  'border-slate-500/30 text-slate-400'
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{item.label}</span>
        <span className={`chip border ${chipTone}`}>
          {!detected ? 'not detected' : conf >= 0.8 ? 'high conf.' : conf >= 0.6 ? 'medium' : 'low'}
        </span>
      </div>
      {item.input ? (
        <input
          type="number" min="0"
          value={value ?? detected ?? ''}
          onChange={e => onChange(e.target.value ? Number(e.target.value) : '')}
          placeholder="(auto)"
          className="input"
        />
      ) : (
        <select
          value={value ?? (detected || item.options[0])}
          onChange={e => onChange(e.target.value)}
          className="input"
        >
          {item.options.map(o => <option key={o} value={o}>{o}{o === detected ? '  ← detected' : ''}</option>)}
        </select>
      )}
    </label>
  )
}

function ConfidenceLegend() {
  return (
    <div className="hidden gap-1.5 sm:flex">
      <span className="chip border-emerald-400/30 text-emerald-300/90">high</span>
      <span className="chip border-amber-400/30 text-amber-200/90">medium</span>
      <span className="chip border-white/10 text-slate-500">none</span>
    </div>
  )
}

function Tabs({ value, onChange, options }) {
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-ink-900 p-1 text-xs">
      {options.map(o => (
        <button
          key={o.value} type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 transition ${value === o.value ? 'bg-fate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</span>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

function Bullet({ children }) {
  return (
    <li className="flex gap-2">
      <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-fate-400" />
      <span>{children}</span>
    </li>
  )
}

function Dots() {
  return <span className="ml-1 inline-flex w-4 justify-start"><span className="animate-pulse">…</span></span>
}

function SkeletonResult() {
  return (
    <div className="card p-6 animate-fade-up">
      <div className="h-5 w-40 rounded bg-white/5 mb-4 animate-pulse" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-ink-900 p-4">
            <div className="h-3 w-24 rounded bg-white/5 mb-3 animate-pulse" />
            <div className="h-6 w-32 rounded bg-white/10 mb-2 animate-pulse" />
            <div className="h-3 w-full rounded bg-white/5 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
