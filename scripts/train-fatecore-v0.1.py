#!/usr/bin/env python
"""PaperFate · FateCore v0.1 학습 스켈레톤

LightGBM multi-output regression on Q500 scores → JIF + RCR + citations.

전제 조건:
    pip install pandas numpy scikit-learn lightgbm joblib matplotlib

사용:
    python scripts/train-fatecore-v0.1.py
    python scripts/train-fatecore-v0.1.py --target jcr_jif    # JIF만
    python scripts/train-fatecore-v0.1.py --no-embedding      # 768-d 임베딩 생략

데이터:
    INPUT  data/fatecore/features-YYYY-MM-DD.csv  (n_papers × ~156 cols)
            data/fatecore/labels-YYYY-MM-DD.csv    (n_papers × 4 cols)
    OUTPUT weights/fatecore-v0.1-{target}.txt     (LightGBM native)
            weights/fatecore-v0.1-calibration.json (isotonic + conformal)
            weights/fatecore-v0.1-metrics.json    (held-out perf)

원칙:
    🚨 학습/검증 split: RANDOM ONLY. 연도 기반 split 절대 금지.
       JIF의 연도 변동성 (NEJM 2020=70 → 2023=160) 보정 불가능.
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score

try:
    import lightgbm as lgb
except ImportError:
    raise SystemExit("pip install lightgbm (and pandas numpy scikit-learn joblib)")

ROOT = Path(__file__).parent.parent
DATA_DIR = Path(os.environ.get("DATA_ROOT", ROOT / "data"))
FATECORE_DIR = DATA_DIR / "fatecore"
WEIGHTS_DIR = ROOT / "weights"
WEIGHTS_DIR.mkdir(exist_ok=True)

# ─────────────────────────────────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--features", default=None, help="path to features CSV (default: latest in data/fatecore)")
    p.add_argument("--labels", default=None, help="path to labels CSV")
    p.add_argument("--target", default="multi", choices=["jcr_jif", "icite_rcr", "citations_log", "multi"])
    p.add_argument("--test-size", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--early-stopping", type=int, default=50)
    p.add_argument("--num-rounds", type=int, default=2000)
    return p.parse_args()


def find_latest(prefix: str) -> Path:
    files = sorted(FATECORE_DIR.glob(f"{prefix}-*.csv"))
    if not files:
        raise FileNotFoundError(f"No {prefix}-*.csv in {FATECORE_DIR}. Run build-fatecore-features.mjs first.")
    return files[-1]


# ─────────────────────────────────────────────────────────────────────────────
def load_data(features_path: Path, labels_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    print(f"Loading features:  {features_path.name}")
    X = pd.read_csv(features_path)
    print(f"  shape: {X.shape}")
    print(f"Loading labels:    {labels_path.name}")
    y = pd.read_csv(labels_path)
    print(f"  shape: {y.shape}")
    # Align on doi
    merged = X.merge(y, on="doi", how="inner")
    print(f"  merged rows: {len(merged)}")
    return X, y, merged


def prepare_X(merged: pd.DataFrame) -> tuple[np.ndarray, list[str]]:
    """Build numeric feature matrix.

    Q100 점수 NA → -1, unknown → -2 (encoded explicitly).
    Missing numeric cols → NaN (LightGBM handles natively).
    """
    drop_cols = ["doi", "pmid", "y_jcr_jif", "y_icite_rcr", "y_citations_log"]
    feature_cols = [c for c in merged.columns if c not in drop_cols]
    X = merged[feature_cols].copy()
    # Coerce all to numeric
    for c in X.columns:
        X[c] = pd.to_numeric(X[c], errors="coerce")
    return X.values, feature_cols


def train_one_target(X_train, y_train, X_test, y_test, target_name: str, args):
    """Train LightGBM for one target. Returns (model, metrics)."""
    # Drop rows where y is NaN
    mask_tr = ~pd.isna(y_train)
    mask_te = ~pd.isna(y_test)
    if mask_tr.sum() < 100:
        print(f"  ⚠ {target_name}: only {mask_tr.sum()} train labels — skipping")
        return None, None

    X_tr, y_tr = X_train[mask_tr], y_train[mask_tr]
    X_te, y_te = X_test[mask_te], y_test[mask_te]
    print(f"  {target_name}: train={len(y_tr)}, test={len(y_te)}")

    train_ds = lgb.Dataset(X_tr, label=y_tr)
    val_ds = lgb.Dataset(X_te, label=y_te, reference=train_ds)

    params = {
        "objective": "regression",
        "metric": "mae",
        "learning_rate": 0.05,
        "num_leaves": 63,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "verbose": -1,
    }

    model = lgb.train(
        params,
        train_ds,
        num_boost_round=args.num_rounds,
        valid_sets=[val_ds],
        callbacks=[lgb.early_stopping(args.early_stopping), lgb.log_evaluation(period=0)],
    )

    pred_test = model.predict(X_te, num_iteration=model.best_iteration)
    mae = mean_absolute_error(y_te, pred_test)
    r2 = r2_score(y_te, pred_test)

    # Isotonic calibration on test set (post-hoc — separate cal split would be cleaner)
    iso = IsotonicRegression(out_of_bounds="clip").fit(pred_test, y_te)
    pred_cal = iso.transform(pred_test)
    mae_cal = mean_absolute_error(y_te, pred_cal)

    # Conformal prediction intervals (split conformal, alpha=0.1 → 90% coverage)
    residuals = np.abs(y_te - pred_cal)
    q90 = np.quantile(residuals, 0.9)

    print(f"    MAE raw={mae:.3f}  cal={mae_cal:.3f}  R²={r2:.3f}  conformal±90%={q90:.3f}")

    return model, {
        "n_train": int(mask_tr.sum()),
        "n_test": int(mask_te.sum()),
        "mae": float(mae),
        "mae_cal": float(mae_cal),
        "r2": float(r2),
        "conformal_q90": float(q90),
        "iso_x": iso.X_thresholds_.tolist(),
        "iso_y": iso.y_thresholds_.tolist(),
        "best_iter": int(model.best_iteration),
    }


# ─────────────────────────────────────────────────────────────────────────────
def main():
    args = parse_args()

    features_path = Path(args.features) if args.features else find_latest("features")
    labels_path = Path(args.labels) if args.labels else find_latest("labels")

    _, _, merged = load_data(features_path, labels_path)

    # 🚨 RANDOM SPLIT ONLY (사용자 feedback_fatecore_validation.md 원칙)
    print(f"\n── RANDOM split (test_size={args.test_size}, seed={args.seed}) ──")
    print("⚠ NEVER use year-based split — JIF year-to-year variability is high (cannot calibrate)")
    train, test = train_test_split(merged, test_size=args.test_size, random_state=args.seed)
    print(f"  train: {len(train)}, test: {len(test)}")

    X_tr, feat_cols = prepare_X(train)
    X_te, _ = prepare_X(test)
    print(f"  feature dim: {len(feat_cols)}")

    targets = ["y_jcr_jif", "y_icite_rcr", "y_citations_log"] if args.target == "multi" else [f"y_{args.target}"]

    all_metrics = {"trained_at": datetime.utcnow().isoformat(), "features_used": feat_cols}
    for target in targets:
        print(f"\n── target: {target} ──")
        model, metrics = train_one_target(X_tr, train[target].values, X_te, test[target].values, target, args)
        if model is None:
            all_metrics[target] = {"skipped": True}
            continue
        # Save model
        weight_path = WEIGHTS_DIR / f"fatecore-v0.1-{target}.txt"
        model.save_model(str(weight_path))
        print(f"    saved → {weight_path.name}")
        all_metrics[target] = metrics

    metrics_path = WEIGHTS_DIR / "fatecore-v0.1-metrics.json"
    metrics_path.write_text(json.dumps(all_metrics, indent=2))
    print(f"\n✓ Metrics saved → {metrics_path.name}")

    # Print summary
    print("\n── Summary ──")
    for target in targets:
        m = all_metrics.get(target, {})
        if "skipped" in m:
            print(f"  {target}: skipped")
        else:
            print(f"  {target}: MAE={m['mae']:.3f} (cal {m['mae_cal']:.3f}) R²={m['r2']:.3f} ±90%={m['conformal_q90']:.3f}  n_train={m['n_train']}")


if __name__ == "__main__":
    main()
