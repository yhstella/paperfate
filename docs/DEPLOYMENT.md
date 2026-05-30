# PaperFate — Deployment Runbook

> Operator-facing runbook for shipping PaperFate to production.
> Audience: the on-call engineer pushing to `main`, rolling back a bad deploy,
> or rotating an API key at 2 a.m. Read top-to-bottom once; after that the
> checklists are enough.
>
> Korean version: [DEPLOYMENT_KO.md](./DEPLOYMENT_KO.md)

---

## 1. Hosting layout

PaperFate is a static SPA + Vercel serverless API. There is no separate
backend host — everything ships from a single Vercel project.

| Piece | Where it lives |
|---|---|
| Frontend bundle (`dist/`) | Vercel static hosting |
| Serverless API (`api/*.js`) | Vercel Node 24 functions |
| GitHub repo | `main` is the only deploy branch |
| Domain (apex) | `paperfate.com` |
| Domain (canonical) | `www.paperfate.com` |
| GitHub Actions | `.github/workflows/smoke.yml` (production smoke on every push) |

### 1.1 Vercel project

- **Project name:** `paperfate`
- **Framework preset:** Vite (auto-detected).
- **Build command:** `npm run build` → `vite build`.
- **Output directory:** `dist`.
- **Install command:** `npm install --no-audit --no-fund`.
- **Node version:** 24 (set under Project → Settings → General → Node.js
  Version). The GitHub Action also pins Node 24 — keep these in lock-step.
- **Production branch:** `main`. Pull requests get preview deployments
  automatically; preview URLs are throw-away.

### 1.2 Domain configuration

The apex (`paperfate.com`) redirects/rewrites to `www.paperfate.com` via
`vercel.json`:

```json
"rewrites": [
  { "source": "/api/(.*)", "destination": "https://www.paperfate.com/api/$1",
    "has": [{ "type": "host", "value": "paperfate.com" }] }
]
```

DNS records (registrar side):

| Type | Name | Value |
|---|---|---|
| A    | `@`  | `76.76.21.21` (Vercel apex IP) |
| CNAME | `www` | `cname.vercel-dns.com.` |

Both `paperfate.com` and `www.paperfate.com` must be added to the Vercel
project under **Settings → Domains**. `www` is the primary/canonical; the
apex should be configured to "Redirect to www.paperfate.com (308)".

TLS is issued + renewed automatically by Vercel. There is nothing to rotate.

---

## 2. Environment variables

All env vars live in **Vercel → Project → Settings → Environment Variables**.
Set them for **Production** and **Preview**; the Development scope is only
needed if you run `vercel dev` locally.

| Variable | Required? | Scope | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | **Yes** (else degraded mode) | Production + Preview | See §2.1 |
| `ANTHROPIC_API_KEY` | Optional | Production | Fallback LLM when Gemini errors |
| `PAPERFATE_INTERNAL_TOKEN` | Recommended | Production + GH Actions secret | Smoke / rate-limit bypass |
| `TELEMETRY_LOG_PATH` | Optional | Production | Persistent path for JSONL; defaults to `/tmp/...` |
| `TELEMETRY_SALT` | Recommended | Production | Salt for IP hashing in telemetry |
| `PAPERFATE_ALLOWED_ORIGINS` | Optional | Production | Comma list; defaults to `https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180` |

### 2.1 `GEMINI_API_KEY` — the unrestricted-key rule

This is the single most common cause of a bad deploy. Read it twice.

**Symptom:** API responds 200 but `extractor_used: "rule_fallback"`, or the
forecast endpoint logs `API key not valid. Please pass a valid API key.`
Smoke turns AMBER, not red — the site still works, it just runs on the
rule extractor.

**Root cause:** Vercel's serverless functions egress from a **wide,
changing pool of IPs**. If the Gemini key has any **Application
Restriction** set in Google Cloud Console (HTTP referrers, IP allowlist,
Android, iOS), Google rejects calls from Vercel.

**Fix (do this when creating the key, and re-check after every rotation):**

1. Google Cloud Console → **APIs & Services → Credentials**.
2. Open the key used for PaperFate.
3. Under **Application restrictions**, select **None**.
4. Under **API restrictions**, leave **Generative Language API** (or your
   specific Gemini API) selected — that's the right kind of restriction.
5. Save. Wait ~30 seconds for propagation.
6. Re-deploy on Vercel (Settings → Deployments → Redeploy latest) so the
   functions pick up the env var if you also rotated it.

There is **no way** to allowlist Vercel IPs — the pool isn't published and
changes constantly. "None" + API-restriction is the supported posture.

### 2.2 `ANTHROPIC_API_KEY`

Optional. When present, the extractor falls back to Claude on Gemini errors
or timeouts. If absent, the extractor falls back to the rule-based path
(still functional, just lower quality). Either is fine for production;
having both is belt-and-suspenders.

### 2.3 `PAPERFATE_INTERNAL_TOKEN`

`/api/forecast` rate-limits at **30 requests / IP / hour** (in-process
token bucket; see `api/forecast.js`). The smoke and health scripts can
saturate that bucket if you re-run them in a tight loop.

Set `PAPERFATE_INTERNAL_TOKEN` to any high-entropy string. Then send it as
the `x-paperfate-internal` header — the rate limiter skips that request.

Mirror the same value into the GitHub Actions repo secret of the same
name so `smoke.yml` can pass it in. The header is also accepted by
`smoke-production-v2.mjs` when `PAPERFATE_INTERNAL_TOKEN` is exported in
the shell.

### 2.4 Telemetry vars

- `TELEMETRY_LOG_PATH` — absolute path to a JSONL log file. The beacon
  rotates daily by date suffix and caps at 10 MB. On Vercel the default
  path is `/tmp/paperfate-telemetry-<YYYY-MM-DD>.jsonl`, which is
  **ephemeral** (lost on cold start). Point it at a mounted volume or an
  ingest worker path if you need durable telemetry.
- `TELEMETRY_SALT` — random string. The beacon hashes client IPs with
  this salt to a 16-char prefix before writing. Rotate quarterly; old
  events become unjoinable from new ones, which is the intent.

---

## 3. Pre-deploy checklist (local)

Run these from the repo root **before** pushing to `main`. They are the
same checks the GH Action runs, minus the production hit. ~2 minutes total.

```bash
# 1. Tests
node scripts/run-tests.mjs

# 2. Import-path / module-boundary lint
node scripts/lint-imports.mjs

# 3. Production build (also catches type-y issues at build time)
npm run build

# 4. Bundle budget (gzip size budget enforced)
node scripts/check-bundle-budget.mjs
```

If any of those exit non-zero, **do not push**. The bundle budget check is
the most common stopper after a UI change — see the script's own output
for which chunk blew the cap.

---

## 4. Deploy

```bash
# From main, with a clean working tree
git push origin main
```

That's it. Vercel watches `main` and starts a production build within
~5 seconds. Build typically finishes in 60–90 seconds; the new deployment
becomes the production alias as soon as the build is healthy.

GitHub Actions kicks off `smoke.yml` on the same push and runs
`smoke-production-v2.mjs --quick` against the live domain. Watch it under
the **Actions** tab — if it fails, see §6.

---

## 5. Post-deploy verification

Run both. They take ~20 seconds combined.

```bash
# Quick: hits all 11 public endpoints, asserts response shape + latency
node scripts/smoke-production-v2.mjs --quick

# Full: smoke + security headers + PWA + SEO markup + rate-limit headers
node scripts/health-check.mjs
```

Acceptable states:

- **Green:** all checks pass. Ship it.
- **Amber (WARN):** `extractor_used: rule_fallback` or
  `llm_health.status: degraded`. Site is up but Gemini is unreachable —
  see §2.1 and §7.
- **Red (FAIL):** any 4xx (other than rate-limit) or 5xx, or missing
  security header. Roll back (§6).

Both scripts accept `--base-url` if you want to hit a preview deployment
or staging URL instead of `paperfate.com`.

---

## 6. Rollback

PaperFate has **no database migrations** in the deploy path. Rollback is
purely a frontend + serverless-function swap, so it's safe and instant.

1. Vercel dashboard → **Deployments**.
2. Find the last known-good deployment (timestamp before the bad push).
3. Click the `⋯` menu → **Promote to Production**.
4. Confirm. The production alias swings within ~5 seconds.
5. Re-run `node scripts/health-check.mjs` to confirm green.

After rollback, open a revert PR for the bad commit on GitHub so `main`
matches what's live. Don't leave `main` ahead of production for more than
one cycle — the next push will re-deploy the bad commit.

---

## 7. Common issues

### 7.1 `GEMINI_API_KEY` rejected — "API key not valid"

See §2.1. 95% of "Gemini is down" reports are actually the Application
Restriction being non-None.

Quick diagnostic:

```bash
curl -s https://paperfate.com/api/status | jq '.llm_health'
```

If `status: "degraded"` and `last_error` mentions `API key not valid`,
fix the Google Cloud Console restriction. If `last_error` is a timeout
or 5xx from Google, it's an upstream outage — wait it out or rely on the
Anthropic fallback.

### 7.2 New API file deployed but returns 404

**Cause:** Vercel ignores any file in `api/` whose name starts with `_`.
This bit us when `api/_telemetry-beacon.js` (intended as a draft) silently
404'd in production. The fix was renaming to `api/telemetry-beacon.js`.

**Rule:** never prefix an `api/*.js` file with `_`. If you need a helper
that isn't an endpoint, put it under `src/server/` and import it.

### 7.3 `/api/forecast` returns 429 during a smoke run

Rate limiter (30/IP/hour) tripped. Either:

- Wait an hour (the bucket refills at 1 token every 2 minutes), or
- Send the request with `x-paperfate-internal: $PAPERFATE_INTERNAL_TOKEN`
  to bypass the bucket. The smoke and health scripts pick the header up
  automatically when the env var is exported.

OPTIONS preflight requests are never counted, so CORS isn't the culprit.

### 7.4 Build passes locally but fails on Vercel

Almost always a Node version drift. Check
**Settings → General → Node.js Version** on Vercel matches your local
`node --version` and the GH Action's `node-version: '24'`. Pin to 24
everywhere.

### 7.5 Telemetry log not persisting

Default `/tmp/...` path is ephemeral on Vercel. Set `TELEMETRY_LOG_PATH`
to a durable mount, or accept that the JSONL is best-effort and lean on
the `[telemetry]` stdout prefix captured by Vercel's log drain.

---

## 8. Monitoring

- **GitHub Actions → Production smoke** runs `smoke-production-v2.mjs
  --quick` on every push to `main` and on `workflow_dispatch`. Failures
  notify via GitHub's default email/notification settings.
- **Vercel → Logs** — search for `[telemetry]` for client events and for
  `request_id` for API traces.
- **`/api/status`** is the cheapest live health probe. Returns
  `llm_health`, `extractor`, and the deployed git SHA. Hit it from any
  external uptime monitor with a 1-minute interval.

Add `node scripts/health-check.mjs` to a daily cron if you want belt-and-
suspenders coverage beyond the per-push smoke.

---

## 9. Security headers

All security headers ship from `vercel.json`. Don't move them into
serverless functions — Vercel applies the `headers` block to every
matched route, which keeps the static SPA, the SW, and the API all
consistent.

| Header | Value | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | 2-year HSTS, preload-eligible |
| `X-Content-Type-Options` | `nosniff` | Block MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Anti-clickjacking |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Don't leak full URLs to third parties |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=(), payment=()` | Deny powerful features the app doesn't use |
| `Content-Security-Policy` | see below | Tight default-src, restricted connect-src |

CSP value (kept in sync with `vercel.json`):

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
connect-src 'self' https://api.openalex.org https://*.vercel.app;
font-src 'self' data:;
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

The `health-check.mjs` script asserts every header is present on a sample
of routes; it will go red if a header disappears after an edit.

When you add a new outbound endpoint (e.g. a third-party API), update
`connect-src` in **both** `vercel.json` blocks (the catch-all and the
`/api/(.*)` block). Forgetting one breaks fetches from API routes only,
which is easy to miss in smoke.

---

## 10. Quick reference

```bash
# Pre-deploy
node scripts/run-tests.mjs && \
  node scripts/lint-imports.mjs && \
  npm run build && \
  node scripts/check-bundle-budget.mjs

# Deploy
git push origin main

# Post-deploy
node scripts/smoke-production-v2.mjs --quick
node scripts/health-check.mjs

# Rollback
# Vercel dashboard → Deployments → prior deploy → Promote to Production
```
