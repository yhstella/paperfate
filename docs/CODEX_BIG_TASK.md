# 코덱스 큰 작업 — 전체 코퍼스 Q500 deterministic baseline scoring

> 사용자가 코덱스에게 paste할 instruction. 한 번에 866K paper × 507 items = 약 440M scoring entries (default-NA expansion 포함).

---

## 평가

직전 작업 (50 papers × Q100 deterministic pass)을 정확히 평가했습니다:

- **잘한 점**: `scripts/score-codex-batch-direct.mjs` 가 정확한 Q500 item ID 사용, article type 분류, NA 처리, evidence 인용 모두 우수. 결정론적이라 재현 가능. Recall이 Claude 직접 채점 (18% explicit) 대비 **52% explicit**으로 훨씬 넓음.
- **한계**: regex 기반이라 의미 이해 부족 (binary peak 1/4). 점수 0~5 spectrum 좁음. 본인이 명시한 대로 "gold label 아님" — bootstrap baseline용.

→ **둘 다 가치 있음**: 코덱스의 wide coverage + Claude/Gemini의 deep nuance. 학습 시 weak vs strong label로 구분 사용.

## 큰 작업 — 전체 코퍼스 Q500 baseline scoring

### 목표
FateCore v0.1 학습 데이터셋 X-y 쌍의 X를 **한 번에 생성**. 866K papers × 507 Q500 items.

### 1. 입력 데이터
- DB: `E:/paperfate/data/paperfate.db`
- Table `papers` (866,327 rows) — abstract 있는 paper만 대상
- Rubric: `docs/rubric/Q500.json` (507 items)

### 2. 출력
- Table `paper_scores` 에 upsert (mode='llm' 또는 'codex')
- 별도 mode 사용 추천 — `mode='codex_deterministic'` (현재 'llm'으로 들어가 있는 50 paper도 마이그레이션)
- 또는 그대로 'llm' 유지하되 raw_value에 'codex' tag

### 3. 권장 구현 방식

**현재 `scripts/score-codex-batch-direct.mjs`를 확장**:
1. CLI flag `--all` 추가 — DB에서 직접 papers iterate
2. Stream-based: 1000 paper batch로 메모리 안전
3. Direct DB upsert (jsonl 중간 단계 skip)
4. Resume: 이미 채점된 paper skip
5. Progress log

### 4. Q500 확장 (Q100 → 전체 507)

현재 `scoreItem()`은 Q100 100 항목만 cover합니다. Q500 나머지 407 항목을 추가하세요:

#### 추가할 도메인 (대략적 분포):
- QUEST: 30 items (8개만 Q100 안에 있음)
- NOVEL: 30 items (5개)
- RELEV: 35 items (6개)
- DESIGN: 45 items (10개)
- POPUL: 40 items (8개)
- EXPOS: 30 items (5개)
- OUTCM: 40 items (8개)
- STATS: 55 items (9개)
- AIPRED: 42 items (5개)
- BIAS: 45 items (6개)
- EXTV: 30 items (7개)
- REPRT: 40 items (8개)
- INTERP: 30 items (7개)
- FIGS: 15 items (3개)

#### 채점 패턴 (Q100과 동일하게):
- Regex로 abstract에서 keyword/구문 검출
- types 부합 안 하면 NA
- 명시적 anchor: 0 (없음) → 1 (약함) → 3 (보통) → 5 (강함)
- Evidence 인용 ≤ 120자

### 5. 우선순위

**Phase 1** (즉시): 전체 866K paper × Q100 (100 items) → 약 86.6M entries
- 약 30-60분 소요 예상

**Phase 2**: 추가 407 items 채점기 작성 + 적용 → 추가 350M entries
- 약 2-4시간 소요 예상

### 6. 품질 보장

- 매 paper마다 article_type 추론 → applicable items만 채점
- types="*" 항목은 모두 채점 (NA 안 함)
- regex pattern 못 잡으면 unknown (0점 강제 X)
- score 분포 1/4 peak 줄이려면 mid-anchor (2, 3) 도 사용 — "weak match" vs "strong match" 구분

### 7. 검증

작업 끝나면:
```bash
DATA_ROOT=E:/paperfate/data node -e "
const db = require('better-sqlite3')(process.env.DATA_ROOT + '/paperfate.db', {readonly:true});
const r = db.prepare('SELECT mode, COUNT(*) AS n FROM paper_scores GROUP BY mode').all();
console.log(r);
"
```

기대 결과:
- mode=external: ~2M (이미 있음)
- mode=rule: ~1M (이미 있음)
- mode=llm: 7K (Claude/Gemini 작업분)
- mode=codex_deterministic: ~86M (Q100) 또는 ~440M (Q500)

### 8. 주의사항

- ⚠️ **abstract NULL인 paper skip** — 채점 불가능
- ⚠️ **DB lock 주의** — score-rubric-batch.mjs와 동시 실행 X
- ⚠️ **paper_scores.score=null + raw_value='unknown'** 형식 — 진짜 None 아니라 explicit "unknown"
- ⚠️ Confidence 0.5 미만이면 unknown 권장
- ⚠️ 866K paper × 507 items = 440M rows → DB 크기 10GB+ 추가될 수 있음. 미리 디스크 여유 확인.

### 9. 산출물 위치

- 새 스크립트: `scripts/score-codex-batch-direct-all.mjs` (또는 기존 확장)
- DB: `E:/paperfate/data/paperfate.db` (upsert)
- 로그: `E:/paperfate/data/_codex-all-progress.log`

---

## 시작 방법

코덱스에게 paste 후:
1. Q100 부분 먼저 866K paper 채점 → 검증
2. 검증 통과하면 Q500 전체 (407 추가 항목) 채점기 작성
3. Q500 전체 채점

각 단계마다 1000-paper sample로 점수 분포 sanity check.
