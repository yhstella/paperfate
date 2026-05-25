# Claude 메인 세션 — 2026-05-25 야간 작업 plan (지금 → 오전 9시)

> 사용자 지시: "코덱스에 밤새 시킬 일 + 너도 밤새 작업 진행".
>
> 직전 commit `fccecc2` (Codex Round 5 deliverables) push 완료.
> Vercel deploy 진행 중 — v0.4-timeline 라이브 review_timeline_days 곧 활성화.

작업 분할 원칙:
- **코덱스**: 모델 학습 + 데이터 batch + DB ETL (Round 6 doc 별도, `CODEX_TASKS_2026-05-25_ROUND6.md`).
- **메인 (Claude)**: frontend / API / integration / UX / 메모리 / smoke.

---

## 작업 순서 (총 ~5h 분량)

### A. v0.4-timeline production smoke + verify (10min)

직후 deploy 끝나면:
```
node scripts/smoke-production.mjs
```
기대: `predictions.review_timeline_days.point` 가 response에 등장. ResultPanel "Expected review timeline" 카드가 model 값으로 보이는지.

검증 실패 시:
- weights/fatecore-v0.4-timeline-*가 deploy bundle에 들어갔는지 (.vercelignore 안 잡혔는지)
- 환경변수 `FATECORE_TIMELINE_VERSION` 같은 게 production 누락인지

### B. Target-journal prior-JIF lookup endpoint (1h)

코덱스 Round 5 Task 2 권고: "target-aware UI는 fact-based prior lookup으로". 즉 사용자가 target journal 입력하면 `journals-shortlist` 또는 `journal_year_metrics` (deploy에 없음) 에서 직접 prior-year JIF 보여주기.

#### Deliverable

- `api/journal-info.js` 신규 GET endpoint: `?issn=` 또는 `?name=` → `{ issn, name, jif, jif_5yr, tier, category, publisher, prior_year_jif: jif (이미 1년 전 기준), historical_jif_series: [{year, jif}, ...] }`.
- journals-shortlist에는 시계열이 없으므로 v1은 `jif` (latest) + `jif_5yr` 그대로 반환.
- ResultPanel: target_journal 입력 textbox 추가 (UI), submit 시 journal-info fetch → "If you submit to NEJM, prior-year IF was 176.1; expected JIF for your manuscript: 1.61 (from v0.2-prod)." 같은 fact-based 카드.

#### vercel.json
- `"api/journal-info.js": { "maxDuration": 10 }` 추가.

### C. Methods / How-it-works 페이지 (1h)

SEO + 신뢰도. 사용자 "사이트 신뢰도 표현 원칙" [[feedback_site_trust_voice]] 참조:
- 개인 메일 노출 금지
- 약점 통계 피하기
- "Free/No account/beta" SaaS 카피 회피 [[feedback_research_tool_voice]]

#### Section 구성

- **What PaperFate forecasts**: 6 targets + journey + similar papers
- **How the model was trained**: 3.5M PubMed papers, FateCore v0.2-prod (R² 0.43 honest pre-pub), LightGBM + conformal prediction
- **What's pre-submission only**: 학습 시 post-publication features 제외 명시 (사용자가 가장 자주 받을 질문)
- **Limitations**: "no review acceptance/rejection labels — using prior-year journal IF and citation distributions"

#### File

- `src/components/Methods.jsx`
- `src/App.jsx`에 라우팅 또는 anchor 섹션 추가

### D. ResultPanel timeline 카드 polish (30min)

현재 timeline 카드:
```
{timeline.weeks} weeks to decision
{timeline.note}
```
`note`가 "Learned v0.4 estimate; point X weeks from received to accepted" — 그러나 사용자에게 잘 안 보임. v0.4 estimate 강조.

- 카드 우측 상단에 작은 badge "model v0.4" (vs heuristic "v0.1")
- CI low/high range 명시

### E. References cold-start UI (코덱스 작업 2가 끝나면) (30min)

코덱스 Task 2가 끝나면 (api/forecast.js의 references field 받음), 메인은 UI hook:
- Simulator에 textarea 추가 ("Optionally paste your reference DOIs, one per line")
- Submit 시 references parse → forecast body에 추가

코덱스가 안 끝났으면 skip.

### F. 메모리 업데이트 (15min)

- [[project_paperfate]] — v0.4-timeline + v0.3-pub HOLD 확정 추가
- [[project_paperfate_timeline]] — Phase 4 진행 상태 갱신
- 코덱스 Round 5/6 reference 추가

### G. 7 forecasts 7번째 슬롯 디자인 (1h, defer)

현재 6 forecast cards. 7번째는 무엇? 후보:
- **retraction risk** — PubMed retraction notice 데이터 부재, defer.
- **OA conversion likelihood** — 데이터 있음 (unpaywall_is_oa).
- **NIH/funder match** — `j_hist_*` 와 paper의 NIH 의존도.
- **Preprint advantage** — preprint 있으면 citations 영향.

가장 ROI: **OA conversion likelihood** — 사용자가 target journal 결정 시 도움. 다음 round 학습.

코드만 design doc — `docs/SEVENTH_FORECAST_DESIGN.md`.

### H. Cleanup / 코덱스 결과 received 후 정리 (15min)

코덱스가 만들 새 files:
- `paper_scores` 새 rows (Q500-fulltext batch)
- `scripts/build-reference-cold-start-features.mjs`
- `weights/journals-shortlist-v2.json` (가능)
- `docs/CODEX_HANDOFF_2026-05-25_ROUND6_TASK*.md` ≤ 3개

오전 9시 사용자 깨어날 때 git status가 깨끗하게 정리되어야. 메인 세션이 review 후 commit.

---

## Production deploy 모니터

- Vercel deploy 완료까지 1-2분.
- 모든 commit 후 smoke 자동 가동 권고.

## 실패 시 fallback

- v0.4-timeline 라이브 안 되면 자동 fallback to `timelineFromTier()` 휴리스틱 — Simulator 이미 처리.
- production smoke FAIL면 git revert HEAD + push (이전 직전 working commit `368c37c`로).

## EPMC fulltext 상태

- 5.5/s 진행 중, 7시간 = 약 140K 더 회수 예상.
- Auto-ingest watcher (PID 61872 또는 후속) 1시간 간격 폴링.
- 오전 9시까지 EPMC 누적 약 300K+ 확보 가능.

---

## 마무리 보고 (오전 9시 사용자에게)

- Codex Round 6 결과 요약
- 메인 세션 push 목록 (오늘 commit 추가분)
- production smoke pass/fail
- EPMC fulltext 누적
- 다음 phase 의사결정 필요 사항
