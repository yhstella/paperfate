# CODEX Handoff 2026-05-24 Round 2 Task 1 - v0.3 Training/Eval

## Status

Done.

## Inputs

- Feature CSV: `E:\paperfate\data\features\v0.3-features.csv`
- Manifest: `E:\paperfate\data\features\v0.3-features-manifest.json`
- Rows/columns: `857,284 x 71`
- Feature columns used: `66`
- Split: random 80/20 only. No year split and no year cutoff.

## Files Added

- `scripts/train-fatecore-v0.3.py`
- `scripts/eval-fatecore-v0.3.py`
- `docs/EVAL_v0.3.md`
- `weights/fatecore-v0.3-y_jcr_jif.txt`
- `weights/fatecore-v0.3-y_icite_rcr.txt`
- `weights/fatecore-v0.3-y_citations_log.txt`
- `weights/fatecore-v0.3-metrics.json`

## Training Details

Command:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
python scripts\train-fatecore-v0.3.py --num-threads 8
```

Training design:

- LightGBM one model per target.
- Targets: `y_jcr_jif`, `y_icite_rcr`, `y_citations_log`.
- `y_jcr_jif` and `y_icite_rcr` trained on `log1p`.
- `y_citations_log` already log-scaled, so no extra transform.
- Class weighting: inverse-frequency bins on transformed target.
- Calibration: random calibration subset inside training split.
- Intervals: split conformal, alpha `0.1`.

## Metrics

| Target | Train | Cal | Test | MAE raw cal | R2 log | R2 raw cal | Coverage |
|---|---:|---:|---:|---:|---:|---:|---:|
| JCR JIF | 52,968 | 13,243 | 16,490 | 0.242 | 0.9525 | 0.8684 | 0.895 |
| iCite RCR | 407,170 | 101,793 | 127,253 | 0.061 | 0.9987 | 0.9017 | 0.898 |
| log citations | 546,686 | 136,672 | 170,871 | 0.067 | 0.9872 | 0.9871 | 0.901 |

Deploy rule was `R2_log(y_jcr_jif) >= 0.50`; observed `0.9525`, so deploy is recommended by the Round 2 criterion.

## Important Caveat

v0.3 includes enriched post-publication/corpus features (`citations_openalex`, `fwci`, iCite values, fulltext counters). Offline metrics are therefore an enriched-corpus benchmark. The production server fills unknown post-publication features as missing values for cold-start manuscripts.

For a pure pre-submission-only benchmark, retrain a separate model excluding post-publication features.
