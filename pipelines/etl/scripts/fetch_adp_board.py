#!/usr/bin/env python3
"""Pull the Stats-workbench multi-source ADP consensus (the SAME /api/adp-board the
app already serves) as the auction engine's CURRENT dynasty + redraft signal.

Why: the board already merges FantasyCalc + KeepTradeCut + DynastyProcess + Sleeper
into a CARDINAL value (KTC's own tiering — value 10136 vs 8272 tells you how much
more valuable QB1 is than QB2, which a bare rank throws away). It's also SF-aware on
both axes. This replaces the single-source DynastyProcess scrape for current players
(that outlier had Mahomes dynasty QB3; the consensus has him QB8).

Output docs/auction/data/adp_board_current.json: nkey(name) → {pid, pos, dyn_rank,
dyn_value (cross-positional SF dynasty consensus), rsf (redraft-SF consensus value)}.
The historical E[APWE|rank] CURVES still come from the dated scrapes (the board is
live-only); this is purely the current-player lookup.
"""
from __future__ import annotations
import json, re, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
BASE = "https://upsmflproduction.keith-creelman.workers.dev/api/adp-board"
POS = ["QB", "RB", "WR", "TE"]
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def nkey(s):
    s = (s or "").strip().lower()
    if "," in s:
        a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def mean(xs):
    xs = [x for x in xs if x]
    return sum(xs) / len(xs) if xs else 0


def main():
    out = {}
    for pos in POS:
        u = f"{BASE}?pos={pos}"
        req = urllib.request.Request(u, headers={"User-Agent": "ups-auction", "Accept": "application/json"})
        d = json.loads(urllib.request.urlopen(req, timeout=40).read())
        board = d.get("board") or []
        for x in board:
            fc = x.get("fc") or {}; ktc = x.get("ktc") or {}
            out[nkey(x["name"])] = {
                "pid": x.get("pid"), "name": x.get("name"), "pos": x.get("pos"),
                "dyn_rank": x.get("posRank"),
                "dyn_value": x.get("consensus") or 0,                 # cross-positional SF dynasty (KTC-led)
                "rsf": round(mean([fc.get("rsf"), ktc.get("rsf")])),  # redraft-SF consensus value
            }
        print(f"  {pos}: {len(board)} players", flush=True)
    (DATA / "adp_board_current.json").write_text(json.dumps(out, indent=2))
    print(f"\nwrote {(DATA / 'adp_board_current.json').relative_to(REPO)} ({len(out)} players)")

    # the global anchor: top SF-dynasty value across all positions → the top auction $
    top = sorted(out.values(), key=lambda v: -v["dyn_value"])[:6]
    print("\n=== cross-positional dynasty-value tops (sets the $/value anchor) ===")
    for v in top:
        print(f"  {v['name']:<22}{v['pos']:>3}  dyn_value {v['dyn_value']:>6}")


if __name__ == "__main__":
    main()
