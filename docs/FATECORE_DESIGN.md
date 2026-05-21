# FateCore — 설계 문서 (v0.1 학습 시작 전 계획)

> **상태**: 설계 단계 (코드 작성 안 함). 사용자 승인 후 구현 시작.
> **작성**: 2026-05-21
> **데이터 기반**: paperfate.db 현재 시점 schema + 진행 중 코덱스 ~82M scores baseline

---

## 0. 한 줄 요약

**Manuscript abstract/본문 → "이 paper가 출판된다면 어떤 journal tier에, 어떤 citation/influence를 받을지" 예측**.

학습 데이터: PubMed에서 수집한 866K papers의 (X = 코덱스/LLM이 채점한 Q500 + 메타데이터 + 임베딩) → (y = 실제 게재 저널의 JIF + NIH RCR + 인용수).

학습 방식: **로컬 PC (사용자 R)에서 LightGBM multi-task**, 결과 가중치만 GitHub commit → Vercel deploy.

---

## 1. 문제 정의 (사용자 명시 정정 반영)

### 1.1 Input (학습 시 X, 추론 시 사용자 manuscript에서 추출)

```
X = [
  Q500 scores (100~507 dim),       # 가장 중요한 backbone feature
  paper metadata (~40 dim),         # year, citations 시점 X, OA status, author count, ...
  journal metadata (~15 dim),       # h_index, two_yr_mean_citedness, is_oa, ... (target 저널)
  author features (~10 dim),        # h_index, prior citations, ...
  manuscript embedding (768 dim),   # SPECTER2 — semantic backbone
  similar paper retrieval (~15 dim) # top-K cosine similar papers의 outcome 통계
]
≈ 950 ~ 1,355 dim
```

### 1.2 Output (학습 시 y, 추론 시 forecast)

```
y = [
  jcr_jif_at_publication_year,    # 출판 시점 저널 JIF — 핵심 target
  icite_rcr,                       # NIH 분야 보정 인용 지표
  citations_5yr_normalized,        # log(citations + 1)
  desk_reject_proxy,               # binary (citations_5yr == 0 within 24mo)
]
```

⚠️ **사용자 정정 사항** (헷갈리지 않게 명시): 
- 출판 시점 JIF는 **OUTPUT**.
- 과거 IF (저자가 이전에 게재한 저널들의 IF) = INPUT feature.

### 1.3 사용자 facing outputs (production server 응답)

| 7개 출력 | 산출 방식 |
|---|---|
| Expected journal tier | jcr_jif 예측 + percentile 환산 |
| Best fit + stretch journal | 임베딩 retrieval → similar paper의 venue 분포 |
| Desk-reject risk | desk_reject_proxy 예측 (calibrated) |
| Review timeline weeks | preprint_pub_gap_days 학습 (별도 head) |
| Citation 5yr range | citations_5yr ± conformal interval |
| Actual impact score (0-100) | composite of 4 outputs |
| Main weakness | Q500 항목 중 낮은 점수 도메인 → 자동 텍스트 |

---

## 2. 데이터 자원 인벤토리 (paperfate.db 기준)

### 2.1 Tables 활용 매핑

| Table | Rows (현재) | 학습 활용 |
|---|---|---|
| `papers` | 866,327 | X 메타데이터 + y citation/RCR labels |
| `paper_scores` | 26M+ (코덱스 진행 중 → 82M+) | X의 Q500 점수 |
| `journals` | 4,450 | X journal metadata (h_index, OA, ...) |
| `journal_year_metrics` | 158K | y jcr_jif at publication year |
| `clinical_trials` | 14,754 | X enrichment (sample size, blinding, phase) |
| `ingest_runs` | audit | — |

### 2.2 paper_scores 4-mode 활용 전략

| mode | weight | 용도 |
|---|---|---|
| `llm` (Claude/Gemini) | **1.0** | Gold supervision (50~5,000 paper) |
| `external` | **0.9** | Numeric anchor (citation, OA — 권위 출처) |
| `rule` | **0.7** | Regex 채점 (sample size, AUROC, p-value) |
| `codex_deterministic` | **0.5** | Weak supervision (866K paper, wide recall) |

→ Ensemble 채점: 같은 (doi, item_id) 여러 mode 있을 때
```python
final_score = weighted_avg([
  (llm_score, 1.0) if llm else null,
  (external_score, 0.9) if external else null,
  (rule_score, 0.7) if rule else null,
  (codex_score, 0.5) if codex else null,
])
```

### 2.3 학습 가능한 paper 양 (예상)

| 조건 | papers | 비고 |
|---|---|---|
| 채점됨 (any mode ≥20 items) | ~800K | 코덱스 완료 시 |
| jcr_jif label 있음 | ~80K (10%) | journal × year intersection |
| icite_rcr label 있음 | ~600K (75%) | 2023 이전 paper |
| citation label 있음 | ~150K (18%) | OpenAlex enrich 완료 부분 |
| SPECTER2 임베딩 있음 | ~700K (90%) | S2 enrich 완료 시 |
| **3개 label 모두 + 임베딩 + ≥80 items 채점** | **~50-80K** | sweet spot for v0.1 |

---

## 3. Feature Engineering 세부 (X 구성)

### 3.1 Q500 점수 (backbone)

- 100~507 dim numeric (각 item별 0-5 score)
- 결측 처리:
  - `NA`: -1 (categorical encoding)
  - `unknown`: -2
  - `score=0`: 그대로 0 (명시적 "없음")
- 정규화: 그대로 사용 (LightGBM은 raw 처리 가능)
- Q100만으로 시작 → Q500 확장 (v0.2)

### 3.2 Paper metadata (직접 컬럼)

```
year, pub_year_age
citations_openalex, citations_s2, citations_crossref   # multi-source 인용
fwci, icite_rcr, icite_nih_percentile, icite_apt        # 보정 인용
icite_citations_per_year, icite_field_citation_rate    # NIH 분야 평균
reference_count, influential_citations                  # 참조 quality
is_oa, unpaywall_oa_status, unpaywall_journal_doaj      # OA features
pmc_body_word_count, pmc_section_count, pmc_*_count     # 본문 길이/구조 (full-text가용 paper)
author_count, has_first_affiliation, has_funder         # team features
publication_types_count, mesh_terms_count               # PubMed metadata
is_research_article, is_clinical (iCite)                # paper kind
```

### 3.3 Journal metadata (papers JOIN journals)

```
j_h_index, j_i10_index, j_two_yr_mean_citedness
j_works_count, j_cited_by_count
j_is_oa, j_is_in_doaj, j_is_core, j_apc_usd
j_jcr_jif_5yr (NOT current jcr_jif → leakage), j_jci
```

⚠️ **Data leakage 방지**: target year의 `jcr_jif`는 y로 사용 — feature로 절대 사용 X.

### 3.4 Author features (papers.authors_json → 가공)

```
first_author_h_index, last_author_h_index (corresponding)
max_team_h, median_team_h, team_size
n_unique_institutions
international_collab (binary)
```

→ 별도 enrichment 필요 (OpenAlex authors API). **현재 미구현**. v0.2.

### 3.5 Embedding 기반 features (SPECTER2 + retrieval)

```
embedding (768 dim float)                              # raw 사용 (LightGBM에 직접 입력)
sim_paper_avg_jif (top-K=10 similar papers)            # retrieval-augmented label
sim_paper_avg_rcr
sim_paper_max_jif
sim_paper_field_diversity                              # 분야 confluence
sim_paper_year_median                                  # 시기성
```

**선택**: 768d raw embedding을 LightGBM에 직접 넣으면 차원 너무 큼 (overfitting). 대안:
- PCA 64-dim 축약
- 또는 별도 neural encoder (auxiliary head)
- 또는 retrieval-augmented features만 사용 (15 dim 정도)

v0.1: **retrieval features만**. v0.2: full embedding.

### 3.6 Manuscript-specific (사용자 입력 시 추출)

- 사용자가 입력한 abstract → 위 모든 features를 server에서 추출
- Q500 채점 → Gemini Flash on-demand
- 임베딩 → SPECTER2 ONNX inference 또는 S2 API
- Author info → 사용자가 입력하거나 ORCID lookup
- 비용 ≈ $0.001/요청 (Gemini Flash 무료 분당 10 안에서도 작동)

---

## 4. Target Engineering (y 구성)

### 4.1 핵심 target — jcr_jif at publication year

- `papers.year` + `papers.issn` → `journal_year_metrics WHERE issn = X AND year = Y`
- Coverage: ~80K paper (10%)
- Issue: Long-tail (Nature 50, JACS 16, 무명 저널 0.5)
- 변환: `log(jcr_jif + 1)` — heavy tail 완화

### 4.2 Weak target — iCite RCR

- 분야 보정된 인용 (NIH 권위)
- Coverage: ~600K (~75% of papers ≤2023)
- 변환: `log(rcr + 0.1)` (rcr ≥ 0 boundary)

### 4.3 Weak target — citations log

- `log(citations_openalex + 1)`
- Coverage: ~150K
- 시점 잡음 (오래된 paper일수록 큼) → year 보정

### 4.4 Derived target — desk_reject_proxy

- `citations_5yr == 0 AND year ≤ current - 5` → binary
- 정의: 5년 후 0 인용은 desk reject 수준 또는 사실상 영향력 없음
- Coverage: 2020 이전 paper만

### 4.5 Multi-task vs separate

**Decision**: **Multi-task LightGBM** (shared trees, multiple outputs).
- 장점: jcr_jif sparse labels을 RCR/citation의 dense labels이 보강
- 단점: 손실 weighting 튜닝 필요
- 구현: lightgbm multi-output regression

또는 separate model per target + ensemble. v0.1은 separate (간단), v0.2는 multi-task.

---

## 5. Architecture 선택

### 5.1 v0.1 — **LightGBM separate per target**

```
Model JIF      = LightGBM(features_x → log(jcr_jif + 1))
Model RCR      = LightGBM(features_x → log(rcr + 0.1))
Model Citation = LightGBM(features_x → log(citations + 1))
Model DeskRej  = LightGBM(features_x → binary)
```

이유:
- Tabular feature에 최적
- 빠른 학습 (CPU only OK)
- Native missing 처리
- Feature importance interpretable
- 사용자 PC에서 학습 가능

### 5.2 v0.2 — Multi-task + retrieval-augmented

- Shared early layers (XGBoost or LightGBM multi-output)
- Retrieval features 추가 (top-K similar paper outcome stats)

### 5.3 v0.3 — Neural encoder (manuscript → 64-dim representation) → LightGBM head

- SPECTER2 임베딩 + Q500 점수 → 64-dim joint representation (autoencoder pretrain)
- 그 위에 LightGBM heads
- Ensemble with v0.1 LightGBM

### 5.4 v1.0 — Production ensemble

- Multiple model average
- Domain-specific calibration (의학 vs 생명과학 vs 공학)

---

## 6. 학습 전략

### 6.1 데이터 split

🚨 **RANDOM SPLIT ONLY** (`feedback_fatecore_validation.md` 원칙)

```
train  : 70% random
val    : 15% random (early stopping, hyperparameter tuning)
test   : 15% random (final eval, never touched during dev)
```

- Stratification: `papers.mesh_terms_json[0]` (분야) 또는 `icite_is_clinical`
- 절대 금지: year-based split (JIF 연도 변동성 ±100% 가능)

### 6.2 Sample weighting

```python
sample_weight = base_weight × confidence_weight × label_quality_weight
```

- base_weight: 1.0
- confidence_weight: `avg(paper_scores.confidence)` (0~1)
- label_quality_weight: jcr_jif 있으면 1.0, RCR만 0.6, citation만 0.4

→ Strong label paper에 더 큰 영향.

### 6.3 Loss

- jcr_jif: MAE (robust to outliers)
- RCR: MAE
- citation: Poisson (count data)
- desk_reject: Log loss

### 6.4 Hyperparameter search

- Bayesian optimization (Optuna)
- 50-100 trials × 5-fold CV
- Search space:
  - num_leaves: 31, 63, 127
  - learning_rate: 0.01 ~ 0.1
  - feature_fraction: 0.6 ~ 0.9
  - lambda_l1/l2: 0 ~ 10

### 6.5 Calibration

```
raw prediction → Isotonic regression → calibrated prediction
                                    → Conformal prediction interval
```

- Isotonic: monotonic monotone transformation on val set
- Conformal: split conformal with α=0.1 → 90% prediction interval

---

## 7. Evaluation (test set 기준)

### 7.1 Primary metrics

| Target | Metric | Acceptable | Stretch goal |
|---|---|---|---|
| jcr_jif | MAE (log scale) | ≤ 0.5 | ≤ 0.3 |
| jcr_jif | R² | ≥ 0.5 | ≥ 0.7 |
| jcr_jif | Spearman corr | ≥ 0.7 | ≥ 0.85 |
| RCR | MAE | ≤ 0.4 | ≤ 0.25 |
| Citation | MAE | ≤ 0.8 | ≤ 0.5 |
| Desk reject | AUROC | ≥ 0.75 | ≥ 0.85 |
| Conformal | Coverage (target 90%) | 88-92% | ±1% |

### 7.2 분야별 stratified eval

- 의학 vs 생명과학 vs 임상 vs 기초 — MAE 분포
- 신규 paper (2024+) vs old (2010-2020) — distribution shift 검출
- 분야 imbalance 확인

### 7.3 Baseline 비교

| Baseline | 비교 |
|---|---|
| **Naive**: median JIF in seed disease | FateCore 이게 ±50% 좋아야 함 |
| **Journal lookup only**: paper의 publication_types에서 추론 | FateCore retrieval feature 가치 검증 |
| **Embedding-only kNN**: top-K similar paper avg JIF | FateCore가 Q500 + meta로 더 잘하는지 확인 |
| **Q500 only**: 메타 없이 점수만 | features ablation |

### 7.4 Error analysis

- 가장 큰 MAE 50개 paper inspect
- 분야/연도/article type 분포 — systematic bias?
- 특정 Q500 item 가중치 — interpretability

---

## 8. Production Deployment

### 8.1 Server inference flow (`api/forecast.js`)

```
사용자 입력 (abstract + optional metadata)
    ↓
1. Rule extractors (regex 16개 → 29 Q500 items)         # 무료, ~100ms
    ↓
2. Gemini Flash API (Q100 LLM mode items)               # ~$0.001, 5-10s
    ↓
3. SPECTER2 embedding 생성                              # ONNX local 또는 S2 API, ~50ms
    ↓
4. Supabase pgvector cosine search → top-10 similar    # ~100ms
    ↓
5. Build feature vector (~950 dim)                      # ~10ms
    ↓
6. LightGBM forward (4 heads: JIF/RCR/Cit/DeskRej)      # ~5ms
    ↓
7. Isotonic + Conformal calibration                     # <1ms
    ↓
8. Format response (7 outputs)                          # ~10ms
    ↓
JSON response → 프론트엔드 시각화
```

총 latency: ~6-15초 (Gemini Flash가 bottleneck)

### 8.2 모델 가중치 deploy

```
weights/
├─ fatecore-v0.1-jcr_jif.txt        (~5 MB, LightGBM native)
├─ fatecore-v0.1-icite_rcr.txt      (~5 MB)
├─ fatecore-v0.1-citations_log.txt  (~5 MB)
├─ fatecore-v0.1-desk_reject.txt    (~5 MB)
├─ calibration.json                  (~100 KB, isotonic + conformal q)
└─ feature-schema.json               (~10 KB, column order + NA encoding)
```

총 ~25 MB → Vercel function unzipped 50 MB 한계 안.

### 8.3 Corpus 임베딩 (별도 Supabase pgvector)

- 866K papers × 3 KB = ~3 GB
- Supabase 무료 500MB 부족 → $25/월 plan
- 임베딩 + minimal metadata (title, year, jcr_jif, doi)
- cosine similarity index

---

## 9. Phase별 로드맵

### Phase 1 (v0.1) — 베이스라인 (2주)
**Goal**: 작동하는 첫 모델, MAE 어느 정도인지 측정.

- Step 1.1: 코덱스 작업 완료 대기 (~1시간)
- Step 1.2: `build-fatecore-features.mjs` 실행 → 80K paper × 156 cols CSV
- Step 1.3: `train-fatecore-v0.1.py` 실행 → LightGBM separate per target
- Step 1.4: Test set evaluation → metrics 보고
- Step 1.5: Error analysis 상위 50 paper inspect

**산출**: `weights/fatecore-v0.1-*.txt`, `docs/EVAL_v0.1.md`.

### Phase 2 (v0.2) — 학습 데이터 보강 (2-3주)
- Step 2.1: Author features (OpenAlex authors API enrichment)
- Step 2.2: PMC full-text 50% 이상 covered 대기 → Q500 본문 채점 추가
- Step 2.3: LLM 채점 (Gemini Flash paid tier) → strong labels 10,000 paper
- Step 2.4: Multi-task LightGBM (shared base)
- Step 2.5: Conformal calibration 분야별 stratified

**산출**: `weights/fatecore-v0.2-*.txt`, MAE 20% 개선 목표.

### Phase 3 (v0.3) — Retrieval-augmented (2주)
- Step 3.1: Supabase pgvector setup + 임베딩 upload
- Step 3.2: `api/forecast.js`에 retrieval 단계 추가
- Step 3.3: Retrieval features 학습 데이터에 포함
- Step 3.4: 모델 재학습

### Phase 4 (v1.0) — Production-ready (3-4주)
- Step 4.1: 분야별 calibration
- Step 4.2: Domain detection (사용자 input → 의학/생명과학/공학 자동 분류)
- Step 4.3: Confidence display UI
- Step 4.4: A/B test framework

### Phase 5 (v1.x+) — 확장
- 신경망 encoder ensemble
- 전체 학술 분야 (의학+생명과학 → 화학/공학/CS)
- 실시간 모델 업데이트 (월 1회 재학습)

---

## 10. Risks + Mitigations

| Risk | 영향 | Mitigation |
|---|---|---|
| **JIF label sparsity** (10%) | 학습 데이터 부족 | RCR + citation을 multi-task로 보강. 80K paper로 baseline 가능 |
| **JIF year volatility** (Lancet 2020=70 → 2023=160) | label noise | Random split + log scale + journal-level smoothing |
| **코덱스 채점 binary tendency (1/4 peak)** | weak supervision noise | sample_weight 0.5로 down-weight + LLM 채점으로 보강 |
| **Field imbalance** (의학 80%, 화학 5%) | 일반화 한계 | Stratified sampling. v1.0에 분야별 calibration |
| **Embedding domain shift** (SPECTER2 = 의학 중심) | 비의학 paper에서 정확도 ↓ | 분야별 임베딩 모델 (ChemBERTa, SciBERT) v1.0 |
| **Recent paper citation unavailable** (2024+) | training data shrink | Multi-task로 RCR/citation 부족 보완 |
| **Server inference latency** (Gemini 5-10s) | UX 저하 | Rule extractor 우선 → Gemini는 분당 8 RPM 사용 안 함 위치만 |
| **DB lock during concurrent write** | 학습 데이터 빌드 fail | 코덱스 끝나길 기다림 (1.5h). 또는 DB snapshot 복사 |

---

## 11. 구현 순서 (사용자 승인 후)

### 즉시 (코덱스 끝나는 즉시)
1. `build-fatecore-features.mjs` 실행 → CSV
2. CSV inspect (분포, missing rate, label coverage)
3. `train-fatecore-v0.1.py` 실행 → 첫 모델 + metrics

### 1일 안
4. Error analysis → 가장 큰 잘못된 예측 paper 50개 검토
5. 분야별 stratified eval
6. Feature importance ranking → Q500 어느 항목이 가장 중요한지

### 1주 안
7. v0.1 사용자 review용 데모 페이지 (paperfate.com 신규 manuscript 시도)
8. Author enrichment 시작 (Phase 2 시작)

### 1개월 안
9. PMC 본문 채점 + Q500 확장
10. v0.2 학습 완료
11. Production deploy

---

## 12. 결정 사항 (사용자 답변 반영 — 2026-05-21)

1. **모델 구조**: ✅ **통합 모델** (v0.1). v1.0 단계에서 분야별 calibration 추가 고려.

2. **JIF normalization**: ✅ **A 채택** — `log(jcr_jif + 1)` 학습 + 사용자 표시에는 두 형태:
   - JIF 절대값 (e.g. "Predicted JIF: 8.5")
   - 분야 내 percentile (e.g. "Top 8% within Oncology")

3. **Target journal**: ✅ **Optional UI input**.
   - 명시 시: 그 저널의 metadata가 X에 포함 → desk-reject risk 정밀화
   - 명시 X 시: top-3 best fit journal 추천 (retrieval-based)
   - Multi-target FateCore 출력: "Predicted JIF if accepted here" + "Acceptance prob given this target"

4. **Q100 vs Q500 트리거**: ✅ **자동 결정** by user 입력 길이/유형:
   - User가 abstract만 입력 → Q100 (100 items, Gemini ~$0.001)
   - User가 full manuscript 업로드 → Q500 (507 items, ~$0.005)
   - Frontend UI는 두 입력 모드 토글 제공 (이미 `Simulator.jsx`에 구현됨)

5. **Cold start = default flow** (사용자 통찰):
   - 사용자가 입력하는 paper는 **항상** 코퍼스에 없는 신규 paper
   - 따라서 "cold start"가 예외가 아니라 **default**.
   - **→ 큰 design 영향: Features를 시간축으로 분리해야 함** (§3.7 참조).

6. **신뢰도 UI**: ✅ **Conformal interval + confidence score 둘 다** 표시.
   - Conformal: `Predicted JIF 8.5 [4.2 – 16.3, 90%CI]`
   - Confidence: 별도 0-100 점수 (Q500 채점 신뢰도 + retrieval similarity 평균)
   - 전문가는 CI 보고, 일반 사용자는 confidence 본다.

---

## 3.7 🚨 Pre-publication vs Post-publication features (사용자 #5 통찰 반영)

**문제**: 사용자가 paperfate.com에 입력하는 paper는 항상 "submit 직전 신규 paper" — citations, fwci, RCR 등은 **존재하지 않음**. 학습 시 이런 feature를 X에 포함하면 추론 시 모두 NULL → 모델 generalize 실패.

### Feature 시간축 분리

**X_pre (학습 + 추론 둘 다 사용 가능 — production-safe)**:
```
Q500 scores                           # 사용자 abstract/manuscript에서 추출
publication_year (now or near-future)
publication_types (RCT, observational 등 — manuscript에서 추정)
mesh_terms (자동 추출 가능)
author_count, has_first_affiliation
target_journal_metadata (사용자 명시 시):
  - j_h_index, j_two_yr_mean_citedness
  - j_is_oa, j_apc_usd
  - j_jcr_jif_5yr (현재 시점 저널 평균 — 미래 paper에 사용 OK)
manuscript_embedding (SPECTER2 — abstract 텍스트만 있으면 OK)
retrieval_features (corpus similar paper의 outcome 통계 — corpus는 history라 가용)
```

**X_post (학습만 사용 가능 — 추론 불가, 절대 X에 포함 X)**:
```
citations_openalex, citations_s2, citations_crossref
fwci, icite_rcr, icite_nih_percentile
icite_apt, icite_citations_per_year
influential_citations
pmc_*_count (full-text는 publish 후에만 PMC에 들어감)
unpaywall_is_oa, unpaywall_best_oa_url (publish 후 OA status)
```

→ 이들은 **y label 후보**로만 사용 (jcr_jif, RCR, citations).

### 학습 시 절차

```python
# build-fatecore-features.mjs 수정 필요
feature_cols = X_pre_cols    # 약 130 cols (Q500 100 + metadata 30)
label_cols = [
  'y_jcr_jif',          # journal_year_metrics.jcr_jif (target year)
  'y_icite_rcr',        # papers.icite_rcr
  'y_citations_log',    # log(citations_openalex + 1)
  'y_desk_reject',      # binary
]
# X_post columns는 schema에 기록만 (ablation 비교용), 학습 X에 미사용
```

### 추론 시 (production)

```javascript
// api/forecast.js
const pre_features = {
  q500_scores: scoreManuscriptWithGemini(text),     // ✓
  publication_year: new Date().getFullYear() + 1,    // 가정
  publication_types: inferFromText(text),            // ✓
  mesh_terms: inferFromText(text),                   // ✓
  author_count: user.providedAuthors?.length || 1,   // ✓ (UI input)
  target_journal: user.targetJournal,                // ✓ (optional UI)
  manuscript_embedding: generateSpecter2(text),      // ✓
  retrieval_features: searchSupabase(embedding),     // ✓
}
const forecast = fatecore.predict(pre_features)
```

추론 시 X_post 컬럼은 NULL — 모델이 한 번도 사용 안 했으니 generalize에 문제 없음.

### v0.1 변경 사항

1. `build-fatecore-features.mjs` 수정 — X_pre만 출력 (X_post 컬럼 schema에 'ablation_only' 표시)
2. `train-fatecore-v0.1.py` — drop_cols에 모든 X_post columns 명시
3. 별도 ablation 학습: X_pre + X_post → "ground truth bound" baseline 비교용 (production 사용 X)

→ Model의 production-time 정확도가 학습 시 평가와 일치하게 됨.

---

## 13. 작성자 메모

이 설계는 **현재 데이터** (paperfate.db 26M+ paper_scores, 866K papers) 기준. 코덱스 작업 끝나면 ~80M scores 예상.

학습 데이터 준비는 이미 `scripts/build-fatecore-features.mjs` + `scripts/train-fatecore-v0.1.py`로 minimal 작성 완료 — 사용자 승인 시 실행만 하면 됨.

🚨 **사용자 명시 원칙 다시 환기**:
- 학습/검증 split은 **random만** — 연도 기반 split 절대 금지 (`feedback_fatecore_validation.md`)
- 학습은 로컬 PC, 추론만 서버 (Vercel function)
- Production 임베딩은 Supabase pgvector로 export 필요 (Phase 3)
- paperfate.db는 영원히 로컬 single source of truth

승인 후 Phase 1 단계별 실행 → 결과 보고 → 다음 Phase 결정. 한 번에 모든 Phase 약속 X.
