# Changelog

All notable user- and developer-facing changes to PaperFate, grouped
by round. Rounds correspond to the `docs/CODEX_TASKS_*_ROUND*.md`
briefs that scope each sprint.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versions are not tagged because the deployed surface is the live
Vercel build of `main`.

## [Unreleased] — 2026-05-30

### Round 9 — Polish + docs + contributor onboarding

- Added `CONTRIBUTING.md` covering local setup, endpoint template,
  component template, code style, and test workflow.
- Added `SECURITY.md` with threat model, browser-side header stack,
  rate-limit limitations, and reporting channel.
- Added this `CHANGELOG.md`.
- README "What's new" section refreshed with the Round 7–9
  deliverables.

### Round 8 — Component swaps + perf audit

- Performance budget enforcement: `scripts/perf-audit.mjs` and
  `scripts/check-bundle-budget.mjs` wired into the test contract
  (exit 1 on regression).
- Lint guard: `scripts/lint-imports.mjs` blocks accidental
  cross-domain imports and is enforced by `node scripts/run-tests.mjs`.
- 54 lightweight unit tests covering sanitizer, confidence cap, rate
  limiter, forecast history, i18n vocabulary, and import lint.

### Round 7.5 — Production smoke v2 + 11-endpoint coverage

- New harness `scripts/smoke-production-v2.mjs` exercises all 11
  public endpoints with realistic payloads, shape assertions, and
  per-endpoint latency budgets.
- `--quick` mode skips the slow Q500 path (~30 s end-to-end).
- Degraded-mode response (`extractor_used='rule_fallback'`,
  `llm_health.status='degraded'`) is reported as WARN, not FAIL,
  so the harness stays green during transient Gemini outages.
- Legacy 5-endpoint `scripts/smoke-production.mjs` retained for
  backwards compatibility.

### Round 7 — PWA + Web Share + SW updater + extras pipeline

- `PWAInstallPrompt.jsx` — captures `beforeinstallprompt`, shows a
  dismissable install card, fires telemetry.
- `SWUpdateToast.jsx` — listens for service-worker updates via
  `src/lib/swUpdater.js` and prompts the user to reload.
- `src/lib/shareForecast.js` — Web Share API with clipboard
  fallback; wired into `ResultPanel.jsx`.
- Reference + co-author extras feature builder
  (`scripts/build-extras-features-v2.mjs`, Codex-owned) prepares
  the v0.5 feature CSV. Cost-free, pre-publication-safe.
- Q500 production timeout root-caused and fixed: paid-tier Gemini
  client now uses `rpm=120, batchSize=25, isFreeTier=false`,
  eliminating the ~290 s of mandatory rate-limit gaps that were
  causing 504s.

### Round 6.5 — Telemetry analytics + rate-limiter tuning

- `scripts/analyze-telemetry.mjs` aggregates the
  `/api/telemetry-beacon` event log into per-surface counts and
  trend lines.
- Rate-limiter token bucket tuned per endpoint
  (30/hr for `/api/forecast`, 60/hr for `/api/abstract-quality`,
  higher budgets for the read-only lookups).
- `x-paperfate-internal: $PAPERFATE_INTERNAL_TOKEN` bypass header
  for the internal smoke harness so smokes don't burn user budget.

### Round 6 — Security headers + CSP + Permissions-Policy

- `vercel.json` ships HSTS (2 y, preload), CSP, X-Frame-Options
  DENY, X-Content-Type-Options nosniff, Referrer-Policy
  strict-origin-when-cross-origin, and Permissions-Policy disabling
  geolocation / microphone / camera / payment.
- Headers applied to both `/(.*)` and `/api/(.*)`.
- `frame-ancestors 'none'` blocks all embedding.

### Round 5 — i18n vocabulary + Korean/English parity

- `src/lib/i18n.js` `t(key)` lookup over `messages-ko.json` and
  `messages-en.json` (99 keys, full parity).
- Korean copy reviewed for tone consistency with the in-app
  Methods section.
- `scripts/test-i18n.mjs` enforces no missing/orphan keys across
  the two locales.

### Round 4 — Telemetry plumbing + beacon sink

- `src/lib/telemetry.js` `trackEvent()` uses
  `navigator.sendBeacon` when available, falls back to a
  fire-and-forget `fetch`.
- `api/telemetry-beacon.js` accepts arbitrary JSON event payloads,
  rate-limits per IP, and is treated as a log sink (not a
  security-grade audit trail).
- Per-surface wiring lands across `Simulator.jsx`,
  `ResultPanel.jsx`, `Compare.jsx`, `Status.jsx`.

### Round 3 — Compare panel + abstract-quality fast path

- `Compare.jsx` — side-by-side comparison for up to 5 journals.
- `api/journal-compare.js` — batched single round-trip backing
  `Compare.jsx`.
- `api/abstract-quality.js` — pure Q100 abstract-only scorer with
  no FateCore / suggestions / counterfactual overhead.
- Simulator "quick rubric check" button surfacing the
  abstract-quality fast path.

### Round 2 — Author features + graceful degradation

- `api/author-features.js` — h-index aggregation with
  `single_author` flag.
- `api/forecast.js` graceful degradation: when >50% of LLM items
  fail (invalid Gemini key, rate limit, timeout), the handler
  re-runs the deterministic rule pre-pass and tags the response
  with `extractor_used: 'rule_fallback'`,
  `llm_health: { status: 'degraded', reason }`, and
  `confidence ≤ 0.30`. No more silent zeros.
- `ResultPanel.jsx` degraded-mode banner.

### Round 1 — Status + journal autocomplete + SEO

- `api/status.js` reports server version, deploy commit, and the
  list of public endpoints.
- `api/journals-search.js` — autocomplete over the bundled
  800-journal shortlist (originally 2,840; trimmed for bundle
  size).
- `Status.jsx` panel renders `/api/status` for at-a-glance health.
- Sitemap + `robots.txt` refreshed; per-route metadata; OG card
  alignment with the in-app brand voice.

## Earlier work (pre-sprint, summarized)

The pre-sprint surface shipped:

- FateCore v0.2 prod model (JIF / RCR / citations log) live since
  initial deploy.
- FateCore v0.4-timeline model (review days, MAE 59.4 d, 90.2 %
  conformal coverage).
- Counterfactual suggestion engine — re-inference with the weakest
  Q500 item lifted to anchor 4.
- Submission journey — five ordered targets with category-jaccard
  + publisher + |Δlog IF| + OA-model switch costs.
- Similar-published-papers retrieval via OpenAlex with ISSN→JIF
  join.
- Bibliography summary endpoint (`/api/references`) for DOI lists
  up to 50.

See `docs/MODEL.md`, `docs/EVAL_v0.4-timeline.md`,
`docs/V0.3_PUB_LEAK_DIAGNOSIS.md`, and the
`docs/CODEX_HANDOFF_*.md` series for the detailed history.
