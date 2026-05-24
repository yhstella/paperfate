# FateCore v0.3-prepub Evaluation

- Generated from: `C:\Users\R\paperfate\weights\fatecore-v0.3-prepub-metrics.json`
- Trained at: `2026-05-24T09:17:33.496492`
- Feature CSV: `E:\paperfate\data\features\v0.3-prepub-features.csv`
- Rows: `857,284`
- Features: `34`
- Split: `random_80_20_only_no_year_split`
- Forbidden post-publication features in model: `0`
- Suspicious high R2 guardrail: `R2_log < 0.70`
- EMPA-REG cold-start smoke: passed locally
- Decision: **HOLD v0.2-prod**

## Summary

| Target | Train | Cal | Test | MAE raw cal | R2 log | R2 raw cal | Conf. coverage | v0.2-prod R2 log | Delta |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| JCR JIF | 52,968 | 13,243 | 16,490 | 1.494 | 0.461 | 0.356 | 0.898 | 0.435 | 0.0260 |
| iCite RCR | 407,170 | 101,793 | 127,253 | 1.278 | 0.322 | 0.206 | 0.899 | 0.288 | 0.0345 |
| log citations | 546,686 | 136,672 | 170,871 | 0.692 | 0.712 | 0.713 | 0.901 | 0.707 | 0.0055 |

## Deploy Rule

- Rule: deploy only if `R2_log(y_jcr_jif) >= 0.48`, above v0.2-prod `0.435`, no forbidden features, and no suspiciously high R2.
- Observed JIF R2_log: `0.4610`.
- Observed JIF R2_raw_cal: `0.3557`.
- Forbidden features: `none`.
- Suspicious high-R2 flag: `no`.
- Decision: **HOLD v0.2-prod**.

## EMPA-REG Cold-Start Smoke

Command:

```powershell
node scripts\test-fatecore-v0.3-prepub-empa-reg-cold.mjs --version-tag v0.2-prod
node scripts\test-fatecore-v0.3-prepub-empa-reg-cold.mjs --version-tag v0.3-prepub
```

Input intentionally supplied no target journal and no post-publication fields.

| Model | Feature count | JIF point | CI low | CI high | Status |
|---|---:|---:|---:|---:|---|
| v0.2-prod | 523 | 2.153 | 0.775 | 4.602 | loaded |
| v0.3-prepub | 34 | 2.223 | 0.813 | 4.729 | loaded |

Interpretation: v0.3-prepub does not reproduce the v0.3 cold-start collapse. It is still not deployable under Round3 because offline JIF R2 is `0.4610`, below the `0.48` threshold.

## JIF Tier Metrics

| Tier | n | MAE raw | Median true | Median pred |
|---|---:|---:|---:|---:|
| top >=30 | 48 | 37.620 | 42.700 | 6.408 |
| high 10-30 | 921 | 7.177 | 12.800 | 5.820 |
| mid 3-10 | 8,396 | 1.181 | 4.000 | 3.707 |
| low <3 | 7,125 | 0.885 | 2.000 | 2.658 |

## Top Features

### JCR JIF

| Rank | Feature | Gain | Split | Forbidden? |
|---:|---|---:|---:|---|
| 1 | `is_case_report` | 16492.0 | 218 | no |
| 2 | `mesh_terms_count` | 15985.5 | 1838 | no |
| 3 | `abstract_word_count` | 12936.6 | 5359 | no |
| 4 | `has_funder` | 8785.4 | 379 | no |
| 5 | `author_count` | 6542.0 | 1069 | no |
| 6 | `q_score_mean` | 4885.6 | 3786 | no |
| 7 | `max_team_h_index` | 4819.4 | 3083 | no |
| 8 | `median_team_h_index` | 4739.2 | 2826 | no |
| 9 | `q_score_sd` | 4176.0 | 3513 | no |
| 10 | `funder_count` | 3761.5 | 1335 | no |
| 11 | `title_word_count` | 3696.0 | 2585 | no |
| 12 | `first_author_h_index` | 3276.4 | 2813 | no |
| 13 | `last_author_h_index` | 3121.9 | 2957 | no |
| 14 | `q_numeric_count` | 3095.3 | 1454 | no |
| 15 | `q_na_frac` | 3010.6 | 857 | no |
| 16 | `publication_types_count` | 2652.9 | 854 | no |
| 17 | `year` | 2178.9 | 375 | no |
| 18 | `team_size_with_id` | 1782.9 | 1035 | no |
| 19 | `q_na_count` | 1701.6 | 890 | no |
| 20 | `q_numeric_frac` | 1421.8 | 870 | no |
| 21 | `is_research_article` | 1299.3 | 377 | no |
| 22 | `q_unknown_count` | 1095.9 | 692 | no |
| 23 | `is_trial` | 886.2 | 199 | no |
| 24 | `n_nih_grants` | 768.2 | 335 | no |
| 25 | `has_first_affiliation` | 715.5 | 148 | no |
| 26 | `has_structured_abstract` | 666.7 | 262 | no |
| 27 | `is_review` | 468.3 | 176 | no |
| 28 | `preprint_exists` | 431.4 | 98 | no |
| 29 | `has_nih_grant` | 383.0 | 182 | no |
| 30 | `international_collab` | 341.1 | 347 | no |

### iCite RCR

| Rank | Feature | Gain | Split | Forbidden? |
|---:|---|---:|---:|---|
| 1 | `publication_types_count` | 177086.6 | 3207 | no |
| 2 | `abstract_word_count` | 129049.6 | 14216 | no |
| 3 | `first_author_h_index` | 80392.1 | 12516 | no |
| 4 | `year` | 68280.8 | 7330 | no |
| 5 | `max_team_h_index` | 61937.2 | 9370 | no |
| 6 | `is_case_report` | 53476.5 | 323 | no |
| 7 | `median_team_h_index` | 50124.5 | 10275 | no |
| 8 | `q_score_mean` | 43916.0 | 10846 | no |
| 9 | `title_word_count` | 41847.1 | 7809 | no |
| 10 | `author_count` | 38234.8 | 3489 | no |
| 11 | `q_score_sd` | 33326.2 | 11234 | no |
| 12 | `mesh_terms_count` | 33307.2 | 6839 | no |
| 13 | `last_author_h_index` | 28739.0 | 10598 | no |
| 14 | `q_unknown_count` | 21708.5 | 2013 | no |
| 15 | `is_review` | 21542.1 | 984 | no |
| 16 | `q_numeric_frac` | 16911.5 | 1212 | no |
| 17 | `q_na_frac` | 15434.2 | 1390 | no |
| 18 | `has_funder` | 15295.5 | 986 | no |
| 19 | `is_trial` | 14023.9 | 542 | no |
| 20 | `n_nih_grants` | 11243.8 | 2321 | no |
| 21 | `q_numeric_count` | 10505.4 | 2950 | no |
| 22 | `team_size_with_id` | 9749.7 | 2561 | no |
| 23 | `q_na_count` | 9553.7 | 1639 | no |
| 24 | `is_clinical` | 5949.9 | 667 | no |
| 25 | `is_research_article` | 5847.2 | 826 | no |
| 26 | `funder_count` | 5843.6 | 1594 | no |
| 27 | `has_nih_grant` | 5727.3 | 732 | no |
| 28 | `q_score_min` | 4234.8 | 352 | no |
| 29 | `has_first_affiliation` | 2130.7 | 320 | no |
| 30 | `international_collab` | 2120.5 | 764 | no |

### log citations

| Rank | Feature | Gain | Split | Forbidden? |
|---:|---|---:|---:|---|
| 1 | `year` | 10742773.5 | 8432 | no |
| 2 | `median_team_h_index` | 924719.3 | 9168 | no |
| 3 | `publication_types_count` | 558482.9 | 3122 | no |
| 4 | `mesh_terms_count` | 519824.8 | 7204 | no |
| 5 | `max_team_h_index` | 481625.1 | 7848 | no |
| 6 | `first_author_h_index` | 411865.9 | 10831 | no |
| 7 | `abstract_word_count` | 365657.7 | 13983 | no |
| 8 | `is_case_report` | 365364.0 | 771 | no |
| 9 | `q_score_mean` | 197604.3 | 10735 | no |
| 10 | `last_author_h_index` | 134523.4 | 9392 | no |
| 11 | `author_count` | 129850.3 | 4158 | no |
| 12 | `title_word_count` | 112114.8 | 7156 | no |
| 13 | `q_score_sd` | 101437.3 | 10829 | no |
| 14 | `is_review` | 88819.4 | 975 | no |
| 15 | `team_size_with_id` | 87954.1 | 3401 | no |
| 16 | `funder_count` | 79128.6 | 1325 | no |
| 17 | `has_funder` | 66763.2 | 955 | no |
| 18 | `q_na_count` | 58586.3 | 1644 | no |
| 19 | `has_nih_grant` | 57642.6 | 700 | no |
| 20 | `q_na_frac` | 52191.6 | 1154 | no |
| 21 | `is_research_article` | 48330.1 | 952 | no |
| 22 | `is_trial` | 45226.5 | 499 | no |
| 23 | `q_numeric_count` | 38661.6 | 2726 | no |
| 24 | `is_clinical` | 35664.4 | 625 | no |
| 25 | `n_nih_grants` | 34364.8 | 1519 | no |
| 26 | `q_unknown_count` | 26890.4 | 1595 | no |
| 27 | `q_numeric_frac` | 16694.3 | 1036 | no |
| 28 | `has_first_affiliation` | 14412.6 | 529 | no |
| 29 | `international_collab` | 13392.1 | 912 | no |
| 30 | `q_score_min` | 5484.1 | 319 | no |

## Excluded Leakage Columns

Excluded groups: citations/FWCI/iCite, reference counts, PMC/EPMC/PDF fulltext, PMCID, Unpaywall indexed article signals, accepted-journal `j_hist_*`, post-publication preprint gap.

## Notes

- Random split only was used. No year-based split or cutoff was applied.
- This report is not sufficient for deployment by itself. EMPA-REG cold-start local and production tests are mandatory.
- If R2 is very high, hold deployment and inspect for leakage even when the explicit forbidden-feature count is zero.
