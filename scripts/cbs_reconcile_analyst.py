#!/usr/bin/env python3
"""Reconcile an outside analyst's player list against THIS league's board.

WHY RECONCILE RATHER THAN JUST READ THE GUIDE. Every public guide is written for
generic scoring. This league pays out-of-position touchdowns DOUBLE, tight-end
receptions 1.5, and passing yards 0.04 — so a national analyst's "target" can be
someone whose edge evaporates here, and his "avoid" can be a player this
rulebook rescues. The interesting rows are precisely the DISAGREEMENTS.

Reads a JSON list of {player, position, verdict, take, rank, adp_note} and joins
it to the projected board by normalised name.

⚠️ A NAME THAT DOES NOT JOIN IS REPORTED, NEVER DROPPED. An analyst naming
someone the board has never heard of is a signal — usually a deep sleeper
outside ESPN's projected universe, occasionally a spelling difference worth
fixing — and silently discarding those turns a coverage gap into apparent
agreement.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))
from fantasy import adp as adpmod                               # noqa: E402

SUFFIXES = (" jr", " sr", " ii", " iii", " iv", " v")


def key(name: str) -> str:
    k = adpmod.player_key(name or "")
    for s in SUFFIXES:
        if k.endswith(s):
            k = k[: -len(s)].strip()
            break
    return k


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyst", required=True, help="JSON list of takes")
    ap.add_argument("--board", default="/tmp/final_board.json")
    ap.add_argument("--rulebook", default="patd4", choices=["patd4", "patd6"])
    ap.add_argument("--name", default="the analyst")
    a = ap.parse_args()

    board = json.loads(Path(a.board).read_text())[a.rulebook]["board"]
    by = {key(r["player"]): r for r in board}
    takes = json.loads(Path(a.analyst).read_text())

    # One player can appear in several sections; keep the strongest verdict.
    RANK = {"target": 3, "dart": 2, "neutral": 1, "avoid": 0}
    best: dict[str, dict] = {}
    for t in takes:
        k = key(t.get("player", ""))
        if not k:
            continue
        cur = best.get(k)
        if cur is None or RANK.get(t.get("verdict"), 1) > RANK.get(cur.get("verdict"), 1):
            best[k] = t

    joined, unmatched = [], []
    for k, t in best.items():
        b = by.get(k)
        if not b:
            unmatched.append(t)
            continue
        joined.append({**t, "vor": b["vor"], "pts": b["pts"], "adp": b["adp"],
                       "pos": b["pos"], "flag": b["flag"], "board_player": b["player"]})

    print(f"{a.name}: {len(takes)} takes on {len(best)} distinct players; "
          f"{len(joined)} joined to the board, {len(unmatched)} unmatched\n")

    def show(rows, title, note):
        if not rows:
            return
        print(f"── {title}\n   {note}")
        print(f"   {'player':<24}{'pos':<5}{'VOR':>7}{'ADP':>7}  {'verdict':<8}take")
        for r in rows:
            fl = {1: " [rushing QB]", 2: " [receiving RB]"}.get(r.get("flag"), "")
            print(f"   {r['board_player'][:22]:<24}{r['pos']:<5}{r['vor']:>+7.0f}"
                  f"{(r['adp'] or 0):>7.1f}  {r['verdict']:<8}{str(r['take'])[:64]}{fl}")
        print()

    # ⚠️ THE DISAGREEMENTS ARE THE POINT — surface them first.
    agree_up = [r for r in joined if r["verdict"] == "target" and r["vor"] > 20]
    clash_a = [r for r in joined if r["verdict"] == "avoid" and r["vor"] > 40]
    clash_b = [r for r in joined if r["verdict"] == "target" and r["vor"] < -20]
    darts = [r for r in joined if r["verdict"] == "dart"]

    show(sorted(clash_a, key=lambda r: -r["vor"]),
         "HE FADES, THIS LEAGUE LIKES",
         "his reasoning is generic-scoring; check whether grffl's rules rescue them")
    show(sorted(clash_b, key=lambda r: r["vor"]),
         "HE TARGETS, THIS LEAGUE DOESN'T",
         "usually a scoring mismatch — or a player the board underrates on shape")
    show(sorted(agree_up, key=lambda r: -r["vor"])[:25],
         "BOTH AGREE — TARGET", "highest conviction picks available to you")
    show(sorted(darts, key=lambda r: -r["vor"])[:25],
         "HIS LATE DARTS, RANKED BY THIS LEAGUE'S VOR",
         "the ones near the top are darts that also fit grffl scoring")

    if unmatched:
        print(f"── NOT ON THE BOARD ({len(unmatched)}) — deep sleepers outside "
              f"ESPN's projected set, or a name spelled differently")
        for t in unmatched[:30]:
            print(f"   {t.get('player','?'):<24}{str(t.get('position') or ''):<5}"
                  f"{t.get('verdict','?'):<9}{str(t.get('take'))[:60]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
