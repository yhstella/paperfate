#!/usr/bin/env python
"""FateCore v0.1 — Manuscript → Forecast prediction.

사용:
    python scripts/predict-fatecore.py --abstract "..."
    python scripts/predict-fatecore.py --file manuscript.txt
    python scripts/predict-fatecore.py --doi 10.1234/abc  # corpus existing paper

기능:
    1. Rule-based Q100 scoring (no LLM) — ruleExtractors-equivalent
    2. Paper metadata extraction (year, author count guess, MeSH terms)
    3. LightGBM 4 model predict (jcr_jif, icite_rcr, citations_log)
    4. Calibration + conformal CI
    5. Format response JSON
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path
from datetime import datetime

import numpy as np
import pandas as pd
import lightgbm as lgb

ROOT = Path(__file__).parent.parent
DATA = Path(os.environ.get("DATA_ROOT", ROOT / "data"))
WEIGHTS = ROOT / "weights"

# ─── Load models ────────────────────────────────────────────────────────────
def load_models():
    models = {}
    for tgt in ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]:
        p = WEIGHTS / f"fatecore-v0.1-{tgt}.txt"
        if not p.exists():
            raise FileNotFoundError(f"Missing {p}. Train first with train-fatecore-v0.1.py")
        models[tgt] = lgb.Booster(model_file=str(p))
    schema = json.loads((DATA / "fatecore" / "feature-schema.json").read_text(encoding="utf-8"))
    metrics = json.loads((WEIGHTS / "fatecore-v0.1-metrics.json").read_text(encoding="utf-8"))
    return models, schema, metrics


# ─── Rule-based Q100 scoring (subset of full Q500, no LLM) ──────────────────
# Note: 정확한 Gemini-equivalent 채점은 production server에서. Local CLI는 rule만.
def score_q100_rule(text):
    """Returns dict {item_id: score} for items rule extractors can compute."""
    text_lc = text.lower()
    scores = {}

    def has(pattern):
        return bool(re.search(pattern, text, re.IGNORECASE))

    def find_int(pattern):
        m = re.search(pattern, text, re.IGNORECASE)
        if not m: return None
        try: return int(m.group(1).replace(",", ""))
        except: return None

    # QUEST
    if has(r"\b(aim|aimed|objective|purpose|to assess|to evaluate|to investigate)\b"):
        scores["QUEST_001"] = 4
    else:
        scores["QUEST_001"] = 2
    scores["QUEST_002"] = 3 if has(r"\b(no recent|unknown|unclear|limited|few studies|lack|however|gap)\b") else 1
    scores["QUEST_006"] = 4 if has(r"\b(pre-registered|preregistered|registered|protocol|NCT\d+|ISRCTN|UMIN)\b") else 1
    scores["QUEST_007"] = 3 if has(r"\b(novel|first|new|unknown|limited)\b") else 2
    # NOVEL
    scores["NOVEL_001"] = 3 if has(r"\bnovel|first|new\b") else 1
    scores["NOVEL_010"] = 5 if not has(r"\bfirst\b") else 3
    # DESIGN
    sample_n = find_int(r"\b(?:N\s*=\s*|n\s*=\s*|enrolled|included|recruited)\s*([\d,]{2,})\b") or \
               find_int(r"\b([\d,]{2,})\s+(?:patients|participants|subjects|children|women|men)\b")
    scores["DESIGN_005"] = (
        5 if sample_n and sample_n >= 2000 else
        4 if sample_n and sample_n >= 500 else
        3 if sample_n and sample_n >= 100 else
        2 if sample_n and sample_n >= 30 else
        1
    )
    scores["DESIGN_001"] = 5 if has(r"\b(randomized|RCT|cohort|case-control|cross-sectional|multicenter|systematic review|meta-analysis|observational)\b") else 3
    scores["DESIGN_003"] = 5 if has(r"\b(pre-registered|registered|NCT\d+|ISRCTN)\b") else 1
    scores["DESIGN_011"] = 5 if has(r"\bmulti-?cent|nationwide|countries|sites\b") else 1
    scores["DESIGN_013"] = 5 if has(r"\bprospective|retrospective|follow-up|longitudinal\b") else 2
    scores["DESIGN_017"] = 4 if has(r"\bfollow-up|months?|years?\b") else 1
    # POPUL
    scores["POPUL_005"] = scores["DESIGN_005"]
    scores["POPUL_007"] = 4 if has(r"\b(male|female|men|women|boys|girls|sex|gender)\b") else 1
    scores["POPUL_008"] = 4 if has(r"\b(age|aged|years old|mean age|median age)\b") else 1
    # OUTCM / STATS
    has_p = bool(re.search(r"\bp\s*[=<>]\s*0?\.\d+", text, re.IGNORECASE))
    has_ci = bool(re.search(r"95\s*%\s*ci|confidence interval", text, re.IGNORECASE))
    has_effect = bool(re.search(r"\b(hr|or|rr|odds ratio|risk ratio|hazard ratio|95\s*%\s*ci)\b", text, re.IGNORECASE))
    scores["STATS_007"] = 5 if has_p else 1
    scores["STATS_006"] = 5 if has_ci else 1
    scores["OUTCM_037"] = 5 if has_effect and has_ci else 3 if has_effect else 1
    scores["OUTCM_038"] = 5 if has_ci else 1
    scores["STATS_005"] = scores["OUTCM_037"]
    # REPRT
    scores["REPRT_001"] = 5 if has(r"\b(CONSORT|STROBE|PRISMA|TRIPOD)\b") else 1
    scores["REPRT_013"] = 4 if has(r"\bfunding|funded|supported by|grant\b") else 1
    # BIAS
    scores["BIAS_033"] = 4 if has(r"\bfunding|funded|industry|sponsor\b") else 1
    scores["BIAS_034"] = 5 if has(r"\b(conflict of interest|competing interest|COI)\b") else 1
    # INTERP
    scores["INTERP_001"] = 4 if has(r"\b(conclusion|conclude|suggest|indicate|found)\b") else 2

    return scores, sample_n


def extract_meta(text, year=None, target_journal=None):
    """Extract paper metadata from text."""
    # Approximate counts
    pub_types_keywords = [
        "randomized controlled trial", "meta-analysis", "systematic review",
        "case report", "review", "comparative study", "multicenter",
    ]
    n_pub_types = sum(1 for kw in pub_types_keywords if kw.lower() in text.lower())
    # MeSH terms — heuristic from key medical terms density
    # 평균 corpus MeSH count ≈ 10. Rough heuristic.
    n_mesh = min(20, len(re.findall(r"\b[A-Z][a-z]+(?:\s+[a-z]+){0,2}\b", text)) // 30)
    return {
        "year": year or datetime.now().year + 1,  # assume submitting now → published next year
        "pub_year_age": 0,
        "icite_is_research_article": 1,
        "icite_is_clinical": 1 if re.search(r"\bclinical|patient|trial\b", text, re.IGNORECASE) else 0,
        "author_count": 8,  # default — user can override
        "has_first_affiliation": 1,
        "has_funder": 1 if re.search(r"\bfunding|grant|supported\b", text, re.IGNORECASE) else 0,
        "first_author_h_index": np.nan,  # cold start: unknown
        "last_author_h_index": np.nan,
        "max_team_h_index": np.nan,
        "median_team_h_index": np.nan,
        "team_size_with_id": np.nan,
        "international_collab": np.nan,
        "publication_types_count": n_pub_types,
        "mesh_terms_count": n_mesh,
        "is_preprint": 0,
    }


# ─── Build feature vector ────────────────────────────────────────────────────
def build_feature_vector(text, schema, year=None, target_journal=None):
    """Returns numpy array shaped (1, n_features) matching schema.cols order."""
    q100_items = schema["q100_items"]
    meta_cols = schema["meta_cols"]
    journal_cols = schema["journal_cols"]
    # journal_cols is [] in v0.1 (j_* removed for leakage)

    q_scores, _ = score_q100_rule(text)
    meta = extract_meta(text, year=year, target_journal=target_journal)

    row = []
    # Q100 items in order
    for it in q100_items:
        row.append(q_scores.get(it, -2))  # -2 = unknown for items rule can't score
    for c in meta_cols:
        row.append(meta.get(c, np.nan))
    for c in journal_cols:
        row.append(np.nan)  # v0.1: empty
    return np.array([row], dtype=float)


# ─── Predict ────────────────────────────────────────────────────────────────
def predict(text, year=None, target_journal=None):
    models, schema, metrics = load_models()
    X = build_feature_vector(text, schema, year=year, target_journal=target_journal)

    out = {}
    for tgt in ["y_jcr_jif", "y_icite_rcr", "y_citations_log"]:
        m = models[tgt]
        pred = float(m.predict(X, num_iteration=m.best_iteration)[0])
        m_meta = metrics.get(tgt, {})
        ci_half = m_meta.get("conformal_q90", 0)
        # Isotonic calibration
        iso_x = m_meta.get("iso_x")
        iso_y = m_meta.get("iso_y")
        pred_cal = float(np.interp(pred, iso_x, iso_y)) if iso_x else pred

        if tgt == "y_citations_log":
            # convert back from log
            point = float(np.expm1(max(0, pred_cal)))
            lo = float(np.expm1(max(0, pred_cal - ci_half)))
            hi = float(np.expm1(max(0, pred_cal + ci_half)))
        else:
            point = max(0.0, pred_cal)
            lo = max(0.0, pred_cal - ci_half)
            hi = max(0.0, pred_cal + ci_half)

        out[tgt.replace("y_", "")] = {
            "point": round(point, 2),
            "ci_low": round(lo, 2),
            "ci_high": round(hi, 2),
            "mae_baseline": m_meta.get("mae_cal"),
            "r2_baseline": m_meta.get("r2"),
        }

    return {
        "fatecore_version": "v0.1-paper-only",
        "predictions": out,
        "confidence_note": "v0.1 baseline — paper-only features (no embedding, partial author enrichment). Top tier (JIF≥30) under-predicted; mid tier (3-10) most accurate.",
    }


# ─── CLI ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--abstract", "-a", type=str, help="manuscript abstract text")
    ap.add_argument("--file", "-f", type=str, help="path to text file with abstract")
    ap.add_argument("--doi", "-d", type=str, help="DOI of existing corpus paper (compare predicted vs actual)")
    ap.add_argument("--year", "-y", type=int, default=None)
    ap.add_argument("--target-journal", type=str, default=None)
    args = ap.parse_args()

    if args.doi:
        # Lookup existing paper
        import sqlite3
        conn = sqlite3.connect(str(DATA / "paperfate.db"))
        cur = conn.cursor()
        cur.execute("SELECT title, abstract, year, journal FROM papers WHERE doi=?", (args.doi.lower(),))
        row = cur.fetchone()
        if not row:
            sys.exit(f"DOI not in corpus: {args.doi}")
        title, abstract, year, journal = row
        text = f"{title}\n\n{abstract}"
        cur.execute("SELECT jcr_jif FROM journal_year_metrics jym JOIN papers p ON p.issn=jym.issn AND p.year=jym.year WHERE p.doi=? LIMIT 1", (args.doi.lower(),))
        actual = cur.fetchone()
        actual_jif = actual[0] if actual and actual[0] else None
        conn.close()
        result = predict(text, year=year)
        print(json.dumps({
            "doi": args.doi,
            "title": title[:80],
            "journal": journal,
            "actual_jcr_jif": actual_jif,
            "fatecore": result,
        }, indent=2, ensure_ascii=False))
    else:
        if args.file:
            text = Path(args.file).read_text(encoding="utf-8")
        elif args.abstract:
            text = args.abstract
        else:
            text = sys.stdin.read()
        result = predict(text, year=args.year, target_journal=args.target_journal)
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
