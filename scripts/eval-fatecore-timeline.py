#!/usr/bin/env python
"""Create the FateCore v0.4 review-timeline evaluation report."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).parent.parent
WEIGHTS_DIR = ROOT / "weights"
DOCS_DIR = ROOT / "docs"

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
    p.add_argument("--metrics", default=str(WEIGHTS_DIR / "fatecore-v0.4-timeline-metrics.json"))
    p.add_argument("--out", default=str(DOCS_DIR / "EVAL_v0.4-timeline.md"))
    p.add_argument("--mae-threshold", type=float, default=90.0)
    p.add_argument("--suspicious-r2-log", type=float, default=0.60)
    return p.parse_args()


def fmt(value: Any, digits: int = 3) -> str:
    if value is None:
        return "n/a"
    try:
        return f"{float(value):.{digits}f}"
    except Exception:
        return str(value)


def is_forbidden(name: str) -> bool:
    return name in FORBIDDEN_EXACT or any(name.startswith(prefix) for prefix in FORBIDDEN_PREFIXES)


def tier_table(metrics: dict[str, Any]) -> list[str]:
    rows = [
        "## Target-Journal Tier Metrics",
        "",
        "| Tier by prior-year JIF | n | MAE days | Median true days | Median pred days |",
        "|---|---:|---:|---:|---:|",
    ]
    labels = {
        "target_jif_ge_30": "JIF >=30",
        "target_jif_10_30": "JIF 10-30",
        "target_jif_3_10": "JIF 3-10",
        "target_jif_lt_3": "JIF <3",
        "target_jif_missing": "JIF missing",
    }
    for key in ["target_jif_ge_30", "target_jif_10_30", "target_jif_3_10", "target_jif_lt_3", "target_jif_missing"]:
        v = metrics.get("tier_metrics", {}).get(key)
        if not v:
            continue
        rows.append(
            f"| {labels[key]} | {v.get('n', 0):,} | {fmt(v.get('mae_days'), 1)} "
            f"| {fmt(v.get('median_true_days'), 1)} | {fmt(v.get('median_pred_days'), 1)} |"
        )
    return rows


def feature_table(metrics: dict[str, Any]) -> list[str]:
    rows = [
        "## Top Features",
        "",
        "| Rank | Feature | Gain | Split | Forbidden? |",
        "|---:|---|---:|---:|---|",
    ]
    for i, item in enumerate(metrics.get("top_features_gain", [])[:40], start=1):
        feature = item["feature"]
        rows.append(
            f"| {i} | `{feature}` | {fmt(item.get('gain'), 1)} | {item.get('split', 0)} "
            f"| {'YES' if is_forbidden(feature) else 'no'} |"
        )
    return rows


def main() -> None:
    args = parse_args()
    metrics_path = Path(args.metrics)
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    feature_cols = list(metrics.get("feature_cols", []))
    forbidden = [c for c in feature_cols if is_forbidden(c)]
    mae = float(metrics.get("mae_cal_days", float("inf")))
    r2_log = float(metrics.get("r2_log", float("nan")))
    suspicious = r2_log > args.suspicious_r2_log
    deploy = mae <= args.mae_threshold and not forbidden and not suspicious
    decision = "DEPLOY CANDIDATE" if deploy else "HOLD"

    split = metrics.get("split", {})
    lines = [
        "# FateCore v0.4 Timeline Evaluation",
        "",
        f"- Metrics: `{metrics_path}`",
        f"- Trained at: `{metrics.get('trained_at', 'n/a')}`",
        f"- Feature CSV: `{metrics.get('features_path', 'n/a')}`",
        f"- Rows: `{split.get('n_rows', 0):,}`",
        f"- Split: `{split.get('type', 'n/a')}`; train `{split.get('n_train_model', 0):,}`, cal `{split.get('n_cal', 0):,}`, test `{split.get('n_test', 0):,}`",
        f"- Features: `{metrics.get('n_features', 0):,}`",
        f"- Forbidden post-publication features: `{len(forbidden)}`",
        f"- Decision: **{decision}**",
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "|---|---:|",
        f"| MAE days, calibrated | {fmt(metrics.get('mae_cal_days'), 1)} |",
        f"| MAE days, raw | {fmt(metrics.get('mae_days'), 1)} |",
        f"| Median abs error days | {fmt(metrics.get('median_abs_error_cal_days'), 1)} |",
        f"| R2 log | {fmt(metrics.get('r2_log'), 4)} |",
        f"| R2 log, calibrated | {fmt(metrics.get('r2_log_cal'), 4)} |",
        f"| Conformal coverage | {fmt(metrics.get('conformal_coverage'), 3)} |",
        f"| Median interval width days | {fmt(metrics.get('interval_width_median_days'), 1)} |",
        "",
        "## Deploy Rule",
        "",
        f"- MAE days must be `<= {args.mae_threshold:.0f}`.",
        f"- R2 log must be `<= {args.suspicious_r2_log:.2f}`; higher is suspicious for review-time prediction.",
        "- Forbidden post-publication feature count must be `0`.",
        f"- Observed MAE days: `{fmt(mae, 1)}`.",
        f"- Observed R2 log: `{fmt(r2_log, 4)}`.",
        f"- Forbidden features: `{', '.join(forbidden) if forbidden else 'none'}`.",
        f"- Suspicious high-R2 flag: `{'yes' if suspicious else 'no'}`.",
        f"- Decision: **{decision}**.",
        "",
    ]
    lines.extend(tier_table(metrics))
    lines.append("")
    lines.extend(feature_table(metrics))

    out_path = Path(args.out)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"Decision: {decision}")
    print(f"MAE={fmt(mae, 1)} R2_log={fmt(r2_log, 4)} forbidden={len(forbidden)} suspicious={suspicious}")


if __name__ == "__main__":
    main()
