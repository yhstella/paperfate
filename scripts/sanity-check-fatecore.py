#!/usr/bin/env python
"""FateCore v0.1 sanity check — 알려진 high/low IF paper로 prediction test."""
import os
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb

ROOT = Path(__file__).parent.parent
DATA = Path(os.environ.get("DATA_ROOT", ROOT / "data"))
WEIGHTS = ROOT / "weights"

X = pd.read_csv(DATA / "fatecore" / "features-2026-05-21.csv")
y = pd.read_csv(DATA / "fatecore" / "labels-2026-05-21.csv")
merged = X.merge(y, on="doi", how="inner")

drop_cols = ["doi", "pmid", "y_jcr_jif", "y_icite_rcr", "y_citations_log"]
feature_cols = [c for c in merged.columns if c not in drop_cols]

models = {}
for tgt in ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]:
    p = WEIGHTS / f"fatecore-v0.1-{tgt}.txt"
    if p.exists():
        models[tgt] = lgb.Booster(model_file=str(p))

# Sample 5 papers from each JIF tier
print("\n── Sanity: Random sample of paper with true JIF + predicted JIF ──\n")

# Take papers with valid JIF, sort by true JIF, sample
valid = merged.dropna(subset=["y_jcr_jif"]).copy()
print(f"  Papers with JIF label: {len(valid)}")
print(f"  JIF distribution: min={valid['y_jcr_jif'].min():.2f}, median={valid['y_jcr_jif'].median():.2f}, max={valid['y_jcr_jif'].max():.2f}")

# Bin by JIF tier
tiers = {
    "Top (JIF≥30)": valid[valid["y_jcr_jif"] >= 30],
    "High (10≤JIF<30)": valid[(valid["y_jcr_jif"] >= 10) & (valid["y_jcr_jif"] < 30)],
    "Mid (3≤JIF<10)": valid[(valid["y_jcr_jif"] >= 3) & (valid["y_jcr_jif"] < 10)],
    "Low (JIF<3)": valid[valid["y_jcr_jif"] < 3],
}

for tier_name, df in tiers.items():
    if len(df) == 0: continue
    print(f"\n=== {tier_name} — n={len(df)} ===")
    sample = df.sample(min(5, len(df)), random_state=42)
    X_s = sample[feature_cols].apply(pd.to_numeric, errors="coerce").values
    pred_jif = models["y_jcr_jif"].predict(X_s, num_iteration=models["y_jcr_jif"].best_iteration)
    pred_rcr = models["y_icite_rcr"].predict(X_s, num_iteration=models["y_icite_rcr"].best_iteration) if "y_icite_rcr" in models else [None]*len(sample)
    pred_cit = models["y_citations_log"].predict(X_s, num_iteration=models["y_citations_log"].best_iteration) if "y_citations_log" in models else [None]*len(sample)

    for i in range(len(sample)):
        row = sample.iloc[i]
        true_jif = row["y_jcr_jif"]
        true_rcr = row["y_icite_rcr"] if pd.notna(row["y_icite_rcr"]) else None
        true_cit = np.exp(row["y_citations_log"]) - 1 if pd.notna(row["y_citations_log"]) else None
        pred_cit_raw = np.exp(pred_cit[i]) - 1 if pred_cit[i] is not None else None
        print(f"  DOI: {row['doi']}")
        print(f"    Year: {int(row['year'])}, MeSH terms: {int(row['mesh_terms_count'])}, Authors: {int(row['author_count'])}")
        print(f"    True JIF: {true_jif:.2f}  Predicted: {pred_jif[i]:.2f}  (err {abs(true_jif-pred_jif[i]):.2f})")
        if true_rcr is not None:
            print(f"    True RCR: {true_rcr:.2f}  Predicted: {pred_rcr[i]:.2f}")
        if true_cit is not None and pred_cit_raw is not None:
            print(f"    True citations: {int(true_cit)}  Predicted: {int(pred_cit_raw)}")

# Overall accuracy by tier
print("\n── Accuracy by JIF tier (test only) ──\n")
from sklearn.model_selection import train_test_split
_, test = train_test_split(merged, test_size=0.2, random_state=42)
test_valid = test.dropna(subset=["y_jcr_jif"])
X_test = test_valid[feature_cols].apply(pd.to_numeric, errors="coerce").values
preds = models["y_jcr_jif"].predict(X_test, num_iteration=models["y_jcr_jif"].best_iteration)
test_valid = test_valid.copy()
test_valid["pred"] = preds
test_valid["err"] = np.abs(test_valid["y_jcr_jif"] - test_valid["pred"])
test_valid["rel_err"] = test_valid["err"] / (test_valid["y_jcr_jif"] + 0.1)

for label, mask in [
    ("Top (≥30)", test_valid["y_jcr_jif"] >= 30),
    ("High (10-30)", (test_valid["y_jcr_jif"] >= 10) & (test_valid["y_jcr_jif"] < 30)),
    ("Mid (3-10)", (test_valid["y_jcr_jif"] >= 3) & (test_valid["y_jcr_jif"] < 10)),
    ("Low (<3)", test_valid["y_jcr_jif"] < 3),
]:
    df = test_valid[mask]
    if len(df) == 0: continue
    print(f"  {label:15s}  n={len(df):>5}  MAE={df['err'].mean():.3f}  median_pred={df['pred'].median():.2f}  rel_err_median={df['rel_err'].median()*100:.1f}%")
