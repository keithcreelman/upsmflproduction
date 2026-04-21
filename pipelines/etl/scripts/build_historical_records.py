"""
build_historical_records.py — Generate the UPS Historical Records JSON.

Aggregates ALL league history (2010-2025) into a single comprehensive JSON
for the Historical Records HPM module:
- Franchise records (all-time, by owner, by era)
- Divisional history (realignment every 3 years starting 2011)
- Matchup records (H2H, high/low scores)
- Playoff/Toilet Bowl finishes
- Hall of Shame (sub-.200 allplay, booted owners)
- Scoring records (season, career, weekly)
- "As-of" vs "Current" data framing

Output: historical_records_{leagueId}_{year}.json
"""

import json
import sqlite3
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR.parent / "data"
STANDINGS_DIR = Path("/Users/keithcreelman/Documents/mfl/Codex/V1/legacy_snapshot/site/standings")
OUTPUT_DIR = Path("/Users/keithcreelman/Documents/mfl/Codex/V1/legacy_snapshot/site/historical_records")
FINALS_DB = DATA_DIR / "mfl_database.db"
CAREER_STATS = DATA_DIR / "franchise_career_stats.json"

LEAGUE_IDS = {
    2010: "60671", 2011: "40832", 2012: "37227", 2013: "42721",
    2014: "30590", 2015: "29015", 2016: "27191",
    2017: "74598", 2018: "74598", 2019: "74598", 2020: "74598",
    2021: "74598", 2022: "74598", 2023: "74598", 2024: "74598",
    2025: "74598",
}

# Divisional realignment: every 3 years starting 2011 as Year 1
# Year 1 of each era defines divisions for 3 seasons
ERAS = [
    {"name": "Era 1", "seasons": [2011, 2012, 2013]},
    {"name": "Era 2", "seasons": [2014, 2015, 2016]},
    {"name": "Era 3", "seasons": [2017, 2018, 2019]},
    {"name": "Era 4", "seasons": [2020, 2021, 2022]},
    {"name": "Era 5", "seasons": [2023, 2024, 2025]},
]

# Owner tenure map (franchise_id -> list of owners with seasons)
OWNER_HISTORY = {
    "0001": [
        {"owner": "Steve Bousquet", "seasons": list(range(2010, 2017)), "display": "Steve Bousquet"},
        {"owner": "Ryan Bousquet", "seasons": list(range(2017, 2026)), "display": "Ryan Bousquet"},
    ],
    "0002": [
        {"owner": "Derrick Whitman", "seasons": list(range(2010, 2017)), "display": "Derrick Whitman (1st stint)"},
        {"owner": "AJ & Rico", "seasons": [2017, 2018, 2019, 2020, 2021, 2022],
         "display": "AJ & Rico Balderelli", "booted": True, "booted_reason": "Colluding in auctions and waiver bids"},
        {"owner": "Derrick Whitman", "seasons": list(range(2023, 2026)), "display": "Derrick Whitman (2nd stint)"},
    ],
    "0003": [
        {"owner": "Matt Gerardi", "seasons": list(range(2010, 2026)), "display": "Matt Gerardi"},
    ],
    "0004": [
        {"owner": "Brian Cutting", "seasons": list(range(2010, 2026)), "display": "Brian Cutting"},
    ],
    "0005": [
        {"owner": "Various", "seasons": list(range(2010, 2017)), "display": "BTNH Era"},
        {"owner": "John Richard & Jarrade Nieber", "seasons": [2017, 2018], "display": "John Richard & Jarrade Nieber"},
        {"owner": "Rico Balderelli", "seasons": [2019, 2020, 2021],
         "display": "Rico Balderelli", "booted": True, "booted_reason": "Colluding with AJ (0002)"},
        {"owner": "Eric Martel", "seasons": list(range(2023, 2026)), "display": "Eric Martel"},
    ],
    "0006": [
        {"owner": "Various", "seasons": [2010, 2011]},
        {"owner": "Steve Bousquet", "seasons": list(range(2012, 2023)), "display": "Steve Bousquet"},
        {"owner": "Josh Lima", "seasons": [2023], "display": "Josh Lima",
         "booted": True, "booted_reason": "Removed from league"},
        {"owner": "Brian Cross", "seasons": list(range(2025, 2026)), "display": "Brian Cross"},
    ],
    "0007": [
        {"owner": "Josh Martel", "seasons": list(range(2010, 2026)), "display": "Josh Martel"},
    ],
    "0008": [
        {"owner": "Keith Creelman", "seasons": list(range(2010, 2026)), "display": "Keith Creelman"},
    ],
    "0009": [
        {"owner": "Bear Dunn", "seasons": list(range(2010, 2026)), "display": "Bear Dunn"},
    ],
    "0010": [
        {"owner": "Shawn Blake", "seasons": list(range(2010, 2026)), "display": "Shawn Blake"},
    ],
    "0011": [
        {"owner": "Eric Mannila", "seasons": list(range(2010, 2026)), "display": "Eric Mannila"},
    ],
    "0012": [
        {"owner": "Chris Klingenberg", "seasons": list(range(2010, 2026)), "display": "Chris Klingenberg"},
    ],
}


def load_all_standings():
    """Load all standings JSONs across all league IDs."""
    seasons = {}
    for yr, lid in sorted(LEAGUE_IDS.items()):
        fpath = STANDINGS_DIR / f"standings_{lid}_{yr}.json"
        if fpath.exists():
            with open(fpath) as f:
                seasons[yr] = json.load(f)
    return seasons


def load_final_standings():
    """Load final standings from database."""
    out = {}
    conn = sqlite3.connect(str(FINALS_DB))
    conn.row_factory = sqlite3.Row
    for row in conn.execute("SELECT * FROM metadata_finalstandings"):
        key = (row["franchise_id"], row["year"])
        out[key] = dict(row)
    conn.close()
    return out


def load_career_stats():
    if CAREER_STATS.exists():
        with open(CAREER_STATS) as f:
            return json.load(f)
    return {}


def get_owner_for_season(fid, season):
    """Get the owner info for a franchise in a given season."""
    for entry in OWNER_HISTORY.get(fid, []):
        if season in entry.get("seasons", []):
            return entry
    return {"owner": "Unknown", "display": "Unknown"}


def build_franchise_records(standings, finals, career):
    """Build franchise-level records."""
    franchises = {}
    for fid in [f"000{i}" if i < 10 else f"00{i}" for i in range(1, 13)]:
        fid_str = fid.zfill(4)
        cs = career.get(fid_str, {})
        owner_data = cs.get("owner", {})

        # Season-by-season record with final finishes
        season_records = []
        for yr in sorted(LEAGUE_IDS.keys()):
            key = (fid_str, yr)
            if key in finals:
                fs = finals[key]
                # Get allplay from standings
                ap_data = {}
                if yr in standings:
                    for row in standings[yr].get("rows", []):
                        if row.get("franchise_id") == fid_str:
                            ap_data = row
                            break

                owner = get_owner_for_season(fid_str, yr)
                season_records.append({
                    "season": yr,
                    "team_name": fs.get("franchise", ""),
                    "owner": owner.get("display", "Unknown"),
                    "regular_season_finish": fs.get("regular_season_finish"),
                    "final_finish": fs.get("final_finish"),
                    "playoff": fs.get("final_finish", 99) <= 6,
                    "champion": fs.get("final_finish") == 1,
                    "toilet_bowl": fs.get("final_finish", 0) >= 7,
                    "allplay_pct": float(ap_data.get("all_play_pct", 0)),
                    "points_for": float(ap_data.get("points_for", 0)),
                    "efficiency": float(ap_data.get("efficiency", 0)),
                })

        # Aggregate stats
        champs = [s for s in season_records if s["champion"]]
        playoffs = [s for s in season_records if s["playoff"]]
        toilet = [s for s in season_records if s["toilet_bowl"]]

        franchises[fid_str] = {
            "franchise_id": fid_str,
            "current_name": cs.get("franchise_name", ""),
            "current_owner": owner_data.get("display", ""),
            "owner_since": owner_data.get("first_season", 2010),
            "seasons": season_records,
            "total_seasons": len(season_records),
            "championships": len(champs),
            "championship_seasons": [s["season"] for s in champs],
            "playoff_appearances": len(playoffs),
            "toilet_bowl_appearances": len(toilet),
            "career_allplay": cs.get("career_allplay", {}),
            "career_allplay_pct": cs.get("career_allplay_pct", 0),
            "owner_history": OWNER_HISTORY.get(fid_str, []),
        }

    return franchises


def build_matchup_records(standings):
    """Build H2H matchup records and scoring records."""
    all_matchups = []
    weekly_scores = []  # (season, week, franchise_id, score)
    season_totals = defaultdict(lambda: defaultdict(float))  # fid -> season -> total

    for yr, data in sorted(standings.items()):
        ws = data.get("weeklyScores", {})
        wm = data.get("weeklyMatchups", {})

        for week_str in sorted(ws.keys(), key=lambda x: int(x)):
            week = int(week_str)
            scores = ws[week_str]
            matchups = wm.get(week_str, [])

            # Weekly scores
            if isinstance(scores, dict):
                for fid, score in scores.items():
                    sc = float(score)
                    weekly_scores.append({
                        "season": yr, "week": week,
                        "franchise_id": fid, "score": sc,
                    })
                    season_totals[fid][yr] += sc

            # Matchup results
            if isinstance(matchups, list):
                for m in matchups:
                    home = m.get("home", "")
                    away = m.get("away", "")
                    hs = float(m.get("homeScore", 0))
                    as_ = float(m.get("awayScore", 0))
                    if home and away and (hs > 0 or as_ > 0):
                        all_matchups.append({
                            "season": yr, "week": week,
                            "home": home, "away": away,
                            "home_score": hs, "away_score": as_,
                            "margin": abs(hs - as_),
                            "total": hs + as_,
                            "winner": home if hs > as_ else away,
                        })

    # Scoring records
    weekly_scores.sort(key=lambda x: -x["score"])
    highest_weekly = weekly_scores[:25] if weekly_scores else []
    lowest_weekly = sorted([s for s in weekly_scores if s["score"] > 0],
                           key=lambda x: x["score"])[:25]

    # Biggest blowouts
    all_matchups.sort(key=lambda x: -x["margin"])
    biggest_blowouts = all_matchups[:25]

    # Closest games
    close = sorted([m for m in all_matchups if m["margin"] > 0],
                   key=lambda x: x["margin"])[:25]

    # Highest combined scores
    all_matchups.sort(key=lambda x: -x["total"])
    highest_combined = all_matchups[:25]

    # Season scoring records
    season_records = []
    for fid, seasons in season_totals.items():
        for yr, total in seasons.items():
            season_records.append({
                "franchise_id": fid, "season": yr, "total_points": round(total, 1),
            })
    season_records.sort(key=lambda x: -x["total_points"])

    # H2H all-time series
    h2h = defaultdict(lambda: {"wins": 0, "losses": 0, "ties": 0, "games": 0,
                                "points_for": 0, "points_against": 0})
    for m in all_matchups:
        if m["home_score"] > m["away_score"]:
            h2h[(m["home"], m["away"])]["wins"] += 1
            h2h[(m["away"], m["home"])]["losses"] += 1
        elif m["away_score"] > m["home_score"]:
            h2h[(m["away"], m["home"])]["wins"] += 1
            h2h[(m["home"], m["away"])]["losses"] += 1
        else:
            h2h[(m["home"], m["away"])]["ties"] += 1
            h2h[(m["away"], m["home"])]["ties"] += 1

        h2h[(m["home"], m["away"])]["games"] += 1
        h2h[(m["away"], m["home"])]["games"] += 1
        h2h[(m["home"], m["away"])]["points_for"] += m["home_score"]
        h2h[(m["home"], m["away"])]["points_against"] += m["away_score"]
        h2h[(m["away"], m["home"])]["points_for"] += m["away_score"]
        h2h[(m["away"], m["home"])]["points_against"] += m["home_score"]

    h2h_series = []
    seen = set()
    for (f1, f2), record in h2h.items():
        pair = tuple(sorted([f1, f2]))
        if pair not in seen:
            seen.add(pair)
            r1 = h2h[(f1, f2)]
            r2 = h2h[(f2, f1)]
            h2h_series.append({
                "team_a": f1, "team_b": f2,
                "a_wins": r1["wins"], "a_losses": r1["losses"],
                "a_ties": r1["ties"], "games": r1["games"],
                "a_points": round(r1["points_for"], 1),
                "b_points": round(r2["points_for"], 1),
            })

    return {
        "highest_weekly_scores": highest_weekly,
        "lowest_weekly_scores": lowest_weekly,
        "biggest_blowouts": biggest_blowouts,
        "closest_games": close,
        "highest_combined_scores": highest_combined,
        "season_scoring_leaders": season_records[:25],
        "h2h_series": h2h_series,
    }


def build_divisional_history(standings):
    """Build divisional records by era (3-year alignment windows)."""
    eras_data = []
    for era in ERAS:
        era_entry = {
            "name": era["name"],
            "seasons": era["seasons"],
            "divisions": {},
        }
        # Get divisions from the first season of the era
        first_season = era["seasons"][0]
        if first_season in standings:
            rows = standings[first_season].get("rows", [])
            divs = defaultdict(list)
            for row in rows:
                div = row.get("division_name", row.get("division", "Unknown"))
                divs[div].append(row.get("franchise_id", ""))

            for div_name, members in divs.items():
                era_entry["divisions"][div_name] = {
                    "members": members,
                    "seasons_together": len(era["seasons"]),
                }
        eras_data.append(era_entry)

    return eras_data


def build_hall_of_shame(standings, finals):
    """Build the Hall of Shame: sub-.200 allplay seasons, booted owners, worst finishes."""
    shame_entries = []

    # Sub-.200 allplay seasons
    for yr, data in standings.items():
        for row in data.get("rows", []):
            ap_pct = float(row.get("all_play_pct", 0))
            if 0 < ap_pct < 0.200:
                fid = row.get("franchise_id", "")
                owner = get_owner_for_season(fid, yr)
                shame_entries.append({
                    "type": "sub_200_allplay",
                    "season": yr,
                    "franchise_id": fid,
                    "team_name": row.get("franchise_name", ""),
                    "owner": owner.get("display", "Unknown"),
                    "allplay_pct": ap_pct,
                    "description": f"{ap_pct:.3f} allplay — historically bad",
                })

    # Booted owners
    for fid, owners in OWNER_HISTORY.items():
        for entry in owners:
            if entry.get("booted"):
                shame_entries.append({
                    "type": "booted_owner",
                    "franchise_id": fid,
                    "owner": entry["display"],
                    "reason": entry.get("booted_reason", "Removed from league"),
                    "seasons": entry["seasons"],
                    "description": f"Kicked out: {entry.get('booted_reason', 'Unknown reason')}",
                })

    # Worst single-week scores (already captured in matchup records)

    return shame_entries


def build_three_year_windows(standings):
    """Build 3-year rolling window stats aligned with divisional eras."""
    windows = []
    for era in ERAS:
        window = {"name": era["name"], "seasons": era["seasons"], "franchises": {}}
        for fid_num in range(1, 13):
            fid = f"000{fid_num}" if fid_num < 10 else f"00{fid_num}"
            fid = fid.zfill(4)
            total_ap_w, total_ap_l, total_pf = 0, 0, 0.0
            season_finishes = []
            for yr in era["seasons"]:
                if yr in standings:
                    for row in standings[yr].get("rows", []):
                        if row.get("franchise_id") == fid:
                            ap = row.get("all_play", {})
                            total_ap_w += int(ap.get("w", 0))
                            total_ap_l += int(ap.get("l", 0))
                            total_pf += float(row.get("points_for", 0))
                            break
            total = total_ap_w + total_ap_l
            pct = round(total_ap_w / total, 3) if total > 0 else 0
            window["franchises"][fid] = {
                "allplay_w": total_ap_w, "allplay_l": total_ap_l,
                "allplay_pct": pct, "total_points": round(total_pf, 1),
            }
        windows.append(window)
    return windows


def main():
    print("Building UPS Historical Records...")

    standings = load_all_standings()
    print(f"  Loaded {len(standings)} seasons of standings")

    finals = load_final_standings()
    print(f"  Loaded {len(finals)} final standing entries")

    career = load_career_stats()
    print(f"  Loaded career stats for {len(career)} franchises")

    # Build all sections
    franchise_records = build_franchise_records(standings, finals, career)
    print("  Built franchise records")

    matchup_records = build_matchup_records(standings)
    print(f"  Built matchup records ({len(matchup_records['h2h_series'])} H2H series)")

    divisional_history = build_divisional_history(standings)
    print(f"  Built divisional history ({len(divisional_history)} eras)")

    hall_of_shame = build_hall_of_shame(standings, finals)
    print(f"  Built hall of shame ({len(hall_of_shame)} entries)")

    three_year_windows = build_three_year_windows(standings)
    print(f"  Built 3-year windows ({len(three_year_windows)} windows)")

    # Assemble final JSON
    output = {
        "meta": {
            "league_id": "74598",
            "generated_at": "2026-04-14",
            "seasons_covered": sorted(standings.keys()),
            "dynasty_start_year": 2011,
            "note": "2010 was a non-dynasty basic auction year. Dynasty begins 2011.",
            "as_of_season": 2025,
        },
        "franchises": franchise_records,
        "matchup_records": matchup_records,
        "divisional_history": divisional_history,
        "three_year_windows": three_year_windows,
        "hall_of_shame": hall_of_shame,
        "eras": ERAS,
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / "historical_records_74598_2026.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, default=str)
    print(f"\nWrote: {out_path}")
    print(f"  Size: {out_path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
