# 코덱스 작업 — 2026-05-26 Round 6.5 (cost-free, 무인 가동 가능)

> Round 6 brief의 Task 1 (Q500 fulltext rescoring, $80-100) 은 사용자
> 동의 대기로 보류. 그 사이 메인 세션이 Task 3 (journals-shortlist
> 800 → 2,840 확장) 을 직접 완료. 남은 작업을 cost-free 범위로 재배치.

이번 라운드의 모든 작업은 **외부 API 비용 없음**. 메인이 자율로 진행해도 OK.

---

## 작업 1 (HIGHEST · 2h) — paper_references DB-backed cold-start features

### 배경

`/api/references` 가 OpenAlex 기반으로 라이브 (메인 작성, commit `b8c4507`).
DB의 `paper_references` 6,013,709 edges는 학습 input으로 더 강력하다 —
단 production endpoint는 DB 미접근.

### Deliverable

#### 1. `scripts/build-reference-cold-start-features.mjs`
- 입력: papers 테이블의 DOI list
- 각 DOI에 대해 `paper_references` 에서 referenced_works → 그것의 jcr_jif/category 통계
- 출력 컬럼:
  - `ref_n` (총 ref 수)
  - `ref_n_with_jif` (ref 중 JIF 알려진 비율)
  - `ref_mean_jif`, `ref_median_jif`, `ref_max_jif`
  - `ref_category_top` (가장 많이 cite된 category 1위)
  - `ref_year_median`, `ref_recency_median_years` (현 year - ref year)
- 출력: `E:\paperfate\data\features\v0.5-reference-features.csv`

#### 2. v0.5 feature CSV 통합
- `scripts/build-fatecore-features-v0.5.mjs` (build-fatecore-features-v0.3-prepub의 후속):
  - v0.3-prepub features (34개) +
  - reference cold-start features (위 6개) =
  - 총 40개 features
- 출력: `E:\paperfate\data\features\v0.5-features.csv`

#### 3. Trial training (small)
- `scripts/train-fatecore-v0.5.py` — v0.3-prepub trainer 베이스, feature 6개만 다름
- 학습 + eval (random 80/20):
  - R²(JIF log) 가 v0.3-prepub (0.461) 대비 의미있는 개선 (+0.02 이상)이면 deploy 후보
  - 미달이면 v0.2-prod 유지

### Deploy 규칙

- v0.3-prepub deploy threshold (0.48) 동일 적용
- 추가: post-pub feature 0개 verify

---

## 작업 2 (MEDIUM · 1h) — v0.4-timeline cold-start eval

### 배경

v0.4-timeline은 j_hist_jcr_jif 등을 입력으로 사용. 사용자가 target journal
없이 요청 (cold-start) 시 NaN 들어감 — LightGBM native NaN handling이라
working하지만 eval 안 했음.

### Deliverable

#### 1. `scripts/eval-fatecore-timeline-cold-start.py`
- v0.4-timeline test set에서 j_hist_* 컬럼 모두 NaN으로 mask → re-eval
- 두 시나리오 metric 표:
  - with target (현재 deploy 그대로)
  - cold start (j_hist_* NaN)
- Tier-stratified MAE (target IF >=30, 10-30, 3-10, <3, missing)

#### 2. 결과
- `docs/EVAL_v0.4-timeline-cold-start.md`
- Decision:
  - cold-start MAE ≤ 75 days (within 26% degradation) → 그대로 deploy 유지
  - 미달이면 alert (현재 deploy 위험 신호)

### 시간

- 30분 code + 30분 eval + doc

---

## 작업 3 (LOW · 30min) — auto-ingest watcher fix

### 배경

`scripts/auto-ingest-watcher.mjs` 가 EPMC ingest를 12+ 시간 동안 trigger
하지 않음 (`changed:false` 로 skip). EPMC collector가 jsonl 누적 중인데
DB에 ingest 안 됨. 메인이 manual trigger (PID `bafl7wmsf`)로 임시 처리.

### Deliverable

- watcher의 changed detection 로직 점검 (probably file size delta threshold가 잘못됨)
- jsonl 디렉터리 내 모든 file의 size 합 변화 또는 row count 증가로 trigger
- 또는 `--min-ingest-min` 보다 `--max-skip-min` 추가: 예 360분 (6h) 마다 강제 ingest

### 시간

- 30min

---

## 작업 4 (DEFER · 사용자 동의 필요) — Q500 본문 채점 batch

이전 Round 6 Task 1. 사용자 비용 동의 받으면 진행.

- 50K papers × 30 본문 의존 items × Gemini Flash batch
- 추정 비용 $80-100 (Batch API 50% + prompt caching 30%)
- 출력: paper_scores mode='Q500-fulltext' 새 rows

---

## 주의

1. **Pre-submission features only** — 작업 1 학습 시 reference features는 OK
   (publication 시점에 이미 ref list 결정됨; post-pub citations 아님).
2. **Random split only**.
3. **R² 너무 높으면 의심** — v0.5 R²(JIF log) > 0.65 이면 leak 점검.
4. **인계장 필수** — `docs/CODEX_HANDOFF_2026-05-26_ROUND6_5_TASK<N>.md`.

---

## 시작 신호

1 → 2 → 3 순서. 1번이 가장 가치 (v0.5 학습 base). 4번은 사용자 비용
동의 후에만.
