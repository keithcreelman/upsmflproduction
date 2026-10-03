#!/usr/bin/env python3
"""Value the ESPN league's declared keepers against market draft capital.

⚠️ THIS IS THE ESPN LEAGUE, NOT grffl. Different rulebook, and the two must
never be scored with each other's table. Read from D1, the 2026 ESPN league
(16th Annual Pigskin Classic, 12 teams) is FULL PPR with SIX-point passing
touchdowns, 0.1/yard rushing and receiving, -2 per interception, one keeper per
team, and no kicker slot. grffl is 4-point passing TDs, TE receptions at 1.5
and out-of-position TDs doubled. A board built for one is wrong for the other.

⚠️ AND THE ESPN RULEBOOK ON FILE IS INCOMPLETE. ESPN's own settings payload
returns 41 scoring items and NONE of them is passing yards (stat id 3) or
fumbles lost (72) — verified against the raw JSON, so this is ESPN's shape, not
a lossy read. Twelve offensive ids cannot be confidently named. The pattern
(three pairs at 5 and 10 points, three at 2) LOOKS like distance touchdown
bonuses and two-point conversions, but looks-like is not knows, and the
provider deliberately stores NULL rather than a guessed label.

CONSEQUENCE, AND IT IS LOAD-BEARING: quarterbacks CANNOT be scored here. A QB
scored without passing yards loses roughly 250 points and would rank below a
backup running back. So skill players get points and quarterbacks get draft
capital only, and the page says which is which rather than showing a number
that is quietly wrong.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))
sys.path.insert(0, str(REPO / "scripts"))

import importlib.util                                            # noqa: E402


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bdb = _load("bdb", REPO / "scripts" / "cbs_build_draft_board.py")
pb = _load("pb", REPO / "scripts" / "cbs_projected_board.py")

from fantasy import adp as adpmod                                # noqa: E402
from fantasy import d1 as fd1                                    # noqa: E402

ESPN_KEY = "ffl.s2026.l.176898"
TEAMS, ROSTER = 12, 16

#: Transcribed from the league group text, 25 Aug 2026. Owner label -> the
#: player as written and the round the keeper costs.
#: ⚠️ COX DECLARED NOTHING. The message lists him with an empty value, which is
#: not the same as keeping nobody — it may simply be undeclared. Carried as
#: None and reported, never dropped, because a missing keeper changes who is in
#: the player pool.
KEEPERS = [
    ("Gary",     "Colston Loveland",   11),
    ("Rob",      "Harold Fannin Jr.",  14),
    ("Creelman", "Luther Burden III",   9),   # Keith
    ("Travis",   "Kyle Monangai",       9),
    ("Jay",      "Travis Etienne Jr.",  7),
    ("Brett",    "Trevor Lawrence",    14),
    ("Devan",    "Bhayshul Tuten",      9),
    ("Evans",    "Jaxson Dart",        14),
    ("Stevie",   "Drake Maye",         10),
    ("Derek",    "Kenneth Gainwell",   14),
    ("Cox",      None,                 None),
    ("Gerardi",  "Rashee Rice",         5),
]
ME = "Creelman"
#: Stat ids this repo can name with confidence. Everything else stays out.
SCORABLE = {"24": 0.1, "25": 6.0, "42": 0.1, "43": 6.0, "53": 1.0}
TO_STAT = {"24": "rush_yds", "25": "rush_tds", "42": "rec_yds",
           "43": "rec_tds", "53": "receptions"}


def rnd(adp):
    return None if not adp or adp <= 0 else int((adp - 1) // TEAMS) + 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--out", default=str(REPO / "data/analyst/espn_keepers.json"))
    a = ap.parse_args()

    loader = fd1.D1Loader(target="remote", db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    rules = {str(r["stat_id"]): float(r["modifier"]) for r in loader.query(
        f"SELECT stat_id, modifier FROM fantasy_scoring_rules WHERE platform='espn' "
        f"AND season=2026 AND league_key='{ESPN_KEY}' AND is_enabled=1;")}
    missing = [s for s in SCORABLE if s not in rules]
    if missing:
        raise SystemExit(f"ESPN scoring is missing stat ids {missing} — refusing "
                         f"to score against a rulebook that changed shape.")
    unknown = sorted(set(rules) - set(SCORABLE) - {"4", "20"}, key=int)

    adp = {adpmod.player_key(r["player_name"]): r
           for r in adpmod.fetch_ffc(2026, scoring="ppr", teams=12).rows}
    projs = pb.fetch_projections(a.limit)
    by_key = {}
    for p in projs:
        by_key.setdefault(bdb.akey(p["name"]), p)

    # ── points, skill positions only ─────────────────────────────────────────
    pts = {}
    for p in projs:
        if p["position"] == "QB":
            continue
        raw = p["raw"]
        pts[bdb.akey(p["name"])] = round(
            sum(rules[s] * float(raw.get(TO_STAT[s], 0.0) or 0.0) for s in SCORABLE), 1)
    ranks = collections.defaultdict(list)
    for p in projs:
        if p["position"] == "QB":
            continue
        k = bdb.akey(p["name"])
        ranks[p["position"]].append((pts.get(k, 0.0), p["name"]))
    posrank = {}
    for pos, lst in ranks.items():
        for i, (_, nm) in enumerate(sorted(lst, reverse=True), 1):
            posrank[bdb.akey(nm)] = (pos, i)

    rows, undeclared = [], []
    for owner, name, cost in KEEPERS:
        if name is None:
            undeclared.append(owner)
            continue
        k = bdb.akey(name)
        a_row = adp.get(adpmod.player_key(name))
        market = a_row["adp"] if a_row else None
        mr = rnd(market)
        proj = by_key.get(k)
        pos = proj["position"] if proj else (a_row["position"] if a_row else "?")
        rows.append({
            "owner": owner, "player": name, "pos": pos, "cost_round": cost,
            "adp": market, "adp_round": mr,
            # ⚠️ SURPLUS IS WHAT YOU GAIN, SO COST COMES SECOND. Written the
            # other way round it ranked the best deals as the worst: keeping
            # Rashee Rice in round 5 when the market takes him in round 2 is
            # three rounds of profit, not a three-round loss.
            "surplus": (cost - mr) if mr else None,
            "pts": None if pos == "QB" else pts.get(k),
            "posrank": None if pos == "QB" else (posrank.get(k) or (None, None))[1],
            "on_board": proj is not None,
        })

    Path(a.out).write_text(json.dumps(
        {"rows": rows, "undeclared": undeclared, "unknown_stat_ids": unknown}, indent=1))

    print(f"ESPN 2026 keepers — 1 per team, {TEAMS} teams, {ROSTER} roster spots\n")
    print(f"  {'owner':<10}{'player':<22}{'pos':<5}{'cost':>5}{'ADP':>8}{'mkt rd':>8}"
          f"{'surplus':>9}   {'proj':>7}  posrank")
    for r in sorted(rows, key=lambda r: -(r["surplus"] if r["surplus"] is not None else -99)):
        s = r["surplus"]
        mark = "  <-- you" if r["owner"] == ME else ""
        pj = f"{r['pts']:>7.0f}" if r["pts"] is not None else "     --"
        # A player with no data is not a quarterback. Say which it is.
        pr = (f"{r['pos']}{r['posrank']}" if r["posrank"]
              else "QB - not scorable" if r["pos"] == "QB"
              else "no projection")
        print(f"  {r['owner']:<10}{r['player'][:20]:<22}{r['pos']:<5}R{r['cost_round']:<4}"
              f"{(r['adp'] or 0):>8.1f}{(r['adp_round'] or 0):>8}"
              f"{(f'{s:+d}' if s is not None else '   ?'):>9}   {pj}  {pr}{mark}")
    off = [r["player"] for r in rows if not r["on_board"]]
    if off:
        print(f"\n  NOT IN THE PROJECTION SET: {', '.join(off)} — no ADP and no "
              f"projection, so neither value nor cost can be judged. That is a "
              f"gap in the data, not a verdict on the player.")
    # ── what the keepers do to the DRAFT, which is the point ────────────────
    # Keeping a player forfeits that round's pick, so a round where several
    # teams keep is a round where the teams still picking face less
    # competition. That is the actionable half of a keeper list.
    forfeit = collections.Counter(r["cost_round"] for r in rows)
    mine = next((r for r in rows if r["owner"] == ME), None)
    print("\n  Picks forfeited by round (a keeper costs that round's pick):")
    for rd in sorted(forfeit):
        n = forfeit[rd]
        who = ", ".join(r["owner"] for r in rows if r["cost_round"] == rd)
        yours = "  <-- your pick is gone here" if mine and rd == mine["cost_round"] else ""
        left = TEAMS - n - (1 if undeclared else 0)
        print(f"    R{rd:<3} {n} forfeited ({who}) -> ~{left}-{left+1} teams still pick{yours}")
    print(f"\n  You pick in every round except R{mine['cost_round']}." if mine else "")

    if undeclared:
        print(f"\n  UNDECLARED: {', '.join(undeclared)} — listed with no keeper. "
              f"Not the same as keeping nobody; it changes who is in the pool.")
    print(f"\n  {len(unknown)} scoring rules could not be named and are excluded: "
          f"{', '.join(unknown[:12])}{' ...' if len(unknown) > 12 else ''}")
    print(f"  Quarterbacks are NOT scored: ESPN's payload carries no passing-yards "
          f"rule, and a QB without passing yards would rank below a backup RB.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
