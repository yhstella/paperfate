# PaperFate API Reference

One-page reference for every public endpoint deployed at
`https://paperfate.com/api/*`. All endpoints run as Vercel Node serverless
functions (`runtime: 'nodejs'`).

## Conventions

- **Base URL** — `https://paperfate.com` in production; `http://localhost:5180`
  for local Vite dev (note: `npm run dev` does *not* run the API; use `vercel
  dev` or hit production from local).
- **CORS** — `Access-Control-Allow-Origin` is whitelisted via
  `PAPERFATE_ALLOWED_ORIGINS` (default
  `https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180`).
  Preflight `OPTIONS` returns `204` with `Vary: Origin`.
- **Content-Type** — `application/json` on both directions for POST endpoints.
- **Rate limiting** — no application-level limiter; Vercel platform limits
  apply. Cache headers are set per-endpoint where the response is stable
  (journal lookups: `s-maxage=86400, stale-while-revalidate=604800`).
- **Errors** — JSON `{ error, detail?, request_id? }`. Common shapes:
  `method_not_allowed (405)`, `invalid_json (400)`, `payload_too_large (413)`,
  `request_timeout (408)`.
- **Server version** — current forecast server is `0.4.0`; abstract-quality is
  `0.3.1`. Returned in the response body where applicable.
- **request_id** — every `/api/forecast` and `/api/abstract-quality` response
  carries a UUID for log correlation.

---

## POST /api/forecast

End-to-end Q500 manuscript scorer + FateCore inference + suggestion engine.

- **Method**: `POST`
- **URL**: `/api/forecast`
- **Latency budget**: up to 300 s (`maxDuration: 300`). Typical Q500 with paid
  Gemini tier: ~110 s. Q100 short-body path: ~15-25 s.
- **Body cap**: 256 KB (`MAX_BODY_BYTES`); stream read timeout 10 s.
- **CORS scope**: `POST, OPTIONS` against whitelisted origins.

### Request body

```jsonc
{
  "title": "string (≥5 chars, required)",
  "abstract": "string (≥200 chars, required)",
  "methods": "string?",            // capped at 8 000 chars
  "results": "string?",            // capped at 8 000 chars
  "discussion": "string?",         // capped at 8 000 chars
  "full_text": "string?",          // capped at 24 000 chars
  "authors": "string[] | string?",
  "year": "number?",
  "first_affiliation": "string?",
  "funder": "string?",
  "funding": "string?",
  "is_preprint": "boolean?",
  "author_features": {
    "first_author_h_index": "number?",
    "last_author_h_index": "number?",
    "max_team_h_index": "number?",
    "median_team_h_index": "number?",
    "team_size_with_id": "number?",
    "international_collab": "0|1?"
  },
  "article_type": "string? (default '*')",
  "mode": "'Q100' | 'Q500' | 'auto' (default 'auto')",
  "target_journal": "object?"
}
```

`mode: 'auto'` with `methods+results+discussion+full_text` total < 1 500 chars
forces `Q100` (response carries `auto_decision: 'Q100_short_body'`).

### Response (200)

```jsonc
{
  // From the extraction layer:
  "overall_score": 3.42,
  "domain_rollup": { "NOVEL": 3.1, "DESIGN": 3.8, /* ... */ },
  "key_weaknesses": [ /* item objects */ ],
  "items": [ /* per-question scores */ ],
  "items_attempted": 487,
  "items_scored": 487,
  "extractor_used": "llm" | "deterministic" | "rule_fallback",

  // Graceful-degradation telemetry (LLM path only):
  "llm_health": {
    "status": "ok" | "degraded",
    "failed": 0,
    "attempted": 487,
    "reason": "gemini_400_invalid_key" | "rate_limited" | "unknown"
  },
  "llm_errors": ["..."],                // ≤10 deduped error strings
  "extraction_fallback_reason": "llm_batch_failures",

  // FateCore inference + journey:
  "jif_point": 14.2,
  "jif_ci_low":  8.1,
  "jif_ci_high": 23.4,
  "tier": "Q1",
  "desk_reject_risk": 0.18,
  "review_days_point": 142,
  "citations_5yr_low": 12,
  "citations_5yr_high": 84,
  "confidence": 0.68,                   // ≤0.30 when extractor_used='rule_fallback'
  "journey": [ /* 5 ordered target steps */ ],

  // Suggestions:
  "counterfactual_suggestions": [ /* per-item lift suggestions */ ],
  "joint_counterfactual": { /* multi-item joint lift */ },

  // Meta:
  "auto_decision": "Q100_short_body" | null,
  "wall_ms": 24813,
  "server_version": "0.4.0",
  "request_id": "9f1c..."
}
```

### `rule_fallback` semantics

When more than 50% of LLM items fail (or zero items score), the handler
re-runs the deterministic rule pre-pass and returns it with:

- `extractor_used: "rule_fallback"`
- `extraction_fallback_reason: "llm_batch_failures"`
- `llm_health.status: "degraded"` with `reason` set
- `confidence ≤ 0.30` (UI caps the displayed confidence)

The client should surface a "degraded" banner (already wired in
`ResultPanel`).

### Errors

| Status | `error`                       | When |
|--------|-------------------------------|------|
| 400    | `missing_or_short_title`      | title missing or <5 chars |
| 400    | `missing_or_short_abstract`   | abstract missing or <200 chars |
| 400    | `invalid_json`                | body could not be parsed |
| 405    | `method_not_allowed`          | non-POST/OPTIONS |
| 408    | `request_timeout`             | body stream >10 s |
| 413    | `payload_too_large`           | body >256 KB |
| 500    | `extraction_failed`           | unexpected throw inside the pipeline |

All error bodies include `request_id`.

### Example

```bash
curl -X POST https://paperfate.com/api/forecast \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Empagliflozin and Cardiovascular Outcomes in T2D",
    "abstract": "We conducted a randomized double-blind trial of empagliflozin...",
    "mode": "Q100"
  }'
```

---

## POST /api/abstract-quality

Pure Q100 abstract-only rubric scorer. Forces `mode='Q100'`, strips
FateCore/journey/suggestions, returns only the rubric rollup.

- **Method**: `POST`
- **URL**: `/api/abstract-quality`
- **Latency budget**: 60 s (`maxDuration: 60`). Typical: ~12-20 s.
- **CORS scope**: `POST, OPTIONS`.

### Request body

```jsonc
{
  "title": "string (≥5 chars, required)",
  "abstract": "string (≥200 chars, required)",
  "article_type": "string? (default '*')"
}
```

### Response (200)

```jsonc
{
  "overall_score": 3.1,
  "domain_rollup": { /* ... */ },
  "key_weaknesses": [ /* ... */ ],
  "items": [ /* ~100 Q100 items */ ],
  "items_attempted": 100,
  "items_scored": 100,
  "elapsed_ms": 18342,
  "server_version": "0.3.1",
  "request_id": "..."
}
```

### Errors

| Status | `error`                       |
|--------|-------------------------------|
| 400    | `missing_or_short_title`      |
| 400    | `missing_or_short_abstract`   |
| 400    | `invalid_json`                |
| 405    | `method_not_allowed`          |
| 500    | `extraction_failed`           |

### Example

```bash
curl -X POST https://paperfate.com/api/abstract-quality \
  -H "Content-Type: application/json" \
  -d '{"title":"Empagliflozin in T2D","abstract":"We randomly assigned..."}'
```

---

## POST /api/similar

OpenAlex similar-paper retrieval with parallel title + abstract searches.
Returns up to 5 candidates with ISSN→JIF joins from the on-deploy 800-journal
shortlist.

- **Method**: `POST`
- **URL**: `/api/similar`
- **Latency budget**: 30 s (`maxDuration: 30`); deadline 22 s inside handler.
- **CORS scope**: `POST, OPTIONS`.

### Request body

```jsonc
{
  "title": "string (≥5 chars, required)",
  "abstract": "string (≥100 chars, required)"
}
```

### Response (200)

```jsonc
{
  "similars": [
    {
      "title": "...",
      "venue": "New England Journal of Medicine",
      "issn": "0028-4793",
      "if": 158.5,
      "jif": 158.5,
      "year": 2024,
      "citations": 412,
      "doi": "10.1056/nejmoa...",
      "openalex_id": "https://openalex.org/W...",
      "score": 41.3
    }
  ],
  "query_used": "Empagliflozin Cardiovascular T2D ..."
}
```

The handler fires two queries in parallel:

1. Title-only search ranked by `relevance_score:desc` (surfaces landmark
   papers above reviews citing them).
2. Abstract-text broad search.

Results are deduped by normalised title and the originating paper's title is
filtered out.

### Errors

| Status | `error`                         |
|--------|---------------------------------|
| 400    | `missing_or_short_title`        |
| 400    | `missing_or_short_abstract`     |
| 400    | `invalid_json`                  |
| 405    | `method_not_allowed`            |
| 502    | `openalex_search_failed`        |

---

## GET /api/journal-info

Single-journal lookup against the 800-journal shortlist. Used to anchor the
target-journal card without deploying the leak-prone v0.3-pub model.

- **Method**: `GET` (the task brief lists `POST/GET`; the live handler is
  GET-only — switch to POST has not landed)
- **URL**: `/api/journal-info?issn=...` or `?name=...`
- **Latency budget**: 10 s.
- **CORS scope**: `GET, OPTIONS`.
- **Cache**: `s-maxage=86400, stale-while-revalidate=604800`.

### Match priority

1. `?issn=` exact (hyphen-tolerant, case-insensitive).
2. `?name=` exact (lowercase compare).
3. `?name=` startsWith (sorted by JIF desc) — `match_score=700`.
4. `?name=` substring (≥6 chars, sorted by JIF desc) — `match_score=500`.

### Response (200)

```jsonc
{
  "journal": {
    "name": "New England Journal of Medicine",
    "issn": "0028-4793",
    "jif": 158.5,
    "jif_5yr": 121.7,
    "tier": "TOP",
    "category": "MEDICINE, GENERAL & INTERNAL",
    "quartile": "Q1",
    "publisher": "Massachusetts Medical Society",
    "country": "United States",
    "is_oa": false,
    "is_in_doaj": false,
    "apc": null,
    "h_index": 1224
  },
  "match_type": "exact" | "startsWith" | "substring",
  "match_score": 1000
}
```

### Errors

| Status | `error`                |
|--------|------------------------|
| 404    | `journal_not_found`    |
| 405    | `method_not_allowed`   |

### Example

```bash
curl 'https://paperfate.com/api/journal-info?issn=0028-4793'
curl 'https://paperfate.com/api/journal-info?name=Lancet'
```

---

## GET /api/journals-search

In-memory fuzzy autocomplete with tier blending. Returns up to 20 candidates.

- **Method**: `GET` (task brief lists POST/GET; live handler is GET-only.)
- **URL**: `/api/journals-search?q=<query>&limit=10&tier=Q1`
- **Latency budget**: 10 s.
- **CORS scope**: `GET, OPTIONS`.
- **Cache**: `s-maxage=86400, stale-while-revalidate=604800`.

### Query parameters

| Param   | Default | Notes |
|---------|---------|-------|
| `q`     | —       | required, ≥2 chars; empty returns `{ results: [] }` |
| `limit` | 10      | clamped to 1-20 |
| `tier`  | —       | optional uppercase filter (e.g. `Q1`, `TOP`); disables blending |

### Tier blending

When `tier` is not specified, the top 7 raw-score matches are kept and the
remaining slots (up to `limit`) are reserved for Q2/Q3 journals scoring above
the floor of the top 7 — so users see realistic mid-tier targets alongside
flagship matches. If the mid pool runs short, the remainder is filled by the
next-highest unseen by score.

Match scoring:

- ISSN exact: 1000
- Name exact: 900
- Name startsWith: 700
- Name substring: 500
- Category substring: 100
- Tie-break: `+min(199, round(JIF*10)/10)`

### Response (200)

```jsonc
{
  "results": [
    {
      "name": "Lancet, The",
      "issn": "0140-6736",
      "jif": 168.9,
      "tier": "TOP",
      "category": "MEDICINE, GENERAL & INTERNAL",
      "publisher": "Elsevier",
      "is_oa": false
    }
  ]
}
```

### Example

```bash
curl 'https://paperfate.com/api/journals-search?q=lancet&limit=5'
```

---

## POST /api/journal-compare

Resolve up to 5 target journals in a single request — side-by-side comparison
without firing N sequential `/journal-info` calls.

- **Method**: `POST`
- **URL**: `/api/journal-compare`
- **Latency budget**: 10 s.
- **CORS scope**: `POST, OPTIONS`.

### Request body

```jsonc
{
  "issns": ["0028-4793", "0140-6736"],
  "names": ["JAMA"]
}
```

`issns.length + names.length` is capped at 5. Resolution uses the same
priority as `/journal-info` (ISSN exact, then name exact, then name
substring sorted by JIF desc). Unresolved entries are silently dropped.

### Response (200)

```jsonc
{
  "journals": [
    { /* same shape as /journal-info `journal` object */ }
  ]
}
```

### Errors

| Status | `error`              |
|--------|----------------------|
| 400    | `no_targets`         |
| 400    | `too_many_targets`   |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

### Example

```bash
curl -X POST https://paperfate.com/api/journal-compare \
  -H "Content-Type: application/json" \
  -d '{"issns":["0028-4793","0140-6736"],"names":["JAMA"]}'
```

---

## POST /api/references

DOI batch resolve through OpenAlex with publisher sanity checks. Joins
ISSN-L → JIF from the shortlist and returns descriptive summary statistics of
the bibliography.

- **Method**: `POST`
- **URL**: `/api/references`
- **Latency budget**: 60 s. Parallel pool of 6 OpenAlex lookups; per-DOI
  request timeout 8 s with one retry on 429.
- **CORS scope**: `POST, OPTIONS`.

### Request body

```jsonc
{
  "dois": ["10.1056/nejmoa1504720", "10.1016/s0140-6736(15)..."]
}
```

`dois` is normalised (lowercase, `doi.org/` prefix stripped) and deduped.
Maximum 50 DOIs per request.

### Publisher sanity check

If a DOI prefix indicates a known publisher (NEJM, Lancet, JAMA, Nature,
Science) but OpenAlex returns a different venue, `venue/issn/jif` are nulled
and the reference is flagged `warning: 'doi_metadata_mismatch'`.
`n_venue_mismatch` is incremented.

### Response (200)

```jsonc
{
  "n_input": 12,
  "n_resolved": 11,
  "n_with_jif": 9,
  "n_not_found": 1,
  "n_lookup_errors": 0,
  "n_venue_mismatch": 0,
  "mean_jif": 28.4,
  "median_jif": 14.2,
  "top_journals": [
    { "name": "NEJM", "count": 3, "issn": "0028-4793", "jif": 158.5 }
  ],
  "top_categories": [
    { "category": "MEDICINE, GENERAL & INTERNAL", "count": 7 }
  ],
  "year_median": 2022,
  "year_min": 2015,
  "year_max": 2024,
  "references": [
    { "doi": "10.1056/...", "title": "...", "venue": "...", "issn": "...",
      "jif": 158.5, "category": "...", "year": 2015, "citations": 1234 },
    { "doi": "10.1234/missing", "_missing": true,
      "error_code": "404" | "timeout" | "network" | "http_500" }
  ]
}
```

### Errors

| Status | `error`              |
|--------|----------------------|
| 400    | `no_valid_dois`      |
| 400    | `too_many_dois`      |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

---

## POST /api/author-features

Resolves author h-indexes via OpenAlex `/authors?search=` (top result by
relevance) and rolls them up into the FateCore author-feature vector.

- **Method**: `POST`
- **URL**: `/api/author-features`
- **Latency budget**: 30 s. Parallel pool of 5; per-author timeout 8 s.
- **CORS scope**: `POST, OPTIONS`.

### Request body

```jsonc
{ "authors": ["Bernard Zinman", "Christoph Wanner", "..."] }
```

Names are trimmed/space-collapsed and deduped. Maximum 25 names per request.

### Response (200)

```jsonc
{
  "first_author_h_index": 78,
  "last_author_h_index":  null,        // null when single_author=true
  "single_author":        false,
  "max_team_h_index":     112,
  "median_team_h_index":  84,
  "team_size_with_id":    8,           // count with resolvable h_index
  "resolved": [
    { "name": "Bernard Zinman", "matched": "Bernard Zinman",
      "h_index": 78, "works_count": 412,
      "openalex_id": "https://openalex.org/A...",
      "institution": "University of Toronto" },
    { "name": "Unknown Author", "matched": null, "h_index": null }
  ]
}
```

`single_author=true` zeros out `last_author_h_index` because a single author
has no separate senior slot (Codex Round 7 spec).

### Errors

| Status | `error`              |
|--------|----------------------|
| 400    | `no_authors`         |
| 400    | `too_many_authors`   |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

---

## POST /api/telemetry-beacon (internal)

Minimal one-shot beacon sink. Events are dumped to Vercel logs prefixed with
`[telemetry]`. No DB, no analytics dependency.

- **Method**: `POST`
- **URL**: `/api/telemetry-beacon`
- **Latency budget**: 5 s.
- **CORS scope**: `POST, OPTIONS`.
- **Body cap**: 4 KB.
- **Usage**: paired with `src/lib/telemetry.js` `trackEvent()` (uses
  `navigator.sendBeacon` when available).

### Request body

```jsonc
{
  "name":       "string (≤64 chars, required)",
  "props":      { /* arbitrary serialisable */ },
  "ts":         1717000000000,
  "url":        "https://paperfate.com/simulator",
  "ua_summary": "Chrome 124"
}
```

### Responses

| Status | Body                  |
|--------|-----------------------|
| 204    | empty (accepted)      |
| 400    | `invalid_json` / `invalid_shape` |
| 405    | `method_not_allowed`  |
| 413    | `payload_too_large`   |

### Example

```bash
curl -X POST https://paperfate.com/api/telemetry-beacon \
  -H "Content-Type: application/json" \
  -d '{"name":"forecast_view","props":{"tier":"Q1"},"ts":1717000000000,"url":"https://paperfate.com/","ua_summary":"Chrome"}'
```

---

## Quick reference

| Endpoint                  | Method | Budget | Notes                          |
|---------------------------|--------|--------|--------------------------------|
| `/api/forecast`           | POST   | 300 s  | Q500 + FateCore + journey      |
| `/api/abstract-quality`   | POST   | 60 s   | Q100 rubric only               |
| `/api/similar`            | POST   | 30 s   | OpenAlex dual search           |
| `/api/journal-info`       | GET    | 10 s   | shortlist lookup, cached       |
| `/api/journals-search`    | GET    | 10 s   | autocomplete, tier blending    |
| `/api/journal-compare`    | POST   | 10 s   | ≤5 journals batched            |
| `/api/references`         | POST   | 60 s   | ≤50 DOIs, OpenAlex resolve     |
| `/api/author-features`    | POST   | 30 s   | ≤25 authors, h-index rollup    |
| `/api/telemetry-beacon`         | POST   | 5 s    | beacon sink (internal)         |
