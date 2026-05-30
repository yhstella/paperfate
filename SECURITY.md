# Security Policy

PaperFate is a pre-submission manuscript forecasting tool. We take
security seriously — manuscript text is sensitive intellectual
property and we want to protect it.

## Reporting a vulnerability

If you believe you have found a security issue in PaperFate:

1. **Open a GitHub issue and tag it `security`.** Include enough
   detail to reproduce.
2. **If the issue is sensitive** (a working exploit, an
   authentication-bypass write-up, or anything you would not want
   indexed publicly), email it instead of filing an issue. Use the
   address listed in the repository owner's GitHub profile.
   *(Placeholder: a dedicated `security@paperfate.com` mailbox is
   not yet provisioned. Until it is, the maintainer's profile
   address is the canonical channel.)*
3. Please give us a reasonable window to confirm and patch before
   public disclosure. We aim to acknowledge within 72 hours.

Bounties are not offered at this time.

## Threat model summary

PaperFate has a deliberately small attack surface. The components
and their trust boundaries:

### Client — React SPA

- Pure browser-side Vite + React bundle served from
  `https://paperfate.com`.
- No user accounts, no login, no cookie-based session.
- Forecast history is stored in `localStorage` only. There is no
  per-user server-side record.
- The bundle ships **no third-party analytics scripts**, no
  Sentry, no Google Tag Manager, no Mixpanel. Telemetry is a
  single fire-and-forget POST to our own
  `/api/telemetry-beacon` sink.

### Server — Vercel serverless

- Eleven stateless Node functions under `api/*.js`. Each function
  owns its own bundle (no shared backend process).
- **No authentication.** The API is intentionally public so a
  bookmarklet/CLI can hit it. Internal-only callers carry
  `x-paperfate-internal: $PAPERFATE_INTERNAL_TOKEN` to bypass the
  per-IP rate limiter; the token confers no other privileges.
- **No persistent user storage.** Forecasts are not stored
  server-side. Manuscript text is sent to the Gemini LLM during
  Q500 extraction and is **not** retained by PaperFate beyond the
  request lifecycle. See Google's Gemini API data policy for what
  happens on their side.
- **No database is exposed to the public API.** `paperfate.db`
  (SQLite, ~hundreds of GB of training data) is **local-only** —
  it lives at `E:\paperfate\data\paperfate.db` on the maintainer's
  machine and never deploys with the Vercel build. The deployed
  API reads from prebuilt artifacts in `weights/` (LightGBM
  models + the 800-journal shortlist JSON).

### Rate limiting

- Each `api/*.js` handler runs an **in-memory token-bucket** rate
  limiter, sized per endpoint (30/hour for `/api/forecast`,
  60/hour for `/api/abstract-quality`, etc).
- Because Vercel serverless is stateless across cold starts, the
  bucket is **per warm instance**, not global. This is sufficient
  to stop runaway loops from a single client hammering one warm
  function. It does **not** stop a determined distributed attack;
  Vercel's platform-level DDoS protection handles that layer.
- A request carrying the internal-token header bypasses the bucket.

### Manuscript text handling

- Manuscript text sent to `/api/forecast` is forwarded to the
  Gemini LLM (paid tier) for Q500 rubric extraction. It is held in
  memory for the duration of the request and is **not** logged or
  persisted by PaperFate.
- If Gemini is unreachable or the API key is invalid, the
  deterministic rule pre-pass (`src/server/deterministicExtract.js`)
  runs instead. This path never leaves the Vercel function — no
  outbound LLM call is made.
- Other endpoints (`/api/similar`, `/api/journal-info`,
  `/api/journals-search`, `/api/journal-compare`,
  `/api/references`, `/api/author-features`) do not touch the LLM.
  They hit either the bundled journal shortlist or the OpenAlex
  REST API directly.

### Secrets

- `GEMINI_API_KEY` and `PAPERFATE_INTERNAL_TOKEN` live in Vercel
  project env vars. They are never echoed in responses, logs, or
  error messages.
- The repository contains **no** committed `.env` files.
  `.gitignore` covers the standard patterns.

## Browser-side security stack

The Round 6 `vercel.json` ships the following response headers on
every route (`/(.*)`) and again on `/api/(.*)`:

- **`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`**
  — HSTS with a 2-year window and HSTS-preload eligibility.
- **`Content-Security-Policy`** —
  `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.openalex.org https://*.vercel.app; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
  We allow inline scripts/styles because Vite emits them; we
  whitelist OpenAlex and Vercel preview hosts on `connect-src`.
- **`X-Frame-Options: DENY`** — no iframe embedding.
- **`X-Content-Type-Options: nosniff`** — no MIME sniffing.
- **`Referrer-Policy: strict-origin-when-cross-origin`** — same-
  origin paths see the full URL, cross-origin sees the origin only.
- **`Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()`**
  — disable all four sensor / payment surfaces.

## Known limitations

- **In-memory rate limit.** As described above, the bucket is per
  warm instance, not global. We rely on Vercel's edge layer for
  cross-instance abuse mitigation.
- **No request signing.** The public API does not verify HMAC
  signatures on incoming requests. Anyone can call it within the
  rate limit.
- **No CSRF tokens.** Because there is no authentication and no
  cookie-based session, CSRF is not in scope — there is no
  "logged-in user" to impersonate.
- **`paperfate.db` is local-only.** If a maintainer's laptop is
  compromised, the SQLite training corpus is exposed; however, all
  source rows in the DB are public OpenAlex / PubMed / EPMC / iCite
  / Crossref / Unpaywall data. No private content is in the DB.
- **Telemetry sink is best-effort.** `/api/telemetry-beacon`
  accepts any well-formed JSON and is rate-limited like the
  other endpoints. It does not authenticate the sender. Treat it
  as a log sink for trends, not a security-grade audit trail.

## Out of scope

The following are deliberately out of scope for PaperFate's
security posture:

- Account takeover (no accounts exist).
- Payment data (no payments are processed).
- Private user data exfiltration (none is stored).
- Cross-tenant isolation (single-tenant by design).

If you find something in scope above, please report it via the
channel in the first section.
