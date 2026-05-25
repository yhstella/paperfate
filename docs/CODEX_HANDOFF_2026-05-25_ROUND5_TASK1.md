# CODEX HANDOFF 2026-05-25 Round 5 Task 1

## Scope

Implemented PubMed history date ingest and trained/deployed a learned review-timeline model.

## Schema / Ingest

- Added nullable `papers` columns:
  - `history_received_date`
  - `history_accepted_date`
  - `history_epublish_date`
  - `history_pubmed_date`
  - `history_revised_date`
  - `review_days_received_to_accepted`
- Added idempotent migration: `scripts/migrate-add-history-dates.mjs`
- Updated PubMed ingest in `scripts/build-unified-db.mjs` to map `rec.history` and compute `accepted - received` days.
- Ran:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts\migrate-add-history-dates.mjs
node scripts\build-unified-db.mjs --only=pubmed
```

## DB Result

- `papers`: `3,897,021`
- `review_days_received_to_accepted IS NOT NULL`: `2,047,937`
- DB summary after ingest: `84,652 MB`
- PubMed-only ingest elapsed: `3,117.2s`

## Timeline Feature / Training

Deliverables:

- `scripts/build-fatecore-timeline-features.mjs`
- `scripts/train-fatecore-timeline.py`
- `scripts/eval-fatecore-timeline.py`
- `weights/fatecore-v0.4-timeline-review_days.txt`
- `weights/fatecore-v0.4-timeline-metrics.json`
- `docs/EVAL_v0.4-timeline.md`

Feature build:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts\build-fatecore-timeline-features.mjs --source-features=E:\paperfate\data\features\v0.3-pub-features.csv
```

Notes:

- Direct DB scan over `papers` was too slow on the 84GB table.
- Final builder uses `v0.3-pub-features.csv` as the source for already-computed Q stats + prepub/j_hist features, then joins DOI -> `review_days_received_to_accepted` from SQLite.
- This preserves the feature policy and avoids re-grouping 147M `paper_scores` rows.

Feature manifest:

- Source rows seen: `857,284`
- Rows written: `228,606`
- Rows under `min_year=2010`: `254,879`
- Rows without review target: `373,799`
- Features: `35`
- Forbidden post-publication features: `0`

Training:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
python scripts\train-fatecore-timeline.py
python scripts\eval-fatecore-timeline.py
```

Metrics:

- Random split only.
- Train/model: `146,307`
- Calibration: `36,577`
- Test: `45,722`
- Calibrated MAE: `59.4 days`
- Median absolute error: `39.6 days`
- `R2_log`: `0.1287`
- Conformal coverage: `0.902`
- Median interval width: `280.9 days`
- Decision: **DEPLOY CANDIDATE**

## Deploy

Implemented as a separate timeline model path, not mixed into the main `v0.2-prod` JIF/RCR/citations targets because the feature schema differs.

Changed:

- `src/server/fatecoreInference.js`
  - Adds `loadTimelineModel()`
  - Loads `fatecore-v0.4-timeline-review_days.txt`
  - Adds `predictions.review_timeline_days`
  - Adds `fatecore.timeline_model`
- `src/components/Simulator.jsx`
  - Uses `review_timeline_days` when available
  - Falls back to `timelineFromTier()` otherwise

Verification:

```powershell
node --check src\server\fatecoreInference.js
node scripts\test-fatecore-inference.mjs
npm run build
```

Smoke result:

- `predictions.review_timeline_days.point`: `50.5`
- `ci_low`: `15.2`
- `ci_high`: `163.3`
- `fatecore.timeline_model`: `fatecore-v0.4-timeline`
- Vite production build passed.

## Recommendation

Keep `v0.2-prod` as the main JIF/RCR/citation model. Use `v0.4-timeline` only for review timeline. Its R2 is intentionally modest and not leakage-suspicious; MAE is within the Round 5 deploy rule.
