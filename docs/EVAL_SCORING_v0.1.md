# Scoring Agreement Evaluation v0.1

Generated: 2026-05-21T11:18:13.435Z
DB: E:\paperfate\data\paperfate.db
Base mode: `codex_deterministic`

## Summary

| Mode | Rows | Papers | Items | Numeric | NA | Unknown | Mean score | Mean confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex_deterministic | 81,990,200 | 819,902 | 100 | 43,654,659 | 26,636,153 | 11,699,388 | 2.324 | 0.745 |
| external | 2,016,018 | 866,274 | 9 | 2,016,018 | 0 | 0 | 1.128 | 0.948 |
| rule | 1,320,351 | 396,985 | 23 | 1,320,351 | 0 | 0 | 3.612 | 0.868 |
| llm | 7,200 | 72 | 100 | 3,215 | 2,355 | 1,630 | 2.432 | 0.753 |

## Codex Deterministic Distribution

| Raw value | Rows | Share |
| --- | --- | --- |
| 0 | 840,116 | 1.0% |
| 1 | 18,641,433 | 22.7% |
| 2 | 4,342,158 | 5.3% |
| 3 | 7,303,183 | 8.9% |
| 4 | 10,413,661 | 12.7% |
| 5 | 2,114,108 | 2.6% |
| na | 26,636,153 | 32.5% |
| unknown | 11,699,388 | 14.3% |

Numeric score rows: 43,654,659
Score 1 + 4 share: 66.6% (binary tendency check)
Score 0 + 5 share: 6.8% (edge-score usage check)

## Confidence

| Mode | Rows | Mean | Min | Max | <0.6 | >=0.8 |
| --- | --- | --- | --- | --- | --- | --- |
| codex_deterministic | 43,654,659 | 0.745 | 0.600 | 0.950 | 0 | 12,837,208 |
| external | 2,016,018 | 0.948 | 0.900 | 0.950 | 0 | 2,016,018 |
| rule | 1,320,351 | 0.868 | 0.700 | 0.980 | 0 | 1,056,652 |
| llm | 2,980 | 0.753 | 0.000 | 1.000 | 10 | 1,049 |

## Pairwise Agreement vs Codex

| Other mode | Overlap | Mean abs diff | Exact | Within 1 | Codex mean | Other mean |
| --- | --- | --- | --- | --- | --- | --- |
| rule | 857,903 | 1.144 | 308,577 (36.0%) | 528,180 (61.6%) | 3.645 | 4.136 |
| external | 820,297 | 2.676 | 25,649 (3.1%) | 359,864 (43.9%) | 2.826 | 0.213 |
| llm | 3,147 | 0.190 | 2,795 (88.8%) | 2,973 (94.5%) | 2.373 | 2.458 |

## Top Disagreements: Codex vs rule

| Item | Overlap | Mean abs diff | Codex mean | rule mean | Exact % |
| --- | --- | --- | --- | --- | --- |
| EXTV_008 | 11,276 | 1.635 | 4.826 | 3.323 | 28.7% |
| AIPRED_015 | 14,603 | 1.605 | 4.848 | 3.367 | 30.3% |
| OUTCM_037 | 200,339 | 1.559 | 3.441 | 5.000 | 29.9% |
| STATS_005 | 200,339 | 1.559 | 3.441 | 5.000 | 29.9% |
| DESIGN_005 | 234,364 | 1.170 | 2.899 | 2.020 | 3.6% |
| DESIGN_017 | 9,723 | 1.001 | 3.999 | 5.000 | 0.0% |
| BIAS_033 | 8,344 | 1.000 | 4.000 | 5.000 | 0.0% |
| DESIGN_011 | 22,804 | 0.727 | 4.273 | 5.000 | 81.8% |
| EXTV_001 | 5,086 | 0.244 | 4.756 | 5.000 | 93.9% |
| DESIGN_003 | 17,532 | 0.173 | 4.827 | 5.000 | 95.7% |
| REPRT_004 | 18,014 | 0.072 | 4.928 | 5.000 | 96.4% |
| OUTCM_038 | 108,466 | 0.005 | 4.995 | 5.000 | 99.9% |
| REPRT_001 | 5,840 | 0.000 | 5.000 | 5.000 | 100.0% |
| REPRT_015 | 1,170 | 0.000 | 5.000 | 5.000 | 100.0% |

## Top Disagreements: Codex vs external

| Item | Overlap | Mean abs diff | Codex mean | external mean | Exact % |
| --- | --- | --- | --- | --- | --- |
| DESIGN_001 | 819,830 | 2.676 | 2.825 | 0.212 | 3.1% |
| BIAS_033 | 467 | 2.516 | 4.000 | 2.473 | 0.0% |

## Top Disagreements: Codex vs llm

| Item | Overlap | Mean abs diff | Codex mean | llm mean | Exact % |
| --- | --- | --- | --- | --- | --- |
| NOVEL_002 | 65 | 0.462 | 1.246 | 1.708 | 81.5% |
| NOVEL_001 | 72 | 0.458 | 1.667 | 2.097 | 76.4% |
| QUEST_002 | 71 | 0.451 | 1.563 | 1.986 | 77.5% |
| EXPOS_001 | 68 | 0.426 | 2.941 | 3.221 | 80.9% |
| QUEST_005 | 33 | 0.424 | 3.212 | 3.576 | 75.8% |
| RELEV_005 | 31 | 0.419 | 2.097 | 2.452 | 77.4% |
| DESIGN_026 | 31 | 0.387 | 3.226 | 3.355 | 83.9% |
| NOVEL_018 | 31 | 0.387 | 2.290 | 2.613 | 80.6% |
| RELEV_001 | 33 | 0.364 | 1.909 | 2.152 | 78.8% |
| QUEST_003 | 42 | 0.357 | 3.048 | 3.262 | 81.0% |
| EXPOS_008 | 64 | 0.344 | 2.594 | 2.750 | 84.4% |
| OUTCM_001 | 67 | 0.328 | 2.448 | 2.776 | 76.1% |
| QUEST_001 | 72 | 0.319 | 2.833 | 3.097 | 79.2% |
| DESIGN_001 | 71 | 0.296 | 2.662 | 2.901 | 84.5% |
| QUEST_010 | 32 | 0.281 | 2.875 | 3.156 | 78.1% |

## FateCore v0.1 Metrics Snapshot

| Target | Train | Test | MAE | MAE cal | R2 | Q90 interval | Best iter |
| --- | --- | --- | --- | --- | --- | --- | --- |
| y_jcr_jif | 55,953 | 14,058 | 1.501 | 1.492 | 0.308 | 3.116 | 179 |
| y_icite_rcr | 88,143 | 22,012 | 2.023 | 1.979 | 0.312 | 3.223 | 140 |
| y_citations_log | 35,290 | 8,730 | 0.160 | 0.157 | 0.862 | 0.535 | 160 |

Features used: 116
Author features included: `first_author_h_index`, `last_author_h_index`, `max_team_h_index`, `median_team_h_index`, `team_size_with_id`, `international_collab`

## Interpretation

- `codex_deterministic` is the only complete Q100 coverage layer, so it should remain the production-safe baseline for FateCore v0.1.
- Rule/external/llm rows are useful audit overlays but have much lower coverage; compare them by item rather than by global row count.
- A high score 1+4 share is expected for regex-style deterministic scoring, but items with large pairwise disagreement should be prioritized for rule refinement or LLM adjudication.
