# PaperFate Quality Rubric — Q500 v0.2

Q500 is PaperFate's manuscript-evaluation rubric bank: **507 scoring items** spanning 14 domains. Each item is a single 0–5 question with anchored rubric, evidence cues, applicable article types, input level, scoring mode, and (where applicable) reporting-guideline tag and weight.

**v0.2 incorporates the production-readiness changes:** all 507 items now have rubrics + evidence cues, with `mode: external`, `guideline` tags, canonical/subtype relations, and 7 new items added (5 causal inference + 2 AI prediction).

## Architecture (where Q500 runs)

```
Local (developer)                          Server (Vercel + Supabase)
─────────────────                          ──────────────────────────
• Score corpus with Q500     ───shared──▶  • Run Q500 extraction on user manuscript
  (Claude API, batched)         (Git)        (Anthropic API call)
• Train FateCore on the                    • Run FateCore inference
  scored QualityVectors                    • Serve similar-papers (pgvector)
• Push FateCore weights                    • Return forecast JSON
  & calibration to repo

                              Frontend (paperfate.com)
                              ──────────────────────────
                              • File / text upload
                              • Progress streaming
                              • Result visualization only
                              • Zero ML / LLM logic
```

## Q100 vs Q500

| | Q100 | Q500 |
|---|---|---|
| Used when | User pastes **abstract only** | User pastes **full manuscript** or OA full text fetched |
| Items | 100 | 507 |
| Input level | mostly 1 (abstract) | 1–4 (all) |
| Rubric format | **Full 6-level anchors** (item-specific) | All have rubric — Q100 uses full 6-anchor, others use compact 4-anchor anchored to scores 0/2/4/5 |
| LLM cost / paper | ~$0.003 (Haiku) | ~$0.020–0.035 |

Q100 ⊂ Q500. Same IDs. Flag `Q100: true`.

## Files

```
docs/rubric/
├── README.md      ← this file
├── schema.json    ← formal schema, scoring rules, default rubric, guideline vocab
└── Q500.json      ← 507 items, single array, grouped by domain
```

## Scoring scale (0–5 + NA + UNK)

| Score | Meaning |
|---|---|
| 0 | Absent or clearly poor |
| 1 | Very weak |
| 2 | Weak |
| 3 | Acceptable / standard |
| 4 | Strong |
| 5 | Excellent / exemplary |
| **NA** | Not applicable to this article type (e.g., allocation concealment for meta-analysis) |
| **UNK** | Cannot determine from available text (e.g., asking about figures from abstract only) |

**Critical: NA and UNK must be tracked separately** — a non-RCT shouldn't be penalized for lacking blinding. That's NA, not 0. Conflating them poisons FateCore training.

## Item record schema

Every item has at minimum: `id`, `name`, `q`, `rubric`, `types`, `lvl`, `mode`, `evidence`.

```json
{
  "id": "STATS_015",
  "name": "Missing data quantified",
  "q": "Is missing data quantified per variable?",
  "rubric": [
    "Not addressed.",
    "Mentioned without quantification.",
    "Quantified overall.",
    "Quantified per variable.",
    "Quantified per variable + mechanism (MCAR/MAR/MNAR) discussed.",
    "Quantified + mechanism + multiple imputation + sensitivity."
  ],
  "types": "*",
  "lvl": 1,
  "mode": "llm",
  "evidence": ["missing percent", "missing per variable"],
  "Q100": true
}
```

Optional: `NA`, `Q100`, `guideline`, `weight`, `relation`, `notes`.

## Scoring modes (v0.2)

| mode | When | Cost / item |
|---|---|---|
| `rule` | Deterministic regex/parser — n=, AUROC, exact p, ICD codes, NCT IDs | ~$0 |
| `llm` | Subjective rubric application — novelty, balance, honesty | ~$0.0002 |
| `hybrid` | Rule finds candidate evidence, LLM scores via rubric | ~$0.0001 |
| `external` | Requires external DB (PubMed, guideline directory) lookup | ~$0.0005 |

Current distribution: 463 llm · 40 hybrid · 4 external (+ all rule-eligible items can be downgraded to hybrid as the rule layer is built out).

## Reporting guideline tags

Items map to reporting guidelines where applicable. 58 items currently tagged. Full list in `schema.json` → `reporting_guidelines`.

| Tag | Use |
|---|---|
| CONSORT, CONSORT-AI | RCTs |
| SPIRIT | Trial protocols |
| STROBE | Observational |
| STARD | Diagnostic accuracy |
| TRIPOD, TRIPOD-AI | Prediction models |
| PROBAST | Risk of bias in prediction models |
| PRISMA | Systematic reviews / meta-analyses |
| ROBINS-I | Non-RCT interventions |
| AMSTAR-2 | SR quality |
| ARRIVE | Animal research |
| CHEERS | Economic evaluations |
| CLAIM, MI-CLAIM | AI imaging / clinical AI |
| SAGER | Sex & gender reporting |
| RECORD | Routinely-collected data |
| ICMJE | Authorship / COI |

## Canonical vs subtype (dedup handling)

13 items carry a `relation` field that hierarchically resolves overlapping concepts:

| Canonical (full weight) | Subtype (down-weighted in aggregation) |
|---|---|
| BIAS_001 selection bias | POPUL_018 selection bias (sampling-phase) |
| BIAS_024 survivor bias | POPUL_021 survivor bias (population-side) |
| BIAS_014 time-varying confounding | STATS_030 time-varying confounding (stats-side) |
| AIPRED_004 cross-validation | STATS_037 cross-validation (stats-side) |
| AIPRED_016 calibration metric | OUTCM_040 calibration (model-outcome) |
| EXTV_001 external validation | AIPRED_026 external validation (AI subtype) |
| RELEV_018 translation timeline | INTERP_024 translation timeline (interp-side) |

Aggregation rule: when a canonical+subtype pair both apply to a paper, downstream rollup uses the canonical and treats the subtype as evidence corroboration (½ weight by default).

## Input levels

| lvl | Source needed |
|---|---|
| 1 | Title + abstract |
| 2 | Methods or Results section |
| 3 | Discussion / full main text / limitations |
| 4 | Tables, figures, supplement, external resources |

## Domain index (507 items)

| Code | Domain | Items | Q100 |
|------|--------|-------|------|
| QUEST  | Research question & hypothesis        | 30  | 8  |
| NOVEL  | Novelty & originality                 | 30  | 6  |
| RELEV  | Clinical / scientific relevance       | 35  | 6  |
| DESIGN | Study design                          | 45  | 10 |
| POPUL  | Population & sampling                 | 40  | 8  |
| EXPOS  | Exposure / intervention / predictor   | 30  | 5  |
| OUTCM  | Outcomes / endpoints                  | 40  | 9  |
| STATS  | Statistical rigor                     | 55  | 9  |
| BIAS   | Bias & internal validity (incl. 5 causal) | 45  | 6  |
| EXTV   | External validity                     | 30  | 7  |
| AIPRED | AI / prediction-model specific (incl. 2 new) | 42  | 8 |
| REPRT  | Reporting / transparency / reproducibility | 40 | 8 |
| INTERP | Interpretation / discussion / conclusion | 30 | 7 |
| FIGS   | Figures & visual communication        | 15  | 3  |
| **Total** | | **507** | **100** |

## Article-type normalization

FateCore scoring **does not compare retrospective cohorts against RCTs on absolute Q500 sum**. Each article type has its own baseline (mean/SD per applicable item set), and the final score is normalized within type. See `schema.json` → `article_type_normalization`.

This prevents the rubric's RCT-favoring items (pre-registration, blinding, allocation concealment) from unfairly penalizing observational designs.

## What changed since v0.1

1. **All 507 items now have rubric** (Q100 = full 6-anchor; rest = compact 4-anchor)
2. **All 507 items now have `evidence`** field — required keywords/phrases the extractor must locate
3. Added **`mode: external`** for items requiring lookup (guideline relevance, regulatory endpoint)
4. Added **`guideline`** field to 58 items mapping to reporting guidelines
5. Added **7 new items**:
   - BIAS_041 target trial emulation clarity
   - BIAS_042 time zero clearly defined
   - BIAS_043 eligibility at time zero
   - BIAS_044 treatment assignment window
   - BIAS_045 prevalent user bias avoided
   - AIPRED_041 data leakage explicit check
   - AIPRED_042 calibration-in-the-large
6. **13 items now carry `relation`** (7 subtype-canonical pairs + 6 canonical anchors)
7. Schema adds `weights` (domain defaults), `article_type_normalization`, `extraction_output_schema`, `extraction_prompt_outline`

## Roadmap

1. **v0.2 (now)**: schema + items production-ready
2. **v0.3**: Server-side extraction prompt template + rule-layer for the 40 hybrid items (regex extractors for n=, AUROC, NCT IDs, etc.)
3. **v0.4**: 200-paper human calibration set → measure inter-rater κ per item → prune low-κ items
4. **v0.5**: FateCore-v0.1 trained on full-corpus QualityVector-507
