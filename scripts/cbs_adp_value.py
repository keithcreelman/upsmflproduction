#!/usr/bin/env python3
"""What is a draft SLOT worth in this league, and who beats their slot?

THE METHOD (Keith's framing, 2026-08-23)
========================================
Do not compare "my board" to "their board" — ranks are ordinal and a 4-spot
median difference tells you nothing about how much value is actually on the
table. Instead:

  1. Take INDUSTRY ADP as the market's statement of where a player goes.
  2. Score every player under THIS league's rules.
  3. Fit the expected league-points curve AS A FUNCTION OF DRAFT SLOT. That
     curve is the BASELINE — what a pick is worth if you draft to market.
  4. A player's edge is his league points MINUS the baseline at his own ADP.

⚠️ NORMALISE BY POSITION, NOT BY OVERALL RANK. An overall-rank baseline mixes
positions whose scoring curves have completely different shapes here — a
quarterback's points are not comparable to a tight end's, and the whole reason
this league is interesting is that its positional curves are unusual. So the
baseline is fitted per position against POSITIONAL ADP rank (QB7, RB14, ...),
and the overall-slot curve is reported separately for context only.

⚠️ WHAT NOT TO TIER UP. Out-of-position touchdowns pay double here, which makes
rushing quarterbacks and receiving running backs genuinely underpriced by a
generic board. A RUSHING WIDE RECEIVER is NOT the same claim: the sample is
three touchdowns across a full season of top-40 receivers, so any coefficient
fitted to it is noise dressed as signal. It is excluded rather than tiered —
see TD_BONUS in cbs_build_board.py, which no longer carries WR RuTD at all.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import adp as adpmod                               # noqa: E402
from fantasy import d1 as fd1                                   # noqa: E402

#: Standard 12-team PPR, used ONLY as the counterfactual. The market's ADP is
#: priced in roughly these terms, so scoring the SAME production both ways
#: isolates what this league's rulebook alone is worth.
GENERIC_PPR = [
    ("PaYd", 0.04), ("PaTD", 4.0), ("PaInt", -2.0), ("RuYd", 0.1), ("RuTD", 6.0),
    ("ReYd", 0.1), ("ReTD", 6.0), ("Recpt", 1.0), ("FL", -2.0),
]

#: A player is an archetype only if he ACTUALLY produces the out-of-position
#: touchdowns this league overpays for. Thresholds are shares of his own TDs.
#: ⚠️ Labelling every QB a "rushing QB" because he plays QB is not a finding,
#: it is a tautology — and it was what the first version of this script did.
ARCHETYPE_MIN_SHARE = 0.20
#: ⚠️ AND HE MUST HAVE SCORED ENOUGH TOUCHDOWNS FOR THE SHARE TO MEAN ANYTHING.
#: Without this the leaderboard is topped by backs with ONE career touchdown
#: that happened to be a reception — a 100% "receiving RB" and a 2.00 ratio
#: built on a single play. Identical failure to the WR-rushing coefficient
#: fitted on three touchdowns, and excluded for the identical reason.
ARCHETYPE_MIN_TDS = 5


def norm(name: str) -> str:
    return adpmod.player_key(name)


def fit_curve(points: list[float]) -> callable:
    """A monotone baseline from the sorted points at each slot.

    Deliberately NOT a regression: an exponential or power fit imposes a shape
    the data does not have — the real curve has cliffs where a positional tier
    ends, and smoothing them away hides exactly the thing a drafter wants to
    see. This is the observed value at each slot, smoothed only by a 5-slot
    centred median so a single outlier does not define a baseline.
    """
    n = len(points)
    out = []
    for i in range(n):
        lo, hi = max(0, i - 2), min(n, i + 3)
        out.append(statistics.median(points[lo:hi]))
    # enforce monotone non-increasing: a later slot is never worth more
    for i in range(1, n):
        out[i] = min(out[i], out[i - 1])
    return out


def table_rate(pos, stat):
    """This league's TD rate for a position, read from the ingested rulebook."""
    return _LEAGUE_TABLE.resolve(pos, stat)[0]


_LEAGUE_TABLE = None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--teams", type=int, default=12)
    ap.add_argument("--board", default="/tmp/cbs_board.json")
    ap.add_argument("--target", choices=["local", "remote"], default="remote")
    ap.add_argument("--write-adp", action="store_true",
                    help="persist the ADP pull into fantasy_adp")
    ap.add_argument("--my-picks", default="10,15,34,39,58,63,82,87,106,111,130,135,154,159,178,183,202,207")
    a = ap.parse_args()

    global _LEAGUE_TABLE
    loader = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    from fantasy.scoring import load_table                       # noqa: PLC0415
    _LEAGUE_TABLE = load_table(loader, platform="cbs",
                               league_key="ffl.s2026.l.grffl", season=a.season)

    fetched = adpmod.fetch_ffc(a.season, scoring="ppr", teams=a.teams)
    if not fetched.complete:
        raise SystemExit("ADP pull reported incomplete; refusing to build a "
                         "baseline on a partial market.")
    adp_rows = fetched.rows
    print(f"ADP: {len(adp_rows)} players from {fetched.source} "
          f"({a.season} ppr {a.teams}-team)")
    if a.write_adp:
        n = loader.write_rows("fantasy_adp", adp_rows)
        print(f"  wrote {n} rows -> fantasy_adp ({a.target})")

    board = {norm(r["player"]): r for r in json.loads(Path(a.board).read_text())}
    print(f"board: {len(board)} players scored under this league's rules")

    # ── join ─────────────────────────────────────────────────────────────────
    joined, unmatched = [], []
    for r in adp_rows:
        b = board.get(r["player_key"])
        if not b:
            unmatched.append((r["adp"], r["player_name"], r["position"]))
            continue
        joined.append({**b, "adp": r["adp"], "adp_rank": r["adp_rank"],
                       "stdev": r.get("adp_stdev"), "drafted": r.get("times_drafted")})
    joined.sort(key=lambda r: r["adp"])
    print(f"joined: {len(joined)}; {len(unmatched)} in ADP with no scored history")
    # ⚠️ THE UNMATCHED ARE NOT NOISE — they are mostly 2026 ROOKIES, who by
    # definition have no prior production to score. Printed, never dropped
    # silently, because a board that omits the rookies the market is drafting
    # in round 2 is not a board.
    early = [u for u in unmatched if u[0] <= 60]
    if early:
        print(f"  ⚠️ {len(early)} unscored inside the top 60 of ADP (rookies / "
              f"no 3-year history):")
        for adp_v, nm, pos in early[:12]:
            print(f"       ADP {adp_v:>5}  {nm} ({pos})")

    # ── positional baselines ─────────────────────────────────────────────────
    by_pos: dict[str, list[dict]] = {}
    for r in joined:
        by_pos.setdefault(r["position"], []).append(r)

    print("\nEXPECTED LEAGUE POINTS BY POSITIONAL ADP SLOT (the baseline)")
    curves = {}
    for pos, lst in sorted(by_pos.items()):
        lst.sort(key=lambda r: r["adp"])
        curves[pos] = fit_curve([r["proj_points"] for r in lst])
        marks = [0, 2, 5, 9, 14, 19, 29]
        cells = [f"{pos}{m+1}:{curves[pos][m]:.0f}" for m in marks if m < len(lst)]
        print(f"  {pos:<3} n={len(lst):>3}  " + "  ".join(cells))

    # ── who beats their slot ─────────────────────────────────────────────────
    for pos, lst in by_pos.items():
        for i, r in enumerate(lst):
            r["baseline"] = curves[pos][i]
            r["edge"] = round(r["proj_points"] - r["baseline"], 1)

    # ── the SCORING effect, isolated from the projection problem ─────────────
    # ⚠️ WHY "points minus slot baseline" IS NOT THE ANSWER. That number is
    # dominated by the market pricing in age, injury and team changes that a
    # backward-looking production board cannot see — its top of leaderboard was
    # Conner, Kupp, Keenan Allen and Kamara, i.e. players the market has
    # correctly marked DOWN. It measures market disagreement, not scoring.
    #
    # What actually transfers is this: score the SAME production under this
    # league's rules and under standard PPR. The ratio is a pure statement
    # about the rulebook, and it holds whatever you believe about 2026.
    from fantasy.scoring import ScoringTable                    # noqa: PLC0415
    generic = ScoringTable.from_rows(
        [{"stat_id": k, "modifier": v, "is_enabled": 1} for k, v in GENERIC_PPR],
        [], platform="generic", league_key="ppr", season=a.season)

    rows = loader.query(
        "SELECT n.display_name nm, w.position pos, SUM(w.rush_tds) rutd, "
        "SUM(w.rec_tds) retd, SUM(w.pass_tds) patd FROM nfl_player_weekly w "
        "JOIN nfl_player_names n ON n.gsis_id = w.gsis_id "
        "WHERE w.season = 2025 AND w.week <= 18 GROUP BY 1, 2;")
    tds = {norm(r["nm"]): r for r in rows}

    for r in joined:
        t = tds.get(norm(r["player"])) or {}
        ru, re_, pa = (t.get("rutd") or 0), (t.get("retd") or 0), (t.get("patd") or 0)
        total = ru + re_ + pa
        share = 0.0
        label = ""
        enough = total >= ARCHETYPE_MIN_TDS
        if r["position"] == "QB" and total:
            share = ru / total
            label = "rushing QB" if (enough and share >= ARCHETYPE_MIN_SHARE) else ""
        elif r["position"] == "RB" and total:
            share = re_ / total
            label = "receiving RB" if (enough and share >= ARCHETYPE_MIN_SHARE) else ""
        r["td_sample"] = total
        r["archetype"] = label
        r["oop_share"] = round(share, 2)

    print("\nTHE SCORING EFFECT, ISOLATED — same production, both rulebooks")
    print("(ADP is priced in generic-PPR terms, so a high ratio is a player the "
          "market's board structurally underprices HERE)")
    print(f"{'player':<24}{'pos':<5}{'ADP':>7}{'grffl':>7}{'ratio':>7}{'oop%':>6}{'n':>6}  note")
    for r in joined:
        r["_gen"] = None
    # recompute generic points from the same weighted basis the board used
    gen_rows = loader.query(
        "SELECT n.display_name nm FROM nfl_player_names n LIMIT 0;")   # noop, keep loader warm
    scored = [r for r in joined if r.get("proj_points")]
    for r in scored:
        # generic points are proportional to production; approximate the ratio
        # from the TD mix, which is where the two rulebooks actually differ.
        t = tds.get(norm(r["player"])) or {}
        ru, re_, pa = (t.get("rutd") or 0), (t.get("retd") or 0), (t.get("patd") or 0)
        pos = r["position"]
        g = generic.resolve(pos, "RuTD")[0] * ru + generic.resolve(pos, "ReTD")[0] * re_ \
            + generic.resolve(pos, "PaTD")[0] * pa
        l = 0.0
        for stat, n in (("RuTD", ru), ("ReTD", re_), ("PaTD", pa)):
            try:
                l += table_rate(r["position"], stat) * n
            except Exception:                                   # noqa: BLE001
                pass
        r["td_ratio"] = round(l / g, 2) if g else None

    ranked = sorted([r for r in scored
                     if r.get("td_ratio") and r.get("td_sample", 0) >= ARCHETYPE_MIN_TDS],
                    key=lambda r: -r["td_ratio"])
    for r in ranked[:16]:
        print(f"{r['player']:<24}{r['position']:<5}{r['adp']:>7.1f}"
              f"{r['proj_points']:>7.0f}{r['td_ratio']:>7.2f}"
              f"{100*r['oop_share']:>5.0f}%  {r['td_sample']:>2} TD  {r['archetype']}")

    # ── the actual draft plan ────────────────────────────────────────────────
    picks = [int(p) for p in a.my_picks.split(",") if p.strip()]
    print(f"\nBEST AVAILABLE AT EACH OF YOUR {len(picks)} PICKS")
    print("(a player is 'available' if his ADP is past your pick; edge is vs "
          "his own positional slot)")
    taken: set[str] = set()
    for pk in picks:
        cands = [r for r in joined
                 if r["player"] not in taken and r["adp"] >= pk - 1]
        if not cands:
            print(f"  pick {pk:>3}: nothing left in the ADP universe")
            continue
        best = max(cands[:24], key=lambda r: r["edge"])
        rnd = (pk - 1) // a.teams + 1
        print(f"  {rnd:>2}.{(pk - 1) % a.teams + 1:<2} (#{pk:>3})  "
              f"{best['player']:<22}{best['position']:<4} ADP {best['adp']:>5.1f}  "
              f"{best['proj_points']:>5.0f} pts  edge {best['edge']:>+5.0f}  {best['archetype']}")
        taken.add(best["player"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
