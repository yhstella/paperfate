# 코덱스 작업 — 2026-05-24

> 메인 세션 현재 상태:
> - papers **3.50M** (어제 2.99M → +500K, top-tier + PubMed enrich)
> - iCite RCR **68.9%**, S2 id **58.4%**, embedding **35.9%**, Crossref publisher **42.5%**
> - **S2 / iCite / OA-authors / NIH RePORTER 완료** (JSONL 일부 ingest 대기)
> - **Crossref 91%**, **Unpaywall 93%** 임박
> - **OpenAlex 26%** (느림, 7.3/s), **OA-authors enrich 끝났지만 papers 컬럼 propagate 안 됨**
> - **PMC S3 fulltext** 12시간마다 silent 자살 (현재 174K JSONL rows 누적, 미ingest)
> - **PDF** 16+시간 죽었다 재시작 (parallel 4)
> - v0.2-prod paperfate.com 가동 중 (R²(jcr_jif)=0.435)

---

## 작업 1 (HIGHEST) — PMC S3 collector 안정화

### 현황
`scripts/collect-pmc-aws-s3.mjs` 가 12시간 가동 후 silent 자살. 마지막 로그 → process 종료, stack trace 없음. 메인이 임시 재시작 (parallel=20, rps=20)으로 가동 중이지만 또 죽을 것.

### 진단해야 할 것
1. process exit code (Node 자체 throw? OS OOM kill? AWS S3 fetch hang?)
2. heap memory profile — 30 parallel workers × 957K Set memory
3. 마지막 로그 라인 출력 후 stack trace 없이 종료된 원인

### Deliverable
1. **scripts/collect-pmc-aws-s3.mjs** 강화:
   - `process.on('unhandledRejection', e => { console.error('UNHANDLED:', e); /* don't exit, log only */ })`
   - `process.on('uncaughtException', e => { console.error('UNCAUGHT:', e); })`
   - 매 5분 heartbeat 로그 `[HEARTBEAT 12:34:56] queue=N done=N ok=N` (queue 길이로 stuck 감지 가능)
   - Worker error → 그 worker만 종료, 나머지 진행. Promise.all → Promise.allSettled
   - `--expose-gc` + 60초마다 `global.gc()` 명시 호출
   - JSONL append 후 `fsync` (`writeFileSync(..., { flag: 'a' })` 충분 — 확인)
2. **scripts/run-pmc-s3.ps1** 무한 재시작 wrapper:
   ```powershell
   while ($true) {
     node scripts/collect-pmc-aws-s3.mjs --parallel=20 --rps=20 2>&1 |
       Tee-Object -FilePath E:/paperfate/data/_pmc_aws_s3.log -Append
     Start-Sleep -Seconds 30
   }
   ```
3. **docs/PMC_S3_CRASH_DIAGNOSIS.md** root cause + 강화 점 요약

### 시간
2-3h

---

## 작업 2 (HIGH, 즉시 가능) — Author features propagation

### 배경 — 데이터 준비됨
- `collect-openalex-authors.mjs` **DONE** (output 2.15GB, 약 1M author records)
- `authors` 테이블 1.45M rows (build-unified-db가 ingest 완료)
- `papers.authorships_json` 28.9% paper에 채워져 있음
- 하지만 `papers.first_author_h_index` 등은 **21.1%만 채워짐** — propagation 안 됨

### 추정 원인
`ingestAuthors`가 papers.authorships_json + authors 테이블 join 시 일부 author id가 authors 테이블에 없어서 skip된 듯. 또는 ingestAuthors가 이전 데이터로만 propagate.

### Deliverable
**scripts/propagate-author-features.mjs**:
1. `SELECT doi, authorships_json FROM papers WHERE authorships_json IS NOT NULL`
2. 각 paper의 authorships_json parse → author OpenAlex ID 목록
3. `authors` 테이블에서 lookup → h_index, works_count, cited_by_count, country_code
4. 계산:
   - `first_author_h_index` = authorships[0]의 h_index
   - `last_author_h_index` = authorships.last의 h_index
   - `max_team_h_index` = max(h_indices)
   - `median_team_h_index` = median(h_indices)
   - `team_size_with_id` = author중 OpenAlex id 있는 수
   - `international_collab` = 1 if 2+ distinct countries
5. UPDATE papers batch (5K씩 transaction)
6. 멱등성: 기존 값 있어도 재계산 후 overwrite
7. 실행 후: `first_author_h_index` coverage 21.1% → ? % 보고

### 시간
- 코드 1h
- 실행 30분-1h

---

## 작업 3 (MEDIUM) — v0.3 학습용 feature build

### 배경
v0.2-prod 가동 중 (R²=0.435). 신규 enrichment 거의 다 차오름. v0.3 학습 준비.

### v0.3 신규 feature (v0.2 baseline + 추가)
| 카테고리 | 컬럼 |
|---|---|
| NIH | has_nih_grant, n_nih_grants |
| OpenAlex | citations_openalex, fwci |
| Domain-norm | fwci - mean(fwci by primary_topic_id) |
| Author | first_author_h_index, last_author_h_index, max_team_h_index, median_team_h_index, team_size_with_id, international_collab |
| iCite | icite_citation_count, icite_nih_percentile, icite_apt, icite_is_clinical, icite_cited_by_clin |
| Crossref | reference_count, funder_count (parse funder_json length) |
| Unpaywall | unpaywall_is_oa (1/0) |
| Fulltext-derived | epmc_body_word_count, pmc_body_word_count, pmc_figure_count, pmc_table_count, pmc_ref_count |
| Preprint | preprint_doi 있음, preprint_pub_gap_days |
| **기존 v0.2 모두** | mesh, journal_y_metrics 등 그대로 |

### 데이터 누수 방지
- `j_*` (target journal metrics): **절대 같은 paper의 같은 연도 jcr_jif 사용 금지** (v0.1에서 R²=0.999 leakage 발생)
- target journal feature는 publication_year < paper_year 인 metrics만 사용

### Deliverable
- **scripts/build-fatecore-features-v0.3.mjs**
- 기존 `build-fatecore-features.mjs` 참고 (in-memory cache 패턴 그대로)
- 출력: `data/features/v0.3-features.csv` (550K rows, 60-80 columns 예상)
- column manifest: `data/features/v0.3-features-manifest.json`

### 시간
2-3h

---

## 작업 4 (LOW, optional) — Q500 fulltext 재채점 (PMC S3 신규)

### 배경
PMC S3가 새로 fetch한 174K papers (그리고 차차 800K까지) — 기존 `score-codex-q500-fulltext.mjs`가 PMC fulltext에 대해 채점 가능.

### Deliverable
PMC S3 ingest 완료 후 (paperfate.db에 pmc_body_word_count > 0 인 row 증가) `score-codex-q500-fulltext.mjs --only-new` 옵션 추가 → 기존 channel 'codex_deterministic' 이 paper_scores 테이블에 없는 paper만 재채점.

### 시간
- 옵션 추가 30분
- 실행: 174K paper × 500 items × ~10ms = ~14h

### Defer 조건
작업 1-3 완료 후. PMC S3 ingest가 다음 build-unified-db에서 자동 ingest될 때.

---

## 주의

1. **DB busy_timeout**: 60s 명시. 메인 세션 collector들은 JSONL만 씀 (DB write 안 함), build-unified-db만 write. 코덱스 UPDATE 시 충돌 적음.

2. **인계장 필수**: 작업별로 `docs/CODEX_HANDOFF_2026-05-24_TASK<N>.md` 작성. 메인 세션이 그것 보고 후속 검증.

3. **순서**: 작업 1 (PMC S3 안정화) → 작업 2 (author propagation, 즉시 가능) → 작업 3 (v0.3 features). 작업 4는 보류.

4. **메인 세션 동시 작업**:
   - Crossref + Unpaywall (90%+ 진행, ~3h 남음)
   - OpenAlex (느림, 며칠)
   - PMC S3 (임시 가동, 또 죽음 예상)
   - PDF (재가동, 1-2/s)

---

## 시작 신호

작업 1 → 2 → 3 순서대로. 1, 2는 병렬 가능 (다른 파일 수정).
