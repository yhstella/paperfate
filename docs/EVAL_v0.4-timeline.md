# FateCore v0.4 Timeline Evaluation

- Metrics: `C:\Users\R\paperfate\weights\fatecore-v0.4-timeline-metrics.json`
- Trained at: `2026-05-25T13:25:07.885511Z`
- Feature CSV: `E:\paperfate\data\features\v0.4-timeline-features.csv`
- Rows: `228,606`
- Split: `random`; train `146,307`, cal `36,577`, test `45,722`
- Features: `35`
- Forbidden post-publication features: `0`
- Decision: **DEPLOY CANDIDATE**

## Summary

| Metric | Value |
|---|---:|
| MAE days, calibrated | 59.4 |
| MAE days, raw | 59.4 |
| Median abs error days | 39.6 |
| R2 log | 0.1287 |
| R2 log, calibrated | 0.1274 |
| Conformal coverage | 0.902 |
| Median interval width days | 280.9 |

## Deploy Rule

- MAE days must be `<= 90`.
- R2 log must be `<= 0.60`; higher is suspicious for review-time prediction.
- Forbidden post-publication feature count must be `0`.
- Observed MAE days: `59.4`.
- Observed R2 log: `0.1287`.
- Forbidden features: `none`.
- Suspicious high-R2 flag: `no`.
- Decision: **DEPLOY CANDIDATE**.

## Target-Journal Tier Metrics

| Tier by prior-year JIF | n | MAE days | Median true days | Median pred days |
|---|---:|---:|---:|---:|
| JIF >=30 | 12 | 48.6 | 191.5 | 144.6 |
| JIF 10-30 | 295 | 70.8 | 153.0 | 144.6 |
| JIF 3-10 | 4,689 | 50.1 | 82.0 | 88.8 |
| JIF <3 | 2,944 | 60.9 | 103.0 | 103.7 |
| JIF missing | 37,782 | 60.4 | 101.0 | 96.7 |

## Top Features

| Rank | Feature | Gain | Split | Forbidden? |
|---:|---|---:|---:|---|
| 1 | `abstract_word_count` | 36953.2 | 4391 | no |
| 2 | `j_hist_jcr_jif` | 35499.5 | 2520 | no |
| 3 | `is_research_article` | 27855.4 | 258 | no |
| 4 | `mesh_terms_count` | 22372.2 | 1845 | no |
| 5 | `year` | 15551.8 | 1819 | no |
| 6 | `q_score_mean` | 13812.0 | 3136 | no |
| 7 | `q_score_sd` | 12199.5 | 3041 | no |
| 8 | `first_author_h_index` | 10444.3 | 2246 | no |
| 9 | `title_word_count` | 9380.8 | 2303 | no |
| 10 | `last_author_h_index` | 8955.1 | 2311 | no |
| 11 | `max_team_h_index` | 8487.5 | 2108 | no |
| 12 | `has_structured_abstract` | 8273.5 | 223 | no |
| 13 | `median_team_h_index` | 8148.0 | 1998 | no |
| 14 | `author_count` | 7841.1 | 1181 | no |
| 15 | `publication_types_count` | 4897.4 | 651 | no |
| 16 | `j_hist_metric_age` | 4392.1 | 634 | no |
| 17 | `funder_count` | 4060.6 | 784 | no |
| 18 | `q_numeric_count` | 3409.1 | 810 | no |
| 19 | `team_size_with_id` | 3207.6 | 755 | no |
| 20 | `q_na_count` | 2717.3 | 551 | no |
| 21 | `is_review` | 2639.5 | 216 | no |
| 22 | `is_case_report` | 2626.7 | 260 | no |
| 23 | `q_unknown_count` | 2394.1 | 572 | no |
| 24 | `n_nih_grants` | 2143.6 | 297 | no |
| 25 | `q_numeric_frac` | 2032.1 | 474 | no |
| 26 | `q_na_frac` | 1568.3 | 334 | no |
| 27 | `is_clinical` | 1176.7 | 122 | no |
| 28 | `has_nih_grant` | 1032.2 | 161 | no |
| 29 | `has_funder` | 1028.4 | 206 | no |
| 30 | `international_collab` | 911.1 | 233 | no |
| 31 | `is_trial` | 506.9 | 72 | no |
| 32 | `q_score_max` | 436.2 | 82 | no |
| 33 | `q_score_min` | 425.1 | 78 | no |
| 34 | `has_first_affiliation` | 264.6 | 50 | no |
| 35 | `q_score_count` | 186.5 | 44 | no |
