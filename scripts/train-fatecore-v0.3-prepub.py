#!/usr/bin/env python
"""Train FateCore v0.3-prepub models.

This wrapper uses the v0.3 trainer with stricter defaults:
  - pre-submission-only feature CSV
  - version tag v0.3-prepub
  - random split only
"""
from __future__ import annotations

import runpy
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
DATA_ROOT = Path(__import__("os").environ.get("DATA_ROOT", ROOT / "data"))
FEATURES_DIR = DATA_ROOT / "features"
BASE = ROOT / "scripts" / "train-fatecore-v0.3.py"


def has_arg(flag: str) -> bool:
    return any(a == flag or a.startswith(flag + "=") for a in sys.argv[1:])


defaults = {
    "--features": str(FEATURES_DIR / "v0.3-prepub-features.csv"),
    "--manifest": str(FEATURES_DIR / "v0.3-prepub-features-manifest.json"),
    "--version-tag": "v0.3-prepub",
}

argv = [str(BASE)]
for flag, value in defaults.items():
    if not has_arg(flag):
        argv.extend([flag, value])
argv.extend(sys.argv[1:])
sys.argv = argv

runpy.run_path(str(BASE), run_name="__main__")
