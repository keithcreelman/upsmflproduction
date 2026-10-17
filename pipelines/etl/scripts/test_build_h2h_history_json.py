"""build_h2h_history_json.py: owners from src_franchises (not the schedule's pull-time names) and fail-closed games.

    node scripts/safe_tests/run.mjs --only test_build_h2h_history_json
"""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("bh", ROOT / "pipelines" / "etl" / "scripts" / "build_h2h_history_json.py")
bh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bh)

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def game(season, week, a, b, sa, sb, po=0):
    return [
        {"season": season, "week": week, "franchise_id": a, "opponent_franchise_id": b, "team_score": sa, "opponent_score": sb, "is_playoff": po},
        {"season": season, "week": week, "franchise_id": b, "opponent_franchise_id": a, "team_score": sb, "opponent_score": sa, "is_playoff": po},
    ]


FR = [{"season": 2024, "franchise_id": "0006", "owner_name": "Josh Lima"}, {"season": 2024, "franchise_id": "0007", "owner_name": "Josh Martel"},
      {"season": 2025, "franchise_id": "0006", "owner_name": "Brian Cross"}, {"season": 2025, "franchise_id": "0007", "owner_name": "Josh Martel"}]

# A good build: one row per game, owners per season, the regular-season seasons listed.
out = bh.build(game(2024, 3, "0007", "0006", 210.5, 180.25) + game(2025, 15, "0006", "0007", 200.0, 190.0, 1), FR, 2025, "test")
check(out["games"] == [[2024, 3, "0006", "0007", 180.25, 210.5, 0], [2025, 15, "0006", "0007", 200.0, 190.0, 1]], f"games {out['games']}")
check(out["owners"]["2024"]["0006"] == "Josh Lima" and out["owners"]["2025"]["0006"] == "Brian Cross", "owner of record per season")
check(out["regular_season_pairings"] == [2024], f"pairings {out['regular_season_pairings']}")

# A pull-time owner name on the schedule row is never read.
rows = game(2024, 3, "0007", "0006", 210.5, 180.25)
for r in rows:
    r["franchise_owner"] = "Brian Cross"
check(bh.build(rows, FR, 2025, "t")["owners"]["2024"]["0006"] == "Josh Lima", "schedule owner stamps ignored")


def refuses(schedule, franchises, why):
    try:
        bh.build(schedule, franchises, 2025, "t")
    except SystemExit as e:
        check(e.code == 1, f"{why}: exit code {e.code}")
        return
    failures.append(f"{why}: built anyway")


refuses(game(2024, 3, "0007", "0006", 210.5, 180.25)[:1], FR, "only one side's row")
bad = game(2024, 3, "0007", "0006", 210.5, 180.25); bad[1]["team_score"] = 181.0
refuses(bad, FR, "the two rows disagree")
refuses(game(2024, 3, "0007", "0008", 210.5, 180.25), FR, "a team with no owner")
refuses(game(2024, 3, "0007", "0006", None, 180.25), FR, "a missing score")

if failures:
    print("FAIL"); [print("  " + f) for f in failures]; sys.exit(1)
print("ok test_build_h2h_history_json")
