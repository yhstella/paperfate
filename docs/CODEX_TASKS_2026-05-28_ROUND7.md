# 코덱스 작업 — 2026-05-28 Round 7 (manuscript quality 진짜 학습)

> Diagnostic (commit `8c35802`, `d80361f`) 으로 확정된 root cause:
> 현재 LLM Q-rubric 채점이 NEJM/Lancet/JAMA-class abstract와 Q2-specialty
> abstract에 동일 q_mean (~4.0)을 부여. 결과적으로 v0.2-prod는 모든 abstract에
> JIF ~2.6의 flat predictor. R²(JIF log)=0.435 ceiling은 모델 한계가 아니라
> **input feature가 tier-discriminative하지 않다는 신호**.
>
> Round 7의 목표: input quality scoring을 fix해서 그 위에 새 학습.

---

## 작업 1 (HIGHEST · 4h, ~$80–100) — Q500 본문 LLM rescoring

### 배경
- `paper_scores` 25.8% coverage, 거의 전부 Q100 (abstract-only) + rule pre-pass
- v0.4-timeline은 review-days라 영향 다름
- v0.2-prod의 q_score_mean / sd 등 features는 LLM Q-rubric에 의존 — 그 채점이 tier-blind니 다운스트림 model도 tier-blind

### Deliverable

#### 1.1 본문 의존 Q500 items 식별
- `docs/rubric/Q500.json`에서 `Q100: false` AND mode='llm'|'hybrid' items
- 약 30-50개 예상 (BIAS_*, STATS_*, REPRT_*, DESIGN_017+, OUTCM_010+ 등)

#### 1.2 Calibrated batch scoring
- `scripts/score-q500-fulltext-llm.mjs` 신규:
  - 대상: papers WHERE (pmc_body_word_count > 800 OR epmc_body_word_count > 800) AND DOI not in paper_scores(mode='Q500-fulltext')
  - 우선: high-JIF (real_jcr_jif >= 5) papers 먼저 → 학습 distribution이 top tier 회복하도록
  - **system prompt는 commit `055fe68`의 calibration block 그대로** (anchor 5 = NEJM-class)
  - Gemini Flash, prompt caching, JSONL append + WAL DB upsert
- Cost 추정: 50K papers × 30 items × ~2.5k tokens × $0.075/1M ≈ **$280** raw / **$80–100** with Batch + cache

#### 1.3 실행
- 작은 1,000-paper sample 먼저 → quality 검증 (mid vs top tier q_score 차이 측정)
- quality 통과 후 50K full batch
- 출력: `paper_scores` mode='Q500-fulltext' rows + log `E:/paperfate/data/_q500_fulltext_round7.log`

### Deploy 규칙
- 1,000-paper sample에서 **Δ q_mean (top vs mid tier) ≥ 0.7** 이면 large batch GO
- 미달이면 prompt 추가 개혁 + 재시도

### 시간/비용
- 코드: 1h
- 1K sample: 30분, ~$2
- Quality check: 15분
- 50K batch (사용자 동의 후): 3-4h, ~$80-100

---

## 작업 2 (HIGH · 1.5h) — abstract-extractable signal expansion

### 배경
메인이 `extract.js`에 sample-size / multicenter / AUC / follow-up magnitude-aware
rule scoring 추가 (commit `d80361f`). 추가 abstract signals (study type,
primary endpoint defined, statistical method depth, intervention type)이
모두 v0.5 학습 input으로 가치.

### Deliverable
- `src/server/ruleExtractors.js`에 신규:
  - `extractStudyDesignTier(m)` — `phase 3 randomized double-blind multicenter` → tier 'rct_phase3'; `prospective cohort` → 'cohort_prospective'; `retrospective` → 'cohort_retro'; `case series` → 'case_series'
  - `extractPrimaryEndpointDefined(m)` — "primary outcome" + 명시된 endpoint 텍스트 → score 4-5
  - `extractStatisticalDepth(m)` — Cox / mixed-effects / Bayesian / propensity / mediation 등 advanced 통계 mention → tier
  - `extractInterventionType(m)` — drug / device / surgery / behavioural — 분야 학습용
- `extract.js`의 `scoreFromRule`에 각각 magnitude-aware branch
- v0.5 feature builder가 새 신호를 column으로 사용

### 시간
- 1.5h

---

## 작업 3 (MEDIUM · 4h) — v0.5 학습 with calibrated rubric + new features

### 학습 데이터
- 작업 1 결과 paper_scores (Q500-fulltext mode rows)
- 작업 2 결과 새 abstract-extractable features
- 기존 v0.3-prepub 34 features + 새 features

### Trainer
- `scripts/train-fatecore-v0.5.py` (v0.3-prepub trainer 베이스)
- Random 80/20, log target, **tier-stratified class weighting** (top tier 6× over mid tier)
- Isotonic + split conformal calibration

### Eval
- `scripts/eval-fatecore-v0.5.py`
- `docs/EVAL_v0.5.md`
- 50-sample diagnostic (메인 `scripts/sample-test-from-epmc.mjs`) 재실행 → tier-stratified MAE 보고

### Deploy 규칙
- R²(JIF log) ≥ 0.50 (v0.2-prod 0.435 + 0.07)
- top-tier MAE < 30 (현재 90)
- 50-sample tier match ≥ 50% (현재 23%)

만족 시 deploy. 미달 시 v0.2-prod 유지.

---

## 작업 4 (LOW · 30min) — sample size rule false-positive 점검

`extractSampleSize`가 abstract에서 모든 숫자를 잡아 가장 큰 것을 N으로 선택.
- "1,127 patients" → N=1127 ✓
- "follow-up 52 weeks" → 52 (잘못 — N 아님)
- "95% CI" → 95 (잘못)
- 결과: small abstract에서 false N=95, false score 1 매겨질 수도

`POPUL_005` patterns 점검 + tighten 후 false positive 제거.

---

## 주의

1. **Pre-submission features only** — 작업 3 학습 시 v0.3-prepub ban list 그대로 (citation, fwci, fulltext counts 등).
2. **Calibration prompt (`055fe68`)는 그대로 유지** — 모든 LLM call이 이 system prompt 사용해야 tier discrimination.
3. **DB busy_timeout 60s** — 작업 1 batch 가동 중 paper_scores write 많음.
4. **인계장 필수** — `docs/CODEX_HANDOFF_2026-05-28_ROUND7_TASK<N>.md`.

---

## 시작 신호
작업 1 → (검증 + 사용자 동의 후 large batch) → 2 → 3. 4번은 언제든 가능.
