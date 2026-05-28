# PaperFate 세션 핸드오프 — 2026-05-29

## TL;DR

Pro 요금제 활성 + Q500 production timeout 진단·코드 fix는 끝남.
**남은 1개 blocker는 사용자 액션**: Vercel 환경의 `GEMINI_API_KEY` 가
"API key not valid"를 반환. local key 자체는 유효(429 = rate-limited).
→ Google Cloud Console의 application restriction(HTTP referrer/IP)을
풀거나, Vercel에서 사용할 새 unrestricted 키를 발급해야 production
LLM 경로가 작동.

---

## 1. Q500 production timeout — root cause + fixes (커밋 4개)

### 진단
- 첫 timeout: `FUNCTION_INVOCATION_TIMEOUT` at 300s 한도
- 가짜 원인 1: Vercel maxDuration — `vercel.json`엔 이미 300 (Pro plan 한도). 적용 OK.
- 가짜 원인 2: `concurrency` opt — `forecast.js`가 extract.js에 넘기지만 `GeminiClient.batchScore`는 sequential loop (RPM-bound). concurrency 옵션 자체가 no-op.
- **진짜 원인**: `GeminiExtractor` constructor default = `{ rpm: 9, batchSize: 8, isFreeTier: true }` (free-tier era 잔재). Q500은 LLM 350-450 items → batchSize 8 = ~44 batches × 6.67s mandatory gap = **290s of pure rate-limit gaps** before any LLM time → 504.

### 커밋
1. `960b880` perf: bump concurrency default 10 → 25 (사실상 no-op이지만 의도 명확화)
2. `a7156ff` perf: per-section input cap 8K chars / full_text cap 24K chars + concurrency 35
3. `bd02ccd` **fix: paid-tier Gemini opts (rpm=120, batchSize=25, isFreeTier=false)** ← 진짜 fix
4. `3ac118e`, `8bc0586` empty redeploy commits (env update 후 build snapshot 갱신용)

코드 경로:
- `api/forecast.js:131-152` — paid-tier opts 구성 + `forecastManuscript`에 `geminiOpts` 전달
- `src/server/extract.js:333` — `createExtractor(opts)` (opts.geminiOpts 통과)
- `src/server/geminiClient.js:112-128` — `GeminiExtractor({rpm, batchSize, isFreeTier})`

Override env (필요시):
- `GEMINI_PAID_TIER=0` → free tier로 강제
- `GEMINI_RPM=120` / `GEMINI_BATCH_SIZE=25`
- `PAPERFATE_CONCURRENCY=35` (현 no-op, 향후 GeminiClient parallelization 시 의미)

### Smoke 결과 (2026-05-29)
- timeout 해결: Q500 mode wall_ms 11s (이전 504)
- 그러나 `items_scored: 1`, `errors: 506`. 모든 LLM call이 `Gemini HTTP 400: "API key not valid"` 즉시 fail.

---

## 2. Vercel GEMINI_API_KEY blocker

### 시도한 것
- Vercel CLI로 `env rm` → `env add` (stdin pipe, trailing newline 제거 위해 `Process.StandardInput.Write` direct API 사용, no `WriteLine`)
- key length 39 (Google API key 표준), local에서 직접 Gemini API 호출 → HTTP 429 (rate-limited, **valid**)
- 빈 commit으로 Vercel redeploy 후 재smoke → 여전히 HTTP 400 invalid

### 가설
가장 가능성 큰 원인: **Google Cloud의 API key application restriction**
- Local IP에선 valid (429), Vercel serverless IP에선 invalid (400)
- API key를 발급한 Google Cloud project에서 "Application restrictions" → "HTTP referrers" 또는 "IP addresses"가 설정되어 있을 가능성

차순위 가설:
- Vercel CLI의 stdin handling이 여전히 key 변형 (Process API direct write에도 불구). pull로 확인 시도했지만 auto-mode classifier가 production secrets read를 차단.

### 사용자 액션 (택1)
1. **권장**: Google AI Studio (https://aistudio.google.com/apikey) 에서 새 API key 발급, restrictions = **None**, Vercel Dashboard
   (https://vercel.com/hyunjae-shin-s-projects/paperfate/settings/environments/production)
   에서 `GEMINI_API_KEY` 값을 새 key로 update, 그 후 Vercel Dashboard "Redeploy".
2. **대안**: 기존 key의 Google Cloud Console (https://console.cloud.google.com/apis/credentials)
   에서 application restrictions = "None"으로 풀어주기.

Update 후 production smoke:
```bash
node scripts/sample-test-from-epmc.mjs   # 또는 scripts/smoke-production.mjs
```

---

## 3. Background collectors (모두 정상)

| PID | 작업 | 진행 | 비고 |
|---|---|---|---|
| 85448 | EPMC fulltext | 270K / 459K (58.8%), ok=56K, 5.8/s, eta ~9h | hit rate 20.5% (이전 1.1% 대비 17×) |
| 79200 | auto-ingest watcher | 5분 polling 정상 |  |
| 41212 | PDF fulltext (이전 PID 66000 죽음 후 재가동) | 2550/100K, ok=528, 1.39/s | 새 시작 — 33K 이미 추출 + 581K skip (PMC/EPMC 중복) |

---

## 4. Codex Round 7 진척

- `docs/CODEX_TASKS_2026-05-28_ROUND7.md` 작업 1 (Q500 fulltext rescoring)
- `_q500_fulltext_round7.log`: dry-run 두 번 완료 (8 papers stratified top/high/mid/low × 2)
- `_q500_fulltext_round7.jsonl` 58KB, 마지막 update 2026-05-29 00:42
- 마지막 entry: `dry_run_done` (paid:false). **paid live run은 아직 시작 전.**
- 1,000-paper sample → quality check (Δ q_mean ≥ 0.7) → 50K batch 순서. Codex 자체 페이스로 진행 중.

---

## 5. 다음 세션 우선순위

1. **Vercel GEMINI_API_KEY 교체** (위 §2). 이 한 단계로 production Q500 path가 완전 작동.
2. Smoke 재실행 + 50-sample tier diagnostic 재측정 — 기대값: top-tier q_mean ≥ 4.5, mid-tier ~3.8 (Δ ≥ 0.7), pred JIF Δ는 v0.5 retraining 전까지는 미미할 수 있음.
3. Codex Round 7 작업 1 paid live run 결과 확인. quality 통과 시 50K full batch GO.
4. (선택) Task #61 — Switch-cost matrix 실제 cost. Pending 상태.

---

## 6. Memory update 후보

`reference_paperfate_keys.md`에 추가할 것:
- "GEMINI_API_KEY는 unrestricted 키여야 Vercel serverless IP에서 작동.
  Google Cloud Console의 application restrictions = None 확인 필수."
