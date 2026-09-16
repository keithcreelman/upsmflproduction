#!/usr/bin/env python3
"""What would a rules change actually do to this league? Scored, not guessed.

Two proposals, evaluated alone and together:

  A. LINEUP — add a third WR and a second flex (9 starters -> 11).
  B. SCORING — raise the base passing touchdown from 4 to 6.

⚠️ THE TWO CHANGES ARE NOT INDEPENDENT AND MUST BE RUN TOGETHER TOO. Adding
starters deepens demand at WR, which lowers WR replacement level; raising the
passing touchdown lifts every quarterback, which raises QB replacement level.
Each alters the OTHER's baseline, so the combined effect is not the sum of the
parts and evaluating them separately would mislead.

⚠️ WHAT "PASSING TD 4 -> 6" MEANS HERE. This league scores a passing touchdown
by POSITION: 4 for a quarterback, 8 for a running back, receiver or tight end
(the out-of-position premium). Read literally, the proposal moves the BASE — the
league default and the QB override, both currently 4 — to 6, and leaves the
out-of-position value at 8. Stated because the other reading (move everything)
would change the answer, and the file should not hide which one it assumed.

⚠️ IT ALSO SHRINKS THE RUSHING-QB EDGE, WHICH IS THE POINT WORTH SEEING. A
quarterback's rushing touchdown is worth 12 against a passing touchdown's 4 —
a 3.0x ratio that is exactly why running quarterbacks are underpriced here. At
6 the ratio falls to 2.0. The proposal does not merely inflate quarterbacks; it
partially DISMANTLES the league's most distinctive edge.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import d1 as fd1                              # noqa: E402
from fantasy.scoring import ScoringTable, load_table       # noqa: E402

LEAGUE_KEY = "ffl.s2026.l.grffl"
#: Today: QB1 RB2 WR2 TE1 FLEX1 (+K, DST) = 9 starters.
BASE = {"QB": 1, "RB": 2, "WR": 2, "TE": 1}
BASE_FLEX = 1
FLEX_ELIGIBLE = ("RB", "WR", "TE")


def vor(board, starters_base, flex_slots, teams):
    """Replacement level with the flex allocated FROM THE DATA, then VOR."""
    by: dict[str, list[dict]] = {}
    for r in sorted(board, key=lambda r: -r["pts"]):
        by.setdefault(r["position"], []).append(r)
    starters = {p: n * teams for p, n in starters_base.items()}
    pool = [r for p in FLEX_ELIGIBLE for r in by.get(p, [])[starters[p]:]]
    pool.sort(key=lambda r: -r["pts"])
    for r in pool[:flex_slots * teams]:
        starters[r["position"]] += 1
    repl = {}
    for p, n in starters.items():
        lst = by.get(p, [])
        if len(lst) < n:
            raise SystemExit(f"only {len(lst)} at {p}, {n} would start league-wide")
        repl[p] = lst[n - 1]["pts"]
    out = [{**r, "vor": round(r["pts"] - repl[r["position"]], 1)} for r in board]
    out.sort(key=lambda r: -r["vor"])
    return out, starters, repl


def rescore(rows, table, td_bonus, fumbles, games=17):
    """Re-score the SAME projected game logs under a (possibly modified) table."""
    out = []
    for r in rows:
        pts = table.score_weeks(r["position"], r["games"], strict=False)
        for stat, bonus in td_bonus[r["position"]].items():
            pts += bonus * r["season"].get(stat, 0.0)
        pts += -2.0 * fumbles[r["position"]] * games
        out.append({"player": r["player"], "position": r["position"],
                    "pts": round(pts, 1)})
    return out


def modified_table(loader, pass_td: float | None):
    """The live rulebook, optionally with the BASE passing TD moved."""
    base = load_table(loader, platform="cbs", league_key=LEAGUE_KEY, season=2026)
    if pass_td is None:
        return base
    rules, bonuses = [], []
    for (pos, stat), rate in base.rates.items():
        sid = f"{pos}:{stat}" if pos else stat
        # Only the BASE moves: the league default and the QB override. The
        # out-of-position value (8, for RB/WR/TE) is deliberately untouched.
        if stat == "PaTD" and (pos is None or pos == "QB"):
            rate = pass_td
        rules.append({"stat_id": sid, "modifier": rate, "is_enabled": 1})
        for i, b in enumerate(base.bands.get((pos, stat), [])):
            bonuses.append({"bonus_id": f"{sid}:{i}", "stat_id": sid,
                            "target_value": b.target, "target_max": b.target_max,
                            "bonus_points": b.points,
                            "is_stacking": 1 if b.stacking else 0})
    return ScoringTable.from_rows(rules, bonuses, platform="cbs",
                                  league_key=LEAGUE_KEY, season=2026)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", default="/tmp/cbs_scenario_games.json")
    ap.add_argument("--teams", type=int, default=12)
    ap.add_argument("--pass-td", type=float, default=6.0)
    a = ap.parse_args()

    rows = json.loads(Path(a.games).read_text())
    loader = fd1.D1Loader(target="remote", db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    TD = {"QB": {"PaTD": 0.72, "RuTD": 0.48}, "RB": {"RuTD": 0.77, "ReTD": 1.27},
          "WR": {"ReTD": 0.87}, "TE": {"ReTD": 0.48}}
    FUM = {"QB": 0.173, "RB": 0.090, "WR": 0.026, "TE": 0.011}

    live = modified_table(loader, None)
    bumped = modified_table(loader, a.pass_td)
    base_pts = rescore(rows, live, TD, FUM)
    bump_pts = rescore(rows, bumped, TD, FUM)

    scenarios = [
        ("TODAY                  (WR2 + 1 flex, PaTD 4)", base_pts, BASE, BASE_FLEX),
        ("A: +WR3 +2nd flex      (PaTD 4)", base_pts, {**BASE, "WR": 3}, 2),
        (f"B: PaTD {a.pass_td:.0f}             (WR2 + 1 flex)", bump_pts, BASE, BASE_FLEX),
        (f"A+B: both             ", bump_pts, {**BASE, "WR": 3}, 2),
    ]
    results = {}
    for label, pts, st, flex in scenarios:
        board, starters, repl = vor(pts, st, flex, a.teams)
        results[label] = (board, starters, repl)

    print("SCENARIO COMPARISON — 2026 ESPN projections scored under each rulebook\n")
    print(f"{'scenario':<40}{'starters league-wide':<34}{'replacement level'}")
    for label, (b, st, rp) in results.items():
        print(f"{label:<40}"
              + f"{', '.join(f'{p}{n}' for p, n in sorted(st.items())):<34}"
              + ", ".join(f"{p} {v:.0f}" for p, v in sorted(rp.items())))

    print("\nTOP 12 BY VOR UNDER EACH SCENARIO")
    keys = list(results)
    width = 26
    print("".join(f"{k.split('(')[0].strip()[:width - 2]:<{width}}" for k in keys))
    for i in range(12):
        line = ""
        for k in keys:
            r = results[k][0][i]
            line += f"{i+1:>2} {r['player'][:15]:<16}{r['vor']:>5.0f} "[:width].ljust(width)
        print(line)

    print("\nWHO MOVES MOST (rank change vs today)")
    today = {r["player"]: i + 1 for i, r in enumerate(results[keys[0]][0])}
    for k in keys[1:]:
        ranks = {r["player"]: i + 1 for i, r in enumerate(results[k][0])}
        moves = sorted(((today[p] - ranks[p], p, results[k][0][ranks[p] - 1]["position"])
                        for p in ranks if p in today), key=lambda t: -t[0])
        up = [m for m in moves if m[0] > 0][:5]
        dn = [m for m in moves if m[0] < 0][-5:]
        print(f"\n  {k.strip()}")
        print("     UP  : " + ", ".join(f"{p} ({pos}) +{d}" for d, p, pos in up))
        print("     DOWN: " + ", ".join(f"{p} ({pos}) {d}" for d, p, pos in dn))

    print("\nPOSITIONAL SHARE OF THE TOP 36")
    print(f"{'scenario':<40}" + "".join(f"{p:>6}" for p in ("QB", "RB", "WR", "TE")))
    for k, (b, st, rp) in results.items():
        c = collections.Counter(r["position"] for r in b[:36])
        print(f"{k:<40}" + "".join(f"{c[p]:>6}" for p in ("QB", "RB", "WR", "TE")))

    print("\nTHE RUSHING-QB RATIO (a QB's rushing TD vs his passing TD)")
    for label, t in (("today", live), (f"PaTD {a.pass_td:.0f}", bumped)):
        ru = t.resolve("QB", "RuTD")[0]
        pa = t.resolve("QB", "PaTD")[0]
        print(f"   {label:<12} RuTD {ru:.0f} / PaTD {pa:.0f} = {ru/pa:.1f}x")
    return 0


if __name__ == "__main__":
    sys.exit(main())
