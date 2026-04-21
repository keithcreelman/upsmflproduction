"""
load_standings_history.py — Aggregate multi-year standings into per-franchise career stats.

Loads standings_74598_*.json files (2017-2025) and builds:
- Career allplay record and win%
- Best/worst seasons
- Year-over-year trends
- H2H records between any two franchises
- Championship drought tracking

Output: franchise_career_stats.json
"""

import json
import glob
from pathlib import Path
from collections import defaultdict

STANDINGS_DIR = Path("/Users/keithcreelman/Documents/mfl/Codex/V1/legacy_snapshot/site/standings")
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "franchise_career_stats.json"

# League changed MFL league IDs over the years but franchise IDs stayed consistent
LEAGUE_IDS_BY_SEASON = {
    2010: "60671", 2011: "40832", 2012: "37227", 2013: "42721",
    2014: "30590", 2015: "29015", 2016: "27191",
    2017: "74598", 2018: "74598", 2019: "74598", 2020: "74598",
    2021: "74598", 2022: "74598", 2023: "74598", 2024: "74598",
    2025: "74598",
}

# Owner tenure: franchise_id -> {owner_name, first_season, display_name}
# Only seasons >= first_season count as "their" record.
# Prior seasons are franchise history only.
OWNER_TENURE = {
    "0001": {"owner": "Ryan Bousquet", "first_season": 2017, "display": "Ryan Bousquet"},
    # Whitman had 0002 from 2010-2016, left mid-2017 (AJ/Rico replaced him),
    # AJ/Rico ran it 2017-2021, got kicked mid-2022 for collusion.
    # Whitman came BACK in 2023. His current tenure = 2023+.
    # 2017 data belongs to Whitman (he was there most of the season).
    "0002": {"owner": "Derrick Whitman", "first_season": 2023, "display": "Derrick Whitman"},
    "0003": {"owner": "Matt Gerardi", "first_season": 2017, "display": "Matt Gerardi"},
    "0004": {"owner": "Brian Cutting", "first_season": 2017, "display": "Brian Cutting"},
    "0005": {"owner": "Eric Martel", "first_season": 2023, "display": "Eric Martel"},
    "0006": {"owner": "Brian Cross", "first_season": 2025, "display": "Brian Cross"},
    "0007": {"owner": "Josh Martel", "first_season": 2017, "display": "Josh Martel"},
    "0008": {"owner": "Keith Creelman", "first_season": 2017, "display": "Keith Creelman"},
    "0009": {"owner": "Bear Dunn", "first_season": 2017, "display": "Bear Dunn"},
    "0010": {"owner": "Shawn Blake", "first_season": 2017, "display": "Shawn Blake"},
    "0011": {"owner": "Eric Mannila", "first_season": 2017, "display": "Eric Mannila"},
    "0012": {"owner": "Chris Klingenberg", "first_season": 2017, "display": "Chris Klingenberg"},
}


FINALS_DB = Path("/Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db")


def _load_final_standings() -> dict:
    """Load final finish positions (including playoffs) from metadata_finalstandings.
    Returns {(franchise_id, year): {final_finish, regular_season_finish, franchise_name}}.
    """
    import sqlite3
    out = {}
    if not FINALS_DB.exists():
        return out
    conn = sqlite3.connect(str(FINALS_DB))
    conn.row_factory = sqlite3.Row
    for row in conn.execute("SELECT * FROM metadata_finalstandings"):
        key = (row["franchise_id"], row["year"])
        out[key] = {
            "final_finish": row["final_finish"],
            "regular_season_finish": row["regular_season_finish"],
            "franchise_name": row["franchise"],
        }
    conn.close()
    return out


def load_all_standings() -> list:
    """Load all standings JSONs across all league IDs, sorted by season."""
    seasons = []
    current_year = 2026  # exclude current season — no games played yet
    for season_yr, league_id in sorted(LEAGUE_IDS_BY_SEASON.items()):
        if season_yr >= current_year:
            continue
        fpath = STANDINGS_DIR / f"standings_{league_id}_{season_yr}.json"
        if not fpath.exists():
            continue
        with open(fpath) as fh:
            data = json.load(fh)
        seasons.append({"season": season_yr, "data": data})
    return seasons


def build_career_stats(seasons: list) -> dict:
    """Build per-franchise career stats from all seasons."""
    franchises = defaultdict(lambda: {
        "franchise_id": "",
        "franchise_name": "",
        "seasons": [],
        "career_allplay": {"w": 0, "l": 0, "t": 0},
        "career_allplay_pct": 0.0,
        "career_overall": {"w": 0, "l": 0, "t": 0},
        "career_overall_pct": 0.0,
        "career_points_for": 0.0,
        "best_season": None,
        "worst_season": None,
        "best_allplay_pct": 0.0,
        "worst_allplay_pct": 1.0,
        "best_finish": 99,
        "worst_finish": 0,
        "championships": 0,
        "playoff_appearances": 0,
        "championship_drought": 0,
        "last_championship": None,
        "h2h": defaultdict(lambda: {"w": 0, "l": 0, "t": 0, "games": 0}),
        "trend": [],  # last 3 seasons allplay_pct
        "seasons_played": 0,
    })

    for season_data in seasons:
        season = season_data["season"]
        rows = season_data["data"].get("rows", [])

        # Sort by overall_pct descending to determine finish position
        sorted_rows = sorted(rows, key=lambda r: float(r.get("overall_pct", 0)), reverse=True)
        finish_map = {r["franchise_id"]: i + 1 for i, r in enumerate(sorted_rows)}

        for row in rows:
            fid = row["franchise_id"]
            f = franchises[fid]
            f["franchise_id"] = fid
            f["franchise_name"] = row.get("franchise_name", f.get("franchise_name", ""))
            f["seasons_played"] += 1

            # Allplay
            ap = row.get("all_play", {})
            ap_w = int(ap.get("w", 0))
            ap_l = int(ap.get("l", 0))
            ap_t = int(ap.get("t", 0))
            ap_pct = float(row.get("all_play_pct", 0))

            f["career_allplay"]["w"] += ap_w
            f["career_allplay"]["l"] += ap_l
            f["career_allplay"]["t"] += ap_t

            # Overall
            ov = row.get("overall", {})
            ov_w = int(ov.get("w", 0))
            ov_l = int(ov.get("l", 0))
            ov_t = int(ov.get("t", 0))

            f["career_overall"]["w"] += ov_w
            f["career_overall"]["l"] += ov_l
            f["career_overall"]["t"] += ov_t

            # Points
            pf = float(row.get("points_for", 0))
            f["career_points_for"] += pf

            # Finish (preliminary — will be overridden by final standings DB later)
            finish = finish_map.get(fid, 99)

            # H2H
            h2h = row.get("h2h", {})
            for opp_id, record in h2h.items():
                f["h2h"][opp_id]["w"] += int(record.get("w", 0))
                f["h2h"][opp_id]["l"] += int(record.get("l", 0))
                f["h2h"][opp_id]["t"] += int(record.get("t", 0))
                f["h2h"][opp_id]["games"] += int(record.get("games", 0))

            # Season entry
            f["seasons"].append({
                "season": season,
                "allplay": {"w": ap_w, "l": ap_l, "t": ap_t},
                "allplay_pct": ap_pct,
                "overall": {"w": ov_w, "l": ov_l, "t": ov_t},
                "overall_pct": float(row.get("overall_pct", 0)),
                "points_for": pf,
                "finish": finish,
                "efficiency": float(row.get("efficiency", 0)),
            })

    # Load final standings from database for accurate championship/finish data
    final_standings = _load_final_standings()

    # Override finish positions with database values (which include playoff results)
    for fid, f in franchises.items():
        for season_entry in f["seasons"]:
            yr = season_entry["season"]
            key = (fid, yr)
            if key in final_standings:
                season_entry["finish"] = final_standings[key]["final_finish"]
                season_entry["reg_season_finish"] = final_standings[key]["regular_season_finish"]

    # Second pass: compute championship/finish stats from FINAL standings
    # (must happen after the override so we use playoff results, not reg season)
    for fid, f in franchises.items():
        f["championships"] = 0
        f["playoff_appearances"] = 0
        f["last_championship"] = None
        f["best_finish"] = 99
        f["worst_finish"] = 0
        for s in f["seasons"]:
            finish = s.get("finish", 99)
            ap_pct = s.get("allplay_pct", 0)
            season = s["season"]
            if finish == 1:
                f["championships"] += 1
                f["last_championship"] = season
            if finish <= 6:
                f["playoff_appearances"] += 1
            if finish < f["best_finish"]:
                f["best_finish"] = finish
            if finish > f["worst_finish"]:
                f["worst_finish"] = finish
            if ap_pct > f.get("best_allplay_pct", 0):
                f["best_allplay_pct"] = ap_pct
                f["best_season"] = {"season": season, "allplay_pct": ap_pct,
                                     "record": f"{s['allplay']['w']}-{s['allplay']['l']}", "finish": finish}
            if ap_pct < f.get("worst_allplay_pct", 1.0):
                f["worst_allplay_pct"] = ap_pct
                f["worst_season"] = {"season": season, "allplay_pct": ap_pct,
                                      "record": f"{s['allplay']['w']}-{s['allplay']['l']}", "finish": finish}

    # Post-processing
    latest_season = max(s["season"] for s in seasons) if seasons else 2025
    for fid, f in franchises.items():
        total_ap = f["career_allplay"]["w"] + f["career_allplay"]["l"] + f["career_allplay"]["t"]
        if total_ap > 0:
            f["career_allplay_pct"] = round(f["career_allplay"]["w"] / total_ap, 3)

        total_ov = f["career_overall"]["w"] + f["career_overall"]["l"] + f["career_overall"]["t"]
        if total_ov > 0:
            f["career_overall_pct"] = round(f["career_overall"]["w"] / total_ov, 3)

        # Championship drought
        if f["last_championship"]:
            f["championship_drought"] = latest_season - f["last_championship"]
        else:
            f["championship_drought"] = f["seasons_played"]

        # Trend (last 3 seasons)
        recent = sorted(f["seasons"], key=lambda s: s["season"], reverse=True)[:3]
        f["trend"] = [{"season": s["season"], "allplay_pct": s["allplay_pct"],
                        "finish": s["finish"]} for s in recent]

        # Convert h2h defaultdict to regular dict
        f["h2h"] = dict(f["h2h"])

        # Owner-specific stats (only seasons under current owner)
        tenure = OWNER_TENURE.get(fid, {})
        owner_first = tenure.get("first_season", 2017)
        owner_name = tenure.get("owner", "")
        owner_display = tenure.get("display", "")
        owner_seasons = [s for s in f["seasons"] if s["season"] >= owner_first]

        owner_ap = {"w": 0, "l": 0, "t": 0}
        owner_ov = {"w": 0, "l": 0, "t": 0}
        owner_champs = 0
        owner_playoffs = 0
        owner_best_finish = 99
        owner_worst_finish = 0
        owner_best_pct = 0.0
        owner_worst_pct = 1.0

        for s in owner_seasons:
            ap = s["allplay"]
            owner_ap["w"] += ap["w"]
            owner_ap["l"] += ap["l"]
            owner_ap["t"] += ap["t"]
            ov = s["overall"]
            owner_ov["w"] += ov["w"]
            owner_ov["l"] += ov["l"]
            owner_ov["t"] += ov["t"]
            if s["finish"] == 1:
                owner_champs += 1
            if s["finish"] <= 6:
                owner_playoffs += 1
            if s["finish"] < owner_best_finish:
                owner_best_finish = s["finish"]
            if s["finish"] > owner_worst_finish:
                owner_worst_finish = s["finish"]
            if s["allplay_pct"] > owner_best_pct:
                owner_best_pct = s["allplay_pct"]
            if s["allplay_pct"] < owner_worst_pct:
                owner_worst_pct = s["allplay_pct"]

        owner_total_ap = owner_ap["w"] + owner_ap["l"] + owner_ap["t"]
        owner_ap_pct = round(owner_ap["w"] / owner_total_ap, 3) if owner_total_ap > 0 else 0

        f["owner"] = {
            "name": owner_name,
            "display": owner_display,
            "first_season": owner_first,
            "seasons_count": len(owner_seasons),
            "allplay": owner_ap,
            "allplay_pct": owner_ap_pct,
            "overall": owner_ov,
            "championships": owner_champs,
            "playoff_appearances": owner_playoffs,
            "best_finish": owner_best_finish if owner_best_finish < 99 else None,
            "worst_finish": owner_worst_finish if owner_worst_finish > 0 else None,
            "best_allplay_pct": owner_best_pct,
            "worst_allplay_pct": owner_worst_pct if owner_worst_pct < 1.0 else None,
            "seasons": owner_seasons,
        }

    return dict(franchises)


def main():
    print("Loading standings history...")
    seasons = load_all_standings()
    print(f"  Found {len(seasons)} seasons: {[s['season'] for s in seasons]}")

    stats = build_career_stats(seasons)
    print(f"  Built stats for {len(stats)} franchises")

    # Summary
    for fid in sorted(stats.keys()):
        f = stats[fid]
        ap = f["career_allplay"]
        print(f"  {f['franchise_name']:<25} "
              f"AP: {ap['w']}-{ap['l']} ({f['career_allplay_pct']:.3f})  "
              f"Champs: {f['championships']}  "
              f"Drought: {f['championship_drought']}yr  "
              f"Best: #{f['best_finish']}  Worst: #{f['worst_finish']}")

    # Write output
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as fout:
        json.dump(stats, fout, indent=2, default=str)
    print(f"\nWrote: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
