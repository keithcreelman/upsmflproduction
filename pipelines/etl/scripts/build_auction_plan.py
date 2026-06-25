#!/usr/bin/env python3
"""Optimal FA-auction roster fill for 0008 + a league competitiveness benchmark + scenario runner.

Lineup strength = Σ E[APWE] of the best 9 OFFENSIVE skill starters (1QB + 2RB + 2WR + 1TE +
2 flex[RB/WR/TE] + 1 superflex[QB/RB/WR/TE]) — the all-play wins your starting offense earns.
(K/P/IDP are streamed at ~$1K and don't move APWE, so the value fight is the 9 skill slots.)

For 0008: take the current roster, then GREEDILY buy the available FA that adds the most lineup
APWE per dollar until the cap room is spent — the optimal "everything goes to plan" build. Then
rank the resulting lineup APWE against all 12 teams' current lineups = "good enough to compete?".

CLI scenario knobs (for the volatility playbook):
  --budget N        cap room to deploy ($K; default = 0008's room to the $300K ceiling)
  --price-mult X    multiply every FA's expected price (inflation/bidding-war stress)
  --exclude "a;b"   players 0008 CANNOT get (sniped) — nkey-matched, removed from the pool
  --reserve N       $K held back for K/P/IDP/depth (default 12)
"""
from __future__ import annotations
import argparse, json, re, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
LEAGUE = "74598"; YEAR = 2026; CAP = 300
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")
SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "SF"]   # 9 skill starters
FLEX_OK = {"RB", "WR", "TE"}; SF_OK = {"QB", "RB", "WR", "TE"}


def jget(u):
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "ups", "Accept": "*/*"}), timeout=30).read())


def nkey(s):
    s = (s or "").strip().lower()
    if "," in s: a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def best9_apwe(players):
    """players: list of {pos, score}. Fill the 9 skill slots greedily by STRENGTH → total + the lineup.
    `score` = the strength metric (redraft APWE, or a blend with dynasty/KTC value — see --strength-blend)."""
    pool = sorted([p for p in players if p["pos"] in SF_OK and (p.get("score") or 0) > 0], key=lambda x: -x["score"])
    used = set(); line = []
    def take(ok):
        for i, p in enumerate(pool):
            if i not in used and p["pos"] in ok:
                used.add(i); return p
        return None
    for slot in ["QB", "RB", "RB", "WR", "WR", "TE"]:
        p = take({slot})
        if p: line.append((slot, p))
    for slot in ["FLEX", "FLEX"]:
        p = take(FLEX_OK)
        if p: line.append((slot, p))
    p = take(SF_OK)
    if p: line.append(("SF", p))
    return round(sum(x[1]["score"] for x in line), 1), line


def marginal(roster_players, fa):
    """APWE gain to the best-9 lineup if `fa` is added to roster_players."""
    base, _ = best9_apwe(roster_players)
    new, _ = best9_apwe(roster_players + [fa])
    return round(new - base, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=None)
    ap.add_argument("--price-mult", type=float, default=1.0)
    ap.add_argument("--exclude", default="")
    ap.add_argument("--force", default="", help="players 0008 MUST buy (name[@priceK];…) — pre-purchased before the greedy fill")
    ap.add_argument("--strength-blend", type=float, default=0.0, help="0=redraft APWE only, 1=dynasty/KTC only; blends the lineup-strength metric")
    ap.add_argument("--reserve", type=float, default=12)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    excl = {nkey(x) for x in args.exclude.split(";") if x.strip()}
    force = {}
    for tok in args.force.split(";"):
        tok = tok.strip()
        if not tok:
            continue
        nm, _, pr = tok.partition("@")
        force[nkey(nm)] = float(pr) if pr else None     # optional @priceK override (a war price)

    core = json.loads((DATA / "fa_value_core.json").read_text())["players"]
    B = max(0.0, min(1.0, args.strength_blend))
    worth = {nkey(p["player"]): {"pos": p["pos"], "apwe": p.get("e_apwe_p50") or 0,
                                 "dyn_apwe": (p.get("dynasty_worth_k") or 0) / 6.5,
                                 "worth": p.get("worth_k") or 0} for p in core}
    board = json.loads((DATA / "fa_value.json").read_text())
    teams_meta = board.get("teams", {})

    # live rosters → team → players (with model apwe/worth)
    rosters = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]
    players_db = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=players&L={LEAGUE}&JSON=1")["players"]["player"]
    id2name = {str(p["id"]): p.get("name") for p in players_db}
    team_players = {}
    for fr in rosters:
        pls = fr.get("player", []); pls = [pls] if isinstance(pls, dict) else pls
        lst = []
        for p in pls:
            nm = id2name.get(str(p.get("id")))
            w = worth.get(nkey(nm or ""))
            if w and w["pos"] in SF_OK:
                sc = round((1 - B) * w["apwe"] + B * w["dyn_apwe"], 2)
                lst.append({"name": nm, "pos": w["pos"], "apwe": w["apwe"], "dyn_apwe": round(w["dyn_apwe"],1), "score": sc, "worth": w["worth"]})
        team_players[fr["id"]] = lst

    # league benchmark: every team's CURRENT best-9 lineup APWE
    bench = []
    for fid, pls in team_players.items():
        ap9, _ = best9_apwe(pls)
        bench.append((fid, teams_meta.get(fid, {}).get("team", fid), ap9))
    bench.sort(key=lambda x: -x[2])
    median = sorted([b[2] for b in bench])[len(bench) // 2]
    top3 = sum(b[2] for b in bench[:3]) / 3

    # 0008 fill
    me = team_players.get("0008", [])
    cur_ap, cur_line = best9_apwe(me)
    room = args.budget if args.budget is not None else round((CAP - teams_meta.get("0008", {}).get("active_salary", 105000) / 1000.0))
    if "0008" in teams_meta and teams_meta["0008"].get("capspace") is not None and args.budget is None:
        room = round(teams_meta["0008"]["capspace"] / 1000.0)
    budget = room - args.reserve

    # available FA pool with (apwe, scenario-adjusted price)
    pool = []
    for f in board["fas"]:
        if f.get("own"):
            continue
        nk = nkey(f["player"])
        if nk in excl or f["pos"] not in SF_OK:
            continue
        price = max(1, round((f.get("ep_k") or 1) * args.price_mult))
        da = (worth.get(nk, {}).get("dyn_apwe") or 0)
        apwe = f.get("e_apwe_p50") or 0
        pool.append({"name": f["player"], "pos": f["pos"], "apwe": apwe, "dyn_apwe": round(da,1),
                     "score": round((1 - B) * apwe + B * da, 2), "worth": f.get("worth_k") or 0, "price": price})

    # greedy: repeatedly buy the FA with the best marginal lineup-APWE per $ that fits the budget
    have = list(me); buys = []; spent = 0
    # forced buys first (a "I want this guy" override) — at model price or a @priceK war price
    for fa in list(pool):
        nk = nkey(fa["name"])
        if nk in force:
            if force[nk]:
                fa = {**fa, "price": round(force[nk])}
            mg = marginal(have, fa)
            have.append(fa); buys.append({**fa, "marg": mg, "forced": True}); spent += fa["price"]
            pool = [x for x in pool if x["name"] != fa["name"]]
    while budget - spent >= 1:
        best = None
        for fa in pool:
            if fa["price"] > (budget - spent):
                continue
            mg = marginal(have, fa)
            if mg <= 0:
                continue
            eff = mg / max(1, fa["price"])
            if best is None or eff > best[0] or (abs(eff - best[0]) < 1e-9 and mg > best[1]):
                best = (eff, mg, fa)
        if not best:
            break
        _, mg, fa = best
        have.append(fa); buys.append({**fa, "marg": mg}); spent += fa["price"]
        pool = [x for x in pool if x["name"] != fa["name"]]

    final_ap, final_line = best9_apwe(have)
    final_rank = 1 + sum(1 for _, _, a in bench if a > final_ap)

    out = {
        "scenario": {"budget_k": budget, "reserve_k": args.reserve, "price_mult": args.price_mult,
                     "excluded": sorted(excl)},
        "current": {"lineup_apwe": cur_ap, "rank": 1 + sum(1 for _, _, a in bench if a > cur_ap)},
        "plan": {"buys": [{"player": b["name"], "pos": b["pos"], "price_k": b["price"],
                           "apwe": round(b["apwe"], 1), "marg": b["marg"]} for b in buys],
                 "spent_k": spent, "n_buys": len(buys),
                 "final_lineup_apwe": final_ap, "final_rank": final_rank,
                 "starters": [{"slot": s, "player": p["name"], "pos": p["pos"], "apwe": round(p["apwe"], 1)} for s, p in final_line]},
        "league": {"benchmark": [{"team": t, "apwe": a} for _, t, a in bench],
                   "median_apwe": median, "top3_avg_apwe": round(top3, 1),
                   "contender_bar": round(top3, 1)},
    }
    if args.json:
        print(json.dumps(out)); return out

    print(f"=== 0008 current lineup: {cur_ap} APWE (rank {out['current']['rank']}/12) ===")
    print(f"=== budget ${budget}K (room ${room}K − ${args.reserve}K reserve) · price_mult {args.price_mult} · excl {sorted(excl) or '—'} ===\n")
    print(f"PLAN — {len(buys)} buys, ${spent}K spent:")
    for b in buys:
        print(f"  ${b['price']:>3}K  {b['name'][:22]:<23} {b['pos']:<3} APWE {b['apwe']:>4.1f}  (+{b['marg']} lineup)")
    print(f"\nOPTIMAL LINEUP — {final_ap} APWE (rank {final_rank}/12):")
    for s, p in final_line:
        print(f"  {s:<5}{p['name'][:22]:<23}{p['pos']:<3}{p['apwe']:>5.1f}")
    print(f"\n=== LEAGUE BENCHMARK (current best-9 APWE) ===")
    for i, (_, t, a) in enumerate(bench, 1):
        star = " ←0008 optimal lands here" if a <= final_ap and (i == 1 or bench[i - 2][2] > final_ap) else ""
        print(f"  {i:>2}. {t[:24]:<25}{a:>6.1f}{star}")
    print(f"\n  contender bar (top-3 avg): {round(top3,1)} · median: {median} · 0008 optimal: {final_ap} → " +
          ("COMPETES (≥ top-3)" if final_ap >= top3 else "above median" if final_ap >= median else "below median"))
    return out


if __name__ == "__main__":
    main()
