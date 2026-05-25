# 코덱스 병렬 작업 instruction (Phase 1 진행 중)

> Claude이 Phase 1 FateCore 학습 진행 중. 코덱스는 v0.2/production 준비를 병렬로 진행.
> 작성 시점: 2026-05-21, 코덱스 Q100 866K 완료 직후.

---

## 평가 + 감사

Q100 deterministic baseline 작업 완료 잘 했습니다:
- 819,902 papers × 100 items = **82M scores in paper_scores**
- 평균 157 paper/s — 매우 빠름
- mode='codex_deterministic'로 다른 채점과 분리 잘 됨

이제 다음 작업 — 우선순위 1번부터 순차 진행해주세요. 1번 완료 후 2번, 그 후 3번. 각 단계마다 sanity check.

---

## 작업 1 (HIGH PRIORITY) — Author features enrichment

### Goal
v0.2 학습용으로 가장 큰 missing 영역. Author identity가 paper outcome 예측의 강력한 signal.

### 현재 상황
- `papers.authors_json`: 저자 이름/소속만 있음. h-index 등 quality metric 없음.
- OpenAlex Authors API: `https://api.openalex.org/authors/{author_id}` — h_index, i10_index, 2yr_mean_citedness, works_count 제공
- `papers.authorships_json`: OpenAlex enrich로 author_id (`A123456789`) 있는 paper들. 약 45K paper.

### Deliverable
1. **scripts/collect-openalex-authors.mjs** 확장 또는 새로 작성
   - 코퍼스 paper에서 unique author_id 추출 (authorships_json 파싱)
   - OpenAlex /authors/{id} 호출 (polite pool, 25 req/s)
   - 결과 저장: `data/openalex-authors/all-YYYY-MM-DD.jsonl`
   - Idempotent (이미 fetch된 author skip)

2. **DB migration**: `authors` 테이블 추가
   ```sql
   CREATE TABLE authors (
     openalex_id        TEXT PRIMARY KEY,    -- A123456789
     orcid              TEXT,
     display_name       TEXT,
     works_count        INTEGER,
     cited_by_count     INTEGER,
     h_index            INTEGER,
     i10_index          INTEGER,
     two_yr_mean_citedness REAL,
     affiliations_json  TEXT,                 -- 최근 5년 institutions
     last_known_country TEXT,
     fetched_at         TEXT,
     ingested_at        TEXT DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_authors_h ON authors(h_index);
   ```

3. **build-unified-db.mjs에 ingestAuthors() 추가**

4. **Per-paper author features** — `papers` 테이블에 컬럼 추가 (또는 derived view):
   - `first_author_h_index`
   - `last_author_h_index` (corresponding author 추정)
   - `max_team_h_index`
   - `median_team_h_index`
   - `team_size_with_id` (author_id 있는 저자 수)
   - `international_collab` (multi-country flag)

### Time estimate
- Unique authors in corpus: ~500K-1M (대량 자료 collab paper 많음)
- 25 req/s polite pool, 1M authors → **11 hours**
- DB migration + ingest: 30분
- Per-paper feature aggregation: 10분

### Success criteria
- `authors` 테이블 ≥ 300K rows
- 학습 가능 paper의 ≥ 80%에 first_author_h_index 값 있음

---

## 작업 2 (MEDIUM PRIORITY) — Q500 본문 채점기 작성 + 적용

### Goal
v0.1은 Q100 (abstract) 만으로 학습. Q500 본문 항목 (407 items)을 채점하면 full manuscript 입력 시 더 정밀한 추론 가능.

### 현재 상황
- PMC full-text 진행 중 (현재 7%, 매우 느림)
- EuropePMC full-text 진행 중 (45%)
- 두 source 합쳐서 ~100K-200K paper에 full-text 가용 예상

### Deliverable
1. **scripts/score-codex-q500-fulltext.mjs**
   - `score-codex-batch-direct.mjs` 패턴 따라 작성
   - 407 추가 항목별 regex pattern (Q500.json items where Q100 != true)
   - 본문 입력: `papers.pmc_*` 또는 EPMC text (별도 jsonl)
   - mode='codex_deterministic'으로 같은 paper에 추가 채점

2. **Domain별 추가 항목 매핑** (작업 1에서 작성한 `score-codex-batch-direct.mjs` 확장):
   - STATS: regression/Cox/likelihood/ANOVA 등 detail
   - BIAS: confounding adjustment 방법, sensitivity analysis
   - AIPRED: train/val/test ratio, hyperparameter search, calibration
   - REPRT: PRISMA/STROBE checklist, supplementary materials
   - EXTV: external cohort 상세, 기간 등
   - FIGS: figure captions, KM curve, forest plot

3. **PMC fulltext 적용**
   - 본문 word count ≥ 500 paper만 대상
   - 결과: ~100-200K paper × 407 items = ~40-80M 추가 rows

### Time estimate
- 407 항목 regex 작성: 4-6시간 (한 도메인씩)
- 100-200K paper 채점 적용: 1-2시간 (코덱스가 PMC text 기반)

### Success criteria
- 100K+ paper에 mode='codex_deterministic' + Q500 항목 채점됨
- 도메인별 균등 분포 (한 domain만 NA가 100% X)

### Defer 조건
PMC full-text가 충분히 차지 않으면 (< 50K paper) 이 작업 미뤄도 됨. Q100만으로 v0.1, v0.2까지는 충분.

---

## 작업 3 (HIGH PRIORITY — Phase 1 학습 완료 직후 필요) — Server inference pipeline 구현

### Goal
현재 `api/forecast.js`는 mock. v0.1 학습 weights 나오면 즉시 실제 모델 로드 + predict로 교체.

### 현재 상황
- `api/forecast.js`: mock implementation, Gemini provider 설정만 있음
- `src/lib/forecastClient.js`: 프론트엔드 호출
- `src/server/extract.js`: forecastManuscript() — extract만 함, predict X

### Deliverable
1. **scripts/test-fatecore-inference.mjs** — 학습된 weights를 load해서 sample manuscript에 predict
   - LightGBM 모델 로드 (Node lightgbm 또는 .txt 직접 파싱)
   - X_pre feature vector 구성
   - Predict + calibration apply
   - JSON 출력

2. **api/forecast.js 실제 구현**
   ```javascript
   // 입력: { text, mode: 'abstract'|'full', target_journal?: {issn, name} }
   // 절차:
   //   1. extractMeta() — rule extractors (no LLM)
   //   2. Gemini Q100 채점 (mode=abstract) 또는 Q500 (mode=full)
   //   3. SPECTER2 임베딩 생성 (S2 API 또는 ONNX local)
   //   4. retrieval (later — Supabase pgvector. v0.1은 placeholder)
   //   5. FateCore predict (4 heads: JIF/RCR/Citations/DeskReject)
   //   6. Isotonic calibration apply
   //   7. Conformal interval apply
   //   8. Response 형식:
   //      {
   //        predictions: {
   //          jcr_jif: { point: 8.5, ci_low: 4.2, ci_high: 16.3, percentile_in_field: 92 },
   //          icite_rcr: { point: 2.1, ... },
   //          citations_5yr: { point: 45, ci_low: 12, ci_high: 180 },
   //          desk_reject_risk: { point: 0.15, ci_low: 0.05, ci_high: 0.32 },
   //        },
   //        domain_scores: { ... },  // Q500 도메인별 평균
   //        weakness: [...],          // 가장 낮은 Q500 항목 5개
   //        similar_papers: [...],    // (v0.3까지 mock)
   //        confidence: 0.78,
   //        cost_usd: 0.002,
   //      }
   ```

3. **weights/ deploy 준비**
   - Phase 1 학습 결과 (~25MB) → GitHub commit 가능 크기
   - 또는 GitHub LFS / 외부 hosting

### Time estimate
- LightGBM .txt parser (Node native): 2-3시간
- api/forecast.js 실제 구현: 4-6시간
- 통합 테스트 with mock weights: 1시간

### Success criteria
- `node scripts/test-fatecore-inference.mjs` — sample manuscript로 prediction 성공
- paperfate.com에서 사용자 manuscript 입력 시 5-15초 안에 forecast 응답
- LightGBM weights size ≤ 30MB (Vercel function limit 안)

---

## 작업 4 (LOW PRIORITY — 시간 남으면) — Validation dashboard

### Goal
3개 채점 출처 (codex / external / rule / llm) 일치도를 시각화. 학습 데이터 quality 검증.

### Deliverable
1. **scripts/validate-scoring-agreement.mjs**
   - paper별로 mode 4종이 동의/불일치한 항목 분포
   - 출처별 confidence 분포
   - Codex의 binary tendency (1/4 peak) 정량화

2. **출력**: `docs/EVAL_SCORING_v0.1.md` — Markdown 보고서

### Defer 조건
v0.1 학습 안 끝났으면 skip. 학습 후 model interpretation에 활용.

---

## 진행 방식

- 작업 1 (Author enrichment) 즉시 시작 — 10시간 long-running이라 일찍.
- 작업 1 launch 직후 작업 3 (Server inference) 코드 작성 시작 (병렬).
- 작업 2 (Q500 본문)는 PMC full-text 수집 진행률 50%+ 도달 후 시작 권장.
- 작업 4는 v0.1 학습 metrics 나온 다음.

각 작업 완료/문제 시 사용자에게 보고. 시간 견적 크게 빗나가면 알림.

---

## 주의사항

- DB write 충돌 방지: Claude가 `papers` 테이블 read 중일 수 있음. 작업 1 (authors 테이블)은 새 테이블이라 충돌 X. 작업 3은 read-only.
- 새 mode 사용 시 paper_scores composite PK 활용 (doi, item_id, mode) — 기존 codex_deterministic 덮어쓰기 X
- Author enrichment 진행 중 OpenAlex rate-limit 주의 (polite pool 25 req/s — `OPENALEX_EMAIL` env 설정해 polite 표시)

---

## 시작 신호

이 메시지 받은 즉시 작업 1 (Author enrichment) 시작. 작업 1이 launch되면 작업 3 (Server inference) 코드 작성 병렬로. 진행 보고는 30분마다 또는 마일스톤마다.
