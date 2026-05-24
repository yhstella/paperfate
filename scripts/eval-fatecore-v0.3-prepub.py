#!/usr/bin/env python
"""Create the FateCore v0.3-prepub evaluation report."""
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

FORBIDDEN_PATTERNS = [
    "citations_",
    "fwci",
    "reference_count",
    "influential_citations",
    "icite_citation_count",
    "icite_nih_percentile",
    "icite_apt",
    "icite_cited_by_clin",
    "unpaywall_",
    "has_pmcid",
    "pmc_",
    "epmc_",
    "pdf_",
    "j_hist_",
    "preprint_pub_gap_days",
    "pub_year_age",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--metrics", default=str(WEIGHTS_DIR / "fatecore-v0.3-prepub-metrics.json"))
    p.add_argument("--baseline", default=str(WEIGHTS_DIR / "fatecore-v0.2-prod-metrics.json"))
    p.add_argument("--out", default=str(DOCS_DIR / "EVAL_v0.3-prepub.md"))
    p.add_argument("--prod-r2-jif", type=float, default=0.435)
    p.add_argument("--deploy-threshold", type=float, default=0.48)
    p.add_argument("--suspicious-r2", type=float, default=0.70)
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
    return any(name.startswith(p) if p.endswith("_") else name == p for p in FORBIDDEN_PATTERNS)


def metric_row(target: str, metrics: dict[str, Any], baseline: dict[str, Any]) -> str:
    m = metrics.get(target, {})
    b = baseline.get(target, {})
    delta = None
    if m.get("r2_log") is not None and b.get("r2_log") is not None:
      delta = float(m["r2_log"]) - float(b["r2_log"])
    return (
        f"| {TARGET_LABELS.get(target, target)} "
        f"| {m.get('n_train_model', m.get('n_train', 0)):,} "
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
    rows = [f"### {TARGET_LABELS.get(target, target)}", "", "| Rank | Feature | Gain | Split | Forbidden? |", "|---:|---|---:|---:|---|"]
    for i, item in enumerate(metrics.get(target, {}).get("top_features_gain", [])[:30], start=1):
        feature = item["feature"]
        rows.append(f"| {i} | `{feature}` | {fmt(item.get('gain'), 1)} | {item.get('split', 0)} | {'YES' if is_forbidden(feature) else 'no'} |")
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
    return rows


def main() -> None:
    args = parse_args()
    metrics = load_json(Path(args.metrics))
    baseline = load_json(Path(args.baseline))
    features = list(metrics.get("feature_cols", []))
    forbidden = [f for f in features if is_forbidden(f)]

    jif = metrics.get("y_jcr_jif", {})
    jif_r2 = float(jif.get("r2_log", float("nan")))
    suspicious = jif_r2 >= args.suspicious_r2
    deploy = jif_r2 >= args.deploy_threshold and jif_r2 > args.prod_r2_jif and not forbidden and not suspicious
    decision = "DEPLOY CANDIDATE" if deploy else "HOLD v0.2-prod"

    lines: list[str] = [
        "# FateCore v0.3-prepub Evaluation",
        "",
        f"- Generated from: `{args.metrics}`",
        f"- Trained at: `{metrics.get('trained_at', 'n/a')}`",
        f"- Feature CSV: `{metrics.get('features_path', 'n/a')}`",
        f"- Rows: `{metrics.get('n_rows', 0):,}`",
        f"- Features: `{metrics.get('n_features', 0):,}`",
        f"- Split: `{metrics.get('split_policy', 'random_80_20_only_no_year_split')}`",
        f"- Forbidden post-publication features in model: `{len(forbidden)}`",
        f"- Suspicious high R2 guardrail: `R2_log < {args.suspicious_r2:.2f}`",
        f"- Decision before EMPA-REG cold-start smoke: **{decision}**",
        "",
        "## Summary",
        "",
        "| Target | Train | Cal | Test | MAE raw cal | R2 log | R2 raw cal | Conf. coverage | v0.2-prod R2 log | Delta |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for target in ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]:
        if target in metrics:
            lines.append(metric_row(target, metrics, baseline))

    lines.extend([
        "",
        "## Deploy Rule",
        "",
        f"- Rule: deploy only if `R2_log(y_jcr_jif) >= {args.deploy_threshold:.2f}`, above v0.2-prod `{args.prod_r2_jif:.3f}`, no forbidden features, and no suspiciously high R2.",
        f"- Observed JIF R2_log: `{fmt(jif.get('r2_log'), 4)}`.",
        f"- Observed JIF R2_raw_cal: `{fmt(jif.get('r2_raw_cal'), 4)}`.",
        f"- Forbidden features: `{', '.join(forbidden) if forbidden else 'none'}`.",
        f"- Suspicious high-R2 flag: `{'yes' if suspicious else 'no'}`.",
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
        "## Excluded Leakage Columns",
        "",
        "Excluded groups: citations/FWCI/iCite, reference counts, PMC/EPMC/PDF fulltext, PMCID, Unpaywall indexed article signals, accepted-journal `j_hist_*`, post-publication preprint gap.",
        "",
        "## Notes",
        "",
        "- Random split only was used. No year-based split or cutoff was applied.",
        "- This report is not sufficient for deployment by itself. EMPA-REG cold-start local and production tests are mandatory.",
        "- If R2 is very high, hold deployment and inspect for leakage even when the explicit forbidden-feature count is zero.",
    ])

    out_path = Path(args.out)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"Decision: {decision}")
    print(f"JIF R2_log={fmt(jif.get('r2_log'), 4)} forbidden={len(forbidden)} suspicious={suspicious}")


if __name__ == "__main__":
    main()
