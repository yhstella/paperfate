# PaperFate

Pre-submission manuscript forecasting for biomedical papers.
Production at **https://paperfate.com**.

Each forecast pairs a Q500 rubric extraction with calibrated LightGBM
predictions and surfaces:

- **Journal tier** — JIF point + 90% conformal interval
- **Desk-reject risk** — at the recommended tier
- **Review timeline** — days from received to accepted (v0.4-timeline model)
- **Citation potential** — five-year citation range
- **Submission journey** — five ordered targets with category-jaccard +
  publisher + |Δlog IF| + OA-model switch-cost between each step
- **Counterfactual suggestions** — "if you raised item X to anchor 4,
  predicted JIF +Y" via re-inference with the weakest Q500 item lifted
- **Similar published papers** — OpenAlex retrieval, dedupe, ISSN→JIF join
- **Target-journal lookup** — prior-year IF, tier, quartile, OA flag, APC
  for a user-supplied journal name or ISSN
- **Bibliography summary** — descriptive median/mean IF, top venues, and
  JCR-category distribution of a user-supplied DOI list (≤50)

The training and calibration policy is documented in the in-app
**Methods** section.

## Architecture

| Layer | Stack | Source |
|---|---|---|
| Frontend | Vite + React + Tailwind | `src/components/*` |
| API | Vercel Serverless (Node) | `api/*.js` |
| Models | LightGBM (.txt) + isotonic + split-conformal | `weights/*` |
| Local DB | SQLite (WAL, busy_timeout=60s) | `E:\paperfate\data\paperfate.db` |
| ETL | Node + Python | `scripts/*` |

### API surface (production)

| Route | Method | Purpose |
|---|---|---|
| `/api/forecast` | POST | Q500 extraction → FateCore JIF/RCR/citations + v0.4-timeline + counterfactual suggestions + journey |
| `/api/similar` | POST | OpenAlex similar-paper retrieval, ISSN→JIF |
| `/api/journal-info` | GET | Single-journal prior-year IF lookup (`?issn=` or `?name=`) |
| `/api/journals-search` | GET | Journal autocomplete (`?q=` over 2,840 shortlist) |
| `/api/references` | POST | Bibliography summary for a DOI list (≤50) |

### Models

| Tag | Target | MAE / R² | Status |
|---|---|---|---|
| `fatecore-v0.2-prod` | JIF / RCR / citations log | R²(JIF log) 0.435 | Live |
| `fatecore-v0.4-timeline` | review days | MAE 59.4 d, R²(log) 0.13, 90.2% conformal cov | Live |
| `fatecore-v0.3-prepub` | JIF / RCR / citations log | R²(JIF log) 0.461 (below 0.48 deploy gate) | Held |
| `fatecore-v0.3-pub` | JIF + j_hist_* (target-aware) | R²(JIF log) 0.935 dominated by ISSN autocorr — see `docs/V0.3_PUB_LEAK_DIAGNOSIS.md` | Permanently held |

Target-aware UI uses a direct `/api/journal-info` lookup instead of a
deployed target-aware model.

## Pre-submission feature policy

The training pipeline forbids any post-publication feature
(`icite_citation_count`, `citations_openalex`, `citations_s2`,
`citations_crossref`, `fwci`, `fwci_topic_norm`, `icite_rcr`,
`icite_nih_percentile`, `icite_apt`, `icite_cited_by_clin`,
`pmc_*_count`, `epmc_*_count`, `pdf_body_*`, `pmcid`,
`has_pdf_source_url`, `pmc_has_data_avail`, `pmc_has_ethics`,
`pmc_has_coi`, `unpaywall_is_oa`, `unpaywall_oa_status`,
`unpaywall_journal_oa`, `unpaywall_journal_doaj`,
`preprint_pub_gap_days`). Splits are random 80/20 only — temporal
holdout is a poor proxy because JIF and citation distributions shift
year over year, making the calibration set non-comparable to test.

## Local development

```bash
npm install
npm run dev      # Vite preview on http://localhost:5180
npm run build    # production bundle into dist/
```

API endpoints run on Vercel; `npm run dev` does not host them — the
Simulator falls back to `src/lib/mockEngine.js` for offline preview.

## Smoke checks

```bash
# Production smoke against paperfate.com
node scripts/smoke-production.mjs

# Sanity check four reference manuscripts and report journey + costs
node scripts/sanity-samples.mjs
```

Both exit non-zero on shape/bound failures.

## Repository layout

```
api/                  Vercel serverless functions
src/components/       React UI
src/server/           FateCore + suggestion engine + extract pipeline
src/lib/              Frontend clients
scripts/              ETL, training, evaluation, smoke
weights/              LightGBM models + journals-shortlist (deployed)
docs/                 Codex handoffs, evals, design briefs
public/               Static assets (favicon, og.svg, robots, sitemap)
```

Data and model-version policy details: see `docs/MODEL.md`,
`docs/EVAL_v0.4-timeline.md`, `docs/V0.3_PUB_LEAK_DIAGNOSIS.md`,
and the `docs/CODEX_HANDOFF_*.md` series.
