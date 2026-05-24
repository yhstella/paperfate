# CODEX Handoff 2026-05-24 Round 2 Task 2 - v0.3 Deploy

## Status

Completed and pushed.

- commit: `d2fba77 feat(fatecore): train and deploy v0.3`
- pushed: `origin/main`
- production verification: passed on `2026-05-24T11:33:59+09:00`

## Deploy Condition

Round 2 rule:

```text
deploy if R2_log(y_jcr_jif) >= 0.50 and better than v0.2-prod baseline
```

Observed:

- v0.3 `R2_log(y_jcr_jif)`: `0.9525`
- v0.2-prod baseline from task doc: `0.435`
- decision: deploy recommended

## Files Changed

- `src/server/fatecoreInference.js`
- `api/forecast.js`
- `scripts/test-fatecore-v0.3-empa-reg.mjs`

## Runtime Changes

`src/server/fatecoreInference.js` now loads:

- `weights/fatecore-v0.3-y_jcr_jif.txt`
- `weights/fatecore-v0.3-y_icite_rcr.txt`
- `weights/fatecore-v0.3-y_citations_log.txt`
- `weights/fatecore-v0.3-metrics.json`

Runtime version:

```text
fatecore-v0.3
```

API server version changed:

```text
0.3.0
```

The server now reads `metrics.feature_cols` in addition to the older `metrics.features_used` key.

## Smoke Tests

Build:

```powershell
npm run build
```

Result: passed.

General local inference smoke:

```powershell
node scripts\test-fatecore-inference.mjs
```

Result:

- `model_status`: `loaded`
- loaded targets: `jcr_jif`, `icite_rcr`, `citations_5yr`
- `feature_count`: `66`
- version: `fatecore-v0.3`

EMPA-REG style smoke:

```powershell
node scripts\test-fatecore-v0.3-empa-reg.mjs
```

Result:

- `model_status`: `loaded`
- loaded targets: all 3
- predicted JIF point: `57.69`
- confidence: `0.879`

Production endpoint:

```powershell
Invoke-RestMethod -Method Post -Uri https://paperfate.com/api/forecast -ContentType application/json -Body ...
```

Result:

- `server_version`: `0.3.0`
- `fatecore_version`: `fatecore-v0.3`
- `model_status`: `loaded`
- `feature_count`: `66`
- EMPA-style predicted JIF point: `59.731`

## Caveat

Cold-start manuscripts do not have future citations/FWCI/iCite features. Production inference fills these as `NaN`. The v0.3 deploy is justified under the requested R2 rule, but a future `v0.3-pre` or `v0.4` should train on production-available features only.
