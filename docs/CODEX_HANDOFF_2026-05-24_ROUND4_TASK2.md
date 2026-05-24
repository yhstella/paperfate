# CODEX Handoff 2026-05-24 Round 4 Task 2 - Deploy Decision

## Status

Not deployed.

## Why

Round4 v0.3-pub failed two deploy guards:

- with-target JIF R2 was `0.9349`, above the suspicious `0.85` threshold
- cold-start JIF R2 was `0.4383`, below the required `0.45`
- EMPA-REG no-target cold-start predicted JIF `0.488`, far below the v0.2-prod range

Target-present smoke cases were plausible:

- NEJM: JIF `42.700`
- Saudi Heart: JIF `1.580`

But the single NaN-safe model is still not safe enough for production.

## Production State

No production version change was made. Default runtime remains:

```text
fatecore-v0.2-prod
```

The v0.3-pub model can be loaded locally only with:

```js
loadFateCore({ versionTag: 'v0.3-pub' })
```

## Suggested Next Move

The failure mode suggests that the single-model 30% masking approach still overfits target-journal identity when present and is undertrained for no-target inference. Reasonable next experiments:

- increase `j_hist_*` mask fraction to 50%
- train two calibrated heads over the same booster, one with-target and one cold-start
- revisit two-model routing: target-aware model plus v0.3-prepub/v0.2-prod fallback
