# PaperFate — Roadmap

> What we are building, what we are not, and the order we expect to build it in.
> This roadmap is intentionally honest: items are tagged with a real status,
> not a wishlist colour. If something is hard, slow, or uncertain we say so.
>
> Korean version: [ROADMAP_KO.md](./ROADMAP_KO.md)
>
> Last updated: 2026-05-30. Roadmap horizons reflect quarters of the calendar
> year — Q3 = Jul-Sep 2026, Q4 = Oct-Dec 2026, mid-term = first half of 2027,
> long-term = second half of 2027 and beyond.

---

## Legend

| Tag | Meaning |
|---|---|
| `[done]` | Shipped to `main` and reachable from production. |
| `[in progress]` | Code is being written this sprint; partially merged. |
| `[next]` | Scheduled for the named quarter; design is settled, no code yet. |
| `[exploring]` | We think it matters but the approach is not decided. |
| `[not planned]` | Out of scope by design. We will not build this. |

Round references (`Round 7`, `Round 6.5`, …) point to the corresponding
`docs/CODEX_TASKS_*.md` and `docs/CODEX_HANDOFF_*.md` files. They are the
authoritative spec for that sprint's deliverable.

---

## Where we are today (2026-Q2 exit state)

- v0.3 FateCore model is live in production. v0.4-timeline is evaluated;
  v0.5 (Round 7 outputs) is training/evaluating.
- Rule-based Q-rubric scoring is active. LLM Q-rubric scoring (Gemini) is
  fully implemented but currently **blocked by a single Vercel-side
  `GEMINI_API_KEY` issue** (see [SESSION_HANDOFF_2026-05-29.md](./SESSION_HANDOFF_2026-05-29.md)).
- 459K-paper EPMC fulltext ingest is ~59% complete and continuing.
- Q500 / 50-paper / 1K-paper evaluation harnesses exist and run on demand.
- Theme switcher, RSS changelog feed, CSV history export, audit-log read
  endpoint, pre-push gate, and Codex digest are all shipped.

This is the baseline the rest of the roadmap builds on.

---

## Q3 2026 — Unblock production LLM + ship v0.5

Goal: turn the corpus and model work we have already done into a measurable
quality bump that an end user can feel.

- **Production LLM Q-rubric scoring fully active.** `[in progress]`
  Implementation is done (`api/forecast.js`, `src/server/geminiClient.js`,
  paid-tier opts wired). The blocker is a single Vercel environment key
  swap — see SESSION_HANDOFF_2026-05-29 §2. Once unblocked, the same
  smoke-production harness already in `scripts/smoke-production.mjs`
  becomes the regression gate.
- **v0.5 FateCore model deployment.** `[in progress]`
  Round 7 (`CODEX_TASKS_2026-05-28_ROUND7.md`) is producing the v0.5
  feature set + retrained weights. Deployment criterion: v0.5 must beat
  v0.4-timeline on the held-out random split (R² and MAE on log-JIF) by
  a margin that exceeds the seed-to-seed noise observed in
  `EVAL_v0.5.md`. We will not ship a "looks better" model.
- **50-paper regression baseline.** `[next]`
  A fixed 50-paper set with known ground-truth outcomes (target journal,
  realised JIF, time-to-acceptance where available) becomes the
  every-deploy regression suite. Goal: catch behavioural drift that
  aggregate R²/MAE hides — e.g. a single tier collapsing.
- **Q500 LLM rescoring at scale.** `[in progress]`
  Round 7 Task 1 (`_q500_fulltext_round7.jsonl`) is in dry-run; paid
  live run follows after the Vercel key is fixed. Quality gate:
  Δ q_mean (top-tier minus mid-tier) ≥ 0.7 before any 50K-paper batch
  is greenlit.

---

## Q4 2026 — Author network + corpus expansion + live UI

Goal: extend FateCore beyond manuscript-internal signals, and let users
watch a forecast happen in real time instead of staring at a spinner.

- **Author network features into v0.5+.** `[next]`
  Co-authorship graph, career-stage proxies, and prior-venue distribution
  per author become first-class FateCore inputs. Honest constraints:
  these features are noisy for early-career authors and we will not
  let them dominate the score for first-time submitters. Deliverable is
  a v0.5.x or v0.6 model with author-network features as an ablation
  arm, scored on the same 50-paper baseline.
- **Bibliography pre-pub signals expansion.** `[next]`
  Extend `paper_extras_v2` to a wider corpus (target: full ingested
  EPMC fulltext corpus, not just the seed). The pre-pub features
  (citation-position salience, reference recency profile, methods-section
  vocabulary) need a broader fit set before they can carry weight in the
  model without risk of the v0.3-style post-pub leakage we already
  caught and documented in `V0.3_LEAKAGE_POSTMORTEM.md`.
- **Real-time SSE updates UI.** `[next]`
  The forecast pipeline is currently request/response — the user sees
  nothing for 10-60 seconds, then gets the whole result. Move to a
  server-sent-events stream so each stage (extract → rule score →
  LLM score → model → journey) updates the UI as it completes.
  Concretely a new `/api/forecast-stream` endpoint plus a streaming
  ForecastPanel component. The pre-push gate guarantees no regression
  in the synchronous endpoint while this lands.

---

## Mid-term (H1 2027) — From single-shot tool to a workspace

Goal: give a returning user a reason to come back, without turning into
a manuscript-management platform we cannot maintain.

- **Multi-user accounts.** `[exploring]`
  Today the app is stateless from the user's point of view; history lives
  in their browser only (the CSV export shipped this sprint is the
  workaround). A lightweight account — email magic link, no password —
  would let a user keep their forecasts across devices and over time.
  Open question: do we host this ourselves or stand it up on Supabase /
  Clerk / similar? Decision required before code.
- **Journal recommendation refinement.** `[in progress]`
  The current journey is a 5-step ladder anchored on predicted JIF. The
  next iteration takes into account scope fit (topic distance to the
  journal's recent corpus), acceptance-rate priors where available, and
  switch-cost (how much the manuscript has to change to fit). The
  switch-cost matrix is Task #61 in the open list — pending real cost
  data, not synthetic placeholders.
- **OpenReview integration.** `[exploring]`
  OpenReview hosts public peer review for a subset of venues. Ingesting
  it would let FateCore learn from review *outcomes*, not just
  acceptance — but coverage is uneven and biased toward ML venues.
  Useful as a sanity check; we are not betting the model on it.
- **Manuscript change history tracking.** `[exploring]`
  Save successive drafts of the same manuscript and surface how the
  forecast moved. The harder design question is what counts as "the
  same manuscript" — title hash is too brittle, content hash is too
  strict. A user-confirmed thread ID is the likely answer.

---

## Long-term (H2 2027+) — Decision support, not replacement

Goal: extend the forecast into the parts of the submission decision that
authors actually agonise over — *will reviewers like it*, *which journal
fits*, *should I submit at all* — while keeping the tool firmly on the
"support" side of the line.

- **Peer review prediction.** `[exploring]`
  Estimate the probability and severity of major revision / reject
  outcomes at a given venue, conditioned on the manuscript. Trained on
  the OpenReview corpus plus any retrospective venue-decision data we
  can legitimately obtain. The output we will ship is a probability and
  a confidence band — never a binary "will be rejected" verdict.
- **Journal-fit ranking with reviewer-style critique.** `[exploring]`
  For the top few candidate venues from the journey, produce a short,
  honest critique in the voice of a methods-focused reviewer at that
  venue. The critique must cite the specific rubric domain it is
  worried about (statistics, novelty, reporting), not freelance vague
  doubt.
- **Publication-decision support tool.** `[exploring]`
  The integration of all the above into a single decision view: forecast
  + journey + critique + change-history trend. Explicitly framed as
  *support* for the author and their co-authors, not a green-light /
  red-light gate. The submission decision belongs to the humans.

---

## Not planned

We are saying these out loud because they are obvious adjacencies and we
want it on record that we will not build them.

- **Automated submission.** `[not planned]`
  PaperFate will not press "submit" on a journal portal on the user's
  behalf. The submission step is where the author asserts authorship,
  conflicts of interest, and data-availability commitments. Those are
  not the kind of declaration a forecasting tool should be making by
  proxy.
- **Ghostwriting.** `[not planned]`
  PaperFate will not draft manuscript text, rewrite paragraphs, or
  "improve" the abstract. The whole product hinges on the forecast
  reflecting what the author actually wrote. A ghostwriting feature
  would silently turn the score into a forecast of *Gemini's* writing,
  not the author's. Out of scope, permanently.
- **Full review evaluation.** `[not planned]`
  We will not score a finished peer review and tell the editor whether
  to act on it. Peer-review evaluation is a different product with
  different stakeholders (editors, not authors) and a different ethical
  surface. If we ever build review-side tooling it will be a separate
  product, not a PaperFate feature.

---

## Honest caveats on this roadmap

- Quarter boundaries are aspirational. Q3 is gated on a single
  user-side Vercel action; if that drags, every downstream Q3 item
  drags with it.
- "Beats v0.4-timeline" is the only acceptance criterion for v0.5
  going to production. If v0.5 underperforms on the random-split
  validation set, it does not ship — see `feedback_fatecore_validation`
  for why we will not switch validation strategies to make a model
  look better.
- Items in `[exploring]` may move to `[not planned]` once we look at
  them seriously. That is the point of the tag.
