# FateCore v0.3 Evaluation

- Generated from: `C:\Users\R\paperfate\weights\fatecore-v0.3-metrics.json`
- Trained at: `2026-05-24T02:17:16.183170`
- Feature CSV: `E:\paperfate\data\features\v0.3-features.csv`
- Rows: `857,284`
- Features: `66`
- Split: `random_80_20_only_no_year_split`
- Decision: **DEPLOY RECOMMENDED**

## Summary

| Target | Train | Cal | Test | MAE raw cal | R2 log | R2 raw cal | Conf. coverage | v0.2 R2 log | Delta |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| JCR JIF | 52,968 | 13,243 | 16,490 | 0.242 | 0.952 | 0.868 | 0.895 | 0.503 | 0.4490 |
| iCite RCR | 407,170 | 101,793 | 127,253 | 0.061 | 0.999 | 0.902 | 0.898 | 0.337 | 0.6613 |
| log citations | 546,686 | 136,672 | 170,871 | 0.067 | 0.987 | 0.987 | 0.901 | 0.727 | 0.2605 |

## Deploy Decision

- Rule: deploy if `R2_log(y_jcr_jif) >= 0.50` and above the production baseline `0.435`.
- Observed JIF R2_log: `0.9525`.
- Observed JIF R2_raw_cal: `0.8684`.
- Decision: **DEPLOY RECOMMENDED**.

## JIF Tier Metrics

| Tier | n | MAE raw | Median true | Median pred |
|---|---:|---:|---:|---:|
| top >=30 | 48 | 12.847 | 42.700 | 52.007 |
| high 10-30 | 921 | 0.726 | 12.800 | 12.673 |
| mid 3-10 | 8,396 | 0.202 | 4.000 | 3.910 |
| low <3 | 7,125 | 0.142 | 2.000 | 2.152 |

## Top Features

### JCR JIF

| Rank | Feature | Gain | Split |
|---:|---|---:|---:|
| 1 | `j_hist_jcr_jif` | 115434.9 | 21835 |
| 2 | `j_hist_jcr_jif_5yr` | 30519.9 | 21051 |
| 3 | `icite_citation_count` | 4921.2 | 7370 |
| 4 | `j_hist_article_influence` | 3403.5 | 1711 |
| 5 | `j_hist_jci` | 2012.2 | 5285 |
| 6 | `is_case_report` | 1389.6 | 454 |
| 7 | `icite_nih_percentile` | 1324.9 | 14706 |
| 8 | `abstract_word_count` | 1164.1 | 18603 |
| 9 | `reference_count` | 1145.4 | 15905 |
| 10 | `pmc_body_word_count` | 993.4 | 7413 |
| 11 | `citations_openalex` | 781.9 | 2795 |
| 12 | `unpaywall_journal_oa` | 717.0 | 1671 |
| 13 | `icite_cited_by_clin` | 709.6 | 1260 |
| 14 | `mesh_terms_count` | 650.2 | 4641 |
| 15 | `has_funder` | 613.3 | 1105 |
| 16 | `year` | 610.5 | 2267 |
| 17 | `q_score_mean` | 559.7 | 13977 |
| 18 | `unpaywall_journal_doaj` | 555.6 | 1718 |
| 19 | `epmc_body_word_count` | 552.7 | 9641 |
| 20 | `first_mesh_root_hash` | 537.4 | 5747 |
| 21 | `q_score_sd` | 525.4 | 13800 |
| 22 | `author_count` | 478.3 | 4830 |
| 23 | `is_trial` | 441.9 | 142 |
| 24 | `max_team_h_index` | 398.9 | 7668 |
| 25 | `pmc_ref_count` | 396.6 | 5579 |
| 26 | `median_team_h_index` | 330.1 | 7429 |
| 27 | `j_hist_eigenfactor` | 289.2 | 2852 |
| 28 | `title_word_count` | 284.2 | 8876 |
| 29 | `pmc_table_count` | 279.2 | 3086 |
| 30 | `pmc_figure_count` | 274.8 | 2699 |

### iCite RCR

| Rank | Feature | Gain | Split |
|---:|---|---:|---:|
| 1 | `icite_nih_percentile` | 1713781.4 | 30303 |
| 2 | `icite_citation_count` | 329788.8 | 34496 |
| 3 | `year` | 19102.9 | 14649 |
| 4 | `pub_year_age` | 17246.9 | 2528 |
| 5 | `citations_openalex` | 6983.4 | 17195 |
| 6 | `fwci_topic_norm` | 4674.9 | 11525 |
| 7 | `icite_apt` | 3857.5 | 7255 |
| 8 | `fwci` | 1575.0 | 11087 |
| 9 | `icite_cited_by_clin` | 1328.9 | 22518 |
| 10 | `reference_count` | 381.9 | 26393 |
| 11 | `team_size_with_id` | 333.2 | 2694 |
| 12 | `max_team_h_index` | 226.5 | 13066 |
| 13 | `q_score_sd` | 212.0 | 18067 |
| 14 | `first_author_h_index` | 205.8 | 15325 |
| 15 | `abstract_word_count` | 203.7 | 19422 |
| 16 | `q_score_mean` | 199.1 | 16234 |
| 17 | `last_author_h_index` | 193.0 | 14652 |
| 18 | `median_team_h_index` | 171.9 | 13575 |
| 19 | `mesh_terms_count` | 140.8 | 9532 |
| 20 | `title_word_count` | 137.2 | 10783 |
| 21 | `first_mesh_root_hash` | 106.4 | 11390 |
| 22 | `q_numeric_count` | 104.9 | 3823 |
| 23 | `q_na_count` | 75.8 | 2013 |
| 24 | `unpaywall_journal_oa` | 75.2 | 1667 |
| 25 | `funder_count` | 61.9 | 2963 |
| 26 | `author_count` | 50.6 | 4139 |
| 27 | `j_hist_jcr_jif_5yr` | 50.3 | 2825 |
| 28 | `j_hist_jcr_jif` | 50.2 | 2943 |
| 29 | `epmc_body_word_count` | 49.9 | 3543 |
| 30 | `q_unknown_count` | 45.2 | 2558 |

### log citations

| Rank | Feature | Gain | Split |
|---:|---|---:|---:|
| 1 | `icite_citation_count` | 15949452.5 | 10692 |
| 2 | `icite_nih_percentile` | 2929630.7 | 12234 |
| 3 | `citations_openalex` | 1543711.7 | 11050 |
| 4 | `fwci` | 99331.7 | 2543 |
| 5 | `pub_year_age` | 90233.0 | 1248 |
| 6 | `year` | 61846.5 | 7681 |
| 7 | `reference_count` | 33241.0 | 13507 |
| 8 | `icite_apt` | 12547.6 | 1999 |
| 9 | `abstract_word_count` | 10418.0 | 12502 |
| 10 | `first_mesh_root_hash` | 10238.9 | 10481 |
| 11 | `q_score_sd` | 9236.0 | 10917 |
| 12 | `q_score_mean` | 8484.6 | 9981 |
| 13 | `title_word_count` | 8276.8 | 8073 |
| 14 | `mesh_terms_count` | 6669.3 | 5631 |
| 15 | `icite_cited_by_clin` | 5100.7 | 3302 |
| 16 | `has_pmcid` | 4938.3 | 1009 |
| 17 | `author_count` | 4474.7 | 4622 |
| 18 | `max_team_h_index` | 3922.8 | 461 |
| 19 | `fwci_topic_norm` | 3919.9 | 927 |
| 20 | `unpaywall_is_oa` | 2565.7 | 2055 |
| 21 | `q_numeric_count` | 2437.3 | 2086 |
| 22 | `team_size_with_id` | 2434.4 | 611 |
| 23 | `j_hist_metric_age` | 2213.1 | 1634 |
| 24 | `median_team_h_index` | 1716.7 | 245 |
| 25 | `publication_types_count` | 1612.9 | 1828 |
| 26 | `is_case_report` | 1337.4 | 655 |
| 27 | `epmc_body_word_count` | 1247.5 | 41 |
| 28 | `q_unknown_count` | 1122.8 | 1273 |
| 29 | `q_na_count` | 1074.0 | 737 |
| 30 | `unpaywall_journal_oa` | 1008.9 | 729 |

## Notes

- Random split only was used. No year-based split or year cutoff was applied.
- Calibration uses a random calibration subset taken only from the training split.
- Conformal intervals use split conformal residuals on the calibration subset with alpha=0.1.
- Same-year journal metrics are not present as feature columns; v0.3 uses prior-year `j_hist_*` features from the CSV.
- Production cold-start inference cannot know post-publication features such as future citations, FWCI, and iCite values; the server fills those as missing values. Treat the offline v0.3 metrics as an enriched-corpus benchmark, not a pure pre-submission-only benchmark.
