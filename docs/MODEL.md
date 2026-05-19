# FateCore — learning model design

> Status: design doc, not yet implemented. Goal of this doc is to make every modeling decision concrete enough that we can ship FateCore-v0.1 as the real engine and retire the mock.

## 1. What we predict

Given a manuscript (`title`, `abstract`, optionally `full_text`), produce **five probabilistic forecasts**:

| Output | Form | Calibration target |
|---|---|---|
| Journal tier | discrete bucket over 5 IF bins + best-fit shortlist of ≤10 journals | top-1 accuracy on held-out 2023+ papers (target: ~45%; top-3: ~75%) |
| Desk-reject probability at target tier | scalar 0–1 | Brier score ≤ 0.18 |
| Citations at 3y / 5y | log-normal **range** (5th–95th percentile) | empirical coverage of true 5y count ≥ 90% |
| Actual Impact Score | scalar 0–100, composite | rank correlation (Spearman ρ) with field-normalized citations ≥ 0.55 |
| Reviewer risk axes | 4–6 named axes with severity 0–1 | manual eval, no metric |

Every output is **a range or distribution, never a point estimate**. The UI never displays a single number without a confidence indicator.

## 2. Data sources & coverage

| Layer | Source | Per-paper fields | Latency to refresh |
|---|---|---|---|
| L1 — text | **PubMed E-utilities** | title, abstract, MeSH, authors, affiliations, pub types, year, journal | Daily |
| L2 — citations | **OpenAlex** (by DOI) | citation count, FWCI, OA status, concepts, venue ID, host institution | Weekly |
| L3 — graph | **Semantic Scholar** (by DOI) | influential citations, SPECTER2 embeddings, cited-by graph (1-hop) | Weekly |
| L4 — venue | OpenAlex venues table + JCR IF lookup (manual, annual) | name, ISO abbrev, SJR, IF, scope, OA model, desk-reject rate (manually curated for top ~150 journals) | Annual |
| L5 — early attention (optional) | Altmetric / X mentions | tweets, news, blogs, policy docs | Daily |

All five layers are joined on **DOI primary, PMID secondary**. Records missing a DOI fall through to PMID-only and can still be used for L1+L3 (S2 supports PMIDs).

Initial corpus target: **~60,000 biomedical papers** from 30 PubMed seed queries (see `scripts/seeds.json`), 2018–2025, biased toward clinical research with abstracts.

## 3. Pipeline stages

### Stage A — Retrieval (cheap, fast)

```
input text  ──►  embed(input)  ──►  ANN search over corpus_embeddings  ──►  top-K (K=200)
```

- **Embedding model**: SPECTER2 (768-d, scientific-paper-tuned, free, runs on CPU in ~50ms) for the corpus. For the user's manuscript at query time, same model. Allenai/specter2_base via ONNX is the deployment target.
- **Index**: pgvector on Postgres (Supabase free tier handles 500K+ vectors comfortably). HNSW ef_construction=128.
- **Optional rerank**: BM25 over title+abstract on the top-200, then keep top-50 hybrid (vector × BM25). Skip for v0.1.

### Stage B — Statistical aggregation

From the top-50 neighbors, compute distributional baselines:

- `journal_tier` ← empirical distribution of venues (weighted by similarity), bucketed into 5 IF bins. Best-fit list = top-10 venues by weighted count, capped to those with ≥3 similar papers.
- `citation_5y` ← log-normal fit to the 5y citation counts of neighbors with ≥5 years of follow-up, **field-normalized** by dividing each count by the median 5y count of that venue's OpenAlex concept × year cell.
- `desk_reject_pct` ← look up the historical desk-reject rate for the best-fit venue (manual table for top venues; default 65% for unknown).
- `reviewer_risk_axes` ← presence/absence of: external validation, ≥1000 sample size, multicenter, RCT/meta-analysis pub type, decision-curve mention, pre-registration mention. Each maps to a known axis.

This alone produces **a usable v0.1** that beats the mock.

### Stage C — Learned head (optional, v0.2)

A small LightGBM regressor on top of Stage B that takes:
- 12 neighbor-aggregate features (median IF, IQR IF, median citations, citation skew, neighbor recency, …)
- 8 manuscript features (length, structured-abstract flag, has-validation, has-decision-curve, sample-size bucket, RCT flag, multicenter flag, AI-keyword count)
- 4 author/affiliation features (first-author h-index from OpenAlex, last-author h-index, institution rank, prior pub count in this venue)

Trained on **held-out 2023 papers** to predict 5y-citation log; trees explain the residual the heuristic misses. **Do not train on 2024+ — those papers don't have their 5y window yet.**

### Stage D — LLM grading (Claude)

A single call to Claude per simulation that scores three axes from the abstract:

```
novelty:          0–25  + 1-sentence rationale
methods_strength: 0–25  + 1-sentence rationale
clinical_utility: 0–25  + 1-sentence rationale
+
weakness:         free text, 1–2 sentences, must reference a specific axis
suggestions:      array of 3–5 concrete edits
```

Prompted with the top-5 similar abstracts as in-context examples. **The LLM does not see citation/IF data** — it only judges textual content. This isolates "text-quality" from "field momentum".

Cost: ~$0.01 per simulation with Claude Haiku 4.5. Cacheable per-text-hash.

### Stage E — Composition

```
score_100 = 0.35 · LLM_text_score + 0.45 · neighbor_strength + 0.20 · author_signal
tier      = posterior over 5 IF buckets, blending neighbor distribution and learned-head correction
citation  = log-normal(μ from learned head, σ from neighbor IQR)  →  reported as 10th–90th percentile range
```

Coefficients fixed for v0.1; learned via grid search on held-out set in v0.2.

## 4. Calibration

Two layers:

1. **Isotonic regression** on desk-reject probability — fit on held-out 2023 venue submissions where we know the outcome (hard data, see §8).
2. **Conformal prediction** wrapper on citation ranges — guarantees 90% coverage of true 5y citation count on the held-out set, regardless of how miscalibrated the underlying log-normal fit is.

Both wrappers are cheap to fit (≤1 min) and re-fit monthly.

## 5. Evaluation

Held-out set: **all biomedical papers in our corpus published in 2023** (sample of ~5,000). For each, we have:
- ground-truth venue → tier accuracy
- ground-truth citations through 2025 → 3y citation MAE / range coverage
- ground-truth desk-reject (where venue submission data is available, ~150 top venues)

Metrics published in a public `docs/EVAL.md` alongside each model version. We commit to **never claiming accuracy we cannot show on this set**.

A second held-out: **2024 papers** for "early citation" calibration (only 3y window will be available by early 2027).

## 6. What we will NOT do

- Predict a single IF number ("your paper will get IF 12.3"). Always ranges.
- Train on the corpus we evaluate on (no temporal leakage).
- Use author-name features in the LLM prompt (avoid reputation-laundering in the text-quality score).
- Promise that a high score guarantees acceptance. The UI explicitly disclaims this.

## 7. Infrastructure & responsibility split

**Locked decision (2026-05-19):** training is local, inference is server, UI is dumb.

```
┌───────────────────────────────────┐    ┌───────────────────────────────────┐
│  LOCAL (developer machine)        │    │  SERVER (Vercel + Supabase)        │
│  ──────────────────────────       │    │  ─────────────────────────         │
│  • Score corpus with Q500 rubric  │    │  • POST /api/forecast              │
│    (Claude API, batched)          │    │     1. Q500 LLM extraction          │
│  • Train FateCore on labeled      │◀──▶│        on user manuscript           │
│    QualityVectors                 │    │     2. SPECTER2 embed + ANN search  │
│  • Run held-out evaluation        │    │     3. FateCore inference           │
│  • Commit artifacts to repo:      │    │     4. Compose result JSON          │
│      docs/rubric/Q500.json        │    │  • Serve similar-papers from       │
│      models/fatecore-v0.X.onnx    │    │    Supabase pgvector index          │
│      models/calibration-v0.X.json │    │  • Stateless: no per-user storage   │
└───────────────────────────────────┘    └───────────────────────────────────┘
                ▲                                          ▲
                │      shared via Git (deterministic)      │
                ▼                                          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  FRONTEND (paperfate.com)                                                   │
│  • File / text upload                                                       │
│  • Progress streaming (Q500 items being extracted)                          │
│  • Result visualization (forecast cards, domain rollup, similar papers)     │
│  • Zero ML / LLM logic — pure presentation                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

**What's where:**
- **Local-only**: corpus scoring (one-time, ~$50 LLM bill), FateCore training, evaluation, calibration fitting.
- **Server-only**: real-time inference, pgvector search, Anthropic API key, similar-paper lookup.
- **Shared artifacts (in git)**: Q500 rubric, FateCore weights (small ONNX), calibration tables, prompt templates.
- **Frontend**: presentation. Does not call Anthropic, does not embed models. Talks only to `/api/forecast`.

**Implications:**
- Anthropic API key lives only in Vercel env vars. Never shipped to browser.
- FateCore versioning happens locally; deploying = `git push` of weight files (small, <10 MB).
- Sensitive manuscripts never leave the request — server processes and returns, nothing persisted.
- **Cost**: local one-time corpus scoring ~$30–60 (Haiku); per-user inference ~$0.005–0.015.
- **Latency**: ~800–1500ms p50 (Q500 extraction is the bottleneck; will need parallelization across items or sub-set scoring per request).

## 8. Hard data we still need (manual work)

These don't come from APIs. Either curate by hand or skip in v0.1.

| Asset | Why | How |
|---|---|---|
| JCR Impact Factor lookup | OpenAlex doesn't carry IF | Manually maintained CSV for top ~300 biomedical journals. Update annually when JCR releases. |
| Desk-reject rate per venue | OpenAlex doesn't have submission data | Survey papers, publisher reports, anecdotal — start with 5 buckets (top, very high, high, moderate, low) based on prestige. |
| Review timeline per venue | Same — submission data not public | Self-reported via paperfate.com community over time. Start with tier-level defaults. |

## 9. Roadmap

| Version | What changes | When |
|---|---|---|
| **v0.0** (now) | Pure-frontend mock engine, keyword heuristics | shipped |
| **v0.1 — PubMed Lite** | Real corpus (60K papers), Stage A+B+D running on Vercel. No learned head. | ~2 weeks after corpus is complete |
| **v0.2 — LearnedHead** | Stage C learned head (LightGBM), public eval page | +2 weeks |
| **v0.3 — Calibrated** | Isotonic + conformal wrappers, monthly refit | +1 week |
| **v0.4 — Full text** | Accept full manuscript, extract methods section, longer context to LLM | +2 weeks |
| **v0.5 — Author signal** | Optionally accept author ORCIDs, pull h-index from OpenAlex, gated UI explaining the trade-off | +1 week |

Total time to a respectable v0.3 = **~5–6 weeks** of focused work after the corpus is collected.

## 10. Open questions (track in issues)

1. Do we accept full PDF upload or only pasted text? PDF parsing adds infra; text-only is cleaner. → v0.1: text-only.
2. How do we handle non-biomedical fields? → v0.1 ships PubMed-only and says so on the landing page.
3. Reviewer-risk axes — should we let the LLM name new axes, or constrain to a fixed taxonomy? → fixed taxonomy of 8 axes for v0.1 to keep the output stable.
4. Privacy mode: should we offer a "do not log even hashed text" mode for sensitive in-flight work? → yes, default on. The cost is no caching for that request.
5. What's the line between "PaperFate" the forecast tool and a future "PaperFate Studio" (editing + revision rebuttal generator)? → Studio is post-v0.5.
