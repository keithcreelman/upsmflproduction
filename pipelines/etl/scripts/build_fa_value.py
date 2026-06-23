#!/usr/bin/env python3
"""Phase D — per-player APW value + verdict (the value layer).

For every priced player: their dynasty-SF rank → E[APW] p25/p50/p90 (Phase B
dynasty curve) → implied $/E[APW] from the expected price (pricing.json via
strategy.json) → value_ratio vs the market rate R[pos] (Phase C). Verdict ladder:

  SPLURGE  value_ratio ≥1.5 AND E[APW]_p50 ≥4   (cheap per APW + a real starter)
  VALUE    1.15 ≤ value_ratio < 1.5
  FAIR     0.85 ≤ value_ratio < 1.15
  OVERPAY  value_ratio <0.85 AND price >$4K     (cut-free ≤$4K can never be OVERPAY)
  DART     price ≤$4K AND E[APW]_p90 ≥4 AND p50 <2  (low floor, real boom, no cap risk)

value_ratio = R[pos] / (price / E[APW]_p50): >1 = the market historically paid
MORE per expected-APW than this player's ask (a bargain). Writes the value layer
to fa_value_core.json; Phase E filters to FAs + adds roster fit + pushes D1.
"""
from __future__ import annotations
import json, re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"


def parse_rank(s):
    m = re.match(r"([A-Za-z]+)(\d+)", s or "")
    return (m.group(1).upper(), int(m.group(2))) if m else (None, None)


def verdict(price_k, p50, p90, vr):
    cutfree = price_k <= 4
    if cutfree and p90 >= 4 and p50 < 2:
        return "DART"
    if vr is not None and vr >= 1.5 and p50 >= 4:
        return "SPLURGE"
    if vr is not None and vr >= 1.15:
        return "VALUE"
    if vr is not None and vr >= 0.85:
        return "FAIR"
    if cutfree:                       # cheap: never OVERPAY → boom dart or fair filler
        return "DART" if p90 >= 4 else "FAIR"
    return "OVERPAY"


def main():
    strat = json.loads((DATA / "strategy.json").read_text())["players"]
    curves = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["dynasty"]
    rate = json.loads((DATA / "market_rate.json").read_text())["rate"]

    def eapw(pos, rank):
        c = curves.get(pos)
        if not c or not rank:
            return (None, None, None)
        i = min(rank, len(c["p50"])) - 1
        return (c["p25"][i], c["p50"][i], c["p90"][i])

    out = []
    for p in strat:
        pos, rank = parse_rank(p["dyn_sf_rank"])
        p25, p50, p90 = eapw(pos, rank)
        price_k = p.get("median_k") or 0
        rrow = rate.get(pos) or {}
        R = rrow.get("R"); R_conf = rrow.get("R_conf")
        implied = round(price_k * 1000 / p50) if (p50 and p50 > 0) else None
        vr = round(R / implied, 2) if (R and implied) else None
        v = verdict(price_k, p50 or 0, p90 or 0, vr)
        # value_conf: "solid" only when BOTH the price band and the market rate are
        # well-sampled; else "estimate" (elite projected price OR thin market rate).
        value_conf = "solid" if (p.get("price_confidence") == "model" and R_conf == "high") else "estimate"
        out.append({
            **{k: p[k] for k in ("player", "pos", "age", "dyn_sf_rank", "redraft_rank",
                                 "win_now", "asset", "low_k", "median_k", "top10_k",
                                 "price_confidence", "deal_type")},
            "e_apw_p25": p25, "e_apw_p50": p50, "e_apw_p90": p90,
            "market_R": R, "implied_apw": implied, "value_ratio": vr,
            "verdict": v, "value_conf": value_conf,
        })

    (DATA / "fa_value_core.json").write_text(json.dumps(
        {"meta": {"note": "value layer; FA filter + roster fit applied in Phase E (fa_value.json)"},
         "players": out}, indent=2))
    print(f"wrote {(DATA / 'fa_value_core.json').relative_to(REPO)} ({len(out)} players)")

    import collections
    vc = collections.Counter(p["verdict"] for p in out)
    print("\nverdict mix:", dict(vc))
    print("\n=== top E[APW]·value players (sample) ===")
    print(f"  {'player':<22}{'rank':>6}{'E[APW]50':>9}{'p90':>6}{'price$':>8}{'$/APW':>8}{'vr':>6}  verdict")
    for p in sorted(out, key=lambda x: -(x["e_apw_p50"] or 0))[:16]:
        print(f"  {p['player'][:21]:<22}{p['dyn_sf_rank']:>6}{(p['e_apw_p50'] or 0):>9.1f}{(p['e_apw_p90'] or 0):>6.1f}"
              f"{('$'+str(p['median_k'])+'K'):>8}{('$'+str(p['implied_apw']) if p['implied_apw'] else '-'):>8}"
              f"{str(p['value_ratio'] or '-'):>6}  {p['verdict']}")
    # spot Josh Allen + a boom dart
    ja = next((p for p in out if p["player"].startswith("Josh Allen")), None)
    if ja:
        print(f"\n  Josh Allen → {ja['dyn_sf_rank']}  E[APW] {ja['e_apw_p50']} (p90 {ja['e_apw_p90']})  "
              f"${ja['median_k']}K  $/APW {ja['implied_apw']}  vr {ja['value_ratio']}  → {ja['verdict']}")


if __name__ == "__main__":
    main()
