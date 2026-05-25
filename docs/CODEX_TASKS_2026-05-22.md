# 코덱스 작업 지시 — 2026-05-22 (v0.2 학습 준비 phase)

> Claude은 FateCore v0.1을 paperfate.com에 production 배포 완료. 이제 v0.2 학습 준비 + 데이터 통합 단계. 코덱스가 병렬로 처리할 high-leverage 작업 4개.

---

## 평가 (이전 작업 review)

### ✅ 매우 잘 한 것
1. **Author enrichment 작업 1 완료** — 285,516 authors fetched, papers 테이블에 author_h_index 14.2% propagated. SQL+OpenAlex API 워크플로우 안정적.
2. **`fatecoreInference.js` 작성** — Node native LightGBM .txt parser, predict, calibration apply. paperfate.com production에서 실제 호출 중.
3. **`deterministicExtract.js` + `score-codex-batch-direct.mjs`** — Q100 100항목 deterministic scoring backbone. Vercel function 호환.
4. **`score-codex-deterministic-all.mjs`** — 819K papers × Q100 = **82M scores** 한 번에 처리. 매우 빠름 (157/s).

### 🟡 부분 완료
- Q500 본문 채점기 (작업 2): PMC fulltext가 충분히 안 차서 미시작 — 이제 EPMC fulltext 74K 있음
- Validation dashboard (작업 4): 미시작

### 미발견 이슈 (이제 발생)
- 어제 모은 jsonl (iCite 387MB, S2 8.6GB, Crossref 935K, OpenAlex 385K, EPMC 74K, authors 285K) 중 **papers 테이블에 ingest 안 된 것 다수**
- 결과: papers의 enrichment coverage가 아직 어제 수준 (S2 4.7%, embedding 3.7%, openalex 5.2%)
- 실제 jsonl 보유량은 30-90%까지 가능한 수준

---

## 작업 1 (HIGHEST PRIORITY) — build-unified-db 재실행 + 새 데이터 통합

### Goal
어제 모은 모든 jsonl을 papers 테이블에 ingest. v0.2 학습용 X feature가 모두 채워져야 의미 있는 학습 가능.

### 상황
```
jsonl 보유량 vs papers 테이블 coverage:
  OpenAlex:    385K rows in jsonl  →  papers 5.2% (45K)   ← gap 340K
  S2:          1M+ rows in jsonl   →  papers 4.7% (41K)   ← gap 960K
  Crossref:    949K rows in jsonl  →  papers 5.2% (45K)   ← gap 905K
  iCite:       1.12M rows (387MB)  →  papers 13.3% (115K) ← gap 1M+
  EPMC text:   74K rows in jsonl   →  papers 5.8% (50K)   ← gap 24K
  Authors:     285K rows           →  papers 14.2% (122K) ← propagate needed
```

### Deliverable

#### 1.1 build-unified-db 단순 재실행
```bash
DATA_ROOT=E:/paperfate/data node scripts/build-unified-db.mjs
```
- 모든 ingest 함수 idempotent — 안전
- 예상 시간: 15-30분 (1M jsonl rows × 8 sources)
- 진행 log 모니터링

#### 1.2 Author features를 papers 테이블에 propagate
현재 authors 테이블에 285K author profiles 있지만 papers 테이블의 first_author_h_index 등은 14% 채워짐 — 더 채울 수 있음.

`scripts/propagate-author-features.mjs` 작성 또는 build-unified-db에 추가:
```sql
-- For each paper with authorships_json having author_ids
-- Look up authors table for h_index/i10/etc.
-- Compute aggregates: first, last, max, median team h-index
UPDATE papers SET
  first_author_h_index = (SELECT h_index FROM authors WHERE openalex_id = papers.authorships_json[0].author.id),
  ...
```

실제로는 JavaScript에서 JSON 파싱 + aggregate 계산이 더 간단. SQL은 sqlite의 json1 extension 사용 가능하지만 복잡.

### Success criteria
- papers의 openalex_id coverage ≥ 40% (현재 5.2%)
- s2_id ≥ 95% (현재 4.7%, S2 batch endpoint 거의 완료)
- icite_rcr ≥ 70% (현재 13.3%)
- first_author_h_index ≥ 50% (현재 14.2%)

### 시간 estimate
- build-unified-db 재실행: 15-30분
- Author propagation: 20-30분
- 총: 1시간 안

### 주의
- 진행 중 다른 collectors가 jsonl에 계속 write 중 — ingest는 idempotent라 OK
- composite index (`doi, item_id, mode`)가 paper_scores에 있어 query 빠름

---

## 작업 2 (HIGH) — Q500 본문 채점 (PMC/EPMC fulltext 가용 paper에)

### Goal
v0.1 학습은 Q100 (abstract only) 만 사용. **본문 가용 paper에 Q500 추가 채점**하면 v0.2 학습 X 더 풍부.

### 상황
- PMC fulltext: 22K papers (느림, 7%)
- EPMC fulltext: 74K papers (77%) — 큰 진전
- 합계 가용: ~80-100K papers with full text (Q100과 별도)

### Deliverable

`scripts/score-codex-q500-fulltext.mjs`:
- `score-codex-batch-direct.mjs`의 패턴 따름
- **407 Q500 항목** 추가 (Q100 = 100, Q500 = 507)
- 본문 입력: `data/europepmc-fulltext/*.jsonl` 또는 `data/pmc-fulltext/*.jsonl` 의 `body_text`, `methods_text`, `results_text`, `discussion_text`
- mode='codex_deterministic' 동일 사용 (Q100과 같은 paper에 추가 채점, item_id로 구분)

#### 추가 항목 도메인 분포 (Q500 - Q100 = 407 items)
- STATS: +46 (Q500 55개, Q100 9개)
- BIAS: +39 (Q500 45, Q100 6)
- AIPRED: +37 (Q500 42, Q100 5)
- POPUL: +32 (Q500 40, Q100 8)
- DESIGN: +35 (Q500 45, Q100 10)
- 등 14 도메인 모두

#### Regex pattern 작성 가이드
본문에서 추출:
- `STATS_010` (multivariable adjustment): "adjusted for", "multivariable", "covariates included"
- `STATS_025` (regression coefficients): "β = ", "OR = ", "HR = "  
- `BIAS_010` (sensitivity analysis): "sensitivity analysis", "robustness check"
- `POPUL_020` (loss to follow-up): "lost to follow-up", "withdrew", "attrition"
- 등

### Success criteria
- 100K+ papers에 Q500 본문 항목 채점됨
- 항목별 NA 비율 < 80% (article type 부합)
- Avg score 분포 reasonable (binary 1/4 peak 줄임)

### 시간 estimate
- Regex 작성 (407 items): 4-6시간 (한 도메인씩 batch)
- 100K paper 적용: 1-2시간
- 총: 6-8시간

### Defer 조건
EPMC fulltext가 100% 안 되면 (현재 77%) 우선 가용 paper 만으로 진행.

---

## 작업 3 (MEDIUM) — PMC fulltext 가속화

### 상황
- PMC fulltext: 22K/304K (7%) — 매우 느림 (4.4/s)
- EuropePMC fulltext가 같은 PMC 콘텐츠를 fetch 가능 (74K 진행, 거의 같은 source)

### Deliverable
`collect-pmc-fulltext.mjs`의 Stage B (NCBI efetch) 를 EPMC fullTextXML로 fallback 또는 primary:

```javascript
// 현재 Stage B:
//   NCBI efetch db=pmc id=NUM → JATS XML
// 제안:
//   1순위: EPMC fullTextXML by PMCID (이미 작동 검증됨)
//   2순위: NCBI efetch (fallback)
```

EPMC가 NCBI보다 폼 단순 + 더 빠를 수도. 이미 collect-europepmc-fulltext.mjs가 PMCID 기반으로 fetch 하니, PMC와 같은 코드 사용 가능.

### Success criteria
- PMC fulltext rate ≥ 20/s (현재 4.4/s, 4-5배 가속)
- 24시간 안에 80%+ coverage

### Defer 조건
작업 2가 이미 EPMC fulltext (74K)로 충분히 학습 가능하면 — PMC 가속화는 우선순위 ↓.

---

## 작업 4 (LOW) — Validation dashboard

### Goal
4-mode 채점 (codex / rule / external / llm)의 일치도 분석. 학습 데이터 quality 검증.

### Deliverable

`scripts/validate-scoring-agreement.mjs`:
1. 같은 (doi, item_id)을 여러 mode가 채점한 cases 분석:
   - codex vs llm agreement rate
   - score 차이 분포
   - 어느 도메인이 가장 disagreement 많은지
2. Codex의 binary tendency (1/4 peak) 정량화:
   - score histogram 도메인별
   - NA/unknown 비율
3. 출력: `docs/EVAL_SCORING_v0.2.md`

### 시간 estimate
- 2-3시간

### Defer
- Phase 2 학습 직전에 한 번만 실행 — 학습 데이터 quality assurance용
- 사용자 결정 사항

---

## 진행 순서 권장

```
[NOW]
  작업 1.1: build-unified-db 재실행 (15-30분)   ← 즉시 시작
    ↓ 완료
  작업 1.2: Author features propagate (20-30분)
    ↓ 완료
  → Claude이 v0.2 학습 시작 가능 (log target + class weighting + new features)

[PARALLEL with 1]
  작업 2: Q500 본문 채점기 작성 + 적용 (6-8h)
    → v0.2.1 학습 시 Q500 features 추가

[LATER]
  작업 3: PMC 가속화 (필요 시)
  작업 4: Validation dashboard (v0.2 학습 직전)
```

---

## 주의사항

1. **DB write 충돌**: 작업 1 (build-unified-db)이 다른 활성 collectors와 같은 papers 테이블에 write — 충돌 가능. 가능하면 collectors 안 죽이고 진행 (sqlite WAL mode가 보호하지만 느려질 수 있음).
2. **paper_scores composite PK**: `(doi, item_id, mode)` — 같은 mode의 같은 item 중복 X. 작업 2의 mode는 'codex_deterministic' (Q100과 같음, item_id로 구분).
3. **Vercel deploy에 영향 없음**: 모든 작업은 backend / 학습용. paperfate.com production은 안전.
4. **paperfate.db 크기 증가 주의**: 현재 1.12GB → ingest 후 ~10-15GB 예상. E: SSD 1.85TB free라 OK.

---

## 시작 신호

이 메시지 받은 즉시 **작업 1.1 (build-unified-db 재실행)** 시작. 30분 후 결과 보고. 1.1 완료되면 1.2로 자동 진행.

작업 2는 1.2 완료 후 또는 병렬로 — 코덱스가 자체 판단.

진행 중 issue 시 사용자에게 알림.
