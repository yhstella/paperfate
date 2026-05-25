# CODEX HANDOFF 2026-05-25 Round 5 Task 2

## Scope

Diagnosed whether `v0.3-pub` JIF performance (`R2_log ~= 0.935`) is genuine manuscript signal or target-journal autocorrelation.

## Deliverables

- `scripts/diag-v0.3-pub-leak.py`
- `docs/V0.3_PUB_LEAK_DIAGNOSIS.md`
- `docs/V0.3_PUB_ISSN_STRATIFIED.md`

## Run

```powershell
$env:DATA_ROOT='E:\paperfate\data'
python scripts\diag-v0.3-pub-leak.py
```

## Result

- Original with-target `R2_log`: `0.9349`
- Original calibrated raw MAE: `0.3494` JIF
- Joint shuffle of `j_hist_*`: `R2_log = -0.7516`, MAE `2.7294`
- Cold-start all `j_hist_* = NaN`: `R2_log = 0.3531`, MAE `1.5872`
- Shuffle only `j_hist_jcr_jif`: `R2_log = -0.2327`, MAE `2.1166`
- Top-200 ISSN median MAE: `0.199` JIF

## Decision

`v0.3-pub` should remain **HOLD** as a learned manuscript-quality model. The high score is mostly target-journal prior-year JIF lookup/autocorrelation. Product path should use direct target-journal historical lookup for target-aware explanations, not deploy this model as FateCore.

## Notes For Claude

This does not invalidate `v0.2-prod` or honest prepub modeling. It only says the target-aware `v0.3-pub` path is dominated by `j_hist_jcr_jif`. If a target-journal path is needed in UI, expose it as a fact-based prior such as "prior-year target journal JIF" and combine with manuscript-level model outputs separately.
