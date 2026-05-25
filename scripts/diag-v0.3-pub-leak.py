#!/usr/bin/env python
"""Diagnose whether FateCore v0.3-pub JIF performance is target-journal autocorrelation.

Diagnostics:
  - recreate the random test split used by train-fatecore-v0.3-pub.py
  - ISSN-stratified MAE for top 200 ISSNs
  - shuffle ablation of j_hist_* columns on test set only
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split


ROOT = Path(__file__).parent.parent
DATA_DIR = Path(os.environ.get("DATA_ROOT", ROOT / "data"))
FEATURES_DIR = DATA_DIR / "features"
WEIGHTS_DIR = ROOT / "weights"
DOCS_DIR = ROOT / "docs"
DB_PATH = Path(os.environ.get("PAPERFATE_DB", DATA_DIR / "paperfate.db"))

J_HIST_COLS = [
    "j_hist_jcr_jif",
    "j_hist_jcr_jif_5yr",
    "j_hist_jci",
    "j_hist_article_influence",
    "j_hist_eigenfactor",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--features", default=str(FEATURES_DIR / "v0.3-pub-features.csv"))
    p.add_argument("--manifest", default=str(FEATURES_DIR / "v0.3-pub-features-manifest.json"))
    p.add_argument("--metrics", default=str(WEIGHTS_DIR / "fatecore-v0.3-pub-metrics.json"))
    p.add_argument("--model", default=str(WEIGHTS_DIR / "fatecore-v0.3-pub-y_jcr_jif.txt"))
    p.add_argument("--db", default=str(DB_PATH))
    p.add_argument("--out", default=str(DOCS_DIR / "V0.3_PUB_LEAK_DIAGNOSIS.md"))
    p.add_argument("--issn-out", default=str(DOCS_DIR / "V0.3_PUB_ISSN_STRATIFIED.md"))
    return p.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def apply_isotonic(pred: np.ndarray, iso_x: list[float], iso_y: list[float]) -> np.ndarray:
    x = np.asarray(iso_x, dtype=np.float64)
    y = np.asarray(iso_y, dtype=np.float64)
    return np.interp(pred, x, y, left=y[0], right=y[-1])


def inverse_jif(y_log: np.ndarray) -> np.ndarray:
    return np.maximum(0.0, np.expm1(y_log))


def scenario_metrics(model: lgb.Booster, x: np.ndarray, y_raw: np.ndarray, y_log: np.ndarray, iso_x: list[float], iso_y: list[float]) -> dict[str, Any]:
    pred_log = model.predict(x, num_iteration=model.best_iteration)
    pred_iso_log = apply_isotonic(pred_log, iso_x, iso_y)
    pred_raw = inverse_jif(pred_log)
    pred_iso_raw = inverse_jif(pred_iso_log)
    return {
        "r2_log": float(r2_score(y_log, pred_log)),
        "r2_log_cal": float(r2_score(y_log, pred_iso_log)),
        "mae_raw": float(mean_absolute_error(y_raw, pred_raw)),
        "mae_cal_raw": float(mean_absolute_error(y_raw, pred_iso_raw)),
        "pred_cal_raw": pred_iso_raw,
    }


def fetch_issn_map(db_path: Path, dois: list[str], batch_size: int = 500) -> dict[str, str | None]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.execute("PRAGMA busy_timeout=60000")
    out: dict[str, str | None] = {}
    try:
        for i in range(0, len(dois), batch_size):
            batch = dois[i : i + batch_size]
            placeholders = ",".join("?" for _ in batch)
            for doi, issn in conn.execute(f"SELECT doi, issn FROM papers WHERE doi IN ({placeholders})", batch):
                out[str(doi).lower()] = issn
    finally:
        conn.close()
    return out


def issn_stratified(df_test: pd.DataFrame, y_raw: np.ndarray, pred_raw: np.ndarray, db_path: Path) -> pd.DataFrame:
    dois = [str(x).lower() for x in df_test["doi"].tolist()]
    issn_map = fetch_issn_map(db_path, dois)
    issns = np.array([issn_map.get(d) or "" for d in dois], dtype=object)
    rows = []
    for issn in sorted(set(issns)):
        if not issn:
            continue
        mask = issns == issn
        n = int(mask.sum())
        if n < 5:
            continue
        rows.append(
            {
                "issn": issn,
                "n": n,
                "mae": float(mean_absolute_error(y_raw[mask], pred_raw[mask])),
                "median_true": float(np.median(y_raw[mask])),
                "median_pred": float(np.median(pred_raw[mask])),
                "p90_abs_error": float(np.percentile(np.abs(y_raw[mask] - pred_raw[mask]), 90)),
            }
        )
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    return out.sort_values(["n", "mae"], ascending=[False, True]).head(200)


def fmt(value: Any, digits: int = 3) -> str:
    if value is None:
        return "n/a"
    try:
        return f"{float(value):.{digits}f}"
    except Exception:
        return str(value)


def render_issn_doc(path: Path, table: pd.DataFrame) -> None:
    lines = [
        "# v0.3-pub ISSN-Stratified JIF Error",
        "",
        "| Rank | ISSN | n | MAE | Median true | Median pred | P90 abs error |",
        "|---:|---|---:|---:|---:|---:|---:|",
    ]
    for rank, row in enumerate(table.itertuples(index=False), start=1):
        lines.append(
            f"| {rank} | `{row.issn}` | {int(row.n):,} | {fmt(row.mae)} "
            f"| {fmt(row.median_true)} | {fmt(row.median_pred)} | {fmt(row.p90_abs_error)} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def render_diag_doc(path: Path, original: dict[str, Any], ablations: dict[str, dict[str, Any]], issn_table: pd.DataFrame, metrics_path: Path) -> None:
    joint = ablations.get("shuffle_all_j_hist_joint", {})
    delta = float(original["r2_log"]) - float(joint.get("r2_log", float("nan")))
    if joint and joint.get("r2_log", 1.0) <= 0.55 and delta >= 0.30:
        verdict = "mostly target-journal autocorrelation"
        recommendation = "Do not deploy v0.3-pub as a learned manuscript-quality model. Use direct prior-year journal lookup for target-aware explanations."
    elif joint and joint.get("r2_log", 0.0) >= 0.70:
        verdict = "not solely journal lookup"
        recommendation = "v0.3-pub may contain additional signal, but it still needs cold-start/product validation before deployment."
    else:
        verdict = "mixed"
        recommendation = "Treat v0.3-pub as diagnostic only until additional cold-start tests pass."

    lines = [
        "# v0.3-pub Leak / Autocorrelation Diagnosis",
        "",
        f"- Metrics source: `{metrics_path}`",
        f"- Original with-target R2 log: `{fmt(original.get('r2_log'), 4)}`",
        f"- Original with-target calibrated MAE raw: `{fmt(original.get('mae_cal_raw'), 3)}`",
        f"- Joint j_hist shuffle R2 log: `{fmt(joint.get('r2_log'), 4)}`",
        f"- R2 drop from joint shuffle: `{fmt(delta, 4)}`",
        f"- Verdict: **{verdict}**",
        f"- Recommendation: **{recommendation}**",
        "",
        "## Shuffle Ablation",
        "",
        "| Scenario | R2 log | R2 log calibrated | MAE raw | MAE calibrated raw |",
        "|---|---:|---:|---:|---:|",
        f"| original | {fmt(original.get('r2_log'), 4)} | {fmt(original.get('r2_log_cal'), 4)} | {fmt(original.get('mae_raw'))} | {fmt(original.get('mae_cal_raw'))} |",
    ]
    for name, m in ablations.items():
        lines.append(
            f"| {name} | {fmt(m.get('r2_log'), 4)} | {fmt(m.get('r2_log_cal'), 4)} "
            f"| {fmt(m.get('mae_raw'))} | {fmt(m.get('mae_cal_raw'))} |"
        )

    lines.extend([
        "",
        "## ISSN-Stratified Summary",
        "",
        "| Metric | Value |",
        "|---|---:|",
    ])
    if issn_table.empty:
        lines.append("| Top ISSNs with n>=5 | 0 |")
    else:
        lines.extend([
            f"| Top ISSNs with n>=5 | {len(issn_table):,} |",
            f"| Median ISSN MAE | {fmt(issn_table['mae'].median())} |",
            f"| P10 ISSN MAE | {fmt(issn_table['mae'].quantile(0.10))} |",
            f"| P90 ISSN MAE | {fmt(issn_table['mae'].quantile(0.90))} |",
        ])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    features_path = Path(args.features)
    manifest_path = Path(args.manifest)
    metrics_path = Path(args.metrics)
    model_path = Path(args.model)
    db_path = Path(args.db)

    manifest = load_json(manifest_path)
    metrics = load_json(metrics_path)
    target_metrics = metrics["y_jcr_jif"]
    feature_cols = list(manifest["feature_cols"])
    usecols = ["doi", *feature_cols, "y_jcr_jif"]

    print("Loading v0.3-pub features...")
    df = pd.read_csv(features_path, usecols=usecols, low_memory=False)
    x_all = df[feature_cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=np.float32)
    y_raw_all = pd.to_numeric(df["y_jcr_jif"], errors="coerce").to_numpy(dtype=np.float64)
    y_log_all = np.log1p(np.maximum(0.0, y_raw_all))

    all_idx = np.arange(len(df))
    train_idx, test_idx = train_test_split(
        all_idx,
        test_size=float(metrics.get("test_size", 0.2)),
        random_state=int(metrics.get("seed", 42)),
        shuffle=True,
    )
    test_idx = test_idx[np.isfinite(y_raw_all[test_idx])]
    df_test = df.iloc[test_idx].reset_index(drop=True)
    x_test = x_all[test_idx].copy()
    y_raw = y_raw_all[test_idx]
    y_log = y_log_all[test_idx]

    model = lgb.Booster(model_file=str(model_path))
    iso_x = target_metrics["iso_x"]
    iso_y = target_metrics["iso_y"]
    original = scenario_metrics(model, x_test, y_raw, y_log, iso_x, iso_y)
    print(f"Original R2_log={original['r2_log']:.4f} MAE={original['mae_cal_raw']:.4f} n={len(test_idx):,}")

    rng = np.random.default_rng(int(metrics.get("seed", 42)) + 909)
    ablations: dict[str, dict[str, Any]] = {}
    jhist_idx = [feature_cols.index(c) for c in J_HIST_COLS if c in feature_cols]
    if jhist_idx:
        perm = rng.permutation(x_test.shape[0])
        x_joint = x_test.copy()
        x_joint[:, jhist_idx] = x_joint[perm][:, jhist_idx]
        ablations["shuffle_all_j_hist_joint"] = scenario_metrics(model, x_joint, y_raw, y_log, iso_x, iso_y)

        x_nan = x_test.copy()
        x_nan[:, jhist_idx] = np.nan
        ablations["cold_start_all_j_hist_nan"] = scenario_metrics(model, x_nan, y_raw, y_log, iso_x, iso_y)

    for col in J_HIST_COLS:
        if col not in feature_cols:
            continue
        idx = feature_cols.index(col)
        x_col = x_test.copy()
        x_col[:, idx] = x_col[rng.permutation(x_test.shape[0]), idx]
        ablations[f"shuffle_{col}"] = scenario_metrics(model, x_col, y_raw, y_log, iso_x, iso_y)

    issn_table = issn_stratified(df_test, y_raw, original["pred_cal_raw"], db_path)
    render_issn_doc(Path(args.issn_out), issn_table)
    render_diag_doc(Path(args.out), original, ablations, issn_table, metrics_path)

    print(f"Wrote {args.out}")
    print(f"Wrote {args.issn_out}")
    for name, m in ablations.items():
        print(f"{name}: R2_log={m['r2_log']:.4f} MAE={m['mae_cal_raw']:.4f}")


if __name__ == "__main__":
    main()
