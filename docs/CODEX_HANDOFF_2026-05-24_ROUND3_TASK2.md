# CODEX Handoff 2026-05-24 Round 3 Task 2 - v0.3-prepub Deploy Decision

## Status

Not deployed.

## Reason

Round3 deploy rule:

```text
R2_log(y_jcr_jif) >= 0.48
AND pre-submission features only
AND EMPA-REG cold-start smoke passes
```

Observed:

- `R2_log(y_jcr_jif)=0.4610`
- forbidden feature count: `0`
- suspicious high-R2 flag: `false`
- EMPA-REG cold-start local smoke: stable

The model passes leakage/cold-start checks but fails the offline R2 threshold. Production should remain on rollback commit `12bdfea` / `fatecore-v0.2-prod`.

Production verification after this task:

```text
server_version=0.3.0
fatecore_version=fatecore-v0.2-prod
model_status=loaded
feature_count=523
EMPA-style JIF=1.411
```

## Code Note

`src/server/fatecoreInference.js` now accepts an optional non-production loader override:

```js
loadFateCore({ versionTag: 'v0.3-prepub' })
```

Default remains:

```text
fatecore-v0.2-prod
```

This was added only to allow local cold-start comparison without changing production defaults.
