# PaperFate 배포 가이드

> 운영자용 배포 매뉴얼. `main`에 푸시하고, 잘못된 배포를 롤백하고,
> 새벽 2시에 API 키를 교체해야 하는 사람을 위한 문서입니다.
> 처음에는 한 번 통독하고, 이후에는 §10 체크리스트만 봐도 충분합니다.
>
> 영문판: [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## 1. 호스팅 구조

PaperFate는 정적 SPA + Vercel 서버리스 API 구성이고, 별도의 백엔드
호스트가 없습니다. Vercel 프로젝트 하나가 전부입니다.

| 구성요소 | 위치 |
|---|---|
| 프론트엔드 번들 (`dist/`) | Vercel 정적 호스팅 |
| 서버리스 API (`api/*.js`) | Vercel Node 24 함수 |
| GitHub 저장소 | `main` 브랜치가 유일한 배포 대상 |
| 도메인 (apex) | `paperfate.com` |
| 도메인 (canonical) | `www.paperfate.com` |
| GitHub Actions | `.github/workflows/smoke.yml` (push마다 프로덕션 smoke) |

### 1.1 Vercel 프로젝트

- 프로젝트 이름: `paperfate`
- 프레임워크 프리셋: Vite (자동 인식)
- Build command: `npm run build` → `vite build`
- Output directory: `dist`
- Install command: `npm install --no-audit --no-fund`
- Node 버전: **24**. Project → Settings → General → Node.js Version에서
  지정. GH Action도 24로 고정 — 두 값이 어긋나면 사고가 납니다.
- 프로덕션 브랜치: `main`. PR은 자동으로 preview deployment가 생성되며,
  preview URL은 일회성이라 그대로 두면 됩니다.

### 1.2 도메인 설정

`vercel.json`에서 apex(`paperfate.com`) → `www.paperfate.com`으로
rewrite합니다.

```json
"rewrites": [
  { "source": "/api/(.*)", "destination": "https://www.paperfate.com/api/$1",
    "has": [{ "type": "host", "value": "paperfate.com" }] }
]
```

DNS 레코드 (도메인 등록업체 쪽):

| Type | Name | Value |
|---|---|---|
| A    | `@`  | `76.76.21.21` (Vercel apex IP) |
| CNAME | `www` | `cname.vercel-dns.com.` |

Vercel 프로젝트 **Settings → Domains**에 `paperfate.com`, `www.paperfate.com`
둘 다 등록되어 있어야 합니다. `www`가 정식(primary), apex는
"Redirect to www.paperfate.com (308)"로 설정합니다.

TLS는 Vercel이 자동 발급·갱신하므로 별도 관리할 게 없습니다.

---

## 2. 환경변수

모든 환경변수는 **Vercel → Project → Settings → Environment Variables**에서
관리합니다. **Production**과 **Preview** 두 스코프 모두 설정하고,
Development 스코프는 `vercel dev`로 로컬 실행할 때만 필요합니다.

| 변수 | 필수? | 스코프 | 비고 |
|---|---|---|---|
| `GEMINI_API_KEY` | **필수** (없으면 degraded 모드) | Production + Preview | §2.1 필독 |
| `ANTHROPIC_API_KEY` | 선택 | Production | Gemini 장애 시 fallback LLM |
| `PAPERFATE_INTERNAL_TOKEN` | 권장 | Production + GH Actions secret | smoke / rate-limit 우회 |
| `TELEMETRY_LOG_PATH` | 선택 | Production | JSONL 영속 경로 (없으면 `/tmp/...`) |
| `TELEMETRY_SALT` | 권장 | Production | telemetry IP 해시용 salt |
| `PAPERFATE_ALLOWED_ORIGINS` | 선택 | Production | 쉼표 구분 origin 리스트 |

### 2.1 `GEMINI_API_KEY` — "제한 없음" 규칙

배포 사고의 단골 1위입니다. 두 번 읽어두는 게 좋습니다.

**증상:** API가 200으로 응답하지만 `extractor_used: "rule_fallback"`,
혹은 forecast 로그에 `API key not valid. Please pass a valid API key.`가
찍히는 경우. smoke는 RED가 아니라 AMBER로 떨어집니다 — 사이트는 살아 있고,
대신 rule 추출기로 돌아가는 상태.

**원인:** Vercel 서버리스 함수는 **광범위하게 바뀌는 IP 풀**에서
egress 합니다. Gemini 키에 Google Cloud Console에서 **Application
restriction**(HTTP referrer, IP allowlist, Android, iOS)이 설정되어 있으면
Google이 Vercel에서 오는 호출을 거부합니다.

**조치 (키 생성 시점과 모든 교체 시점에 매번 확인):**

1. Google Cloud Console → **APIs & Services → Credentials**.
2. PaperFate에서 사용 중인 키를 엽니다.
3. **Application restrictions**에서 **None**을 선택합니다.
4. **API restrictions**에서는 **Generative Language API**(또는 사용하는
   Gemini API)만 남겨둡니다 — 이쪽 제한은 안전합니다.
5. 저장. 전파에 30초 정도.
6. 키도 함께 교체했다면 Vercel → Settings → Deployments → 최신 배포에
   **Redeploy**를 눌러 함수가 새 env를 픽업하게 합니다.

Vercel IP 풀은 공개되지 않고 계속 바뀌기 때문에 **allowlist 방식은
불가능**합니다. "None" + API restriction이 정공법입니다.

### 2.2 `ANTHROPIC_API_KEY`

선택 사항. 설정되어 있으면 Gemini 오류·타임아웃 시 Claude로 fallback 합니다.
없으면 rule 기반 추출로 fallback 됩니다 (품질만 낮을 뿐 동작은 합니다).
프로덕션에서는 둘 다 설정해 두는 게 안전합니다.

### 2.3 `PAPERFATE_INTERNAL_TOKEN`

`/api/forecast`는 **시간당 IP당 30회** rate-limit이 걸려 있습니다
(in-process token bucket, `api/forecast.js` 참고). smoke·health 스크립트를
짧은 간격으로 반복 실행하면 한도를 채워버리기 쉽습니다.

`PAPERFATE_INTERNAL_TOKEN`을 충분히 긴 랜덤 문자열로 설정하고,
요청 시 `x-paperfate-internal` 헤더로 같은 값을 실어 보내면
rate-limit을 건너뜁니다.

같은 값을 GitHub Actions 저장소 secret (동일 이름)에도 등록해야
`smoke.yml`이 헤더를 실어 보낼 수 있습니다. `smoke-production-v2.mjs`도
쉘에 `PAPERFATE_INTERNAL_TOKEN`이 export 되어 있으면 자동으로 헤더를
붙입니다.

### 2.4 Telemetry 관련 변수

- `TELEMETRY_LOG_PATH` — JSONL 로그 파일의 절대 경로. beacon이 날짜별로
  rotate 하고 파일당 10 MB에서 끊습니다. Vercel 기본 경로는
  `/tmp/paperfate-telemetry-<YYYY-MM-DD>.jsonl`인데 **cold start 시
  날아갑니다**. 영속이 필요하면 마운트된 볼륨이나 ingest worker 경로를
  지정하세요.
- `TELEMETRY_SALT` — 랜덤 문자열. beacon이 클라이언트 IP를 이 salt로 해싱한
  앞 16자만 기록합니다. 분기마다 교체 권장 — 새 salt 이후의 이벤트는
  이전 데이터와 join이 불가능해지는데, 의도된 동작입니다.

---

## 3. 배포 전 체크리스트 (로컬)

`main`에 푸시하기 **전에** 저장소 루트에서 실행하세요. GH Action이 돌리는
검사 중 프로덕션 호출 부분만 빠진 동일 세트입니다. 전체 2분 이내.

```bash
# 1. 테스트
node scripts/run-tests.mjs

# 2. import 경로 / 모듈 경계 lint
node scripts/lint-imports.mjs

# 3. 프로덕션 빌드 (타입 관련 이슈도 빌드 시점에 잡힘)
npm run build

# 4. 번들 사이즈 예산 (gzip 기준)
node scripts/check-bundle-budget.mjs
```

하나라도 non-zero exit이면 **푸시 금지**입니다. UI를 건드린 후 가장 자주
막히는 건 4번이고, 어떤 청크가 예산을 초과했는지는 스크립트 출력에 그대로
표시됩니다.

---

## 4. 배포

```bash
# 작업 트리가 깨끗한 main에서
git push origin main
```

이게 끝입니다. Vercel이 `main`을 감시하다가 푸시 후 5초 이내에 빌드를
시작하고, 보통 60–90초 안에 빌드가 끝나면서 새 배포가 프로덕션 alias로
승격됩니다.

같은 push 트리거로 GitHub Actions의 `smoke.yml`이 실행되어
`smoke-production-v2.mjs --quick`을 실제 도메인 대상으로 돌립니다.
**Actions** 탭에서 결과를 확인하고, 실패하면 §6 (롤백)로 갑니다.

---

## 5. 배포 후 검증

둘 다 돌립니다. 합쳐서 20초 정도.

```bash
# Quick: 공개 엔드포인트 11개를 응답 구조 + latency 예산 기준으로 점검
node scripts/smoke-production-v2.mjs --quick

# Full: smoke + 보안 헤더 + PWA + SEO 마크업 + rate-limit 헤더
node scripts/health-check.mjs
```

판정 기준:

- **Green:** 전부 통과. 배포 OK.
- **Amber (WARN):** `extractor_used: rule_fallback` 또는
  `llm_health.status: degraded`. 사이트는 살아 있지만 Gemini가 막힌
  상태 — §2.1과 §7 확인.
- **Red (FAIL):** rate-limit 외의 4xx, 5xx, 또는 보안 헤더 누락.
  롤백합니다 (§6).

두 스크립트 모두 `--base-url`로 preview 배포나 staging URL을 지정할 수
있습니다.

---

## 6. 롤백

PaperFate 배포 경로에는 **DB 마이그레이션이 없습니다**. 롤백은 프론트
번들과 서버리스 함수만 갈아끼우는 작업이라 즉시·안전합니다.

1. Vercel 대시보드 → **Deployments**.
2. 사고 직전의 마지막 정상 배포(타임스탬프 기준)를 찾습니다.
3. 우측 `⋯` 메뉴 → **Promote to Production**.
4. 확인. 프로덕션 alias가 5초 이내에 옮겨갑니다.
5. `node scripts/health-check.mjs`를 다시 돌려 green인지 확인.

롤백 후에는 사고 커밋을 revert 하는 PR을 만들어 GitHub `main`을 현재
배포 상태에 맞춥니다. 한 사이클 이상 `main`이 프로덕션보다 앞서 있으면
다음 push가 사고 커밋을 다시 배포해 버립니다.

---

## 7. 자주 발생하는 문제

### 7.1 `GEMINI_API_KEY` 거부 — "API key not valid"

§2.1 참고. "Gemini 죽었어요" 제보의 95%는 Application Restriction이 None이
아니어서 발생합니다.

빠른 진단:

```bash
curl -s https://paperfate.com/api/status | jq '.llm_health'
```

`status: "degraded"`이고 `last_error`에 `API key not valid`가 보이면
Google Cloud Console 제한 설정 문제입니다. `last_error`가 타임아웃이나
Google 쪽 5xx이면 업스트림 장애 — 기다리거나 Anthropic fallback에
의존하면 됩니다.

### 7.2 새로 추가한 API 파일이 404

**원인:** Vercel은 `api/` 폴더의 파일명이 `_`로 시작하면 무시합니다.
초안으로 만든 `api/_telemetry-beacon.js`가 프로덕션에서 조용히 404를
반환하던 사고가 있었고, `api/telemetry-beacon.js`로 이름을 바꿔
해결했습니다.

**규칙:** `api/*.js` 파일명을 절대 `_`로 시작하지 말 것. 엔드포인트가
아닌 헬퍼는 `src/server/` 아래에 두고 import 합니다.

### 7.3 smoke 도중 `/api/forecast`가 429

Rate limiter (30회/IP/시간)가 발동했습니다. 둘 중 하나:

- 한 시간 기다리거나 (버킷이 2분마다 1 토큰씩 충전됨),
- 요청에 `x-paperfate-internal: $PAPERFATE_INTERNAL_TOKEN` 헤더를 실어
  버킷을 우회합니다. smoke·health 스크립트는 env가 export 되어 있으면
  자동으로 헤더를 붙입니다.

OPTIONS preflight는 카운트되지 않으니 CORS는 원인이 아닙니다.

### 7.4 로컬은 통과 / Vercel은 실패

거의 항상 Node 버전 차이입니다. Vercel의
**Settings → General → Node.js Version**, 로컬 `node --version`, GH Action의
`node-version: '24'`가 모두 24인지 확인하세요. 24로 통일이 정답입니다.

### 7.5 Telemetry 로그가 안 남음

기본 `/tmp/...` 경로는 Vercel에서 ephemeral 입니다. `TELEMETRY_LOG_PATH`를
영속 마운트로 지정하거나, JSONL은 best-effort로 두고 Vercel 로그 드레인이
잡아주는 `[telemetry]` stdout 라인을 사용합니다.

---

## 8. 모니터링

- **GitHub Actions → Production smoke** — `main`으로의 모든 push와
  `workflow_dispatch`에서 `smoke-production-v2.mjs --quick`을 실행합니다.
  실패는 GitHub 기본 알림으로 들어옵니다.
- **Vercel → Logs** — 클라이언트 이벤트는 `[telemetry]`, API 추적은
  `request_id`로 검색.
- **`/api/status`** — 가장 가벼운 라이브 헬스 프로브. `llm_health`,
  `extractor`, 배포된 git SHA를 반환합니다. 외부 uptime 모니터에 1분
  간격으로 걸어두면 충분합니다.

push 단위 smoke 외에 일일 정기 점검이 필요하면 cron에
`node scripts/health-check.mjs`를 등록하세요.

---

## 9. 보안 헤더

모든 보안 헤더는 `vercel.json`에서 일괄 적용합니다. 서버리스 함수로
옮기지 마세요 — Vercel의 `headers` 블록은 모든 라우트(정적 SPA, SW, API)에
일관되게 붙여주므로 한 곳에서 관리하는 게 안전합니다.

| 헤더 | 값 | 의도 |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | 2년 HSTS, preload 등록 가능 |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing 차단 |
| `X-Frame-Options` | `DENY` | clickjacking 차단 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 외부로 전체 URL 누출 방지 |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=(), payment=()` | 사용하지 않는 강한 권한 차단 |
| `Content-Security-Policy` | 아래 참고 | 좁은 default-src, 제한된 connect-src |

CSP 값 (`vercel.json`과 동기 유지):

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
connect-src 'self' https://api.openalex.org https://*.vercel.app;
font-src 'self' data:;
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

`health-check.mjs`가 샘플 라우트에서 헤더 존재 여부를 검증하므로,
편집 중 헤더가 사라지면 곧바로 red가 됩니다.

새 외부 엔드포인트(예: 3rd-party API)를 호출하게 되면 `vercel.json`의
**두 블록 모두**(catch-all과 `/api/(.*)`)에서 `connect-src`를 업데이트해야
합니다. 한 쪽만 고치면 API 라우트에서만 fetch가 깨지는데, smoke로는
잘 안 잡히는 패턴입니다.

---

## 10. 빠른 참조

```bash
# 배포 전
node scripts/run-tests.mjs && \
  node scripts/lint-imports.mjs && \
  npm run build && \
  node scripts/check-bundle-budget.mjs

# 배포
git push origin main

# 배포 후
node scripts/smoke-production-v2.mjs --quick
node scripts/health-check.mjs

# 롤백
# Vercel 대시보드 → Deployments → 이전 배포 → Promote to Production
```
