# PaperFate Data Dictionary

> **목적**: paperfate.db의 모든 컬럼이 (1) 무엇을 의미하는지 (2) 어디에서 왔는지 (3) 어떻게 QC되는지 (4) Q100/Q500/FateCore 개발 시 어떻게 활용되는지 단일 문서로 정리.
>
> **버전**: 2026-05-21 (DB schema 186 cols / 4 main tables, after Phase 1 expansion)
>
> **유지 원칙**: 컬럼이 추가/이름 변경되면 이 문서를 같이 업데이트한다. 자동 QC 스크립트 `scripts/qc-database.mjs`는 이 문서의 룰을 코드로 강제한다.

---

## 0. 개요

### 0.1 데이터 흐름 (ETL)
```
                  ┌─ PubMed E-utilities ────────┐
                  ├─ OpenAlex API ──────────────┤
원본 코퍼스       ├─ Semantic Scholar API ─────┤        SQLite
  (.jsonl)        ├─ Crossref REST ────────────┤────►   paperfate.db
                  ├─ iCite (NIH RCR) ──────────┤        (papers / journals /
                  ├─ Unpaywall ─────────────────┤         journal_year_metrics /
                  ├─ ClinicalTrials.gov ────────┤         clinical_trials)
                  ├─ PMC OA / Europe PMC XML ──┤
                  ├─ Unpaywall PDF text ────────┤
                  ├─ bioRxiv / medRxiv ─────────┤
                  ├─ JCR JIF (.xlsx) ───────────┤
                  ├─ Wayback (historical JIF) ──┤
                  └─ Wikipedia (current JIF) ───┘
```
- 모든 JSONL은 `$DATA_ROOT/<source>/all-YYYY-MM-DD.jsonl` 형식 (idempotent).
- `build-unified-db.mjs`가 ETL의 L 단계. 모든 ingest는 ON CONFLICT/UPSERT idempotent.
- 컬럼 추가는 `migrateAddMissingColumns()` 안에서 `ALTER TABLE ADD COLUMN`. **테이블을 재생성하지 않는다** (기존 데이터 보존).

### 0.2 매칭 키
| 키 | 정합성 | 사용처 |
|---|---|---|
| **PMID** (TEXT) | 1:1, PubMed 권위 | papers ↔ iCite / EPMC fulltext / PMC mapping |
| **DOI** (lowercase TEXT) | 1:1, 대부분 안정 | papers ↔ OpenAlex / S2 / Crossref / Unpaywall / PDF / bioRxiv |
| **ISSN-L** (TEXT) | 1:N (저널은 여러 ISSN) | papers.issn ↔ journals / journal_year_metrics |
| **PMCID** (TEXT, "PMC"+숫자) | OA 논문에만 존재 | papers ↔ PMC fulltext |
| **OpenAlex ID** | URL 형식 (W…/S…) | works(papers) ↔ sources(journals) |
| **NCT ID** | 단독 키 | clinical_trials |

### 0.3 일관성 규칙
- **DOI 정규화**: 항상 `String(doi).toLowerCase()`. NULL/빈 문자열은 무조건 reject.
- **PMID 정규화**: 항상 `String(pmid)` (1234567 → "1234567"). 정수형 컬럼 아님 — leading-zero 보존 위해 TEXT.
- **년도 컬럼**: `year` 외에 `publication_year` 등으로 출처별 다른 의미일 수 있음. PubMed의 `year`가 권위.
- **시간 컬럼**: 모두 ISO 8601 (`2026-05-21T10:30:00.000Z`).
- **JSON 컬럼**: 무조건 `JSON.stringify`로 저장. 읽을 때 `JSON.parse`. 빈 배열은 `[]`로 저장 (NULL 아님).

### 0.4 NULL의 의미 (semantics)
NULL은 항상 **"unknown / not fetched yet"**을 의미한다. **"applicable but actual zero"는 NULL이 아닌 0**으로 저장.

예시:
- `pmcid IS NULL` → PMC mapping 시도 안 했거나 매핑 검색 후 PMCID 없음 (두 경우 구분은 `_pmid_to_pmcid.json` 캐시 참조)
- `icite_rcr IS NULL` → iCite 데이터 fetch 안 했거나, 신규 논문이라 RCR 계산 불가능
- `icite_citation_count = 0` → 명시적으로 인용 없음
- `unpaywall_is_oa = 0` → 명시적으로 closed access
- `unpaywall_is_oa IS NULL` → Unpaywall 조회 안 함

---

## 1. `papers` (91 cols, 215,721 rows)

### 1.1 PubMed core (PK + 메타데이터)

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `doi` | TEXT (PK) | 논문 DOI. lowercase. | 정규식 `^10\..+/.+$`. 빈 문자열 reject. 중복 시 ON CONFLICT UPDATE. | 매칭 키 |
| `pmid` | TEXT (UNIQUE) | PubMed ID. 숫자만. | `/^\d+$/`. NULL 허용 (DOI만 있고 PMID 없는 preprint 등). | 매칭 키 |
| `title` | TEXT | 논문 제목 (PubMed `ArticleTitle`). | 길이 ≥ 5. HTML/MathML 태그 제거됨. | abstract similarity의 query field |
| `abstract` | TEXT | 초록 (`AbstractText` concat). | 길이 ≥ 50 (else NULL). Structured abstract은 section label과 함께 concat. | Q100 **전 항목**의 입력 |
| `journal` | TEXT | 저널 표시명 (`Journal.Title`). | 비어있지 않음. | journal_year_metrics 매칭 (faulty — issn 우선) |
| `issn` | TEXT | 저널 ISSN. **issn-l 우선, fallback issn**. | 정규식 `^\d{4}-\d{3}[\dX]$`. | journals 테이블 매칭 키 |
| `year` | INTEGER | 출판 년도. `PubDate.Year` 우선, `MedlineDate` fallback. | 1900 ≤ year ≤ 현재+2. | retrieval temporal filter / FateCore feature |
| `publication_types_json` | TEXT (JSON array) | PubMed publication types (`Journal Article`, `Randomized Controlled Trial`, `Meta-Analysis` 등). | 비어있지 않음 (`[]`도 허용). | Q500 study_type 추출 |
| `mesh_terms_json` | TEXT (JSON array) | MeSH descriptors + qualifier (`{descriptor, qualifier, isMajor}`). | 1990년 이후 논문은 보통 ≥ 1. | Q500 disease/intervention 추출 |
| `authors_json` | TEXT (JSON array) | 저자 리스트 (`{lastName, foreName, initials, affiliation, orcid}`). | 1명 이상. | first/last author features |
| `first_affiliation` | TEXT | 첫 저자의 소속 (`AffiliationInfo[0]`). | 길이 ≥ 5. | 기관 normalization (향후 ROR 연결) |
| `seeds_json` | TEXT (JSON array) | 이 paper가 어느 seed query로 수집됐는지. 여러 seed에 matched 가능. | 1개 이상. | 도메인 라벨 (stratified sampling) |
| `fetched_pubmed_at` | TEXT (ISO8601) | PubMed fetch 시각. | 항상 not-null. | data freshness QC |

### 1.2 OpenAlex enrichment (DOI 매칭, 45,264 rows)

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `openalex_id` | TEXT | OpenAlex Work ID (`W123456789`). | 정규식 `^W\d+$`. | works→sources join |
| `citations_openalex` | INTEGER | OpenAlex 누적 인용 수. | ≥ 0. **citation count 권위 출처 (S2/Crossref와 비교용)**. | FateCore citation feature 입력 |
| `fwci` | REAL | Field-Weighted Citation Impact (≥ 1이면 평균 이상). | ≥ 0, 보통 0~10 (이상치 30+ 가능). | FateCore impact feature |
| `concepts_json` | TEXT (JSON) | OpenAlex concepts (`[{id, display_name, score, level}]`). | score는 0~1. 평균 5~10개. | 도메인 분류 |
| `primary_topic_json` | TEXT (JSON) | OpenAlex primary topic + subfield + field + domain. | 모두 null인 경우는 매우 신규 논문. | FateCore topic embedding |
| `venue_openalex_id` | TEXT | source(저널) OpenAlex ID. | journals 테이블 매칭 키. | journal_year_metrics 조인 |
| `venue_name` | TEXT | OpenAlex venue display name. | `papers.journal`와 비교 QC (대소문자 차이 OK). | — |
| `venue_type` | TEXT | `journal` / `conference` / `repository` / `book series`. | enum. **journal만 학습 대상**. | FateCore filter |
| `is_oa` | INTEGER (bool) | OpenAlex 기준 OA 여부. | 0/1. **`unpaywall_is_oa`와 우선순위 비교**. | OA feature |
| `oa_status` | TEXT | `gold` / `green` / `bronze` / `hybrid` / `closed`. | enum. | OA license feature |
| `authorships_json` | TEXT (JSON) | 저자별 (orcid, institutions, raw_affiliation, is_corresponding). | corresponding flag는 약 80% 채워짐. | first/last/corresponding author features |
| `oa_publication_date` | TEXT (YYYY-MM-DD) | OpenAlex 인지한 공개 일자. | year와 일관성. | preprint→publication gap 후보 |
| `fetched_openalex_at` | TEXT | fetch 시각. | not-null. | freshness |

### 1.3 Semantic Scholar enrichment (40,942 rows)

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `s2_id` | TEXT | Semantic Scholar paper ID (40-hex). | `^[a-f0-9]{40}$`. | — |
| `citations_s2` | INTEGER | S2 citation count. | ≥ 0. **OpenAlex와 ~10% 차이 가능**. | citation triangulation |
| `influential_citations` | INTEGER | "influential" (high overlap) citation count. | ≤ citations_s2. | impact feature (S2 고유 신호) |
| `reference_count` | INTEGER | 본문 reference 개수. | 보통 20~80. | reference density feature |
| `fields_of_study_json` | TEXT (JSON) | S2 fields of study (`Medicine`, `Computer Science` 등). | 1개 이상. | — |
| `tldr` | TEXT | S2 AI-generated TLDR (1줄 요약). | 길이 50~300자. **LLM 입력 short-form 후보**. | Q100 의 context 보조 |
| `embedding_model` | TEXT | 임베딩 모델명 (`specter2`). | enum. | retrieval pipeline |
| `embedding_dim` | INTEGER | 차원 (SPECTER2는 768). | == 768 (현재). | sanity check |
| `embedding` | BLOB | Float32 little-endian. 3072 bytes (768×4). | size == embedding_dim × 4. **NULL이면 retrieval 불가**. | Similar paper retrieval |
| `s2_open_access_pdf` | TEXT | S2가 인지한 OA PDF URL. | URL 형식. | PDF collector 보조 |
| `fetched_s2_at` | TEXT | fetch 시각. | not-null. | freshness |

### 1.4 Crossref enrichment (44,923 rows)

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `citations_crossref` | INTEGER | Crossref `is-referenced-by-count`. | ≥ 0. **subset of citations_openalex, 보통 80~95%**. | citation triangulation |
| `license_json` | TEXT (JSON) | 라이센스 URL/start date 리스트. | `[]` if missing. | OA license verification |
| `funder_json` | TEXT (JSON) | 펀더 (name, DOI, awards). | `[]` if missing. | Q500 funding 점검 |
| `container_title` | TEXT | 저널명 (Crossref 버전). | `journal` 컬럼과 비교 QC. | — |
| `publisher` | TEXT | 출판사. | 예: "Elsevier BV", "Springer Nature". | journal feature 보조 |
| `cr_published_print` | TEXT (YYYY-MM-DD 또는 YYYY-MM) | 인쇄본 출판일. | year와 일관성. | preprint gap 계산 |
| `cr_published_online` | TEXT | 온라인 출판일. | print과 비교: online ≤ print 통상. | preprint gap 계산 |
| `fetched_crossref_at` | TEXT | fetch 시각. | not-null. | — |

### 1.5 iCite (NIH RCR, 198,486 rows)

NIH OPRA의 권위 있는 영향력 지표. **재현 가능하고 분야 보정된** 인용 점수.

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `icite_rcr` | REAL | **Relative Citation Ratio**. 분야·연도 보정 후 NIH 평균=1. | ≥ 0. 보통 0~5. 10+는 lab/instrument paper. **연도 < 2024는 NULL 비율 높음 (안정화 안 됨)**. | FateCore impact feature (분야 보정된 신호) |
| `icite_nih_percentile` | REAL | NIH 동분야 동연도 percentile (0~100). | 0 ≤ x ≤ 100. **분야 비교에 가장 안정**. | FateCore percentile feature |
| `icite_citation_count` | INTEGER | iCite 시점 누적 인용. | ≥ 0. OpenAlex/S2와 차이 있음 (snapshot 시점 다름). | citation triangulation |
| `icite_citations_per_year` | REAL | 연평균 인용. | 0 ≤ x. **연도가 5년 미만이면 신뢰도 낮음**. | citation momentum |
| `icite_expected_cit_per_year` | REAL | 같은 분야 동연도 기대 인용. | ≥ 0. RCR = citations_per_year / expected. | denominator validation |
| `icite_field_citation_rate` | REAL | 분야 평균 인용률. | ≥ 0. | denominator |
| `icite_is_clinical` | INTEGER (bool) | NIH 분류 임상 여부. | 0/1. | 임상 vs 기초 stratification |
| `icite_is_research_article` | INTEGER (bool) | 1이면 research article (review/editorial 제외). | 0/1. **학습 시 1만 사용 권장**. | FateCore filter |
| `icite_apt` | REAL | Approximate Potential to Translate (0~1). | 0 ≤ x ≤ 1. | translation potential feature |
| `icite_cited_by_clin` | INTEGER | "이 논문을 임상 가이드라인 등이 인용한 횟수". | ≥ 0. **희소 컬럼 (55K rows)**. | clinical impact signal |
| `fetched_icite_at` | TEXT | fetch 시각. | not-null. | — |

**iCite 데이터 신뢰성**: NIH 직접 제공, 출판 후 3년 안정화. **2024+ 논문은 RCR null 비율 높음** — Q500/FateCore 학습 시 cutoff year 고려.

### 1.6 Unpaywall (212,156 rows)

OA 상태와 PDF 위치의 권위 출처.

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `unpaywall_is_oa` | INTEGER (bool) | Unpaywall OA 판정. | 0/1. OpenAlex `is_oa`와 ~5% 차이 (Unpaywall이 더 정확). | OA feature (우선) |
| `unpaywall_oa_status` | TEXT | `gold` / `hybrid` / `green` / `bronze` / `closed`. | enum. | OA license tier |
| `unpaywall_best_oa_url` | TEXT | 최선의 무료 full-text URL. | URL. NULL = no free copy. | PDF collector input |
| `unpaywall_best_oa_host` | TEXT | `publisher` / `repository`. | enum. | green vs gold 구분 |
| `unpaywall_best_oa_version` | TEXT | `publishedVersion` / `acceptedVersion` / `submittedVersion`. | enum. **submittedVersion은 preprint**. | publication stage |
| `unpaywall_best_oa_license` | TEXT | 라이센스 SPDX (`cc-by`, `cc-by-nc`, …). | NULL 허용. | reuse rights |
| `unpaywall_journal_oa` | INTEGER (bool) | 저널 자체가 OA인가. | 0/1. | journal OA model |
| `unpaywall_journal_doaj` | INTEGER (bool) | DOAJ 등재 여부. | 0/1. **predatory journal 필터링 시 이게 1=safer**. | journal quality signal |
| `fetched_unpaywall_at` | TEXT | fetch 시각. | not-null. | — |

### 1.7 PMC full-text (PMID→PMCID→XML)

**현재 0 rows** (수집 중). 매핑 진행률은 `data/pmc-fulltext/_pmid_to_pmcid.json` 참조.

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `pmcid` | TEXT | PubMed Central ID (`PMC1234567`). | `^PMC\d+$`. EPMC search로 매핑. **약 35-40%의 PMID가 PMCID 보유 예상**. | full-text 접근 키 |
| `pmc_body_word_count` | INTEGER | 본문 word 수. | 통상 2000~10000. < 500은 의심. | Q500 본문 길이 sanity |
| `pmc_section_count` | INTEGER | `<sec>` 개수. | 통상 4~12 (IMRaD + subsection). | Q500 structure 점수 |
| `pmc_figure_count` | INTEGER | `<fig>` 개수. | 0~20. | Q500 visual content |
| `pmc_table_count` | INTEGER | `<table-wrap>` 개수. | 0~10. | Q500 data presentation |
| `pmc_ref_count` | INTEGER | `<ref>` 개수. | 통상 20~80. **`reference_count` (S2)와 교차 검증**. | reference density |
| `pmc_has_data_avail` | INTEGER (bool) | Data Availability 섹션 존재 여부. | 0/1. **CONSORT/STROBE 권고 항목 직접 채점**. | Q500: data sharing item |
| `pmc_has_ethics` | INTEGER (bool) | Ethics 섹션 존재 여부. | 0/1. | Q500: ethical reporting |
| `pmc_has_coi` | INTEGER (bool) | Conflict of Interest 섹션 존재 여부. | 0/1. | Q500: COI disclosure |
| `fetched_pmc_at` | TEXT | fetch 시각. | not-null. | — |

### 1.8 Europe PMC full-text (대안 OA full-text 출처)

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `epmc_body_word_count` | INTEGER | EPMC 본문 word 수. | PMC와 5~15% 차이 가능 (다른 XML 버전). | PMC 미수집 시 대체 |
| `epmc_section_count` | INTEGER | EPMC 섹션 수. | — | — |
| `epmc_figure_count` | INTEGER | EPMC 그림 수. | — | — |
| `epmc_ref_count` | INTEGER | EPMC reference 수. | — | — |
| `fetched_epmc_at` | TEXT | fetch 시각. | not-null. | — |

**PMC와 EPMC 모두 가능한 경우 PMC를 우선** (NLM 공식 archive). EPMC는 PMC가 빠진 European-funded paper 보완용.

### 1.9 PDF 본문 (Unpaywall URL → pdfjs 추출, 372 rows)

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `pdf_body_chars` | INTEGER | 추출된 character 수. | ≥ 5000. < 1000은 추출 실패 가능성. | full-text 대체 |
| `pdf_body_words` | INTEGER | 추출된 word 수. | chars/5 ≈ words. | sanity check |
| `pdf_num_pages` | INTEGER | PDF 페이지 수. | 1~50. | — |
| `pdf_source_url` | TEXT | 출처 URL. | URL. | provenance |
| `fetched_pdf_at` | TEXT | fetch 시각. | not-null. | — |

**용도**: PMC OA가 없지만 Unpaywall이 publisher PDF를 가리킬 때. **품질이 PMC XML보다 낮음** (figure/section/ref 분리 어려움).

### 1.10 Preprint 연결 (bioRxiv/medRxiv, 0 rows)

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `preprint_server` | TEXT | `bioRxiv` / `medRxiv`. | enum. | preprint provenance |
| `preprint_doi` | TEXT | preprint DOI (10.1101/...). | `^10\.1101/.+`. | preprint→publication link |
| `preprint_published_date` | TEXT (YYYY-MM-DD) | preprint 공개일. | not-null when preprint_doi exists. | — |
| `preprint_pub_gap_days` | INTEGER | 학술지 출판 — preprint 공개일 (일수). | ≥ 0. 통상 60~600일. | **Q500: review timeline 학습 라벨** |
| `fetched_preprint_at` | TEXT | fetch 시각. | not-null. | — |

⚠️ **현재 bioRxiv API에 `published_doi` 필드 없음** — 매칭 0건. Crossref relation API로 역참조 또는 title fuzzy matching 필요 (Task #6).

---

## 2. `journals` (23 cols, 4,450 rows)

OpenAlex sources에서 수집한 저널 메타데이터. 저널 단위 1행.

| 컬럼 | type | 의미 | QC | 비고 |
|---|---|---|---|---|
| `openalex_id` | TEXT (PK) | OpenAlex Source ID (`S123456789`). | `^S\d+$`. | — |
| `issn_l` | TEXT | ISSN-L (linking). | `^\d{4}-\d{3}[\dX]$`. **journal_year_metrics 연결 키**. | — |
| `issn_json` | TEXT (JSON) | 모든 ISSN (electronic + print). | 1개 이상. | — |
| `display_name` | TEXT | 저널명. | not-null. | — |
| `alternate_titles_json` | TEXT (JSON) | 별칭/약어 리스트. | `[]` 허용. | search alias |
| `type` | TEXT | `journal` / `repository` / `conference`. | enum. **학습은 journal만**. | filter |
| `country_code` | TEXT | ISO 2-letter (`US`, `GB`, `KR`, …). | regex `^[A-Z]{2}$`. | journal geographic feature |
| `host_organization` | TEXT | publisher OpenAlex ID. | `^P\d+$`. | — |
| `host_organization_name` | TEXT | publisher 이름. | — | — |
| `homepage_url` | TEXT | 저널 홈페이지. | URL. | — |
| `works_count` | INTEGER | 전체 출판 수. | ≥ 0. | journal size feature |
| `cited_by_count` | INTEGER | 누적 인용. | ≥ 0. | impact feature |
| `first_publication_year` | INTEGER | 첫 출판 연도. | 1500~현재. | journal age feature |
| `last_publication_year` | INTEGER | 마지막 출판 연도. | first 이상. | active/dormant detection |
| `is_oa` | INTEGER (bool) | OA journal 여부. | 0/1. | — |
| `is_in_doaj` | INTEGER (bool) | DOAJ 등재. | 0/1. | **predatory filter** |
| `is_core` | INTEGER (bool) | OpenAlex "core" 분류. | 0/1. | quality signal |
| `apc_usd` | REAL | Article Processing Charge (USD). | 0~10000. NULL = unknown. | OA cost feature |
| `h_index` | INTEGER | 저널 h-index. | ≥ 0. | impact feature |
| `i10_index` | INTEGER | 10+ 인용 논문 수. | ≥ 0. | impact feature |
| `two_yr_mean_citedness` | REAL | OpenAlex 2년 평균 인용 (JIF proxy). | ≥ 0. **JCR JIF와 ~50% 상관**. | journal_year_metrics.if_proxy_openalex와 동일 |
| `topics_json` | TEXT (JSON) | OpenAlex topic 리스트. | `[]` 허용. | 분야 분류 |
| `fetched_at` | TEXT | fetch 시각. | not-null. | — |

---

## 3. `journal_year_metrics` (49 cols, 157,987 rows)

저널 × 연도 단위. 한 저널이 10년치 데이터면 10 rows.

### 3.1 OpenAlex 연도별 지표 (157,987 rows base)

| 컬럼 | type | 의미 | QC | 활용 |
|---|---|---|---|---|
| `openalex_id` | TEXT | journals 매칭 키. | journals 테이블에 존재. | — |
| `issn` | TEXT | papers 매칭용 ISSN. | NULL 가능 (저널이 ISSN 없을 때). | papers.issn join |
| `year` | INTEGER | 연도. | 1950~현재+1. | — |
| `works_count` | INTEGER | 그 해 출판 수. | ≥ 0. | 저널 활동 강도 |
| `cited_by_count` | INTEGER | 그 해 출판된 논문의 누적 인용. | ≥ 0. | impact |
| `if_proxy_openalex` | REAL | OpenAlex 기반 2년 IF proxy. | ≥ 0. **JCR JIF와 ~50% 상관 (잘 안 맞음)**. | estimated_jif 계산 입력 |
| `ingested_at` | TEXT | ingest 시각. | not-null. | — |

### 3.2 Scimago (현재 0 rows — 차단됨)

| 컬럼 | type | 의미 | 상태 |
|---|---|---|---|
| `scimago_id`, `sjr`, `sjr_quartile`, `scimago_h_index`, `total_docs_*`, `total_cites_3y`, `cites_per_doc_2y`, `scimago_country`, `scimago_publisher`, `scimago_categories`, `scimago_areas` | — | Scimago가 IP 차단 — 수집 불가 | (alt 데이터 사용) |

### 3.3 JCR Impact Factor (10,990 rows with jcr_jif)

**권위 출처**. xlsx 직접 import. 라이센스: 비영리·연구·교육 용도만.

| 컬럼 | type | 의미 | QC | 활용 |
|---|---|---|---|---|
| `jcr_jif` | REAL | **JCR Journal Impact Factor** (Clarivate). | 0 ≤ x ≤ 200 (이상치 200+ = lab error). | **Ground truth label** |
| `jcr_jif_5yr` | REAL | 5년 평균 JIF. | jif와 동향 일치. | 안정된 impact |
| `jcr_jif_no_self` | REAL | self-citation 제외 JIF. | jif 이하. | quality signal |
| `jci` | REAL | Journal Citation Indicator (분야 보정). | ≥ 0. JIF보다 cross-field 비교에 좋음. | preferred for FateCore |
| `jcr_quartile` | TEXT | Q1/Q2/Q3/Q4 + 카테고리별. | enum. | tier feature |
| `jcr_category` | TEXT | JCR 분야 (multi-cat 가능). | — | 분야 분류 |
| `jcr_rank` | INTEGER | 카테고리 내 순위. | ≥ 1. | — |
| `jcr_total_in_category` | INTEGER | 카테고리 전체 저널 수. | rank ≤ total. | — |
| `jcr_publisher` | TEXT | JCR 표시 publisher. | journals.publisher와 비교. | — |
| `jcr_total_cites` | INTEGER | 누적 인용. | ≥ 0. | — |
| `jcr_total_articles` | INTEGER | 누적 article 수. | ≥ 0. | — |
| `jcr_citable_items` | INTEGER | citable items (JIF 분모). | ≥ 0. | JIF 검증 (cites/citable ≈ JIF) |
| `jcr_source_file` | TEXT | 어느 xlsx에서 왔는지. | provenance. | — |
| `eigenfactor`, `normalized_eigenfactor`, `article_influence`, `immediacy_index`, `jci_percentile`, `jif_5yr_quartile`, `jcr_edition` | REAL/TEXT | SchemaD (HyunjaeShin export) 추가 지표. | 301 rows만 채워짐 (최신 JCR만). | future feature |

### 3.4 Estimated JIF (calibration 결과, 132,244 rows)

`scripts/calibrate-jif.mjs`가 OpenAlex proxy를 anchor-based scaling으로 JIF 추정.

| 컬럼 | type | 의미 | QC | 주의 |
|---|---|---|---|---|
| `estimated_jif` | REAL | 추정 JIF. | ≥ 0. | **정확도 4.4% within ±20% (낮음)**. weak feature. |
| `est_jif_method` | TEXT | `anchor_scaled` / `global_factor`. | enum. | — |
| `est_jif_confidence` | REAL | 0~1 confidence (anchor 개수 기반). | 0 ≤ x ≤ 1. | < 0.5는 사용 권장 X. |

### 3.5 Wayback historical JIF (445 rows)

`scripts/verify-top100-jif.mjs`가 Wikipedia + Wayback Machine에서 추출.

| 컬럼 | type | 의미 | QC | 활용 |
|---|---|---|---|---|
| `wayback_jif` | REAL | Wayback snapshot에서 정규식으로 추출한 JIF. | ≥ 0. **JCR과 ~19.5% mean error**. | Top journal 과거 시계열 보강 |
| `wayback_jif_confidence` | REAL | extraction confidence. | 0 ≤ x ≤ 1. | 신뢰도 낮으면 표시만 |
| `wayback_snapshot_url` | TEXT | 추출 출처 URL. | URL. | audit trail |

### 3.6 Wiki current JIF (259 rows)

| 컬럼 | type | 의미 | QC | 활용 |
|---|---|---|---|---|
| `wiki_current_jif` | REAL | Wikipedia 페이지 현재 JIF 텍스트 추출. | ≥ 0. **JCR과 ~41.6% mean error (높음 — 연도 매칭 약함)**. | 보조용. fallback only. |
| `wiki_current_jif_confidence` | REAL | 0~1. | — | — |
| `wiki_current_jif_url` | TEXT | Wikipedia 출처. | URL. | — |

### 3.7 JIF 우선순위 (Q500/FateCore에서 사용 시)

```
jcr_jif (권위, 10,990) >> wayback_jif (445, ±20%)
        > estimated_jif (132,244, ±40%, weak)
        > wiki_current_jif (259, ±42%)
```

학습 시: `COALESCE(jcr_jif, wayback_jif, NULL)`를 hard label, `estimated_jif`을 weak/auxiliary feature로 사용.

---

## 4. `clinical_trials` (23 cols, 14,745 rows)

NCT ID 단위. PubMed paper와 N:N 관계 (직접 join은 안 함, 추후 `pubmed_nct_link` 테이블 추가 예정).

| 컬럼 | type | 의미 | QC | Q500 활용 |
|---|---|---|---|---|
| `nct_id` | TEXT (PK) | NCT 등록번호 (`NCT12345678`). | `^NCT\d{8}$`. | — |
| `brief_title` | TEXT | 임상시험 제목. | not-null. | — |
| `study_type` | TEXT | `INTERVENTIONAL` / `OBSERVATIONAL` / `EXPANDED_ACCESS`. | enum. | Q500 study_type |
| `phases_json` | TEXT (JSON) | `["PHASE2", "PHASE3"]` 등. | `[]` 허용. | Q500 trial_phase |
| `enrollment` | INTEGER | 등록 환자 수 (실제 또는 계획). | ≥ 0. 통상 10~10000. | Q500 sample_size 검증 |
| `enrollment_type` | TEXT | `ACTUAL` / `ESTIMATED`. | enum. | sample size confidence |
| `allocation` | TEXT | `RANDOMIZED` / `NON_RANDOMIZED` / `NA`. | enum. | Q500 randomization |
| `intervention_model` | TEXT | `PARALLEL` / `CROSSOVER` / `SINGLE_GROUP` / `FACTORIAL`. | enum. | Q500 design |
| `masking` | TEXT | `NONE` / `SINGLE` / `DOUBLE` / `TRIPLE` / `QUADRUPLE`. | enum. | Q500 blinding |
| `overall_status` | TEXT | `COMPLETED` / `RECRUITING` / `TERMINATED` / `WITHDRAWN` 등. | enum. | trial trajectory |
| `start_date` | TEXT | 시작일. | YYYY-MM-DD. | timeline |
| `primary_completion_date` | TEXT | 1차 완료일. | start_date 이후. | timeline |
| `completion_date` | TEXT | 전체 완료일. | start_date 이후. | timeline |
| `last_update_post_date` | TEXT | 최근 업데이트. | — | freshness |
| `has_results` | INTEGER (bool) | 결과 등록 여부. | 0/1. | reporting bias check |
| `sponsor_name` | TEXT | 스폰서. | not-null. | conflict signal |
| `sponsor_class` | TEXT | `INDUSTRY` / `NIH` / `OTHER_GOV` / `OTHER` / `NETWORK`. | enum. **`INDUSTRY`는 publication bias 위험**. | Q500 funding bias |
| `conditions_json` | TEXT (JSON) | 질환 리스트. | 1개 이상. | disease 매칭 |
| `interventions_json` | TEXT (JSON) | [{type, name}] 리스트. | `[]` 허용. | drug/device 매칭 |
| `primary_outcomes_json` | TEXT (JSON) | [{measure, timeFrame}]. | not-null. | Q500 outcome validity |
| `secondary_outcomes_json` | TEXT (JSON) | 2차 결과. | `[]` 허용. | — |
| `fetched_at`, `ingested_at` | TEXT | 시각. | not-null. | — |

---

## 5. `ingest_runs` (감사 로그, 556 rows)

각 ingest 실행 기록. **삭제 금지** — 데이터 출처 audit trail.

| 컬럼 | 의미 |
|---|---|
| `id` | autoincrement |
| `source` | `pubmed`, `openalex`, `icite` 등 |
| `file` | 원본 jsonl 파일 경로 |
| `rows_seen` | jsonl line 수 |
| `rows_upserted` | 실제 papers 테이블에 영향을 준 row 수 |
| `started_at`, `finished_at` | 시각 |

---

## 6. QC 자동화

### 6.1 정기 QC 항목 (`scripts/qc-database.mjs` — TODO)

**필수 QC** (build-unified-db 후 자동):
1. **PK 무결성**: `doi` UNIQUE, `pmid` UNIQUE in papers
2. **FK 무결성**: 모든 `papers.issn`는 `journals.issn_l` 또는 `issn_json`에 존재 (현재 95% 일치)
3. **JIF 이상치**: `jcr_jif > 200` 검출
4. **Year 이상치**: `year < 1900` 또는 `year > 현재+1`
5. **DOI 형식**: 정규식 `^10\.\d+/.+`
6. **PMID 형식**: 숫자만
7. **JSON 유효성**: 모든 `*_json` 컬럼 `JSON.parse` 성공
8. **Embedding 무결성**: `embedding_dim` × 4 == `LENGTH(embedding)`

**경고 QC** (실패해도 진행):
- iCite RCR null 비율 (연도별)
- Unpaywall journal_doaj=1 비율 (예상치 20~30%)
- PMC mapping 진행률 (현재 0% → 목표 35%)

### 6.2 Source freshness QC
- 모든 `fetched_*_at` 컬럼이 30일 이내인지 확인 (오래된 데이터는 재수집 큐로)

### 6.3 Missing data heat map
- 컬럼별 NULL 비율을 연도 × 분야로 stratified 분석. 학습 split 시 missing pattern 이 systematic하면 bias 위험.

---

## 7. Q100 / Q500 / FateCore 활용 가이드

### 7.1 Q100 (초록만으로 채점)
- **입력**: `papers.title` + `papers.abstract`
- **메타데이터 보조**: `publication_types_json`, `mesh_terms_json`
- **사전 채점 가능**: study_type, sample_size (`enrollment` from CT.gov via NCT ID), p-value (regex from abstract)

### 7.2 Q500 (본문 필요)
- **본문 출처 우선**: `pmc_*` (NLM 권위) → `epmc_*` (보완) → `pdf_*` (publisher PDF)
- **구조 항목**: `pmc_section_count` (≥ 6이면 IMRaD 완성도 높음)
- **CONSORT/STROBE 직접 채점**: `pmc_has_data_avail`, `pmc_has_ethics`, `pmc_has_coi`
- **References 검증**: `pmc_ref_count` vs `reference_count` (S2) — 두 값이 ~20% 이내 일치하면 신뢰

### 7.3 FateCore feature 후보

**Tier 1 (학습 시 필수)**
- `citations_openalex`, `fwci`, `icite_rcr`, `icite_nih_percentile`
- `jcr_jif` (target label) 또는 `jci`
- `embedding` (BLOB, retrieval)
- `year`, `publication_types_json`, `mesh_terms_json` (one-hot)

**Tier 2 (보조)**
- `influential_citations`, `reference_count`, `apc_usd`
- `unpaywall_is_oa`, `unpaywall_oa_status`
- `pmc_body_word_count`, `pmc_section_count` (full-text 확보된 paper만)

**Tier 3 (실험)**
- `icite_apt`, `icite_cited_by_clin`
- `preprint_pub_gap_days`
- `estimated_jif` (weak)

### 7.4 학습 split 원칙 (⚠️ 반복 환기)
- **random split만** (sklearn `train_test_split` default).
- **연도 기반 split 절대 금지** — JIF의 연도 변동성(2020 NEJM JIF=70 → 2023 JIF=160 같은 spike) 보정 불가능.
- Stratification은 `mesh_terms_json[0]` (분야) 또는 `icite_is_clinical` 으로.

---

## 7.5 `paper_scores` 테이블 (Q500 채점 결과 저장소)

`build-unified-db.mjs` 마이그레이션에서 생성. **Composite PK `(doi, item_id, mode)`** — 같은 paper×item을 여러 mode가 각자 채점한 결과를 동시 보존.

### 컬럼
| 컬럼 | type | 의미 |
|---|---|---|
| `doi` | TEXT (PK part 1) | papers.doi 매칭 |
| `item_id` | TEXT (PK part 2) | Q500 item ID (`QUEST_001`, `DESIGN_005`, …) |
| `mode` | TEXT (PK part 3) | 채점 출처 — 아래 enum 참조 |
| `score` | REAL | 0–5 정수 (실제 점수) 또는 NULL (na/unknown) |
| `raw_value` | TEXT | `'0'`–`'5'` 또는 `'na'`, `'unknown'` |
| `confidence` | REAL | 0–1, 채점 신뢰도 |
| `evidence` | TEXT | abstract/본문 인용 (≤200자) |
| `scored_at` | TEXT | ISO 8601 |

### Mode enum (현재 사용 중)
| mode | 의미 | 출처 스크립트 | 신뢰도 |
|---|---|---|---|
| `external` | DB 컬럼에서 직접 매핑 (citation, OA, has_data_avail, …) | `score-rubric-batch.mjs` | **높음** — 권위 데이터 |
| `rule` | regex extractor (sample size, AUROC, p-value, …) | `score-rubric-batch.mjs` + `ruleExtractors.js` | 높음 — 결정론적 |
| `codex_deterministic` | ChatGPT 코덱스의 deterministic regex pass (Q500 100+ 항목) | `score-codex-batch-direct.mjs` / `score-codex-deterministic-all.mjs` | 중간 — wide recall, binary tendency |
| `llm` | Claude / Gemini Flash 실제 LLM 채점 (deep, nuanced) | `ingest-llm-scores.mjs` (`--mode llm`) + `score-with-gemini.mjs` | 최고 — gold label |

### 학습 시 mode별 활용
- **Strong label (학습용 truth)**: `llm`
- **Weak label (대량 supervision)**: `codex_deterministic`
- **Anchor features (numeric)**: `external` + `rule`
- 동일 (doi, item_id)에 여러 mode 있을 때:
  - LLM 우선 (있으면) > external > rule > codex
  - 또는 ensemble (median, weighted average)

### 통계 query (예시)
```sql
SELECT mode, COUNT(*) AS rows, COUNT(DISTINCT doi) AS papers
FROM paper_scores
GROUP BY mode;
```

---

## 8. 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-05-21 (1차) | 초판. 91+23+49+23 = 186 columns 정리. iCite/Unpaywall/CT.gov/PMC/EPMC/PDF/preprint 통합 직후. |
| 2026-05-21 (2차) | `paper_scores` 테이블 추가 (composite PK `(doi, item_id, mode)`), Codex deterministic baseline 작업 시작 (866K paper × Q100). §7.5 추가. |

---

## 9. TODO (문서 자체)

- [ ] `scripts/qc-database.mjs` 작성 — 위 §6.1 룰 자동 강제
- [ ] `pubmed_nct_link` 테이블 추가 (paper ↔ clinical_trial N:N)
- [ ] `docs/Q500_FEATURE_MAP.md` 작성 — Q500 각 item ↔ 컬럼 명시
- [ ] Author/Institution 정규화 단계 추가 (ROR ID)
- [ ] 모든 `*_json` 의 schema를 `docs/schemas/` 디렉토리에 JSON Schema로 저장
