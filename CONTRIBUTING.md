# Contributing to PaperFate

PaperFate is jointly maintained by Claude (UI + API + smoke + docs) and
Codex (extraction pipeline + training + weights). This file covers the
day-to-day workflow for the Claude-owned surfaces. For Codex-owned paths
see `docs/CODEX_HANDOFF_*.md`.

## Quick start

```bash
# Clone, install, run the Vite dev server on http://localhost:5180
npm install
npm run dev

# Production bundle (output: dist/)
npm run build

# Local preview of the production bundle
npm run preview
```

`npm run dev` only serves the React app. The `/api/*` routes run on
Vercel serverless and are **not** hosted by Vite. The Simulator falls
back to `src/lib/mockEngine.js` for offline preview when the deployed
API is unreachable. To exercise real endpoints during development,
point the smoke harness at production:

```bash
node scripts/smoke-production-v2.mjs --quick
```

`--quick` skips the slow Q500 path and finishes in ~30 s; it is the
recommended sanity check before pushing.

## Repository layout

See `README.md` § Repository layout. The short version:

- `api/*.js` — Vercel serverless functions. Self-contained per file.
- `src/components/*.jsx` — React UI.
- `src/lib/*.js` — frontend clients (telemetry, forecast client,
  history store, i18n, share, SW updater, mock engine, version).
- `src/server/*` — FateCore inference + suggestion engine + extract
  pipeline. Most files here are Codex-owned (see § Ownership below).
- `scripts/*` — ETL, training, evaluation, smoke harnesses, tests.
- `weights/` — deployed LightGBM models + journals shortlist.

## Ownership

Before editing anything, confirm the file is in your domain. From the
top of `README.md`:

**Codex-owned** (do not touch from a Claude session):
`src/server/extract.js`, `src/server/ruleExtractors.js`,
`weights/fatecore-*`, `scripts/train-fatecore-*.py`,
`scripts/build-fatecore-features-v0.5.mjs`,
`scripts/build-prepub-features.py`,
`scripts/score-q500-fulltext-llm.mjs`,
`scripts/build-extras-features-v2.mjs`,
`scripts/export-extras-subset.mjs`, and the
`docs/CODEX_HANDOFF_*.md` / `docs/EVAL_v*.md` series.

**Claude-owned**: `api/*.js`, `src/components/*.jsx`, `src/lib/*.js`,
the smoke harness, this file, `SECURITY.md`, `CHANGELOG.md`, and
`README.md`.

Per-round briefs in `docs/CODEX_HANDOFF_*.md` further partition the
work among multiple Claude workers. Stay in your declared domain.

## Adding a new API endpoint

Endpoints live in `api/<name>.js` and follow a strict template so the
smoke harness can exercise them without per-file glue. To add one:

1. **Create `api/<name>.js`.** Copy the inline `corsHeaders()` helper
   and inline `readBody()` helper from `api/status.js` (or
   `api/abstract-quality.js` if you need a POST body). Do **not**
   factor them into a shared module — Vercel serverless functions
   each ship their own bundle, and the inline copies are intentional
   to keep cold-start size predictable.
2. **Add an in-process token-bucket rate limiter.** Use the same
   shape as `api/forecast.js` or `api/abstract-quality.js`
   (`_buckets` Map, `_pruneBuckets`, `_takeToken`). Pick a sensible
   per-IP/hour budget. Bypass the bucket when the request carries
   `x-paperfate-internal: $PAPERFATE_INTERNAL_TOKEN`.
3. **Set `export const config = { maxDuration: <s>, runtime: 'nodejs' }`**
   on the handler. Tune `maxDuration` to the slowest legitimate path
   (Q500 needs the Pro 300 s ceiling; lookups can stay at 10 s).
4. **Return `{ ok, request_id, server_version }`** alongside the
   payload, and `{ error, detail, request_id }` on failure. The smoke
   harness asserts on `ok` and on per-endpoint shape.
5. **Register the endpoint in the smoke harness.** Add an entry to the
   table inside `scripts/smoke-production-v2.mjs` with a realistic
   payload, the expected response shape, and a latency budget.
6. **Surface it in `api/status.js`.** Append the route name to the
   `endpoints` array so `/api/status` reflects the public surface.
7. **Surface it in the `Status.jsx` panel.** The UI reads
   `/api/status` and renders the endpoint list; the panel should not
   need code changes if the array drives the render, but eyeball it.
8. **Document it.** Add a short entry to `docs/API.md`. If it has user
   impact, add a line to `README.md` § What's new and `CHANGELOG.md`.

## Adding a new component

Components live in `src/components/<Name>.jsx` and are pulled into the
shell by `src/App.jsx` (or whichever parent owns the route).

1. **Verify the build.** After your edit run `npm run build` once.
   esbuild parses every file in the dep graph; a syntax slip in a
   component will fail the bundle immediately.
2. **Accessibility.** Every interactive element needs a label
   (`aria-label`, `aria-labelledby`, or visible text). Modal/popover
   surfaces need `role="dialog"`, focus trap, and Escape-to-close.
   Buttons must be `<button>`, not `<div onClick>`. Match the
   `PWAInstallPrompt.jsx` and `SWUpdateToast.jsx` patterns.
3. **Telemetry.** If the component has interactive surfaces worth
   measuring, import `trackEvent` from `src/lib/telemetry.js` and
   fire on the meaningful action (open, submit, dismiss, share).
   `trackEvent` uses `navigator.sendBeacon` when available and falls
   back to a fire-and-forget `fetch`, so it is safe in unload paths.
4. **i18n.** Every user-visible string must come from
   `src/lib/i18n.js` `t(key)`. Add the key to **both**
   `src/lib/messages-ko.json` and `src/lib/messages-en.json`. The
   vocabulary now sits at 99 keys; missing-key drift fails
   `scripts/test-i18n.mjs`.
5. **No new deps.** See § Code style below.

## Code style

- **No new dependencies** unless explicitly asked. The current
  package.json is intentionally minimal (React, Tailwind, Vite,
  `better-sqlite3` server-side, three parsers). Prefer browser/Node
  built-ins. If you genuinely need a dep, raise it in the PR
  description first.
- **Additive patches.** Prefer adding new files / new fields over
  rewriting shared modules. The Codex/Claude split assumes minimal
  cross-owner churn. Round briefs always say "additive — do not
  delete existing keys / fields / endpoints".
- **Sequential commits in small logical chunks.** Each round
  produces 5–10 commits, not one giant patch. Order matters:
  scaffolding first, wiring second, polish/tests last. The Round
  brief usually pre-numbers the chunks.
- **Inline over shared.** For the serverless functions, repeating
  `corsHeaders` and `readBody` per file is the deliberate house
  style. Shared modules would bloat every cold-start bundle.
- **No emojis in code or commits** unless the user asks for them.
- **Server version constant.** When the response shape changes in a
  meaningful way, bump `server_version` in the handler and in
  `src/lib/version.js`.

## Running the tests

```bash
# Lightweight unit tests + import-lint guard
node scripts/run-tests.mjs
```

The runner sequences the following node:test files:

- `scripts/test-sanitizer.mjs`
- `scripts/test-confidence-cap.mjs`
- `scripts/test-rate-limiter.mjs`
- `scripts/test-forecast-history.mjs`
- `scripts/test-i18n.mjs`
- `scripts/test-import-lint.mjs`

It then runs `scripts/lint-imports.mjs` as a final guard. The whole
suite exits non-zero on any test failure or lint violation. The
current pass count is 54.

Smoke-test the deployed app any time the API surface or shape
changes:

```bash
# Full smoke against paperfate.com (~3-4 min, runs Q500)
node scripts/smoke-production-v2.mjs

# Skip Q500
node scripts/smoke-production-v2.mjs --quick

# Point at staging / local Vercel dev
node scripts/smoke-production-v2.mjs --base-url http://localhost:3000 --quick
```

Perf budgets live in `scripts/perf-audit.mjs` and
`scripts/check-bundle-budget.mjs`; both are wired into the same exit
contract (0 = green, 1 = budget exceeded).

## Filing changes

PaperFate currently lands changes via direct commits to `main`. There
is no formal PR template, but each round's deliverables are tracked
in `docs/CODEX_HANDOFF_*.md` with explicit acceptance criteria. When
in doubt, mirror the format of the most recent handoff.
