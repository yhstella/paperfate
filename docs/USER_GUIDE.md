# PaperFate user guide

> A pre-submission forecast for clinical and biomedical manuscripts.
> This guide covers what PaperFate does today, how to use it, and how to
> read its output honestly — including the cases where you should not
> trust the number.

---

## 1. What PaperFate does

PaperFate reads your draft manuscript (title + abstract at minimum,
optionally methods/results/discussion, authors, references and a target
journal) and returns a forecast: an estimated Journal Impact Factor for
the venue you are likely to land in, a confidence interval, a five-step
"journey" of plausible target journals, and a domain-by-domain rubric
breakdown of strengths and weaknesses.

It is a decision-support tool, not a verdict. The forecast is meant to
sit alongside your own judgement and your co-authors' read, not replace
either.

---

## 2. Entering a manuscript

Open the **Simulator** section on the home page.

### Minimum inputs

You need two things:

- **Title** — at least 9 characters.
- **Abstract** — at least 200 characters when on the *Abstract* tab,
  or at least 1,000 characters of full text when on the *Full text* tab.

That alone is enough to run a forecast. The server will auto-detect
study type, field, and the article-type rubric to apply.

### Helpful but optional inputs

These do not change whether a forecast runs — they sharpen it.

- **Field** and **Study type** — leave on *Auto-detect* unless the
  abstract is ambiguous and you want to force a specific rubric.
- **Target tier** — leave on *Auto-recommend* unless you have a
  specific impact-factor band in mind.
- **Authors** — paste the byline as written on the title page. PaperFate
  resolves each name against OpenAlex and rolls h-indexes into the
  author-features vector. Up to 25 names per run.
- **References** — paste DOIs, one per line or comma-separated. PaperFate
  resolves them against OpenAlex (up to 50 per run), joins each venue
  to a Journal Impact Factor, and surfaces the bibliography's mean/median
  JIF, top journals, and median publication year. This helps anchor the
  estimate when the abstract is thin.
- **Target journal** — typing a journal name pulls in its JIF, OA status,
  APC, h-index and quartile, and the result panel will show how your
  estimate compares to it.

### Sample manuscripts

The Simulator ships with four sample drafts (RCT, meta-analysis, cohort,
AI/imaging). Click one to populate the form and feel the UI before
pasting your own work.

### Keyboard

- **Ctrl/Cmd + Enter** from any text field submits the form.

### Two run modes

- **Abstract mode** runs a Q500 forecast on the title + abstract.
- **Full text** mode lets you paste structured sections (Methods,
  Results, Discussion) or a single long body. Adds more rubric items
  that need the actual writing to score (e.g. methodological detail
  beyond what an abstract can carry).

If you supply a full-text body but it is short (<1,500 characters of
methods + results + discussion + full text combined), PaperFate
automatically falls back to a Q100 short-body path. The result will say
`auto_decision: Q100_short_body`.

---

## 3. Reading the result panel

When the forecast completes the result panel scrolls into view. From
top to bottom:

### Forecast for "…"
The title you submitted (truncated to 90 chars on screen). A small
inputs strip shows how many authors were detected, how many reference
DOIs were resolved, and which mode (Q100 / Q500) was used.

If you supplied 5 author names but OpenAlex resolved zero of them, an
amber chip will warn you that the names may be malformed (e.g. last name
first without a comma) — fix and re-run for a sharper h-index rollup.

### ScoreDial
An overall rubric score 0–5 derived from the rolled-up Q-rubric domain
averages.

### Expected journal tier
Three cards:

- **Expected JIF (point estimate)** with the **90% confidence interval**
  below it. If you supplied a target journal whose JIF is anchoring the
  estimate, you will see an *Adjusted* badge with a small delta showing
  how much the anchor moved the raw model.
- **Desk-reject risk** — a probability, not a verdict.
- **Review timeline** — a median number of days from submission to
  first decision (model estimate, wide intervals on smaller venues).

### Journey
Five ordered, plausible submission targets, from your reach down to a
realistic backup. Each row shows the journal name, tier, JIF, and a
short rationale. This is the most-used part of the panel — use it as a
seed list, not a ranking to follow blindly.

### Adjusted JIF blend
When a target journal is supplied, the panel shows the **raw** model
estimate alongside the **target-anchored adjusted** estimate. The blend
weights raw and anchor based on confidence and how far apart they are.
Useful for spotting when your reach journal is far above what the model
sees in the draft.

### Domain rollup
Q-rubric domains (Novelty, Design, Statistics, Reporting, Writing, etc.)
each scored 0–5 with the weakest items called out. Click into a domain
to see which specific rubric items dragged it down.

### Key weaknesses + suggestions
The strongest signal in the panel. Each item shows the rubric question
that scored low, the model's reasoning, and a concrete suggestion that
would lift the score. The joint counterfactual at the bottom estimates
the lift if you address several of them at once.

> Suggestions are hidden when the run was a deterministic fallback —
> rule-only scoring is not reliable enough to issue per-item rewrite
> advice.

### Similar papers
Up to 5 published papers retrieved from OpenAlex via title + abstract
search. Useful sanity check: if your draft is methodologically close to
papers published in NEJM, the journey should reflect that; if it is
close to papers in regional society journals, the journey should
reflect *that*.

### References summary
When you supplied DOIs, the panel shows resolved count, mean and median
bibliography JIF, top venues, top categories, and median year. A thin or
outdated bibliography is one of the more reliable headwinds against
top-tier acceptance, and this card surfaces it explicitly.

---

## 4. The amber "degraded mode" banner

If the result panel opens with an amber banner at the top —

> *LLM scoring unavailable right now — showing rule-only forecast.
> Q-rubric domain breakdowns are degraded; please retry shortly.*

— it means the LLM scoring layer failed (Gemini outage, expired key,
rate-limit cliff, etc.) and the server returned a deterministic
rule-based fallback instead.

### What's still trustworthy

- The **journey** and **similar papers**: these are independent of LLM
  scoring.
- The **references summary** and **author features**: pure OpenAlex
  joins.
- A coarse **tier** signal (Q1 / Q2 / Q3 / Q4): the rule pre-pass is
  noisy but not zero-information.

### What you should not trust

- The per-item rubric scores. Many will be heuristic guesses.
- The point estimate of JIF. The confidence is capped at ≤0.30 for a
  reason — treat it as "wide range" rather than "this number".
- Per-item rewrite suggestions. These are hidden in degraded mode.

### What to do

Retry in a few minutes. Most degraded responses are transient — a
provider hiccup or a brief rate-limit window. Check the public **Status**
page (linked from the footer) to see whether the full path is healthy
before re-running.

---

## 5. Compare venues

The **Compare** tab takes up to 5 journal names or ISSNs and pulls a
side-by-side table: name, publisher, JIF, JCR quartile, OA status, APC
(USD), h-index, scope. It is a single API call (`/api/journal-compare`)
so it is fast even on flaky connections.

Use it when:

- You already have a shortlist and want the boring facts in one place.
- You are deciding between an OA venue and a subscription venue at
  similar tier and need to see the APC.
- You want to compare a top-tier reach with a Q2 realistic target on the
  same screen before you start the cover letter.

Drafts are kept in localStorage for 10 minutes, so a half-typed
shortlist survives a tab refresh.

---

## 6. Quick rubric check

The **Quick rubric check** button on the Simulator runs a
fast-and-cheap title + abstract scoring pass against `/api/abstract-quality`.
It returns the rubric rollup only — no journey, no similar papers, no
journal anchoring.

Use it when:

- You are still iterating on the abstract and just want to know whether
  the rewrite raised or lowered the domain scores.
- You do not want to spend a full Q500 run while the draft is still
  changing every five minutes.
- You want the fastest path to "does this even read like a Q1 abstract".

Typical latency is 12–20 seconds vs. ~110 seconds for a full Q500.

---

## 7. Forecast history and draft persistence

Both are local-only. Nothing in this section ever leaves your browser.

### Draft persistence

While you are typing in the Simulator, your inputs are debounced and
saved to `localStorage` under `paperfate.simulator.draft`. If you reload
the tab within 5 minutes, the form rehydrates and a brief "draft
restored" note shows you the relative time.

Compare-tab inputs persist under `paperfate.compare.draft` for 10
minutes. There is a **Clear draft** control on each form.

If your browser is in private mode, or storage quota is exhausted, the
save silently no-ops — you simply lose the in-flight draft on reload.

### Forecast history

After every successful Q500 run, a compact record is stored in
`localStorage` under `paperfate.forecast.history` — up to 20 most-recent
entries. Each record holds the title, the first 100 chars of the
abstract, the headline numbers, and a UUID.

The full abstract and full results are **not** persisted server-side.
This history is browser-scoped: switch browsers and it is gone. There is
no "shared link" that actually replays a forecast on another machine
today — sharing a URL only opens the receiving tab's local store.

---

## 8. Locale switcher (KO / EN)

The top-right of the header has a **KO / EN** toggle. It switches the UI
strings (nav, simulator, result panel, degraded banner, compare tab)
between Korean and English. The forecast itself is locale-independent —
the LLM reads English manuscript text either way.

The selection persists across reloads (same browser).

---

## 9. Privacy

### What's sent to the server

- The manuscript text you submit: title, abstract, and any optional
  sections (methods/results/discussion/full text), authors, references
  DOIs, target journal. This text is sent to the LLM scoring layer
  (Google Gemini at present) for rubric scoring, and to OpenAlex for
  author and reference resolution. It is processed and discarded; no
  long-term storage of manuscript content is performed by PaperFate.
- A small **request ID** (UUID) per forecast for log correlation.
- Anonymous **telemetry beacons** (event name + a few non-identifying
  props, e.g. `result_render`, `degraded: true`, `has_journey: true`).
  No manuscript text is ever attached. Payloads are capped at 1 KB.
  Beacons go to `/api/_telemetry` and are dumped to platform logs only.
- The **Status page** sends a synthetic probe payload, never your
  manuscript.

### What is NOT sent to the server

- Your local **drafts** (Simulator and Compare). They live only in your
  browser's `localStorage`.
- Your local **forecast history**. Same.
- Your **locale** choice. Same.
- Any analytics SDK third-party data — there isn't one.

### Opt-out

The client telemetry is intentionally minimal. If you want to block it
entirely, any standard tracker blocker (uBlock, Brave shields, Firefox
strict mode, corporate DNS filter) can drop the `/api/_telemetry`
endpoint — the app keeps functioning normally. The forecast endpoints
themselves do not run telemetry.

---

## 10. Known limitations

Read these once before you build any conclusions on PaperFate output.

- **Rule-only fallback is exactly that.** When the LLM scoring path
  fails, the server returns a deterministic rule-based forecast with
  `confidence ≤ 0.30`. The numbers are still surfaced so the journey
  and similar-paper cards are usable, but per-item rubric scores are
  not reliable. The amber banner is the signal.
- **LLM scoring depends on an upstream API.** A Gemini outage or an
  expired key will drop you into the degraded fallback. The
  `llm_health` field in the API response (and the public `/api/status`
  page) tells you the current state.
- **JIF is a model estimate, not an oracle.** Even at full confidence
  the 90% CI is wide on purpose. The "Expected JIF" is anchored to
  recent Clarivate JIFs of similar venues, and venues move year-to-year
  for reasons no model in 2026 fully captures.
- **Author h-index resolution is best-effort.** OpenAlex matches the
  top search result for each name; ambiguous names (common surnames,
  Romanised CJK names) can collide. If the inputs strip shows zero
  authors matched, the rollup is noise.
- **References are capped at 50 DOIs per run** and authors at 25 per
  run. The full bibliography of a long paper will be truncated.
- **The journey is suggestive, not exhaustive.** It surfaces five
  realistic targets — not every viable venue for your draft.
- **PaperFate does not predict reviewer behaviour at a specific
  journal.** Desk-reject risk is a model-level prior. Editor and
  reviewer noise is not in the loop.

---

## 11. FAQs

**Q. Is my manuscript stored?**
No. The text is sent to the LLM scoring layer (Gemini) for scoring and
to OpenAlex for author/reference resolution, then discarded. We keep
only a request ID and aggregated, non-identifying telemetry.

**Q. Why did my forecast come back with an amber banner the second time
but not the first?**
The LLM provider had a transient failure between runs. Retry — most
degraded responses resolve within a few minutes.

**Q. Why does the model show a different JIF for the same abstract on
two runs?**
LLM scoring has non-zero variance even at temperature 0 because of
provider-side sampling and tie-breaking. The confidence interval is
where the more honest number lives — a 1–2 JIF shift between identical
runs is expected.

**Q. Should I follow the journey list as my submission order?**
Treat it as a strong shortlist and then apply your own judgement —
editorial fit, scope drift, prior rejections, OA mandate, deadline
pressure all matter and PaperFate cannot see them.

**Q. The desk-reject risk for the top-tier choice in my journey is 55%.
Is that bad?**
For NEJM-tier journals, 55% is roughly what a strong paper sees. A 90%
desk-reject risk is the meaningful warning signal. Use it as one input.

**Q. Can I run PaperFate without an internet connection?**
No. Forecasts and journal lookups all require the deployed API. The PWA
shell will cache the UI for an offline page-load attempt, but submitting
the form requires the server.

**Q. What is the difference between Quick rubric check and a full
forecast?**
Quick rubric check is title + abstract only, 12–20s, returns rubric
scores. Full forecast adds journey, similar papers, references summary,
author features, target journal anchoring, suggestions, and a JIF
estimate with CI. Use Quick while you are still rewriting the abstract;
run the full forecast when the draft is close to final.

**Q. Does PaperFate work for non-clinical manuscripts?**
The model is trained on biomedical content. Adjacent fields (public
health, basic/translational, AI/imaging in medicine) work; manuscripts
from outside life sciences will run but the rubric is not tuned for
them.

**Q. Is there a Korean-language scoring pass?**
No. The UI is bilingual; the rubric scoring runs on the English text
the LLM sees. Submit your manuscript in the language you intend to
publish it in.

**Q. What's a "request_id" and when do I need it?**
Every forecast carries a UUID returned in the response. If you hit a
support thread or contact us about a specific run, that UUID lets us
correlate to platform logs. It does not contain any of your manuscript.
