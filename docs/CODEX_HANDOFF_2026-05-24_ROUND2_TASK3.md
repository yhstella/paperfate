# CODEX Handoff 2026-05-24 Round 2 Task 3 - OpenAlex References

## Status

Implemented, smoke-tested, and launched in background.

- background PID: `69936`
- log: `E:\paperfate\data\_openalex_refs_2026-05-24.log`
- output: `E:\paperfate\data\openalex-refs\refs-2026-05-24.jsonl`
- launch rps: `16`, parallel: `12`

Reason for `--rps 16`: an older `scripts/collect-openalex.mjs` process is still running at about `9/s`, so this keeps aggregate OpenAlex traffic near the requested `25/s`. Once the older collector exits, refs can be restarted at `--rps 25`; resume will skip already fetched works.

Latest checked progress:

```text
Selected: 100,000 (JIF>=10 12,793, FWCI>=5 90,469, citations>=100 60,871)
Fetched rows: 2 across 1 file(s)
Queued: 99,998
1,500/99,998 ok=1,500 miss=0 fail=0 refs=58,915 rate=16.0/s eta=103m
```

## Files

- `scripts/collect-openalex-references.mjs`
- `scripts/ingest-paper-references.mjs`

## Collector

Command:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
$env:OPENALEX_EMAIL='beta@paperfate.com'
node scripts\collect-openalex-references.mjs --limit 100000 --rps 25 --parallel 16
```

Actual launched command:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
$env:OPENALEX_EMAIL='beta@paperfate.com'
node scripts\collect-openalex-references.mjs --limit 100000 --rps 16 --parallel 12
```

Output:

```text
E:\paperfate\data\openalex-refs\refs-YYYY-MM-DD.jsonl
```

Row shape:

```json
{"doi":"10.xxxx/xxxx","openalex_id":"W123","ref_openalex_ids":["W456"],"n_refs":1,"referenced_works_count":1,"fetched_at":"..."}
```

The collector:

- selects the top 100K papers from `papers` by JIF priority, FWCI, and citation popularity
- fetches OpenAlex `/works/{id}?select=id,doi,referenced_works,referenced_works_count`
- normalizes OpenAlex work IDs to short `W...` form
- resumes by scanning existing `openalex-refs/*.jsonl`
- honors `--retry-errors` if transient failures should be retried

## Ingest

Command:

```powershell
$env:DATA_ROOT='E:\paperfate\data'
node scripts\ingest-paper-references.mjs
```

Schema:

```sql
CREATE TABLE IF NOT EXISTS paper_references (
  doi             TEXT NOT NULL COLLATE NOCASE,
  ref_openalex_id TEXT NOT NULL,
  PRIMARY KEY (doi, ref_openalex_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_doi ON paper_references(doi);
CREATE INDEX IF NOT EXISTS idx_pr_ref ON paper_references(ref_openalex_id);
```

The ingest script skips error/missing rows and uses `INSERT OR IGNORE`, so re-running is safe.

Smoke ingest was run on the first 2 fetched rows:

```text
lines=2 rows=2 refs_seen=127 skipped=0
paper_references=127
source papers=2
unique ref works=127
```

Do not run the full ingest until the collector is complete, unless partial network features are explicitly desired.
