import { useMemo, useState } from 'react'
import { simulate } from '../lib/mockEngine.js'
import ResultPanel from './ResultPanel.jsx'

const SAMPLE = {
  title: 'A multicenter deep-learning model for HCC risk prediction in chronic hepatitis B',
  abstract: 'Background: Hepatocellular carcinoma (HCC) remains a leading cause of cancer mortality. Existing risk scores have limited discrimination. We developed and externally validated a deep-learning model that integrates routine laboratory data and FibroScan-derived liver stiffness to stratify HCC risk in chronic hepatitis B patients. Methods: We retrospectively enrolled 12,438 CHB patients from 7 tertiary centers in South Korea, Taiwan, and Japan (2009-2022). The model was trained on 8,210 patients and externally validated on two independent cohorts (n=2,114 and n=2,114). Primary endpoint was HCC development within 5 years. Results: Median follow-up was 6.4 years; 612 HCC events occurred. The model achieved a time-dependent AUC of 0.872 (95% CI 0.851-0.893) in external validation, outperforming PAGE-B (0.764) and mPAGE-B (0.791). Decision curve analysis showed net benefit across clinically relevant thresholds. Conclusions: Our externally validated model improves HCC risk stratification in CHB and may support personalized surveillance.',
  field: 'Hepatology',
  studyType: 'Multicenter retrospective cohort',
  sampleSize: 12438,
  validation: 'External (2 cohorts)',
  target: 'IF 10–15',
}

export default function Simulator() {
  const [form, setForm] = useState({
    title: '', abstract: '', field: 'Hepatology',
    studyType: 'Retrospective cohort', sampleSize: '',
    validation: 'Internal only', target: 'IF 5–10',
  })
  const [status, setStatus] = useState('idle') // idle | running | done
  const [result, setResult] = useState(null)

  const charCount = form.abstract.length
  const canRun = form.title.trim().length > 10 && charCount > 200

  function onChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  function loadSample() {
    setForm(SAMPLE)
    setStatus('idle')
    setResult(null)
  }

  async function onSubmit(e) {
    e.preventDefault()
    if (!canRun) return
    setStatus('running')
    setResult(null)
    // simulate latency so the UX feels real
    await new Promise(r => setTimeout(r, 1400))
    const r = simulate(form)
    setResult(r)
    setStatus('done')
    setTimeout(() => {
      document.getElementById('result')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  return (
    <section id="simulator" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">The simulator</h2>
          <p className="mt-3 text-slate-400">
            Paste your title and abstract. PaperFate retrieves comparable published papers,
            normalizes citation patterns by field and year, and returns a probabilistic forecast.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-slate-400">
            <Bullet>Embeddings + OpenAlex similarity (top-200)</Bullet>
            <Bullet>Field- and year-normalized citation percentiles</Bullet>
            <Bullet>Journal tier modeled from venue history of similar work</Bullet>
            <Bullet>LLM-graded novelty, methods, clinical relevance</Bullet>
          </ul>
          <button onClick={loadSample} type="button" className="mt-6 text-xs text-fate-300 underline-offset-4 hover:underline">
            ↳ Try a sample manuscript
          </button>
        </div>

        <form onSubmit={onSubmit} className="card p-5 sm:p-6 lg:col-span-3">
          <div className="space-y-4">
            <Field label="Title">
              <input
                name="title" value={form.title} onChange={onChange}
                placeholder="e.g., A multicenter deep-learning model for HCC risk prediction…"
                className="input"
              />
            </Field>

            <Field label="Abstract" hint={`${charCount} chars · min 200`}>
              <textarea
                name="abstract" value={form.abstract} onChange={onChange}
                rows={8}
                placeholder="Paste your full abstract. The richer the structured detail (methods, sample size, endpoint, validation), the sharper the forecast."
                className="input resize-y leading-relaxed"
              />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Field">
                <select name="field" value={form.field} onChange={onChange} className="input">
                  {['Hepatology','Gastroenterology','Oncology','Cardiology','Endocrinology','Radiology','Pulmonology','Neurology','Surgery','Infectious disease','Other'].map(v => <option key={v}>{v}</option>)}
                </select>
              </Field>
              <Field label="Study type">
                <select name="studyType" value={form.studyType} onChange={onChange} className="input">
                  {['Multicenter retrospective cohort','Retrospective cohort','Prospective cohort','RCT','Meta-analysis / systematic review','Case-control','Cross-sectional','Basic / translational','Modeling / AI'].map(v => <option key={v}>{v}</option>)}
                </select>
              </Field>
              <Field label="Sample size">
                <input name="sampleSize" value={form.sampleSize} onChange={onChange} type="number" min="0" placeholder="e.g., 1240" className="input" />
              </Field>
              <Field label="Validation">
                <select name="validation" value={form.validation} onChange={onChange} className="input">
                  {['Internal only','External (1 cohort)','External (2 cohorts)','External (≥3 cohorts)','None'].map(v => <option key={v}>{v}</option>)}
                </select>
              </Field>
              <Field label="Target tier">
                <select name="target" value={form.target} onChange={onChange} className="input">
                  {['IF <5','IF 5–10','IF 10–15','IF 15–25','IF >25 (top-tier)'].map(v => <option key={v}>{v}</option>)}
                </select>
              </Field>
            </div>

            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-slate-500">
                Nothing is stored. The beta runs locally in your browser.
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
        {status === 'done' && result && <ResultPanel result={result} input={form} />}
      </div>
    </section>
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
