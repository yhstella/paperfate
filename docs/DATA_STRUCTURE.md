# PaperFate Data Structure

총괄: PubMed → OpenAlex (works + sources) → Semantic Scholar → Crossref → Scimago의 5-source ETL이 모두 DOI 키 중심으로 SQLite에 통합됩니다.

## 디렉토리 구조

```
$DATA_ROOT/                  # 기본 ./data, env로 SSD 이전 가능
├── pubmed/                  # 1차 코퍼스 (PubMed E-utilities)
│   ├── <seed>-<lo>-<hi>-<YYYY-MM-DD>.jsonl   # year-bucketed
│   └── ...                  # 30 seeds × 3 buckets = ~90 파일
├── openalex/                # 논문-level enrichment
│   └── all-<YYYY-MM-DD>.jsonl
├── semantic-scholar/        # citation + SPECTER2 embedding
│   └── all-<YYYY-MM-DD>.jsonl
├── crossref/                # license/funder/2차 citation
│   └── all-<YYYY-MM-DD>.jsonl
├── openalex-sources/        # 저널 메타데이터 + 시계열
│   └── sources-<YYYY-MM-DD>.jsonl
├── scimago/                 # SJR per-year (수동 다운로드)
│   ├── scimago-YYYY.csv
│   └── scimago-YYYY.jsonl
└── paperfate.db             # 통합 SQLite (모든 source join)
```

DATA_ROOT 환경변수로 전체 위치 이동 가능 → SSD 이전 시 `D:\paperfate-data` 등으로 설정만.

## 데이터 흐름

```
NCBI E-utilities
    │ (PMID + DOI + title/abstract/MeSH/...)
    ▼
data/pubmed/*.jsonl
    │
    ├── OpenAlex API ──► data/openalex/*.jsonl  (citation, FWCI, concepts, venue_id)
    │                           │
    │                           └─► OpenAlex Sources API ──► data/openalex-sources/*.jsonl
    │                                       (venue별 works/citations 시계열, IF proxy)
    │
    ├── Semantic Scholar API ──► data/semantic-scholar/*.jsonl  (SPECTER2 embedding 등)
    │
    ├── Crossref API ──► data/crossref/*.jsonl  (license, funder, refs)
    │
    └── Scimago CSV (manual) ──► data/scimago/*.jsonl  (SJR, quartile per year)

        모두 DOI/ISSN 키로
                    ▼
            data/paperfate.db
            ┌──────────────────────────┐
            │ papers (DOI PK)          │
            │ journals (oa_id PK)      │
            │ journal_year_metrics     │
            │ ingest_runs              │
            └──────────────────────────┘
```

## SQLite 스키마

### `papers` (DOI 기준, 논문 1행)
실제 row 수: 현재 ~100K (year-bucket 진행 중).

| 컬럼 | 타입 | 출처 | 설명 |
|---|---|---|---|
| **doi** | TEXT PK | * | 정규화 소문자 |
| pmid | TEXT | PubMed | |
| title | TEXT | PubMed | |
| abstract | TEXT | PubMed | 구조화 섹션 합쳐서 |
| journal | TEXT | PubMed | ISOAbbreviation |
| issn | TEXT | PubMed | |
| year | INTEGER | PubMed | publication year |
| publication_types_json | TEXT | PubMed | RCT/Review/Meta-analysis 등 |
| mesh_terms_json | TEXT | PubMed | 상위 20 MeSH descriptors |
| authors_json | TEXT | PubMed | 상위 8명 (last + initials) |
| first_affiliation | TEXT | PubMed | 첫 저자 소속 |
| seeds_json | TEXT | PubMed | 어느 seed query에서 잡혔는지 |
| **openalex_id** | TEXT | OpenAlex | |
| **citations_openalex** | INTEGER | OpenAlex | |
| **fwci** | REAL | OpenAlex | field-weighted citation impact |
| concepts_json | TEXT | OpenAlex | 상위 8 concepts |
| primary_topic_json | TEXT | OpenAlex | OpenAlex Topic 분류 (subfield/field/domain) |
| **venue_openalex_id** | TEXT | OpenAlex | → `journals.openalex_id` join |
| venue_name | TEXT | OpenAlex | |
| is_oa | INTEGER | OpenAlex | open access boolean |
| oa_status | TEXT | OpenAlex | gold/green/bronze/closed |
| authorships_json | TEXT | OpenAlex | ORCID + institution + country |
| oa_publication_date | TEXT | OpenAlex | ISO date |
| **s2_id** | TEXT | S2 | |
| citations_s2 | INTEGER | S2 | |
| **influential_citations** | INTEGER | S2 | S2의 "influential" 분류 |
| reference_count | INTEGER | S2 | |
| fields_of_study_json | TEXT | S2 | |
| tldr | TEXT | S2 | AI-generated 1-sentence summary |
| embedding_model | TEXT | S2 | "specter@v0.1.0" 등 |
| embedding_dim | INTEGER | S2 | 768 |
| **embedding** | BLOB | S2 | Float32Array (3 KB/paper) |
| s2_open_access_pdf | TEXT | S2 | |
| **citations_crossref** | INTEGER | Crossref | is-referenced-by-count |
| license_json | TEXT | Crossref | |
| funder_json | TEXT | Crossref | grant numbers |
| container_title | TEXT | Crossref | journal full name |
| publisher | TEXT | Crossref | |
| cr_published_print/online | TEXT | Crossref | |
| fetched_*_at | TEXT | each source | provenance timestamps |

인덱스: pmid, year, journal, citations_openalex, citations_s2, venue_openalex_id, embedding_dim (partial).

### `journals` (OpenAlex Source ID 기준, 저널 1행)
실제 row 수: 4,450 (코퍼스 내 등장 저널 unique).

| 컬럼 | 출처 | 설명 |
|---|---|---|
| **openalex_id** PK | OA Sources | |
| **issn_l** | OA Sources | ISSN-L (Scimago join key) |
| issn_json | OA Sources | 전체 ISSN 리스트 |
| display_name | OA Sources | |
| alternate_titles_json | OA Sources | |
| type | OA Sources | journal / conference / repository |
| country_code | OA Sources | ISO 2자리 |
| host_organization* | OA Sources | 출판사 |
| homepage_url | OA Sources | |
| works_count | OA Sources | 누적 논문 수 |
| cited_by_count | OA Sources | 누적 인용 수 |
| first/last_publication_year | OA Sources | |
| is_oa, is_in_doaj, is_core | OA Sources | |
| apc_usd | OA Sources | open access 비용 |
| **h_index** | OA Sources | |
| i10_index | OA Sources | |
| **two_yr_mean_citedness** | OA Sources | **IF의 무료 proxy (snapshot)** |
| topics_json | OA Sources | OpenAlex Topic 분류 |

### `journal_year_metrics` (저널 × 연도, IF 시계열)
실제 row 수: 157,965 (저널마다 평균 35년 커버).

| 컬럼 | 출처 | 설명 |
|---|---|---|
| **openalex_id** | OA Sources | PK with year |
| issn | OA Sources / Scimago | join key |
| **year** | both | PK with openalex_id |
| works_count | OA Sources counts_by_year | 그 해 출판된 논문 수 |
| cited_by_count | OA Sources counts_by_year | 그 해 받은 인용 수 |
| **if_proxy_openalex** | 직접 계산 | `cite[Y] / (works[Y-1]+works[Y-2])` — 진짜 IF 공식 |
| scimago_id | Scimago | |
| **sjr** | Scimago | Scimago Journal Rank |
| sjr_quartile | Scimago | Q1/Q2/Q3/Q4 |
| scimago_h_index | Scimago | |
| total_docs_year/3y | Scimago | |
| total_cites_3y | Scimago | |
| citable_docs_3y | Scimago | |
| cites_per_doc_2y | Scimago | Scimago의 IF-ish |
| scimago_country/publisher/categories/areas | Scimago | |

→ 이 테이블이 FateCore 학습 라벨의 근원: **"2022년 NEJM에 실린 논문의 expected IF"는 이 테이블의 `if_proxy_openalex` WHERE openalex_id=X AND year=2022**.

### `ingest_runs` (audit)
모든 ingestion 실행 기록 (source, file, rows_seen, rows_upserted, timestamps).

## 현재 데이터 부피 (2026-05-20 시점)

| 자산 | 크기 | 상태 |
|---|---|---|
| pubmed/*.jsonl | ~280 MB | year-bucket 진행 중 |
| openalex/all-*.jsonl | 118 MB | 완료 (45K) |
| semantic-scholar/all-*.jsonl | 482 MB | 완료 (39K, embedding 비중 큼) |
| crossref/all-*.jsonl | 99 MB | 완료 (45K) |
| openalex-sources/sources-*.jsonl | 31 MB | 완료 (4,450 venues) |
| scimago/*.jsonl | 0 | 수동 다운로드 대기 |
| **paperfate.db** | 654 MB | 통합 SQLite |

총 ~1.6 GB. SSD 이전 후엔 DATA_ROOT만 변경.

## 사용 패턴 (예시 쿼리)

### "이 논문과 비슷한 NEJM 논문"
```sql
SELECT p.title, p.year, p.citations_openalex,
       j.display_name AS venue, j.two_yr_mean_citedness AS if_proxy
FROM papers p
LEFT JOIN journals j ON p.venue_openalex_id = j.openalex_id
WHERE p.embedding IS NOT NULL
  AND j.two_yr_mean_citedness > 50
ORDER BY p.citations_openalex DESC
LIMIT 10;
```
→ SPECTER2 cosine similarity는 코드 (similarity-prototype.mjs)에서 처리.

### "2022년 NEJM에 실린 논문들의 expected 5-year citation 분포"
```sql
SELECT p.title, p.citations_openalex,
       jym.if_proxy_openalex AS year_if_proxy
FROM papers p
JOIN journals j ON p.venue_openalex_id = j.openalex_id
JOIN journal_year_metrics jym
  ON jym.openalex_id = j.openalex_id AND jym.year = p.year
WHERE j.display_name = 'New England Journal of Medicine'
  AND p.year = 2022;
```

### "심장학 분야 / RCT만 / 2015-2020 / IF 10+"
```sql
SELECT p.doi, p.title, p.year, p.citations_openalex,
       json_extract(p.publication_types_json, '$') AS pub_types,
       j.display_name AS venue, j.two_yr_mean_citedness AS if_proxy
FROM papers p
JOIN journals j ON p.venue_openalex_id = j.openalex_id
WHERE p.year BETWEEN 2015 AND 2020
  AND p.publication_types_json LIKE '%Randomized Controlled Trial%'
  AND j.two_yr_mean_citedness >= 10
  AND p.mesh_terms_json LIKE '%Heart%';
```

### "IF의 시간 흐름 (Lancet 2010-2025)"
```sql
SELECT year, if_proxy_openalex, works_count, cited_by_count
FROM journal_year_metrics
WHERE openalex_id = (SELECT openalex_id FROM journals WHERE display_name='The Lancet')
ORDER BY year;
```

## FateCore 학습 라벨 매핑

| 학습 출력 | 데이터 소스 |
|---|---|
| Expected journal tier | `papers.venue_openalex_id` → `journals.two_yr_mean_citedness` 분포 |
| Expected citation 5y | `papers.citations_openalex` (논문 publication_year + 5년 이상 경과한 경우) |
| Desk-reject probability | 사용자 입력 + 비슷한 논문이 실제 실린 venue 분포 |
| Actual impact score | citation percentile (field/year-normalized using `journals.topics_json`) |
| Reviewer-risk axes | Q500 LLM 채점 결과 (별도) |

## 다음 데이터 확장 후보

| 확장 | 기대 가치 | 비용 |
|---|---|---|
| 더 많은 seed / 분야 | 코퍼스 두께 | 시간 (NCBI rate) |
| OA full text (PMC, OpenAlex pdf_url) | Q500 본문 채점 가능 | 디스크 (TB) |
| Altmetric (early attention) | 트위터/뉴스/정책 신호 | 유료 |
| **JCR IF (Clarivate)** | 진짜 IF, 우리 proxy 검증 | 유료 (대학 도서관 라이선스 필요) |
| Editor 데이터베이스 | 저널별 editor character | 수동 큐레이션만 가능 |
