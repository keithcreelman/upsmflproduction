"""refresh_prospects.py — Re-pull MFL rookie data and rewrite rookie_prospects_2026.json.

Calls build_prospects() from build_rookie_draft_hub but targets THIS repo's
site/rookies/ (not the legacy /Users/keithcreelman/Documents/New project path).

Run: python3 pipelines/etl/scripts/refresh_prospects.py
"""

from __future__ import annotations
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
OUT_FILE = REPO_ROOT / "site" / "rookies" / "rookie_prospects_2026.json"

sys.path.insert(0, str(SCRIPT_DIR))
import build_rookie_draft_hub as b  # noqa: E402

if not OUT_FILE.parent.exists():
    print(f"ERROR: output dir missing: {OUT_FILE.parent}", file=sys.stderr)
    sys.exit(1)

print(f"Refreshing {OUT_FILE}")
data = b.build_prospects()
OUT_FILE.write_text(json.dumps(data, indent=2))
print(f"  wrote {data['meta']['n_prospects']} prospects "
      f"(generated {datetime.now(timezone.utc).isoformat()})")
