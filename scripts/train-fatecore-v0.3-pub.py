#!/usr/bin/env python
"""Train FateCore v0.3-pub NaN-safe target-journal-aware models.

Hard rules:
  - random split only
  - no post-publication features
  - j_hist_* features are prior-year target-journal features
  - randomly mask j_hist_* on train/cal rows so one model handles target present
    and target absent inputs
"""
from __future__ import annotations

import argparse
import importlib.util
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

BASE_PATH = ROOT / "scripts" / "train-fatecore-v0.3.py"
SPEC = importlib.util.spec_from_file_location("train_fatecore_v03_base", BASE_PATH)
BASE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(BASE)

TARGETS: dict[str, dict[str, Any]] = BASE.TARGETS
J_HIST_COLS = [
    "j_hist_metric_age",
    "j_hist_jcr_jif",
    "j_hist_jcr_jif_5yr",
    "j_hist_jci",
    "j_hist_article_influence",
    "j_hist_eigenfactor",
]
TARGET_SEED_OFFSETS = {
    "y_jcr_jif": 101,
    "y_icite_rcr": 202,
    "y_citations_log": 303,
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--features", default=str(FEATURES_DIR / "v0.3-pub-features.csv"))
    p.add_argument("--manifest", default=str(FEATURES_DIR / "v0.3-pub-features-manifest.json"))
    p.add_argument("--target", default="multi", choices=["multi", "jcr_jif", "icite_rcr", "citations_log"])
    p.add_argument("--test-size", type=float, default=0.2)
    p.add_argument("--cal-size", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--num-rounds", type=int, default=3000)
    p.add_argument("--early-stopping", type=int, default=100)
    p.add_argument("--learning-rate", type=float, default=0.035)
    p.add_argument("--num-leaves", type=int, default=127)
    p.add_argument("--num-threads", type=int, default=8)
    p.add_argument("--version-tag", default="v0.3-pub")
    p.add_argument("--sample-frac", type=float, default=1.0)
    p.add_argument("--no-class-weight", action="store_true")
    p.add_argument("--alpha", type=float, default=0.1)
    p.add_argument("--jhist-mask-frac", type=float, default=0.30)
    return p.parse_args()


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def target_names(arg: str) -> list[str]:
    if arg == "multi":
        return list(TARGETS)
    return [f"y_{arg}"]


def mask_j_hist(
    x: np.ndarray,
    feature_cols: list[str],
    rng: np.random.Generator,
    frac: float,
    cols: list[str] = J_HIST_COLS,
) -> tuple[np.ndarray, int, list[str]]:
    idx = [feature_cols.index(c) for c in cols if c in feature_cols]
    if not idx or frac <= 0:
        return x.copy(), 0, [feature_cols[i] for i in idx]
    out = x.copy()
    mask = rng.random(out.shape[0]) < frac
    if int(mask.sum()) > 0:
        out[np.ix_(mask, idx)] = np.nan
    return out, int(mask.sum()), [feature_cols[i] for i in idx]


def cold_start_x(x: np.ndarray, feature_cols: list[str]) -> np.ndarray:
    out = x.copy()
    for col in J_HIST_COLS:
        if col in feature_cols:
            out[:, feature_cols.index(col)] = np.nan
    return out


def eval_scenario(
    model: lgb.Booster,
    iso: IsotonicRegression,
    target: str,
    x_eval: np.ndarray,
    y_raw: np.ndarray,
    y_t: np.ndarray,
    q90_t: float,
    alpha: float,
) -> dict[str, Any]:
    use_log = bool(TARGETS[target]["log"])
    pred_t = model.predict(x_eval, num_iteration=model.best_iteration)
    pred_iso_t = iso.transform(pred_t)
    pred_raw = BASE.inverse_y(pred_t, use_log)
    pred_cal_raw = BASE.inverse_y(pred_iso_t, use_log)
    lower_raw = BASE.inverse_y(pred_iso_t - q90_t, use_log)
    upper_raw = BASE.inverse_y(pred_iso_t + q90_t, use_log)
    out: dict[str, Any] = {
        "mae_transformed": float(mean_absolute_error(y_t, pred_t)),
        "mae_cal_transformed": float(mean_absolute_error(y_t, pred_iso_t)),
        "mae_raw": float(mean_absolute_error(y_raw, pred_raw)),
        "mae_cal_raw": float(mean_absolute_error(y_raw, pred_cal_raw)),
        "r2_log": float(r2_score(y_t, pred_t)),
        "r2_log_cal": float(r2_score(y_t, pred_iso_t)),
        "r2_raw": float(r2_score(y_raw, pred_raw)),
        "r2_raw_cal": float(r2_score(y_raw, pred_cal_raw)),
        "conformal_alpha": float(alpha),
        "conformal_coverage_test": float(np.mean((y_raw >= lower_raw) & (y_raw <= upper_raw))),
        "interval_width_median_raw": float(np.median(upper_raw - lower_raw)),
    }
    if target == "y_jcr_jif":
        out["tier_metrics"] = BASE.tier_metrics_jif(y_raw, pred_cal_raw)
    return out


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
    y_model_t = BASE.transform_y(y_model_raw, use_log)
    y_cal_t = BASE.transform_y(y_cal_raw, use_log)
    y_test_t = BASE.transform_y(y_test_raw, use_log)

    rng = np.random.default_rng(args.seed + TARGET_SEED_OFFSETS.get(target, 999))
    x_model_masked, n_model_masked, masked_cols = mask_j_hist(x_all[model_idx], feature_cols, rng, args.jhist_mask_frac)
    x_cal_masked, n_cal_masked, _ = mask_j_hist(x_all[cal_idx], feature_cols, rng, args.jhist_mask_frac)

    weights = None if args.no_class_weight else BASE.inverse_freq_weights(y_model_t)
    train_ds = lgb.Dataset(x_model_masked, label=y_model_t, weight=weights, feature_name=feature_cols)
    cal_ds = lgb.Dataset(x_cal_masked, label=y_cal_t, reference=train_ds, feature_name=feature_cols)

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
    print(f"  j_hist mask: train={n_model_masked:,}/{len(model_idx):,} cal={n_cal_masked:,}/{len(cal_idx):,} cols={masked_cols}")
    model = lgb.train(
        params,
        train_ds,
        num_boost_round=args.num_rounds,
        valid_sets=[cal_ds],
        valid_names=["cal_masked_mixture"],
        callbacks=[
            lgb.early_stopping(args.early_stopping),
            lgb.log_evaluation(period=50),
        ],
    )

    pred_cal_t = model.predict(x_cal_masked, num_iteration=model.best_iteration)
    iso = IsotonicRegression(out_of_bounds="clip").fit(pred_cal_t, y_cal_t)
    pred_cal_iso_t = iso.transform(pred_cal_t)
    q90_t = BASE.conformal_quantile(np.abs(y_cal_t - pred_cal_iso_t), args.alpha)

    x_test_with = x_all[test_target_idx]
    x_test_cold = cold_start_x(x_test_with, feature_cols)
    scenarios = {
        "with_target": eval_scenario(model, iso, target, x_test_with, y_test_raw, y_test_t, q90_t, args.alpha),
        "cold_start": eval_scenario(model, iso, target, x_test_cold, y_test_raw, y_test_t, q90_t, args.alpha),
    }

    metrics: dict[str, Any] = {
        "target": target,
        "label": cfg["label"],
        "log_scale": use_log,
        "n_train_model": int(len(model_idx)),
        "n_cal": int(len(cal_idx)),
        "n_test": int(len(test_target_idx)),
        "j_hist_mask_fraction": float(args.jhist_mask_frac),
        "j_hist_masked_cols": masked_cols,
        "n_train_j_hist_masked": int(n_model_masked),
        "n_cal_j_hist_masked": int(n_cal_masked),
        "conformal_q90_transformed": q90_t,
        "best_iteration": int(model.best_iteration),
        "class_weighted": not args.no_class_weight,
        "iso_x": [float(x) for x in iso.X_thresholds_],
        "iso_y": [float(x) for x in iso.y_thresholds_],
        "top_features_gain": BASE.top_importance(model, feature_cols, 30),
        "scenario_metrics": scenarios,
    }
    metrics.update(scenarios["with_target"])
    if target == "y_jcr_jif":
        metrics["tier_metrics"] = scenarios["with_target"].get("tier_metrics", {})

    model_path = WEIGHTS_DIR / f"fatecore-{args.version_tag}-{target}.txt"
    model.save_model(str(model_path))
    metrics["model_path"] = str(model_path)

    print(
        "  with_target: "
        f"R2_log={scenarios['with_target']['r2_log']:.4f} "
        f"MAE_raw={scenarios['with_target']['mae_cal_raw']:.4f} "
        f"R2_raw_cal={scenarios['with_target']['r2_raw_cal']:.4f}"
    )
    print(
        "  cold_start:  "
        f"R2_log={scenarios['cold_start']['r2_log']:.4f} "
        f"MAE_raw={scenarios['cold_start']['mae_cal_raw']:.4f} "
        f"R2_raw_cal={scenarios['cold_start']['r2_raw_cal']:.4f}"
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
    print("FateCore v0.3-pub training")
    print(f"  features: {features_path}")
    print(f"  manifest: {manifest_path}")
    print(f"  targets:  {', '.join(selected_targets)}")
    print("  split:    RANDOM only, 80/20 train/test")
    print(f"  j_hist mask fraction: {args.jhist_mask_frac:.2f}")

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
        "target_journal_feature_cols": [c for c in J_HIST_COLS if c in feature_cols],
        "j_hist_mask_fraction": float(args.jhist_mask_frac),
        "pre_submission_only": True,
        "target_journal_optional": True,
        "lightgbm": {
            "num_rounds": args.num_rounds,
            "early_stopping": args.early_stopping,
            "learning_rate": args.learning_rate,
            "num_leaves": args.num_leaves,
            "num_threads": args.num_threads,
        },
        "baseline": {
            "v0.2_prod_r2_jcr_jif": 0.435,
            "v0.3_prepub_r2_jcr_jif": 0.4610,
            "deploy_threshold_with_target_r2_jcr_jif": 0.55,
            "deploy_threshold_cold_start_r2_jcr_jif": 0.45,
            "suspicious_high_r2_jcr_jif": 0.85,
        },
    }

    for target in selected_targets:
        metrics[target] = train_one_target(target, args, df, x_all, feature_cols, train_idx, test_idx)

    out_path = WEIGHTS_DIR / f"fatecore-{args.version_tag}-metrics.json"
    out_path.write_text(json.dumps(BASE.to_jsonable(metrics), indent=2), encoding="utf-8")
    print(f"\nSaved metrics: {out_path}")
    print("Summary:")
    for target in selected_targets:
        m = metrics[target]
        if m.get("skipped"):
            print(f"  {target}: skipped")
            continue
        wt = m["scenario_metrics"]["with_target"]
        cs = m["scenario_metrics"]["cold_start"]
        print(
            f"  {target}: with_target R2_log={wt['r2_log']:.4f} "
            f"cold_start R2_log={cs['r2_log']:.4f} "
            f"n_test={m['n_test']:,}"
        )


if __name__ == "__main__":
    main()
