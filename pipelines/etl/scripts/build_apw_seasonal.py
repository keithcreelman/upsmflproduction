#!/usr/bin/env python3
"""Phase A (v2) — seasonal APW as STANDARDIZED, ABSOLUTE, SATURATING all-play wins.

The v1 metric (win_chunks × β) was a marginal, un-saturating, started-only score
(centered at 0, could go negative, over-credited tail weeks, ignored benched/
playoff games). This rebuilds it to the definition the commissioner specified:

  "Holding every other lineup slot at MEDIAN, how many all-play wins is THIS
   performance worth? Anchor it to the team all-play standings — the #1 all-play
   team beats 11, work your way down — a standardized, year-over-year number."

Per player-week, the performance is judged as all-play AT THE POSITION — the player
analog of the team all-play standings (the #1 team beats 11; the #1 player at his
position beats the field):
  field[wk,pos] = the scores of every STARTED player at that position that week
  apw_wk        = (# of the OTHER field players this score beats, ties 0.5) / (field−1)  ∈ [0,1]
The #1 player at his position that week → beats everyone → ~1.0 (SATURATES); a median
starter → ~0.5; a dud → ~0. This is context-free (judged on the performance itself vs
peers, "not his fault" how his teammates/opponent played) and standardized 0→1/week.
Season:
  apw_started  = Σ apw_wk over weeks the player was STARTED (reg + playoff)
  apw_bestball = Σ apw_wk over ALL weeks he played (start/sit-optimal ceiling; incl
                 benched + playoff — finally credits e.g. Pitts 2025 W15 = 55.7 benched)
Output is the RAW all-play number (top ≈ 14, median full-time starter ≈ 7); the
positional-leverage β is applied DOWNSTREAM (curves/value) so this stays an
interpretable, comparable "all-play wins" figure. Emits docs/auction/data/apw_seasonal.csv.
"""
from __future__ import annotations
import csv, json, statistics, subprocess, urllib.request, collections
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
SEASONS = range(2020, 2026)
SKILL = {"QB", "RB", "WR", "TE"}
# ── Points-Above-Replacement → All-Play Wins Earned (the value metric) ──
# Replacement = the league's revealed weekly STARTER demand (SF era): the Nth-best
# started player at the position each week is the "replacement bar" you'd otherwise
# field. A player's edge = his score above that bar, summed over weeks he played
# (missed/benched weeks net 0 — you fill replacement, so durability is rewarded:
# 6 great weeks < 17 near-great weeks). SLOPE converts team points → all-play wins
# (regressed: +1 team point ≈ 0.088 all-play wins/week), so PAR × SLOPE = the
# all-play wins a player's production EARNS you — points-based, scarcity-aware
# (replacement differs by position), and NON-saturating (unlike the raw all-play %).
REPL_RANK = {"QB": 24, "RB": 30, "WR": 40, "TE": 13}
SLOPE = 0.088


def d1(sql):
    res = subprocess.run(
        ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql],
        cwd=WORKER, capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        raise RuntimeError(res.stderr[-1500:])
    out = res.stdout
    return json.loads(out[out.find("["):])[0]["results"]


def mfl_names():
    u = "https://www48.myfantasyleague.com/2026/export?TYPE=players&L=74598&JSON=1"
    req = urllib.request.Request(u, headers={"User-Agent": "ups", "Accept": "*/*"})
    pl = json.loads(urllib.request.urlopen(req, timeout=30).read())
    return {str(p.get("id")): p.get("name") for p in pl["players"]["player"]}


def allplay_fraction(s, others):
    """Fraction of `others` that score s beats (ties=0.5), normalized to [0,1]."""
    n = len(others)
    if n < 1:
        return None
    below = sum(1 for x in others if x < s) + 0.5 * sum(1 for x in others if x == s)
    return max(0.0, min(1.0, below / n))


def main():
    names = mfl_names()
    out = []
    diag = {}  # season -> per-week field sizes for sanity
    for season in SEASONS:
        rows = d1(
            "SELECT week, player_id, roster_franchise_id fid, pos_group pos, "
            "score, status, is_reg FROM src_weekly WHERE season=%d AND score IS NOT NULL" % season)
        # the started field per (week, pos): list of (player_id, score)
        field = collections.defaultdict(lambda: collections.defaultdict(list))  # wk -> pos -> [(pid,score)]
        for r in rows:
            if (r["status"] or "") == "starter":
                field[int(r["week"])][r["pos"]].append((str(r["player_id"]), float(r["score"] or 0)))
        diag[season] = {wk: {p: len(v) for p, v in d.items() if p in SKILL} for wk, d in sorted(field.items())}
        # SEASON replacement level per pos = the PPG of the REPL_RANK-th regular starter
        # (the league's weekly demand cutoff), a stable VORP baseline (~QB24 ≈ 12 PPG).
        ptot = collections.defaultdict(lambda: [0.0, 0])  # (pid,pos) -> [sum_started, gp_started]
        for r in rows:
            if (r["status"] or "") == "starter":
                t = ptot[(str(r["player_id"]), r["pos"])]; t[0] += float(r["score"] or 0); t[1] += 1
        repl_ppg = {}
        for pos in SKILL:
            ppgs = sorted((s / g for (p, po), (s, g) in ptot.items() if po == pos and g >= 8), reverse=True)
            cut = REPL_RANK[pos]
            repl_ppg[pos] = ppgs[cut - 1] if len(ppgs) >= cut else (ppgs[-1] if ppgs else 0.0)

        agg = collections.defaultdict(lambda: {"apw_s": 0.0, "apw_b": 0.0, "par_s": 0.0, "par_b": 0.0, "gp_s": 0, "gp_a": 0, "pos": None})
        for r in rows:
            wk = int(r["week"]); pos = r["pos"]; sc = float(r["score"] or 0); pid = str(r["player_id"])
            fld = (field.get(wk) or {}).get(pos)
            if not fld:
                continue
            started = (r["status"] or "") == "starter"
            others = [x[1] for x in fld if x[0] != pid] if started else [x[1] for x in fld]
            apw = allplay_fraction(sc, others)
            if apw is None:
                continue
            par = sc - repl_ppg.get(pos, 0.0)   # points above the season replacement level
            a = agg[pid]; a["pos"] = pos
            a["apw_b"] += apw; a["par_b"] += max(0.0, par); a["gp_a"] += 1   # best-ball: bench sub-repl weeks
            if started:
                a["apw_s"] += apw; a["par_s"] += par; a["gp_s"] += 1          # started: as-played (neg allowed)
        for pid, a in agg.items():
            out.append({"season": season, "player_id": pid, "player": names.get(pid, ""),
                        "pos": a["pos"], "gp_started": a["gp_s"], "gp_all": a["gp_a"],
                        "apw_started": round(a["apw_s"], 3), "apw_bestball": round(a["apw_b"], 3),
                        "par_started": round(a["par_s"], 1), "par_bestball": round(a["par_b"], 1),
                        "apwe_started": round(a["par_s"] * SLOPE, 2), "apwe_bestball": round(a["par_b"] * SLOPE, 2)})
        print(f"  {season}: {len(agg)} player-seasons", flush=True)

    out.sort(key=lambda x: (x["season"], -x["apwe_started"]))
    with open(DATA / "apw_seasonal.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["season", "player_id", "player", "pos", "gp_started", "gp_all",
                                          "apw_started", "apw_bestball", "par_started", "par_bestball",
                                          "apwe_started", "apwe_bestball"])
        w.writeheader(); w.writerows(out)
    print(f"\nwrote {(DATA / 'apw_seasonal.csv').relative_to(REPO)} ({len(out)} player-seasons)")

    # ── acceptance tests (APWE = all-play wins earned = PAR × slope; the proper spread) ──
    s24 = [r for r in out if r["season"] == 2024]
    print("\n=== (a) 2024 top-12 by APWE — expect a PROPER spread (QB ≫ TE), not the flat APW band ===")
    print(f"  {'player':<22}{'pos':>4}{'PAR':>7}{'APWE':>7}{'apw%':>7}  (gp)")
    for r in sorted(s24, key=lambda x: -x["apwe_started"])[:12]:
        print(f"  {r['player'][:21]:<22}{r['pos']:>4}{r['par_started']:>7.0f}{r['apwe_started']:>7.1f}{r['apw_started']:>7.1f}  ({r['gp_started']})")
    print("\n=== (b) Allen vs Kelce edge (the test that was failing) ===")
    al = next(r for r in s24 if r["player_id"] == "13589"); ke = next((r for r in s24 if r["player_id"] == "15329"), None)
    print(f"  Allen APWE {al['apwe_started']:.1f} (PAR {al['par_started']:.0f}) ; old apw% {al['apw_started']:.1f}")
    print("\n=== (c) Mixon (15257) — should be LOW now (no individual prediction here; this is realized) ===")
    for r in sorted([r for r in out if r["player_id"] == "15257"], key=lambda x: x["season"]):
        print(f"  {r['season']}: APWE {r['apwe_started']:>5.1f}  PAR {r['par_started']:>6.0f}  apw% {r['apw_started']:.1f}  (gp {r['gp_started']})")
    print("\n=== (d) durability — Kyle Pitts (15329) started vs best-ball APWE ===")
    for r in sorted([r for r in out if r["player_id"] == "15329"], key=lambda x: x["season"]):
        print(f"  {r['season']}: APWE started {r['apwe_started']:>5.1f}  best-ball {r['apwe_bestball']:>5.1f}  (gp {r['gp_started']}/{r['gp_all']})")


if __name__ == "__main__":
    main()
