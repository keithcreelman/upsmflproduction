#!/usr/bin/env python3
"""Phase A — seasonal APW (Adjusted All-Play Wins) per player.

APW(player, season) = ( Σ_reg-weeks win_chunks ) × positional_leverage_β[pos_group]
  - win_chunks (D1 src_weekly): a player's per-week distance from the positional
    starter median, in "win chunks" (only populated for STARTER weeks). It's the
    raw all-play-win contribution before positional weighting.
  - β (positional leverage, from worker POS_LEVERAGE_2026): scales by how much a
    point at that position moves a team's all-play outcome (SF QBs ~2.2× a DB).

win_chunks exists only for 2010-2011 + 2020-2025; we emit 2020-2025 (the window
that overlaps ADP history). Output: docs/auction/data/apw_seasonal.csv.
"""
from __future__ import annotations
import csv, json, subprocess, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
DB = "ups-mfl-db"

# canonical positional leverage β (worker/src/index.js POS_LEVERAGE_2026, year-flat)
BETA = {"QB": 0.8825, "RB": 0.8162, "WR": 0.8168, "TE": 0.6953,
        "DB": 0.3945, "DL": 0.5184, "LB": 0.3801, "PK": 0.3844, "PN": 0.3844}


def d1(sql):
    """Run a read-only SELECT against remote D1 via wrangler, return rows."""
    res = subprocess.run(
        ["npx", "--yes", "wrangler@latest", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        cwd=WORKER, capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        raise RuntimeError(f"d1 query failed:\n{res.stderr[-1500:]}")
    # wrangler may prefix non-JSON lines; grab the JSON array
    out = res.stdout
    i = out.find("[")
    return json.loads(out[i:])[0]["results"]


def mfl_names():
    """MFL player id → name (current export; for readability/validation)."""
    u = "https://www48.myfantasyleague.com/2026/export?TYPE=players&L=74598&JSON=1"
    req = urllib.request.Request(u, headers={"User-Agent": "ups", "Accept": "*/*"})
    pl = json.loads(urllib.request.urlopen(req, timeout=30).read())
    return {str(p.get("id")): p.get("name") for p in pl["players"]["player"]}


def main():
    rows = d1(
        "SELECT season, player_id, pos_group, "
        "SUM(win_chunks) sum_wc, COUNT(*) gp "
        "FROM src_weekly WHERE win_chunks IS NOT NULL AND season BETWEEN 2020 AND 2025 "
        "GROUP BY season, player_id, pos_group")
    names = mfl_names()

    out = []
    for r in rows:
        pos = r["pos_group"]
        beta = BETA.get(pos, 0.0)
        sum_wc = float(r["sum_wc"] or 0)
        out.append({
            "season": int(r["season"]), "player_id": str(r["player_id"]),
            "player": names.get(str(r["player_id"]), ""),
            "pos": pos, "gp": int(r["gp"]),
            "sum_wc": round(sum_wc, 3), "apw": round(sum_wc * beta, 3),
        })
    out.sort(key=lambda x: (x["season"], -x["apw"]))

    with open(DATA / "apw_seasonal.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["season", "player_id", "player", "pos", "gp", "sum_wc", "apw"])
        w.writeheader()
        w.writerows(out)
    print(f"wrote {(DATA / 'apw_seasonal.csv').relative_to(REPO)} ({len(out)} player-seasons, 2020-2025)")

    print("\n=== 2024 top-12 APW (validate: #1 ≈ Lamar 19.2) ===")
    top = sorted([r for r in out if r["season"] == 2024], key=lambda x: -x["apw"])[:12]
    for r in top:
        print(f"  {r['player'][:24]:<25}{r['pos']:>3}  APW {r['apw']:>6.2f}  (gp {r['gp']}, Σwc {r['sum_wc']:.2f})")
    print("\n=== per-position APW ceiling (2024 top / mean) ===")
    import collections
    byp = collections.defaultdict(list)
    for r in out:
        if r["season"] == 2024: byp[r["pos"]].append(r["apw"])
    for pos in ["QB", "RB", "WR", "TE"]:
        v = sorted(byp.get(pos, []), reverse=True)
        if v: print(f"  {pos}: top {v[0]:.2f}  mean {sum(v)/len(v):.2f}  (n {len(v)})")


if __name__ == "__main__":
    main()
