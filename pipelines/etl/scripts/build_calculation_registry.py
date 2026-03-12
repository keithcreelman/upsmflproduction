#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
REPO_ROOT = ETL_ROOT.parent.parent
if str(ETL_ROOT) not in sys.path:
    sys.path.insert(0, str(ETL_ROOT))

from lib.calculation_registry import (  # noqa: E402
    CALCULATION_REGISTRY_PATHS,
    build_calculation_registry,
    render_registry_markdown,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Acquisition Value Score calculation registry artifacts.")
    parser.add_argument("--json-path", default=str(REPO_ROOT / CALCULATION_REGISTRY_PATHS["json"]))
    parser.add_argument("--markdown-path", default=str(REPO_ROOT / CALCULATION_REGISTRY_PATHS["markdown"]))
    return parser.parse_args()


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main() -> int:
    args = parse_args()
    registry = build_calculation_registry()
    json_path = Path(args.json_path).resolve()
    markdown_path = Path(args.markdown_path).resolve()
    write_json(json_path, registry)
    write_text(markdown_path, render_registry_markdown(registry))
    print(f"Wrote {json_path}")
    print(f"Wrote {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
