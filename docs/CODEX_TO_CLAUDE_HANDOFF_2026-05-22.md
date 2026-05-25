# Codex → Claude handoff (2026-05-22 06:36 KST)

## Summary

PaperFate/FateCore parallel work is stable. Q100 deterministic scoring is complete, server inference is wired to FateCore v0.1 weights, and long-running collectors are still active. Current safest next work is incremental ingest of already collected raw data (`authors`, `epmc`, later `openalex/crossref/pubmed`) while avoiding overwriting Claude training artifacts unless intentionally retraining.

## Current DB / corpus snapshot

- `DATA_ROOT`: `E:\paperfate\data`
- DB: `E:\paperfate\data\paperfate.db`
- DB size: ~32.1 GB
- papers total: `866,327`
- papers with abstract: `819,902` (`94.64%`)
- Q100 deterministic scores:
  - mode: `codex_deterministic`
  - rows: `81,990,200`
  - items: `100`
  - coverage: exactly `819,902 x 100`
- Other score modes:
  - `external`: `2,016,018` rows, `9` items
  - `rule`: `1,320,351` rows, `23` items
  - `llm`: `7,200` rows, `100` items

## Long-running collectors

As of 2026-05-22 06:36 KST:

- OpenAlex Authors:
  - process: `scripts/collect-openalex-authors.mjs --source jsonl --rps 25 --parallel 20`
  - progress: `625,000 / 941,090`
  - ok/miss/fail: `624,981 / 1 / 18`
  - rate: ~`16.9/s`
  - ETA: ~`311 min`
  - raw output: `E:\paperfate\data\openalex-authors\all-2026-05-21.jsonl`
  - file size then: ~`1.96 GB`

- EuropePMC fulltext:
  - process: `scripts/collect-europepmc-fulltext.mjs`
  - progress: `142,300 / 254,145`
  - ok/miss/fail: `64,945 / 77,355 / 0`
  - rate: ~`4.0/s`
  - ETA: ~`466 min`
  - raw output: `E:\paperfate\data\europepmc-fulltext\all-2026-05-21.jsonl`
  - file size then: ~`3.08 GB`

- OpenAlex works:
  - process: `scripts/collect-openalex.mjs`
  - progress: `387,900 / 767,567`
  - ok/miss/fail: `387,292 / 599 / 9`
  - rate: ~`5.0/s`
  - output: `E:\paperfate\data\openalex\all-2026-05-21.jsonl`

- Crossref:
  - process: `scripts/collect-crossref.mjs`
  - progress: `955,900 / 1,015,340`
  - ok/miss/fail: `944,685 / 11,178 / 37`
  - rate: ~`14.5/s`
  - close to completion
  - output: `E:\paperfate\data\crossref\all-2026-05-21.jsonl`

- PubMed:
  - seed expansion log says completed: `Done in 1164.5 min`
  - one `collect-pubmed.mjs` process was still visible at status time, so verify whether it is idle before starting PMC fulltext.

- bioRxiv:
  - completed
  - new entries: `498,314`
  - output: `E:\paperfate\data\biorxiv\preprints-2026-05-21.jsonl` (~`1.13 GB`)

## DB ingest status

Already ingested into SQLite:

- `authors`: `285,516` rows
- `first_author_h_index`: `122,622` papers
- `max_team_h_index`: `262,314` papers
- EuropePMC fulltext rows in DB: `50,523`
- PMC fulltext rows in DB: `0`

Important: raw collection is now ahead of DB ingest. Ingesting the current raw author and EPMC files should substantially raise coverage.

Safe incremental commands:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=authors
node scripts/build-unified-db.mjs --only=epmc
```

After Crossref/OpenAlex/PubMed finish or reach a natural checkpoint, safe ingest commands are:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=openalex,crossref,pubmed
```

Do not start PMC fulltext until PubMed/NCBI collectors are confirmed stopped, because PubMed + PMC share NCBI polite-pool limits.

## FateCore / inference state

Weights exist and server inference is functional:

- `weights/fatecore-v0.1-y_jcr_jif.txt`
- `weights/fatecore-v0.1-y_icite_rcr.txt`
- `weights/fatecore-v0.1-y_citations_log.txt`
- `weights/fatecore-v0.1-metrics.json`

Inference/runtime files added or updated:

- `src/server/fatecoreInference.js`
- `src/server/deterministicExtract.js`
- `api/forecast.js`
- `scripts/test-fatecore-inference.mjs`
- `scripts/test-forecast-api.mjs`

Current API behavior:

- Default extractor is zero-cost deterministic Q100 (`codex_deterministic`).
- LLM extraction only happens if `PAPERFATE_EXTRACTOR=llm` and an API key is present.
- API smoke test returned:
  - `statusCode=200`
  - `model_status=loaded`
  - loaded targets: `jcr_jif`, `icite_rcr`, `citations_5yr`
  - `feature_count=116`
  - `cost_usd=0`
  - `llm_items=0`
  - `deterministic=true`

Verification commands that passed:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/test-fatecore-inference.mjs
node scripts/test-forecast-api.mjs
npm run build
```

## Q500 / fulltext status

Q500 production scoring has not been run. This is intentional.

Existing prep script:

- `scripts/score-codex-q500-fulltext.mjs`

It defaults to dry-run and requires `--write --force` for DB writes.

Latest dry-run:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/score-codex-q500-fulltext.mjs --source europepmc --limit 20
```

Result:

- papers scored: `20`
- scored rows: `5,994`
- `na`: `2,146`
- `unknown`: `0`
- distribution: `1=1540`, `3=2208`, `4=2246`
- `wrote=false`

Recommendation: keep Q500 writes paused until fulltext coverage is higher and item-specific rules are reviewed. Current scorer is useful for diagnostics, not final production scoring.

## Utility status script

Codex added:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/status-codex-parallel.mjs
node scripts/status-codex-parallel.mjs --deep
```

The deep mode counts score modes and can take longer because `paper_scores` has ~82M codex rows.

## Collision / coordination notes

- Avoid overwriting current FateCore feature CSVs or weights unless Claude intentionally retrains:
  - `E:\paperfate\data\fatecore\features-2026-05-21.csv`
  - `E:\paperfate\data\fatecore\labels-2026-05-21.csv`
  - `E:\paperfate\data\fatecore\feature-schema.json`
  - `C:\Users\R\paperfate\weights\*`
- Incremental DB ingest for `authors` and `epmc` is safe and does not touch model weights.
- `paper_scores` Q100 is complete. Do not rerun full Q100 unless explicitly validating.
- Q500 production write should remain paused unless explicitly approved.
- PMC collector should wait until NCBI/PubMed collectors are confirmed finished.

## Recommended next actions

1. Run incremental author ingest now or after the author collector reaches another large checkpoint:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=authors
```

2. Run incremental EuropePMC ingest:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=epmc
```

3. When Crossref finishes, ingest Crossref and check label/metadata coverage:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=crossref
```

4. When OpenAlex works reaches a checkpoint or finishes, ingest OpenAlex:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=openalex
```

5. Only after PubMed collectors are done, start/restart PMC fulltext if needed.

