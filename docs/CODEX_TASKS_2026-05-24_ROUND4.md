# 코덱스 작업 — 2026-05-24 Round 4 (v0.3-pub: target-journal aware)

> Round 3 결과: v0.3-prepub R²(JIF log)=0.461 — threshold 0.48 미달, HOLD v0.2-prod 옳음.
>
> 핵심 인사이트: `j_hist_jcr_jif`/`j_hist_jcr_jif_5yr` 같은 **target journal의 prior-year metrics**가 빠지면 모델이 journal identity를 못 알아봄. 결과 top tier (JIF≥30) MAE=**37.6** (predict 6.4, actual 42.7).
>
> v0.3 (leak version)는 이 j_hist_* 있어서 R²=0.95 같은 fake high score 받음. v0.3-prepub은 너무 보수적으로 다 빼서 0.46만 됨.

---

## 전략: target-journal **optional** input

대부분의 사용자는 target journal을 마음에 두고 paperfate.com에 입력. 그 정보를 활용해야 함. 단, 입력 안 한 경우에도 합리적 prediction 가능해야 함.

### 두 가지 접근법

**(A) Single NaN-safe model** (권장)
- `j_hist_jcr_jif`, `j_hist_jcr_jif_5yr`, `j_hist_jci`, `j_hist_article_influence`, `j_hist_eigenfactor` 모두 feature로 포함
- 학습 시: random 30-50% rows의 j_hist_* features → NaN으로 mask out
- LightGBM의 native NaN handling 활용
- 추론 시: user provides target_journal → j_hist_* lookup. 미입력 시 NaN.

**(B) Two-model approach**
- model A: target-aware (j_hist_* 포함)
- model B: target-blind (j_hist_* 제외, v0.3-prepub)
- API가 input에 따라 분기

**(A) 우선 시도**. 작업량 적고 NaN-safe pattern이 cleaner.

---

## 작업 1 (HIGHEST) — v0.3-pub 학습

### 핵심 원칙
1. **Pre-submission features only** (Round 3 표 그대로)
2. **target journal features는 자기 자신 paper의 같은 연도 jcr_jif 절대 사용 금지** — 반드시 `journal_year_metrics.year < paper.year` (Round 1 v0.1에서 R²=0.999 leak 사고 재발 방지)
3. **j_hist_* features 포함** — Round 3에서 제외한 거 다시 추가
4. **학습 시 target journal mask out 30%** — 모델이 NaN-safe 되도록

### Deliverable
1. **scripts/build-fatecore-features-v0.3-pub.mjs** (v0.3-prepub 기반):
   - v0.3-prepub의 34 features 그대로 유지
   - **추가 features (target journal aware)**:
     - `j_hist_jcr_jif` (paper.year - 1년의 ISSN match journal IF)
     - `j_hist_jcr_jif_5yr` (paper.year - 1년의 5yr IF)
     - `j_hist_jci` (paper.year - 1년의 JCI)
     - `j_hist_article_influence`
     - `j_hist_eigenfactor`
     - `j_hist_metric_age` (몇 년 차이로 lookup 했는지)
   - 학습 데이터 (CSV): 모든 row에 j_hist_* 채움 (training time에는 알 수 있음)
   - **manifest에 명시**: 추론 시 user가 target_journal 입력 안 하면 j_hist_* 모두 NaN
   - 출력: `E:\paperfate\data\features\v0.3-pub-features.csv`

2. **scripts/train-fatecore-v0.3-pub.py**:
   - 기본 train-fatecore-v0.3-prepub.py 베이스
   - **추가**: training time augmentation:
     - 매 epoch마다 random 30%의 rows에서 j_hist_* columns을 NaN으로 마스크
     - 이걸 통해 모델이 j_hist_* present/absent 둘 다 학습
   - 출력: `weights/fatecore-v0.3-pub-*.txt`, `weights/fatecore-v0.3-pub-metrics.json`

3. **scripts/eval-fatecore-v0.3-pub.py**:
   - 두 시나리오로 평가:
     - **"with target"**: test set 그대로 (j_hist_* present)
     - **"cold-start"**: test set에서 j_hist_* 모두 NaN으로 mask
   - 각각 R²(log), MAE_cal, tier-stratified MAE 보고
   - 두 시나리오 모두 honest pre-pub features (post-pub leak 0)
   - vs v0.2-prod, vs v0.3-prepub 비교

### Deploy 규칙 (이번엔 더 엄격)
1. **with target** scenario: R²(JIF log) **≥ 0.55** AND 합리적 (R² 0.85 처럼 비현실적이면 leak 의심)
2. **cold-start** scenario: R²(JIF log) **≥ 0.45** (v0.2-prod 0.435 동등 이상)
3. **EMPA-REG cold-start (no target)** smoke: v0.2-prod 2.15와 ±50% 내 prediction
4. **EMPA-REG with target=NEJM**: prediction이 30-100 사이 (NEJM IF ≈ 100) — 합리적이면 OK

만족하면 deploy 권장.

### docs/EVAL_v0.3-pub.md 필수 내용
- 두 시나리오 metric 표
- Top 30 features 별 forbidden flag (반드시 모두 no)
- EMPA-REG cold-start AND with-target=NEJM 결과
- Deploy decision

---

## 작업 2 (조건부) — v0.3-pub deploy

작업 1 만족 시:
1. **api/forecast.js** 에 target_journal optional input 처리 — 이미 있을 수도 있음 (paper.target_journal에 들어가는 듯). 확인.
2. **src/server/fatecoreInference.js**: target_journal이 있으면 journals/journal_year_metrics 테이블에서 j_hist_* lookup. 없으면 NaN.
3. version `fatecore-v0.3-pub`
4. **Test cases**:
   - EMPA-REG cold-start (no journal): JIF ~2-3
   - EMPA-REG with target=NEJM: JIF 70-100
   - EMPA-REG with target=Saudi Heart: JIF 1-2
5. Production verify after push

### 만약 cold-start 시나리오에서 v0.2-prod보다 나쁘면
Deploy 안 함. 두 모델 path는 너무 복잡. v0.2-prod 유지.

---

## 작업 3 (LOW) — paper_references 기반 features

### 배경
방금 6M edges ingested. `paper_references` 테이블에서 통계 features 가능:
- `n_refs` (paper가 cite한 ref 수)
- `n_refs_with_jif` (cite한 ref 중 JIF 알려진 비율)
- `avg_ref_jif` (cite한 ref들의 평균 JIF)
- `ref_recency_median` (cite한 ref들의 publication year median)

### 적용 조건
v0.3-pub deploy 후 v0.4 단계에서 활용. 현재 references 커버리지는 98K papers뿐 (모든 학습 data 857K 중 11%). 충분히 차오르지 않아서 지금 학습엔 별 도움 안 됨.

### Deliverable (defer)
**scripts/build-reference-features.mjs**:
- `paper_references` + `papers` join
- `n_refs`, `avg_ref_jif`, `ref_recency_median` 계산
- DB UPDATE 또는 별도 CSV
- v0.4 학습 때 활용

### 시간
defer until references 50%+ coverage 도달

---

## 메인 세션 진행
- PMC S3 hardened (TypeError fetch failed 간간이 발생, wrapper auto-restart로 회복)
- OpenAlex enrichment 38% 진행
- PDF collector readFileSync 패치 (commit e8f5476)
- Production v0.2-prod 가동 중

---

## 주의
1. v0.3-pub R²이 너무 높으면 (예: 0.8 이상) 즉시 leak 점검. Round 3에서 0.95 fake 사고 기억.
2. j_hist_* features는 **반드시 paper.year보다 이전 year** 데이터로만. journal_year_metrics 쿼리 시 `year < ?` 명시.
3. EMPA-REG with target=NEJM 예측이 비현실적 (예: 5 같은 낮은 수치)이면 deploy 안 함.
4. 인계장: `docs/CODEX_HANDOFF_2026-05-24_ROUND4_TASK<N>.md`.

---

## 시작 신호

작업 1부터 즉시. 1 끝나면 결과 보고. 좋으면 2 진행.
