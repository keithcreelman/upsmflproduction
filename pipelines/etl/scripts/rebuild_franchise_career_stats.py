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
    """Build the career stats dict keyed by current franchise_id.

    Owner-tenure attribution rule (Keith 2026-05-22):
      An owner is credited with a season ONLY if they owned the franchise
      for the WHOLE season (zero mid-season transitions). Seasons where
      multiple owner_name values appear across the weekly summary are
      "transition seasons" — excluded from owner-tenure stats for ANY
      owner involved. Final-standings finish/championship attribution
      uses the season-end owner (whoever was there at the last week).
    """
    # Per-season totals (franchise-wide)
    season_totals = defaultdict(lambda: defaultdict(lambda: {
        "h2h_w": 0, "h2h_l": 0, "h2h_t": 0, "h2h_g": 0,
        "ap_w": 0, "ap_l": 0, "pts_for": 0.0, "weeks": 0,
    }))
    # Track all distinct owner_names per (fid, season) for transition detection
    season_owners_seen = defaultdict(lambda: defaultdict(set))
    # Track the LATEST-week owner per (fid, season) for end-of-season attribution
    season_end_owner = defaultdict(dict)  # season_end_owner[fid][season] = (max_week, owner_name)

    for w in weekly:
        fid = str(w["franchise_id"]).zfill(4)
        season = int(w["season"])
        week = int(w.get("week") or 0)
        s = season_totals[fid][season]
        s["h2h_w"] += int(w.get("h2h_wins") or 0)
        s["h2h_l"] += int(w.get("h2h_losses") or 0)
        s["h2h_t"] += int(w.get("h2h_ties") or 0)
        s["h2h_g"] += int(w.get("h2h_games") or 0)
        s["ap_w"] += int(w.get("allplay_wins") or 0)
        s["ap_l"] += int(w.get("allplay_losses") or 0)
        s["pts_for"] += float(w.get("h2h_team_score") or 0)
        s["weeks"] += 1
        owner_nm = (w.get("owner_name") or "").strip()
        if owner_nm:
            season_owners_seen[fid][season].add(owner_nm)
            # Track the latest week's owner
            prior = season_end_owner[fid].get(season)
            if prior is None or week > prior[0]:
                season_end_owner[fid][season] = (week, owner_nm)

    # Index final standings
    finish_by_fs = {}  # (fid, season) → final_finish
    for r in standings:
        fid = str(r["franchise_id"]).zfill(4)
        finish_by_fs[(fid, int(r["season"]))] = int(r["final_finish"]) if r.get("final_finish") else None

    # Build per-franchise career stats
    out = {}
    for fid in sorted(set(list(owners.keys()) + list(season_totals.keys()))):
        owner_info = owners.get(fid, {})
        seasons_with_data = sorted(season_totals.get(fid, {}).keys())
        # Determine the current owner: take from discord_owners (canonical)
        current_owner = owner_info.get("owner_name", "") or (
            list(season_owners_seen[fid][seasons_with_data[-1]])[0]
            if seasons_with_data and season_owners_seen[fid][seasons_with_data[-1]]
            else ""
        )
        # Owner tenure = WHOLE-SEASON-ONLY rule:
        #   include season iff (current_owner is the only owner_name seen
        #   across all weeks of that season). Transition seasons are
        #   excluded from owner-tenure stats entirely.
        owner_seasons = []
        transition_seasons = []
        for season in seasons_with_data:
            owners_seen = season_owners_seen[fid].get(season, set())
            if not owners_seen:
                # No owner_name data — can't attribute, skip
                continue
            if len(owners_seen) >= 2:
                # Multi-owner season → transition, exclude from tenure
                transition_seasons.append(season)
                continue
            # Exactly one owner_name across all weeks → check match
            sole_owner = next(iter(owners_seen))
            if not current_owner:
                owner_seasons.append(season)
            elif current_owner.lower() == sole_owner.lower():
                owner_seasons.append(season)
            elif current_owner.lower() in sole_owner.lower() or sole_owner.lower() in current_owner.lower():
                # Allow substring match for nickname variations (e.g. "Brian" vs "Brian Cross")
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
            # Transition seasons (multi-owner mid-year takeovers) — excluded
            # from owner-tenure stats. Surfaced so the trade-counter logic
            # can build trade_exclusions windows from these, and so the
            # roast prompt can avoid attributing inherited rosters.
            "transition_seasons": transition_seasons,
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
