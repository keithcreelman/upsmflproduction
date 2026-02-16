#!/usr/bin/env python3
"""Build static standings snapshot JSON for standalone HPM rendering."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_OUT = ROOT_DIR / "site" / "standings" / "standings_25625_2026.json"
API_BASE = "https://api.myfantasyleague.com"


def safe_str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def safe_int(v: Any, default: int = 0) -> int:
    try:
        return int(float(safe_str(v)))
    except Exception:
        return default


def safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(safe_str(v))
    except Exception:
        return default


def fetch_json(year: int, league_id: str, type_name: str) -> Dict[str, Any]:
    qs = urllib.parse.urlencode({"TYPE": type_name, "L": league_id, "JSON": "1"})
    url = f"{API_BASE}/{year}/export?{qs}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_wlt(text: str) -> Dict[str, int]:
    raw = safe_str(text)
    parts = raw.replace("/", "-").split("-")
    if len(parts) < 2:
        return {"w": 0, "l": 0, "t": 0}
    w = safe_int(parts[0], 0)
    l = safe_int(parts[1], 0)
    t = safe_int(parts[2], 0) if len(parts) > 2 else 0
    return {"w": w, "l": l, "t": t}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--league-id", default="25625")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    standings_payload = fetch_json(args.season, args.league_id, "leagueStandings")
    league_payload = fetch_json(args.season, args.league_id, "league")

    standings_rows = standings_payload.get("leagueStandings", {}).get("franchise", []) or []
    league_rows = league_payload.get("league", {}).get("franchises", {}).get("franchise", []) or []

    franchise_meta = {}
    for r in league_rows:
        fid = safe_str(r.get("id")).zfill(4)
        if not fid:
            continue
        franchise_meta[fid] = {
            "name": safe_str(r.get("name")) or fid,
            "icon": safe_str(r.get("icon")),
            "logo": safe_str(r.get("logo")),
            "division": safe_str(r.get("division")),
        }

    rows: List[Dict[str, Any]] = []
    for r in standings_rows:
        fid = safe_str(r.get("id")).zfill(4)
        ap = parse_wlt(r.get("all_play_wlt"))
        meta = franchise_meta.get(fid, {})
        rows.append(
            {
                "franchise_id": fid,
                "franchise_name": safe_str(meta.get("name")) or fid,
                "icon": safe_str(meta.get("icon")),
                "logo": safe_str(meta.get("logo")),
                "division": safe_str(meta.get("division")),
                "all_play": ap,
                "all_play_pct": safe_float(r.get("all_play_pct")),
                "overall": {
                    "w": safe_int(r.get("h2hw"), 0),
                    "l": safe_int(r.get("h2hl"), 0),
                    "t": 0,
                },
                "overall_pct": safe_float(r.get("h2hpct")),
                "divisional": {
                    "w": safe_int(r.get("divw"), 0),
                    "l": safe_int(r.get("divl"), 0),
                    "t": 0,
                },
                "divisional_pct": safe_float(r.get("divpct")),
                "points_for": safe_float(r.get("pf")),
                "off_points": safe_float(r.get("op")),
                "def_points": safe_float(r.get("dp")),
                "potential_points": safe_float(r.get("pp")),
                "efficiency": safe_float(r.get("eff")),
            }
        )

    rows.sort(
        key=lambda x: (
            -safe_float(x.get("all_play_pct")),
            -safe_int(x.get("all_play", {}).get("w")),
            x.get("franchise_name", ""),
        )
    )

    out = {
        "meta": {
            "league_id": safe_str(args.league_id),
            "season": int(args.season),
            "generated_at_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "source": "mfl_export",
        },
        "rows": rows,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out_path} ({len(rows)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
