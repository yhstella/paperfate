# 코덱스 작업 — 2026-05-25 Round 5 (overnight)

> Round 4 결과: v0.3-pub HOLD (with-target R²=0.935 의심, cold-start fail). v0.2-prod 유지.
>
> 메인 세션은 이번 라운드에서 frontend/journey/suggestion 작업으로 이동했음:
> - api/similar.js (OpenAlex retrieval)
> - generateJourney에 진짜 switch-cost matrix
> - suggestionEngine.js (counterfactual JIF lift)
>
> 데이터 채널 상태:
> - EPMC fulltext PMCID-wide 가동 중 (PID 72296). ok=85%, ETA 28h. 다 돌면 +540K fulltext.
> - PDF collector 가동 중 (PID 74988). 느리지만 누적.
> - PubMed year-balanced 보강 가동 중 (PID 46304).
> - OpenAlex enricher / references / Crossref / iCite / S2 / Unpaywall / NIH RePORTER 모두 완료.

---

## 작업 1 (HIGHEST) — PubMed history dates ingest + review-timeline learner

### 배경

`scripts/collect-pubmed.mjs` 파서는 이미 `PubMedPubDate` history (`received`, `accepted`, `epublish`, `pubmed`, `entrez` 등)를 추출해서 JSONL에 저장한다 (commit `c68b6a3`). 그러나 DB `papers` 테이블에는 이 필드들이 ingest되지 않았다.

이 데이터를 ingest하면 **review timeline** (`accepted - received` days)을 학습 target으로 쓸 수 있고, 이는 사용자가 진짜 알고 싶은 7 forecasts 중 하나다 (현재는 heuristic `timelineFromTier`).

### Deliverable

#### 1. Schema 확장
- `papers` 테이블에 다음 컬럼 추가 (모두 nullable):
  - `history_received_date` TEXT (ISO YYYY-MM-DD)
  - `history_accepted_date` TEXT
  - `history_epublish_date` TEXT
  - `history_pubmed_date` TEXT
  - `history_revised_date` TEXT
  - `review_days_received_to_accepted` INTEGER (computed)
- 마이그레이션 스크립트: `scripts/migrate-add-history-dates.mjs` (idempotent — ALTER TABLE IF NOT EXISTS pattern)

#### 2. Ingest
- `scripts/build-unified-db.mjs`의 PubMed ingest section에 history 컬럼 매핑 추가.
- 다시 실행:
  ```
  DATA_ROOT=E:/paperfate/data node scripts/build-unified-db.mjs --only=pubmed
  ```
- Expected: 일부 papers에 history 채워짐 (PubMed XML의 PubMedPubDate가 모든 article에 있는 건 아님 — 보통 20-40% 정도 예상).

#### 3. Review timeline learner
- 학습 데이터: `papers WHERE history_received_date AND history_accepted_date AND year >= 2010`
  - target: `review_days_received_to_accepted` (clip to [1, 730] days)
  - Pre-pub features only (Round 3 ban list 그대로):
    - Q500 stats (`q_score_*`)
    - author h-index (first/last/max/median)
    - `team_size_with_id`, `international_collab`
    - `j_hist_jcr_jif` (year-1, target-journal)
    - `is_review`, `is_trial`, `is_case_report`, `is_clinical`
    - `mesh_terms_count`, `publication_types_count`
    - `n_nih_grants`, `has_funder`
- LightGBM regression, log1p target, random 80/20 split, isotonic + split-conformal calibration.
- Output:
  - `scripts/build-fatecore-timeline-features.mjs`
  - `scripts/train-fatecore-timeline.py`
  - `weights/fatecore-v0.4-timeline-*.txt` + `weights/fatecore-v0.4-timeline-metrics.json`
- Eval (`scripts/eval-fatecore-timeline.py`):
  - MAE_days, R²(log), tier-stratified (top JIF≥30 vs others — top tier 보통 review가 더 길다)
  - Honest pre-pub check (post-pub feature 0개)

#### 4. Deploy 규칙
- MAE_days ≤ 90 days (3개월) AND honest pre-pub features only → deploy 권장
- src/server/fatecoreInference.js의 TARGETS에 추가
- src/components/Simulator.jsx의 `timelineFromTier` heuristic을 model prediction으로 교체 (있으면)

#### 5. 인계장
- `docs/CODEX_HANDOFF_2026-05-25_ROUND5_TASK1.md`
- 학습 결과 metric 표, deploy 결정 명시

---

## 작업 2 (MEDIUM) — v0.3-pub R²=0.94 leak/autocorr 진단

### 배경

v0.3-pub의 with-target R²(jcr_jif log) = 0.935는 Round 4 threshold (0.85 의심선) 초과. 그러나 진짜 leak일지, `j_hist_jcr_jif` (prior-year IF)의 ISSN identity autocorrelation일지 불분명.

만약 후자라면, "트리비얼하지만 valid" — production target-aware path로 deploy 가능. 만약 전자라면 v0.3-pub 영구 폐기.

### 진단 방법

#### A. ISSN-stratified MAE
- v0.3-pub의 with-target predictions를 test set에서 ISSN별로 grouping
- 상위 200 ISSN별 MAE 분포 → 거의 0이면 trivial lookup, 분산이 크면 모델이 본문 신호도 학습
- 출력: `docs/V0.3_PUB_ISSN_STRATIFIED.md`

#### B. `j_hist_jcr_jif` shuffle ablation
- v0.3-pub feature CSV에서 `j_hist_jcr_jif`, `j_hist_jcr_jif_5yr`, `j_hist_jci`, `j_hist_article_influence`, `j_hist_eigenfactor` 5개 컬럼 **셔플** (test set에서만 random permute)
- 재예측 → R² 떨어지는 정도 측정
  - R² 0.935 → ~0.43 (v0.3-prepub 수준)이면 trivial autocorr
  - R² 0.935 → 0.7~0.8이면 모델이 본문도 학습한 것

#### C. 결정
- A + B 결과 종합
- Trivial autocorr → 대안: api/forecast.js에 target_journal ISSN으로 직접 j_hist_jcr_jif lookup → response에 "if you submit to {journal}, expected IF ≈ {lookup}" 같은 fact-based 출력. 모델 없이.
- 실제 학습 → v0.3-pub target-aware path 부활 검토

#### Deliverable
- `scripts/diag-v0.3-pub-leak.py` (위 진단 코드)
- `docs/V0.3_PUB_LEAK_DIAGNOSIS.md` (결과 + 권고)

### 시간
- 1-2시간

---

## 작업 3 (LOW, defer if 1+2 끝나면) — paper_references cold-start features

### 배경
`paper_references` 테이블에 6M edges 있음 (98K papers).

사용자가 manuscript 입력 시 reference list를 함께 입력하면:
- 평균 referenced-paper IF
- referenced-paper 분야 분포
- 가장 자주 cite된 journal (target-journal hint)
- "your references span {N} fields, top journals: {list}" 같은 feature

### Deliverable
- `scripts/build-reference-cold-start-features.mjs`:
  - 입력: array of reference DOIs (사용자 입력)
  - DB lookup → JIF, category, year
  - return: { n_refs_with_jif, mean_ref_jif, median_ref_jif, top_categories, top_journals }
- api/forecast.js에 references field 받기 (optional)
- ResultPanel에 "your references suggest target tier ≈ X" 표시

### 시간
- 1시간

### Defer 조건
- 작업 1 + 2 모두 끝난 후. paper_references coverage가 11%라 아직 baseline 약함.

---

## 작업 4 (NIGHT-LIGHT — 가동 중 collectors 점검)

`scripts/auto-ingest-watcher.mjs` 또는 새 watcher 가동해서:
- 매 1시간마다 EPMC fulltext jsonl 누적분을 DB로 ingest
- PDF jsonl 동일
- ingest 후 papers 테이블 `pmc_body_word_count`/`epmc_body_word_count` 새로 채워진 row 수 보고
- 30분 간격 progress 보고 (log에)

### Deliverable
- 가동 시작, 첫 ingest 보고만 확인되면 OK

---

## 주의

1. **Pre-submission features only** — 작업 1 학습 시 절대 위반 금지. `feedback_data_leakage_postpub.md` 룰 그대로.
2. **Random split only** — 작업 1 학습 시. 연도 split 절대 금지.
3. **R² 너무 높으면 의심** — 작업 1에서 review-time R²(log) > 0.6이면 leak 점검. 일반적 review time predictor R² 0.3-0.5 ceiling.
4. **인계장 필수** — 각 작업마다 `docs/CODEX_HANDOFF_2026-05-25_ROUND5_TASK<N>.md`.
5. **메인 세션은 frontend/UI 작업 진행 중** — backend 학습은 코덱스 단독.

---

## 시작 신호

1 → 2 → (3, 4 optional). 1번이 가장 가치 큼 (새 forecast 항목 추가). 2번이 가장 빠름 (분석만). 4번은 watcher라 background에서 silent.
