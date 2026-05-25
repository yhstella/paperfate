# 코덱스 작업 — Phase 3 (2026-05-22 오후, 데이터 수집 최대화)

> Phase 2 작업 (bioRxiv matching, auto-ingest watcher, Q500 fulltext) 진행 중. 그 위에 데이터 수집 폭을 최대로 확장. v0.3 학습 + 사용자 신뢰도 향상이 목표.

---

## 평가 (Phase 2 review)

### 매우 잘 한 것 ✅
1. **Q500 fulltext scoring**: 어제 0 → **91K papers, 28M scores 추가**. mode='codex_deterministic' 119.4M rows.
2. **BioRxiv matching**: 52K / 498K processed, **5,194 papers에 preprint_doi 매칭** (~10% match rate). Crossref relations API로 작동 검증.
3. **Auto-ingest watcher**: state 파일 + log 작동. OpenAlex/EPMC 완료 시 자동 ingest 예정.

### 미해결 / 진행 중 (계속 가동)
- BioRxiv matching: ETA ~30시간 (rate-limit polite)
- Q500 fulltext: 91K / ~300K papers 채점됨

---

## 현재 데이터 gap (왜 Phase 3가 필요한가)

```
papers: 2,281,270
  abstract:       94.7%   ← 좋음
  embedding:      24.3%   ← 더 채울 수 있음 (S2 enrich)
  icite_rcr:      33.9%   ← collector 완료 후 ingest 다시 필요
  openalex:       18.3%   ← 70% 진행 중
  first_author_h: 15.5%   ← propagation 추가 가능
  pmcid:          13.0%   ← 297K, OK
  epmc fulltext:   5.3%   ← 121K, 더 가능 (77% collector 진행)
  pmc fulltext:    0.4%   ← 9.4K 매우 부족 ← Phase 3 우선순위
  preprint:        0.2%   ← Phase 2 진행 중
```

특히 PMC/EPMC full-text가 부족해서 Q500 본문 채점이 91K paper로 제한됨. **fulltext 가용 paper 30만+ 만들기**가 가장 가치 큰 목표.

---

## 작업 1 (HIGHEST) — PMC full-text 가속 (EPMC fullTextXML로 우회)

### 상황
- PMC collector (NCBI efetch): 4.4/s 매우 느림 → 9,426 papers only
- EPMC fullTextXML collector: 2.2/s but PMC와 동일 콘텐츠 fetch 가능
- PMCID 매핑 완료: **297,426 papers** (가용 fulltext source)

### 문제
- EPMC collector 단독으로는 77% (74K) 진행 중
- 17만+ papers의 PMC fulltext 빠진 채로 v0.3 학습 진행 시 본문 features 손실

### Deliverable
1. **`scripts/collect-pmc-via-epmc.mjs`** 작성 — PMCID list 직접 사용
   - PMCID 297K 전부 input
   - EPMC URL: `https://www.ebi.ac.uk/europepmc/webservices/rest/{PMCID}/fullTextXML`
   - parallel=8, 5/s rate
   - 출력: 기존 `data/europepmc-fulltext/*.jsonl`과 같은 폴더 (또는 새 폴더)
   - resume 안전: 이미 fetch된 PMCID skip

2. 예상 결과: **120K → 250K papers fulltext** (2배 증가) in ~15시간

3. 완료 후 `build-unified-db --only=epmc` 자동 trigger (auto-ingest-watcher가 처리)

### Success criteria
- EPMC fulltext rows ≥ 250K (현재 121K)
- Q500 fulltext scoring 가능 paper ~300K (현재 91K)

### 시간 estimate
- 코드: 30분 (EPMC collector clone + 입력 변경)
- Run: 15시간 background

---

## 작업 2 (HIGH) — Unpaywall PDF full-text 수집

### Goal
PMC + EPMC 외 추가 fulltext source. Unpaywall은 paper의 best_oa_url을 제공 (PDF 또는 HTML).

### 상황
- Unpaywall 데이터: 726K papers의 OA 정보 (papers 테이블에 ingested)
- `unpaywall_best_oa_url`: 약 250K papers에 PDF URL
- 기존 `scripts/collect-pdf-fulltext.mjs` 있음 — 어제 5K pilot만 (success 91%) 진행

### Deliverable
1. **`collect-pdf-fulltext.mjs`** 본격 실행 — 250K target
   - `--limit 250000 --parallel 6 --per-host-rps 1.5`
   - polite per-publisher throttle (Elsevier, Springer, Wiley 등)
   - pdfjs 본문 추출
   - 출력: `data/pdf-fulltext/all-*.jsonl`

2. **ingest**: build-unified-db에 이미 `ingestPdfFulltext()` 있음

### 결과
- PDF fulltext rows: 442 → ~100K-150K (publisher PDF availability에 따라)
- Q500 본문 채점 가능 paper 추가 확보

### Success criteria
- 100K+ papers에 `pdf_body_chars` 채워짐
- 일부 publisher rate-limit/CAPTCHA로 실패 — 정상 (50-60% success rate 예상)

### 시간 estimate
- Full run: 30-50시간 (publisher rate-limit, 0.3-0.5/s)
- background gradual run OK

---

## 작업 2b (HIGH) — bioRxiv full-text XML 수집 (별도 테이블, retrieval corpus)

### Goal
bioRxiv preprint XML fulltext 수집. ⚠️ **papers 테이블에 mix하지 않음** — preprint은 publish JIF 없어 학습 X-y 쌍 형성 불가 (사용자 지적).

### 사용처
- v0.4+ retrieval corpus (similar paper search)
- 별도 "preprint → 어느 저널" 예측 task의 학습 데이터
- Q500 채점은 가능 (abstract + body만 있으면)

### Deliverable
1. **새 테이블 `preprints`** (별도, papers와 분리):
   ```sql
   CREATE TABLE preprints (
     doi TEXT PRIMARY KEY,
     server TEXT,           -- 'bioRxiv' / 'medRxiv'
     title TEXT,
     abstract TEXT,
     body_text TEXT,        -- full XML 본문 (compressed)
     authors_json TEXT,
     posted_date TEXT,
     version INTEGER,
     license TEXT,
     matched_paper_doi TEXT, -- 매칭된 published paper DOI (있으면)
     fetched_at TEXT
   );
   ```

2. **`scripts/collect-biorxiv-fulltext.mjs`**:
   - bioRxiv jsonl의 DOI → bioRxiv API: `https://api.biorxiv.org/details/{server}/{doi}/json`
   - 또는 직접 XML: `https://www.biorxiv.org/content/{doi}.full.xml`
   - 498K preprints — gradual fetch (~수일)

### Success criteria
- preprints 테이블 ≥ 100K rows with body_text
- papers 테이블 unaffected (preprint mix X)

### 시간
- 코드: 1시간 (collector + ingest)
- Run: 수일 background

### Defer 조건
PMC + EPMC + PDF fulltext가 충분히 모인 후. v0.4 retrieval 필요할 때.

---

## 작업 3 (MEDIUM) — NIH RePORTER funding data collector

### Goal
Paper의 funding info (NIH grants, sponsors) 수집. Q500 funding 항목 정확화 + journal predict feature.

### 상황
- 현재 funding: Crossref funder_json만 (45% coverage)
- NIH RePORTER (https://api.reporter.nih.gov/v2) — 무료, 한국 IP 가능
  - Grant info: PI, institution, amount, abstract, project terms

### Deliverable
1. **`scripts/collect-nih-reporter.mjs`**:
   - 우리 papers의 PMID list → RePORTER로 grant linkage
   - 또는 papers.funder_json에서 NIH grant numbers 추출 → RePORTER lookup
   - 결과: `data/nih-reporter/*.jsonl`

2. **DB schema 추가** (또는 기존 funder_json 확장):
   - `papers.nih_grants_json` — [{grant_id, pi_name, institution, project_terms}]
   - 또는 별도 `nih_grants` 테이블

3. **ingestion**: build-unified-db에 추가

### Success criteria
- 100K+ papers에 NIH grant linkage
- Q500 funding 항목 정밀화

### 시간
- 4-6시간 (NIH RePORTER API 학습 + 코드)

### Defer 조건
PMC fulltext 가속이 더 중요 — 작업 1 끝나면 시작.

---

## 작업 4 (MEDIUM) — OpenAlex citation network depth (referenced_works)

### Goal
각 paper의 references (citations 받은 쪽, 한 hop 깊이) → SPECTER2 embedding 보강 + retrieval features

### 현재
- papers.reference_count: S2 기반 (~50K)
- 실제 referenced paper list 없음

### Deliverable
1. **`scripts/collect-openalex-references.mjs`**:
   - Top 100K paper (high JIF 또는 popular) target
   - OpenAlex /works/{id} 의 `referenced_works` field fetch
   - 각 paper × ~30 references = ~3M reference rows

2. **DB schema**:
   - `paper_references` 테이블: `(doi, ref_doi, ref_openalex_id)` 
   - PK (doi, ref_doi)

3. v0.3 학습 시 feature:
   - Reference의 평균 JIF (paper의 reading network quality)
   - Reference recency
   - Reference 분야 diversity

### Success criteria
- 100K papers × ~30 references = 3M reference edges

### 시간
- 8시간 (100K paper × 25 req/s polite)

### Defer 조건
v0.3 학습 시점에 필요할 때 시작. 작업 1, 2 끝난 후.

---

## 작업 5 (LOW) — JCR JIF historical depth (2010-2020 추가)

### 상황
- 현재 JCR data: 2022, 2024, 2025만 (10,990 rows)
- 학습 시 y_jcr_jif는 paper의 publication year기준 — 2010-2020 paper의 정확한 historical JIF 없음

### 가치
- 2014-2019 paper (현재 큰 비중) 학습에 정확한 label 가능
- Top tier paper (NEJM/Lancet) 의 historical JIF (50-100 range)

### Source 옵션
- Wayback Machine + Wikipedia (이미 시도 — 19.5% error rate, OK for v0.3)
- Web scraping ScimagoJR (이전에 IP 차단됨)
- Manual JCR archive (라이센스 위험)

### 권장
Wayback 다시 시도 + 더 robust parser. 또는 OpenAlex 2yr_mean_citedness historical (이미 있음, JIF-proxy).

### Defer 조건
v0.3 학습 직전 if needed.

---

## 작업 6 (LOW) — Q500 anchor 0/2/5 (Phase 2 이월)

Phase 2 작업 3 — 이미 인지. 작업 1-2 완료 후 다시 시작.

---

## 진행 권장

```
[Phase 2 진행 중인 것]
  - BioRxiv matching (5K matched / 52K processed, ~30시간 남음)
  - Q500 fulltext scoring (91K papers, ~수시간)
  - Auto-ingest watcher (대기)

[즉시 시작 — Phase 3]
  작업 1: PMC via EPMC fetch (15시간 background) ← 가장 큰 leverage
  
[작업 1 launch 후]
  작업 2: bioRxiv as papers (1.5시간) ← 사용자 결정 받고

[작업 1 끝나면]
  작업 3 (NIH RePORTER) 또는 작업 4 (references network)

[Phase 4 candidate]
  작업 5 (JCR historical)
  작업 6 (Q500 anchors)
```

---

## 주의

1. **NCBI API rate-limit 공유**: PMC + PubMed + iCite 동시 작업 시 충돌. 작업 1은 EPMC API 사용해서 NCBI와 분리.
2. **DB lock**: 모든 ingest는 busy_timeout=60s 설정. 충돌 자동 retry.
3. **사용자 가시성**: 작업 2 (bioRxiv as papers) 시작 전 사용자에게 확인 — papers 테이블에 preprint mix할지 결정.

---

## 시작 신호

이 메시지 받은 즉시 **작업 1 (PMC via EPMC)** 즉시 launch. background 가동 중에 작업 2, 3 코드 작성.

진행 보고는 30분마다 또는 마일스톤. 사용자 결정 필요 사항은 즉시 알림.
