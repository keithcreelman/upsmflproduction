#!/usr/bin/env python3
import sys
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from rulebook_core import MFL_MANIFEST_PATH, fetch_mfl_sources


def main():
    manifest = fetch_mfl_sources()
    completed = sum(1 for item in manifest.get("seasons", []) if item.get("files"))
    print(f"Wrote {MFL_MANIFEST_PATH}")
    print(f"Fetched {completed} season snapshot sets.")
    if manifest.get("warnings"):
        print(f"Warnings: {len(manifest['warnings'])}")


if __name__ == "__main__":
    main()
