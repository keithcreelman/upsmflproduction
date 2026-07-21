#!/usr/bin/env python3
"""Pull the Stats-workbench multi-source ADP consensus (the SAME /api/adp-board the
app already serves) as the auction engine's CURRENT dynasty + redraft signal.

Why: the board already merges FantasyCalc + KeepTradeCut + DynastyProcess + Sleeper
into a CARDINAL value (KTC's own tiering — value 10136 vs 8272 tells you how much
more valuable QB1 is than QB2, which a bare rank throws away). It's also SF-aware on
both axes. This replaces the single-source DynastyProcess scrape for current players
(that outlier had Mahomes dynasty QB3; the consensus has him QB8).

Output docs/auction/data/adp_board_current.json: nkey(name) → {pid, pos, dyn_rank,
dyn_value (cross-positional SF dynasty consensus), rsf (redraft-SF consensus value),
tier (gap-derived, per position), panels (INDEPENDENT opinions, not source count)}.
Shape is frozen — build_fa_value.py in the auction pricing chain reads it directly.
The historical E[APWE|rank] CURVES still come from the dated scrapes (the board is
live-only); this is purely the current-player lookup.

Sibling docs/auction/data/adp_board_meta.json carries the DEGENERACY SCORE the worker computes on every response, so a
regression in the blend can never land silently in a snapshot. Read it as:
`leader` (the source the consensus agrees with most) must equal `expected_leader`
(the source that agrees most with the OTHER sources) — a real centroid always sits
closest to the least-outlying source. When they differ (`inverted: true`) one
source's value scale is dragging the board, which is precisely what shipped until
2026-07-21 (leader KTC, expected FantasyCalc). This script FAILS LOUDLY on that.
"""
from __future__ import annotations
import json, os, re, sys, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
# UPS_WORKER_BASE lets this run against `wrangler dev` when verifying a blend
# change before it deploys (e.g. UPS_WORKER_BASE=http://localhost:8799).
BASE = os.environ.get("UPS_WORKER_BASE", "https://upsmflproduction.keith-creelman.workers.dev").rstrip("/") + "/api/adp-board"
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
    meta = {}
    for pos in POS:
        u = f"{BASE}?pos={pos}"
        req = urllib.request.Request(u, headers={"User-Agent": "ups-auction", "Accept": "application/json"})
        d = json.loads(urllib.request.urlopen(req, timeout=40).read())
        board = d.get("board") or []
        if not meta:
            meta = {
                "generated_at": d.get("generated_at"),
                "sources": d.get("sources"),
                "source_config": d.get("source_config"),
                "consensus_method": d.get("consensus_method"),
                "te_premium": d.get("te_premium"),
                "degeneracy": d.get("degeneracy"),
                "tier_check": d.get("tier_check"),
                "mfl_aav": d.get("mfl_aav"),
            }
        for x in board:
            fc = x.get("fc") or {}; ktc = x.get("ktc") or {}
            out[nkey(x["name"])] = {
                "pid": x.get("pid"), "name": x.get("name"), "pos": x.get("pos"),
                "dyn_rank": x.get("posRank"),
                # cross-positional SF dynasty consensus, TE-premium-aware and blended
                # in rank space (see the worker's /api/adp-board for the method)
                "dyn_value": x.get("consensus") or 0,
                "rsf": round(mean([fc.get("rsf"), ktc.get("rsf")])),  # redraft-SF consensus value
                "tier": x.get("tier"),                                # gap-derived, per position
                "panels": x.get("nPanels"),                           # INDEPENDENT opinions, not source count
            }
        print(f"  {pos}: {len(board)} players", flush=True)

    # adp_board_current.json stays a FLAT nkey→record map: build_fa_value.py reads it
    # directly and is part of the auction pricing chain, so its shape is frozen. The
    # method/degeneracy metadata goes to a sibling file instead of nesting the players.
    (DATA / "adp_board_current.json").write_text(json.dumps(out, indent=2))
    (DATA / "adp_board_meta.json").write_text(json.dumps(meta, indent=2))
    print(f"\nwrote {(DATA / 'adp_board_current.json').relative_to(REPO)} ({len(out)} players)")
    print(f"wrote {(DATA / 'adp_board_meta.json').relative_to(REPO)} (method + degeneracy)")

    # ── degeneracy gate: is this a consensus, or one source wearing three hats? ──
    dg = meta.get("degeneracy") or {}
    print("\n=== degeneracy (consensus vs each source alone) ===")
    print(f"  rho vs source      : {dg.get('rho_vs_source')}")
    print(f"  mean pairwise agree: {dg.get('mean_pairwise_agreement')}")
    print(f"  leader {dg.get('leader')}  expected {dg.get('expected_leader')}  "
          f"spread {dg.get('spread')}  panels {dg.get('independent_panels')}/{dg.get('value_sources')} sources")
    if dg.get("inverted"):
        print("  !! INVERTED — the consensus is closest to the source that agrees LEAST\n"
              "     with the others. One source's value scale is driving the board.\n"
              "     Do not ship auction numbers off this snapshot until it is fixed.")
    else:
        print("  OK — consensus sits closest to the least-outlying source, as a centroid should.")

    tc = meta.get("tier_check") or {}
    if tc:
        print("\n=== tiers (gap-derived) vs KTC's own published positional tiers ===")
        for pos in sorted(tc):
            t = tc[pos]
            print(f"  {pos:<5} {t.get('tiers')} tiers over {t.get('n')} players; "
                  f"{t.get('ktc_aligned')}/{t.get('boundaries')} boundaries land within "
                  f"1 slot of a KTC boundary ({t.get('ktc_agreement')})")

    # the global anchor: top SF-dynasty value across all positions → the top auction $
    top = sorted(out.values(), key=lambda v: -v["dyn_value"])[:6]
    print("\n=== cross-positional dynasty-value tops (sets the $/value anchor) ===")
    for v in top:
        print(f"  {v['name']:<22}{v['pos']:>3}  dyn_value {v['dyn_value']:>6}  tier {v.get('tier')}")
    return 1 if dg.get("inverted") else 0


if __name__ == "__main__":
    # non-zero exit when the degeneracy check is INVERTED, so a scheduled run fails
    # loudly instead of quietly writing a KTC-shaped board into the auction pipeline
    sys.exit(main())
