# PMC S3 Crash Diagnosis / Hardening

Date: 2026-05-24

## Problem

`scripts/collect-pmc-aws-s3.mjs` had previously run for long periods and then stopped without a useful stack trace. The old run path made diagnosis difficult because:

- top-level `Promise.all(...)` could end the whole run when an unexpected worker-level rejection escaped;
- there was no heartbeat, so a hung fetch / stuck queue / dead process all looked similar from the outside;
- the process did not log heap/RSS state over time;
- the restart wrapper was not persistent enough to treat the collector as a long-running service;
- JSONL writes were synchronous append calls, but there was no explicit periodic `fsync`.

The exact prior exit code is not recoverable from the old log. The most likely practical causes are a long-tail network/fetch exception, a worker promise escape, or memory pressure while holding the done-PMCID set and queue for hundreds of thousands of PMCIDs.

## Hardening Applied

Updated `scripts/collect-pmc-aws-s3.mjs`:

- added `process.on('unhandledRejection')` and `process.on('uncaughtException')` logging;
- changed worker orchestration to `Promise.allSettled(...)`;
- isolated per-item and per-worker exceptions so one failed worker does not take down the run;
- added heartbeat logging every 5 minutes:
  - queue length
  - done/ok/miss/short/fail counts
  - worker fatal count
  - RSS and heap MB
- added `--expose-gc` support with explicit `global.gc()` every 60 seconds when available;
- switched JSONL output to a persistent append file descriptor with periodic `fsync`;
- changed DB reads to use `busy_timeout=60000`;
- streamed the DB PMCID candidate query with `.iterate()` instead of materializing all rows first.

Added `scripts/run-pmc-s3.ps1`:

- infinite restart loop;
- starts Node with `--expose-gc`;
- waits 30 seconds before restart;
- supports configurable `-Parallel`, `-Rps`, `-HeartbeatSec`, `-GcSec`, `-FsyncEvery`, and `-LogPath`.

## Active Run

Started hardened wrapper on 2026-05-24.

- wrapper PID: `56684`
- node PID: `57776`
- clean log: `E:\paperfate\data\_pmc_aws_s3_hardened_2026-05-24.log`
- output JSONL: `E:\paperfate\data\pmc-fulltext\aws-s3-2026-05-24.jsonl`

Initial queue state:

- already extracted in `pmc-fulltext`: `292,627`
- DB candidates without `pmc_body_word_count`: `864,327`
- skipped already done: `173,042`
- queued: `691,285`

The earlier `_pmc_aws_s3.log` contains mixed encoding from the pre-patch PowerShell `Tee-Object` run. Use the hardened log above for current monitoring.

## Monitoring

Useful checks:

```powershell
Get-Content E:\paperfate\data\_pmc_aws_s3_hardened_2026-05-24.log -Tail 80
Get-Item E:\paperfate\data\pmc-fulltext\aws-s3-2026-05-24.jsonl
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*collect-pmc-aws-s3.mjs*' -or $_.CommandLine -like '*run-pmc-s3.ps1*' }
```

If the Node child exits, the wrapper should append an exit line and restart after 30 seconds.
