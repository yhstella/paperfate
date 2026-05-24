# 코덱스 작업 — 2026-05-24 Round 3 (URGENT)

> Round 2 v0.3 deploy는 **rollback**됨 (commit 12bdfea). v0.3 모델이 **심각한 데이터 누수**를 가지고 있음을 메인이 production endpoint cold-start 테스트로 확인.
>
> **EMPA-REG cold-start prediction**:
> - v0.2-prod: JIF 1.255 (CI 0.26-2.26) ← 사용자가 운영 중인 baseline
> - v0.3:      JIF **0.61** (CI 0.46-0.78) ← 더 나쁨, rollback 필요
>
> R²=0.9525는 **fake**. 테스트셋이 published paper들이라 `icite_citation_count`, `citations_openalex`, `fwci` 같은 post-publication features가 채워져 있었음. 실제 submission 시점엔 모두 NaN/0 → 모델이 "citations=0 → 매우 낮은 JIF journal" 로 예측.

---

## 핵심 원칙 (반드시 준수)

### Pre-submission 이란?

논문이 **아직 출간되지 않은 상태**에서 사용자가 paperfate.com에 입력하는 시점. 알 수 있는 것:

| 구분 | 사용 OK | 사용 금지 |
|---|---|---|
| 본문 | title, abstract, methods/results/discussion (사용자 입력), references list (저자가 입력한 ref list) | — |
| 메타 | year (submission year), authors (이름 list), funder (manuscript에 작성됨), MeSH (저자가 입력하거나 추정), 출판 type | — |
| Author features | 첫/마지막 저자의 h-index (외부 lookup 가능), team size, international collab | — |
| Journal | 전년도 이전 historical JIF/JCI/citedness (`j_hist_*` from `journal_year_metrics` where year < paper.year) | 같은 연도 journal metrics |
| Citations | ❌ **모두 금지** | `icite_citation_count`, `citations_openalex`, `citations_s2`, `citations_crossref`, `fwci`, `fwci_topic_norm` |
| iCite signals | ❌ **금지** | `icite_rcr`, `icite_nih_percentile`, `icite_apt`, `icite_cited_by_clin` (모두 publication 후 계산됨) |
| Fulltext | ❌ **금지** | `pmc_body_word_count`, `epmc_body_word_count`, `pdf_body_chars`, `pmc_figure_count`, `pmc_table_count`, `pmc_ref_count` (PMC에 deposit된 것 자체가 publication 증거) |
| NIH grant | ✅ OK | `has_nih_grant`, `n_nih_grants` (funding은 submission 전 결정됨) |
| Unpaywall | ❌ 부분 금지 | `unpaywall_is_oa`, `unpaywall_journal_oa`, `unpaywall_journal_doaj` (출간 후 indexed) — 단 journal 자체의 OA 여부는 journal metadata에서 별도 lookup 가능 |
| Preprint | ✅ OK if user explicitly indicates | `preprint_doi`, `preprint_pub_gap_days` (preprint은 submission 전이지만 sentence가 짧음) |
| Q500 scores | ✅ OK | `q_score_mean`, `q_score_sd`, `q_numeric_count`, etc — 사용자 input 본문에서 직접 계산되므로 |
| Has PMCID | ❌ 금지 | `has_pmcid` — PMCID 부여는 publication 후 |
| Has PDF source | ❌ 금지 | `has_pdf_source_url` |
| Has preprint | ✅ OK | `has_preprint` 등 user 입력 |

---

## 작업 1 (URGENT) — v0.3-prepub 학습

### Deliverable
1. **scripts/build-fatecore-features-v0.3-prepub.mjs** (기존 v0.3 mjs 수정):
   - **위 표의 금지 컬럼 모두 제거**
   - 남는 features 약 30-40개 추정 (66개에서 절반 정도)
   - 출력: `E:\paperfate\data\features\v0.3-prepub-features.csv`
2. **scripts/train-fatecore-v0.3-prepub.py**:
   - 기존 train-fatecore-v0.3.py 와 같은 random 80/20 split, log target, class weighting
   - 출력: `weights/fatecore-v0.3-prepub-*.txt`, `weights/fatecore-v0.3-prepub-metrics.json`
3. **scripts/eval-fatecore-v0.3-prepub.py**:
   - 정직한 평가
   - **반드시 v0.2-prod와 비교** (0.435)
   - tier-stratified MAE (top JIF≥30 / high 10-30 / mid 3-10 / low <3)
   - top 30 features (post-pub feature 0개 확인)
4. **docs/EVAL_v0.3-prepub.md**:
   - v0.2-prod 대비 delta
   - 어떤 features를 제외해서 무엇이 좋아졌는지/같은지
   - **Deploy rule**: `R²(jcr_jif) ≥ 0.48` AND `pre-submission features only` 확인

### 기대 결과
v0.3-prepub의 R² (jcr_jif) 예상: **0.45-0.55** (v0.2-prod 0.435 보다 약간 좋아질 것)
- 좋아지는 이유: NIH grant, author h-index, fwci_topic_norm (도메인 정규화) 신규 features
- 단, post-pub feature 빠지므로 R²=0.95처럼 fake high score 안 나와야 정상

만약 R² 0.45 미만이면 → 그냥 v0.2-prod 유지 (deploy 안 함)

---

## 작업 2 — v0.3-prepub deploy (조건부)

### 조건
작업 1 결과 `R²(jcr_jif) ≥ 0.48` 이고 honestly trained (post-pub feature 0개) 확인.

### Deliverable
1. `src/server/fatecoreInference.js` TARGETS을 `fatecore-v0.3-prepub-*.txt` 로 변경
2. version `fatecore-v0.3-prepub`
3. **EMPA-REG cold-start production test** — 반드시 v0.2-prod prediction (JIF 1.25)와 가깝거나 더 좋아야 함. 갑자기 0.5처럼 떨어지면 즉시 rollback.
4. Push + Vercel deploy 후 production verify

### 만약 안 좋으면
v0.2-prod 유지. v0.3-prepub 작업물은 weights/에 보존만.

---

## 작업 3 — v0.3 leakage 사후 분석 (필수, 짧게)

### Deliverable
`docs/V0.3_LEAKAGE_POSTMORTEM.md`:
1. 어떤 features가 leak인지 표
2. 왜 R²=0.95가 fake인지 mechanistic 설명
3. 이번에 배운 점 (post-pub feature 식별 체크리스트)
4. 향후 모든 학습 round에서 적용할 leakage filter rule

---

## 메인 세션 진행

- Production 즉시 v0.2-prod 로 rollback됨 (commit 12bdfea, push 완료)
- OpenAlex enrichers + PMC S3 (코덱스 Round 1 hardened) + PDF 가동 중
- 코덱스 Round 2 Task 3 (OpenAlex references collector) — 백그라운드 가동 중, 그대로 둠

---

## 주의

1. **Pre-submission feature 정의 위반 절대 금지**. 위 표를 그대로 따를 것.
2. **R² 너무 높으면 의심**. 0.7 이상이면 leakage 가능성 점검. honest pre-pub model의 ceiling은 약 0.55-0.60 정도.
3. **Production deploy 전 EMPA-REG cold-start test 필수**.
4. **인계장**: `docs/CODEX_HANDOFF_2026-05-24_ROUND3_TASK<N>.md`.

---

## 시작 신호

작업 1부터 즉시. 메인 세션도 데이터 수집 계속 진행 중.
