#!/usr/bin/env python
"""Train FateCore v0.4 review-timeline model.

Hard rules:
  - random split only
  - pre-submission features only
  - target is log1p(clipped review days)
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split


ROOT = Path(__file__).parent.parent
DATA_DIR = Path(os.environ.get("DATA_ROOT", ROOT / "data"))
FEATURES_DIR = DATA_DIR / "features"
WEIGHTS_DIR = ROOT / "weights"
WEIGHTS_DIR.mkdir(exist_ok=True)

FORBIDDEN_PREFIXES = [
    "citations_",
    "fwci",
    "reference_count",
    "influential_citations",
    "unpaywall_",
    "pmc_",
    "epmc_",
    "pdf_",
    "preprint_pub_gap_days",
    "pub_year_age",
]
FORBIDDEN_EXACT = {
    "icite_rcr",
    "icite_citation_count",
    "icite_nih_percentile",
    "icite_apt",
    "icite_cited_by_clin",
    "icite_citations_per_year",
    "icite_expected_cit_per_year",
    "icite_field_citation_rate",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--features", default=str(FEATURES_DIR / "v0.4-timeline-features.csv"))
    p.add_argument("--manifest", default=str(FEATURES_DIR / "v0.4-timeline-features-manifest.json"))
    p.add_argument("--target", default="y_review_days")
    p.add_argument("--test-size", type=float, default=0.2)
    p.add_argument("--cal-size", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--num-rounds", type=int, default=2500)
    p.add_argument("--early-stopping", type=int, default=100)
    p.add_argument("--learning-rate", type=float, default=0.035)
    p.add_argument("--num-leaves", type=int, default=63)
    p.add_argument("--num-threads", type=int, default=8)
    p.add_argument("--sample-frac", type=float, default=1.0)
    p.add_argument("--alpha", type=float, default=0.1)
    p.add_argument("--version-tag", default="v0.4-timeline")
    return p.parse_args()


def is_forbidden(name: str) -> bool:
    return name in FORBIDDEN_EXACT or any(name.startswith(prefix) for prefix in FORBIDDEN_PREFIXES)


def conformal_quantile(abs_errors: np.ndarray, alpha: float) -> float:
    if abs_errors.size == 0:
        return float("nan")
    q = np.ceil((abs_errors.size + 1) * (1 - alpha)) / abs_errors.size
    return float(np.quantile(abs_errors, min(1.0, q), method="higher"))


def inverse_log_days(y_log: np.ndarray) -> np.ndarray:
    return np.clip(np.expm1(y_log), 1, 730)


def regression_metrics(y_raw: np.ndarray, y_log: np.ndarray, pred_log: np.ndarray, pred_iso_log: np.ndarray, q_log: float, alpha: float) -> dict[str, Any]:
    pred_raw = inverse_log_days(pred_log)
    pred_iso_raw = inverse_log_days(pred_iso_log)
    lower = inverse_log_days(pred_iso_log - q_log)
    upper = inverse_log_days(pred_iso_log + q_log)
    return {
        "mae_days": float(mean_absolute_error(y_raw, pred_raw)),
        "mae_cal_days": float(mean_absolute_error(y_raw, pred_iso_raw)),
        "median_abs_error_cal_days": float(np.median(np.abs(y_raw - pred_iso_raw))),
        "r2_log": float(r2_score(y_log, pred_log)),
        "r2_log_cal": float(r2_score(y_log, pred_iso_log)),
        "r2_days": float(r2_score(y_raw, pred_raw)),
        "r2_cal_days": float(r2_score(y_raw, pred_iso_raw)),
        "conformal_alpha": float(alpha),
        "conformal_q_log": float(q_log),
        "conformal_coverage": float(np.mean((y_raw >= lower) & (y_raw <= upper))),
        "interval_width_median_days": float(np.median(upper - lower)),
        "pred_days_p10": float(np.percentile(pred_iso_raw, 10)),
        "pred_days_p50": float(np.percentile(pred_iso_raw, 50)),
        "pred_days_p90": float(np.percentile(pred_iso_raw, 90)),
    }


def tier_metrics(df_test: pd.DataFrame, y_raw: np.ndarray, pred_raw: np.ndarray) -> dict[str, Any]:
    hist = pd.to_numeric(df_test.get("j_hist_jcr_jif"), errors="coerce").to_numpy(dtype=np.float64)
    tiers = {
        "target_jif_ge_30": hist >= 30,
        "target_jif_10_30": (hist >= 10) & (hist < 30),
        "target_jif_3_10": (hist >= 3) & (hist < 10),
        "target_jif_lt_3": hist < 3,
        "target_jif_missing": ~np.isfinite(hist),
    }
    out: dict[str, Any] = {}
    for name, mask in tiers.items():
        if int(mask.sum()) == 0:
            continue
        out[name] = {
            "n": int(mask.sum()),
            "mae_days": float(mean_absolute_error(y_raw[mask], pred_raw[mask])),
            "median_true_days": float(np.median(y_raw[mask])),
            "median_pred_days": float(np.median(pred_raw[mask])),
        }
    return out


def top_importance(model: lgb.Booster, feature_cols: list[str], n: int = 40) -> list[dict[str, Any]]:
    gain = model.feature_importance(importance_type="gain")
    split = model.feature_importance(importance_type="split")
    rows = []
    for i, name in enumerate(feature_cols):
      rows.append({"feature": name, "gain": float(gain[i]), "split": int(split[i])})
    rows.sort(key=lambda r: r["gain"], reverse=True)
    return rows[:n]


def main() -> None:
    args = parse_args()
    features_path = Path(args.features)
    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    feature_cols = list(manifest["feature_cols"])
    forbidden = [c for c in feature_cols if is_forbidden(c)]
    if forbidden:
        raise SystemExit(f"Forbidden post-publication features present: {forbidden}")

    print("PaperFate FateCore v0.4 timeline trainer")
    print(f"Features: {features_path}")
    print(f"Rows loading...")
    df = pd.read_csv(features_path)
    if args.sample_frac < 1.0:
        df = df.sample(frac=args.sample_frac, random_state=args.seed).reset_index(drop=True)
    df = df[pd.to_numeric(df[args.target], errors="coerce").notna()].reset_index(drop=True)
    if len(df) < 1000:
        raise SystemExit(f"Not enough timeline rows after filtering: {len(df):,}")

    y_raw = pd.to_numeric(df[args.target], errors="coerce").clip(1, 730).to_numpy(dtype=np.float64)
    y_log = np.log1p(y_raw)
    x_all = df[feature_cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=np.float32)

    all_idx = np.arange(len(df))
    train_idx, test_idx = train_test_split(all_idx, test_size=args.test_size, random_state=args.seed, shuffle=True)
    model_idx, cal_idx = train_test_split(train_idx, test_size=args.cal_size, random_state=args.seed + 17, shuffle=True)

    train_ds = lgb.Dataset(x_all[model_idx], label=y_log[model_idx], feature_name=feature_cols)
    cal_ds = lgb.Dataset(x_all[cal_idx], label=y_log[cal_idx], reference=train_ds, feature_name=feature_cols)

    params = {
        "objective": "regression",
        "metric": "mae",
        "learning_rate": args.learning_rate,
        "num_leaves": args.num_leaves,
        "feature_fraction": 0.85,
        "bagging_fraction": 0.85,
        "bagging_freq": 5,
        "min_data_in_leaf": 40,
        "lambda_l2": 0.1,
        "num_threads": args.num_threads,
        "verbose": -1,
        "seed": args.seed,
        "feature_pre_filter": False,
    }

    print(f"train_model={len(model_idx):,} cal={len(cal_idx):,} test={len(test_idx):,} features={len(feature_cols):,}")
    model = lgb.train(
        params,
        train_ds,
        num_boost_round=args.num_rounds,
        valid_sets=[cal_ds],
        valid_names=["cal"],
        callbacks=[
            lgb.early_stopping(args.early_stopping),
            lgb.log_evaluation(period=50),
        ],
    )

    pred_cal = model.predict(x_all[cal_idx], num_iteration=model.best_iteration)
    iso = IsotonicRegression(out_of_bounds="clip").fit(pred_cal, y_log[cal_idx])
    pred_cal_iso = iso.transform(pred_cal)
    q_log = conformal_quantile(np.abs(y_log[cal_idx] - pred_cal_iso), args.alpha)

    pred_test = model.predict(x_all[test_idx], num_iteration=model.best_iteration)
    pred_test_iso = iso.transform(pred_test)
    metrics = regression_metrics(y_raw[test_idx], y_log[test_idx], pred_test, pred_test_iso, q_log, args.alpha)
    pred_test_iso_raw = inverse_log_days(pred_test_iso)
    metrics["tier_metrics"] = tier_metrics(df.iloc[test_idx], y_raw[test_idx], pred_test_iso_raw)

    model_path = WEIGHTS_DIR / f"fatecore-{args.version_tag}-review_days.txt"
    metrics_path = WEIGHTS_DIR / f"fatecore-{args.version_tag}-metrics.json"
    model.save_model(str(model_path))

    out = {
        "trained_at": datetime.utcnow().isoformat() + "Z",
        "version": args.version_tag,
        "features_path": str(features_path),
        "manifest_path": str(manifest_path),
        "model_path": str(model_path),
        "target": args.target,
        "target_transform": "log1p clipped review days",
        "seed": args.seed,
        "split": {
            "type": "random",
            "test_size": args.test_size,
            "cal_size_of_train": args.cal_size,
            "n_rows": int(len(df)),
            "n_train_model": int(len(model_idx)),
            "n_cal": int(len(cal_idx)),
            "n_test": int(len(test_idx)),
        },
        "n_features": len(feature_cols),
        "feature_cols": feature_cols,
        "forbidden_feature_count": len(forbidden),
        "forbidden_remaining": forbidden,
        "best_iteration": int(model.best_iteration),
        "iso_x": [float(x) for x in iso.X_thresholds_],
        "iso_y": [float(y) for y in iso.y_thresholds_],
        "top_features_gain": top_importance(model, feature_cols),
        **metrics,
    }
    metrics_path.write_text(json.dumps(out, indent=2), encoding="utf-8")

    print(f"Saved model: {model_path}")
    print(f"Saved metrics: {metrics_path}")
    print(
        f"MAE_days={metrics['mae_cal_days']:.1f} "
        f"R2_log={metrics['r2_log']:.3f} "
        f"coverage={metrics['conformal_coverage']:.3f}"
    )


if __name__ == "__main__":
    main()
