# FateCore v0.3-pub Evaluation

- Generated from: `C:\Users\R\paperfate\weights\fatecore-v0.3-pub-metrics.json`
- Trained at: `2026-05-24T12:08:27.814265`
- Feature CSV: `E:\paperfate\data\features\v0.3-pub-features.csv`
- Rows: `857,284`
- Features: `40`
- Target-journal mask fraction: `0.3`
- Forbidden post-publication features in model: `0`
- Decision before EMPA smoke: **HOLD v0.2-prod**

## Summary

| Target | With-target R2 log | With-target MAE raw | Cold-start R2 log | Cold-start MAE raw | v0.2-prod R2 log | v0.3-prepub R2 log |
|---|---:|---:|---:|---:|---:|---:|
| JCR JIF | 0.935 | 0.349 | 0.438 | 1.523 | 0.435 | 0.461 |
| iCite RCR | 0.328 | 1.274 | 0.321 | 1.283 | 0.288 | 0.322 |
| log citations | 0.715 | 0.688 | 0.712 | 0.692 | 0.707 | 0.712 |

## Deploy Rule

- With-target JIF R2 must be `>= 0.55`.
- Cold-start JIF R2 must be `>= 0.45`.
- Any JIF R2 `>= 0.85` is suspicious and blocks deploy.
- Observed with-target JIF R2: `0.9349`.
- Observed cold-start JIF R2: `0.4383`.
- Forbidden features: `none`.
- Suspicious high-R2 flag: `yes`.
- Decision: **HOLD v0.2-prod**.

## JIF Tier Metrics - with_target

| Tier | n | MAE raw | Median true | Median pred |
|---|---:|---:|---:|---:|
| top >=30 | 48 | 12.839 | 42.700 | 42.700 |
| high 10-30 | 921 | 1.250 | 12.800 | 11.845 |
| mid 3-10 | 8,396 | 0.310 | 4.000 | 3.799 |
| low <3 | 7,125 | 0.195 | 2.000 | 2.125 |

## JIF Tier Metrics - cold_start

| Tier | n | MAE raw | Median true | Median pred |
|---|---:|---:|---:|---:|
| top >=30 | 48 | 40.196 | 42.700 | 6.176 |
| high 10-30 | 921 | 7.178 | 12.800 | 5.650 |
| mid 3-10 | 8,396 | 1.187 | 4.000 | 3.742 |
| low <3 | 7,125 | 0.926 | 2.000 | 2.787 |

## Top Features

### JCR JIF

| Rank | Feature | Gain | Split | Forbidden? |
|---:|---|---:|---:|---|
| 1 | `j_hist_jcr_jif` | 98537.2 | 2790 | no |
| 2 | `j_hist_jcr_jif_5yr` | 12544.2 | 1636 | no |
| 3 | `is_case_report` | 5744.4 | 131 | no |
| 4 | `mesh_terms_count` | 4435.8 | 1308 | no |
| 5 | `abstract_word_count` | 4101.5 | 3719 | no |
| 6 | `year` | 2446.5 | 522 | no |
| 7 | `has_funder` | 2332.3 | 284 | no |
| 8 | `max_team_h_index` | 2077.1 | 2175 | no |
| 9 | `q_score_mean` | 2077.0 | 2679 | no |
| 10 | `q_score_sd` | 2024.4 | 2492 | no |
| 11 | `author_count` | 1862.1 | 777 | no |
| 12 | `median_team_h_index` | 1844.0 | 2135 | no |
| 13 | `title_word_count` | 1530.6 | 1934 | no |
| 14 | `q_numeric_count` | 1401.2 | 1151 | no |
| 15 | `last_author_h_index` | 1332.9 | 2034 | no |
| 16 | `first_author_h_index` | 1323.6 | 1906 | no |
| 17 | `publication_types_count` | 1301.3 | 660 | no |
| 18 | `funder_count` | 1219.6 | 873 | no |
| 19 | `q_na_frac` | 1149.0 | 595 | no |
| 20 | `team_size_with_id` | 900.1 | 725 | no |
| 21 | `j_hist_metric_age` | 877.3 | 932 | no |
| 22 | `q_na_count` | 737.7 | 561 | no |
| 23 | `q_numeric_frac` | 535.3 | 596 | no |
| 24 | `n_nih_grants` | 443.9 | 257 | no |
| 25 | `q_unknown_count` | 408.7 | 532 | no |
| 26 | `is_review` | 352.4 | 106 | no |
| 27 | `is_research_article` | 337.4 | 243 | no |
| 28 | `is_trial` | 310.4 | 128 | no |
| 29 | `has_structured_abstract` | 205.2 | 135 | no |
| 30 | `has_nih_grant` | 175.0 | 146 | no |

### iCite RCR

| Rank | Feature | Gain | Split | Forbidden? |
|---:|---|---:|---:|---|
| 1 | `publication_types_count` | 148370.8 | 2076 | no |
| 2 | `abstract_word_count` | 111043.7 | 9081 | no |
| 3 | `first_author_h_index` | 68830.8 | 7740 | no |
| 4 | `year` | 66278.2 | 5534 | no |
| 5 | `max_team_h_index` | 56409.3 | 5597 | no |
| 6 | `is_case_report` | 51156.4 | 223 | no |
| 7 | `q_score_mean` | 46408.6 | 6595 | no |
| 8 | `median_team_h_index` | 45037.7 | 6514 | no |
| 9 | `title_word_count` | 41253.3 | 4789 | no |
| 10 | `author_count` | 35748.4 | 2350 | no |
| 11 | `is_trial` | 31936.1 | 363 | no |
| 12 | `mesh_terms_count` | 30037.9 | 4061 | no |
| 13 | `q_score_sd` | 25353.2 | 6830 | no |
| 14 | `is_review` | 22904.8 | 764 | no |
| 15 | `last_author_h_index` | 20456.0 | 6379 | no |
| 16 | `has_funder` | 16631.6 | 691 | no |
| 17 | `q_numeric_frac` | 16334.1 | 756 | no |
| 18 | `q_na_frac` | 15738.8 | 994 | no |
| 19 | `q_unknown_count` | 15317.0 | 1278 | no |
| 20 | `n_nih_grants` | 10708.2 | 1614 | no |
| 21 | `j_hist_metric_age` | 9682.2 | 1005 | no |
| 22 | `team_size_with_id` | 9462.0 | 1708 | no |
| 23 | `q_numeric_count` | 8903.9 | 1955 | no |
| 24 | `q_na_count` | 8013.8 | 1105 | no |
| 25 | `is_research_article` | 7618.6 | 678 | no |
| 26 | `has_nih_grant` | 5944.4 | 549 | no |
| 27 | `funder_count` | 5421.8 | 1148 | no |
| 28 | `is_clinical` | 5306.9 | 509 | no |
| 29 | `has_first_affiliation` | 1830.6 | 272 | no |
| 30 | `q_score_min` | 1699.7 | 246 | no |

### log citations

| Rank | Feature | Gain | Split | Forbidden? |
|---:|---|---:|---:|---|
| 1 | `year` | 11028395.7 | 9553 | no |
| 2 | `median_team_h_index` | 728250.8 | 10226 | no |
| 3 | `max_team_h_index` | 516616.8 | 8916 | no |
| 4 | `publication_types_count` | 470199.5 | 3360 | no |
| 5 | `first_author_h_index` | 369676.5 | 11620 | no |
| 6 | `abstract_word_count` | 358966.1 | 15465 | no |
| 7 | `is_case_report` | 330855.1 | 797 | no |
| 8 | `mesh_terms_count` | 329206.7 | 8004 | no |
| 9 | `j_hist_jcr_jif` | 326019.1 | 517 | no |
| 10 | `q_score_mean` | 167081.4 | 12055 | no |
| 11 | `last_author_h_index` | 135806.0 | 10417 | no |
| 12 | `author_count` | 129592.9 | 4483 | no |
| 13 | `title_word_count` | 113225.4 | 8121 | no |
| 14 | `q_score_sd` | 108847.5 | 12403 | no |
| 15 | `is_review` | 105346.6 | 1153 | no |
| 16 | `team_size_with_id` | 85164.0 | 3828 | no |
| 17 | `is_trial` | 74900.7 | 475 | no |
| 18 | `has_funder` | 70899.8 | 986 | no |
| 19 | `has_nih_grant` | 63321.1 | 755 | no |
| 20 | `q_na_frac` | 57219.6 | 1305 | no |
| 21 | `j_hist_metric_age` | 46394.0 | 1851 | no |
| 22 | `q_na_count` | 44841.9 | 1759 | no |
| 23 | `q_numeric_count` | 42910.0 | 3188 | no |
| 24 | `is_research_article` | 40770.9 | 1020 | no |
| 25 | `funder_count` | 37183.2 | 1492 | no |
| 26 | `n_nih_grants` | 34583.2 | 1643 | no |
| 27 | `q_unknown_count` | 29947.1 | 1808 | no |
| 28 | `is_clinical` | 19548.4 | 628 | no |
| 29 | `q_numeric_frac` | 18846.1 | 1224 | no |
| 30 | `has_first_affiliation` | 14497.0 | 557 | no |

## EMPA-REG Smoke

Command:

```powershell
node scripts\test-fatecore-v0.3-pub-empa-reg.mjs --version-tag v0.3-pub
```

| Scenario | Target journal | JIF point | CI low | CI high | Required | Result |
|---|---|---:|---:|---:|---|---|
| cold_start | none | 0.488 | 0.047 | 1.115 | v0.2-prod range, about 2-3 JIF | fail |
| nejm | New England Journal of Medicine | 42.700 | 29.744 | 61.116 | 30-100 JIF | pass |
| saudi_heart | Saudi Heart Association Journal | 1.580 | 0.815 | 2.667 | 1-2 JIF | pass |

Interpretation: the target-aware path behaves plausibly, but the no-target cold-start path collapses below the v0.2-prod EMPA-REG range. Combined with suspicious with-target R2 `0.9349`, this blocks deploy.
