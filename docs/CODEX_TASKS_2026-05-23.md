# 코덱스 작업 — 2026-05-23

> 메인 세션에서 PMC AWS S3 fulltext, PMID→PMCID expansion (686K 신규), 5+ enricher 동시 가동 중. iCite RCR 75%, S2 95% 진행. 코덱스는 아래 3개를 병렬 진행.

---

## 작업 1 (HIGHEST) — PMC AWS S3 collector 안정화

### 문제
`scripts/collect-pmc-aws-s3.mjs` (parallel=30, rps=25)가 12시간마다 silent 자살. 최근 마지막 로그는 13:22, 그 후 더 이상 progress 없음. log freshness 확인하면 process 죽음.

```
E:/paperfate/data/_pmc_aws_s3.log  마지막 13:22:29
68,250/865,427 ok=41,645 miss=18,605 short=8000 fail=0 5.7/s eta=2331m
```

### 진단해야 할 것
1. process가 죽는 root cause (memory leak? AWS S3 connection pool exhaustion? Node fetch unhandled rejection?)
2. log에 마지막 라인 출력 후 stack trace 없이 종료 — Node가 EXIT_CODE 1로 죽는지, OS가 kill하는지
3. heap memory profile — 30 parallel workers + 957K queue Set in memory ≈ OK여야 함

### Deliverable
1. **root cause 진단** — docs/PMC_S3_CRASH_DIAGNOSIS.md
2. **scripts/collect-pmc-aws-s3.mjs** 강화:
   - Unhandled promise rejection global handler (process.on('unhandledRejection', ...))
   - Periodic checkpoint to JSONL (확실히 fsync)
   - Heartbeat 로그 (예: 매 5분마다 "alive at <timestamp>" 출력)
   - 60초마다 자동 GC trigger (필요시 `--expose-gc` 옵션)
   - Worker error → respawn (1개 worker 죽어도 나머지 계속)
3. **재시작 wrapper** scripts/run-pmc-s3.ps1:
   - 무한 루프로 collector 가동 + 종료 감지 + 즉시 재시작 (resume-skip이 처리)

### 시간 estimate
- 2-3시간

---

## 작업 2 (HIGH) — Author features propagation

### 배경
`collect-openalex-authors.mjs`가 OpenAlex author records를 fetch 중 (현재 58.5만개). 각 record에 `h_index`, `works_count`, `cited_by_count` 등 있음. 이걸 paper-level feature로 propagate해야 함.

### 현재 상태
- papers에 `first_author_h_index`, `last_author_h_index`, `max_team_h_index`, `median_team_h_index`, `team_size_with_id`, `international_collab` 컬럼 이미 존재 (22.6% coverage)
- 이 컬럼들은 build-unified-db의 ingestAuthors에서 채워지는 것으로 보임. 확인 필요
- OA author 데이터가 차오를수록 더 많은 paper에 채워질 것

### Deliverable
1. **scripts/propagate-author-features.mjs** 작성:
   - `authors` 테이블 (이미 1.45M rows) + `papers.authorships_json` join
   - 각 paper의 author id list → authors table에서 h_index lookup
   - first/last/max/median h_index, team_size, international_collab 계산
   - papers UPDATE batch
2. 멱등성 보장 (이미 채워진 paper도 재계산 OK)
3. 실행 후 coverage 보고 (몇 % 차이 났는지)

### 시간 estimate
- 코드: 1시간
- 실행: 30분-1시간

---

## 작업 3 (MEDIUM) — v0.3 학습용 feature build script

### 배경
v0.2-prod는 production 가동 중 (R²(jcr_jif)=0.435). 신규 enrichment 차오르면 v0.3 학습 가능. 그 전에 feature script 미리 작성.

### v0.3에서 추가할 feature
1. **NIH grant** — has_nih_grant (binary), n_nih_grants (count)
2. **OpenAlex citation** — citations_openalex, fwci
3. **FWCI mode/median by primary_topic** — domain-normalized impact
4. **Author features** — first_author_h_index, last_author_h_index, max_team_h_index, median_team_h_index, team_size_with_id, international_collab
5. **iCite features** — icite_citation_count, icite_nih_percentile, icite_apt, icite_is_clinical, icite_cited_by_clin
6. **Crossref** — reference_count, funder_count (from funder_json)
7. **Unpaywall** — unpaywall_is_oa
8. **Fulltext-derived** — epmc_body_word_count (binary >0), pmc_body_word_count, pmc_figure_count, pmc_table_count, pmc_ref_count
9. **Preprint** — preprint_doi 있음 여부, preprint_pub_gap_days
10. **기존 v0.2 baseline 모두 포함**

### Deliverable
- **scripts/build-fatecore-features-v0.3.mjs**
- 기존 build-fatecore-features.mjs 참고
- 출력: data/features/v0.3-features.csv
- 학습/검증은 train-fatecore-v0.3.py로 따로 (메인 세션에서)

### 시간 estimate
- 2시간

---

## 주의

1. **DB lock**: `papers` 테이블에 UPDATE할 때 busy_timeout=60s. 메인 세션의 collector들이 동시 write 안 함 (JSONL만 씀), build-unified-db만 write. 따라서 코덱스도 UPDATE 시 busy_timeout 충분히 설정.

2. **인계장**: 작업 끝나면 docs/CODEX_HANDOFF_2026-05-23_END.md에 결과 + 메인이 후속으로 해야 할 work 명시.

3. **순서**: 작업 1 즉시 시작 (메인 세션은 PMC S3 collector 죽음 무력함). 작업 2는 OA-authors enricher가 50% 이상 진행되어 데이터 충분 — 가능. 작업 3는 가장 늦게.

4. **메인 세션 진행 상황**:
   - PMC S3 (죽음 → 재시작 필요)
   - PDF (재가동 중, 1.61/s)
   - 5 enrichers + OA-authors + OA-sources (계속 진행)
   - v0.2-prod production 가동
   - iCite + NIH RePORTER + sources ingested

---

## 시작 신호

이 메시지 받은 즉시 **작업 1 (PMC S3 안정화)** 가장 먼저. 그 다음 2 → 3.
