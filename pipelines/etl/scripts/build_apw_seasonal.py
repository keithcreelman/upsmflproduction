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

        agg = collections.defaultdict(lambda: {"started": 0.0, "bestball": 0.0, "gp_s": 0, "gp_a": 0, "pos": None})
        for r in rows:
            wk = int(r["week"]); pos = r["pos"]; sc = float(r["score"] or 0); pid = str(r["player_id"])
            fld = (field.get(wk) or {}).get(pos)
            if not fld:
                continue
            started = (r["status"] or "") == "starter"
            # compare vs the OTHER started players at the position (remove one own row if started)
            others = [x[1] for x in fld if x[0] != pid] if started else [x[1] for x in fld]
            apw = allplay_fraction(sc, others)
            if apw is None:
                continue
            a = agg[pid]; a["pos"] = pos
            a["bestball"] += apw; a["gp_a"] += 1
            if started:
                a["started"] += apw; a["gp_s"] += 1
        for pid, a in agg.items():
            out.append({"season": season, "player_id": pid, "player": names.get(pid, ""),
                        "pos": a["pos"], "gp_started": a["gp_s"], "gp_all": a["gp_a"],
                        "apw_started": round(a["started"], 3), "apw_bestball": round(a["bestball"], 3)})
        print(f"  {season}: {len(agg)} player-seasons", flush=True)

    out.sort(key=lambda x: (x["season"], -x["apw_started"]))
    with open(DATA / "apw_seasonal.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["season", "player_id", "player", "pos", "gp_started", "gp_all", "apw_started", "apw_bestball"])
        w.writeheader(); w.writerows(out)
    print(f"\nwrote {(DATA / 'apw_seasonal.csv').relative_to(REPO)} ({len(out)} player-seasons)")

    # ── acceptance tests ──
    s24 = [r for r in out if r["season"] == 2024]
    print("\n=== (a) 2024 top-10 apw_started — expect top ≈ 13-15 ===")
    for r in sorted(s24, key=lambda x: -x["apw_started"])[:10]:
        print(f"  {r['player'][:22]:<23}{r['pos']:>3}  started {r['apw_started']:>5.1f}  bestball {r['apw_bestball']:>5.1f}  (gp {r['gp_started']}/{r['gp_all']})")
    fulltime = [r for r in s24 if r["gp_started"] >= 12 and r["pos"] in SKILL]
    if fulltime:
        med = statistics.median([r["apw_started"] for r in fulltime])
        print(f"\n=== (b) 2024 median full-time starter (gp>=12) apw_started = {med:.1f} (expect ≈7) ===")
    print("\n=== (c) position field sizes (W1 each season — the all-play denominator) ===")
    for season in SEASONS:
        wk1 = diag[season].get(1, {})
        if wk1: print(f"  {season} W1 started field: " + " ".join(f"{p}={wk1.get(p,0)}" for p in ['QB','RB','WR','TE']))
    print("\n=== (d) Kyle Pitts (15329) started vs bestball by season ===")
    for r in sorted([r for r in out if r["player_id"] == "15329"], key=lambda x: x["season"]):
        print(f"  {r['season']}: started {r['apw_started']:.1f}  bestball {r['apw_bestball']:.1f}  (gp {r['gp_started']}/{r['gp_all']})")
    print("\n=== (e) Josh Allen (13589) by season — expect elite ≈12-14, sticky ===")
    for r in sorted([r for r in out if r["player_id"] == "13589"], key=lambda x: x["season"]):
        print(f"  {r['season']}: started {r['apw_started']:.1f}  bestball {r['apw_bestball']:.1f}  (gp {r['gp_started']}/{r['gp_all']})")


if __name__ == "__main__":
    main()
