#!/usr/bin/env python3
"""Phase B — expected-APW-by-ADP-slot curves.

For each position, learn E[APW | positional ADP rank] from history, on TWO axes:
  - redraft  (adp_history.csv, joins on mfl_id)        = production-truth axis
  - dynasty  (dynasty_adp_history.csv, fp_id→mfl_id)   = auction-market axis

Method per (axis, position):
  - p50 log-linear backbone  E[APW] = b0 + b1·ln(rank)  (OLS; reported in meta)
  - p25/p50/p90 empirical quantile bands over a ±6 rank window (widen if sparse),
    isotonic-projected to be non-increasing in rank, clamped ≥0.
A drafted player with NO starter APW that season counts as APW=0 (keeps the bust
tail honest — ~40% of mid/late picks return ~0). Fit seasons: QB 2022-2025
(Superflex doubled QB starter-weeks, pre-SF non-comparable); RB/WR/TE 2020-2025.

Output: docs/auction/data/eapw_curves.json.
"""
from __future__ import annotations
import csv, json, math, subprocess
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
MAXR = 80                      # rank lookups 1..80
SKILL = ["QB", "RB", "WR", "TE"]
FIT_FROM = {"QB": 2022, "RB": 2020, "WR": 2020, "TE": 2020}   # QB SF-only


def d1(sql):
    res = subprocess.run(
        ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql],
        cwd=WORKER, capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        raise RuntimeError(res.stderr[-1500:])
    out = res.stdout
    return json.loads(out[out.find("["):])[0]["results"]


def rank_of(s):
    d = "".join(c for c in (s or "") if c.isdigit())
    return int(d) if d else None


def isotonic_decreasing(y):
    """Pool-adjacent-violators → nearest non-increasing fit (weights=1)."""
    y = [float(v) for v in y]
    # solve non-decreasing on reversed, then reverse back
    r = y[::-1]
    vals = list(r); wts = [1.0] * len(r); idx = [[i] for i in range(len(r))]
    i = 0
    while i < len(vals) - 1:
        if vals[i] > vals[i + 1] + 1e-12:
            nv = (vals[i] * wts[i] + vals[i + 1] * wts[i + 1]) / (wts[i] + wts[i + 1])
            vals[i] = nv; wts[i] += wts[i + 1]; idx[i] += idx[i + 1]
            del vals[i + 1]; del wts[i + 1]; del idx[i + 1]
            if i > 0: i -= 1
        else:
            i += 1
    res = [0.0] * len(r)
    for v, g in zip(vals, idx):
        for j in g: res[j] = v
    return [max(0.0, v) for v in res[::-1]]


def fit_curve(pairs):
    """pairs: list of (rank, apw). Returns rank→{p25,p50,p90} + log-linear coeffs."""
    if len(pairs) < 20:
        return None
    ranks = np.array([p[0] for p in pairs], float)
    apws = np.array([p[1] for p in pairs], float)
    # log-linear p50 backbone (OLS apw ~ ln(rank))
    b1, b0 = np.polyfit(np.log(ranks), apws, 1)
    # windowed empirical quantiles per rank, then isotonic
    p25 = []; p50 = []; p90 = []
    for r in range(1, MAXR + 1):
        for half in (6, 12, 18, 30):
            m = (ranks >= r - half) & (ranks <= r + half)
            if m.sum() >= 15 or half == 30:
                break
        sample = apws[m] if m.sum() else apws
        p25.append(float(np.percentile(sample, 25)))
        p50.append(float(np.percentile(sample, 50)))
        p90.append(float(np.percentile(sample, 90)))
    p25 = isotonic_decreasing(p25); p50 = isotonic_decreasing(p50); p90 = isotonic_decreasing(p90)
    # v4 TAIL FLOOR (audit fix): the empirical p50 hard-zeros deep (QB33/RB39/WR46/TE21),
    # forcing every startable player past that rank to redraft worth $0 and onto a hand-set
    # startability table. Replace the hard 0 with a gentle exponential decay so a ranked
    # player never has exactly $0 production worth (floor 0.9·e^(−rank/40) APWE → ~$2.9 at
    # rank 33, ~$1.4 at rank 60). Non-increasing by construction; only lifts where p50 hit 0.
    p50 = [round(max(v, 0.9 * math.exp(-(r) / 40.0)), 2) for r, v in enumerate(p50, 1)]
    return {"b0": round(float(b0), 3), "b1": round(float(b1), 3), "n": len(pairs),
            "p25": [round(v, 2) for v in p25], "p50": p50,
            "p90": [round(v, 2) for v in p90]}


def main():
    # per (season, mfl_id): APW (legacy all-play %) AND APWE (all-play wins EARNED = the
    # value metric). Pick the player's primary pos_group (max games).
    apw, apwe = {}, {}
    for r in csv.DictReader(open(DATA / "apw_seasonal.csv")):
        key = (int(r["season"]), str(r["player_id"]))
        gp = int(r["gp_started"])
        if key not in apw or gp > apw[key][2]:
            apw[key] = (r["pos"], float(r["apw_started"]), gp)
            apwe[key] = (r["pos"], float(r["apwe_started"]), gp)

    # fp_id → mfl_id crosswalk
    fp2mfl = {}
    for row in d1("SELECT mfl_id, fantasypros_id FROM ff_player_ids WHERE fantasypros_id IS NOT NULL"):
        fp2mfl[str(row["fantasypros_id"])] = str(row["mfl_id"])

    # ---- collect (pos, rank, value) pairs on each axis ----
    # fpros = FantasyPros REDRAFT rank → APWE (the startability-aware market proxy → earned
    # all-play wins; THIS is the value expectation Keith wants). redraft/dynasty kept on the
    # legacy APW for reference.
    pairs = {"fpros": {p: [] for p in SKILL}, "redraft": {p: [] for p in SKILL}, "dynasty": {p: [] for p in SKILL}}

    for r in csv.DictReader(open(DATA / "fpros_adp_history.csv")):     # FANTASYPROS REDRAFT → APWE
        pos, s = r["pos"], int(r["season"])
        if pos not in SKILL or s < FIT_FROM[pos] or s < 2022 or s > 2025 or not r["mfl_id"]:
            continue
        val = apwe.get((s, str(r["mfl_id"])), (pos, 0.0, 0))[1]         # ranked but no APWE → 0 (didn't produce)
        pairs["fpros"][pos].append((int(r["fp_pos_rank"]), val))

    for r in csv.DictReader(open(DATA / "adp_history.csv")):           # FFC REDRAFT → APW (legacy)
        pos, s = r["pos"], int(r["season"])
        if pos not in SKILL or s < FIT_FROM[pos] or s < 2020:
            continue
        rk = rank_of(r["pos_rank"])
        if not rk:
            continue
        pairs["redraft"][pos].append((rk, apw.get((s, str(r["mfl_id"])), (pos, 0.0, 0))[1]))

    for r in csv.DictReader(open(DATA / "dynasty_adp_history.csv")):   # DYNASTY-SF → APWE (asset/longevity value)
        pos, s = r["pos"], int(r["season"])
        if pos not in SKILL or s < FIT_FROM[pos]:
            continue
        rk = rank_of(r["sf_pos_rank"]); mid = fp2mfl.get(str(r["fp_id"]))
        if not rk or not mid:
            continue
        pairs["dynasty"][pos].append((rk, apwe.get((s, mid), (pos, 0.0, 0))[1]))

    curves = {"fpros": {}, "redraft": {}, "dynasty": {}}
    for axis in curves:
        for pos in SKILL:
            c = fit_curve(pairs[axis][pos])
            if c:
                curves[axis][pos] = c

    out = {"meta": {
        "method": "E[value|ADP pos-rank]: log-linear p50 backbone + isotonic-smoothed empirical p25/p50/p90. missing→0 (bust). QB fit SF-only 2022-2025; RB/WR/TE 2020-2025.",
        "axes": "fpros=FantasyPros REDRAFT rank → APWE (all-play wins EARNED, the value expectation); redraft/dynasty → legacy APW%",
        "fit_seasons": FIT_FROM, "max_rank": MAXR,
    }, "curves": curves}
    (DATA / "eapw_curves.json").write_text(json.dumps(out, indent=2))
    print(f"wrote {(DATA / 'eapw_curves.json').relative_to(REPO)}")

    print(f"\n=== fpros axis — E[APWE] p50 by REDRAFT pos-rank (the value expectation; validate QB≫TE) ===")
    print(f"  {'pos':<4}{'n':>6}    r1    r6   r12   r24   r36   r60")
    for pos in SKILL:
        c = curves["fpros"].get(pos)
        if not c:
            print(f"  {pos:<4} (insufficient)"); continue
        g = lambda r: c["p50"][min(r, len(c["p50"])) - 1]
        print(f"  {pos:<4}{c['n']:>6}" + "".join(f"{g(r):>6.1f}" for r in (1, 6, 12, 24, 36, 60)))
    print("\n=== anchor checks (E[APWE] p25/p50/p90 at the player's 2026 redraft rank) ===")
    for pos, rk, nm in [("QB", 1, "Allen QB1"), ("QB", 23, "Darnold QB23"), ("TE", 10, "Kelce TE10"), ("RB", 90, "Mixon RB90"), ("WR", 56, "Diggs WR56")]:
        c = curves["fpros"].get(pos)
        if c:
            i = min(rk, len(c["p50"])) - 1
            print(f"  {nm:<14} p25 {c['p25'][i]:>5.1f}  p50 {c['p50'][i]:>5.1f}  p90 {c['p90'][i]:>5.1f}")


if __name__ == "__main__":
    main()
