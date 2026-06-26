#!/usr/bin/env python3
"""Phase D — per-player VALUE (two-axis, blendable) vs EXPECTED PRICE.

THREE numbers, all surfaced (the engine Keith specified):

  WORTH = a BLEND of two axes, both in cross-positional $K, both cardinal:
    • redraft_worth = E[APWE] from the player's FantasyPros REDRAFT slot × $6.5K —
      the all-play wins his PRODUCTION earns you (our league, grounded, win-now).
    • dynasty_worth = his multi-source SF dynasty CONSENSUS value (KTC-led, from the
      Stats-workbench /api/adp-board) × $/value — the ASSET value, using KTC's own
      cardinal tiering (value 10136 vs 8272 says how much more QB1 is than QB2, which
      a bare rank throws away). Anchored so the top asset (Allen 10136) ≈ $75K.
    The View blends them on a live redraft↔dynasty SLIDER; we carry BOTH components +
    a default 50/50 blend.

  EP (price) = max(dynasty_worth, startability slot-rent) — what a player CLEARS for.
    A startable NFL player commands the slot rent regardless of production; a stud
    clears near his dynasty asset value. INFLATION (Phase E, league-level) multiplies
    this above the floor.

  GAP = EP − WORTH (recomputed live as the slider moves) — pay the premium or pass.

Writes fa_value_core.json; Phase E (build_roster_fit) adds FA filter + roster fit +
the inflation factor + pushes the D1 blob.
"""
from __future__ import annotations
import csv, json, re, collections
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")

DOLLAR_PER_APWE = 6.5      # $K per earned all-play win (anchors redraft worth: QB1 E[APWE]≈11.6 → $75K)
DYN_ANCHOR_VALUE = 10136   # the top SF-dynasty consensus value (Josh Allen) …
DYN_ANCHOR_K = 75          # … anchored to the top auction $; PER_VALUE = $K per dynasty-value unit
PER_VALUE = DYN_ANCHOR_K / DYN_ANCHOR_VALUE
DEFAULT_DYN_W = 0.5        # default blend weight on the dynasty axis (the View slider overrides live)
# ── v4 EXPECTED-PRICE model (harness-fit + thread findings) ──
# The auction clearing line, re-fit on ALL clears (build_auction_backtest.py): paid$K ≈
# 3.53 + 0.82·redraft_worth (MSE 31 vs the v13 selection-biased 7.28+0.72/MSE 89). This is the
# empirically-best price predictor (MAE $3.5K). EP = the max of three anchors:
#   • the affine clearing line on REDRAFT (win-now) worth — the data-grounded predictor,
#   • the startability slot-rent floor (a startable NFL player costs ≥ the rent), and
#   • a POSITION-WEIGHTED dynasty anchor — RB clears win-now (dynasty heavily discounted: an
#     expensive RB is a 1-yr rental, dynasty over-prices its age), while QB/WR/TE command their
#     dynasty value (durable, locked multi-year, extensions hold ~80% — the thread's finding).
AFFINE_ANTE = 2.67
AFFINE_SLOPE = 0.84
POS_DYN_W = {"QB": 1.0, "WR": 0.9, "TE": 0.9, "RB": 0.55}   # how much of dynasty value the auction will pay, by pos

# ── EXPECTED PRICE: STARTABILITY FLOOR (FantasyPros redraft rank → slot rent $K) ──
# A startable NFL player commands the slot rent regardless of production. Calibrated to
# Keith's anchors: any STARTING QB ≥ $12K (Rodgers QB28→$12K), Darnold QB23→$13K,
# Flacco QB40→$6K, Mixon RB90→$2K, Diggs WR56→$5-9K, Kelce TE10→$14K.
STARTABILITY = {
    "QB": [(8, 32), (16, 18), (24, 13), (32, 12), (40, 6), (52, 2), (999, 1)],
    "RB": [(6, 40), (18, 20), (30, 10), (48, 4), (999, 2)],
    "WR": [(12, 30), (24, 16), (40, 8), (60, 5), (999, 2)],
    "TE": [(6, 20), (12, 14), (20, 5), (999, 2)],
}


def startability_floor(pos, fp_rank):
    tiers = STARTABILITY.get(pos)
    if not tiers or not fp_rank:
        return 0
    for ub, price in tiers:
        if fp_rank <= ub:
            return price
    return tiers[-1][1]


def nkey(s):
    s = (s or "").strip().lower()
    if "," in s: a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def parse_rank(s):
    m = re.match(r"([A-Za-z]+)(\d+)", s or "")
    return (m.group(1).upper(), int(m.group(2))) if m else (None, None)


def load_fpros():
    """nkey(name) → (pos, FantasyPros redraft positional rank) for the current season."""
    rows = list(csv.DictReader(open(DATA / "fpros_adp_history.csv")))
    yr = max(int(r["season"]) for r in rows)
    return {nkey(r["name"]): (r["pos"], int(r["fp_pos_rank"])) for r in rows if int(r["season"]) == yr}


def verdict(ep_k, worth_k, p90, vr):
    cutfree = ep_k <= 4
    if vr is not None and vr >= 1.5 and worth_k >= 15:
        return "SPLURGE"                       # real edge, well below its price
    if vr is not None and vr >= 1.2:
        return "VALUE"
    if vr is not None and vr >= 0.85:
        return "FAIR"
    if cutfree:
        return "DART" if (p90 or 0) >= 5 else "FAIR"
    return "OVERPAY"                           # priced well above what it earns you


def main():
    strat = json.loads((DATA / "strategy.json").read_text())["players"]
    fpros_curve = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["fpros"]
    fpros = load_fpros()
    board = json.loads((DATA / "adp_board_current.json").read_text())   # nkey → {dyn_value, dyn_rank, rsf, pos}

    def eapwe(pos, fp_rank):
        c = fpros_curve.get(pos)
        if not c or not fp_rank:
            return (0.0, 0.0, 0.0)
        i = min(fp_rank, len(c["p50"])) - 1
        return (c["p25"][i], c["p50"][i], c["p90"][i])

    out = []
    for p in strat:
        nk = nkey(p["player"])
        fp = fpros.get(nk)
        bd = board.get(nk)
        pos = (fp[0] if fp else parse_rank(p["dyn_sf_rank"])[0])
        fp_rank = fp[1] if fp else None
        dyn_value = (bd or {}).get("dyn_value") or 0

        a25, a50, a90 = eapwe(pos, fp_rank)                 # E[APWE] from the REDRAFT slot (no individual prediction)
        redraft_worth_k = round(a50 * DOLLAR_PER_APWE)      # production worth (win-now)
        dynasty_worth_k = round(dyn_value * PER_VALUE)      # asset worth (KTC cardinal tiering)
        worth_k = round((1 - DEFAULT_DYN_W) * redraft_worth_k + DEFAULT_DYN_W * dynasty_worth_k)  # default 50/50

        # v4 EXPECTED PRICE = max(affine clearing line on redraft worth, startability floor,
        # position-weighted dynasty anchor). The affine IS the inflation (prices clear above worth
        # via the fit), so there is no separate regime/ante machinery downstream.
        sf_floor = startability_floor(pos, fp_rank)
        affine_k = AFFINE_ANTE + AFFINE_SLOPE * redraft_worth_k
        dyn_anchor_k = dynasty_worth_k * POS_DYN_W.get(pos, 0.8)
        ep_base_k = round(max(sf_floor, affine_k, dyn_anchor_k))
        gap_k = ep_base_k - worth_k                          # +premium / −discount (vs the default blend; View recomputes live)
        per_apwe = round(ep_base_k / a50, 1) if a50 > 0 else None
        vr = round(worth_k / ep_base_k, 2) if ep_base_k > 0 else None
        v = verdict(ep_base_k, worth_k, a90, vr)

        out.append({
            **{k: p[k] for k in ("player", "pos", "age", "dyn_sf_rank", "redraft_rank",
                                 "win_now", "asset", "price_confidence", "deal_type")},
            "fp_rank": (pos + str(fp_rank)) if fp_rank else None,
            "dyn_value": dyn_value,
            "redraft_worth_k": redraft_worth_k, "dynasty_worth_k": dynasty_worth_k,
            "worth_k": worth_k, "ep_base_k": ep_base_k, "gap_k": gap_k,
            "low_k": round(ep_base_k * 0.78), "median_k": ep_base_k, "top10_k": round(ep_base_k * 1.3),
            "e_apwe_p25": a25, "e_apwe_p50": a50, "e_apwe_p90": a90,
            "per_apwe": per_apwe, "value_ratio": vr, "verdict": v,
        })

    (DATA / "fa_value_core.json").write_text(json.dumps(
        {"meta": {"dollar_per_apwe": DOLLAR_PER_APWE, "per_value": round(PER_VALUE, 5),
                  "dyn_anchor": {"value": DYN_ANCHOR_VALUE, "k": DYN_ANCHOR_K},
                  "default_dyn_weight": DEFAULT_DYN_W, "startability": STARTABILITY,
                  "note": "WORTH=blend(redraft E[APWE]×$6.5, dynasty cardinal value×$/val); EP_base=max(dynasty$,startability); "
                          "inflation (Phase E) multiplies EP above floor; GAP=EP−WORTH recomputed live on the View blend slider"},
         "players": out}, indent=2))
    print(f"wrote {(DATA / 'fa_value_core.json').relative_to(REPO)} ({len(out)} players)")

    vc = collections.Counter(p["verdict"] for p in out)
    print("\nverdict mix:", dict(vc))
    print(f"\n=== worth (50/50) vs EP_base (pre-inflation) — sample ===")
    print(f"  {'player':<20}{'fpRk':>6}{'redrW':>6}{'dynW':>6}{'worth':>6}{'EP':>5}{'gap':>6}{'vr':>5}  verdict")
    for nm in ["Josh Allen", "Patrick Mahomes", "Sam Darnold", "Joe Flacco", "Aaron Rodgers",
               "Travis Kelce", "Joe Mixon", "Stefon Diggs", "Bijan Robinson", "Ja'Marr Chase"]:
        p = next((r for r in out if r["player"].startswith(nm)), None)
        if p:
            print(f"  {p['player'][:19]:<20}{str(p.get('fp_rank') or '-'):>6}{p['redraft_worth_k']:>6}{p['dynasty_worth_k']:>6}"
                  f"{p['worth_k']:>6}{p['median_k']:>5}{(('+' if p['gap_k']>=0 else '')+str(p['gap_k'])):>6}"
                  f"{str(p['value_ratio'] or '-'):>5}  {p['verdict']}")


if __name__ == "__main__":
    main()
