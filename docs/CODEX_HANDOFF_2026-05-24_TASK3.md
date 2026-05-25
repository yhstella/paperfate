# CODEX Handoff 2026-05-24 Task 3 - FateCore v0.3 Feature Build

## Status

Done.

## Files Changed

- `scripts/build-fatecore-features-v0.3.mjs`

## Outputs

Default full build output:

- CSV: `E:\paperfate\data\features\v0.3-features.csv`
- manifest: `E:\paperfate\data\features\v0.3-features-manifest.json`
- log: `E:\paperfate\data\_features_v0.3_2026-05-24.log`

Full build completed; no active v0.3 builder process remains.

## Design

The v0.3 matrix is compact by default:

- per-item Q500 columns are not expanded;
- Q scores are represented as aggregate `q_*` columns;
- smoke output produced `1,000 rows x 71 columns`.

Feature groups included:

- manuscript shape: year, title/abstract length, structured abstract, publication type flags, MeSH counts
- NIH: `has_nih_grant`, `n_nih_grants`
- OpenAlex: `citations_openalex`, `fwci`
- domain-normalized: `fwci_topic_norm`
- author/team: first/last/max/median h-index, team size, international collaboration
- iCite: citation count, NIH percentile, APT, clinical flag, cited-by-clin
- Crossref: reference count, funder count
- Unpaywall: OA flags
- fulltext: PMC/EPMC/PDF word/count features, PMC figure/table/ref counts
- preprint: preprint existence and publication gap
- journal history: prior-year-only `j_hist_*` metrics
- labels: `y_jcr_jif`, `y_icite_rcr`, `y_citations_log`

## Leakage Rule

Same-year `journal_year_metrics` are used only for labels. Feature columns use the latest `journal_year_metrics` row where:

```text
metric_year < paper.year
```

No same-year `jcr_jif` is emitted as a feature.

## Smoke Test

Command:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts\build-fatecore-features-v0.3.mjs --min-scores=0 --limit=1000 --out=E:\paperfate\data\features\v0.3-features-smoke.csv --manifest=E:\paperfate\data\features\v0.3-features-smoke-manifest.json
```

Result:

- `1,000 rows x 71 columns`
- CSV and manifest written successfully.

## Full Build

Started with defaults:

```powershell
node --max-old-space-size=4096 scripts\build-fatecore-features-v0.3.mjs
```

Result:

- rows written: `857,284`
- columns: `71`
- CSV size: `222,544,784` bytes
- CSV mtime: `2026-05-24 10:53 KST`
- score-filtered rows: `2,380,741`
- label-filtered rows: `511`

The Q aggregate preload took several minutes, then CSV writing proceeded at roughly `30K-40K rows/s`.

Monitor:

```powershell
Get-Content E:\paperfate\data\_features_v0.3_2026-05-24.log -Tail 80
Get-Item E:\paperfate\data\features\v0.3-features.csv
```
