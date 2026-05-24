#!/usr/bin/env python
"""Create the v0.3 evaluation report from FateCore metrics JSON."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).parent.parent
WEIGHTS_DIR = ROOT / "weights"
DOCS_DIR = ROOT / "docs"

TARGET_LABELS = {
    "y_jcr_jif": "JCR JIF",
    "y_icite_rcr": "iCite RCR",
    "y_citations_log": "log citations",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--metrics", default=str(WEIGHTS_DIR / "fatecore-v0.3-metrics.json"))
    p.add_argument("--baseline", default=str(WEIGHTS_DIR / "fatecore-v0.2-metrics.json"))
    p.add_argument("--out", default=str(DOCS_DIR / "EVAL_v0.3.md"))
    p.add_argument("--prod-r2-jif", type=float, default=0.435)
    p.add_argument("--deploy-threshold", type=float, default=0.50)
    return p.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def fmt(value: Any, digits: int = 3) -> str:
    if value is None:
        return "n/a"
    try:
        return f"{float(value):.{digits}f}"
    except Exception:
        return str(value)


def metric_row(target: str, metrics: dict[str, Any], baseline: dict[str, Any]) -> str:
    m = metrics.get(target, {})
    b = baseline.get(target, {})
    delta = None
    if m.get("r2_log") is not None and b.get("r2_log") is not None:
        delta = float(m["r2_log"]) - float(b["r2_log"])
    return (
        f"| {TARGET_LABELS.get(target, target)} "
        f"| {m.get('n_train_model', 0):,} "
        f"| {m.get('n_cal', 0):,} "
        f"| {m.get('n_test', 0):,} "
        f"| {fmt(m.get('mae_cal_raw'))} "
        f"| {fmt(m.get('r2_log'))} "
        f"| {fmt(m.get('r2_raw_cal'))} "
        f"| {fmt(m.get('conformal_coverage_test'))} "
        f"| {fmt(b.get('r2_log'))} "
        f"| {fmt(delta, 4)} |"
    )


def feature_table(target: str, metrics: dict[str, Any]) -> list[str]:
    rows = [f"### {TARGET_LABELS.get(target, target)}", "", "| Rank | Feature | Gain | Split |", "|---:|---|---:|---:|"]
    for i, item in enumerate(metrics.get(target, {}).get("top_features_gain", [])[:30], start=1):
        rows.append(f"| {i} | `{item['feature']}` | {fmt(item.get('gain'), 1)} | {item.get('split', 0)} |")
    return rows


def tier_table(metrics: dict[str, Any]) -> list[str]:
    tiers = metrics.get("y_jcr_jif", {}).get("tier_metrics", {})
    rows = ["## JIF Tier Metrics", "", "| Tier | n | MAE raw | Median true | Median pred |", "|---|---:|---:|---:|---:|"]
    labels = {
        "top_30_plus": "top >=30",
        "high_10_30": "high 10-30",
        "mid_3_10": "mid 3-10",
        "low_lt_3": "low <3",
    }
    for key in ["top_30_plus", "high_10_30", "mid_3_10", "low_lt_3"]:
        v = tiers.get(key)
        if not v:
            continue
        rows.append(
            f"| {labels[key]} | {v.get('n', 0):,} | {fmt(v.get('mae_raw'))} "
            f"| {fmt(v.get('median_true'))} | {fmt(v.get('median_pred_cal'))} |"
        )
    if len(rows) == 4:
        rows.append("| n/a | 0 | n/a | n/a | n/a |")
    return rows


def main() -> None:
    args = parse_args()
    metrics = load_json(Path(args.metrics))
    baseline = load_json(Path(args.baseline))
    out_path = Path(args.out)

    jif = metrics.get("y_jcr_jif", {})
    jif_r2 = float(jif.get("r2_log", float("nan")))
    deploy = jif_r2 >= args.deploy_threshold and jif_r2 > args.prod_r2_jif
    decision = "DEPLOY RECOMMENDED" if deploy else "HOLD v0.3"

    lines: list[str] = [
        "# FateCore v0.3 Evaluation",
        "",
        f"- Generated from: `{args.metrics}`",
        f"- Trained at: `{metrics.get('trained_at', 'n/a')}`",
        f"- Feature CSV: `{metrics.get('features_path', 'n/a')}`",
        f"- Rows: `{metrics.get('n_rows', 0):,}`",
        f"- Features: `{metrics.get('n_features', 0):,}`",
        f"- Split: `{metrics.get('split_policy', 'random_80_20_only_no_year_split')}`",
        f"- Decision: **{decision}**",
        "",
        "## Summary",
        "",
        "| Target | Train | Cal | Test | MAE raw cal | R2 log | R2 raw cal | Conf. coverage | v0.2 R2 log | Delta |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for target in ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]:
        if target in metrics:
            lines.append(metric_row(target, metrics, baseline))

    lines.extend([
        "",
        "## Deploy Decision",
        "",
        f"- Rule: deploy if `R2_log(y_jcr_jif) >= {args.deploy_threshold:.2f}` and above the production baseline `{args.prod_r2_jif:.3f}`.",
        f"- Observed JIF R2_log: `{fmt(jif.get('r2_log'), 4)}`.",
        f"- Observed JIF R2_raw_cal: `{fmt(jif.get('r2_raw_cal'), 4)}`.",
        f"- Decision: **{decision}**.",
        "",
    ])

    lines.extend(tier_table(metrics))
    lines.extend(["", "## Top Features", ""])
    for target in ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]:
        if target in metrics:
            lines.extend(feature_table(target, metrics))
            lines.append("")

    lines.extend([
        "## Notes",
        "",
        "- Random split only was used. No year-based split or year cutoff was applied.",
        "- Calibration uses a random calibration subset taken only from the training split.",
        "- Conformal intervals use split conformal residuals on the calibration subset with alpha=0.1.",
        "- Same-year journal metrics are not present as feature columns; v0.3 uses prior-year `j_hist_*` features from the CSV.",
        "- Production cold-start inference cannot know post-publication features such as future citations, FWCI, and iCite values; the server fills those as missing values. Treat the offline v0.3 metrics as an enriched-corpus benchmark, not a pure pre-submission-only benchmark.",
    ])

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"Decision: {decision}")
    print(f"JIF R2_log={fmt(jif.get('r2_log'), 4)} R2_raw_cal={fmt(jif.get('r2_raw_cal'), 4)}")


if __name__ == "__main__":
    main()
