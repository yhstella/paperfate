# Codex -> Claude handoff: post-ingest / Q500 running

Timestamp: 2026-05-22 07:34 KST  
Repo: `C:\Users\R\paperfate`  
DATA_ROOT: `E:\paperfate\data`  
DB: `E:\paperfate\data\paperfate.db`

## Executive summary

Codex completed the high-priority v0.2 data integration pass from `docs/CODEX_TASKS_2026-05-22.md`.

The major DB gap is now substantially reduced:

- `papers`: `866,327` -> `2,281,270`
- abstracts: `2,159,679`
- Semantic Scholar: `968,737`
- SPECTER2 embeddings: `554,365`
- Crossref: `983,853`
- iCite RCR: `772,868`
- Unpaywall: `725,748`
- OpenAlex: `416,369`
- authors table: `862,438`
- `first_author_h_index`: `353,982`
- `max_team_h_index`: `379,080`
- EPMC fulltext: `121,083`
- PMC fulltext: `9,426`
- PMCID mapping: `297,426`

Q500 fulltext deterministic scoring has started and is running in the background.

## Active background jobs

Check with:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/status-codex-parallel.mjs --deep
```

Active at handoff:

- OpenAlex works collectors:
  - `scripts/collect-openalex.mjs`
  - PIDs seen: `29528`, `45528`
- PubMed collector:
  - `scripts/collect-pubmed.mjs`
  - PID seen: `46304`
  - Note: previous PubMed seed expansion log had completed, but this process still existed. Verify idle/running before starting PMC fetch jobs.
- OpenAlex Authors collector:
  - `scripts/collect-openalex-authors.mjs --source jsonl --rps 25 --parallel 20`
  - PID: `32304`
  - progress: `711,900 / 941,090`
  - ok/miss/fail: `711,881 / 1 / 18`
  - rate: ~`17.6/s`
  - output: `E:\paperfate\data\openalex-authors\all-2026-05-21.jsonl`
- EuropePMC fulltext collector:
  - `scripts/collect-europepmc-fulltext.mjs`
  - PID: `41108`
  - progress: `156,200 / 254,145`
  - ok/miss/fail: `73,858 / 82,342 / 0`
  - rate: ~`4/s`
  - output: `E:\paperfate\data\europepmc-fulltext\all-2026-05-21.jsonl`
- Q500 fulltext scoring:
  - PID: `42020`
  - command: `node scripts/score-codex-q500-fulltext.mjs --source both --write --force`
  - stdout: `E:\paperfate\data\_q500_fulltext_2026-05-22.log`
  - stderr: `E:\paperfate\data\_q500_fulltext_2026-05-22.err.log`
  - stderr was empty at handoff.

## DB coverage snapshot

From `status-codex-parallel.mjs --deep`:

```text
DB size:                  41087.3 MB
papers total:             2,281,270
papers with abstract:     2,159,679 (94.67%)
OpenAlex:                 416,369 (18.25%)
Semantic Scholar:         968,737 (42.46%)
SPECTER2 embeddings:      554,365 (24.30%)
Crossref:                 983,853 (43.13%)
iCite RCR:                772,868 (33.88%)
Unpaywall:                725,748 (31.81%)
authors table:            862,438 rows
first_author_h_index:     353,982 (16.39% of abstract papers)
max_team_h_index:         379,080 (16.62% of all papers)
EuropePMC fulltext rows:  121,083 (5.31%)
PMC fulltext rows:        9,426 (0.41%)
```

Score modes:

```text
codex_deterministic: 82,992,641 rows, 507 items
external:             2,016,018 rows, 9 items
rule:                 1,320,351 rows, 23 items
llm:                      7,200 rows, 100 items
```

Interpretation:

- Q100 deterministic baseline remains complete: `81,990,200` rows = `819,902 x 100`.
- Q500 extra rows at handoff: `1,002,441` rows = `2,463 papers x 407 items`.
- Q500 is actively increasing while PID `42020` runs.

## Work completed by Codex

### 1. Full `build-unified-db` ingest

Started with:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs
```

The run completed PubMed, OpenAlex, and OpenAlex Authors, then failed at Semantic Scholar because the old reader used `readFileSync` on a very large JSONL:

```text
Error: Cannot create a string longer than 0x1fffffe8 characters
```

Fix applied:

- `scripts/build-unified-db.mjs`
  - replaced the synchronous whole-file JSONL reader with a chunked streaming reader using `openSync/readSync/StringDecoder`.
  - added `idx_pmcid` to avoid full scans during PMC fulltext updates.

Then resumed with:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=s2,crossref,sources,scimago,jcr,icite,unpaywall,clinicaltrials,pmc,epmc,pdf,biorxiv
```

The process hit a transient SQLite lock around Crossref logging, but the node process continued and committed; verification from `ingest_runs` showed Crossref completed. Later fulltext handling exposed slow `pmcid` lookup, so Codex stopped the owned build process, added `idx_pmcid`, and resumed only fulltext/preprint:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=pmc,epmc,pdf,biorxiv
```

Completed summary from that final fulltext/preprint run:

```text
pmc: all-2026-05-21.jsonl seen=9712 updated=9426
epmc: all-2026-05-21-batch1.jsonl seen=2014 updated=1968
epmc: all-2026-05-21.jsonl seen=122779 updated=120502
pdf: all-2026-05-21.jsonl seen=442 updated=442
pdf: errors-2026-05-21.jsonl seen=439 updated=439
biorxiv: preprints-2026-05-21.jsonl seen=498314 updated=0
```

BioRxiv updated zero papers because current matching logic did not find publication links in `papers`.

### 2. Q500 fulltext scoring

Dry-run over 1,000 papers:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/score-codex-q500-fulltext.mjs --source both --limit 1000
```

Dry-run result:

```json
{
  "papers_scored": 1000,
  "skipped_no_text": 52298,
  "skipped_no_paper": 13,
  "scored": 307014,
  "na": 99986,
  "unknown": 0,
  "dist": {
    "1": 53768,
    "3": 116988,
    "4": 136258
  },
  "wrote": false
}
```

Write smoke over 1,000 papers:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/score-codex-q500-fulltext.mjs --source both --limit 1000 --write --force
```

Write smoke succeeded:

```json
{
  "papers_scored": 1000,
  "skipped_no_text": 52298,
  "skipped_no_paper": 13,
  "skipped_scored": 0,
  "scored": 307014,
  "na": 99986,
  "unknown": 0,
  "wrote": true
}
```

Then full run started:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/score-codex-q500-fulltext.mjs --source both --write --force
```

Important: the scorer now has resume protection:

- default write behavior skips a paper if the first Q500-extra item already exists for `(doi, item_id, mode)`.
- pass `--no-skip-scored` only if intentionally overwriting existing Q500 rows.

At handoff, log tail showed:

```text
papers=1300 scored=395894 na=133206 unknown=0
```

Because of the 1,000-paper smoke plus background progress, DB count already showed:

```text
Q500 extra rows: 1,002,441 = 2,463 papers x 407 items
```

## Files changed by Codex in this pass

Key files:

- `scripts/build-unified-db.mjs`
  - chunked JSONL reader
  - `idx_pmcid`
- `scripts/score-codex-q500-fulltext.mjs`
  - write-mode resume skip
  - `skipped_scored` counter
- `scripts/status-codex-parallel.mjs`
  - reports OpenAlex/Crossref/Q500 processes
  - reports OpenAlex/S2/embedding/Crossref/iCite/Unpaywall coverage

Earlier Codex files still relevant:

- `src/server/fatecoreInference.js`
- `src/server/deterministicExtract.js`
- `api/forecast.js`
- `scripts/test-fatecore-inference.mjs`
- `scripts/test-forecast-api.mjs`

## Known caveats / coordination notes

1. Do not start PMC fulltext fetching while PubMed/NCBI processes are still active unless rate-limit sharing is handled. Current PMC DB ingest is done for existing raw file, but PMC collection itself is not restarted.

2. Q500 scoring is intentionally deterministic and regex-heavy. It is suitable as a wide weak-label layer, not a gold nuanced label layer.

3. Q500 score distribution has no 0/2/5 in current rules; it mostly emits 1/3/4 plus NA. This should be treated as weak signal / feature layer, not calibrated human-like scoring.

4. Full `paper_scores` is now growing beyond the original 82M Q100 rows. Any training builder must be explicit about which item set to consume:
   - Q100 only: use Q100 item list, not all `codex_deterministic`.
   - Q500/fulltext: use 507 items or split abstract/fulltext features deliberately.

5. Current feature CSVs and weights were not rebuilt by Codex after this ingest. If Claude starts v0.2 training, rebuild feature matrix deliberately from the new DB snapshot.

6. BioRxiv raw has `498,314` rows but `biorxiv` ingest matched zero current papers. Matching logic likely needs improvement if preprint gap is important.

## Suggested next steps for Claude

1. Monitor Q500 process:

```powershell
Get-Process -Id 42020 -ErrorAction SilentlyContinue
Get-Content E:\paperfate\data\_q500_fulltext_2026-05-22.log -Tail 40
Get-Content E:\paperfate\data\_q500_fulltext_2026-05-22.err.log -Tail 40
```

2. After Q500 finishes, validate Q500 extra coverage:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/status-codex-parallel.mjs --deep
```

3. Rebuild v0.2 feature matrix only when ready:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-fatecore-features.mjs --score-mode codex_deterministic --min-scores 80
```

Before using that command for v0.2, confirm whether `build-fatecore-features.mjs` should include only Q100 or Q500-expanded items. The current Q500 rows are fulltext-only for a subset of papers, while Q100 covers the broad abstract corpus.

4. Consider a v0.2 split:

- baseline broad model: Q100 + enriched metadata over ~2.16M abstract papers
- fulltext-enhanced model: Q100 + Q500 + PMC/EPMC/PDF features over ~120K fulltext papers

5. If OpenAlex Authors collector finishes, rerun author ingest:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=authors
```

6. If EuropePMC collector advances significantly, rerun EPMC ingest:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts/build-unified-db.mjs --only=epmc
```

