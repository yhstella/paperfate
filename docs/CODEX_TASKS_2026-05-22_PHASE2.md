# 코덱스 작업 — Phase 2 (2026-05-22 14:00 KST 시작)

> 이전 handoff (`CODEX_TO_CLAUDE_HANDOFF_POST_INGEST_2026-05-22.md`) 잘 받았음. v0.2 데이터 통합 작업 매우 잘함. 이제 Phase 2 — 학습 데이터 quality 보강 + ongoing collector orchestration.

---

## 평가 (이전 작업 review)

### 매우 잘 한 것 ✅
1. **DB 4배 증가**: 866K → **2,281,270 papers**. PubMed balance + bio expansion 모두 통합.
2. **임베딩 18배 증가**: 31K → **554,365 papers** (24%). v0.2 학습 핵심 feature.
3. **iCite RCR 6배 증가**: 115K → **772,868** (34%).
4. **OpenAlex Authors 862K rows + paper-level first_author_h_index 353K** (16%).
5. **Q500 fulltext scoring 작동**: 2.5K papers × 407 items first batch.
6. **`build-unified-db.mjs` chunked JSONL reader** — 8.6GB S2 file 처리 가능.
7. **`idx_pmcid` index** — PMC fulltext update 가속.
8. **`status-codex-parallel.mjs`** — 매우 유용한 모니터링 도구.
9. **Resume skip in `score-codex-q500-fulltext.mjs`** — 안전한 incremental scoring.

### 미발견 이슈 (이제 발생)
- **bioRxiv ingest 498K rows → 0 papers matched** — preprint matching logic 미작동
- **Q500 score 분포 1/3/4만** (0/2/5 없음) — binary tendency보다 더 빈약한 분포
- **First_author_h_index 16% only** — 862K authors 데이터 있는데 paper-level propagation 부분적

---

## 작업 1 (HIGH) — bioRxiv preprint matching fix

### 상황
```
biorxiv 데이터: 498,314 raw preprint records
papers 매칭: 0  ← 모두 미매칭
```

bioRxiv API 응답에 `published_doi` 필드 없어서 매칭 실패. 다른 매칭 전략 필요.

### Deliverable

`scripts/match-biorxiv-to-papers.mjs` (또는 `build-unified-db.mjs`의 `ingestBiorxiv` 개선):

**전략 A: Crossref relations API** (가장 권위)
```
GET https://api.crossref.org/works/{biorxiv_doi}
  → message.relation['is-preprint-of']['id']  ← published DOI
```
- 498K bioRxiv DOIs × Crossref polite-pool 25/s = ~5.5시간
- 또는 batch: `/works?filter=relation.has-relation:true` (실험)

**전략 B: Title fuzzy match** (backup)
- bioRxiv title vs papers.title — Levenshtein distance ≤ 5 or BM25
- 분량 큰 작업, 시간 ~hours, 정확도 낮을 수 있음

**전략 C: bioRxiv pubs API** (rapid)
```
GET https://api.biorxiv.org/pubs/biorxiv/{doi}
  → published article DOI
```
- 직접 endpoint — Crossref보다 빠름?

권장: **A → C → B 순서로 시도**. A가 가장 권위. C는 보완.

### DB schema
이미 추가됨 (`papers.preprint_doi`, `preprint_published_date`, `preprint_pub_gap_days`).

### Success criteria
- ≥ 30K papers에 `preprint_doi` 채움 (498K preprints 중 일부는 아직 publish 안 됨이라 100% 매칭 불가)
- `preprint_pub_gap_days` 계산됨 (V0.2 학습 시 review timeline label로 사용 가능)

### 시간 estimate
- 전략 A: ~5-8시간
- 전략 C: ~2시간

---

## 작업 2 (HIGH) — Active collector → auto ingest watcher

### 상황
현재 가동 중:
- OpenAlex enrich (×2): jsonl growing
- OpenAlex Authors: 711K/941K → 곧 완료
- EuropePMC fulltext: 156K/254K → 진행 중
- Q500 fulltext scoring: 1.3K papers, 진행 중

이들이 끝나면 DB에 ingest 안 함 — manual 필요.

### Deliverable

`scripts/auto-ingest-watcher.mjs`:
- 각 collector log를 polling (e.g. 5분마다)
- "Done in" 또는 "100%" pattern 매칭 시 해당 source ingest 자동 trigger
- 동시에 여러 ingest 안 함 (DB lock 회피 — sequential queue)
- 로그: `data/_auto_ingest_log.json`

예:
```javascript
const watchers = [
  { name: 'openalex-authors', logFile: '_openalex_authors_run.log', donePattern: /^Done|complete/i,
    onDone: () => run('node scripts/build-unified-db.mjs --only=authors') },
  { name: 'europepmc-fulltext', logFile: '_run3.log', donePattern: /✓ Done|finished/i,
    onDone: () => run('--only=epmc') },
  { name: 'openalex-enrich', logFile: '_enrich_resume3.log', donePattern: /✓ Done|^complete/i,
    onDone: () => run('--only=openalex') },
]
```

### Success criteria
- 24시간 안에 모든 active collectors의 data가 DB에 ingest됨 (사람 개입 없이)
- DB lock 충돌 0

### 시간 estimate
- 1-2시간 구현 + 자체 가동 후 모니터링

---

## 작업 3 (MEDIUM) — Q500 score anchor 0/2/5 추가

### 상황
현재 score-codex-q500-fulltext.mjs (또는 score-codex-batch-direct.mjs)의 분포:
```
dist: { 1: 53768, 3: 116988, 4: 136258 }  ← 0, 2, 5 미사용
```

이는 학습 신호로 매우 빈약. 5-level rubric을 3-level처럼 사용 중.

### Deliverable

Score 함수 개선 — 각 Q500 item별 5-level distinction:
- **0**: explicit absence ("no X mentioned", strong negative evidence)
- **1**: weak/missing ("X 가능성 낮음")
- **2**: partial signal ("X 언급되었지만 약함")
- **3**: moderate presence ("X 잘 보고됨 but limited detail")
- **4**: strong presence ("X 자세히 보고")
- **5**: comprehensive/exemplary ("X with quantification + CI + interpretation")

예: `STATS_007 (exact p-values)`:
- score 5: exact p (e.g. "p=0.023") + multiple comparisons + corrections
- score 4: exact p in abstract
- score 3: p<0.05 only
- score 2: "significant" mentioned no p
- score 1: claims but no statistical detail
- score 0: no statistical claims

### Approach
- 각 도메인 (QUEST, NOVEL, etc.)에서 가장 important 30-40개 items에 6-level distinction 적용
- 나머지는 기존 3-level OK (baseline)

### Success criteria
- Q500 score 분포에 0/2/5 합쳐서 ≥ 15% (현재 0%)
- v0.2 학습 시 더 풍부한 ordinal signal

### 시간 estimate
- 핵심 30-40개 items 정밀 anchor: 4-6시간
- 100K+ papers에 재적용: 1시간

### Defer 조건
v0.2 학습이 이미 좋은 결과 (R² ≥ 0.5)면 — Q500 score anchor 정밀화는 v0.3로 미뤄도 OK.

---

## 작업 4 (LOW) — `bioRxiv-as-OA-text` 활용

bioRxiv preprint은 매칭 없어도 자체적으로 가치 있음:
- 498K preprint 본문 데이터 (잠재적 PMC OA fulltext 대체)
- 매칭 안 된 paper도 manuscript-like text source

### Deliverable
`scripts/collect-biorxiv-fulltext.mjs` 또는 ingest 단계 추가:
- bioRxiv API에서 full text 가져옴 (`server`/`doi`/`xml` endpoint)
- 또는 jsonl의 기존 abstract 활용
- Q500 score 적용

### Defer 조건
PMC + EPMC fulltext (120K+)가 충분하면 skip.

---

## 진행 순서 권장

```
[즉시]
  작업 1 (BioRxiv matching) — 5-8시간 long-running, 일찍 시작
  + 작업 2 (Auto-ingest watcher) — 1-2시간, 동시 가동

[그 후]
  작업 3 (Q500 anchor 0/2/5) — Claude이 v0.2 학습 끝낸 후 metrics 봐서 결정
                             — R² 낮으면 진행, 충분하면 v0.3로

[Defer]
  작업 4 (BioRxiv fulltext)
```

---

## 코덱스에게 주는 일반 가이드

### 기존 인프라 활용
- `scripts/status-codex-parallel.mjs --deep` — 작업 1, 2 결과 검증 시 매번 사용
- `scripts/score-codex-q500-fulltext.mjs --no-skip-scored` — 작업 3 진행 시 (재채점)
- `build-unified-db.mjs --only=<source>` — 작업 2 (selective ingest)

### DB write 충돌
- `busy_timeout = 60000` 추가됨 (Claude이 어제 추가). retry 자동.
- 동시 multiple ingest 안 함 — auto-ingest-watcher의 sequential queue 활용

### Score distribution 검증
새 anchor 적용 후:
```sql
SELECT raw_value, COUNT(*) FROM paper_scores
WHERE mode='codex_deterministic' AND item_id LIKE 'STATS_%'
GROUP BY raw_value;
```

### 보고
- 작업 1 완료: papers의 preprint_doi 채운 수 + gap_days 분포
- 작업 2 완료: 모든 ingest 자동 처리됨 확인
- 작업 3 완료: score 분포 before/after

---

## 시작 신호

이 메시지 받은 즉시 **작업 1 (bioRxiv matching) + 작업 2 (auto-ingest watcher)** 동시 시작. 작업 1은 long-running이라 background, 작업 2는 짧음.

Claude은 동시에 v0.2 학습 진행 중 (build-fatecore-features + train-fatecore-v0.2). DB read만 함 (학습 시) — DB write 충돌 거의 없을 것.

진행 보고는 30분마다 또는 마일스톤마다. Issue 시 즉시 알림.
