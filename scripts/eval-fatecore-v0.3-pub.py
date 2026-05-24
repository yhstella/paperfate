#!/usr/bin/env python
"""Create the FateCore v0.3-pub evaluation report."""
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
FORBIDDEN_PREFIXES = [
    "citations_",
    "fwci",
    "reference_count",
    "influential_citations",
    "unpaywall_",
    "has_pmcid",
    "pmc_",
    "epmc_",
    "pdf_",
    "preprint_pub_gap_days",
    "pub_year_age",
]
FORBIDDEN_EXACT = {
    "icite_citation_count",
    "icite_nih_percentile",
    "icite_apt",
    "icite_cited_by_clin",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--metrics", default=str(WEIGHTS_DIR / "fatecore-v0.3-pub-metrics.json"))
    p.add_argument("--baseline", default=str(WEIGHTS_DIR / "fatecore-v0.2-prod-metrics.json"))
    p.add_argument("--prepub", default=str(WEIGHTS_DIR / "fatecore-v0.3-prepub-metrics.json"))
    p.add_argument("--out", default=str(DOCS_DIR / "EVAL_v0.3-pub.md"))
    p.add_argument("--with-target-threshold", type=float, default=0.55)
    p.add_argument("--cold-start-threshold", type=float, default=0.45)
    p.add_argument("--suspicious-r2", type=float, default=0.85)
    return p.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def fmt(value: Any, digits: int = 3) -> str:
    if value is None:
        return "n/a"
    try:
        return f"{float(value):.{digits}f}"
    except Exception:
        return str(value)


def is_forbidden(name: str) -> bool:
    return name in FORBIDDEN_EXACT or any(name.startswith(p) for p in FORBIDDEN_PREFIXES)


def scenario(metrics: dict[str, Any], target: str, name: str) -> dict[str, Any]:
    return metrics.get(target, {}).get("scenario_metrics", {}).get(name, {})


def metric_row(target: str, metrics: dict[str, Any], baseline: dict[str, Any], prepub: dict[str, Any]) -> str:
    wt = scenario(metrics, target, "with_target")
    cs = scenario(metrics, target, "cold_start")
    b = baseline.get(target, {})
    p = prepub.get(target, {})
    return (
        f"| {TARGET_LABELS.get(target, target)} "
        f"| {fmt(wt.get('r2_log'))} | {fmt(wt.get('mae_cal_raw'))} "
        f"| {fmt(cs.get('r2_log'))} | {fmt(cs.get('mae_cal_raw'))} "
        f"| {fmt(b.get('r2_log'))} | {fmt(p.get('r2_log'))} |"
    )


def tier_table(metrics: dict[str, Any], scenario_name: str) -> list[str]:
    tiers = scenario(metrics, "y_jcr_jif", scenario_name).get("tier_metrics", {})
    rows = [
        f"## JIF Tier Metrics - {scenario_name}",
        "",
        "| Tier | n | MAE raw | Median true | Median pred |",
        "|---|---:|---:|---:|---:|",
    ]
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
    return rows


def feature_table(target: str, metrics: dict[str, Any]) -> list[str]:
    rows = [
        f"### {TARGET_LABELS.get(target, target)}",
        "",
        "| Rank | Feature | Gain | Split | Forbidden? |",
        "|---:|---|---:|---:|---|",
    ]
    for i, item in enumerate(metrics.get(target, {}).get("top_features_gain", [])[:30], start=1):
        feature = item["feature"]
        rows.append(f"| {i} | `{feature}` | {fmt(item.get('gain'), 1)} | {item.get('split', 0)} | {'YES' if is_forbidden(feature) else 'no'} |")
    return rows


def main() -> None:
    args = parse_args()
    metrics = load_json(Path(args.metrics))
    baseline = load_json(Path(args.baseline))
    prepub = load_json(Path(args.prepub))
    features = list(metrics.get("feature_cols", []))
    forbidden = [f for f in features if is_forbidden(f)]

    wt_jif = scenario(metrics, "y_jcr_jif", "with_target")
    cs_jif = scenario(metrics, "y_jcr_jif", "cold_start")
    wt_r2 = float(wt_jif.get("r2_log", float("nan")))
    cs_r2 = float(cs_jif.get("r2_log", float("nan")))
    suspicious = wt_r2 >= args.suspicious_r2 or cs_r2 >= args.suspicious_r2
    deploy = (
        wt_r2 >= args.with_target_threshold
        and cs_r2 >= args.cold_start_threshold
        and not suspicious
        and not forbidden
    )
    decision = "DEPLOY CANDIDATE - pending EMPA smoke" if deploy else "HOLD v0.2-prod"

    lines = [
        "# FateCore v0.3-pub Evaluation",
        "",
        f"- Generated from: `{args.metrics}`",
        f"- Trained at: `{metrics.get('trained_at', 'n/a')}`",
        f"- Feature CSV: `{metrics.get('features_path', 'n/a')}`",
        f"- Rows: `{metrics.get('n_rows', 0):,}`",
        f"- Features: `{metrics.get('n_features', 0):,}`",
        f"- Target-journal mask fraction: `{metrics.get('j_hist_mask_fraction', 'n/a')}`",
        f"- Forbidden post-publication features in model: `{len(forbidden)}`",
        f"- Decision before EMPA smoke: **{decision}**",
        "",
        "## Summary",
        "",
        "| Target | With-target R2 log | With-target MAE raw | Cold-start R2 log | Cold-start MAE raw | v0.2-prod R2 log | v0.3-prepub R2 log |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for target in ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]:
        if target in metrics:
            lines.append(metric_row(target, metrics, baseline, prepub))

    lines.extend([
        "",
        "## Deploy Rule",
        "",
        f"- With-target JIF R2 must be `>= {args.with_target_threshold:.2f}`.",
        f"- Cold-start JIF R2 must be `>= {args.cold_start_threshold:.2f}`.",
        f"- Any JIF R2 `>= {args.suspicious_r2:.2f}` is suspicious and blocks deploy.",
        f"- Observed with-target JIF R2: `{fmt(wt_r2, 4)}`.",
        f"- Observed cold-start JIF R2: `{fmt(cs_r2, 4)}`.",
        f"- Forbidden features: `{', '.join(forbidden) if forbidden else 'none'}`.",
        f"- Suspicious high-R2 flag: `{'yes' if suspicious else 'no'}`.",
        f"- Decision: **{decision}**.",
        "",
    ])
    lines.extend(tier_table(metrics, "with_target"))
    lines.append("")
    lines.extend(tier_table(metrics, "cold_start"))
    lines.extend(["", "## Top Features", ""])
    for target in ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]:
        if target in metrics:
            lines.extend(feature_table(target, metrics))
            lines.append("")
    lines.extend([
        "## EMPA-REG Smoke",
        "",
        "Pending. Run:",
        "",
        "```powershell",
        "node scripts\\test-fatecore-v0.3-pub-empa-reg.mjs --version-tag v0.3-pub",
        "```",
        "",
        "Required checks:",
        "",
        "- cold-start/no target: v0.2-prod range, about 2-3 JIF",
        "- target=NEJM: 30-100 JIF",
        "- target=Saudi Heart: 1-2 JIF",
    ])

    out_path = Path(args.out)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"Decision: {decision}")
    print(f"JIF with_target R2={fmt(wt_r2, 4)} cold_start R2={fmt(cs_r2, 4)} forbidden={len(forbidden)} suspicious={suspicious}")


if __name__ == "__main__":
    main()
