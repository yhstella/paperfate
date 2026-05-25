#!/usr/bin/env python
"""Phase 1.4 — FateCore v0.1 feature importance + error analysis.

사용:
    python scripts/analyze-fatecore-v0.1.py

출력:
    weights/fatecore-v0.1-importance.json    (feature importance ranking)
    weights/fatecore-v0.1-errors.json        (worst 50 predictions per target)
    docs/EVAL_v0.1.md                        (eval report)
"""
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.isotonic import IsotonicRegression

ROOT = Path(__file__).parent.parent
DATA = Path(os.environ.get("DATA_ROOT", ROOT / "data"))
WEIGHTS = ROOT / "weights"

print("Loading data + models …")
X = pd.read_csv(DATA / "fatecore" / "features-2026-05-21.csv")
y = pd.read_csv(DATA / "fatecore" / "labels-2026-05-21.csv")
merged = X.merge(y, on="doi", how="inner")

drop_cols = ["doi", "pmid", "y_jcr_jif", "y_icite_rcr", "y_citations_log"]
feature_cols = [c for c in merged.columns if c not in drop_cols]
print(f"  features: {len(feature_cols)}, rows: {len(merged)}")

train, test = train_test_split(merged, test_size=0.2, random_state=42)

X_train = train[feature_cols].apply(pd.to_numeric, errors="coerce").values
X_test  = test[feature_cols].apply(pd.to_numeric, errors="coerce").values

targets = ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]
importance_report = {}
error_report = {}

for target in targets:
    print(f"\n── {target} ──")
    model_path = WEIGHTS / f"fatecore-v0.1-{target}.txt"
    if not model_path.exists():
        print(f"  ✗ missing {model_path}")
        continue
    model = lgb.Booster(model_file=str(model_path))

    # Feature importance (gain-based — more meaningful than split count)
    imp_gain = model.feature_importance(importance_type="gain")
    imp_split = model.feature_importance(importance_type="split")
    feat_imp = sorted(
        zip(feature_cols, imp_gain, imp_split),
        key=lambda x: x[1], reverse=True
    )
    top20 = [{"col": c, "gain": float(g), "splits": int(s)} for c, g, s in feat_imp[:20]]
    importance_report[target] = top20

    print(f"  Top 10 features by gain:")
    for c, g, s in feat_imp[:10]:
        print(f"    {c:35s}  gain={g:>12.1f}  splits={s}")

    # Error analysis on test set
    mask = ~pd.isna(test[target].values)
    if mask.sum() < 100:
        continue
    y_true = test[target].values[mask]
    X_te = X_test[mask]
    pred = model.predict(X_te, num_iteration=model.best_iteration)
    err = np.abs(y_true - pred)

    # Calibration MAE
    iso = IsotonicRegression(out_of_bounds="clip").fit(pred, y_true)
    pred_cal = iso.transform(pred)
    err_cal = np.abs(y_true - pred_cal)

    print(f"  Test MAE raw={mean_absolute_error(y_true, pred):.3f}  cal={mean_absolute_error(y_true, pred_cal):.3f}  R²={r2_score(y_true, pred):.3f}")

    # Worst 50 predictions
    test_keep = test[mask].reset_index(drop=True)
    worst_idx = np.argsort(err)[::-1][:50]
    worst = []
    for i in worst_idx:
        worst.append({
            "doi": test_keep.iloc[i]["doi"],
            "pmid": str(test_keep.iloc[i]["pmid"]) if not pd.isna(test_keep.iloc[i]["pmid"]) else None,
            "year": int(test_keep.iloc[i]["year"]) if not pd.isna(test_keep.iloc[i]["year"]) else None,
            "true": float(y_true[i]),
            "pred": float(pred[i]),
            "pred_cal": float(pred_cal[i]),
            "err": float(err[i]),
        })
    error_report[target] = {
        "test_n": int(mask.sum()),
        "mae_raw": float(mean_absolute_error(y_true, pred)),
        "mae_cal": float(mean_absolute_error(y_true, pred_cal)),
        "r2": float(r2_score(y_true, pred)),
        "worst_50": worst,
        "true_dist": {
            "mean": float(np.mean(y_true)),
            "median": float(np.median(y_true)),
            "p5": float(np.percentile(y_true, 5)),
            "p95": float(np.percentile(y_true, 95)),
            "max": float(np.max(y_true)),
        },
        "pred_dist": {
            "mean": float(np.mean(pred)),
            "median": float(np.median(pred)),
            "p5": float(np.percentile(pred, 5)),
            "p95": float(np.percentile(pred, 95)),
        },
    }

    # Year × MAE breakdown
    year_buckets = {}
    for i, row_idx in enumerate(test_keep.index):
        y_val = test_keep.iloc[i]["year"]
        if pd.isna(y_val): continue
        bucket = int(y_val // 5) * 5
        year_buckets.setdefault(bucket, []).append(err[i])
    print(f"  MAE by year bucket:")
    for bucket in sorted(year_buckets.keys()):
        errs = year_buckets[bucket]
        print(f"    {bucket}-{bucket+4}: n={len(errs):>5}  MAE={np.mean(errs):.3f}")

# Save reports
(WEIGHTS / "fatecore-v0.1-importance.json").write_text(json.dumps(importance_report, indent=2))
(WEIGHTS / "fatecore-v0.1-errors.json").write_text(json.dumps(error_report, indent=2))
print(f"\n✓ Saved:")
print(f"  {WEIGHTS / 'fatecore-v0.1-importance.json'}")
print(f"  {WEIGHTS / 'fatecore-v0.1-errors.json'}")
