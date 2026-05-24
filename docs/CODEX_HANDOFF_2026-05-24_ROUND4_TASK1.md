# CODEX Handoff 2026-05-24 Round 4 Task 1 - v0.3-pub Training

## Status

Completed. Do not deploy.

## Files

- `scripts/build-fatecore-features-v0.3-pub.mjs`
- `scripts/train-fatecore-v0.3-pub.py`
- `scripts/eval-fatecore-v0.3-pub.py`
- `scripts/test-fatecore-v0.3-pub-empa-reg.mjs`
- `docs/EVAL_v0.3-pub.md`
- `weights/fatecore-v0.3-pub-y_jcr_jif.txt`
- `weights/fatecore-v0.3-pub-y_icite_rcr.txt`
- `weights/fatecore-v0.3-pub-y_citations_log.txt`
- `weights/fatecore-v0.3-pub-metrics.json`

## Feature Matrix

Generated:

```text
E:\paperfate\data\features\v0.3-pub-features.csv
E:\paperfate\data\features\v0.3-pub-features-manifest.json
```

Matrix:

- rows: `857,284`
- features: `40`
- prepub features: `34`
- target-journal optional `j_hist_*`: `6`
- rows with any `j_hist_*`: `393,924`
- forbidden post-publication features: `0`

The added target-journal optional features are:

- `j_hist_metric_age`
- `j_hist_jcr_jif`
- `j_hist_jcr_jif_5yr`
- `j_hist_jci`
- `j_hist_article_influence`
- `j_hist_eigenfactor`

## Training

Command:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
python scripts\train-fatecore-v0.3-pub.py --num-threads 8
```

Training policy:

- random 80/20 split only
- LightGBM native NaN handling
- `j_hist_*` masked to NaN on random 30% train/cal rows
- one single model for target-present and target-absent inference

## JIF Metrics

| Scenario | R2 log | R2 raw cal | MAE raw cal |
|---|---:|---:|---:|
| with_target | 0.9349 | 0.8303 | 0.3494 |
| cold_start | 0.4383 | 0.3437 | 1.5226 |

Deploy rule:

- with-target JIF R2 must be `0.55-0.85` range and not suspicious
- cold-start JIF R2 must be `>=0.45`

Result:

- with-target R2 `0.9349` exceeds suspicious `0.85` guardrail
- cold-start R2 `0.4383` misses `0.45`
- deploy blocked

## EMPA-REG Smoke

Command:

```powershell
node scripts\test-fatecore-v0.3-pub-empa-reg.mjs --version-tag v0.3-pub
```

| Scenario | JIF point | Required | Result |
|---|---:|---|---|
| cold_start/no target | 0.488 | about 2-3 | fail |
| target=NEJM | 42.700 | 30-100 | pass |
| target=Saudi Heart | 1.580 | 1-2 | pass |

Conclusion: target-aware behavior is plausible, but the no-target path is worse than acceptable. Keep production on v0.2-prod.
