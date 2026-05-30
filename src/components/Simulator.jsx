import { useEffect, useMemo, useRef, useState } from 'react'
import { forecast, fetchSimilar, fetchJournalInfo, fetchReferencesSummary, fetchAuthorFeatures, abstractQuality, DOMAIN_COLORS, DOMAIN_NAMES } from '../lib/forecastClient.js'
import { extractAll, extractAuthors, extractDois } from '../lib/extractMeta.js'
import { trackEvent } from '../lib/telemetry.js'
import ResultPanel from './ResultPanel.jsx'
import DomainRollup from './DomainRollup.jsx'
import FileUpload from './FileUpload.jsx'

function roundTo(v, digits = 1) {
  if (!Number.isFinite(+v)) return null
  const m = Math.pow(10, digits)
  return Math.round((+v) * m) / m
}

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

const SAMPLES = [
  {
    key: 'rct_cardiometabolic',
    label: 'RCT · cardiometabolic',
    title: 'Empagliflozin and major adverse cardiovascular events in adults with chronic kidney disease',
    text: `Background: SGLT2 inhibitors reduce cardiovascular events in patients with type 2 diabetes, but their effect in adults with chronic kidney disease (CKD) without diabetes is uncertain.
Methods: In this international, multicenter, double-blind, placebo-controlled trial, we randomly assigned 6,609 adults with CKD (eGFR 20–45 ml/min/1.73 m^2 or eGFR 45–90 with albuminuria) to empagliflozin 10 mg daily or matching placebo. The primary composite outcome was progression of kidney disease or death from cardiovascular causes. Secondary outcomes included hospitalization for heart failure and all-cause mortality.
Results: Median follow-up was 2.0 years. The primary outcome occurred in 432 of 3,304 participants (13.1%) in the empagliflozin group and in 558 of 3,305 (16.9%) in the placebo group (hazard ratio 0.72, 95% CI 0.64–0.82, P<0.001). Effects were consistent across pre-specified subgroups including patients without diabetes and those with the lowest baseline eGFR.
Conclusions: Empagliflozin reduced the risk of kidney-disease progression or cardiovascular death in adults with CKD, with and without diabetes.`,
    inputMode: 'abstract',
  },
  {
    key: 'meta_oncology',
    label: 'Meta-analysis · oncology',
    title: 'Immune checkpoint inhibitors versus chemotherapy in advanced non–small-cell lung cancer: a meta-analysis of randomized trials',
    text: `Background: First-line therapy for advanced non–small-cell lung cancer (NSCLC) has shifted toward immune checkpoint inhibitors (ICIs), but comparative effectiveness across PD-L1 expression subgroups remains debated.
Methods: We systematically searched PubMed, Embase, and Cochrane CENTRAL through December 2024 for phase III randomized trials comparing first-line ICI-based regimens with platinum-doublet chemotherapy in advanced NSCLC without targetable driver alterations. Two reviewers independently extracted data and assessed risk of bias using Cochrane RoB 2. The primary outcome was overall survival (OS); secondary outcomes were progression-free survival (PFS), objective response rate (ORR), and grade ≥3 immune-related adverse events. We pooled hazard ratios (HRs) using random-effects models, stratified by PD-L1 tumor proportion score (TPS).
Results: Fourteen trials including 8,742 patients met inclusion criteria. ICI-based regimens improved OS over chemotherapy alone (HR 0.74, 95% CI 0.69–0.80, I²=42%). The OS benefit was largest in PD-L1 TPS ≥50% (HR 0.66, 95% CI 0.57–0.76) and attenuated in TPS <1% (HR 0.85, 95% CI 0.74–0.97). Grade ≥3 immune-related events occurred in 17.4% of ICI recipients versus 4.2% with chemotherapy.
Conclusions: First-line ICI-based therapy improves OS in advanced NSCLC across PD-L1 strata, with greatest benefit in PD-L1-high tumors.`,
    inputMode: 'abstract',
  },
  {
    key: 'observational_pediatric',
    label: 'Cohort · pediatrics',
    title: 'Early antibiotic exposure and incident childhood asthma in a population-based birth cohort',
    text: `Background: Early-life antibiotic exposure has been hypothesized to perturb the developing microbiome and increase asthma risk, but evidence from large cohorts with confounding control is inconsistent.
Methods: We assembled a population-based birth cohort of 412,098 children born between 2008 and 2018 from linked national health registries in Denmark. Antibiotic dispensations during the first year of life were classified by spectrum and indication. The outcome was a recorded diagnosis of asthma between ages 2 and 10. We used Cox proportional hazards models adjusted for maternal asthma, mode of delivery, gestational age, breastfeeding duration, household smoking, and socioeconomic indicators. Sibling-pair analyses were performed to address shared familial confounding.
Results: 89,431 children (21.7%) received ≥1 antibiotic course in year 1. Asthma was diagnosed in 36,219 children (8.8%) over median 6.4 years of follow-up. After adjustment, year-1 antibiotic exposure was associated with incident asthma (HR 1.27, 95% CI 1.24–1.31). The association attenuated but remained in sibling-pair analyses (HR 1.11, 95% CI 1.05–1.18). Effect estimates were larger for broad-spectrum antibiotics and for exposures associated with non-respiratory indications.
Conclusions: Early antibiotic exposure was modestly associated with childhood asthma after accounting for shared familial factors, supporting a partially causal contribution.`,
    inputMode: 'abstract',
  },
  {
    key: 'ai_imaging',
    label: 'AI · radiology',
    title: 'A deep-learning model for detection of incidental pulmonary embolism on routine chest CT',
    text: `Background: Incidental pulmonary embolism (iPE) on chest CT performed for other indications is underdiagnosed. We developed and externally validated a deep-learning model to flag suspected iPE in real time at the point of imaging.
Methods: Training data comprised 47,302 contrast-enhanced chest CT studies from three academic centers (2014–2022), with iPE labels established by adjudicated radiologist re-read. We trained a 3D convolutional neural network with attention pooling, using only routine chest-CT studies (PE-protocol CTs were excluded). External validation was performed prospectively on 8,914 consecutive chest CTs from a fourth, geographically distinct center. The primary outcome was area under the receiver operating characteristic curve (AUROC) for iPE detection; secondary outcomes included sensitivity and specificity at the operating point and time-to-flag.
Results: In external validation, iPE prevalence was 1.8%. The model achieved AUROC 0.962 (95% CI 0.954–0.970) with sensitivity 92.4% and specificity 96.1% at the prespecified threshold. Median time from image acquisition to flag was 41 seconds. Calibration was preserved across subgroups defined by scanner vendor, slice thickness, and patient body mass index.
Conclusions: A deep-learning model accurately and rapidly detected incidental pulmonary embolism on routine chest CT across an external cohort.`,
    inputMode: 'abstract',
  },
]
const SAMPLE = SAMPLES[0]

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

  const [targetJournalInput, setTargetJournalInput] = useState('')
  const [referencesInput, setReferencesInput] = useState('')
  const [referencesAutoDetected, setReferencesAutoDetected] = useState(false)
  const [authorsInput, setAuthorsInput] = useState('')
  const [authorsAutoDetected, setAuthorsAutoDetected] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')

  // Quick rubric check (Q100 — title + abstract only). Independent of the
  // main forecast flow above; renders an inline preview below the button.
  const [quickStatus, setQuickStatus] = useState('idle')
  const [quickResult, setQuickResult] = useState(null)
  const [quickError, setQuickError] = useState(null)

  // Track sim_mount exactly once on first render (StrictMode-safe).
  const mountedRef = useRef(false)
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true
    trackEvent('sim_mount', {})
  }, [])

  // Ref to the form so Ctrl/Cmd+Enter from any text input can request a
  // native submit (preserves built-in validation + our onSubmit handler).
  const formRef = useRef(null)
  function onTextKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (formRef.current && typeof formRef.current.requestSubmit === 'function') {
        formRef.current.requestSubmit()
      } else if (formRef.current) {
        // Fallback for older browsers without requestSubmit().
        formRef.current.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
      }
    }
  }

  // Wrap setInputMode so tab changes fire telemetry. Avoid emitting on the
  // initial value the component was constructed with.
  function changeTab(next) {
    if (next !== inputMode) {
      trackEvent('sim_tab_change', { tab: next })
    }
    setInputMode(next)
  }

  const meta = useMemo(() => extractAll(`${title}\n${text}`), [title, text])
  const charCount = text.length
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0
  const minChars = inputMode === 'full' ? 1000 : 200
  const canRun = title.trim().length > 8 && charCount >= minChars

  // Scroll the result panel into view on both 'running' (skeleton) and 'done'
  // (final cards) state transitions, so the user always sees status feedback
  // even on small mobile viewports where the form fills the screen.
  useEffect(() => {
    if (status === 'running' || status === 'done') {
      const t = setTimeout(() => {
        document.getElementById('result')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 60)
      return () => clearTimeout(t)
    }
  }, [status])

  // Elapsed-time counter that runs only while a forecast is in flight.
  useEffect(() => {
    if (status !== 'running') {
      setElapsedSec(0)
      setProgressLabel('')
      return
    }
    const startedAt = Date.now()
    const id = setInterval(() => {
      const sec = Math.round((Date.now() - startedAt) / 1000)
      setElapsedSec(sec)
      const expectedMid = inputMode === 'full' ? 90 : 25
      if (sec < expectedMid * 0.3) setProgressLabel('extracting features')
      else if (sec < expectedMid * 0.7) setProgressLabel('LLM Q-rubric scoring')
      else if (sec < expectedMid * 1.1) setProgressLabel('FateCore inference')
      else if (sec < expectedMid * 1.5) setProgressLabel('finalising')
      else setProgressLabel('still running… (high traffic)')
    }, 500)
    return () => clearInterval(id)
  }, [status, inputMode])

  // Auto-detect authors and reference DOIs from full-manuscript uploads.
  // Only fills the input when the user hasn't typed something else there.
  useEffect(() => {
    if (inputMode !== 'full') return
    if (!text || text.length < 500) return
    if (!authorsInput.trim() || authorsAutoDetected) {
      const found = extractAuthors(text)
      if (found.length >= 2) {
        setAuthorsInput(found.join('\n'))
        setAuthorsAutoDetected(true)
      }
    }
    if (!referencesInput.trim() || referencesAutoDetected) {
      const dois = extractDois(text, 50)
      if (dois.length >= 1) {
        setReferencesInput(dois.join('\n'))
        setReferencesAutoDetected(true)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, inputMode])

  function get(key, fallback) {
    if (overrides[key] && overrides[key] !== 'Auto-detect' && overrides[key] !== 'Auto-recommend') return overrides[key]
    if (meta[key]?.value) return meta[key].value
    return fallback
  }

  function loadSample(sample = SAMPLE) {
    setTitle(sample.title)
    setText(sample.text)
    setInputMode(sample.inputMode)
    setOverrides({})
    setStatus('idle')
    setResult(null)
    setTargetJournalInput('')
    setReferencesInput('')
    setAuthorsInput('')
    setReferencesAutoDetected(false)
    setAuthorsAutoDetected(false)
    trackEvent('sim_sample_load', { sample_name: sample.key })
  }

  // Resolve the same article_type the main forecast pass would use, so the
  // quick check reuses the Round 1 auto-classifier output rather than
  // re-deriving from scratch.
  function resolveArticleType() {
    const studyType = get('studyType', 'Other')
    let articleType = STUDY_TYPE_TO_ARTICLE_TYPE[studyType] || '*'
    const userStudyTypeRaw = overrides.studyType
    const detectedStudyType = meta.studyType?.value
    if (!userStudyTypeRaw || userStudyTypeRaw === 'Auto-detect') {
      if (!detectedStudyType) {
        const abs = text || ''
        if (/\b(randomi[sz]ed|placebo-controlled|double-blind)\b/i.test(abs)) {
          articleType = 'RCT'
        } else if (/\bsystematic review|meta-analysis\b/i.test(abs)) {
          articleType = 'systematic_review'
        } else if (/\bretrospectively|chart review|electronic health record\b/i.test(abs)) {
          articleType = 'cohort_retrospective'
        } else if (/\bprospective cohort|longitudinal\b/i.test(abs)) {
          articleType = 'cohort_prospective'
        } else {
          articleType = 'observational'
        }
      }
    }
    return articleType
  }

  async function onQuickCheck() {
    if (!canRun || quickStatus === 'running') return
    setQuickStatus('running')
    setQuickResult(null)
    setQuickError(null)
    const articleType = resolveArticleType()
    trackEvent('sim_quick_submit', {
      article_type: articleType,
      abstract_len: text.length,
    })
    const t0 = Date.now()
    try {
      const r = await abstractQuality({
        title,
        abstract: text,
        article_type: articleType,
      })
      setQuickResult(r)
      setQuickStatus('done')
      const llmHealth = r?.llm_health || null
      const extractorUsed = r?.extractor_used || null
      const degraded =
        (llmHealth && llmHealth.status === 'degraded') ||
        extractorUsed === 'rule_fallback' ||
        extractorUsed === 'mock' ||
        extractorUsed === 'deterministic'
      trackEvent('sim_quick_result_ok', {
        wall_ms: Date.now() - t0,
        extractor_used: extractorUsed || 'unknown',
        degraded: !!degraded,
        overall_score: Number.isFinite(+r?.overall_score) ? Math.round(+r.overall_score) : null,
      })
    } catch (err) {
      console.warn('abstractQuality failed:', err.message)
      setQuickError(err.message || 'Quick check unavailable')
      setQuickStatus('error')
      trackEvent('sim_quick_result_error', {
        http_or_code: (err && (err.code || err.status || err.message?.slice(0, 80))) || 'unknown',
      })
    }
  }

  async function onSubmit(e) {
    e.preventDefault()
    if (!canRun) return
    setStatus('running')
    setResult(null)
    const studyType = get('studyType', 'Other')
    let articleType = STUDY_TYPE_TO_ARTICLE_TYPE[studyType] || '*'
    // If the user left study-type on Auto-detect (i.e. no override and no
    // confident extractor hit), do a light client-side classification from the
    // abstract text so the server gets a usable article_type instead of '*'.
    const userStudyTypeRaw = overrides.studyType
    const detectedStudyType = meta.studyType?.value
    if (!userStudyTypeRaw || userStudyTypeRaw === 'Auto-detect') {
      if (!detectedStudyType) {
        const abs = text || ''
        if (/\b(randomi[sz]ed|placebo-controlled|double-blind)\b/i.test(abs)) {
          articleType = 'RCT'
        } else if (/\bsystematic review|meta-analysis\b/i.test(abs)) {
          articleType = 'systematic_review'
        } else if (/\bretrospectively|chart review|electronic health record\b/i.test(abs)) {
          articleType = 'cohort_retrospective'
        } else if (/\bprospective cohort|longitudinal\b/i.test(abs)) {
          articleType = 'cohort_prospective'
        } else {
          articleType = 'observational'
        }
      }
    }
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
    const submitStartedAt = Date.now()
    // Snapshot submit-time props (no manuscript text).
    {
      const hasAuthors = authorsInput.trim().length > 0
      const hasRefs = referencesInput.trim().length > 0
      const hasTarget = targetJournalInput.trim().length > 0
      const bodyLen = inputMode === 'full' ? text.length : 0
      const absLen = inputMode === 'full' ? 0 : text.length
      trackEvent('sim_forecast_submit', {
        mode: input.mode,
        has_authors: hasAuthors,
        has_refs: hasRefs,
        has_target: hasTarget,
        article_type: articleType,
        abstract_len: absLen,
        body_len: bodyLen,
      })
    }
    try {
      // Production: hit /api/forecast (server-side Gemini scoring).
      // Local dev (Vite preview has no /api): falls back to local mock engine
      // so the demo still works while you iterate on the UI.
      const tjQuery = targetJournalInput.trim()
      const refDois = referencesInput
        .split(/[\s,;\r\n]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 50)
      const authorNames = authorsInput
        .split(/[\r\n;]+/)
        .map(s => s.replace(/^[\s,]+|[\s,]+$/g, '').trim())
        .filter(s => s.length >= 3)
        .slice(0, 25)

      // All five lookups in parallel. The author-features call resolves in
      // ~1–2 s while /api/forecast resolves the heavy LLM extraction; running
      // them concurrently shaves a few seconds off perceived latency.
      const [authorFeatures, similars, targetJournalInfo, referencesSummary, rNoAuthor] =
        await Promise.all([
          authorNames.length ? fetchAuthorFeatures(authorNames) : Promise.resolve(null),
          fetchSimilar({ title, abstract: text }),
          tjQuery ? fetchJournalInfo(tjQuery) : Promise.resolve(null),
          refDois.length ? fetchReferencesSummary(refDois) : Promise.resolve(null),
          forecast(input, { fallbackMock: true }),
        ])

      // First-pass result: render the heavy forecast we already have plus the
      // light lookups. The user sees something within the longest single call.
      setResult({
        ...rNoAuthor,
        similar_papers: similars,
        target_journal_info: targetJournalInfo,
        references_summary: referencesSummary,
        author_features: authorFeatures,
        __manuscript_text: text,
      })

      // Second pass: if author features came back, re-run the (now-cached) LLM
      // extraction with author_features wired in so v0.2-prod can pull on the
      // h-index inputs. Only fire when authors actually resolved.
      if (authorFeatures && Number.isFinite(authorFeatures.first_author_h_index)) {
        input.author_features = {
          first_author_h_index: authorFeatures.first_author_h_index,
          last_author_h_index: authorFeatures.last_author_h_index,
          max_team_h_index: authorFeatures.max_team_h_index,
          median_team_h_index: authorFeatures.median_team_h_index,
          team_size_with_id: authorFeatures.team_size_with_id,
        }
        forecast(input, { fallbackMock: true })
          .then(r2 => {
            if (!r2) return
            setResult(prev => ({
              ...prev,
              ...r2,
              // Keep the parallel lookups we already paid for
              similar_papers: prev?.similar_papers || similars,
              target_journal_info: prev?.target_journal_info || targetJournalInfo,
              references_summary: prev?.references_summary || referencesSummary,
              author_features: authorFeatures,
              __manuscript_text: text,
            }))
          })
          .catch(err => console.warn('author-aware refine failed:', err.message))
      }
      setStatus('done')
      const llmHealth = rNoAuthor?.llm_health || null
      const extractorUsed = rNoAuthor?.extractor_used || (rNoAuthor?.mode === 'mock' ? 'mock' : 'llm')
      const degraded =
        ['mock', 'rule_fallback', 'deterministic'].includes(extractorUsed) ||
        (llmHealth && llmHealth.status === 'degraded')
      const predJif = rNoAuthor?.predictions?.jcr_jif?.point
      const itemsScored = rNoAuthor?.pipeline?.llm_items
      trackEvent('sim_forecast_result_ok', {
        wall_ms: Date.now() - submitStartedAt,
        extractor_used: extractorUsed || 'unknown',
        items_scored: Number.isFinite(+itemsScored) ? +itemsScored : null,
        degraded: !!degraded,
        predicted_jif: roundTo(predJif, 1),
      })
    } catch (err) {
      console.error('forecast failed:', err)
      setStatus('idle')
      trackEvent('sim_forecast_result_error', {
        http_or_code: (err && (err.code || err.status || err.message?.slice(0, 80))) || 'unknown',
      })
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
          <div className="mt-6">
            <div className="text-xs text-slate-500 mb-2">Try a sample:</div>
            <div className="flex flex-wrap gap-2">
              {SAMPLES.map(s => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => loadSample(s)}
                  aria-label={`Load sample manuscript: ${s.label}`}
                  className="rounded-md border border-fate-400/30 bg-fate-400/[0.06] px-2.5 py-1 text-xs text-fate-300 hover:bg-fate-400/[0.12] transition-colors"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <button onClick={() => loadSample()} type="button" className="mt-3 text-xs text-fate-300 underline-offset-4 hover:underline hidden">
            ↳ Try a sample manuscript
          </button>
        </div>

        <form ref={formRef} onSubmit={onSubmit} className="card p-5 sm:p-6 lg:col-span-3" aria-label="Manuscript forecast form">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Tabs
                value={inputMode}
                onChange={changeTab}
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
            <div className="text-[11px] text-slate-500">
              Abstract → fast scan · Full manuscript → deep rubric (slower, more accurate methods scoring)
            </div>

            {inputMode === 'abstract' && (
              <div className="rounded-md border border-amber-400/20 bg-amber-400/[0.04] p-2.5 text-[11px] text-amber-200/80">
                Abstract-only run — upload the full manuscript for methods-aware scoring.
              </div>
            )}

            <Field label="Title" htmlFor="sim-title">
              <input
                id="sim-title"
                value={title} onChange={e => setTitle(e.target.value)}
                onKeyDown={onTextKeyDown}
                placeholder="Your manuscript title"
                aria-label="Manuscript title"
                className="input"
              />
            </Field>

            <div
              role="tabpanel"
              id={`sim-tabpanel-${inputMode}`}
              aria-labelledby={`sim-tab-${inputMode}`}
            >
            <Field label={inputMode === 'full' ? 'Full manuscript file' : 'Abstract'} htmlFor={inputMode === 'full' ? undefined : 'sim-abstract-textarea'}>
              {inputMode === 'full' ? (
                <FileUpload
                  onText={(t) => {
                    setText(t)
                    if (t && typeof t === 'string' && t.length > 0) {
                      // We don't have direct access to the File object here.
                      // FileUpload owns the filename UI; emit a coarse event
                      // (extension defaults to 'unknown' — the parser already
                      // normalised the text). derived_title reflects whether
                      // a non-empty title is now present (the Field above
                      // also receives the derived title via onTitle).
                      trackEvent('sim_file_upload', {
                        filename_extension: 'unknown',
                        derived_title: !!title.trim(),
                        text_len: t.length,
                      })
                    }
                  }}
                  onTitle={(t) => { if (!title.trim()) setTitle(t) }}
                  currentTextLength={charCount}
                />
              ) : (
                <textarea
                  id="sim-abstract-textarea"
                  value={text} onChange={e => setText(e.target.value)}
                  onKeyDown={onTextKeyDown}
                  rows={9}
                  placeholder={PLACEHOLDER}
                  aria-label="Abstract text"
                  className="input resize-y leading-relaxed"
                />
              )}
            </Field>
            </div>

            <Field label="Target journal (optional)" htmlFor="sim-target-journal">
              <input
                id="sim-target-journal"
                value={targetJournalInput}
                onChange={e => setTargetJournalInput(e.target.value)}
                onKeyDown={onTextKeyDown}
                placeholder="e.g. The Lancet, JAMA, 0028-4793"
                aria-label="Target journal (optional)"
                className="input"
              />
            </Field>

            <Field
              label={`Authors${authorsAutoDetected ? ' (auto-detected — edit if wrong)' : ' (optional)'}`}
              htmlFor="sim-authors"
            >
              <textarea
                id="sim-authors"
                value={authorsInput}
                onChange={e => { setAuthorsInput(e.target.value); setAuthorsAutoDetected(false) }}
                onKeyDown={onTextKeyDown}
                rows={2}
                placeholder="Jane Smith&#10;John Doe"
                aria-label="Authors (optional, one per line)"
                className="input resize-y"
              />
            </Field>

            <Field
              label={`Reference DOIs${referencesAutoDetected ? ' (auto-detected — edit if wrong)' : ' (optional)'}`}
              htmlFor="sim-references"
            >
              <textarea
                id="sim-references"
                value={referencesInput}
                onChange={e => { setReferencesInput(e.target.value); setReferencesAutoDetected(false) }}
                onKeyDown={onTextKeyDown}
                rows={2}
                placeholder="10.1056/NEJMoa1504720"
                aria-label="Reference DOIs (optional, one per line)"
                className="input resize-y"
              />
            </Field>

            <DetectedPanel
              meta={meta}
              overrides={overrides}
              setOverride={(k, v) => setOverrides(o => ({ ...o, [k]: v }))}
              targetValue={overrides.target || 'Auto-recommend'}
            />

            <div className="flex items-center justify-between pt-2 gap-3 sticky bottom-0 sm:static bg-ink-950/95 backdrop-blur p-3 -mx-5 sm:mx-0">
              <div
                className="text-xs text-slate-500 min-w-0"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {status === 'running' ? (
                  <div>
                    <div>
                      Elapsed <span className="font-mono text-slate-300">{elapsedSec}s</span>
                      <span className="text-slate-500"> / expected {inputMode === 'full' ? '30–90s' : '5–15s'}</span>
                      {progressLabel && <span className="ml-2 text-fate-300/90">· {progressLabel}…</span>}
                    </div>
                    <div
                      className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/5"
                      role="progressbar"
                      aria-label="Forecast progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.min(95, Math.round((elapsedSec / (inputMode === 'full' ? 60 : 10)) * 100))}
                    >
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-fate-500 to-fate-300 transition-all duration-500"
                        style={{ width: `${Math.min(95, (elapsedSec / (inputMode === 'full' ? 60 : 10)) * 100)}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  "Text is sent to PaperFate for LLM scoring. We don't persist it after the forecast completes."
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {inputMode === 'abstract' && (
                  <button
                    type="button"
                    onClick={onQuickCheck}
                    disabled={!canRun || quickStatus === 'running'}
                    aria-disabled={!canRun || quickStatus === 'running'}
                    aria-label="Run quick rubric check on title and abstract"
                    title="Lightweight rubric check on title + abstract only. Doesn't replace the full forecast."
                    className="text-xs text-slate-300 hover:text-slate-100 px-2.5 py-1.5 rounded-md border border-white/10 hover:border-white/20 bg-transparent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {quickStatus === 'running' ? <>Checking<Dots /></> : 'Quick rubric check'}
                  </button>
                )}
                <button
                  disabled={!canRun || status === 'running'}
                  aria-disabled={!canRun || status === 'running'}
                  aria-label="Run full PaperFate forecast"
                  className="btn-primary shrink-0"
                >
                  {status === 'running' ? <>Simulating<Dots /></> : 'Simulate fate'}
                </button>
              </div>
            </div>
            {inputMode === 'abstract' && (quickStatus !== 'idle') && (
              <QuickRubricPreview
                status={quickStatus}
                result={quickResult}
                error={quickError}
              />
            )}
          </div>
        </form>
      </div>

      <div id="result" className="mt-10 scroll-mt-24">
        {status === 'running' && <SkeletonResult />}
        {status === 'done' && result && (
          <div className="space-y-6">
            <ResultPanel result={resultLegacyShape(result, { authorsInput, referencesInput })} input={{ title, abstract: text }} />
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

// Combine the manuscript-only model output with strong contextual signals the
// model itself doesn't see (bibliography tier, target journal, top h-index).
// The base v0.2-prod is honest pre-pub but has R²(JIF log)≈0.435; sample-test
// showed it collapses to ~JIF 2.6 on top-tier abstracts. This blend lets the
// UI surface a more realistic single-number estimate while keeping the raw
// model number visible separately.
function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function computeAdjustedJif(r, manuscriptText = '') {
  const baseline = r?.predictions?.jcr_jif?.point
  if (!Number.isFinite(baseline)) return null
  const components = [{ jif: baseline, w: 1.0, label: 'model' }]

  // NB: the previous build had a regex-based "top-tier signature" multiplier
  // here. It was removed because it amounted to cosmetic keyword matching,
  // not real manuscript-level reasoning. Only signals derived from real
  // user input (references, target journal, authors) or external retrieval
  // (similar papers) contribute to the blend below.
  //
  // Discount semantics: each component is pushed as the RAW jif (no per-
  // component multiplier). The `w` weight is the sole discount mechanism in
  // the weighted average. Previously the components were both pre-scaled and
  // weighted, double-discounting external signals against the model baseline.

  // Similar-papers venue IF — strongest abstract-only signal. OpenAlex
  // retrieval often returns a mix of the original landmark paper and low-IF
  // reviews/preprints citing it; the median is dragged down by those reviews.
  // We anchor on the top-3 (highest-relevance / first-returned) and use a
  // top-tilted aggregate so an NEJM/Lancet/JAMA match dominates.
  const similars = (r?.similar_papers || [])
    .map(s => ({ if: +s.if, year: +s.year }))
    .filter(s => Number.isFinite(s.if) && s.if > 0)
  if (similars.length >= 2) {
    const topJifs = similars.slice(0, 3).map(s => s.if).sort((a, b) => b - a)
    const topMax = topJifs[0]
    // Real median over sorted topJifs (handles len 1/2/3+ correctly). The
    // previous build used (max+min)/2 which is the midpoint of the range,
    // not the median — it ignored the middle value when len === 3.
    const topMed = median(topJifs)
    // 60/40 mix of top-max and top-median — a single high-IF hit lifts the
    // signal but doesn't over-anchor if everything else is mid-tier.
    const simAnchor = 0.6 * topMax + 0.4 * topMed
    components.push({ jif: simAnchor, w: 0.6, label: 'similar papers' })
  }

  const refMedian = r?.references_summary?.median_jif
  if (Number.isFinite(refMedian) && refMedian > 0 && (r?.references_summary?.n_resolved || 0) >= 3) {
    components.push({ jif: refMedian, w: 0.45, label: 'bibliography' })
  }

  const tjJif = r?.target_journal_info?.jif
  if (Number.isFinite(tjJif) && tjJif > 0) {
    components.push({ jif: tjJif, w: 0.3, label: 'target' })
  }

  const maxH = r?.author_features?.max_team_h_index
  if (Number.isFinite(maxH) && maxH >= 20) {
    const boost = Math.min(8, Math.pow(maxH / 30, 0.7))
    if (boost > 1.05) components.push({ jif: baseline * boost, w: 0.3, label: 'authors' })
  }

  const totalW = components.reduce((s, c) => s + c.w, 0)
  const point = components.reduce((s, c) => s + c.jif * c.w, 0) / totalW
  return {
    point: +point.toFixed(2),
    baseline: +baseline.toFixed(2),
    components: components.map(c => ({ ...c, jif: +c.jif.toFixed(2) })),
    is_adjusted: components.length > 1,
  }
}

// Adapts the new server schema back to the shape ResultPanel was originally
// designed for, so the existing 6-card layout still renders.
function resultLegacyShape(r, ctx = {}) {
  if (r?.legacy) return r.legacy   // already the mock shape
  const p = r.predictions || {}
  const llmHealth = r.llm_health || null
  const extractionFallbackReason = r.extraction_fallback_reason || r.mock_fallback_reason || null
  const extractorUsed = r.extractor_used || (r.mode === 'mock' ? 'mock' : 'llm')
  const degradedMode =
    ['mock', 'rule_fallback', 'deterministic'].includes(extractorUsed) ||
    llmHealth?.status === 'degraded'
  const manuscriptJifPoint = Number.isFinite(+p.jcr_jif?.point) ? +p.jcr_jif.point : null

  const baseWeakness = r.key_weaknesses?.[0]?.name || 'See domain rollup below.'
  const baseSuggestions = (Array.isArray(r.counterfactual_suggestions) && r.counterfactual_suggestions.length > 0
    ? r.counterfactual_suggestions.map(s =>
        `${s.name} → +${s.predicted_jif_lift?.toFixed?.(1) ?? s.predicted_jif_lift} JIF`)
    : (r.key_weaknesses || []).slice(0, 5).map(w => w.name)
  )

  return {
    score: r.overall_score ?? null,
    tier: jifToTier(p.jcr_jif, r.journey),
    deskReject: deskRejectFormat(p.desk_reject_risk),
    timeline: timelineFromPrediction(p.review_timeline_days, p.jcr_jif),
    citation: citationsFormat(p.citations_5yr, r.overall_score),
    weakness: degradedMode ? 'Rubric scoring unavailable for this run' : baseWeakness,
    suggestions: degradedMode
      ? ['Re-run with a full manuscript for actionable suggestions']
      : baseSuggestions,
    jointCounterfactual: r.joint_counterfactual || null,
    manuscriptJifPoint,
    similars: (r.similar_papers || []).map(s => ({
      title: s.title || '—',
      venue: s.venue || '—',
      if: s.if != null && Number.isFinite(+s.if) ? (+s.if).toFixed(1) : '—',
      year: s.year || '—',
      citations: s.citations ?? 0,
    })),
    targetJournal: r.target_journal_info || null,
    referencesSummary: r.references_summary || null,
    authorFeatures: r.author_features || null,
    adjustedJif: computeAdjustedJif(r, r.__manuscript_text || ''),
    confidence: Number.isFinite(+r.confidence) ? +r.confidence : null,
    fatecoreMeta: r.fatecore
      ? {
          version: r.fatecore.version,
          timelineModel: r.fatecore.timeline_model,
          modelStatus: r.fatecore.model_status,
        }
      : null,
    journey: r.journey || [],
    llmHealth,
    extractionFallbackReason,
    extractorUsed,
    degradedMode,
    mode: r.mode || null,
    authorsCount: typeof ctx.authorsInput === 'string'
      ? ctx.authorsInput.split(/[,;\n]+/).filter(Boolean).length
      : 0,
    referencesCount: typeof ctx.referencesInput === 'string'
      ? ctx.referencesInput.split(/[,;\n]+/).filter(Boolean).length
      : 0,
  }
}

function jifToTier(j, journey) {
  if (!j || !Number.isFinite(j.point)) return { range: '—', bestFit: '—', stretch: '—' }
  const pt = j.point, lo = j.ci_low, hi = j.ci_high
  // Prefer concrete journal names from journey when available
  const bestFitJournal = journey?.find(s => s.step === 2)?.venue
  const stretchJournal = journey?.find(s => s.step === 1)?.venue
  const tierLabel = (v) =>
    v >= 30 ? 'Top tier'
    : v >= 10 ? 'High tier'
    : v >= 5 ? 'Upper-mid tier'
    : v >= 3 ? 'Mid tier'
    : v >= 1.5 ? 'Lower-mid tier'
    : 'Lower tier'
  return {
    range: `JIF ${pt.toFixed(1)} (90% CI ${lo.toFixed(1)}–${hi.toFixed(1)})`,
    bestFit: bestFitJournal ? `${bestFitJournal} (${tierLabel(pt)})` : tierLabel(pt),
    stretch: stretchJournal ? `${stretchJournal} (${tierLabel(hi)})` : (hi > pt * 1.3 ? tierLabel(hi) : '—'),
  }
}

function deskRejectFormat(d) {
  if (!d || !Number.isFinite(d.point)) return { pct: null, label: '—' }
  const pct = Math.round(d.point * 100)
  const label =
    d.point >= 0.6 ? 'High'
    : d.point >= 0.35 ? 'Moderate'
    : d.point >= 0.15 ? 'Low'
    : 'Very Low'
  return { pct, label }
}

function timelineFromTier(j) {
  if (!j || !Number.isFinite(j.point)) return { weeks: '—', note: 'Timeline estimate unavailable' }
  const pt = j.point
  // Heuristic: higher-tier journals → longer review
  const weeks =
    pt >= 30 ? '12–16'
    : pt >= 10 ? '8–14'
    : pt >= 3 ? '6–10'
    : '4–8'
  return { weeks, note: 'Heuristic estimate from journal tier (v0.1 — not learned)' }
}

function timelineFromPrediction(t, fallbackJif) {
  if (!t || !Number.isFinite(t.point)) return timelineFromTier(fallbackJif)
  const point = Math.max(1, Math.round(t.point / 7))
  const lo = Math.max(1, Math.round((Number.isFinite(t.ci_low) ? t.ci_low : t.point) / 7))
  const hi = Math.max(lo, Math.round((Number.isFinite(t.ci_high) ? t.ci_high : t.point) / 7))
  return {
    weeks: `${lo}-${hi}`,
    note: `Learned v0.4 estimate; point ${point} weeks from received to accepted`,
  }
}

function citationsFormat(c, score) {
  if (!c || !Number.isFinite(c.point)) return { range: '—', percentile: null, peerMedian: null }
  const pt = Math.max(0, Math.round(c.point))
  const lo = Math.max(0, Math.round(c.ci_low))
  const hi = Math.max(0, Math.round(c.ci_high))
  // Rough percentile from overall_score
  const pct = Number.isFinite(score) ? Math.max(1, Math.min(99, 100 - score)) : null
  return {
    range: `${lo}–${hi} citations (point: ${pt})`,
    percentile: pct,
    peerMedian: pt,
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
          aria-label={item.label}
          className="input"
        />
      ) : (
        <select
          value={value ?? (detected || item.options[0])}
          onChange={e => onChange(e.target.value)}
          aria-label={item.label}
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
    <div
      role="tablist"
      aria-label="Input mode"
      className="inline-flex rounded-lg border border-white/10 bg-ink-900 p-1 text-xs"
    >
      {options.map(o => {
        const selected = value === o.value
        return (
          <button
            key={o.value} type="button"
            role="tab"
            id={`sim-tab-${o.value}`}
            aria-selected={selected}
            aria-controls={`sim-tabpanel-${o.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-1.5 transition ${selected ? 'bg-fate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, hint, children, htmlFor }) {
  // When htmlFor is provided we render a non-wrapping <label htmlFor=…> so
  // assistive tech treats the explicit id linkage as authoritative. The
  // wrapping <label> form is kept for legacy call sites that don't pass an
  // id. Both shapes render identical visual markup.
  const inner = (
    <>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</span>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </>
  )
  if (htmlFor) {
    return (
      <div className="block">
        <label htmlFor={htmlFor} className="block">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</span>
            {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
          </div>
        </label>
        {children}
      </div>
    )
  }
  return <label className="block">{inner}</label>
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

function QuickRubricPreview({ status, result, error }) {
  if (status === 'running') {
    return (
      <div
        className="mt-2 rounded-md border border-white/5 bg-ink-900/60 p-3 text-[11px] text-slate-400 animate-pulse"
        style={{ maxHeight: 120 }}
        role="status"
        aria-live="polite"
      >
        Running quick rubric check…
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div
        className="mt-2 rounded-md border border-amber-400/20 bg-amber-400/[0.04] p-3 text-[11px] text-amber-200/80"
        style={{ maxHeight: 120 }}
        role="alert"
      >
        Quick rubric check unavailable{error ? ` — ${error.slice(0, 100)}` : ''}.
      </div>
    )
  }
  if (!result) return null
  const overall = Number.isFinite(+result.overall_score) ? +result.overall_score : null
  const rollup = Array.isArray(result.domain_rollup) ? result.domain_rollup.slice(0, 4) : []
  const wallMs = Number.isFinite(+result.wall_ms) ? +result.wall_ms : null
  const llmHealth = result.llm_health || null
  const extractorUsed = result.extractor_used || null
  const degraded = (llmHealth && llmHealth.status === 'degraded') || extractorUsed === 'rule_fallback'
  return (
    <div className="mt-2 rounded-md border border-white/5 bg-ink-900/60 p-3" style={{ maxHeight: 120, overflow: 'hidden' }}>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-slate-400">Quick rubric</span>
        {overall != null && (
          <span className="font-mono text-slate-200">{overall.toFixed?.(0) ?? overall}</span>
        )}
        {degraded && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
            title={`Degraded mode${extractorUsed ? ` (${extractorUsed})` : ''}`}
          />
        )}
        {wallMs != null && (
          <span className="ml-auto text-slate-500">{(wallMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      {rollup.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {rollup.map((d, i) => {
            const code = d.domain || d.code || ''
            const name = DOMAIN_NAMES[code] || code || '—'
            const color = DOMAIN_COLORS[code] || '#94a3b8'
            const score = Number.isFinite(+d.score) ? +d.score : (Number.isFinite(+d.mean) ? +d.mean : null)
            return (
              <span
                key={`${code}-${i}`}
                className="chip border text-[10px] px-1.5 py-0.5"
                style={{ borderColor: `${color}55`, color }}
                title={name}
              >
                {code}{score != null ? ` ${score.toFixed?.(0) ?? score}` : ''}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
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
