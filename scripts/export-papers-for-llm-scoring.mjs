#!/usr/bin/env node
// PaperFate · LLM scoring 입력 export
//
// 사용 시나리오:
//   1. Random sample N paper 추출 (학습 baseline용)
//   2. Q500 items 중 LLM mode만 추출 (특정 domain 필터 가능)
//   3. LLM에 보낼 prompt 생성 (Claude / 코덱스 / Gemini 공통 포맷)
//   4. 결과 JSON으로 출력
//
// 사용:
//   node scripts/export-papers-for-llm-scoring.mjs --n 50 --mode Q100 --out batch1.json
//   node scripts/export-papers-for-llm-scoring.mjs --n 100 --domain DESIGN --out design-batch.json
//   node scripts/export-papers-for-llm-scoring.mjs --n 20 --skip-scored --out unscored.json
//
// 출력 batch1.json 구조:
//   {
//     "instruction": "...prompt for LLM...",
//     "rubric_items": [{id, name, q, rubric, evidence, types}],
//     "papers": [{doi, pmid, title, abstract, publication_types, mesh_terms}]
//   }
//
// 이 JSON을 Claude/코덱스에 paste → JSON 응답 받아서 ingest-llm-scores.mjs로 DB 저장.

import Database from 'better-sqlite3'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = process.env.DATA_ROOT || join(ROOT, 'data')
const DB_PATH = join(DATA_ROOT, 'paperfate.db')
const RUBRIC_PATH = join(ROOT, 'docs/rubric/Q500.json')

const ARGS = process.argv.slice(2)
function arg(name, def) {
  const a = ARGS.find(x => x.startsWith(`--${name}=`))
  if (a) return a.split('=')[1]
  const i = ARGS.indexOf(`--${name}`)
  if (i >= 0 && ARGS[i+1] && !ARGS[i+1].startsWith('--')) return ARGS[i+1]
  return def
}

const N = parseInt(arg('n', '50'))
const MODE = arg('mode', 'Q100')  // Q100 (100 items) or Q500 (full 507)
const DOMAIN = arg('domain', null) // optional filter: QUEST, NOVEL, DESIGN, ...
const OUT = arg('out', `data/llm-batch-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`)
const SKIP_SCORED = ARGS.includes('--skip-scored')
const SMART = ARGS.includes('--smart')         // infer article type → only applicable items per paper
const TYPE_FILTER = arg('type', null)           // group by article type (RCT, clinical_cohort, ...)

const db = new Database(DB_PATH, { readonly: true })
const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'))
const allItems = Array.isArray(rubric.items) ? rubric.items : Object.values(rubric)

// Filter items
let items = allItems
if (MODE === 'Q100') items = items.filter(i => i.Q100)
if (DOMAIN) items = items.filter(i => i.id.startsWith(DOMAIN + '_'))
// Only items needing LLM (skip rule-only items already in paper_scores)
items = items.filter(i => i.mode === 'llm' || i.mode === 'hybrid')

console.log(`Mode: ${MODE}  Domain filter: ${DOMAIN || 'all'}  Smart: ${SMART}`)
console.log(`LLM-mode items: ${items.length}`)

// Article type inference (matches Q500 schema types)
function inferArticleType(paper) {
  const types = paper.publication_types_json ? JSON.parse(paper.publication_types_json) : []
  if (types.some(t => /Randomized Controlled Trial/i.test(t))) return 'RCT'
  if (types.some(t => /Meta-?Analysis/i.test(t))) return 'meta_analysis'
  if (types.some(t => /Systematic Review/i.test(t))) return 'systematic_review'
  if (types.some(t => /Case Reports?/i.test(t))) return 'case_report'
  const a = (paper.abstract || '').toLowerCase()
  if (/cohort|prospective.*follow|follow.?up of/i.test(a)) return 'clinical_cohort'
  if (/case.?control/i.test(a)) return 'case_control'
  if (/diagnostic accuracy|sensitivity.+?specificity/i.test(a)) return 'diagnostic_accuracy'
  if (/(prediction|risk).{0,10}(model|score)|AUROC|c-index/i.test(a)) return 'prediction_model'
  if (/deep learning|convolutional|neural network/i.test(a) && /imag|radiograph|MRI|CT/i.test(a)) return 'ai_imaging'
  if (/in vitro|murine|mice|macaque|knockout|transgenic|cell line/i.test(a)) return 'basic_translational'
  if (/technical note|surgical technique|preferred method/i.test(a)) return 'technical_note'
  return 'clinical_cohort' // fallback
}

function itemAppliesToType(item, articleType) {
  if (!item.types || item.types === '*') return true
  const typesList = String(item.types).split(',').map(s => s.trim())
  return typesList.includes(articleType)
}

// Sample papers
let papers
if (SKIP_SCORED) {
  papers = db.prepare(`
    SELECT p.doi, p.pmid, p.title, p.abstract, p.publication_types_json, p.mesh_terms_json,
           p.year, p.journal
    FROM papers p
    WHERE p.abstract IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM paper_scores s
        WHERE s.doi = p.doi AND s.mode = 'llm'
      )
    ORDER BY RANDOM()
    LIMIT ?
  `).all(N)
} else {
  papers = db.prepare(`
    SELECT doi, pmid, title, abstract, publication_types_json, mesh_terms_json,
           year, journal
    FROM papers
    WHERE abstract IS NOT NULL
    ORDER BY RANDOM()
    LIMIT ?
  `).all(N)
}

console.log(`Sampled papers: ${papers.length}`)

const smartHint = SMART
  ? `\n## SMART MODE (적용됨)\n각 paper는 article_type이 추론되어 있고, 이 type에 applicable한 items만 paper.applicable_items에 있습니다. ${items.length}개 전체 rubric_items 대신 applicable_items에 있는 것만 채점하면 됩니다. 나머지는 ingest 시 자동 NA 처리.\n`
  : ''

const instruction = `당신은 PaperFate의 Q500 채점자입니다. ${SMART ? '각 paper의 applicable_items에 대해' : `아래 ${items.length}개 평가 항목에 대해 각 논문을`} 채점합니다.
${smartHint}
## 채점 룰
- 각 항목의 \`rubric\` 배열은 6단계 anchor (0~5). 0이 최악, 5가 최선.
- abstract에 명시적 증거가 있으면 해당 anchor에 따라 점수.
- 증거 없으면 \`unknown\` 표시 (점수 null).
- ${SMART ? 'applicable_items에 있는 것만 보내면 됨 — 응답에 빠진 항목은 자동 NA 처리.' : '항목별 `types`가 "*"가 아니면 해당 article type일 때만 채점. 부합 안 하면 `na=true`.'}
- \`evidence\`는 abstract에서 인용한 verbatim 텍스트 **≤30자** (짧을수록 좋음).

## 출력 형식 (반드시 valid JSON)
\`\`\`json
{
  "scores": [
    {
      "doi": "10.xxxx/xxxx",
      "items": [
        {"id": "QUEST_001", "s": 4, "e": "explicit hypothesis"},
        {"id": "STATS_005", "u": true},
        ...
      ]
    },
    ...
  ]
}
\`\`\`

**컴팩트 형식 사용**: \`s\` (score), \`e\` (evidence, optional ≤30자), \`u\` (unknown), \`n\` (na, default-NA 모드면 생략).
응답은 \`\`\`json ... \`\`\` 코드 블록 안에만.`

const papersOut = papers.map(p => {
  const articleType = inferArticleType(p)
  const base = {
    doi: p.doi,
    pmid: p.pmid,
    year: p.year,
    journal: p.journal,
    title: p.title,
    abstract: p.abstract,
    publication_types: p.publication_types_json ? JSON.parse(p.publication_types_json) : [],
    mesh_terms: p.mesh_terms_json ? JSON.parse(p.mesh_terms_json).slice(0, 6) : [],
  }
  if (SMART) {
    base.article_type = articleType
    base.applicable_items = items.filter(i => itemAppliesToType(i, articleType)).map(i => i.id)
  }
  return base
})

const out = {
  generated_at: new Date().toISOString(),
  mode: MODE,
  smart: SMART,
  default_na: SMART,
  domain_filter: DOMAIN,
  n_papers: papers.length,
  n_items: items.length,
  instruction,
  rubric_items: items.map(i => ({
    id: i.id,
    name: i.name,
    q: i.q,
    rubric: i.rubric,
    types: i.types,
    evidence: i.evidence,
    guideline: i.guideline,
  })),
  papers: papersOut,
}

// Reporting on applicable item reduction
if (SMART) {
  const totalApplicable = papersOut.reduce((s, p) => s + p.applicable_items.length, 0)
  const totalIfNoSmart = papersOut.length * items.length
  console.log(`Applicable items: ${totalApplicable} / ${totalIfNoSmart} (reduction ${(100*(1-totalApplicable/totalIfNoSmart)).toFixed(0)}%)`)
}

const outPath = OUT.startsWith('/') || OUT.match(/^[A-Z]:/) ? OUT : join(ROOT, OUT)
writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log(`\n✓ Wrote: ${outPath}`)
console.log(`  Size:  ${(JSON.stringify(out).length / 1024).toFixed(1)} KB`)
console.log(`  → LLM (Claude/코덱스/Gemini)에 instruction + rubric_items + papers paste`)
console.log(`  → 응답 JSON 받아서 scripts/ingest-llm-scores.mjs --in <response.json>`)

db.close()
