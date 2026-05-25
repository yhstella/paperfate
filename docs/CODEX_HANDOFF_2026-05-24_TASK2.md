# CODEX Handoff 2026-05-24 Task 2 - Author Feature Propagation

## Status

Done.

## Files Changed

- `scripts/propagate-author-features.mjs`

## Script Behavior

`scripts/propagate-author-features.mjs` recomputes paper-level author features from:

- `papers.authorships_json`
- `authors.openalex_id`
- `authors.h_index`
- `authors.works_count`
- `authors.cited_by_count`
- `authors.last_known_country`
- `authors.affiliations_json`

Computed / overwritten columns:

- `first_author_h_index`
- `last_author_h_index`
- `max_team_h_index`
- `median_team_h_index`
- `team_size_with_id`
- `international_collab`
- `fetched_authors_at`

The script uses:

- `busy_timeout=60000`
- read/write SQLite connections split apart to avoid `better-sqlite3` iterator/transaction conflicts
- 5,000-row write batches
- idempotent overwrite

## Verification

Dry run passed:

- limit: `10,000`
- with OpenAlex author IDs: `9,875 / 10,000`
- no author hits: `220`

Full run completed twice:

1. First run found that `international_collab` became NULL for no-country cases.
2. Script was corrected so `international_collab = 1` only for 2+ countries, otherwise `0`, then rerun.

Final coverage:

- papers total: `3,501,005`
- with `authorships_json`: `929,209`
- `first_author_h_index`: `737,051` (`79.32%` of authorship papers)
- `last_author_h_index`: `761,522` (`81.95%`)
- `max_team_h_index`: `864,550` (`93.04%`)
- `median_team_h_index`: `864,550` (`93.04%`)
- `team_size_with_id`: `922,051` (`99.23%`)
- `international_collab`: `922,051` (`99.23%`)

Run stats:

- seen: `929,209`
- parsed: `928,202`
- with author IDs: `920,617`
- no IDs: `7,585`
- no author hits: `57,115`
- updated: `920,617`

## Notes

`first_author_h_index` did not increase because current `authors` coverage does not add new first-author hits beyond the existing DB state. `last_author_h_index` improved from `753,444` to `761,522`.

An initial launch accidentally opened `C:\Users\R\paperfate\data\paperfate.db` because of PowerShell env quoting. That zero-byte local DB was removed. The real DB used for the completed runs was `E:\paperfate\data\paperfate.db`.
