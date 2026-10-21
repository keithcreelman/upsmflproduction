#!/usr/bin/env python3
"""Replay every 2026 trade under the grader before and after decision 2.

Three graders, same recorded inputs (tests/fixtures/trade_replay_2026.json):
  live      today's grader: the letter its score gives (x.06 future picks,
            R1 rookie salary charged). Scores are recorded, not recomputed.
  d1        #1346 alone: R1 salary out of the grade, future picks still x.06.
  d1_d2     #1346 + decision 2: future picks valued over bracket odds from
            the ORIGINAL franchise's owner history (canon §D.2 tenure),
            blended in season with standings committed BEFORE the trade.

Owner history is rebuilt from tests/fixtures/final_finish_history_2010_2025.json
in the shape of franchise_career_stats.json's owner block, so the replay sees
what a correct career file would hold. Nothing is restated: this is a review
table. No D1, no network.

  python3 pipelines/etl/scripts/replay_2026_trade_grades.py
"""
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import pick_valuation as pv  # noqa: E402
from backtest_pick_slot_model import load_finishes, use_live_curve  # noqa: E402
from trade_grader import (  # noqa: E402
    PickInfo, PlayerInfo, TradeSide, compute_grade, grade_sides, parse_asset_string,
)

REPLAY = REPO / "tests" / "fixtures" / "trade_replay_2026.json"
SEASON = 2026


def career_cache(replay: dict) -> dict:
    """franchise_career_stats.json-shaped blocks from the fixtures (2025 complete)."""
    finish, tenure = load_finishes()
    cache = {}
    for fid, pairs in tenure.items():
        by_franchise = {}
        for f, s in pairs:
            by_franchise.setdefault(f, []).append(s)
        cache[fid] = {
            "current_year": SEASON,
            "trend": [{"season": s, "finish": finish[(fid, s)]} for s in range(2022, SEASON)],
            "owner": {
                "display": replay["owners"].get(fid, ""),
                "seasons_by_franchise": {f: sorted(v) for f, v in by_franchise.items()},
                "seasons_count": len(pairs),
                "playoff_appearances": sum(1 for p in pairs if finish[p] <= 6),
            },
        }
    return cache


def season_state(raw: dict) -> "pv.SeasonState":
    return pv.SeasonState(raw["season"], raw["status"], raw.get("weeks_completed", 0),
                          raw.get("allplay_pct", {}), raw.get("points_for", {}),
                          raw.get("snapshot_committed_utc", ""))


def player(p: dict) -> PlayerInfo:
    sal = p["salaries"]
    info = f"CL {len(sal)}| " + ", ".join(f"Y{i + 1}-{v}" for i, v in enumerate(sal))
    return PlayerInfo(player_id=p["id"], name=p["name"], position=p["pos"], team="",
                      salary=sal[0], contract_info=info, contract_year=len(sal),
                      expected_ppg=p["ppg"])


def x06_pick(token: str) -> PickInfo:
    """The live grader's future pick: slot 6 whatever the owner (career file lacks seasons)."""
    _, owner, year, rnd = token.split("_")[:4]
    rnd = int(rnd)
    return PickInfo(year=int(year), round=rnd, original_owner=owner,
                    expected_points=pv.pick_expected_points(int(year), rnd, slot=6),
                    predicted_slot=6, slot_is_projected=True)


def sides(trade: dict, model: str):
    a, b = trade["a"], trade["b"]
    names = trade["names"]
    state = season_state(trade["season_state"])
    gave = {}
    for fid in (a, b):
        g = trade["gave"][fid]
        tokens = ",".join(g["picks"])
        _p, picks, _bb = parse_asset_string(tokens, {}, names, state)
        if model == "d1":
            picks = [x06_pick(t) if t.startswith("FP_") else pk for t, pk in zip(g["picks"], picks)]
        gave[fid] = ([player(p) for p in g["players"]], picks, g["bb"])
    sa = TradeSide(a, names[a], players_given=gave[a][0], picks_given=gave[a][1], salary_given=gave[a][2],
                   players_received=gave[b][0], picks_received=gave[b][1], salary_received=gave[b][2])
    sb = TradeSide(b, names[b], players_given=gave[b][0], picks_given=gave[b][1], salary_given=gave[b][2],
                   players_received=gave[a][0], picks_received=gave[a][1], salary_received=gave[a][2])
    grade_sides(sa, sb)
    return sa, sb


def replay(path=REPLAY):
    use_live_curve()
    data = json.loads(Path(path).read_text())
    pv._CAREER_CACHE = career_cache(data)
    rows = []
    for t in data["trades"]:
        d1 = sides(t, "d1")
        d2 = sides(t, "d1_d2")
        for i, fid in enumerate((t["a"], t["b"])):
            picks = [pk for pk in d2[0].picks_given + d2[1].picks_given if pk.projection is not None]
            rows.append({
                "key": t["key"], "date": t["date_et"], "fid": fid, "team": t["names"][fid],
                "published": t["published"]["letters"].get(fid, ""),
                "live": (t["live"]["scores"][fid], t["live"]["letters"][fid]),
                "d1": (d1[i].grade_score, d1[i].grade),
                "d1_d2": (d2[i].grade_score, d2[i].grade),
                "odds": [f"{pk.year} R{pk.round} ({pk.original_owner}): {pk.odds_text}" for pk in picks],
                "provisional": [x for pk in picks for x in pk.value_issues],
            })
    return rows


def main():
    rows = replay()
    print(f"{'trade':<18} {'date':<10} {'team':<20} {'pub':<4} {'live':>10} {'#1346':>10} {'#1346+D2':>10}")
    moves_d2 = moves_both = 0
    for r in rows:
        flag = []
        if r["d1_d2"][1] != r["d1"][1]:
            moves_d2 += 1; flag.append("D2 moves")
        if r["d1_d2"][1] != r["live"][1]:
            moves_both += 1; flag.append("vs live")
        print(f"{r['key']:<18} {r['date']:<10} {r['team'][:20]:<20} {r['published']:<4} "
              f"{r['live'][0]:+6.1f} {r['live'][1]:<3} {r['d1'][0]:+6.1f} {r['d1'][1]:<3} "
              f"{r['d1_d2'][0]:+6.1f} {r['d1_d2'][1]:<3} {', '.join(flag)}")
    print(f"\n{len(rows)} side grades. Decision 2 on top of #1346 moves {moves_d2} letters; "
          f"#1346 + decision 2 vs the live grader moves {moves_both}.")
    seen = set()
    for r in rows:
        for o in r["odds"]:
            if (r["key"], o) not in seen:
                seen.add((r["key"], o))
                print(f"  {r['key']}: {o}")


if __name__ == "__main__":
    main()
