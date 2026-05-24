# CODEX Handoff 2026-05-24 Round 3 Task 1 - v0.3-prepub Training

## Status

Completed. Do not deploy this model under the Round3 rule.

## Files

- `scripts/build-fatecore-features-v0.3-prepub.mjs`
- `scripts/train-fatecore-v0.3-prepub.py`
- `scripts/eval-fatecore-v0.3-prepub.py`
- `scripts/test-fatecore-v0.3-prepub-empa-reg-cold.mjs`
- `docs/EVAL_v0.3-prepub.md`
- `weights/fatecore-v0.3-prepub-y_jcr_jif.txt`
- `weights/fatecore-v0.3-prepub-y_icite_rcr.txt`
- `weights/fatecore-v0.3-prepub-y_citations_log.txt`
- `weights/fatecore-v0.3-prepub-metrics.json`

## Feature Matrix

Input source:

```text
E:\paperfate\data\features\v0.3-features.csv
```

Generated:

```text
E:\paperfate\data\features\v0.3-prepub-features.csv
E:\paperfate\data\features\v0.3-prepub-features-manifest.json
```

Matrix:

- rows: `857,284`
- features: `34`
- total columns: `39`
- forbidden post-publication features: `0`

Excluded groups:

- citations/FWCI/iCite
- OpenAlex/Crossref/S2 reference counts
- PMC/EPMC/PDF fulltext and PMCID
- Unpaywall indexed article signals
- accepted-journal `j_hist_*`
- post-publication preprint-to-publication gap

Accepted-journal `j_hist_*` was excluded for this deploy candidate because the Round3 EMPA-REG cold-start case supplies no target journal. It can be used later in a separate target-journal-aware model path.

## Training

Command:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
python scripts\train-fatecore-v0.3-prepub.py --num-threads 8
```

Split:

```text
random_80_20_only_no_year_split
```

## Metrics

| Target | R2 log | R2 raw cal | MAE raw cal | Test n |
|---|---:|---:|---:|---:|
| JCR JIF | 0.4610 | 0.3557 | 1.4937 | 16,490 |
| iCite RCR | 0.3224 | 0.2063 | 1.2784 | 127,253 |
| log citations | 0.7125 | 0.7125 | 0.6921 | 170,871 |

JIF delta vs v0.2-prod:

```text
0.4610 - 0.4351 = +0.0260
```

Round3 deploy threshold:

```text
R2_log(y_jcr_jif) >= 0.48
```

Decision:

```text
HOLD v0.2-prod
```

## EMPA-REG Cold-Start Smoke

Commands:

```powershell
node scripts\test-fatecore-v0.3-prepub-empa-reg-cold.mjs --version-tag v0.2-prod
node scripts\test-fatecore-v0.3-prepub-empa-reg-cold.mjs --version-tag v0.3-prepub
```

No target journal and no post-publication fields were supplied.

| Model | Feature count | JIF point | CI |
|---|---:|---:|---|
| v0.2-prod | 523 | 2.153 | 0.775-4.602 |
| v0.3-prepub | 34 | 2.223 | 0.813-4.729 |

Interpretation: cold-start behavior is stable, but offline JIF R2 misses the threshold. Keep production on v0.2-prod.
