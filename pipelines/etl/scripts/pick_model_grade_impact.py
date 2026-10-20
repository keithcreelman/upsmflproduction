#!/usr/bin/env python3
"""Which 2026 trade grades move if future picks use the bracket-first model?

Re-scores every 2026 trade that moved a future round 1-3 pick (the only picks
whose value depends on a predicted slot) with the grader's own formula
(trade_grader._compute_side_value_pts / compute_grade), once with the model
live since 2026-05-23 (every future pick valued at x.06, see LIVE below) and
once with pick_valuation's bracket-first distribution.

Player and budget-buck totals are not re-derived from production. Two ways in,
both offline:
  * A trade with a round 1 pick charges the receiver the pick's rookie salary,
    so the two sides' scores do not sum to zero. That gap fixes the trade size,
    and the two published scores then fix both sides' player totals exactly.
  * A trade without one is rebuilt from the player inputs listed in REFERENCE
    (the same PPG and contracts the Wire's 2026-09-11 recompute used), and must
    reproduce the reference score before it is re-scored.

Inputs: data/mfl-snapshots/2026-10-20/transactions.json (assets) and
tests/fixtures/final_finish_history_2010_2025.json (each owner's playoff record,
identical to franchise_career_stats.json's owner block). No D1, no network.

  python3 pipelines/etl/scripts/pick_model_grade_impact.py
"""
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import pick_valuation as pv  # noqa: E402
from backtest_pick_slot_model import load_fixture, use_live_curve  # noqa: E402
from trade_grader import compute_grade, PLAYER_DECAY, GAMES_PER_SEASON  # noqa: E402

TRANSACTIONS = REPO / "data" / "mfl-snapshots" / "2026-10-20" / "transactions.json"
LIVE_SLOT = 6  # every future pick since the 2026-05-23 career-stats rebuild

# Reference score = the grader's number behind the letter the league saw.
#   posted: the bot's post (roast_tracker / content_archive).
#   wire:   site/wire/data/trade_grades_2026.json "recomputed" score (asterisked
#           letters for trades before the bot posted, and the reference recompute
#           for the 2026-05-25 posts, whose letters it matches).
# players: (player_id, from_fid, to_fid, ppg, remaining salaries) for trades
# solved directly; bb: (from_fid, to_fid, dollars).
REFERENCE = {
    "1774623376": {"kind": "wire", "letters": {"0007": "C", "0010": "C+"},
                   "score": {"0007": -28.5, "0010": -21.9}},
    "1775772921": {"kind": "wire", "letters": {"0006": "C", "0005": "A-"},
                   "score": {"0006": -35.2, "0005": 18.9}},
    "1776092645": {"kind": "wire", "letters": {"0005": "D+", "0008": "A"},
                   "score": {"0005": -46.9, "0008": 27.6},
                   # Cross-check only: the direct rebuild must agree with the solve.
                   "players": [("15711", "0008", "0005", 13.2, [15000, 59000])]},
    "1776396348": {"kind": "wire", "letters": {"0005": "C", "0001": "A"},
                   "score": {"0005": -38.3, "0001": 38.3},
                   "players": [("14071", "0001", "0005", 12.9, [12000])]},
    "1778117113": {"kind": "wire", "letters": {"0004": "A", "0006": "C"},
                   "score": {"0004": 39.6, "0006": -39.6},
                   "players": [("16188", "0004", "0006", 12.8, [18000])]},
    "1779668012": {"kind": "posted", "letters": {"0008": "C+", "0004": "A-"},
                   "score": {"0008": -23.4, "0004": 23.4},
                   "note": "posted -20.4/+20.4 by the 05-25 bot build; today's grader gives -23.4, same letters"},
    "1779668813": {"kind": "posted", "letters": {"0004": "B-", "0003": "B+"},
                   "score": {"0004": -5.7, "0003": 5.7},
                   "note": "posted -5.4/+5.4 by the 05-25 bot build; today's grader gives -5.7, same letters"},
    "1779669427": {"kind": "posted", "letters": {"0005": "B", "0004": "B"},
                   "score": {"0005": -3.9, "0004": 3.9},
                   "note": "posted -3.6/+3.6 by the 05-25 bot build; today's grader gives -3.9, same letters"},
    "1783770745": {"kind": "posted", "letters": {"0007": "B+", "0010": "B-"},
                   "score": {"0007": 30.8, "0010": -30.8},
                   "players": [("13299", "0007", "0010", 19.2, [29000])],
                   "bb": [("0007", "0010", 5000)],
                   "note": "official letter is the manual SECOND LOOK (B+/B-); the grader's own letter is A/C"},
    "1790679568": {"kind": "posted", "letters": {"0007": "A", "0004": "C"},
                   "score": {"0007": 32.3, "0004": -39.3}},
    "1791320211": {"kind": "posted", "letters": {"0006": "B+", "0010": "C"},
                   "score": {"0006": 14.4, "0010": -26.7}},
    "1791320240": {"kind": "posted", "letters": {"0003": "C+", "0010": "B"},
                   "score": {"0003": -17.5, "0010": -2.5}},
}
# Also moved a 2027 round 1 pick, but its published letters (A- / C+ / B) were
# written by the roast model for the whole three-way deal, not by the grader.
EXCLUDED = {"1784743077": "three-way trade; published letters are the roast model's, not grader math"}


def owner_cache(path=None):
    """franchise_career_stats.json-shaped owner blocks rebuilt from the fixture."""
    finish, tenure = load_fixture(path) if path else load_fixture()
    return {owner: {"owner": {"seasons_count": len(pairs),
                              "playoff_appearances": sum(1 for p in pairs if finish[p] <= 6)}}
            for owner, pairs in tenure.items()}


def parse_picks(asset_str):
    """[(kind, round, slot_or_owner)] for FP_/DP_ tokens."""
    out = []
    for tok in (asset_str or "").strip().rstrip(",").split(","):
        tok = tok.strip()
        if tok.startswith("FP_"):
            _, owner, _year, rnd = tok.split("_")[:4]
            out.append(("FP", int(rnd), owner))
        elif tok.startswith("DP_"):
            _, rnd, slot = tok.split("_")[:3]
            out.append(("DP", int(rnd) + 1, int(slot) + 1))
    return out


def pick_terms(pick, model):
    """(expected points, R1 rookie-salary points charged to the receiver)."""
    kind, rnd, x = pick
    if kind == "DP":
        pts = pv.pick_expected_points(2026, rnd, slot=x)
        aav = pv.pick_rookie_salary_aav(rnd, x)
    elif model == "live" and rnd <= 3:
        pts = pv.pick_expected_points(2027, rnd, slot=LIVE_SLOT)
        aav = pv.pick_rookie_salary_aav(rnd, LIVE_SLOT)
    else:
        pts = pv.pick_expected_points(2027, rnd, original_owner=x)
        aav = pv.expected_rookie_salary_aav(rnd, x)
    salary = aav * pv.ROOKIE_CONTRACT_YEARS if rnd == 1 else 0  # trade_grader._pick_effective_salary
    return pts, salary / pv.dollars_per_point()


def side_picks(gave_a, gave_b, model):
    """Pick totals per side: points received / given, R1 salary charged."""
    def tot(picks):
        terms = [pick_terms(p, model) for p in picks]
        return sum(t[0] for t in terms), sum(t[1] for t in terms)
    pts_a_gave, sal_on_b = tot(gave_a)   # b receives what a gave
    pts_b_gave, sal_on_a = tot(gave_b)
    return {"a": {"recv": pts_b_gave, "given": pts_a_gave, "sal": sal_on_a},
            "b": {"recv": pts_a_gave, "given": pts_b_gave, "sal": sal_on_b}}


def scores(u_a, u_b, picks):
    """Grader scores given each side's player/BB 'given' total (u) and pick totals.

    A side's player/BB receipts equal the other side's player/BB give-ups, so
    recv_a = u_b + picks received, given_a = u_a + picks given + R1 salary.
    """
    recv_a = u_b + picks["a"]["recv"]
    given_a = u_a + picks["a"]["given"] + picks["a"]["sal"]
    recv_b = u_a + picks["b"]["recv"]
    given_b = u_b + picks["b"]["given"] + picks["b"]["sal"]
    size = given_a + given_b
    return 100 * (recv_a - given_a) / size, 100 * (recv_b - given_b) / size


def solve_from_scores(s_a, s_b, picks):
    """Player/BB totals implied by two published scores (needs an R1 salary)."""
    sal = picks["a"]["sal"] + picks["b"]["sal"]
    size = -sal / ((s_a + s_b) / 100)
    total_u = size - (picks["a"]["given"] + picks["b"]["given"] + sal)
    diff = (s_a / 100) * size - picks["a"]["recv"] + picks["a"]["given"] + picks["a"]["sal"]
    return (total_u - diff) / 2, (total_u + diff) / 2   # u_a, u_b


def direct_u(ref, fid_a, fid_b):
    """Player/BB totals from listed inputs, with trade_grader's production math."""
    u = {fid_a: 0.0, fid_b: 0.0}
    for _pid, src, dst, ppg, salaries in ref.get("players", []):
        prod = sum(ppg * GAMES_PER_SEASON * PLAYER_DECAY[min(i, len(PLAYER_DECAY) - 1)]
                   for i in range(len(salaries)))
        u[src] += prod                                    # production the sender gives up
        u[dst] += sum(salaries) / pv.dollars_per_point()  # salary the receiver takes on
    for src, _dst, dollars in ref.get("bb", []):
        u[src] += dollars / pv.dollars_per_point()
    return u[fid_a], u[fid_b]


def analyze(path=None):
    use_live_curve()
    pv._CAREER_CACHE = owner_cache(path)
    txns = json.loads(TRANSACTIONS.read_text())["transactions"]["transaction"]
    trades = {t["timestamp"]: t for t in txns if t.get("type") == "TRADE"}
    rows = []
    for ts, ref in REFERENCE.items():
        t = trades[ts]
        fa, fb = t["franchise"], t["franchise2"]
        gave_a, gave_b = parse_picks(t.get("franchise1_gave_up")), parse_picks(t.get("franchise2_gave_up"))
        live = side_picks(gave_a, gave_b, "live")
        new = side_picks(gave_a, gave_b, "proposed")
        has_r1_salary = live["a"]["sal"] + live["b"]["sal"] > 0
        s_ref = (ref["score"][fa], ref["score"][fb])
        if has_r1_salary:
            u = solve_from_scores(*s_ref, live)
            method = "solved from scores"
        else:
            u = direct_u(ref, fa, fb)
            method = "rebuilt from inputs" if ref.get("players") or ref.get("bb") else "picks only"
        s_live = scores(*u, live)
        s_new = scores(*u, new)
        cross = None
        if has_r1_salary and ref.get("players"):
            cross = scores(*direct_u(ref, fa, fb), live)
        rows.append({
            "ts": ts, "kind": ref["kind"], "method": method, "fids": (fa, fb),
            "letters": (ref["letters"][fa], ref["letters"][fb]),
            "ref": s_ref, "live": s_live, "new": s_new, "cross": cross,
            "live_letters": tuple(compute_grade(s) for s in s_live),
            "new_letters": tuple(compute_grade(s) for s in s_new),
            "note": ref.get("note", ""),
        })
    return rows


def main():
    rows = analyze()
    moved = 0
    print(f"{'trade':<11} {'kind':<7} {'side':<5} {'letter':<7} {'ref':>6} {'live':>6} {'new':>6} {'d':>5}  grader letter")
    for r in rows:
        for i in (0, 1):
            fid = r["fids"][i]
            changed = r["live_letters"][i] != r["new_letters"][i]
            moved += changed
            flag = f"{r['live_letters'][i]} -> {r['new_letters'][i]}" if changed else r["live_letters"][i]
            print(f"{r['ts']:<11} {r['kind']:<7} {fid:<5} {r['letters'][i]:<7} {r['ref'][i]:>+6.1f}"
                  f" {r['live'][i]:>+6.1f} {r['new'][i]:>+6.1f} {r['new'][i] - r['live'][i]:>+5.1f}  {flag}")
        extra = f"; direct rebuild gives {r['cross'][0]:+.1f}/{r['cross'][1]:+.1f}" if r["cross"] else ""
        print(f"{'':<11} {r['method']}{extra}{'; ' + r['note'] if r['note'] else ''}")
    print(f"\n{len(rows)} trades, {2 * len(rows)} side grades; grader letters that change: {moved}")
    for ts, why in EXCLUDED.items():
        print(f"excluded {ts}: {why}")


if __name__ == "__main__":
    main()
