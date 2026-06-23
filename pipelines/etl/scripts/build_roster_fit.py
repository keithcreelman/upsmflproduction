#!/usr/bin/env python3
"""Phase E — league-wide roster fit + competition + finalize the FA value blob.

1. Pull all 12 live rosters → each team's projected APW by position (rostered
   players' E[APW]_p50) vs a startable baseline B[pos] (E[APW] at the marginal
   starter slot given the SF lineup) → per-team NEED / SURPLUS.
2. Filter the Phase-D value layer to AVAILABLE FAs (unrostered).
3. Per FA: 0008's fit (NEED/SURPLUS/OK at that position) + a COMPETITION forecast
   (other teams with a NEED there, ranked by need × cap space).
4. Post-auction fill context (transactions_adddrop, auction→Week-1 window): do
   teams fill to 35 at the auction, or lock in fewer and add via waivers?
5. Write fa_value.json (lean, FAs only) + fa_valuation.csv; --push-d1 upserts the
   ups_auction_fa_value blob.
"""
from __future__ import annotations
import argparse, csv, json, re, sqlite3, subprocess, time, urllib.request, collections
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
DB = "/tmp/ups_auction_canon.db"
LEAGUE = "74598"; YEAR = 2026; CAP = 300000
SKILL = ["QB", "RB", "WR", "TE"]
SLOTS = {"QB": 2, "RB": 2, "WR": 2, "TE": 1}        # SF starting demand per team
REPL_RANK = {"QB": 24, "RB": 31, "WR": 31, "TE": 14}  # replacement (marginal-starter) rank
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def jget(u):
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "ups", "Accept": "*/*"}), timeout=30).read())


def nkey(s):
    s = (s or "").strip().lower()
    if "," in s: a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--push-d1", action="store_true")
    args = ap.parse_args()

    core = json.loads((DATA / "fa_value_core.json").read_text())["players"]
    by_name = {nkey(p["player"]): p for p in core}
    curve = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["dynasty"]
    rate = json.loads((DATA / "market_rate.json").read_text())["rate"]
    B = {pos: (curve[pos]["p50"][REPL_RANK[pos] - 1] if pos in curve else 0.0) for pos in SKILL}

    # ---- live league state ----
    rosters = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]
    players = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=players&L={LEAGUE}&JSON=1")["players"]["player"]
    id2name = {str(p["id"]): p.get("name") for p in players}
    lg = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=league&L={LEAGUE}&JSON=1")["league"]
    fid2team = {f["id"]: f.get("name", f["id"]) for f in lg["franchises"]["franchise"]}

    rostered_names, team = set(), {}
    for fr in rosters:
        fid = fr["id"]
        pls = fr.get("player", [])
        if isinstance(pls, dict): pls = [pls]
        active_sal = 0; apw_by_pos = collections.defaultdict(list)
        for p in pls:
            nm = id2name.get(str(p.get("id")))
            if nm: rostered_names.add(nkey(nm))
            if p.get("status") == "ROSTER":
                active_sal += int(p.get("salary") or 0)
            c = by_name.get(nkey(nm or ""))
            if c and c["pos"] in SKILL and c.get("e_apw_p50") is not None:
                apw_by_pos[c["pos"]].append(c["e_apw_p50"])
        fit = {}
        for pos in SKILL:
            vals = sorted(apw_by_pos.get(pos, []), reverse=True)
            starters = (vals + [0.0] * SLOTS[pos])[:SLOTS[pos]]
            need = round(sum(max(0.0, B[pos] - v) for v in starters), 2)
            surplus = round(sum(max(0.0, v - B[pos]) for v in vals), 2)
            fit[pos] = {"need": need, "surplus": surplus, "starters_apw": round(sum(vals[:SLOTS[pos]]), 2)}
        team[fid] = {"team": fid2team.get(fid, fid), "capspace": CAP - active_sal,
                     "active_salary": active_sal, "fit": fit}

    def need_label(fid, pos):
        f = team[fid]["fit"][pos]; b = B[pos] or 0.01
        if f["need"] > 0.4 * b: return "NEED"
        if f["surplus"] > 0.8 * b: return "SURPLUS"
        return "OK"

    def competition(pos):
        cands = []
        for fid, t in team.items():
            if fid == "0008": continue
            f = t["fit"][pos]; b = B[pos] or 0.01
            if f["need"] > 0.4 * b:
                cands.append((f["need"] * max(0.05, t["capspace"] / CAP), fid, t["team"], f["need"], t["capspace"]))
        cands.sort(reverse=True)
        return [{"fid": fid, "team": tm, "need": round(nd, 2), "capspace": cs} for _, fid, tm, nd, cs in cands[:3]]

    # ---- available FAs (unrostered) ----
    fas = []
    for p in core:
        if nkey(p["player"]) in rostered_names: continue
        pos = p["pos"]
        comp = competition(pos) if pos in SKILL else []
        fas.append({**p, "fit_0008": need_label("0008", pos) if pos in SKILL else "—",
                    "competition": comp})
    fas.sort(key=lambda x: -(x["e_apw_p50"] or 0))

    # ---- post-auction fill context ----
    c = sqlite3.connect(DB)
    fill = []
    for s in range(2020, 2026):
        end = c.execute("SELECT MAX(date_et) FROM transactions_auction WHERE season=? AND auction_type='FreeAgent'", (s,)).fetchone()[0]
        wins = c.execute("SELECT COUNT(*) FROM transactions_auction WHERE season=? AND auction_type='FreeAgent' AND finalbid_ind=1", (s,)).fetchone()[0]
        adds = c.execute("SELECT COUNT(*) FROM transactions_adddrop WHERE season=? AND move_type='ADD' AND date_et > ? AND date_et <= ?",
                         (s, end or f"{s}-08-01", f"{s}-09-08")).fetchone()[0]
        fill.append({"season": s, "auction_end": end, "wins_per_team": round(wins / 12, 1), "post_auction_adds_per_team": round(adds / 12, 1)})
    fill_avg = round(sum(f["post_auction_adds_per_team"] for f in fill) / len(fill), 1)

    payload = {
        "meta": {
            "generated": "build_roster_fit.py", "n_fas": len(fas),
            "baseline_apw": {pos: round(B[pos], 2) for pos in SKILL},
            "replacement_rank": REPL_RANK, "starter_slots": SLOTS,
            "market_rate": {pos: {"R": rate[pos]["R"], "R_conf": rate[pos]["R_conf"],
                                  "preSF": rate[pos]["preSF"]["median"], "SF": rate[pos]["SF"]["median"]} for pos in SKILL},
            "fill": {"by_season": fill, "avg_post_auction_adds_per_team": fill_avg,
                     "note": "adds between auction-end and ~Week 1; high = teams lock in fewer at auction and fill via waivers"},
            "verdict_legend": "SPLURGE/VALUE/FAIR/OVERPAY/DART by value_ratio=R[pos]/(price/E[APW]); value_conf=solid|estimate",
        },
        "teams": {fid: {"team": t["team"], "capspace": t["capspace"], "fit": t["fit"]} for fid, t in team.items()},
        "fas": [{
            "player": p["player"], "pos": p["pos"], "age": p["age"],
            "dyn_sf_rank": p["dyn_sf_rank"], "redraft_rank": p["redraft_rank"],
            "win_now": p["win_now"], "asset": p["asset"], "deal_type": p["deal_type"],
            "low_k": p["low_k"], "median_k": p["median_k"], "top10_k": p["top10_k"],
            "e_apw_p25": p["e_apw_p25"], "e_apw_p50": p["e_apw_p50"], "e_apw_p90": p["e_apw_p90"],
            "implied_apw": p["implied_apw"], "value_ratio": p["value_ratio"],
            "verdict": p["verdict"], "value_conf": p["value_conf"],
            "fit_0008": p["fit_0008"], "competition": p["competition"],
        } for p in fas],
    }
    (DATA / "fa_value.json").write_text(json.dumps(payload, indent=2))
    blob_len = len(json.dumps(payload))
    print(f"wrote {(DATA / 'fa_value.json').relative_to(REPO)} ({len(fas)} FAs, blob {blob_len/1024:.1f}KB)")

    # ---- CSV ----
    cols = ["player", "pos", "age", "dyn_sf_rank", "redraft_rank", "win_now", "asset",
            "low_k", "median_k", "top10_k", "e_apw_p50", "e_apw_p90", "implied_apw",
            "value_ratio", "verdict", "value_conf", "fit_0008", "deal_type", "top_competitors"]
    with open(DATA / "fa_valuation.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for p in fas:
            w.writerow({**p, "top_competitors": "; ".join(x["team"] for x in p["competition"])})
    print(f"wrote {(DATA / 'fa_valuation.csv').relative_to(REPO)}")

    # ---- summaries ----
    print(f"\n=== startable baseline B[pos] (E[APW] at replacement rank) ===")
    print("  " + "  ".join(f"{pos}{REPL_RANK[pos]}={B[pos]:.2f}" for pos in SKILL))
    print(f"\n=== post-auction fill (avg adds/team after auction, pre-Week1) = {fill_avg} ===")
    for f in fill:
        print(f"  {f['season']}: won {f['wins_per_team']}/team at auction, +{f['post_auction_adds_per_team']} waiver adds/team after")
    print(f"\n=== 0008 roster fit (need/surplus by pos) ===")
    for pos in SKILL:
        ff = team["0008"]["fit"][pos]
        print(f"  {pos}: need {ff['need']:.1f}  surplus {ff['surplus']:.1f}  → {need_label('0008', pos)}")
    print(f"\n=== top FA targets for 0008 (by E[APW], with fit + competition) ===")
    print(f"  {'player':<20}{'rk':>5}{'E50':>5}{'$K':>5}{'vr':>5}  {'verdict':<8}{'fit':<8} competition")
    for p in fas[:14]:
        print(f"  {p['player'][:19]:<20}{p['dyn_sf_rank']:>5}{(p['e_apw_p50'] or 0):>5.1f}{str(p['median_k']):>5}"
              f"{str(p['value_ratio'] or '-'):>5}  {p['verdict']:<8}{p['fit_0008']:<8}{', '.join(x['team'] for x in p['competition'][:2])}")

    if args.push_d1:
        # lean/compact payload for D1 (per-statement SQLITE_TOOBIG ~100KB). Short
        # keys + top-2 competition as fids + rounding; the View maps the keys. The
        # full readable shape stays in the committed fa_value.json + CSV.
        def r1(v): return round(v, 1) if isinstance(v, (int, float)) else v
        DT = {"cut-free dart": "d", "1-yr rental / flip": "r", "multi-year build": "m",
              "anchor": "a", "1-yr / situational": "s"}
        VC = {"solid": "s", "estimate": "e"}
        FT = {"NEED": "N", "SURPLUS": "S", "OK": "-", "—": "-"}
        lean = {
            "meta": payload["meta"],
            "key": {"n": "player", "p": "pos", "dr": "dyn_sf_rank", "rr": "redraft_rank",
                    "wn": "win_now", "as": "asset", "dt": "deal_type", "lk": "low_k",
                    "mk": "median_k", "tk": "top10_k",
                    "a25": "e_apw_p25", "a50": "e_apw_p50", "a90": "e_apw_p90",
                    "vr": "value_ratio", "v": "verdict", "vc": "value_conf",
                    "f": "fit_0008", "c": "competition_fids",
                    "_dt": {v: k for k, v in DT.items()}, "_vc": {v: k for k, v in VC.items()},
                    "_f": {"N": "NEED", "S": "SURPLUS", "-": "OK"}},
            "teams": {fid: {"team": t["team"], "capspace": t["capspace"],
                            "fit": {pos: {"need": t["fit"][pos]["need"], "surplus": t["fit"][pos]["surplus"]} for pos in SKILL}}
                      for fid, t in team.items()},
            "fas": [{
                "n": p["player"], "p": p["pos"], "dr": p["dyn_sf_rank"], "rr": p["redraft_rank"],
                "wn": p["win_now"], "as": p["asset"], "dt": DT.get(p["deal_type"], "s"),
                "lk": p["low_k"], "mk": p["median_k"], "tk": p["top10_k"],
                "a25": r1(p["e_apw_p25"]), "a50": r1(p["e_apw_p50"]), "a90": r1(p["e_apw_p90"]),
                "vr": p["value_ratio"], "v": p["verdict"], "vc": VC.get(p["value_conf"], "e"),
                "f": FT.get(p["fit_0008"], "-"), "c": [x["fid"] for x in p["competition"][:2]],
            } for p in fas],
        }
        blob = json.dumps(lean, separators=(",", ":")).replace("'", "''")
        print(f"  (lean D1 blob {len(blob)/1024:.1f}KB)")
        ts = int(time.time())
        tmp = WORKER / ".tmp"; tmp.mkdir(parents=True, exist_ok=True)
        sql_path = tmp / "fa_value_upsert.sql"
        sql_path.write_text(f"INSERT OR REPLACE INTO ups_auction_fa_value (id, payload, updated_at) VALUES (1, '{blob}', {ts});\n")
        print(f"\n  pushing fa_value blob to D1 ({len(blob)} bytes) …")
        subprocess.run(["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db", "--remote", "--file", str(sql_path)], cwd=str(WORKER), check=True)
        print("  pushed ups_auction_fa_value")


if __name__ == "__main__":
    main()
