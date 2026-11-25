#!/usr/bin/env python3
"""The simulator seeds the field the way the Worker does (canon F.1.2-F.1.4, Keith's rulings 2026-11-25; ChatGPT's
review of PR #1529). Every case in tests/fixtures/seeding_agreement_cases.json is also checked against
worker/src/seeding.js playoffField by tests/ups_seeding_ladder.test.mjs, so the two agree on:
  - who the wild cards are (a division winner is never part of a wild-card head-to-head tie);
  - every seed no open tie decides;
  - which pools are left open (Worker regular_season.unresolved = simulator pendingTies);
  - the Hawk Tuah side, H1-H6, in its unchanged order -- EXCEPT when Hawk Tuah teams are level on all-play %, overall
    record and points for. That difference is documented, not fixed (Keith 2026-11-25): the Worker then uses head-to-head
    among them, then name, then franchise id; the simulator franchise id only. Cases with expect.hawkDiffers pin both.

    python3 pipelines/etl/wire/test_season_sim_seeding_agreement.py
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import season_sim as S                 # noqa: E402

CASES = json.load(open(os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "seeding_agreement_cases.json")))["cases"]
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:400]))
    if not cond:
        fails += 1


for c in CASES:
    print(c["name"])
    st = {fid: {"ap_pct": ap, "pf": pf, "pct": ovr} for fid, _n, ap, pf, ovr in c["teams"]}
    vs = {fid: {} for fid in st}
    for a, b, sa, sb in c["games"]:
        if sa > sb:
            vs[a][b] = vs[a].get(b, 0.0) + 1
        elif sb > sa:
            vs[b][a] = vs[b].get(a, 0.0) + 1
        else:
            vs[a][b] = vs[a].get(b, 0.0) + 0.5
            vs[b][a] = vs[b].get(a, 0.0) + 0.5
    ex = c["expect"]
    # Many draws of the open-tie stream: the settled seeds never depend on it.
    for draw in range(25):
        pending = {}
        seeds, outside = S.playoff_seeds(sorted(st), list(c["dw"]), st, vs, random.Random(draw), pending)
        if draw == 0:
            check("open pools = %s" % ex["unresolved"], sorted(pending) == sorted(ex["unresolved"]), pending)
        bad = [i for i, want in enumerate(ex["seeds"]) if want is not None and seeds[i] != want]
        if bad:
            check("settled seeds (draw %d)" % draw, False, (seeds, ex["seeds"]))
            break
        if ex["wildCards"] is not None:
            wc = [f for f in seeds if f not in c["dw"]]
            if sorted(wc) != sorted(ex["wildCards"]):
                check("wild cards (draw %d)" % draw, False, wc)
                break
        if ex["hawk"] is not None and S.hawk_tuah_order(outside, st) != ex["hawk"]:
            check("Hawk Tuah order (draw %d)" % draw, False, S.hawk_tuah_order(outside, st))
            break
        if ex.get("hawkDiffers") and S.hawk_tuah_order(outside, st) != ex["hawkDiffers"]["simulator"]:
            check("documented difference: the simulator's own H1-H6 (draw %d)" % draw, False, S.hawk_tuah_order(outside, st))
            break
        if ex.get("nextOut") and outside[0] != ex["nextOut"]:
            check("next in line for the last wild card (draw %d)" % draw, False, outside[0])
            break
    else:
        check("settled seeds, wild cards and H1-H6 match the Worker's expectation over 25 draws", True)

print("\n%s" % ("all passed" if not fails else "%d FAILED" % fails))
sys.exit(1 if fails else 0)
