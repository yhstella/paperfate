# 코덱스 작업 — 2026-05-24 Round 2

> Round 1 (3개) 모두 완수했음. v0.3 feature CSV 준비됨. **이제 v0.3 학습** + 검증 + production deploy.
>
> Round 1 결과 요약:
> - PMC S3 hardened collector 가동 중 (wrapper + node)
> - author propagate: first_h 737K, max_team_h 864K, intl_collab 922K
> - v0.3 features CSV: **857,284 rows × 71 cols** at `E:\paperfate\data\features\v0.3-features.csv`
>
> ⚠️ 메인 세션에서 발견한 버그 1개 (Round 1 외부에서 fix됨):
> - `collect-pmc-aws-s3.mjs` body regex가 `<body id="..">` 못 잡았음 → ok=0 발생
> - commit 1d5ecfb 으로 패치, 하드닝 wrapper가 새 코드로 자동 재시작됨

---

## 작업 1 (HIGHEST) — v0.3 학습 + 검증

### 입력
- CSV: `E:\paperfate\data\features\v0.3-features.csv` (857K rows × 71 cols)
- Manifest: `E:\paperfate\data\features\v0.3-features-manifest.json`
- 기존 학습 스크립트: `scripts/train-fatecore-v0.2.py` (참고)

### 핵심 규칙 (절대 위반 금지)
1. **Random split만**. 연도 기반 split 절대 금지 (이전 v0.1 leakage 사고 재발 방지)
2. **Test set은 train과 random 분리**. 80/20.
3. **Log target**: `log1p(jcr_jif)`, `log1p(citations_5yr)` 사용
4. **Class weighting**: log-binned target inverse-frequency
5. **j_* 같은 paper의 같은 연도 metrics 제외** (v0.2-prod 동일)

### Deliverable
1. **scripts/train-fatecore-v0.3.py**:
   - v0.2와 같은 LightGBM multi-target (jcr_jif, icite_rcr, citations_log)
   - v0.3 features 사용 (NIH, author h-index, fwci, embedding 등 자동 포함)
   - Conformal prediction interval (split conformal, α=0.1)
   - Output: `weights/fatecore-v0.3-*.txt` (LightGBM model)
2. **scripts/eval-fatecore-v0.3.py**:
   - Test set MAE / R²(log) / R²(raw_cal) by target
   - Tier-stratified MAE (top JIF≥30 / high 10-30 / mid 3-10 / low <3)
   - Feature importance ranking (top 30)
   - vs v0.2-prod 비교 표

### 보고
`docs/EVAL_v0.3.md`:
- Train/test sizes
- Per-target metrics
- vs v0.2-prod (R² delta, MAE delta)
- Top 30 feature importance
- Decision: deploy or not (R²(jcr_jif) >= 0.50 이면 deploy 권장)

### 시간
- 코드: 1.5h
- 학습: 1h (GPU 없이 LightGBM, 8 cores)
- eval + 보고: 30분

---

## 작업 2 (HIGH) — v0.3 deploy decision + production update

### 조건부 실행
작업 1 결과 `R²(jcr_jif) >= 0.50` 이고 v0.2-prod (0.435)보다 의미있게 좋으면 deploy.

### Deliverable
1. `src/server/fatecoreInference.js` 의 TARGETS 경로를 `fatecore-v0.3-*.txt` 로 변경
2. `version: 'fatecore-v0.3'` 업데이트
3. metrics 파일 경로도 업데이트
4. local smoke test (EMPA-REG sample) 통과 확인
5. `git push origin main` (Vercel 자동 deploy)
6. paperfate.com 프로덕션 endpoint 검증

### 안 좋으면
v0.3 보류하고 v0.2-prod 유지. Codex가 결정 사유 보고 (어떤 target이 나빠졌는지).

### 시간
- 30분

---

## 작업 3 (MEDIUM) — OpenAlex referenced_works collector

### 배경
현재 papers 테이블에 reference COUNT는 있지만 (`reference_count` from Crossref/S2), **어떤 paper를 cite했는지 list가 없음**. 이건 v0.4의 citation network feature + retrieval에 필수.

### Deliverable
`scripts/collect-openalex-references.mjs`:
1. 대상: 상위 100K papers (high JIF or popular by fwci > 5)
2. OpenAlex `/works/{id}` 의 `referenced_works` field fetch
3. 출력: `data/openalex-refs/refs-{date}.jsonl`:
   ```json
   {"doi":"10.1056/NEJMoa1...","ref_openalex_ids":["W123","W456",...],"n_refs":42,"fetched_at":"..."}
   ```
4. RPS 25 (polite pool with email)
5. Resume-skip 패턴 (기존 collectors 따라)

### 새 DB schema
`paper_references` 테이블:
```sql
CREATE TABLE paper_references (
  doi          TEXT NOT NULL,
  ref_openalex_id TEXT NOT NULL,
  PRIMARY KEY (doi, ref_openalex_id)
);
CREATE INDEX idx_pr_doi ON paper_references(doi);
CREATE INDEX idx_pr_ref ON paper_references(ref_openalex_id);
```

### ingest 함수
`scripts/build-unified-db.mjs`에 추가 또는 별도 `scripts/ingest-paper-references.mjs`.

### 시간
- 코드: 1.5h
- 실행: 1-2시간 (100K papers × 25 RPS)

---

## 작업 4 (LOW) — PDF collector 자살 root cause

### 현황
`scripts/collect-pdf-fulltext.mjs` 가 100-500개 papers 처리 후 silent exit. 메인이 반복 재시작 중. 효용 낮음 (5% OK rate).

### Deliverable
1. 자살 원인 진단 (publisher rate-limit hammer? memory leak? unhandled rejection?)
2. PMC S3 와 같은 hardening 적용 (process.on handlers, heartbeat, allSettled)
3. 또는 — 효용 너무 낮으면 **kill switch** 로 명시적 abandon 권고

### 시간
- 1h

### Defer 조건
작업 1-3 끝난 후에. 우선순위 낮음.

---

## 작업 5 (OPTIONAL) — auto-ingest watcher 강화

### 배경
PMC S3 jsonl 누적되는데 DB ingest 안 함. 메인 세션이 build-unified-db --only=pmc 수동으로 돌려야 반영됨. auto-ingest watcher (`scripts/auto-ingest-watcher.mjs`)가 있는데 가동 여부 불확실.

### Deliverable
- watcher 상태 확인 (PID, 마지막 ingest)
- 안 돌면 launch
- 1시간 간격 polling, `--only=pmc,epmc,pdf` ingest 실행
- 동시 lock 안전성

### 시간
- 30분

### Defer 조건
작업 1-3 끝난 후. 메인 세션이 build-unified-db 한 번 더 돌려도 OK.

---

## 주의

1. **DB busy_timeout 60s** 명시. v0.3 학습은 read-only (CSV에서 읽음) → DB 락 무관.

2. **인계장 필수**: 각 작업마다 `docs/CODEX_HANDOFF_2026-05-24_ROUND2_TASK<N>.md`.

3. **순서**: 1 → (조건부 2) → 3 → (4, 5는 optional).

4. **메인 세션 동시 작업**:
   - Crossref, Unpaywall, OpenAlex enrichers (계속 진행 — Crossref/Unpaywall 90%+, OpenAlex 26%)
   - PMC S3 hardened wrapper (자동 재시작)
   - PDF 재가동 중
   - v0.2-prod production 가동 중

---

## 시작 신호

작업 1 즉시 시작. 학습은 1시간 걸리므로 평행하게 작업 2-3 코드 준비 가능 (단 학습 결과 대기 후 deploy).
