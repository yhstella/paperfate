# CODEX Handoff 2026-05-24 Task 1 - PMC S3 Collector Hardening

## Status

Done and relaunched in background.

## Files Changed

- `scripts/collect-pmc-aws-s3.mjs`
- `scripts/run-pmc-s3.ps1`
- `docs/PMC_S3_CRASH_DIAGNOSIS.md`

## What Changed

- Added global `unhandledRejection` / `uncaughtException` logging.
- Replaced top-level worker `Promise.all` with `Promise.allSettled`.
- Isolated per-item and per-worker failures.
- Added 5-minute heartbeat with queue, done/ok/miss/short/fail, RSS, heap.
- Added explicit `global.gc()` timer when Node is launched with `--expose-gc`.
- Added persistent append FD plus periodic `fsync`.
- Added DB `busy_timeout=60000`.
- Changed PMCID candidate loading to stream via `.iterate()`.
- Added persistent PowerShell restart wrapper.

## Active Run

- wrapper PID: `56684`
- node PID: `57776`
- log: `E:\paperfate\data\_pmc_aws_s3_hardened_2026-05-24.log`
- output: `E:\paperfate\data\pmc-fulltext\aws-s3-2026-05-24.jsonl`

Initial queue:

- already extracted: `292,627`
- DB candidates: `864,327`
- skipped already done: `173,042`
- queued: `691,285`

Recent observed progress from hardened log:

- heartbeat and GC lines are present.
- process is alive and fetching.
- latest observed: `7,250 / 691,285`, `miss=5,653`, `short=1,597`, `ok=0`, `fail=0`, `worker_fail=0`.
- current rate around `6-7/s`; actual rate is below `rps=20` because many PMCIDs require version probes / misses.

## Notes

The old `_pmc_aws_s3.log` has mixed encoding from the pre-patch wrapper. Current monitoring should use `_pmc_aws_s3_hardened_2026-05-24.log`.
