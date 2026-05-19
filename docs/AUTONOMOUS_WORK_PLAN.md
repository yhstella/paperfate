# PaperFate Autonomous Work Plan

**Initiated:** 2026-05-19 (시작 시각은 PROGRESS.md 첫 entry에 기록)
**Mode:** autonomous, user unavailable, **DO NOT ASK QUESTIONS**
**Initiated by:** user instruction "쉬고 4시간 뒤부터 진행해 … openalex/s2/crossref/pubmed 총동원해서 local 데이터베이스 확장 … 알아서 작업을 진행해"

## 깨어났을 때 첫 번째 할 일

1. `docs/AUTONOMOUS_PROGRESS.md` 읽기
2. 첫 entry가 있는지 확인:
   - **없으면**: 이 세션이 첫 wake-up. 시작 시각 기록. 4시간이 안 지났으면 계속 쉬기.
   - **있으면**: 시작 시각으로부터 경과 시간 계산.
3. 경과 < 4시간: ScheduleWakeup으로 다음 1시간 후 깨우기 예약 + 종료
4. 경과 ≥ 4시간: 작업 시작 (Track A + B 동시)

## Stop conditions (어느 하나라도 만족하면 중단)

1. 사용자가 새 메시지를 보냄 (즉시 요약 작성 후 stop)
2. Track A 4개 + Track B 동기화 모두 완료
3. 시작 후 7일 경과
4. Anthropic API 비용 누적 $50 초과

## Track A — 구현 (순서대로 실행, 한 세션에 한 chunk씩)

### A1. Server extraction pipeline (최우선)

**목표**: `POST /api/forecast`로 manuscript를 받아 Q500 점수 반환.

**파일**:
- `src/server/extractionPrompt.ts` — system prompt template (evidence-first)
- `src/server/extract.ts` — per-item 채점, 병렬 batch
- `src/server/anthropicClient.ts` — retry+rate-limit 래퍼
- `api/forecast.ts` — Vercel function endpoint
- `scripts/test-extract.mjs` — 샘플 manuscript로 end-to-end 테스트

**Prompt 구조 (evidence-first)**:
```
You are scoring one PaperFate Q500 rubric item.

ITEM: {id} — {name}
QUESTION: {q}
RUBRIC (score → anchor):
  0: {rubric[0]}
  1: {rubric[1]}
  ...
EVIDENCE REQUIRED: {evidence.join(", ")}
APPLICABLE TO: {types}
ARTICLE TYPE OF MANUSCRIPT: {article_type}

MANUSCRIPT:
{title}

{abstract}

[full_text optional]

PROCEDURE:
1. If article_type ∉ types and types !== "*", emit applicability="not_applicable".
2. Search manuscript for evidence matching required keywords. If none findable, emit "UNK".
3. Quote most relevant ≤30-word span (verbatim).
4. Pick rubric anchor that best matches; score = anchor index.
5. Confidence: 0.9+ if explicit quote, 0.6-0.8 if implied, <0.5 if uncertain.
6. Return JSON: {id, score, applicability, confidence, evidence_text, evidence_section, rationale_short, scoring_mode:"llm"}

OUTPUT JSON ONLY. NO PROSE.
```

**모델 선택 전략**:
- Default: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)
- Fallback (confidence < 0.5 또는 critical Q100 items): Sonnet 4.6 (`claude-sonnet-4-6`)
- 평균 비용 목표: Q100 한 편 ~$0.003, Q500 한 편 ~$0.025

**병렬화**: `Promise.all` 10개씩. Q100 = 10 batch = ~3초 p50.

**Article type detection**: `extractMeta.js`의 `extractStudyType`을 server에서도 호출. 또는 별도 Claude 호출로 분류.

**검증 방법**: `scripts/test-extract.mjs`에 SAMPLE (Empagliflozin CKD RCT) 넣어서 Q100 전체 채점 → JSON 출력 → 확인.

### A2. Rule-layer (hybrid items 대체)

**목표**: ~40개 hybrid-mode item을 regex로 결정론적 추출. LLM 비용 절감 + 일관성.

**파일**: `src/server/ruleExtractors.js`

**함수 목록** (Q500.json에서 `mode: "hybrid"` 또는 `mode: "rule"` 필터):
- `extractSampleSize` (이미 `src/lib/extractMeta.js`에 있음 — 재사용)
- `extractAUC(text)` → `0.872 (95% CI 0.851-0.893)` 같은 패턴
- `extractCindex(text)` → c-index, c-statistic, concordance
- `extractPValueExact(text)` → "p = 0.003" vs "p < 0.05"
- `extractCI(text)` → 95% CI 존재 여부
- `extractNCT(text)` → /NCT\d{8}/
- `extractISRCTN(text)`, `extractPROSPERO(text)`, `extractOSF(text)`
- `extractKappa(text)` → κ = 0.XX
- `extractFollowUpDuration(text)` → "median 6.4 years", "12-month follow-up"
- `extractCRediT(text)` → CRediT taxonomy 사용 여부
- `extractFunding(text)` → grant number 패턴 (NIH R01..., NRF...)
- `extractSoftwareVersion(text)` → R 4.X.X, Python 3.X, SPSS XX
- `extractGuideline(text)` → CONSORT/STROBE/TRIPOD/PRISMA mention
- `extractMulticenter` (이미 있음)
- `extractMultiCountry(text)` → 2+ countries named

각 함수 반환: `{ value, evidence_text, evidence_section, confidence }` 또는 `null`.

**Wiring**: `extract.ts`에서 item.mode가 hybrid면 rule 먼저 시도 → null이면 LLM fallback.

### A3. Calibration set 200편

**목표**: human gold standard 만들 수 있는 stratified sample.

**파일**: `scripts/build-calibration-set.mjs`

샘플링 전략 (총 200편):
- 25 cardiology (예: cardiology_hf seed에서)
- 25 oncology
- 25 neurology
- 25 endocrinology
- 25 hepatology
- 25 infection
- 25 AI clinical models
- 25 meta-analysis

각 seed에서 stratified random sampling. seed가 충분치 않으면 다른 seed로 보충.

**출력**: `data/calibration/calibration-set.jsonl`
- 각 record: { pmid, doi, title, abstract, seed, sampled_at }

**human annotation tool**: 후순위 (별도 lightweight 페이지로 나중). 일단 JSONL ready만.

### A4. Frontend result viz

**목표**: mock engine → /api/forecast 연결, 결과 시각화 강화.

**변경**:
- `src/lib/forecastClient.js` (NEW) — fetch /api/forecast, stream progress (SSE 또는 polling)
- `src/components/Simulator.jsx` — `simulate(form)` → `forecast(form)` 교체
- `src/components/ResultPanel.jsx` — 새 schema (14-domain rollup, Q100/Q500 toggle) 지원
- `src/components/DomainRollup.jsx` (NEW) — 14개 domain bar chart, strong/weak highlight
- `src/components/ProgressStream.jsx` (NEW) — "Scoring 23/100 items..." 진행률
- `src/components/Q100Q500Toggle.jsx` (NEW) — 두 모드 전환

**Mock engine 유지**: `?mock=true` query param이면 mock 사용 (dev fallback).

---

## Track B — Local DB 확장 (Track A와 병렬)

**중요: DATA_ROOT env var**
모든 스크립트는 `process.env.DATA_ROOT || path.join(rootDir, 'data')`로 데이터 경로 결정. 사용자가 곧 SSD로 옮길 거라서 — 옮긴 뒤 `DATA_ROOT=D:\paperfate-data` 같은 식으로 설정만 바꾸면 됨.

기존 `scripts/collect-pubmed.mjs`, `scripts/stats-pubmed.mjs`도 이 패턴으로 업데이트.

### B1. PubMed 나머지 23 seed 수집

이미 7개 완료. seeds.json에 정의된 23개 더 필요.

```bash
NCBI_EMAIL=yhstella@gmail.com node scripts/collect-pubmed.mjs
```

세션 길이 한계 때문에 background로 run. `run_in_background: true`로 Bash 호출.

### B2. OpenAlex 보강

**파일**: `scripts/collect-openalex.mjs`

- Input: `$DATA_ROOT/pubmed/*.jsonl`에서 DOI 추출
- API: `https://api.openalex.org/works/doi:{doi}?mailto=yhstella@gmail.com`
- Rate: polite pool = 10 req/s
- 추출 필드: `id`, `doi`, `cited_by_count`, `fwci`, `concepts[].id+display_name+level+score`, `host_venue.id+display_name+issn`, `open_access.is_oa+oa_url`, `publication_year`, `type`, `referenced_works_count`, `counts_by_year`
- 출력: `$DATA_ROOT/openalex/<seed>-<date>.jsonl` (또는 한 파일 `all-<date>.jsonl`)
- Idempotent: 이미 받은 DOI 스킵

### B3. Semantic Scholar 보강

**파일**: `scripts/collect-semantic-scholar.mjs`

- API: `https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}?fields=citationCount,influentialCitationCount,embedding,referenceCount,tldr,fieldsOfStudy,publicationVenue,openAccessPdf`
- Rate: 1 req/s without key, 더 빠르면 `S2_API_KEY` env var 사용
- 핵심: **embedding (SPECTER2, 768-d)** — 나중에 vector similarity index 만들 때 씀
- 출력: `$DATA_ROOT/semantic-scholar/<seed>-<date>.jsonl`

### B4. Crossref 보강

**파일**: `scripts/collect-crossref.mjs`

- API: `https://api.crossref.org/works/{doi}`
- Header: `User-Agent: paperfate/0.2 (mailto:yhstella@gmail.com)`
- 추출: `is-referenced-by-count`, `license[]`, `funder[]`, `abstract` (PubMed에 없을 때 backup), `published.date-parts`
- 출력: `$DATA_ROOT/crossref/<seed>-<date>.jsonl`

### B5. 통합 SQLite DB

**파일**: `scripts/build-unified-db.mjs`

```sql
CREATE TABLE papers (
  pmid TEXT,
  doi TEXT PRIMARY KEY,
  title TEXT,
  abstract TEXT,
  journal TEXT,
  issn TEXT,
  year INTEGER,
  publication_types JSON,
  mesh_terms JSON,
  authors JSON,
  first_affiliation TEXT,
  -- OpenAlex
  oa_id TEXT,
  citations_openalex INTEGER,
  fwci REAL,
  concepts JSON,
  venue_openalex_id TEXT,
  venue_name TEXT,
  is_oa BOOLEAN,
  -- Semantic Scholar
  s2_id TEXT,
  citations_s2 INTEGER,
  influential_citations INTEGER,
  embedding BLOB,
  fields_of_study JSON,
  tldr TEXT,
  -- Crossref
  citations_crossref INTEGER,
  license JSON,
  funder JSON,
  -- Source seeds
  seeds JSON,
  -- Provenance
  fetched_pubmed_at TEXT,
  fetched_openalex_at TEXT,
  fetched_s2_at TEXT,
  fetched_crossref_at TEXT
);
CREATE INDEX idx_pmid ON papers(pmid);
CREATE INDEX idx_year ON papers(year);
CREATE INDEX idx_journal ON papers(journal);
CREATE INDEX idx_citations ON papers(citations_openalex);
```

`better-sqlite3` 패키지 추가 (`npm i better-sqlite3`).

- DB 경로: `$DATA_ROOT/paperfate.db`
- 모든 JSONL을 읽어 upsert
- Embedding은 BLOB로 저장 (4×768 = 3072 bytes/paper, 60K papers ≈ 180MB)
- Idempotent: re-run safe

### B6. (선택, 여유 있으면) Vector index

`sqlite-vec` extension 또는 별도 `embeddings.bin` (raw float32 array + 인덱스 파일) — 추후 server에서 ANN search용.

---

## 세션 운영 패턴

각 wake-up 세션의 표준 흐름:

1. **시작**:
   - `docs/AUTONOMOUS_PROGRESS.md` 읽기
   - 경과 시간 계산
   - 4시간 이전이면 다음 wake-up만 예약하고 종료

2. **작업 단위 결정**:
   - Track A 다음 미완료 task 1~2개
   - Track B의 background 프로세스 상태 확인 (`tasklist | grep node` 또는 파일 크기 확인)
   - 한 세션에 ~30-60분 분량만

3. **실행**:
   - 코드 작성
   - 로컬 테스트 (preview server, 또는 script 직접 실행)
   - commit + push (Vercel auto-deploy)

4. **마무리**:
   - PROGRESS.md에 entry 추가
   - 다음 ScheduleWakeup (작업 남았으면 ~1시간 후, 거의 끝났으면 더 짧게)

## Commit 규칙

- 메시지 형식: `feat(autonomous): <description> [A1|A2|...|B1|...]`
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` 포함
- 매 task 완료마다 별도 commit
- `--no-verify` 금지

## Error handling

- 모든 외부 API 호출: retry 3회 (exponential backoff)
- 3회 실패 시 PROGRESS.md에 로그하고 다음 task로
- Git push 실패: `git pull --rebase` 후 재시도
- 데이터 파일 절대 삭제 금지 (backup 우선)
- Force push 금지

## SSD 마이그레이션 대비

새 스크립트 작성 시 반드시:
```js
const DATA_ROOT = process.env.DATA_ROOT || path.join(rootDir, 'data')
```

기존 `scripts/collect-pubmed.mjs`도 이 패턴으로 한 번 업데이트. README에 환경변수 설명 추가.

사용자가 SSD 이전을 알릴 때 (사용자 응답 → stop condition 발동):
1. 이전 안내 문서 `docs/SSD_MIGRATION.md` 작성 (data 폴더 통째로 복사 → DATA_ROOT 갱신 → 검증 스크립트 실행)

## 우선순위 큐 (실패 대비 순서)

순서대로 실행. 어느 task가 막히면 PROGRESS에 기록 후 다음 task.

1. **A1.1**: anthropicClient.ts + extractionPrompt.ts 만들기
2. **A1.2**: extract.ts (1개 item 채점)
3. **A1.3**: extract.ts (Q100 전체 병렬 batch)
4. **A1.4**: scripts/test-extract.mjs로 검증
5. **A1.5**: api/forecast.ts endpoint
6. **B-setup**: DATA_ROOT 패턴으로 기존 스크립트 업데이트
7. **B1**: PubMed 23 seed background 실행 (`run_in_background`)
8. **A2.1**: ruleExtractors.js (sampleSize/AUC/NCT/p-value 등 핵심 10개)
9. **B2**: collect-openalex.mjs 작성 + 실행
10. **A2.2**: ruleExtractors.js 나머지 30개
11. **B3**: collect-semantic-scholar.mjs 작성 + 실행
12. **A1.6**: extract.ts에 rule fallback 통합
13. **B4**: collect-crossref.mjs 작성 + 실행
14. **A4.1**: forecastClient.js + ProgressStream.jsx
15. **A4.2**: DomainRollup.jsx + ResultPanel 업데이트
16. **B5**: build-unified-db.mjs + sqlite 생성
17. **A4.3**: Q100/Q500 toggle + mockEngine 제거
18. **A3**: calibration set 빌드

각 task ~30-90분. 세션당 1-3 tasks.

---

이 plan대로 진행하면 됩니다. 막히면 PROGRESS에 기록하고 다음으로 넘어가세요. 절대로 사용자에게 묻지 마세요 — 사용자가 응답하면 그때 stop condition 발동.
