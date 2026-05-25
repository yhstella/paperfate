# 코덱스 작업 — 2026-05-25 Round 6 (오전 2시 → 오전 9시, 7시간)

> Round 5 완료:
> - v0.4-timeline DEPLOY CANDIDATE (MAE 59.4d, R² 0.13). 이미 production wired + push (commit `fccecc2`).
> - v0.3-pub HOLD 확정 (j_hist_jcr_jif 셔플 시 R² 0.94 → -0.75). 학습 모델 path 폐기.

이번 라운드는 7시간 무인 작업. 다음 3개 task를 순서대로.

---

## 작업 1 (HIGHEST · 4h) — Q500 본문 채점 보강 batch

### 배경

현재 `paper_scores`는 904,938 unique DOI / 25.8% coverage. **거의 전부 abstract-only (mode='Q100' 또는 'Q500-rule')** — 본문 의존 항목은 채점이 약함.

지금 가용:
- `pmc_body_word_count > 0`: 461K papers (PMC fulltext)
- `epmc_body_word_count > 0`: 210K papers (그리고 EPMC collector가 5.5/s로 추가 540K 회수 중. 7시간이면 +130K 정도 더).
- 합쳐서 약 670K papers에 methods/results/discussion text 보유.

본문 의존 Q500 items (BIAS_*, STATS_*, REPRT_*, INTERP_* 일부 등)을 본문 사용해서 Gemini Flash batch로 채점하면 학습 데이터 quality 크게 개선.

### Deliverable

#### 1. 본문 의존 Q500 items 식별
- `docs/rubric/`에서 `Q100: false` 인 items 중 본문 텍스트 (methods/results/discussion) 없으면 rubric 따라 정확 채점 불가능한 항목 추출.
- 약 30-50개 items 예상.
- 출력: `docs/CODEX_HANDOFF_2026-05-25_ROUND6_TASK1.md`의 list section.

#### 2. Batch 채점 스크립트
- `scripts/score-q500-fulltext-batch.mjs` 신규 또는 기존 `score-with-gemini.mjs` 확장:
  - 입력: papers WHERE has body (PMC 또는 EPMC) AND paper_scores에 mode='Q500-fulltext' 없는 것.
  - 우선 처리: high-JIF journal (IF >= 5) papers 먼저 — 학습 outcome distribution에 균형.
  - Gemini Flash, prompt caching, batch API 활용.
  - 출력: `paper_scores` 테이블에 mode='Q500-fulltext' 새 rows insert.
- Sampling: 첫 50K papers 처리 (cost 추정 후 사용자 동의 받고 확장).

#### 3. 실행 + 결과
- 새벽 batch 가동.
- 진행 log: `E:/paperfate/data/_q500_fulltext_round6.log`
- 완료 시 paper_scores coverage 새로 통계.

### 비용 추정

- Gemini Flash: 50K papers × 30 items × ~2000 input tokens × $0.075/1M = **약 $225**.
- Batch API 50% discount + prompt caching 30% → 약 **$80-100**.
- 사용자가 작업 1 시작 전 비용 estimate 제시할 것 (handoff doc 첫 section).

### 시간

- 코드: 1h
- Batch 가동 + 50K 처리: 2-3h (Gemini Flash rate limit 따라)
- Eval / ingest: 30min

### Deploy 규칙

- 새 mode='Q500-fulltext' rows의 평균 confidence ≥ Q100 baseline의 80% 이상 → ok.
- Inter-rater agreement (기존 Q100 점수와 새 Q500-fulltext 점수) 점검: 상관 0.6+ → 정상.
- 위반 시 batch 중단, 사용자에게 알림.

---

## 작업 2 (MEDIUM · 2h) — paper_references cold-start features

### 배경

`paper_references` 6,013,709 edges, 98,632 unique citing DOI (11%). 사용자가 manuscript 입력 시 reference list (DOIs) 같이 넣으면:

- 평균 referenced-paper JIF
- referenced-paper 분야 분포
- 가장 자주 cite된 journal (target journal hint)

이건 새 feature이고 v0.5 학습 input. 단 cold-start 안전 (publication 시점 정보).

### Deliverable

#### 1. `scripts/build-reference-cold-start-features.mjs`
- 입력: array of reference DOIs
- DB lookup → 각 referenced paper의 (jcr_jif from journal_year_metrics, category, year)
- 출력: `{ n_refs_with_jif, mean_ref_jif, median_ref_jif, top_categories_top3, top_journal_issn }`

#### 2. API integration
- `api/forecast.js`에 `references` field 받기 (optional array of DOIs)
- forecastClient.js + Simulator UI에 references 입력 textarea 추가
  - "Optionally paste your reference DOIs (one per line). Improves journey recommendation."
- 결과 response에 `reference_summary` field 추가

#### 3. ResultPanel 표시
- "Reference profile" 새 카드 (optional)
- "your references suggest target tier ≈ {tier} (median IF {median})"

### 시간

- code: 1.5h
- Q500 fulltext batch 가동 중 병행 가능 (DB read-only)

---

## 작업 3 (LOW · 1h) — journals-shortlist 확장 (800 → 3,000+)

### 배경

현재 `weights/journals-shortlist.json`은 800 journals. /api/journals-search + journey + suggestion engine 모두 이걸로 lookup. 800은 mid-tier 이하 long-tail이 부족.

### Deliverable

#### 1. OpenAlex sources 데이터에서 확장 추출
- `data/openalex-sources/` 에 OpenAlex venues 데이터 있음 (Round 3 수집).
- 또는 `journal_year_metrics` 테이블에서 ISSN별 최근 5년 평균 JIF.
- 상위 3,000 journals 추출, 다양한 tier 보장 (top 100 + high 300 + upper_mid 500 + mid 1000 + lower_mid 700 + low 400 정도).

#### 2. `weights/journals-shortlist-v2.json`
- 같은 schema (name, issn, jif, jif_5yr, tier, category, quartile, publisher, country, is_oa, is_in_doaj, apc, h_index).
- 메인 fatecoreInference.js의 `loadJournals()` 가 v2 로드 자동 (existsSync fallback).

#### 3. Smoke 검증
- /api/journals-search?q=lancet 결과 더 풍부.
- journey + similar 가 더 fine-grained.

### 시간

- 30min code + 30min validation.

### Defer 조건

- 작업 1 진행 중이면 미루기. 작업 1 끝나고 시작.

---

## 주의

1. **Pre-submission features only** — 작업 1 채점 시 본문 사용 OK이지만 outcome (citation, fwci 등)을 prompt에 노출 X.
2. **DB busy_timeout=60s** — Q500 batch 가동 중 paper_scores 테이블에 write 많음. EPMC collector와 충돌 가능. 필요시 batch insert (트랜잭션 1만건 단위).
3. **인계장 필수** — `docs/CODEX_HANDOFF_2026-05-25_ROUND6_TASK<N>.md`.
4. **메인 세션은 frontend / UX 작업 진행 중** — backend는 코덱스 단독.

---

## 시작 신호

작업 1 → 2 → 3. 작업 1 비용 estimate 먼저 handoff doc에 명시 (실행 전 사용자가 보면 stop signal 가능).
