# CODEX Handoff 2026-05-30 — Reference + Coauthor Extras for v0.5

Author: Worker III (Claude)
Owner of integration: Codex (Round 7 Task 3)
Status: cost-free, pre-publication-safe, ready to fold into v0.5 feature build.

## Summary

A new builder ships an auxiliary feature table that captures two signal families currently absent from the v0.5 prepub feature CSV:

1. Reference-quality features derived from `paper_references` joined to local journal IF tables.
2. Co-author seniority features derived from `papers.authorships_json` joined to `authors.h_index`.

All features are computable at submission time (no post-publication leakage).

## Builder

- New file: `scripts/build-extras-features-v2.mjs`
- Writes only to a new table `paper_extras_v2` (DOI primary key, NOCASE).
- Reads only from: `papers`, `paper_references`, `authors`, `journals`, `journal_year_metrics`.
- Does NOT touch `paper_scores`, any Codex-owned trainer feature CSV, or any v0.5/v0.3 manifest.
- Idempotent. Defaults to skipping DOIs already present. Flags:
  - `--limit N` — bound run (for smoke tests).
  - `--force` — recompute rows already present.
  - `--rebuild` — `DROP TABLE` then recreate (use sparingly).
  - `--batch=N` — write batch size (default 1000).
  - Threshold overrides: `--top5-cutoff`, `--nejm-cutoff`, `--h-gt`, `--tier0-h`, `--tier1-h`, `--if-proxy-scale`.
- Uses `better-sqlite3` with `busy_timeout=60000`, WAL, NORMAL sync.

Run example:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts\build-extras-features-v2.mjs
# smoke test:
node scripts\build-extras-features-v2.mjs --limit 1000
```

## Columns (DOI primary key)

| Column | Type | Computation | Source tables |
|---|---|---|---|
| `refs_count` | INTEGER | `COUNT(*)` of `paper_references` for `doi`. | `paper_references` |
| `refs_jif_mean` | REAL | Mean JIF over references whose journal/year is matched. | `paper_references` → `papers` (by `openalex_id`) → `journal_year_metrics(venue_openalex_id, year).jcr_jif`; fallback `journals.two_yr_mean_citedness * IF_PROXY_SCALE`. |
| `refs_jif_median` | REAL | Median of the same JIF set as `refs_jif_mean`. | (same) |
| `refs_jif_top5_share` | REAL | Share of matched references whose JIF ≥ `TOP5_JIF_CUTOFF` (default 20). | (same) |
| `refs_to_NEJM_class_count` | INTEGER | Count of matched references whose JIF ≥ `NEJM_CLASS_JIF_CUTOFF` (default 40; NEJM/Lancet/JAMA/Nature/Science class). NULL when there are no refs at all; 0 when refs exist but none had a JIF lookup. | (same) |
| `refs_mean_year_gap` | REAL | Mean of `(source paper year) - (referenced paper year)` over references whose year is known. | `papers.year` × `paper_references` → `papers.year` |
| `coauthor_max_h` | INTEGER | Max h-index across authorships whose OpenAlex author ID resolves in `authors`. | `papers.authorships_json` → `authors.h_index` |
| `coauthor_top3_h_mean` | REAL | Mean h-index of the top 3 highest-h coauthors (uses up to 3; fewer if team is smaller). | (same) |
| `coauthor_count_h_gt_50` | INTEGER | Count of coauthors with `h_index > COAUTHOR_H_GT_THRESHOLD` (default 50). | (same) |
| `author_tier0_pubs` | INTEGER | Count of coauthors with `h_index >= TIER0_H` (default 70). | (same) |
| `author_tier1_pubs` | INTEGER | Count of coauthors with `TIER1_H <= h_index < TIER0_H` (defaults 40 ≤ h < 70). | (same) |

Notes:

- The JIF lookup falls back to `journals.two_yr_mean_citedness` when no JCR JIF is on file for the exact (venue, year). That is acceptable as a proxy but means `refs_jif_*` will be slightly noisier at the edges. Multiplicative correction available via `--if-proxy-scale`.
- All thresholds are constants in the script; please do not silently change them in `train-fatecore-v0.5.py` — change them here so the doc stays in sync.

## Suggested Integration Into v0.5 Trainer (READ-ONLY suggestion)

For `scripts/build-fatecore-features-v0.5.mjs` (which Codex owns; I did not touch it):

1. After opening `Database` for read, add a single prepared statement:

   ```js
   const extrasByDoi = db.prepare(`
     SELECT refs_count, refs_jif_mean, refs_jif_median, refs_jif_top5_share,
            refs_to_NEJM_class_count, refs_mean_year_gap,
            coauthor_max_h, coauthor_top3_h_mean, coauthor_count_h_gt_50,
            author_tier0_pubs, author_tier1_pubs
     FROM paper_extras_v2 WHERE doi = ?
   `)
   ```

2. Append the 11 column names to `newFeatureCols`. None of them are post-publication features. All are computable from data that exists at submission time:
   - reference list and reference venues are part of the manuscript.
   - coauthor h-indices come from prior public output of the listed authors.

3. In the CSV row loop, alongside `ruleFeatures(paper)`, do:

   ```js
   const extras = doi ? (extrasByDoi.get(doi) || {}) : {}
   ```

   then emit `csvCell(extras[col] ?? '')` for each new column.

4. Bump manifest `version` to `v0.5.1` (or whatever Codex prefers), add the new columns to `feature_cols` and `new_feature_cols`, and update the manifest `notes.policy` to say the extras came from `paper_extras_v2`.

Behavioral expectation:

- The new features should help discriminate the top JIF tier that v0.5 currently underpredicts (`top >=30` row in EVAL_v0.5.md): high coauthor h, high NEJM-class reference count, and high `refs_jif_mean` should correlate with high target JIF.
- `refs_mean_year_gap` captures "is this a fresh-literature paper or a methodological-anchor paper" — useful as a soft tier feature.

## What I did NOT do

- I did not run the builder against the live DB; only `node --check` syntax verification.
- I did not modify `scripts/build-fatecore-features-v0.5.mjs`, `scripts/build-prepub-features.py`, `scripts/build-fatecore-features-v0.3-prepub.mjs`, `src/server/extract.js`, `src/server/ruleExtractors.js`, or any trainer/eval/weight artifacts.
- I did not write to `paper_scores` or any Codex-owned table.

## CODEX action: integrate when convenient.
