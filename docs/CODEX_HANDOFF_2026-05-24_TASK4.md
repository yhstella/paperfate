# CODEX Handoff 2026-05-24 Task 4 - Q500 Fulltext Rescore

## Status

Deferred.

## Reason

Task 4 depends on new PMC S3 fulltext being fetched and then ingested into `paperfate.db` so that `pmc_body_word_count` and related fulltext columns increase materially.

Current priority order from `docs/CODEX_TASKS_2026-05-24.md` was:

1. PMC S3 collector hardening
2. Author feature propagation
3. v0.3 feature build
4. Q500 fulltext rescore only after new PMC S3 ingest

Tasks 1-3 have been started/completed as appropriate; Task 4 should not run yet because it would mostly rescore the same current fulltext set.

## Suggested Resume Condition

Resume after:

- hardened PMC S3 run has produced a meaningful new JSONL increment;
- `build-unified-db.mjs` or the auto-ingest watcher has ingested the new PMC S3 output;
- `papers.pmc_body_word_count > 0` has increased materially.

## Suggested Implementation

Add `--only-new` to `scripts/score-codex-q500-fulltext.mjs` so it only scores papers with fulltext availability and no existing `mode='codex_deterministic'` Q500 rows for the fulltext item set.

Expected output remains `paper_scores` upsert under:

```text
mode = 'codex_deterministic'
```
