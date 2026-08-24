#!/usr/bin/env python3
"""Build a round-by-round draft plan for the 8 Sep 2026 grffl draft.

WHY THIS IS NOT THE BOARD. The board answers "who is best available"; it cannot
answer "who should I take at 3.10", because that depends on who will still be
there at 4.03. A target list has to price in the gap between your picks — the
right pick is not the highest VOR on the screen, it is the value that will not
survive until your next turn.

⚠️ POSITIONAL RANK ONLY — NEVER OVERALL. An analyst's overall list encodes HIS
scoring and HIS positional weighting. JJ deliberately devalues quarterbacks
against ADP and says so on the record, so "he has Maye 64th and this board has
him 52nd" compares two different questions and means nothing. Within a position
the comparison is real: his WR14 against this board's WR9 is two people ranking
the same pool. The scoring adjustment is already in VOR, which is computed from
this league's own rulebook, so the two layers do not double-count.

Availability comes from FantasyFootballCalculator's ADP *and its standard
deviation*: a player's draft slot is treated as Normal(adp, stdev), so
P(still there at pick p) = 1 - Phi((p - adp) / stdev). Using the mean alone
would call a 40%-likely player "gone" and a 60%-likely player "certain".
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))
sys.path.insert(0, str(REPO / "scripts"))

import importlib.util                                            # noqa: E402
_spec = importlib.util.spec_from_file_location(
    "bdb", str(REPO / "scripts" / "cbs_build_draft_board.py"))
bdb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bdb)

from fantasy import adp as adpmod                                # noqa: E402

TEMPLATE = REPO / "scripts" / "_round_plan_template.html"
TEAMS = 12
#: Keith picks 10th of 12, snake, 18 rounds.
MY_PICKS = [10, 15, 34, 39, 58, 63, 82, 87, 106, 111, 130, 135, 154, 159, 178, 183, 202, 207]
#: An ADP with no spread is a lie of precision. FFC reports one for every
#: player, but floor it anyway so a heavily-mocked stud does not read as
#: mathematically certain.
MIN_STDEV = 2.5
#: A player outside FFC's universe is undrafted in most rooms, not unavailable.
UNRANKED_AVAIL = 0.97
#: What the plan is willing to call a realistic target, a coin flip, and a
#: fall-to-you steal.
LIKELY, COINFLIP, STEAL_LO, STEAL_HI = 0.55, 0.30, 0.08, 0.45

#: 18 rounds. K and DST are unranked by the projection engine and go last.
ROSTER_TARGET = {"QB": 2, "RB": 6, "WR": 6, "TE": 2}
#: ⚠️ THESE ARE KEITH'S OWN GUARDRAILS, derived from five seasons of his drafts
#: against this league — not generic advice. They are HARD constraints on the
#: plan, and where unconstrained VOR disagrees the page says so rather than
#: quietly overriding him.
WINDOWS = {
    #: "WR at 1.10 and 2.03" — he took 4 WRs in the first three rounds across
    #: five seasons; the league's best drafter took 9, at +60 a pick. That is
    #: enforced by FORCED below, not by closing the window at round 8.
    #: ⚠️ TWO OF HIS GUARDRAILS COLLIDE IN THE LATE ROUNDS and the page says so
    #: rather than picking a winner silently: "don't chase WR depth after round
    #: 8, every WR past ADP 106 has negative VOR" is about PROJECTED value,
    #: while "late RB darts convert to startable 16% vs WR's 33%" is about what
    #: actually happened. Past ADP ~150 the projection is noise and the
    #: conversion rate is the better guide, so the window stays open and late
    #: WR picks carry the warning instead.
    "WR": (1, 16),
    #: "No QB before round 7" — his early QBs run -76 a pick.
    "QB": (7, 16),
    #: "TE in rounds 5-6" — worth +34 to top-4 teams, and he is -165 there.
    "TE": (5, 16),
    "RB": (1, 16),
}
#: Round past which a WR pick gets the conflict note attached.
LATE_WR = 8
FORCED = {1: "WR", 2: "WR"}          # the 1.10 / 2.03 guardrail, stated outright
KDST = {17: "K", 18: "DST"}
CHEAT = re.compile(r"Ovr\s*(\d+)\s*\|\s*(QB|RB|WR|TE|K|DST)\s*(\d+)\s*\|\s*Tier\s*(\d+)")
AUCTION = re.compile(r"\$(\d+)")


def phi(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def avail(pick: int, adp: float | None, sd: float | None) -> float:
    """P(this player is still on the board when pick `pick` comes round)."""
    if adp is None or adp <= 0:
        return UNRANKED_AVAIL
    s = max(sd or 0.0, MIN_STDEV)
    return max(0.0, min(1.0, 1.0 - phi((pick - 0.5 - adp) / s)))


def jj_positional(path: Path) -> dict:
    """JJ's cheat sheet, keyed by player, as POSITIONAL rank + tier + $.

    The overall column is deliberately dropped. It is the number that invites
    a cross-scoring comparison that cannot mean anything.
    """
    out = {}
    for t in json.loads(path.read_text()):
        if "Cheat Sheet" not in (t.get("section") or ""):
            continue
        m = CHEAT.search(t.get("rank") or "")
        if not m:
            continue
        a = AUCTION.search(t.get("take") or "")
        out[bdb.akey(t["player"])] = {
            "pos": m.group(2), "pr": int(m.group(3)), "tier": int(m.group(4)),
            "aav": int(a.group(1)) if a else None,
            "note": t.get("take"), "verdict": t.get("verdict"),
        }
    return out


def stances(path: Path) -> dict:
    out = collections.defaultdict(list)
    if not path.exists():
        raise SystemExit(f"{path} missing — refusing to build a plan whose "
                         f"analyst layer is silently empty.")
    for t in json.loads(path.read_text()):
        out[bdb.akey(t.get("player", ""))].append(
            {"a": t.get("analyst"), "s": t.get("stance"), "t": t.get("take"),
             "u": t.get("source_url"), "q": 1 if t.get("speaker_uncertain") else 0})
    return out


def enrich(rows, ffc, jj, st):
    """Board rows -> plan rows, with POSITIONAL rank on both sides."""
    out = []
    for r in rows:
        nm, pos = r[0], r[1]
        k = bdb.akey(nm)
        f = ffc.get(adpmod.player_key(nm)) or {}
        j = jj.get(k)
        out.append({
            "nm": nm, "pos": pos, "team": r[2], "bye": r[3],
            "pts": r[4], "vor": r[5],
            "adp": f.get("adp") or (r[6] or None),
            "sd": f.get("adp_stdev"),
            "lo": f.get("high_pick"), "hi": f.get("low_pick"),
            "flag": r[7], "unproven": r[8],
            # ⚠️ jj["pos"] is HIS positional label. Where it disagrees with the
            # board's, the disagreement is reported, not reconciled — a WR he
            # files at TE is a data problem, not a ranking opinion.
            "jjpr": (j or {}).get("pr"), "jjtier": (j or {}).get("tier"),
            "jjaav": (j or {}).get("aav"), "jjnote": (j or {}).get("note"),
            "jjpos": (j or {}).get("pos"),
            "st": st.get(k, []),
        })
    # positional rank on THIS board, by VOR within position
    by = collections.defaultdict(list)
    for r in sorted(out, key=lambda r: -r["vor"]):
        by[r["pos"]].append(r)
    for pos, rows_ in by.items():
        for i, r in enumerate(rows_, 1):
            r["pr"] = i
    return out


def plan(rows, picks):
    """Greedy value-based plan with a one-pick lookahead.

    The decision is not "highest VOR left" — that ignores the 5-to-25 picks
    between your turns. For each eligible position it compares the best player
    likely to be there NOW against the best likely to be there at your NEXT
    pick, and spends the pick where that gap is widest. Positions you can
    still fill later are left for later, which is the whole point of drafting
    from the 10 slot with back-to-back picks.
    """
    live = {r["nm"]: r for r in rows}
    taken, need = [], dict(ROSTER_TARGET)
    for i, p in enumerate(picks):
        rnd = (p - 1) // TEAMS + 1
        nxt = picks[i + 1] if i + 1 < len(picks) else p + TEAMS
        # ⚠️ THE HORIZON IS THE PICK AFTER THE PAIR, NOT THE NEXT PICK. From the
        # 10 slot the picks arrive in pairs five apart (82 then 87), and across
        # five picks nothing moves — measured against the next pick, EVERY
        # position's drop came out at exactly 0.0 and the tiebreak silently
        # chose the whole draft. What actually decides a pair is who survives to
        # the following round: at 82 the best QB was 83% likely to last to 106
        # while the best TE was 40%.
        hor = picks[i + 2] if i + 2 < len(picks) else p + 2 * TEAMS

        def pool(pos, pick, floor):
            return sorted(
                (r for r in live.values()
                 if r["pos"] == pos and avail(pick, r["adp"], r["sd"]) >= floor),
                key=lambda r: -r["vor"])

        if rnd in KDST:
            taken.append({"pick": p, "round": rnd, "pos": KDST[rnd], "kdst": True,
                          "why": "Unranked by the projection engine. One of each, "
                                 "last two rounds — never earlier."})
            continue

        elig = [q for q in ROSTER_TARGET
                if need.get(q, 0) > 0
                and WINDOWS[q][0] <= rnd <= WINDOWS[q][1]]

        # ⚠️ LAST CALL. Deferring a need until its window closes is how the plan
        # arrived at round 16 owing a quarterback with no quarterback left on
        # the board — the deepest one ESPN projects goes at ADP 170 and the pick
        # is 183. If a position needs as many players as it has picks left
        # inside its window, it stops being a choice.
        def window_picks_left(q):
            """Picks left where this position is BOTH in window and stocked.

            ⚠️ Counting the window alone is a fail-open: quarterbacks were
            "allowed" through round 16 while the deepest one ESPN projects goes
            at ADP 170 and that pick is 183. A window with nobody in it is not
            a window, and treating it as one is how the plan reached the end of
            the draft still owing a starter.
            """
            lo, hi = WINDOWS[q]
            n = 0
            for pp in picks[i:]:
                r = (pp - 1) // TEAMS + 1
                if lo <= r <= hi and r not in KDST and pool(q, pp, LIKELY):
                    n += 1
            return n
        forced_now = [q for q in elig if need[q] >= window_picks_left(q)]
        if forced_now:
            elig = forced_now
        elif rnd in FORCED and FORCED[rnd] in elig:
            elig = [FORCED[rnd]]
        if not elig:                       # every window closed: take best left
            elig = [q for q in ROSTER_TARGET if need.get(q, 0) > 0] or list(ROSTER_TARGET)

        # ⚠️ THE OBJECTIVE IS THE MARGINAL VALUE OF NOT WAITING, and it depends
        # on how many of this position you still need. Two simpler rules both
        # failed on real data:
        #
        #   * "highest VOR left" reached 30+ picks past ADP for a quarterback,
        #     because quarterbacks score more and it never asked whether he
        #     would still be there.
        #   * "biggest drop-off" ignores level entirely — it left a +28 tight
        #     end on the board to take a -19 receiver, because the receiver
        #     pool was collapsing faster.
        #
        # What you actually give up by deferring position q for one pick is:
        #     take now  ->  best_now  +  top(k-1) of the horizon pool
        #     defer     ->  top(k)    of the horizon pool
        # If best_now is STILL in the horizon pool those are equal and the gain
        # is zero — which is exactly why this never reaches. If he is gone, the
        # gain is best_now minus the k-th best survivor, so a position you need
        # four of is judged on its fourth-best survivor, not its first.
        scored = []
        for q in elig:
            now, later = pool(q, p, LIKELY), pool(q, hor, LIKELY)
            if not now:
                continue
            k = max(1, need.get(q, 1))
            top = now[0]
            # ⚠️ WEIGHT BY SURVIVAL, DON'T THRESHOLD IT. Asking "is he in the
            # horizon pool?" turns a 52%-likely player into a certainty in
            # whichever direction the cutoff falls, and that cliff alone had the
            # plan reaching 24 picks for a receiver who was a coin flip to last.
            # The value of taking him now is the chance you would otherwise
            # lose him, so scale by exactly that.
            rest = [r for r in later if r["nm"] != top["nm"]]
            if len(rest) >= k:
                raw = top["vor"] - rest[k - 1]["vor"]
            elif rest:
                raw = top["vor"] - (rest[-1]["vor"] - 30)
            else:
                raw = 60.0
            survives = avail(hor, top["adp"], top["sd"])
            gain = raw * (1.0 - survives)
            scored.append((round(gain), top["vor"], q, now))
        if not scored:
            # A round with nothing to say is a hole in a round-by-round plan.
            # Say it out loud rather than omitting the round entirely.
            taken.append({
                "pick": p, "round": rnd, "pos": None, "empty": True,
                "why": "No player at an unfilled position is more likely than not "
                       "to still be here. By this round you are drafting from the "
                       "part of the pool the projections cannot separate — take "
                       "upside, not a slot.",
                "target": None, "alts": [], "flips": [], "steals": [],
                "alt_pos": [],
            })
            continue
        scored.sort(key=lambda x: (-x[0], -x[1]))
        drop, _, pos, now = scored[0]
        alt_gain = [(q, round(g)) for g, _v, q, _n in scored[1:]]

        pick_row = now[0]
        alts = [r for r in now[1:4]]
        # A coin-flip name is worth naming: at 30-55% he is neither a plan nor
        # a fantasy, and knowing which way to lean matters more than the pick.
        flips = [r for r in live.values()
                 if r["pos"] == pos and COINFLIP <= avail(p, r["adp"], r["sd"]) < LIKELY
                 and r["vor"] > pick_row["vor"]][:3]
        flips.sort(key=lambda r: -r["vor"])
        steals = sorted(
            (r for r in live.values()
             if STEAL_LO <= avail(p, r["adp"], r["sd"]) < STEAL_HI
             and r["vor"] > pick_row["vor"] + 15),
            key=lambda r: -r["vor"])[:4]

        alt_pos = [(q, n[0]) for _d, _v, q, n in scored[1:3]]
        taken.append({
            "pick": p, "round": rnd, "pos": pos, "drop": round(drop),
            "target": pick_row, "alts": alts, "flips": flips, "steals": steals,
            "alt_pos": alt_pos, "alt_gain": alt_gain,
            "forced": rnd in FORCED, "next": nxt, "hor": hor,
            "lastcall": bool(forced_now) and pos in forced_now,
            "late_wr": pos == "WR" and rnd > LATE_WR,
            "why": None,
        })
        del live[pick_row["nm"]]
        need[pos] -= 1
        # Everyone the market will realistically have taken by now is gone.
        for nm, r in list(live.items()):
            if avail(p, r["adp"], r["sd"]) < 0.10:
                del live[nm]
    return taken


def why(step, rows) -> str:
    """One sentence saying why this position at this pick, in plain language."""
    pos, d = step["pos"], step.get("drop") or 0
    if step.get("kdst") or step.get("empty"):
        return step["why"]
    rnd = step["round"]
    if step.get("late_wr"):
        return (f"Two of your guardrails collide here. The projection says every "
                f"WR past ADP 106 has negative VOR; your own history says late WR "
                f"darts convert to startable 33% of the time against 16% for RBs. "
                f"Past this point the projection is noise and the conversion rate "
                f"is the better guide — take the upside.")
    if step.get("lastcall"):
        return (f"Last call for {pos}. This is the final pick inside the window "
                f"you set for the position, and the board runs out of them "
                f"before your next turn — deferring again means not filling it.")
    if step.get("forced"):
        return (f"Your own guardrail: WR at 1.10 and 2.03. You took four WRs in "
                f"the first three rounds across five seasons; the league's best "
                f"drafter took nine, at +60 a pick.")
    if pos == "QB":
        return (f"First round the QB window opens. QB1 beats QB12 by 132 while "
                f"RB1 beats RB28 by 209 — the position is deep, so this is where "
                f"it costs least. Waiting past here gives up {d} points.")
    if pos == "TE":
        return (f"TE in rounds 5-6 is worth +34 to top-4 teams and you are -165 "
                f"there. The next tier down costs {d} points.")
    if d >= 25:
        return (f"{pos} falls off a cliff before your next pick — {d} points "
                f"between the best {pos} here and the best one likely to survive.")
    if d <= 8:
        return (f"{pos} is flat here: only {d} points between this pick and your "
                f"next, so the pick is about the player, not the position.")
    return f"Best combination of value on the board and {d} points of drop-off before your next turn."


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload-in", default=str(REPO / "data/analyst/board_payload.json"))
    ap.add_argument("--analyst-dir", default=str(REPO / "data/analyst"))
    ap.add_argument("--out", default=str(REPO / "data/analyst/round_plan_2026.html"))
    a = ap.parse_args()

    rel = Path(a.out).resolve()
    try:
        top = rel.relative_to(REPO).parts[0]
    except ValueError:
        top = None
    if top in bdb.TRACKED:
        raise SystemExit(f"refusing to write to {a.out} — {top}/ is tracked by "
                         f"git and this page carries paid-guide ranks.")

    pay = json.loads(Path(a.payload_in).read_text())
    root = Path(a.analyst_dir)
    jj = jj_positional(root / "jj_takes.json")
    st = stances(root / "verified_takes.json")
    ffc = {adpmod.player_key(r["player_name"]): r
           for r in adpmod.fetch_ffc(2026, scoring="ppr", teams=12).rows}

    out = {}
    for book in ("p4", "p6"):
        rows = enrich(pay[book], ffc, jj, st)
        steps = plan(rows, MY_PICKS)
        for s in steps:
            s["why"] = why(s, rows)
        out[book] = steps

    def slim(r):
        if r is None:
            return None
        return {k: r[k] for k in ("nm", "pos", "team", "bye", "vor", "adp", "pr",
                                  "jjpr", "jjtier", "jjaav", "jjnote", "jjpos",
                                  "st", "flag", "unproven", "lo", "hi")}

    packed = {}
    for book, steps in out.items():
        packed[book] = [{
            "pick": s["pick"], "round": s["round"], "pos": s["pos"],
            "why": s["why"], "kdst": bool(s.get("kdst")), "drop": s.get("drop"),
            "target": slim(s.get("target")),
            "alts": [slim(r) for r in s.get("alts", [])],
            "flips": [slim(r) for r in s.get("flips", [])],
            "steals": [slim(r) for r in s.get("steals", [])],
            "alt_pos": [[q, slim(r)] for q, r in s.get("alt_pos", [])],
            "alt_gain": s.get("alt_gain", []),
            "av": {r["nm"]: round(avail(s["pick"], r["adp"], r["sd"]), 3)
                   for r in ([s["target"]] + s.get("alts", []) + s.get("flips", [])
                             + s.get("steals", []) + [r for _, r in s.get("alt_pos", [])])
                   if r} if not s.get("kdst") else {},
        } for s in steps]

    tpl = TEMPLATE.read_text(encoding="utf-8")
    if "__PLAN__" not in tpl:
        raise SystemExit(f"{TEMPLATE} has no __PLAN__ placeholder.")
    Path(a.out).write_text(
        tpl.replace("__PLAN__", json.dumps(packed, separators=(",", ":"))),
        encoding="utf-8")

    shape = collections.Counter(s["pos"] or "(none)" for s in out["p4"])
    print(f"wrote {a.out}")
    print("  roster the plan builds (PaTD 4): "
          + ", ".join(f"{k} {v}" for k, v in sorted(shape.items())))
    for s in out["p4"]:
        t = s.get("target")
        print(f"  {s['round']:>2}.{((s['pick']-1) % TEAMS)+1:02d}  #{s['pick']:<4}"
              f"{(s['pos'] or '--'):<4}" + (f"{t['nm']:<24}VOR {t['vor']:>+5}  "
                                  f"ADP {(t['adp'] or 0):>5.1f}  "
                                  f"{t['pos']}{t['pr']}"
                                  + (f" / JJ {t['jjpos']}{t['jjpr']}" if t['jjpr'] else " / JJ —")
                                  if t else "—"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
