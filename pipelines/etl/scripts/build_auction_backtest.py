#!/usr/bin/env python3
"""Reproducibility harness for the FA-auction pricing engine (v4).

The v13 audit's #1 process failure: none of the doc's headline tables regenerated from the
data, so calibration bugs hid (a selection-biased affine, a mean-of-ratios "1.97x"). This
script re-derives every load-bearing number from source so each claim is checkable, and emits
the CORRECTED constants the v4 model should use.

Reads (read-only): /tmp/ups_auction_canon.db (transactions_auction = FA wins), and
docs/auction/data/{fpros_adp_history,dynasty_adp_history,apw_seasonal}.csv. Joins fp_id→mfl_id
via the D1 ff_player_ids crosswalk. Prints a report; --json dumps the constants for the model.
"""
from __future__ import annotations
import argparse, csv, json, re, sqlite3, statistics, subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
DB = "/tmp/ups_auction_canon.db"
DOLLAR_PER_APWE = 6.5
SKILL = {"QB", "RB", "WR", "TE"}
SF_ERA = range(2022, 2026)


def d1(sql):
    r = subprocess.run(["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
                        "--remote", "--json", "--command", sql], cwd=WORKER, capture_output=True, text=True, timeout=120)
    return json.loads(r.stdout[r.stdout.find("["):])[0]["results"]


def ols(xy):
    """least squares y = a + b·x → (a, b, mse, n)."""
    n = len(xy)
    mx = sum(x for x, _ in xy) / n; my = sum(y for _, y in xy) / n
    sxx = sum((x - mx) ** 2 for x, _ in xy) or 1e-9
    b = sum((x - mx) * (y - my) for x, y in xy) / sxx
    a = my - b * mx
    mse = sum((y - (a + b * x)) ** 2 for x, y in xy) / n
    return round(a, 2), round(b, 3), round(mse, 1), n


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--json", action="store_true"); args = ap.parse_args()

    # redraft worth = E[APWE | fpros rank] × 6.5 (the worth the affine was fit on)
    curve = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["fpros"]
    fp = {}  # (season, mfl_id) -> (pos, rank)
    for r in csv.DictReader(open(DATA / "fpros_adp_history.csv")):
        if r["mfl_id"]:
            fp[(int(r["season"]), str(r["mfl_id"]))] = (r["pos"], int(r["fp_pos_rank"]))
    fp2mfl = {str(x["fantasypros_id"]): str(x["mfl_id"]) for x in d1("SELECT mfl_id, fantasypros_id FROM ff_player_ids WHERE fantasypros_id IS NOT NULL")}
    dynv = {}  # (season, mfl_id) -> value_2qb
    for r in csv.DictReader(open(DATA / "dynasty_adp_history.csv")):
        mid = fp2mfl.get(str(r["fp_id"]))
        if mid and r.get("value_2qb"):
            dynv[(int(r["season"]), mid)] = int(r["value_2qb"])

    def worth(season, pid):
        m = fp.get((season, pid))
        if not m:
            return 0.0
        pos, rk = m; c = curve.get(pos)
        if not c:
            return 0.0
        return round(c["p50"][min(rk, len(c["p50"])) - 1] * DOLLAR_PER_APWE, 1)

    # FA wins
    c = sqlite3.connect(DB)
    wins = c.execute("SELECT season, player_id, player_name, position, bid_amount FROM transactions_auction "
                     "WHERE finalbid_ind=1 AND auction_type='FreeAgent' AND season BETWEEN 2022 AND 2025").fetchall()
    rows = []
    for s, pid, nm, pos, bid in wins:
        if pos not in SKILL:
            continue
        rows.append({"s": s, "pid": str(pid), "nm": nm, "pos": pos, "paid": bid / 1000.0, "worth": worth(s, str(pid))})

    allc = [(r["worth"], r["paid"]) for r in rows]
    worthy = [(w, p) for w, p in allc if w > 0]

    print(f"=== AFFINE CLEARING LINE — the v13 selection-bias bug ===")
    print(f"  worth>0 only (the SHIPPED, biased fit): paid = {ols(worthy)[0]} + {ols(worthy)[1]}·worth   MSE {ols(worthy)[2]}  n={ols(worthy)[3]}")
    print(f"  ALL clears (the CORRECTED fit)        : paid = {ols(allc)[0]} + {ols(allc)[1]}·worth   MSE {ols(allc)[2]}  n={ols(allc)[3]}")
    a, b, mse, n = ols(allc)
    print(f"  → v4 should ship ANTE={a}, SLOPE={b} (vs v13 ante≈7.0 / slope 0.72). The biased fit's ante is ~2x too high.")

    print(f"\n=== INFLATION HEADLINE — the '1.97x' that doesn't reproduce ===")
    tot_paid = sum(p for _, p in allc); tot_worth = sum(w for w, _ in allc) or 1
    print(f"  $-weighted Σpaid/Σworth (honest)     : {round(tot_paid/tot_worth,2)}x")
    mor = [p/w for w, p in worthy if w > 0]
    print(f"  mean-of-ratios (the inflated artifact): {round(statistics.mean(mor),2)}x")
    for s in SF_ERA:
        yr = [(r["worth"], r["paid"]) for r in rows if r["s"] == s]
        tp = sum(p for _, p in yr); tw = sum(w for w, _ in yr) or 1
        print(f"    {s}: $-weighted {round(tp/tw,2)}x  (n={len(yr)})")

    print(f"\n=== ACCURACY of the affine clearing line (corrected) ===")
    errs = [abs(p - (a + b * w)) for w, p in allc]
    print(f"  MAE ${round(statistics.mean(errs),2)}K · median |err| ${round(statistics.median(errs),2)}K · within ±$5K {round(100*sum(1 for e in errs if e<=5)/len(errs))}%")

    print(f"\n=== TAIL ZEROS — the $0-worth startable players (v13 forces them onto the hand-set floor) ===")
    for pos in ["QB", "RB", "WR", "TE"]:
        cz = curve.get(pos, {}).get("p50", [])
        z = next((i + 1 for i, v in enumerate(cz) if v <= 0.01), None)
        print(f"  {pos}: redraft worth hits $0 at rank {z}")

    if args.json:
        print("\n" + json.dumps({"affine_ante": a, "affine_slope": b, "affine_mse": mse, "n": n,
                                  "inflation_dollar_weighted": round(tot_paid/tot_worth, 2),
                                  "mae_k": round(statistics.mean(errs), 2)}))


if __name__ == "__main__":
    main()
