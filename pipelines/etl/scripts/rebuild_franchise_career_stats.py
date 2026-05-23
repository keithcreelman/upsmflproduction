#!/usr/bin/env python3
"""
rebuild_franchise_career_stats.py — Regenerate pipelines/etl/data/franchise_career_stats.json from D1.

The roast context builder loads franchise_career_stats.json for owner W-L,
championships, playoff appearances, season-by-season finish trend, and h2h
between owners. This script rebuilds that file from D1's src_final_standings
+ src_weekly_franchise_summary + discord_owners tables.

Run periodically (manually, or via a future launchd timer) to keep career
stats fresh as new seasons complete.

Usage:
  python rebuild_franchise_career_stats.py            # writes JSON
  python rebuild_franchise_career_stats.py --dry-run  # prints, no write
"""

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
OUT_PATH = SCRIPT_DIR.parent / "data" / "franchise_career_stats.json"


def d1_query(sql: str) -> list[dict]:
    """Run a SELECT against the remote D1 via wrangler. Returns list of rows."""
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json",
         "--command", sql],
        capture_output=True, text=True,
        cwd=str(Path(__file__).resolve().parents[3] / "worker"),
    )
    if result.returncode != 0:
        sys.stderr.write(f"D1 query failed:\n{result.stderr}\n")
        sys.exit(1)
    # wrangler --json wraps results in [{ "results": [...], "success": true, ... }]
    payload = json.loads(result.stdout)
    if not payload or not isinstance(payload, list):
        return []
    return payload[0].get("results", []) or []


def load_owners() -> dict:
    """Map franchise_id → current owner_name + team_name from D1."""
    out = {}
    for r in d1_query("SELECT franchise_id, team_name, owner_name FROM discord_owners WHERE active_owner='Y';"):
        fid = str(r["franchise_id"]).zfill(4)
        out[fid] = {"owner_name": r.get("owner_name") or "", "team_name": r.get("team_name") or ""}
    return out


def load_final_standings() -> list[dict]:
    return d1_query(
        "SELECT season, franchise_id, final_finish, regular_season_finish "
        "FROM src_final_standings ORDER BY season, franchise_id;"
    )


def load_weekly_summary() -> list[dict]:
    return d1_query(
        "SELECT season, week, franchise_id, owner_name, "
        "       h2h_wins, h2h_losses, h2h_ties, h2h_games, "
        "       allplay_wins, allplay_losses, h2h_team_score "
        "FROM src_weekly_franchise_summary;"
    )


def build_stats(owners: dict, standings: list[dict], weekly: list[dict]) -> dict:
    """Build the career stats dict keyed by current franchise_id."""
    # Aggregate season-level totals per franchise per season
    season_totals = defaultdict(lambda: defaultdict(lambda: {
        "h2h_w": 0, "h2h_l": 0, "h2h_t": 0, "h2h_g": 0,
        "ap_w": 0, "ap_l": 0, "pts_for": 0.0, "weeks": 0,
        "owner_name": "",
    }))
    for w in weekly:
        fid = str(w["franchise_id"]).zfill(4)
        season = int(w["season"])
        s = season_totals[fid][season]
        s["h2h_w"] += int(w.get("h2h_wins") or 0)
        s["h2h_l"] += int(w.get("h2h_losses") or 0)
        s["h2h_t"] += int(w.get("h2h_ties") or 0)
        s["h2h_g"] += int(w.get("h2h_games") or 0)
        s["ap_w"] += int(w.get("allplay_wins") or 0)
        s["ap_l"] += int(w.get("allplay_losses") or 0)
        s["pts_for"] += float(w.get("h2h_team_score") or 0)
        s["weeks"] += 1
        if w.get("owner_name") and not s["owner_name"]:
            s["owner_name"] = w["owner_name"]

    # Index final standings
    finish_by_fs = {}  # (fid, season) → final_finish
    for r in standings:
        fid = str(r["franchise_id"]).zfill(4)
        finish_by_fs[(fid, int(r["season"]))] = int(r["final_finish"]) if r.get("final_finish") else None

    # Build per-franchise career stats
    out = {}
    for fid in sorted(set(list(owners.keys()) + list(season_totals.keys()))):
        owner_info = owners.get(fid, {})
        # Owner attribution per season — use weekly's owner_name (cleanest current source)
        seasons_with_data = sorted(season_totals.get(fid, {}).keys())
        # Determine the current owner: take from discord_owners
        current_owner = owner_info.get("owner_name", "") or (
            season_totals[fid][seasons_with_data[-1]]["owner_name"] if seasons_with_data else ""
        )
        # Owner tenure = seasons where weekly owner_name matches current owner (case-insensitive substring)
        owner_seasons = []
        for season in seasons_with_data:
            s = season_totals[fid][season]
            if not current_owner:
                owner_seasons.append(season)
            elif s["owner_name"] and current_owner.lower() in s["owner_name"].lower():
                owner_seasons.append(season)
            elif s["owner_name"] and s["owner_name"].lower() in current_owner.lower():
                owner_seasons.append(season)
            elif not s["owner_name"]:
                # No owner_name in weekly → can't disambiguate, include cautiously
                owner_seasons.append(season)

        # Owner-tenure aggregates
        owner_h2h_w = sum(season_totals[fid][s]["h2h_w"] for s in owner_seasons)
        owner_h2h_l = sum(season_totals[fid][s]["h2h_l"] for s in owner_seasons)
        owner_ap_w = sum(season_totals[fid][s]["ap_w"] for s in owner_seasons)
        owner_ap_l = sum(season_totals[fid][s]["ap_l"] for s in owner_seasons)
        owner_first = min(owner_seasons) if owner_seasons else None
        owner_finishes = [finish_by_fs.get((fid, s)) for s in owner_seasons if finish_by_fs.get((fid, s)) is not None]
        owner_chips = sum(1 for f in owner_finishes if f == 1)
        owner_playoffs = sum(1 for f in owner_finishes if f and f <= 6)  # top-6 = playoffs assumption
        owner_best = min(owner_finishes) if owner_finishes else None
        owner_worst = max(owner_finishes) if owner_finishes else None

        # Franchise-wide aggregates (all owners)
        all_seasons = seasons_with_data
        franchise_finishes = [finish_by_fs.get((fid, s)) for s in all_seasons if finish_by_fs.get((fid, s)) is not None]
        franchise_chips = sum(1 for f in franchise_finishes if f == 1)
        last_chip_season = None
        if franchise_chips:
            chip_seasons = [s for s in all_seasons if finish_by_fs.get((fid, s)) == 1]
            last_chip_season = max(chip_seasons) if chip_seasons else None
        franchise_ap_w = sum(season_totals[fid][s]["ap_w"] for s in all_seasons)
        franchise_ap_l = sum(season_totals[fid][s]["ap_l"] for s in all_seasons)
        franchise_ap_pct = (franchise_ap_w / (franchise_ap_w + franchise_ap_l)) if (franchise_ap_w + franchise_ap_l) else 0
        owner_ap_pct = (owner_ap_w / (owner_ap_w + owner_ap_l)) if (owner_ap_w + owner_ap_l) else 0

        # Trend: last 4 seasons' allplay% + final finish
        trend = []
        for s in seasons_with_data[-4:]:
            sw = season_totals[fid][s]
            ap_pct = (sw["ap_w"] / (sw["ap_w"] + sw["ap_l"])) if (sw["ap_w"] + sw["ap_l"]) else 0
            trend.append({
                "season": s,
                "allplay_pct": round(ap_pct, 3),
                "finish": finish_by_fs.get((fid, s)),
            })

        # Best/worst season (by allplay %)
        season_aps = [
            (s, (season_totals[fid][s]["ap_w"] / (season_totals[fid][s]["ap_w"] + season_totals[fid][s]["ap_l"]))
                if (season_totals[fid][s]["ap_w"] + season_totals[fid][s]["ap_l"]) else 0)
            for s in seasons_with_data
        ]
        best_season = max(season_aps, key=lambda x: x[1])[0] if season_aps else None
        worst_season = min(season_aps, key=lambda x: x[1])[0] if season_aps else None

        out[fid] = {
            "franchise_name": owner_info.get("team_name", ""),
            "seasons_played": len(all_seasons),
            "championships": franchise_chips,
            "last_championship": last_chip_season,
            "championship_drought": (max(all_seasons) - last_chip_season) if (all_seasons and last_chip_season) else (max(all_seasons) - min(all_seasons) + 1 if all_seasons else 0),
            "career_allplay_pct": round(franchise_ap_pct, 3),
            "best_season": best_season,
            "worst_season": worst_season,
            "trend": trend,
            "owner": {
                "display": current_owner,
                "first_season": owner_first,
                "seasons_count": len(owner_seasons),
                "allplay": {"w": owner_ap_w, "l": owner_ap_l},
                "allplay_pct": round(owner_ap_pct, 3),
                "overall": {"w": owner_h2h_w, "l": owner_h2h_l},
                "championships": owner_chips,
                "playoff_appearances": owner_playoffs,
                "best_finish": owner_best,
                "worst_finish": owner_worst,
            },
            "h2h": {},  # filled below
        }

    # Build h2h between franchises (current owner ↔ current owner, lifetime)
    h2h_pair = defaultdict(lambda: {"w": 0, "l": 0, "games": 0})
    for w in weekly:
        fid = str(w["franchise_id"]).zfill(4)
        my_score = float(w.get("h2h_team_score") or 0)
        for opp_idx in (1, 2, 3):
            opp_id = w.get(f"h2h_opponent{opp_idx}_id")
            opp_score = w.get(f"h2h_opponent{opp_idx}_score")
            if opp_id is None or opp_score is None:
                continue
            opp_fid = str(opp_id).zfill(4)
            if opp_fid == fid:
                continue
            opp_score = float(opp_score)
            h2h_pair[(fid, opp_fid)]["games"] += 1
            if my_score > opp_score:
                h2h_pair[(fid, opp_fid)]["w"] += 1
            elif my_score < opp_score:
                h2h_pair[(fid, opp_fid)]["l"] += 1
    for (fid, opp_fid), record in h2h_pair.items():
        if fid in out:
            out[fid]["h2h"][opp_fid] = record

    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    print("Querying D1...")
    owners = load_owners()
    print(f"  owners: {len(owners)}")
    standings = load_final_standings()
    print(f"  final standings rows: {len(standings)}")
    weekly = load_weekly_summary()
    print(f"  weekly summary rows: {len(weekly)}")

    print("Building career stats...")
    stats = build_stats(owners, standings, weekly)

    # Quick sanity sample
    sample_fids = ["0006", "0007"]
    print("\nSample:")
    for fid in sample_fids:
        s = stats.get(fid, {})
        o = s.get("owner", {})
        print(f"  {fid} {s.get('franchise_name','')}: owner={o.get('display','')} "
              f"seasons={o.get('seasons_count',0)} "
              f"allplay={o.get('allplay',{}).get('w',0)}-{o.get('allplay',{}).get('l',0)} "
              f"chips={o.get('championships',0)} "
              f"finishes={s.get('trend')}")

    if args.dry_run:
        print("\nDRY RUN — not writing")
        return

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # atomic write
    tmp = OUT_PATH.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(stats, f, indent=2)
    tmp.replace(OUT_PATH)
    print(f"\nWrote {OUT_PATH} — {len(stats)} franchises")


if __name__ == "__main__":
    main()
