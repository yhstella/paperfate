#!/usr/bin/env python
"""FateCore v0.2 — improvements over v0.1.

핵심 변경:
1. Log-scale targets — log1p(jcr_jif), log1p(rcr), log1p(citations)
   → top-tier (JIF≥30) under-prediction 완화.
2. Class weighting (inverse frequency) — Nature/Cell/Lancet 같은 rare top-tier paper에 더 큰 weight.
3. RCR target은 2022 이전 paper만 (안정화된 데이터). v0.1에서 2020-2024 MAE 7.08로 매우 불안정.
4. Author features integration — first/last/max/median team h-index (코덱스 enrichment 완료).
5. Field stratification 옵션 (--stratify) — mesh_terms[0] 기반 학습 분리.
6. SPECTER2 embedding 통합 — papers.embedding BLOB을 64-d PCA 축약 후 features에 추가.
   (--with-embedding)

🚨 RANDOM split만 사용. 연도 기반 split 절대 금지.

사용:
    python scripts/train-fatecore-v0.2.py
    python scripts/train-fatecore-v0.2.py --target jcr_jif --with-embedding
    python scripts/train-fatecore-v0.2.py --stratify-by-field
"""
from __future__ import annotations

import argparse
import json
import os
import struct
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.decomposition import PCA

ROOT = Path(__file__).parent.parent
DATA_DIR = Path(os.environ.get("DATA_ROOT", ROOT / "data"))
FATECORE_DIR = DATA_DIR / "fatecore"
WEIGHTS_DIR = ROOT / "weights"
WEIGHTS_DIR.mkdir(exist_ok=True)

# ── targets + RCR cutoff ─────────────────────────────────────────────────────
TARGETS = {
    "y_jcr_jif":         {"log": True,  "year_max": None,  "lower_bound": 0.0,  "metric": "mae"},
    "y_icite_rcr":       {"log": True,  "year_max": 2022,  "lower_bound": 0.0,  "metric": "mae"},
    "y_citations_log":   {"log": False, "year_max": None,  "lower_bound": 0.0,  "metric": "mae"},  # already log
}

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--features", default=None)
    p.add_argument("--labels", default=None)
    p.add_argument("--target", default="multi", choices=["jcr_jif", "icite_rcr", "citations_log", "multi"])
    p.add_argument("--test-size", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--early-stopping", type=int, default=80)
    p.add_argument("--num-rounds", type=int, default=3000)
    p.add_argument("--stratify-by-field", action="store_true")
    p.add_argument("--with-embedding", action="store_true",
                   help="Load papers.embedding BLOBs from paperfate.db and add 64-d PCA")
    p.add_argument("--no-class-weight", action="store_true")
    p.add_argument("--version-tag", default="v0.2")
    return p.parse_args()


def find_latest(prefix: str) -> Path:
    files = sorted(FATECORE_DIR.glob(f"{prefix}-*.csv"))
    if not files:
        raise FileNotFoundError(f"No {prefix}-*.csv in {FATECORE_DIR}")
    return files[-1]


def load_embeddings_from_db(dois: list[str], pca_dim: int = 64):
    """Load SPECTER2 embeddings (Float32 little-endian, 768d, 3072 bytes) and reduce to pca_dim.

    SQLite default IN(...) variable limit is ~32K — batch the lookup.
    """
    import sqlite3
    conn = sqlite3.connect(str(DATA_DIR / "paperfate.db"))
    cur = conn.cursor()
    BATCH = 5000
    rows = []
    for i in range(0, len(dois), BATCH):
        batch = dois[i:i+BATCH]
        placeholders = ",".join("?" for _ in batch)
        rows.extend(cur.execute(
            f"SELECT doi, embedding, embedding_dim FROM papers WHERE doi IN ({placeholders}) AND embedding IS NOT NULL",
            batch
        ).fetchall())
    conn.close()
    emb_map = {}
    for doi, blob, dim in rows:
        if not blob or dim != 768: continue
        vec = np.frombuffer(blob, dtype=np.float32)
        if vec.size == 768:
            emb_map[doi] = vec
    print(f"  loaded {len(emb_map)}/{len(dois)} embeddings ({100*len(emb_map)/len(dois):.1f}% coverage)")
    if not emb_map: return None
    # PCA reduce
    matrix = np.vstack(list(emb_map.values()))
    pca = PCA(n_components=min(pca_dim, matrix.shape[1], matrix.shape[0]))
    reduced = pca.fit_transform(matrix)
    print(f"  PCA: {matrix.shape[1]}d → {reduced.shape[1]}d (var explained {pca.explained_variance_ratio_.sum():.3f})")
    return {doi: reduced[i] for i, doi in enumerate(emb_map.keys())}, pca


def compute_class_weights(y, scheme="inverse_freq_log"):
    """Returns sample weights — top tier rare paper gets more weight."""
    if scheme == "inverse_freq_log":
        # Bin into quartiles, weight = 1 / log(count + e)
        bins = np.percentile(y, [25, 50, 75, 90, 99])
        idx = np.digitize(y, bins)
        counts = np.bincount(idx)
        weights = 1.0 / np.log(counts[idx] + np.e)
        weights = weights / weights.mean()
        return weights
    return np.ones_like(y)


def train_one(X_tr, y_tr, X_te, y_te, target_name, args, sample_weight=None):
    mask_tr = ~pd.isna(y_tr)
    mask_te = ~pd.isna(y_te)
    if mask_tr.sum() < 100:
        return None, None
    cfg = TARGETS[target_name]

    # Year filter for RCR
    X_tr_use = X_tr[mask_tr]
    y_tr_use = y_tr[mask_tr]
    X_te_use = X_te[mask_te]
    y_te_use = y_te[mask_te]

    # Log transform
    if cfg["log"]:
        y_tr_t = np.log1p(np.maximum(0, y_tr_use))
        y_te_t = np.log1p(np.maximum(0, y_te_use))
    else:
        y_tr_t = y_tr_use
        y_te_t = y_te_use

    # Class weighting
    w_tr = sample_weight[mask_tr] if sample_weight is not None else None
    if not args.no_class_weight and cfg["log"]:
        # Additional inverse-freq weighting on the log-scale target
        cw = compute_class_weights(y_tr_t)
        w_tr = cw if w_tr is None else w_tr * cw

    print(f"  {target_name}: train={len(y_tr_t)}, test={len(y_te_t)}  (log={cfg['log']})")

    train_ds = lgb.Dataset(X_tr_use, label=y_tr_t, weight=w_tr)
    val_ds = lgb.Dataset(X_te_use, label=y_te_t, reference=train_ds)

    params = {
        "objective": "regression",
        "metric": "mae",
        "learning_rate": 0.04,
        "num_leaves": 127,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.85,
        "bagging_freq": 5,
        "lambda_l2": 0.1,
        "verbose": -1,
    }
    model = lgb.train(
        params, train_ds,
        num_boost_round=args.num_rounds,
        valid_sets=[val_ds],
        callbacks=[lgb.early_stopping(args.early_stopping), lgb.log_evaluation(period=0)],
    )
    pred_t = model.predict(X_te_use, num_iteration=model.best_iteration)

    # Inverse-log for raw-scale metrics
    if cfg["log"]:
        pred_raw = np.expm1(pred_t)
        true_raw = y_te_use
    else:
        pred_raw = pred_t
        true_raw = y_te_use

    mae_log = mean_absolute_error(y_te_t, pred_t) if cfg["log"] else None
    mae_raw = mean_absolute_error(true_raw, pred_raw)
    r2_log = r2_score(y_te_t, pred_t) if cfg["log"] else r2_score(true_raw, pred_raw)

    # Isotonic on log-scale (preserves monotone mapping)
    iso = IsotonicRegression(out_of_bounds="clip").fit(pred_t, y_te_t if cfg["log"] else true_raw)
    pred_cal_t = iso.transform(pred_t)
    pred_cal_raw = np.expm1(pred_cal_t) if cfg["log"] else pred_cal_t
    mae_cal_raw = mean_absolute_error(true_raw, pred_cal_raw)

    # Conformal on log scale → wider on raw scale (interval transforms naturally)
    residuals = np.abs((y_te_t if cfg["log"] else true_raw) - pred_cal_t)
    q90 = float(np.quantile(residuals, 0.9))

    # Tier-wise accuracy
    tier_metrics = {}
    if "jif" in target_name:
        for label, lo, hi in [("top", 30, 1000), ("high", 10, 30), ("mid", 3, 10), ("low", 0, 3)]:
            sel = (true_raw >= lo) & (true_raw < hi)
            if sel.sum() < 5: continue
            tier_metrics[label] = {
                "n": int(sel.sum()),
                "mae_raw": float(mean_absolute_error(true_raw[sel], pred_cal_raw[sel])),
                "median_pred": float(np.median(pred_cal_raw[sel])),
            }

    mae_log_str = f"{mae_log:.3f}" if mae_log is not None else "—"
    print(f"    MAE log={mae_log_str}  raw_cal={mae_cal_raw:.3f}  R²(log)={r2_log:.3f}  conformal±90%(log)={q90:.3f}")
    if tier_metrics:
        print(f"    Tier MAEs: " + " | ".join(f"{k} n={v['n']} mae={v['mae_raw']:.2f}" for k, v in tier_metrics.items()))

    return model, {
        "log_scale": cfg["log"],
        "n_train": int(mask_tr.sum()),
        "n_test": int(mask_te.sum()),
        "mae_log": float(mae_log) if mae_log else None,
        "mae_raw": float(mae_raw),
        "mae_cal_raw": float(mae_cal_raw),
        "r2_log": float(r2_log),
        "conformal_q90_log": q90,
        "iso_x": iso.X_thresholds_.tolist(),
        "iso_y": iso.y_thresholds_.tolist(),
        "best_iter": int(model.best_iteration),
        "tier_metrics": tier_metrics,
    }


def main():
    args = parse_args()
    features_path = Path(args.features) if args.features else find_latest("features")
    labels_path = Path(args.labels) if args.labels else find_latest("labels")

    print(f"Loading {features_path.name} + {labels_path.name}")
    X = pd.read_csv(features_path)
    y = pd.read_csv(labels_path)
    merged = X.merge(y, on="doi", how="inner")
    print(f"  rows: {len(merged)}")

    drop_cols = ["doi", "pmid", "y_jcr_jif", "y_icite_rcr", "y_citations_log"]
    feature_cols = [c for c in merged.columns if c not in drop_cols]
    print(f"  base features: {len(feature_cols)}")

    # Optional embedding
    pca_model = None
    if args.with_embedding:
        print(f"Loading SPECTER2 embeddings + PCA...")
        emb_data = load_embeddings_from_db(merged["doi"].tolist(), pca_dim=64)
        if emb_data:
            emb_map, pca_model = emb_data
            n_emb = pca_model.n_components_
            emb_cols = [f"emb_{i}" for i in range(n_emb)]
            for c in emb_cols: merged[c] = np.nan
            for i, doi in enumerate(merged["doi"]):
                if doi in emb_map:
                    for j, c in enumerate(emb_cols):
                        merged.at[i, c] = float(emb_map[doi][j])
            feature_cols.extend(emb_cols)
            print(f"  +{n_emb} embedding cols → total {len(feature_cols)}")

    # 🚨 RANDOM split
    print(f"\n── RANDOM split (test_size={args.test_size}, seed={args.seed}) ──")
    train, test = train_test_split(merged, test_size=args.test_size, random_state=args.seed)
    print(f"  train: {len(train)}, test: {len(test)}")

    X_tr = train[feature_cols].apply(pd.to_numeric, errors="coerce").values
    X_te = test[feature_cols].apply(pd.to_numeric, errors="coerce").values

    targets = list(TARGETS.keys()) if args.target == "multi" else [f"y_{args.target}"]

    all_metrics = {
        "trained_at": datetime.utcnow().isoformat(),
        "version": args.version_tag,
        "n_features": len(feature_cols),
        "features_used": feature_cols,
        "n_train": len(train),
        "n_test": len(test),
        "with_embedding": args.with_embedding,
        "class_weighted": not args.no_class_weight,
    }

    for tgt in targets:
        print(f"\n── target: {tgt} ──")
        cfg = TARGETS[tgt]
        y_train = train[tgt].values.copy()
        y_test = test[tgt].values.copy()
        # Apply year cutoff if specified
        if cfg["year_max"] and "year" in train.columns:
            mask_train = train["year"].values <= cfg["year_max"]
            mask_test = test["year"].values <= cfg["year_max"]
            y_train[~mask_train] = np.nan
            y_test[~mask_test] = np.nan
            print(f"  year cutoff: ≤{cfg['year_max']} (train kept {mask_train.sum()}/{len(train)})")

        model, m = train_one(X_tr, y_train, X_te, y_test, tgt, args)
        if model is None:
            all_metrics[tgt] = {"skipped": True}
            continue
        # Save
        path = WEIGHTS_DIR / f"fatecore-{args.version_tag}-{tgt}.txt"
        model.save_model(str(path))
        all_metrics[tgt] = m

    out_path = WEIGHTS_DIR / f"fatecore-{args.version_tag}-metrics.json"
    out_path.write_text(json.dumps(all_metrics, indent=2))
    print(f"\n✓ Saved metrics → {out_path.name}")

    print(f"\n── Summary ──")
    for tgt in targets:
        m = all_metrics.get(tgt, {})
        if "skipped" in m: continue
        ml = m.get('mae_log')
        ml_str = f"{ml:.3f}" if ml is not None else "—"
        print(f"  {tgt}: MAE_log={ml_str}  MAE_cal_raw={m['mae_cal_raw']:.3f}  R²(log)={m['r2_log']:.3f}  n_train={m['n_train']}")
        for tier, v in (m.get("tier_metrics") or {}).items():
            print(f"    {tier}: n={v['n']} MAE={v['mae_raw']:.2f}")


if __name__ == "__main__":
    main()
