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
import csv, json, re, collections
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")
# APW scale: elite season ≈ 11-13, good starter ≈ 7-9, mid ≈ 5-6, fodder ≈ 0-2.
STARTER_APW = 6.0   # "a real starter" bar on the new positional all-play scale
BOOM_APW = 5.0      # a cheap dart's p90 must reach a startable-quality ceiling
VET_DISCOUNT = 0.5  # productive vets clear at ~half their full production value (1-yr/age)


def nkey(s):
    s = (s or "").strip().lower()
    if "," in s: a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def parse_rank(s):
    m = re.match(r"([A-Za-z]+)(\d+)", s or "")
    return (m.group(1).upper(), int(m.group(2))) if m else (None, None)


def load_apw_history():
    """name → {season: (apw_started, apw_bestball)} from the rebuilt apw_seasonal.csv."""
    hist = collections.defaultdict(dict)
    for r in csv.DictReader(open(DATA / "apw_seasonal.csv")):
        nm = nkey(r["player"])
        if nm:
            hist[nm][int(r["season"])] = (float(r["apw_started"]), float(r["apw_bestball"]))
    return hist


def trailing(hist, name):
    """Recency-weighted (0.5/0.3/0.2) trailing started+bestball APW + years of history."""
    rows = sorted(hist.get(nkey(name), {}).items(), reverse=True)[:3]   # most-recent 3 seasons
    if not rows:
        return (None, None, 0)
    w = [0.5, 0.3, 0.2][:len(rows)]; tot = sum(w)
    started = sum(wi * v[0] for wi, (_, v) in zip(w, rows)) / tot
    best = sum(wi * v[1] for wi, (_, v) in zip(w, rows)) / tot
    return (round(started, 2), round(best, 2), len(rows))


def verdict(price_k, p50, p90, vr):
    cutfree = price_k <= 4
    if cutfree and p90 >= BOOM_APW and p50 < 3:
        return "DART"
    if vr is not None and vr >= 1.5 and p50 >= STARTER_APW:
        return "SPLURGE"
    if vr is not None and vr >= 1.15:
        return "VALUE"
    if vr is not None and vr >= 0.85:
        return "FAIR"
    if cutfree:                       # cheap: never OVERPAY → boom dart or fair filler
        return "DART" if p90 >= BOOM_APW else "FAIR"
    return "OVERPAY"


def main():
    strat = json.loads((DATA / "strategy.json").read_text())["players"]
    curves = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["dynasty"]
    rate = json.loads((DATA / "market_rate.json").read_text())["rate"]
    hist = load_apw_history()

    def eapw(pos, rank):
        c = curves.get(pos)
        if not c or not rank:
            return (None, None, None)
        i = min(rank, len(c["p50"])) - 1
        return (c["p25"][i], c["p50"][i], c["p90"][i])

    out = []
    for p in strat:
        pos, rank = parse_rank(p["dyn_sf_rank"])
        s25, s50, s90 = eapw(pos, rank)            # the ADP-SLOT curve (good for unknowns)
        # ── sticky projection: blend the slot with the player's OWN trailing APW ──
        t_started, t_best, yrs = trailing(hist, p["player"])
        w = min(yrs / 3.0, 0.7)                     # established players lean on their record
        if s50 is not None and t_started is not None:
            p50 = round((1 - w) * s50 + w * t_started, 2)
        else:
            p50 = s50 if s50 is not None else t_started
        # keep the slot's spread as the outcome range, but never below the projection
        p25 = s25 if s25 is not None else None
        p90 = max(s90, p50) if (s90 is not None and p50 is not None) else s90
        bestball = t_best                           # the optimal-start/sit ceiling (proven)
        dyn_price_k = p.get("median_k") or 0
        rrow = rate.get(pos) or {}
        R = rrow.get("R"); R_conf = rrow.get("R_conf")
        # ── WIN-NOW PRODUCTION FLOOR ──
        # The dynasty-rank price dumps productive VETERANS into the $1K fodder band
        # (Kelce TE21, Mixon RB100) even though a still-producing player commands real
        # win-now money in a contract league. Floor the price at the production value:
        #   price = max( dynasty asset price , E[APW] × market $/APW × VET_DISCOUNT ).
        # Young studs keep their (higher) dynasty price; productive vets get lifted.
        prod_floor_k = round((p50 or 0) * R * VET_DISCOUNT / 1000) if (p50 and R) else 0
        price_k = max(dyn_price_k, prod_floor_k)
        floored = price_k > dyn_price_k
        low_k = round(price_k * 0.72) if floored else p["low_k"]
        top10_k = round(price_k * 1.35) if floored else p["top10_k"]
        implied = round(price_k * 1000 / p50) if (p50 and p50 > 0) else None
        vr = round(R / implied, 2) if (R and implied) else None
        v = verdict(price_k, p50 or 0, p90 or 0, vr)
        # value_conf: "solid" only when BOTH the price band and the market rate are
        # well-sampled; else "estimate" (elite projected price OR thin market rate).
        value_conf = "solid" if (p.get("price_confidence") == "model" and R_conf == "high") else "estimate"
        out.append({
            **{k: p[k] for k in ("player", "pos", "age", "dyn_sf_rank", "redraft_rank",
                                 "win_now", "asset", "price_confidence", "deal_type")},
            "low_k": low_k, "median_k": price_k, "top10_k": top10_k, "price_floored": floored,
            "e_apw_p25": p25, "e_apw_p50": p50, "e_apw_p90": p90,
            "e_apw_bestball": bestball, "apw_yrs": yrs,
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
