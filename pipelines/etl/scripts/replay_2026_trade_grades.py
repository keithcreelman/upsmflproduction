#!/usr/bin/env python3
"""Replay every 2026 trade under the live grader and decisions 1, 2 and 3.

Four graders, same recorded trades (tests/fixtures/trade_replay_2026.json):
  live      today's grader: the letter its score gives (x.06 future picks,
            R1 rookie salary charged, fallback inputs). Scores are recorded.
  d1        #1346 alone: R1 salary out of the grade, future picks still x.06.
  d1_d2     #1346 + decision 2: future picks valued over bracket odds from
            the ORIGINAL franchise's owner history (canon §D.2 tenure),
            blended in season with standings committed BEFORE the trade.
  d1_d2_d3  + decision 3: the full grader on a valuation snapshot built, from
            committed inputs, as of the last MFL snapshot taken before the
            trade (players' PPG, the pick curve and $/point all from it). A
            trade that snapshot cannot support is labeled a present-day
            regrade; a failed input is NO GRADE.

Owner history is rebuilt from tests/fixtures/final_finish_history_2010_2025.json
in the shape of franchise_career_stats.json's owner block, so the replay sees
what a correct career file would hold. Nothing is restated: this is a review
table. No D1, no network.

  python3 pipelines/etl/scripts/replay_2026_trade_grades.py
  python3 pipelines/etl/scripts/replay_2026_trade_grades.py --parts   # decision 3 split by input
"""
import copy
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import pick_valuation as pv  # noqa: E402
import trade_grader as tg  # noqa: E402
import build_valuation_snapshot as bvs  # noqa: E402
import valuation_snapshot as vs  # noqa: E402
from backtest_pick_slot_model import load_finishes, use_live_curve  # noqa: E402
from trade_grader import (  # noqa: E402
    PickInfo, PlayerInfo, TradeSide, compute_grade, grade_sides, parse_asset_string,
)

REPLAY = REPO / "tests" / "fixtures" / "trade_replay_2026.json"
SEASON = 2026
FIRST_ROSTER_SNAPSHOT = "2026-04-21"
ROOKIE_ADP_COMMITTED = "2026-07-21T19:05:38Z"   # player_registry.json's rookie ranks


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


def _utc(ts: str) -> float:
    from datetime import datetime
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


_SNAPS: dict = {}
MFL_SNAPSHOTS = REPO / "data" / "mfl-snapshots"


def as_of_snapshot(as_of: str) -> dict:
    """A valuation snapshot built from the committed inputs and MFL's as_of rosters.

    MFL snapshots before 2026-05-15 carry no leagueStandings.json. Before week 1
    standings say only "no games played", so for those dates the replay writes
    that file (0-0-0 for every franchise) beside the as_of rosters; the generator
    itself still requires one."""
    if as_of not in _SNAPS:
        src = MFL_SNAPSHOTS / as_of
        snap_dir = None
        if not (src / "leagueStandings.json").exists():
            import tempfile
            snap_dir = Path(tempfile.mkdtemp(prefix=f"replay-{as_of}-"))
            for name in ("rosters.json", "_snapshot_meta.json"):
                (snap_dir / name).write_bytes((src / name).read_bytes())
            ids = [f["id"] for f in json.loads((src / "rosters.json").read_text())["rosters"]["franchise"]]
            (snap_dir / "leagueStandings.json").write_text(json.dumps({"leagueStandings": {"franchise": [
                {"id": i, "all_play_wlt": "0-0-0", "all_play_pct": ".000", "pf": "0"} for i in ids]}}))
        repo_rel = bvs.rel
        if snap_dir is not None:      # the written standings file lives outside the repo
            bvs.rel = lambda p: repo_rel(p) if Path(p).resolve().is_relative_to(REPO) else str(Path(p).resolve())
        try:
            _SNAPS[as_of] = bvs.build(as_of, f"{as_of}T23:59:59Z", snapshot_dir=snap_dir)
        finally:
            bvs.rel = repo_rel
    return _SNAPS[as_of]


def last_snapshot_before(trade: dict) -> str:
    """The fixture's snapshot committed before the trade, else the last MFL
    snapshot dated before the trade's UTC day (taken ~09:05 UTC), else ""."""
    if trade["season_state"].get("snapshot"):
        return trade["season_state"]["snapshot"]
    days = sorted(d.name for d in MFL_SNAPSHOTS.iterdir() if (d / "rosters.json").exists())
    before = [d for d in days if d < trade["utc"][:10]]
    return before[-1] if before else ""


def grader_inputs(trade: dict) -> tuple[dict, dict]:
    """The MFL trade transaction and the two traded rosters' contracts, from the fixture."""
    rosters, tokens = {}, {}
    for fid in (trade["a"], trade["b"]):
        g = trade["gave"][fid]
        rosters[fid] = [{"id": p["id"], "salary": p["salaries"][0], "contractYear": len(p["salaries"]),
                         "contractInfo": f"CL {len(p['salaries'])}| "
                                         + ", ".join(f"Y{i + 1}-{v}" for i, v in enumerate(p["salaries"]))}
                        for p in g["players"]]
        tokens[fid] = ",".join([p["id"] for p in g["players"]] + g["picks"]
                               + ([f"BB_{g['bb']}"] if g["bb"] else []))
    txn = {"franchise": trade["a"], "franchise2": trade["b"], "timestamp": str(int(_utc(trade["utc"]))),
           "franchise1_gave_up": tokens[trade["a"]], "franchise2_gave_up": tokens[trade["b"]]}
    return txn, rosters


def d3_grade(trade: dict) -> dict:
    """The full grader (decisions 1-3) on an as-of valuation snapshot."""
    st = trade["season_state"]
    as_of = last_snapshot_before(trade)
    labels = []
    if not as_of:
        as_of = FIRST_ROSTER_SNAPSHOT
        labels.append(f"present-day regrade: no MFL roster snapshot before {trade['utc'][:10]}; "
                      f"rosters and $/point as of {as_of}")
    snap = as_of_snapshot(as_of)
    trade_ts = _utc(trade["utc"])
    txn, rosters = grader_inputs(trade)
    for fid in (trade["a"], trade["b"]):
        for p in trade["gave"][fid]["players"]:
            row = snap["players"].get(p["id"]) or {}
            if row.get("basis") == "adp_implied" and trade["utc"] < ROOKIE_ADP_COMMITTED:
                labels.append(f"present-day regrade: {row.get('name')}'s rookie ADP rank was recorded "
                              f"after the trade")
    saved_adj = tg.load_salary_adjustments
    tg.load_salary_adjustments = lambda: {}        # display-only; keep the replay offline
    try:
        an = tg.analyze_trade(txn, {}, trade["names"], rosters, season_state=season_state(st),
                              snapshot=snap, now=max(trade_ts, _utc(f"{as_of}T23:59:59Z")) + 60)
    finally:
        tg.load_salary_adjustments = saved_adj
    coverage = []
    for side in (an.side_a, an.side_b):
        for p in side.players_given:
            row = snap["players"].get(str(p.player_id)) or {}
            coverage.append({"asset": p.player_id, "name": row.get("name", p.name), "pos": row.get("pos", ""),
                             "ppg": row.get("ppg"), "basis": row.get("basis", "missing"),
                             "flag": ("IDP: zero by rule" if row.get("pos") in vs.IDP_POSITIONS else
                                      "missing" if not row else "no PPG" if row.get("ppg") is None else
                                      "zero PPG" if row.get("ppg") == 0 else
                                      "negative PPG" if row.get("ppg") < 0 else "")})
        for pk in side.picks_given:
            coverage.append({"asset": pick_token(pk), "name": "", "pos": "pick", "ppg": None,
                             "basis": pk.odds_text or f"slot {pk.round}.{pk.predicted_slot:02d}",
                             "value": round(pk.expected_points, 1),
                             "flag": "fixed round 4-6 value" if pk.round >= 4 else ""})
    return {"analysis": an, "labels": labels, "as_of": as_of, "coverage": coverage}


def pick_token(pk) -> str:
    if pk.projection is not None:
        return f"FP_{pk.original_owner}_{pk.year}_{pk.round}"
    return f"DP {pk.round}.{pk.predicted_slot:02d}"


def replay(path=REPLAY, with_d3: bool = True):
    data = json.loads(Path(path).read_text())
    rows = []
    for t in data["trades"]:
        use_live_curve()
        pv._CAREER_CACHE = career_cache(data)
        d1 = sides(t, "d1")
        d2 = sides(t, "d1_d2")
        picks = [pk for pk in d2[0].picks_given + d2[1].picks_given if pk.projection is not None]
        d3 = d3_grade(t) if with_d3 else None
        for i, fid in enumerate((t["a"], t["b"])):
            row = {
                "key": t["key"], "date": t["date_et"], "fid": fid, "team": t["names"][fid],
                "published": t["published"]["letters"].get(fid, ""),
                "live": (t["live"]["scores"][fid], t["live"]["letters"][fid]),
                "d1": (d1[i].grade_score, d1[i].grade),
                "d1_d2": (d2[i].grade_score, d2[i].grade),
                "odds": [f"{pk.year} R{pk.round} ({pk.original_owner}): {pk.odds_text}" for pk in picks],
                "provisional": [x for pk in picks for x in pk.value_issues],
            }
            if d3:
                an = d3["analysis"]
                side = an.side_a if i == 0 else an.side_b
                row["d3"] = ("NO GRADE", "") if an.no_grade else (side.grade_score, side.grade)
                row["d3_no_grade"] = list(an.no_grade_reasons)
                row["d3_provisional"] = list(an.provisional_reasons)
                row["d3_labels"] = d3["labels"]
                row["d3_as_of"] = d3["as_of"]
                row["d3_coverage"] = d3["coverage"]
            rows.append(row)
    pv.clear_valuation()
    return rows


def d3_parts(path=REPLAY):
    """Decision 3 one input at a time, on decisions 1+2: snapshot PPG, then
    $/point, then the fitted pick curve, then the snapshot's owner history.
    The last step must equal the full grader's d3 score."""
    data = json.loads(Path(path).read_text())
    full = {(x["key"], x["fid"]): x for x in replay(path)}
    fixture_career = career_cache(data)
    out = []
    for t in data["trades"]:
        snap = _SNAPS[full[(t["key"], t["a"])]["d3_as_of"]]
        steps = []
        for ppg, dpp, curve, career in ((0, 0, 0, 0), (1, 0, 0, 0), (1, 1, 0, 0), (1, 1, 1, 0), (1, 1, 1, 1)):
            t2 = copy.deepcopy(t)
            if ppg:
                for fid in (t["a"], t["b"]):
                    for p in t2["gave"][fid]["players"]:
                        p["ppg"] = (snap["players"].get(p["id"]) or {}).get("ppg", p["ppg"])
            use_live_curve()
            if curve:
                pv._CURVE_A, pv._CURVE_B = snap["pick_curve"]["A"], snap["pick_curve"]["B"]
            if dpp:
                pv._DOLLARS_PER_POINT = snap["dollars_per_point"]["value"]
            pv._CAREER_CACHE = snap["career"] if career else fixture_career
            steps.append(sides(t2, "d1_d2"))
        for i, fid in enumerate((t["a"], t["b"])):
            out.append({"key": t["key"], "team": t["names"][fid],
                        "steps": [(s[i].grade_score, s[i].grade) for s in steps],
                        "d3": full[(t["key"], fid)]["d3"]})
    pv.clear_valuation()
    return out


def _cell(v):
    return f"{v[0]:+6.1f} {v[1]:<3}" if isinstance(v[0], (int, float)) else f"{v[0]:>10}"


def main_parts():
    rows = d3_parts()
    print(f"{'trade':<18} {'team':<20} {'D1+D2':>10} {'+PPG':>10} {'+$/pt':>10} {'+curve':>10} {'+career':>10}")
    moves = dict.fromkeys(("PPG", "$/pt", "curve", "career"), 0)
    for r in rows:
        for k, (a, b) in zip(moves, zip(r["steps"], r["steps"][1:])):
            moves[k] += a[1] != b[1]
        assert abs(r["steps"][-1][0] - r["d3"][0]) < 0.05, (r["key"], r["steps"][-1], r["d3"])
        print(f"{r['key']:<18} {r['team'][:20]:<20} " + " ".join(_cell(c) for c in r["steps"]))
    print(f"\nLetters that move at each step: {moves}")


def main():
    if "--parts" in sys.argv:
        return main_parts()
    rows = replay()
    print(f"{'trade':<18} {'date':<10} {'team':<20} {'pub':<4} {'live':>10} {'+D1':>10} {'+D2':>10} {'+D3':>10}")
    counts = {"d2": 0, "d3": 0, "all": 0}
    for r in rows:
        flag = []
        if r["d1_d2"][1] != r["d1"][1]:
            counts["d2"] += 1; flag.append("D2")
        if r["d3"][1] != r["d1_d2"][1]:
            counts["d3"] += 1; flag.append("D3")
        if r["d3"][1] != r["live"][1]:
            counts["all"] += 1; flag.append("vs live")
        if r["d3_labels"]:
            flag.append("present-day")
        print(f"{r['key']:<18} {r['date']:<10} {r['team'][:20]:<20} {r['published']:<4} "
              f"{_cell(r['live'])} {_cell(r['d1'])} {_cell(r['d1_d2'])} {_cell(r['d3'])} {' '.join(flag)}")
    print(f"\n{len(rows)} side grades. Letters that move: decision 2 over #1346 {counts['d2']}; "
          f"decision 3 over decisions 1+2 {counts['d3']}; all three vs the live grader {counts['all']}.")
    for r in rows[::2]:
        for lab in r["d3_labels"]:
            print(f"  {r['key']}: {lab}")
        for reason in r["d3_no_grade"]:
            print(f"  {r['key']}: NO GRADE: {reason}")


if __name__ == "__main__":
    main()
