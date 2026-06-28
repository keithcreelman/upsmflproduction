#!/usr/bin/env python3
"""Regenerate site/trades/extension_previews_<season>.json from the LIVE worker.

The static previews JSON is read by mobile-extend and the desktop Trade War Room
(the worker's /trade-workbench fetches it). FO v2 is always-live because the worker
/roster-workbench RECOMPUTES previews from live data per canon §C4 (Y1 = live
current-year salary; extension years = the player's AAV field + escalator). This
script materializes that same live computation into the JSON so the two JSON-reading
surfaces stay correct as contracts change.

It fetches /roster-workbench (the live, recomputed source — which already carries the
D1 salary/AAV overlay, so e.g. Downs's AAV is the real $12K, not the $7K TCV/CL
math-average), flattens each player's extension_previews (deduped to one row per
term/loading), stamps the player's CURRENT franchise (fixing stale-franchise drift),
and writes the JSON — but ONLY if the fetch looks sane, so a transient worker hiccup
never clobbers a good file. No DB, no auth, stdlib only.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

DEFAULT_WORKER = "https://upsmflproduction.keith-creelman.workers.dev"
UA = {"User-Agent": "ups-extension-previews-refresh"}
# Below this row count we treat the fetch as suspect and refuse to overwrite.
MIN_SANE_ROWS = 50


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def build_rows(data: dict, season: str) -> list[dict]:
    rows: list[dict] = []
    nid = 1
    for team in data.get("teams", []) or []:
        fid = team.get("franchise_id")
        fname = team.get("franchise_name", "")
        for p in team.get("players", []) or []:
            seen = set()
            for e in p.get("extension_previews", []) or []:
                term = str(e.get("extension_term", "")).upper()
                load = str(e.get("loaded_indicator", "NONE") or "NONE").upper()
                if not term or (term, load) in seen:
                    continue
                seen.add((term, load))
                rows.append({
                    "id": nid, "nfl_season": season,
                    "franchise_id": fid, "player_id": str(p.get("id")),
                    # Stable (NOT the fetch time) so the file is byte-identical when
                    # no contract changed — the refresh workflow then only commits
                    # on a real change, not every run.
                    "preview_ts": f"{season}-01-01 00:00:00",
                    "extension_term": term, "loaded_indicator": load,
                    "success": 1, "error_message": None,
                    "new_contract_status": e.get("new_contract_status"),
                    "new_contract_length": e.get("new_contract_length"),
                    "new_TCV": e.get("new_TCV"),
                    "new_aav_current": e.get("new_aav_current"),
                    "new_aav_future": e.get("new_aav_future"),
                    "new_contract_guarantee": e.get("new_contract_guarantee"),
                    "preview_contract_info_string": e.get("preview_contract_info_string"),
                    "franchise_name": fname, "player_name": p.get("name"),
                    "position": p.get("position"),
                    "committed": 0, "committed_ts": None, "committed_event_id": None,
                    "mfl_post_status": None, "mfl_post_ts": None, "mfl_post_error": None,
                    "reverted": 0, "reverted_ts": None, "reverted_event_id": None,
                    "mfl_revert_status": None, "mfl_revert_ts": None, "mfl_revert_error": None,
                })
                nid += 1
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker-url", default=DEFAULT_WORKER)
    ap.add_argument("--league", default="74598")
    ap.add_argument("--season", default="2026")
    ap.add_argument("--out", default="site/trades/extension_previews_2026.json")
    args = ap.parse_args()

    url = f"{args.worker_url.rstrip('/')}/roster-workbench?L={args.league}&YEAR={args.season}"
    try:
        data = fetch_json(url)
    except Exception as exc:  # noqa: BLE001
        print(f"[refresh-ext-previews] fetch failed, leaving JSON untouched: {exc}", file=sys.stderr)
        return 0  # fail-open: never clobber a good file on a transient error

    if not isinstance(data, dict) or not data.get("teams"):
        print("[refresh-ext-previews] response had no teams; leaving JSON untouched.", file=sys.stderr)
        return 0

    rows = build_rows(data, args.season)
    if len(rows) < MIN_SANE_ROWS:
        print(f"[refresh-ext-previews] only {len(rows)} rows (< {MIN_SANE_ROWS}); suspect — leaving JSON untouched.", file=sys.stderr)
        return 0

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as fh:
        json.dump(rows, fh, indent=1)
        fh.write("\n")
    print(f"[refresh-ext-previews] wrote {len(rows)} rows → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
