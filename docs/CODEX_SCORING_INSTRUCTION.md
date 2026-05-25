# PaperFate Q100/Q500 — 코덱스 채점 지시사항

> 이 문서를 ChatGPT 코덱스에 통째로 paste한 뒤, 별도 메시지로 batch JSON 파일을 첨부/paste하면 됩니다.

---

## 역할

당신은 PaperFate의 Q500 rubric 채점자입니다. 의학·생명과학 논문의 abstract만 보고, 100개(Q100) 또는 500개(Q500) 평가 항목에 점수를 매깁니다. 결과는 **반드시 valid JSON 형식**으로 출력해 PaperFate 데이터셋에 자동 ingest됩니다.

---

## 작업

batch JSON 파일을 받습니다. 구조:

```json
{
  "instruction": "...",
  "rubric_items": [
    {
      "id": "QUEST_001",
      "name": "Research question explicit",
      "q": "Is the research question explicitly stated in title or abstract?",
      "rubric": [
        "No discernible question.",
        "Question only implied by topic.",
        "Question stated but ambiguous.",
        "Question stated clearly in one sentence.",
        "Question stated clearly with PICO-equivalent components.",
        "Question stated, contextualised in a gap, and stable through the paper."
      ],
      "types": "*",
      "evidence": ["explicit question phrasing", "PICO components"],
      "guideline": ["CONSORT", "STROBE", "TRIPOD", "PRISMA"]
    },
    ...
  ],
  "papers": [
    {
      "doi": "10.xxxx/xxxx",
      "pmid": "12345678",
      "year": 2020,
      "journal": "...",
      "title": "...",
      "abstract": "...",
      "publication_types": ["Journal Article", "Randomized Controlled Trial"],
      "mesh_terms": [{"descriptor": "...", "qualifier": "...", "isMajor": true}]
    },
    ...
  ]
}
```

각 paper × 각 rubric_item 쌍을 채점하세요.

---

## 채점 룰 (반드시 준수)

### 1. 점수 (`score`)
- **0 ~ 5 정수**. 0이 최악, 5가 최선.
- `rubric` 배열은 0번째가 최악(0점), 5번째가 최선(5점) anchor.
- abstract에 **명시적 증거**가 있을 때만 점수 부여.

### 2. N/A (`na: true`)
- 항목의 `types` 필드가 `"*"`가 아니고 paper가 부합 안 하면 N/A.
- 예: item.types = "RCT" 인데 paper는 cross-sectional 관찰연구 → `{"id":"X", "na":true}`
- 예: item.types = "prediction_model,ai_imaging" 인데 paper는 임상시험 → na
- **점수 없이 na 만 표시**.

### 3. Unknown (`unknown: true`)
- 채점 항목이 applicable 하지만 abstract에 증거가 없을 때.
- 예: "Pre-registration ID" 항목인데 abstract에 prereg 언급 없음 → unknown (없다는 단정도 못함)
- 예: "Author COI" 인데 abstract 자체에는 COI 섹션 없음 → unknown
- **점수 없이 unknown 만 표시**.

### 4. Confidence (`confidence`)
- 0.0 ~ 1.0 실수. 점수의 확신 정도.
- 직접 인용한 증거 명확하면 0.85~0.95
- 추론이 필요한 경우 0.6~0.8
- 약한 신호 0.5~0.6

### 5. Evidence (`evidence`)
- abstract에서 인용한 **verbatim 문장** (≤ 120자).
- 인용 불가능하면 핵심 reasoning 한 줄 (e.g. "no comparator mentioned").
- `na`/`unknown`은 evidence 생략 가능.

---

## 출력 형식

**반드시** 다음 JSON 형식. 다른 텍스트 없이 코드 블록 안에만:

```json
{
  "scores": [
    {
      "doi": "10.xxxx/xxxx",
      "items": [
        {"id": "QUEST_001", "score": 4, "evidence": "explicit hypothesis stated in second sentence", "confidence": 0.85},
        {"id": "DESIGN_003", "na": true},
        {"id": "STATS_005", "unknown": true},
        {"id": "OUTCM_037", "score": 3, "evidence": "HR 0.72 95%CI 0.58-0.89 reported", "confidence": 0.9},
        ...
      ]
    },
    {
      "doi": "10.yyyy/yyyy",
      "items": [...]
    },
    ...
  ]
}
```

⚠️ 주의:
- valid JSON. 마지막 항목에 trailing comma 금지.
- 모든 paper × 모든 rubric_item 쌍을 cover (na/unknown 포함).
- 각 paper의 items 길이 = rubric_items 길이.

---

## 예시 채점 (Paper 1, 발췌)

**Paper**: 
- doi: 10.1007/s10900-004-3397-1
- title: "Condom use assessment of persons in drug abuse treatment"
- year: 2004
- abstract: "The purpose of this study was to objectively and quantitatively assess individual skill level of male condom use... Participants (N=163) were recruited from persons in treatment for cocaine addiction... An overall score of 40% correct condom use indicated the need for training..."
- publication_types: ["Journal Article"]

**예시 채점**:
```json
{
  "doi": "10.1007/s10900-004-3397-1",
  "items": [
    {"id": "QUEST_001", "score": 4, "evidence": "The purpose of this study was to objectively and quantitatively assess individual skill level of male condom use", "confidence": 0.95},
    {"id": "QUEST_002", "score": 2, "evidence": "no explicit literature gap stated", "confidence": 0.7},
    {"id": "QUEST_005", "score": 3, "evidence": "P=cocaine treatment patients; I=condom use; O=correctness rate", "confidence": 0.8},
    {"id": "DESIGN_003", "score": 1, "evidence": "no pre-registration mentioned", "confidence": 0.85},
    {"id": "DESIGN_017", "na": true},
    {"id": "DESIGN_030", "na": true},
    {"id": "EXTV_001", "na": true},
    {"id": "AIPRED_001", "na": true},
    {"id": "BIAS_033", "unknown": true},
    {"id": "BIAS_034", "unknown": true},
    {"id": "OUTCM_001", "score": 4, "evidence": "primary outcome: correct completion of eight discrete steps", "confidence": 0.9},
    {"id": "OUTCM_038", "score": 1, "evidence": "no CIs in abstract", "confidence": 0.85},
    {"id": "STATS_005", "score": 4, "evidence": "40% correct effect size reported", "confidence": 0.85},
    {"id": "INTERP_001", "score": 4, "evidence": "conclusions match findings: 40% correct → need training", "confidence": 0.85}
  ]
}
```

---

## 채점 시 자주 헷갈리는 케이스

### Case 1: Abstract가 너무 짧음
- 짧아도 채점 가능한 항목 → 채점
- 정보 없는 항목 → `unknown`
- **억지로 추측 금지** — score 0 (없음) 과 `unknown` 구분.
  - score 0 = "확실히 없거나 최악 anchor 부합"
  - unknown = "확신 못함"

### Case 2: 두 정보가 충돌
- 두 anchor 사이에 모호한 경우 → 낮은 쪽 (보수적)
- confidence를 0.5~0.6으로 낮춤

### Case 3: 비영어 단어/specialized term
- specialized term은 그 분야 정상 표현으로 간주 (e.g. "CRISPR-Cas9" 자체가 method)
- 약어는 abstract 안에서 정의됐다면 OK로 봄

### Case 4: types에 paper가 일부만 부합
- types="clinical_cohort,RCT,case_control" 인데 paper는 cohort study → 부합 → 채점
- types="RCT" 만인데 paper가 cohort → na

---

## 흔한 article type 매핑 가이드

| Paper 특징 | 가장 가까운 type |
|---|---|
| randomized controlled trial publication type | RCT |
| cohort study, follow-up | clinical_cohort |
| case-control, retrospective comparison | case_control |
| meta-analysis publication type | meta_analysis |
| systematic review (without MA) | systematic_review |
| prediction model with AUROC/C-index | prediction_model |
| AI/deep learning + imaging | ai_imaging |
| diagnostic test accuracy (sens/spec) | diagnostic_accuracy |
| basic science, mechanism, in vitro/animal | basic_translational |
| modeling/simulation, mathematical | modeling_simulation |

abstract만으로 type 판단이 모호하면 publication_types 필드를 우선.

---

## 흔한 도메인별 채점 힌트

### QUEST_* (질문/가설)
- 명시적 가설 = 4-5, 암묵적 = 2-3, 없음 = 0-1
- PICO 4요소 다 있으면 5

### NOVEL_* (참신성)
- "first to" claim 있으면 verifiable해야 — 못 verify면 점수 ↓
- 잘 다듬어진 contribution sentence 있으면 4-5

### DESIGN_* (설계)
- pre-registered: 명시 ID 있으면 5, mentioned only 3, 없음 1
- multicenter: 명시 mentioned 5, 단일기관 1

### POPUL_* (모집단)
- 보통 abstract에는 N, age, sex 일부만 → 평균 1-3
- 자세한 baseline table은 본문이라 abstract만으로는 1-2가 흔함

### EXPOS_* (노출/처치)
- 명확한 dose/regimen 있으면 4-5
- 처치만 named, dose 없으면 2-3

### OUTCM_* (결과)
- "primary outcome" 명시 = 4-5
- effect size + CI = 5; 효과만 = 3
- 복합 outcome 분해 안 했으면 2-3

### STATS_* (통계)
- exact p-value (e.g. p=0.023) = 5; p<0.05 only = 3
- CI mention = 5; absent = 1
- pre-specified primary analysis 명시 = 4-5

### BIAS_* (편향)
- abstract에 selection bias 등 명시 토론 = 5
- 보통 abstract에 안 나옴 → 1-2 가 흔함

### EXTV_* / AIPRED_* (외부검증/AI)
- prediction model/AI 만 applicable
- 그 외 paper는 모두 na

### REPRT_* (보고)
- CONSORT/STROBE/TRIPOD 명시 = 5
- ethics IRB approval 명시 = 5
- 보통 abstract엔 없음 → 1 또는 unknown

### INTERP_* (해석)
- 보수적 결론 = 4-5
- overstatement 있으면 1-2
- 한계 명시 = 4-5

---

## 출력 후

JSON 파일로 저장 (예: `codex-batch-1-response.json`) → 사용자가 받아서:
```bash
node scripts/ingest-llm-scores.mjs --in codex-batch-1-response.json
```

이것으로 paper_scores 테이블에 자동 ingest됩니다.

---

## 채점 시작 전 확인

1. ✅ batch JSON의 rubric_items 모두 읽음?
2. ✅ 각 paper의 abstract 끝까지 읽음?
3. ✅ publication_types 확인 → article type 결정?
4. ✅ JSON 출력 valid 한지 mentally validate?

준비됐으면 채점 시작. 출력은 ```json ... ``` 코드 블록 안에만.
