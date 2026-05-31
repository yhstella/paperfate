# PaperFate — 로드맵

> 만들고 있는 것, 만들지 않을 것, 그리고 어떤 순서로 만들 예정인지를 정리한
> 문서. 위시리스트가 아니라 실제 상태 태그를 붙였다. 어렵거나 느리거나
> 불확실한 항목은 그렇다고 적어 두었다.
>
> 영문 버전: [ROADMAP.md](./ROADMAP.md)
>
> 마지막 업데이트: 2026-05-30. 분기는 달력 기준 — Q3 = 2026년 7~9월,
> Q4 = 2026년 10~12월, 중기 = 2027년 상반기, 장기 = 2027년 하반기 이후.

---

## 상태 태그

| 태그 | 의미 |
|---|---|
| `[done]` | `main`에 머지되어 프로덕션에서 동작 중. |
| `[in progress]` | 이번 스프린트에 코드 작성 중. 일부 머지됨. |
| `[next]` | 표시된 분기에 착수 예정. 설계 확정, 코드 미작성. |
| `[exploring]` | 중요하다고 보지만 접근 방식이 아직 정해지지 않음. |
| `[not planned]` | 의도적으로 범위 밖. 만들지 않을 예정. |

라운드 표기(`Round 7`, `Round 6.5` 등)는 같은 이름의
`docs/CODEX_TASKS_*.md`, `docs/CODEX_HANDOFF_*.md` 문서를 가리킨다.
해당 스프린트 산출물의 정식 사양 문서다.

---

## 현재 위치 (2026-Q2 종료 시점)

- v0.3 FateCore 모델이 프로덕션에서 동작 중. v0.4-timeline은 평가 완료,
  v0.5(Round 7 산출물)는 학습/평가 중.
- 규칙 기반 Q-rubric 스코어링은 작동 중. LLM Q-rubric(Gemini) 경로는
  코드 완성 상태지만 현재 **Vercel 측 `GEMINI_API_KEY` 하나 때문에
  막혀 있다.** ([SESSION_HANDOFF_2026-05-29.md](./SESSION_HANDOFF_2026-05-29.md) 참고)
- 459K 논문 EPMC fulltext ingest 약 59% 진행, 계속 돌고 있음.
- Q500 / 50-paper / 1K-paper 평가 하니스가 모두 갖춰져 있고 on-demand로
  실행 가능.
- 테마 스위처, RSS changelog 피드, CSV 기록 export, audit-log read
  엔드포인트, pre-push gate, Codex digest는 모두 배포됨.

여기까지가 아래 로드맵의 출발선이다.

---

## 2026 Q3 — 프로덕션 LLM 해제 + v0.5 배포

목표: 이미 끝낸 코퍼스/모델 작업을 사용자가 체감할 수 있는 품질 향상으로
연결시킨다.

- **프로덕션 LLM Q-rubric 스코어링 본격 가동.** `[in progress]`
  구현은 끝났다 (`api/forecast.js`, `src/server/geminiClient.js`,
  paid-tier opts 배선 완료). 블로커는 Vercel 환경 변수 키 한 개 교체 —
  SESSION_HANDOFF_2026-05-29 §2 참조. 해제되는 즉시
  `scripts/smoke-production.mjs`가 회귀 게이트 역할을 한다.
- **v0.5 FateCore 모델 배포.** `[in progress]`
  Round 7(`CODEX_TASKS_2026-05-28_ROUND7.md`)이 v0.5 feature set과
  재학습 weight를 생산 중. 배포 조건: random split held-out에서 v0.5가
  v0.4-timeline을 R² / log-JIF MAE 모두에서 — `EVAL_v0.5.md`에 기록된
  seed-to-seed 노이즈 범위 이상으로 — 이겨야 한다. "좋아 보이는" 모델은
  배포하지 않는다.
- **50편 회귀 baseline.** `[next]`
  ground-truth 결과(타깃 저널, 실제 JIF, 가능하면 수락까지 걸린 시간)가
  알려진 고정 50편 세트를 매 배포의 회귀 스위트로 삼는다. 목적은 평균
  지표가 가리는 행동 drift를 잡는 것 — 예: 한 tier가 통째로 무너지는
  경우.
- **Q500 LLM 재스코어링 대규모 실행.** `[in progress]`
  Round 7 Task 1 (`_q500_fulltext_round7.jsonl`)이 dry-run 단계. Vercel
  key 교체 후 paid live run 실행. quality gate:
  Δ q_mean (top - mid) ≥ 0.7 미달 시 50K batch GO 없음.

---

## 2026 Q4 — 저자 네트워크 + 코퍼스 확장 + 실시간 UI

목표: FateCore를 manuscript 내부 신호 너머로 확장하고, 사용자가 스피너만
보는 대신 forecast 진행 과정을 실시간으로 볼 수 있게 한다.

- **저자 네트워크 feature를 v0.5+에 통합.** `[next]`
  공저 그래프, 경력 단계 proxy, 저자별 과거 게재지 분포를 FateCore의
  1급 입력으로 승격. 솔직한 제약: early-career 저자에서는 이 feature가
  매우 노이즈가 크고, 첫 투고자의 점수를 좌우하게 두지 않을 것.
  산출물은 author-network feature를 ablation arm으로 가진 v0.5.x 또는
  v0.6 모델, 동일한 50편 baseline에서 평가.
- **Bibliography pre-pub signal 확장.** `[next]`
  `paper_extras_v2`를 더 넓은 코퍼스로 확장 (목표: seed가 아니라 ingest
  완료된 전체 EPMC fulltext). pre-pub feature들(citation-position
  salience, reference recency profile, methods-section vocabulary)이
  모델에서 비중을 가지려면 더 넓은 fit set이 필요하다. 이미 잡혀서
  `V0.3_LEAKAGE_POSTMORTEM.md`에 기록된 v0.3-style post-pub leakage를
  반복하지 않기 위함.
- **실시간 SSE 업데이트 UI.** `[next]`
  현재 forecast 파이프라인은 request/response 일회성 — 사용자는 10~60초
  아무것도 보지 못하다가 전체 결과를 받는다. 각 단계(extract → rule
  score → LLM score → model → journey)가 끝날 때마다 UI가 갱신되는
  server-sent-events 스트림으로 전환. 구체적으로 새 `/api/forecast-stream`
  엔드포인트 + 스트리밍 ForecastPanel 컴포넌트. pre-push gate가 동기
  엔드포인트의 회귀를 막아 주는 동안 진행.

---

## 중기 (2027년 상반기) — 일회성 도구에서 워크스페이스로

목표: 재방문 사용자에게 다시 올 이유를 만들되, 우리가 유지보수할 수 없는
원고 관리 플랫폼으로는 변하지 않는다.

- **멀티 유저 계정.** `[exploring]`
  지금은 사용자 입장에서 stateless — 기록은 브라우저에만 살아 있다
  (이번 스프린트의 CSV export가 임시 우회책). 이메일 매직 링크 기반의
  가벼운 계정 정도면 기기·시간을 가로질러 forecast를 보관할 수 있다.
  미결 질문: 직접 호스팅 vs Supabase / Clerk 같은 서비스 사용. 코드 전에
  결정 필요.
- **저널 추천 고도화.** `[in progress]`
  현재 journey는 예측 JIF 기준 5단계 사다리. 다음 버전은 scope fit
  (해당 저널의 최근 코퍼스와의 주제 거리), 가능한 경우의 acceptance-rate
  prior, switch-cost(원고가 그 저널에 맞춰 얼마나 바뀌어야 하는지)를
  반영. switch-cost matrix는 열려 있는 Task #61 — synthetic placeholder가
  아니라 실제 cost 데이터를 기다리는 중.
- **OpenReview 연동.** `[exploring]`
  OpenReview는 일부 venue의 peer review를 공개한다. 이를 수집하면
  FateCore가 단순 acceptance가 아니라 *review 결과* 자체로부터 배울 수
  있다 — 다만 coverage가 고르지 않고 ML venue에 편향. sanity check
  용으로는 유용, 모델을 여기에 걸진 않는다.
- **원고 변경 이력 추적.** `[exploring]`
  같은 원고의 연속된 draft를 저장하고 forecast가 어떻게 움직였는지
  보여 준다. 더 어려운 설계 질문은 "같은 원고"의 정의 — 제목 해시는
  너무 약하고, 본문 해시는 너무 엄격하다. 사용자가 확정하는 thread ID가
  현실적인 답으로 보인다.

---

## 장기 (2027년 하반기 이후) — 의사결정 *지원*, 대체 아님

목표: 저자가 실제로 가장 고민하는 영역 — *리뷰어가 좋아할까*, *어느
저널이 맞을까*, *지금 내도 될까* — 까지 forecast를 확장하되,
"지원(support)" 선을 분명히 지킨다.

- **Peer review 예측.** `[exploring]`
  특정 venue에서 major revision / reject가 일어날 확률과 심각도를
  원고를 조건으로 추정. OpenReview 코퍼스 + 합법적으로 확보 가능한
  retrospective venue-decision 데이터로 학습. 출력은 확률과 confidence
  band — 절대로 "거부됨" 같은 binary 판정이 아니다.
- **Reviewer-style critique를 곁들인 journal-fit 랭킹.** `[exploring]`
  journey 상위 후보 venue들에 대해, 해당 venue의 methods 중심 리뷰어
  말투로 짧고 솔직한 비평을 생성. critique는 막연한 우려가 아니라
  rubric domain(통계, novelty, reporting)을 인용해야 한다.
- **출판 의사결정 지원 도구.** `[exploring]`
  위 항목들을 forecast + journey + critique + 변경 이력 추세로 묶은
  단일 의사결정 뷰. 명시적으로 저자와 공저자를 위한 *지원* —
  green-light / red-light 게이트가 아니다. 투고 결정은 사람의 몫.

---

## 계획 없음 (Not planned)

다음 항목들은 인접 영역이라 "왜 안 하느냐"는 질문이 자주 나오므로,
하지 않을 것임을 명시적으로 기록한다.

- **자동 투고.** `[not planned]`
  PaperFate는 사용자를 대신해 저널 포털의 "submit" 버튼을 누르지
  않는다. 투고 단계는 저자성, conflict of interest, data-availability
  같은 선언을 본인이 직접 하는 자리다. forecasting 도구가 proxy로
  대신 해서는 안 되는 종류의 행위다.
- **Ghostwriting.** `[not planned]`
  PaperFate는 원고 본문 작성, 문단 다시 쓰기, abstract "개선"을 하지
  않는다. 이 제품의 핵심은 forecast가 저자가 실제로 쓴 글을 반영한다는
  것이다. ghostwriting 기능을 붙이면 점수는 조용히 *Gemini가 쓴 글*에
  대한 forecast로 바뀐다. 영구적으로 범위 밖.
- **풀 리뷰 평가.** `[not planned]`
  완성된 peer review를 채점해서 에디터에게 수용 여부를 권하는 일은
  하지 않는다. peer-review 평가는 stakeholder(에디터)와 윤리적 표면이
  다른 별개의 제품이다. 언젠가 review-side 도구를 만든다면 PaperFate의
  feature가 아니라 별도 제품이 될 것이다.

---

## 이 로드맵의 솔직한 단서

- 분기 경계선은 희망 사항이다. Q3는 사용자 측 Vercel 액션 한 건에
  걸려 있고, 그게 늦어지면 Q3 모든 항목이 함께 늦어진다.
- v0.5의 프로덕션 배포 기준은 단 하나: random-split validation에서
  v0.4-timeline을 이긴다. 못 이기면 배포하지 않는다 — validation 전략을
  바꿔서 모델을 "더 잘 보이게" 만들지 않는 이유는
  `feedback_fatecore_validation`에 기록되어 있다.
- `[exploring]` 항목은 진지하게 들여다본 뒤 `[not planned]`로 옮겨질
  수 있다. 그게 그 태그의 용도다.
