#!/usr/bin/env python
"""Train FateCore v0.3 LightGBM models from the v0.3 CSV.

Hard rule: random split only. Do not use year-based splits or year cutoffs.

Outputs:
  weights/fatecore-v0.3-y_jcr_jif.txt
  weights/fatecore-v0.3-y_icite_rcr.txt
  weights/fatecore-v0.3-y_citations_log.txt
  weights/fatecore-v0.3-metrics.json
"""
from __future__ import annotations

import argparse
import json
import math
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

TARGETS: dict[str, dict[str, Any]] = {
    "y_jcr_jif": {"log": True, "label": "JCR JIF"},
    "y_icite_rcr": {"log": True, "label": "iCite RCR"},
    "y_citations_log": {"log": False, "label": "log citations"},
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--features", default=str(FEATURES_DIR / "v0.3-features.csv"))
    p.add_argument("--manifest", default=str(FEATURES_DIR / "v0.3-features-manifest.json"))
    p.add_argument("--target", default="multi", choices=["multi", "jcr_jif", "icite_rcr", "citations_log"])
    p.add_argument("--test-size", type=float, default=0.2)
    p.add_argument("--cal-size", type=float, default=0.2, help="Calibration fraction inside the random train split.")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--num-rounds", type=int, default=3000)
    p.add_argument("--early-stopping", type=int, default=100)
    p.add_argument("--learning-rate", type=float, default=0.035)
    p.add_argument("--num-leaves", type=int, default=127)
    p.add_argument("--num-threads", type=int, default=8)
    p.add_argument("--version-tag", default="v0.3")
    p.add_argument("--sample-frac", type=float, default=1.0, help="Debug only. Keep at 1.0 for final training.")
    p.add_argument("--no-class-weight", action="store_true")
    p.add_argument("--alpha", type=float, default=0.1, help="Split conformal alpha.")
    return p.parse_args()


def load_manifest(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def target_names(arg: str) -> list[str]:
    if arg == "multi":
        return list(TARGETS)
    return [f"y_{arg}"]


def to_jsonable(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, np.ndarray):
        return [to_jsonable(v) for v in value.tolist()]
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_jsonable(v) for v in value]
    return value


def transform_y(y: np.ndarray, log: bool) -> np.ndarray:
    if log:
        return np.log1p(np.maximum(0.0, y))
    return y.astype(np.float64, copy=False)


def inverse_y(y_t: np.ndarray, log: bool) -> np.ndarray:
    if log:
        return np.maximum(0.0, np.expm1(y_t))
    return y_t.astype(np.float64, copy=False)


def inverse_freq_weights(y_t: np.ndarray) -> np.ndarray:
    finite = y_t[np.isfinite(y_t)]
    if finite.size < 100:
        return np.ones_like(y_t, dtype=np.float32)
    qs = np.unique(np.quantile(finite, [0.0, 0.25, 0.5, 0.75, 0.9, 0.99, 1.0]))
    if qs.size < 3:
        return np.ones_like(y_t, dtype=np.float32)
    bins = qs[1:-1]
    idx = np.digitize(y_t, bins, right=False)
    counts = np.bincount(idx, minlength=len(bins) + 1)
    weights = 1.0 / np.log(counts[idx] + math.e)
    weights = weights / np.mean(weights)
    return weights.astype(np.float32)


def conformal_quantile(abs_residuals: np.ndarray, alpha: float) -> float:
    residuals = np.asarray(abs_residuals, dtype=np.float64)
    residuals = residuals[np.isfinite(residuals)]
    if residuals.size == 0:
        return float("nan")
    q = min(1.0, math.ceil((residuals.size + 1) * (1.0 - alpha)) / residuals.size)
    return float(np.quantile(residuals, q, method="higher"))


def tier_metrics_jif(true_raw: np.ndarray, pred_cal_raw: np.ndarray) -> dict[str, Any]:
    tiers = [
        ("top_30_plus", 30.0, np.inf),
        ("high_10_30", 10.0, 30.0),
        ("mid_3_10", 3.0, 10.0),
        ("low_lt_3", 0.0, 3.0),
    ]
    out: dict[str, Any] = {}
    for name, lo, hi in tiers:
        mask = (true_raw >= lo) & (true_raw < hi)
        if int(mask.sum()) < 5:
            continue
        out[name] = {
            "n": int(mask.sum()),
            "mae_raw": float(mean_absolute_error(true_raw[mask], pred_cal_raw[mask])),
            "median_true": float(np.median(true_raw[mask])),
            "median_pred_cal": float(np.median(pred_cal_raw[mask])),
        }
    return out


def top_importance(model: lgb.Booster, feature_cols: list[str], n: int = 30) -> list[dict[str, Any]]:
    gain = model.feature_importance(importance_type="gain")
    split = model.feature_importance(importance_type="split")
    rows = []
    for col, g, s in zip(feature_cols, gain, split):
        rows.append({"feature": col, "gain": float(g), "split": int(s)})
    rows.sort(key=lambda r: r["gain"], reverse=True)
    return rows[:n]


def train_one_target(
    target: str,
    args: argparse.Namespace,
    df: pd.DataFrame,
    x_all: np.ndarray,
    feature_cols: list[str],
    train_idx: np.ndarray,
    test_idx: np.ndarray,
) -> dict[str, Any]:
    cfg = TARGETS[target]
    use_log = bool(cfg["log"])
    y = pd.to_numeric(df[target], errors="coerce").to_numpy(dtype=np.float64)

    train_target_idx = train_idx[np.isfinite(y[train_idx])]
    test_target_idx = test_idx[np.isfinite(y[test_idx])]
    if train_target_idx.size < 100 or test_target_idx.size < 100:
        return {"skipped": True, "reason": "not enough non-null target rows"}

    model_idx, cal_idx = train_test_split(
        train_target_idx,
        test_size=args.cal_size,
        random_state=args.seed + 17,
        shuffle=True,
    )

    y_model_raw = y[model_idx]
    y_cal_raw = y[cal_idx]
    y_test_raw = y[test_target_idx]
    y_model_t = transform_y(y_model_raw, use_log)
    y_cal_t = transform_y(y_cal_raw, use_log)
    y_test_t = transform_y(y_test_raw, use_log)

    weights = None if args.no_class_weight else inverse_freq_weights(y_model_t)

    train_ds = lgb.Dataset(x_all[model_idx], label=y_model_t, weight=weights, feature_name=feature_cols)
    cal_ds = lgb.Dataset(x_all[cal_idx], label=y_cal_t, reference=train_ds, feature_name=feature_cols)

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

    print(f"\n-- target={target} ({cfg['label']}) --")
    print(f"  train_model={len(model_idx):,} cal={len(cal_idx):,} test={len(test_target_idx):,} log={use_log}")
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

    pred_cal_t = model.predict(x_all[cal_idx], num_iteration=model.best_iteration)
    iso = IsotonicRegression(out_of_bounds="clip").fit(pred_cal_t, y_cal_t)
    pred_cal_iso_t = iso.transform(pred_cal_t)
    residuals = np.abs(y_cal_t - pred_cal_iso_t)
    q90_t = conformal_quantile(residuals, args.alpha)

    pred_test_t = model.predict(x_all[test_target_idx], num_iteration=model.best_iteration)
    pred_test_iso_t = iso.transform(pred_test_t)
    pred_test_raw = inverse_y(pred_test_t, use_log)
    pred_test_cal_raw = inverse_y(pred_test_iso_t, use_log)
    lower_raw = inverse_y(pred_test_iso_t - q90_t, use_log)
    upper_raw = inverse_y(pred_test_iso_t + q90_t, use_log)

    interval_coverage = float(np.mean((y_test_raw >= lower_raw) & (y_test_raw <= upper_raw)))

    metrics: dict[str, Any] = {
        "target": target,
        "label": cfg["label"],
        "log_scale": use_log,
        "n_train_model": int(len(model_idx)),
        "n_cal": int(len(cal_idx)),
        "n_test": int(len(test_target_idx)),
        "mae_transformed": float(mean_absolute_error(y_test_t, pred_test_t)),
        "mae_cal_transformed": float(mean_absolute_error(y_test_t, pred_test_iso_t)),
        "mae_raw": float(mean_absolute_error(y_test_raw, pred_test_raw)),
        "mae_cal_raw": float(mean_absolute_error(y_test_raw, pred_test_cal_raw)),
        "r2_log": float(r2_score(y_test_t, pred_test_t)),
        "r2_log_cal": float(r2_score(y_test_t, pred_test_iso_t)),
        "r2_raw": float(r2_score(y_test_raw, pred_test_raw)),
        "r2_raw_cal": float(r2_score(y_test_raw, pred_test_cal_raw)),
        "conformal_alpha": float(args.alpha),
        "conformal_q90_transformed": q90_t,
        "conformal_coverage_test": interval_coverage,
        "interval_width_median_raw": float(np.median(upper_raw - lower_raw)),
        "best_iteration": int(model.best_iteration),
        "class_weighted": not args.no_class_weight,
        "iso_x": [float(x) for x in iso.X_thresholds_],
        "iso_y": [float(x) for x in iso.y_thresholds_],
        "top_features_gain": top_importance(model, feature_cols, 30),
    }

    if target == "y_jcr_jif":
        metrics["tier_metrics"] = tier_metrics_jif(y_test_raw, pred_test_cal_raw)

    model_path = WEIGHTS_DIR / f"fatecore-{args.version_tag}-{target}.txt"
    model.save_model(str(model_path))
    metrics["model_path"] = str(model_path)

    print(
        "  metrics: "
        f"MAE_t={metrics['mae_cal_transformed']:.4f} "
        f"MAE_raw={metrics['mae_cal_raw']:.4f} "
        f"R2_log={metrics['r2_log']:.4f} "
        f"R2_raw_cal={metrics['r2_raw_cal']:.4f} "
        f"coverage={metrics['conformal_coverage_test']:.3f}"
    )
    return metrics


def main() -> None:
    args = parse_args()
    features_path = Path(args.features)
    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    feature_cols = list(manifest.get("feature_cols") or [])
    label_cols = list(manifest.get("label_cols") or TARGETS.keys())
    if not feature_cols:
        header = pd.read_csv(features_path, nrows=0).columns.tolist()
        feature_cols = [c for c in header if c not in ["doi", "pmid", *TARGETS.keys()]]

    selected_targets = target_names(args.target)
    usecols = ["doi", "pmid", *feature_cols, *selected_targets]
    print("FateCore v0.3 training")
    print(f"  features: {features_path}")
    print(f"  manifest: {manifest_path}")
    print(f"  targets:  {', '.join(selected_targets)}")
    print("  split:    RANDOM only, 80/20 train/test")

    df = pd.read_csv(features_path, usecols=usecols, low_memory=False)
    if args.sample_frac < 1.0:
        df = df.sample(frac=args.sample_frac, random_state=args.seed).reset_index(drop=True)
        print(f"  debug sample_frac={args.sample_frac}: rows={len(df):,}")
    else:
        print(f"  rows: {len(df):,}")

    x_df = df[feature_cols].apply(pd.to_numeric, errors="coerce").astype(np.float32)
    x_all = x_df.to_numpy(dtype=np.float32, copy=True)
    n_rows, n_features = x_all.shape
    print(f"  feature matrix: {n_rows:,} rows x {n_features:,} features")

    all_idx = np.arange(n_rows)
    train_idx, test_idx = train_test_split(
        all_idx,
        test_size=args.test_size,
        random_state=args.seed,
        shuffle=True,
    )
    print(f"  random train/test: train={len(train_idx):,} test={len(test_idx):,}")

    metrics: dict[str, Any] = {
        "trained_at": datetime.utcnow().isoformat(),
        "version": args.version_tag,
        "features_path": str(features_path),
        "manifest_path": str(manifest_path),
        "split_policy": "random_80_20_only_no_year_split",
        "test_size": args.test_size,
        "cal_size_within_train": args.cal_size,
        "seed": args.seed,
        "n_rows": int(n_rows),
        "n_features": int(n_features),
        "feature_cols": feature_cols,
        "label_cols": label_cols,
        "lightgbm": {
            "num_rounds": args.num_rounds,
            "early_stopping": args.early_stopping,
            "learning_rate": args.learning_rate,
            "num_leaves": args.num_leaves,
            "num_threads": args.num_threads,
        },
        "baseline": {
            "v0.2_prod_r2_jcr_jif": 0.435,
            "deploy_threshold_r2_jcr_jif": 0.50,
        },
    }

    for target in selected_targets:
        metrics[target] = train_one_target(target, args, df, x_all, feature_cols, train_idx, test_idx)

    out_path = WEIGHTS_DIR / f"fatecore-{args.version_tag}-metrics.json"
    out_path.write_text(json.dumps(to_jsonable(metrics), indent=2), encoding="utf-8")
    print(f"\nSaved metrics: {out_path}")
    print("Summary:")
    for target in selected_targets:
        m = metrics[target]
        if m.get("skipped"):
            print(f"  {target}: skipped")
            continue
        print(
            f"  {target}: R2_log={m['r2_log']:.4f} "
            f"R2_raw_cal={m['r2_raw_cal']:.4f} "
            f"MAE_raw_cal={m['mae_cal_raw']:.4f} "
            f"n_test={m['n_test']:,}"
        )


if __name__ == "__main__":
    main()
