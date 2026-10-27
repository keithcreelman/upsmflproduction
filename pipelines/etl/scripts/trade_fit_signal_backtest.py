#!/usr/bin/env python3
"""Front Office Trade Finder (#1338): which signal best identifies a player's / a roster's CURRENT strength for the rest of the season?

Offline backtest for the Front Office Trade Finder (no D1, no writes). Inputs are public reads, cached:
  MFL export playerScores W=1..17 (this league's own scores), players (positions), rosters W=t (point-in-time);
  Sleeper weekly projections (RotoWire numbers) for offense, scored with UPS rules by pipelines/etl/wire/ev_projections.py.

Question (Keith's brief): "Test whether recent production, season production or projections best identify current
roster strength. Do not casually invent weights."

For each season 2022-2025 and cutoff week t in {4,6,8,10}:
  * player level: predictors known at t vs target = rest-of-season PPG (weeks t+1..17, MFL-scored weeks only);
    metric = within-position-group Spearman rank correlation and MAE, on players with >= ceil(t/2) MFL weeks by t
    and >= 3 MFL weeks after t.
  * roster level: each franchise's best legal 18-slot lineup at t (lineup_engine, the released slot model) built by
    each predictor; per position group, the sum of the starters' predictor values vs the same starters' realized
    ROS PPG. Metric = Spearman across the 12 teams of (predicted group strength) vs (realized group strength), and
    the same for the whole lineup.
Run:  python3 pipelines/etl/scripts/trade_fit_signal_backtest.py   (about 175 public reads the first time; MFL 429s
are waited out). Results and reading: docs/FRONT_OFFICE_TRADE_FIT.md. No D1, no writes.
Predictors: STD = season-to-date PPG; L3 / L4 = last 3 / 4 MFL weeks; PRIOR = prior-season PPG; PROJ = mean UPS-scored
RotoWire weekly projection for weeks t+1..t+4 (offense only); blends are reported, not tuned per position.
"""
import json, math, os, sys, statistics, collections, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "pipelines/etl/wire"))
import season_sim as S  # fetch() with cache + 429 pacing
import ev_projections as EV
import lineup_engine as LE

# Public reads only (MFL exports + Sleeper's public projections); cached so a rerun is offline.
CACHE = os.environ.get("TRADE_FIT_CACHE", os.path.join(os.environ.get("TMPDIR", "/tmp"), "trade_fit_signal_cache"))
OUT = os.environ.get("TRADE_FIT_OUT", os.path.join(os.environ.get("TMPDIR", "/tmp"), "trade_fit_signal_result.json"))
SEASONS = [int(s) for s in os.environ.get("TF_SEASONS", "2022,2023,2024,2025").split(",")]
CUTS = [4, 6, 8, 10]
END = 17
MFL = "https://www48.myfantasyleague.com/%d/export?TYPE=%s&L=74598&JSON=1%s"


def as_list(v):
    return [] if v is None else (v if isinstance(v, list) else [v])


def load_season(season):
    pos = {p["id"]: p.get("position") for p in S.fetch(S.MFL_PLAYERS % season, CACHE)["players"]["player"]}
    scores = {}
    for w in range(1, END + 1):
        blk = S.fetch(MFL % (season, "playerScores", "&W=%d" % w), CACHE).get("playerScores", {})
        for r in as_list(blk.get("playerScore")):
            s = r.get("score")
            if s in (None, ""):
                continue
            scores.setdefault(r["id"], {})[w] = float(s)
    proj = {}
    for w in range(1, END + 1):
        try:
            rows = EV.fetch_week(season, w, lambda u: S.fetch(u, CACHE))
        except Exception as e:  # offense projections missing → PROJ unavailable that week
            print("sleeper", season, w, "unavailable:", e, file=sys.stderr)
            rows = {}
        proj[w] = rows
    return pos, scores, proj


def sleeper_to_mfl(season, proj_rows):
    """Map Sleeper ids → MFL ids through the players export's sleeper_id-free fields is not possible; ev_projections
    keys by normalized name + position + team. Build a name/pos/team → mfl id index from MFL players (DETAILS)."""
    return proj_rows


def ppg(d, weeks):
    v = [d[w] for w in weeks if w in d]
    return (sum(v) / len(v), len(v)) if v else (None, 0)


def last_n(d, t, n):
    ws = sorted(w for w in d if w <= t)[-n:]
    return ppg(d, ws)


def spearman(xs, ys):
    n = len(xs)
    if n < 5:
        return None
    def ranks(a):
        o = sorted(range(n), key=lambda i: a[i]); r = [0.0] * n; i = 0
        while i < n:
            j = i
            while j + 1 < n and a[o[j + 1]] == a[o[i]]:
                j += 1
            for k in range(i, j + 1):
                r[o[k]] = (i + j) / 2.0
            i = j + 1
        return r
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else None


def main():
    os.makedirs(CACHE, exist_ok=True)
    data = {s: load_season(s) for s in SEASONS + [min(SEASONS) - 1]}
    out = {"player": collections.defaultdict(list), "team": collections.defaultdict(list)}
    for season in SEASONS:
        pos, scores, proj = data[season]
        _, prior_scores, _ = data[season - 1]
        # Sleeper rows → mfl ids via ev_projections' own matcher when available.
        # Sleeper → MFL ids by UNIQUE normalized name + position (no D1 crosswalk; ambiguous names stay unmatched).
        idx = collections.defaultdict(list)
        for p in S.fetch(S.MFL_PLAYERS % season, CACHE)["players"]["player"]:
            idx[(EV.norm_name(p.get("name")), (p.get("position") or "").upper())].append(p["id"])
        pmap, matched, total = {}, set(), set()
        for w, rowsw in proj.items():
            pmap[w] = {}
            for sid, v in rowsw.items():
                total.add(sid)
                hits = idx.get((EV.norm_name(v["name"]), v["pos"]), [])
                if len(hits) == 1:
                    pmap[w][hits[0]] = v["points"]; matched.add(sid)
        print("season", season, "sleeper ids matched", len(matched), "of", len(total), file=sys.stderr)
        for t in CUTS:
            ros_weeks = list(range(t + 1, END + 1))
            rows = []
            for pid, d in scores.items():
                g = LE.pos_group(pos.get(pid, ""))
                if g == LE.OTH:
                    continue
                std, n_std = ppg(d, [w for w in d if w <= t])
                ros, n_ros = ppg(d, ros_weeks)
                if n_std < math.ceil(t / 2) or n_ros < 3:
                    continue
                l3, _ = last_n(d, t, 3)
                l4, _ = last_n(d, t, 4)
                pr, n_pr = ppg(prior_scores.get(pid, {}), list(range(1, END + 1)))
                pj = None
                if pmap:
                    vals = [pmap.get(w, {}).get(pid) for w in range(t + 1, min(END, t + 4) + 1)]
                    vals = [v for v in vals if v is not None]
                    pj = sum(vals) / len(vals) if vals else None
                rows.append({"pid": pid, "g": g, "std": std, "l3": l3, "l4": l4, "prior": pr if n_pr >= 4 else None,
                             "proj": pj, "ros": ros})
            for g in sorted(set(r["g"] for r in rows)):
                grp = [r for r in rows if r["g"] == g]
                # Relevance filter: the top 3x starter demand by STD (the players a trade conversation is about).
                demand = {"QB": 24, "RB": 30, "WR": 40, "TE": 13, "DL": 26, "LB": 27, "DB": 30, "PK": 12, "PN": 12}[g]
                grp = sorted(grp, key=lambda r: -r["std"])[: demand * 2]
                for key in ("std", "l3", "l4", "prior", "proj", "blend_std_l4", "blend_std_proj", "blend_std_prior"):
                    xs, ys = [], []
                    for r in grp:
                        if key == "blend_std_l4":
                            x = 0.5 * r["std"] + 0.5 * r["l4"]
                        elif key == "blend_std_prior":
                            x = r["std"] if r["prior"] is None else 0.5 * r["std"] + 0.5 * r["prior"]
                        elif key == "blend_std_proj":
                            x = None if r["proj"] is None else 0.5 * r["std"] + 0.5 * r["proj"]
                        else:
                            x = r[key]
                        if x is None:
                            continue
                        xs.append(x); ys.append(r["ros"])
                    if len(xs) < 10:
                        continue
                    rho = spearman(xs, ys)
                    mae = sum(abs(a - b) for a, b in zip(xs, ys)) / len(xs)
                    out["player"][(g, key)].append({"season": season, "t": t, "n": len(xs), "rho": rho, "mae": mae})
            # Roster level: point-in-time rosters at week t.
            rost = S.fetch(MFL % (season, "rosters", "&W=%d" % t), CACHE)
            byp = {r["pid"]: r for r in rows}
            for key in ("std", "l4", "proj", "blend_std_l4", "blend_std_prior"):
                team_pred, team_real = collections.defaultdict(dict), collections.defaultdict(dict)
                for f in as_list(rost["rosters"]["franchise"]):
                    pool = []
                    for p in as_list(f.get("player")):
                        if p.get("status") != "ROSTER":
                            continue
                        r = byp.get(p["id"])
                        val = None
                        if r:
                            if key == "blend_std_l4":
                                val = 0.5 * r["std"] + 0.5 * r["l4"]
                            elif key == "blend_std_prior":
                                val = r["std"] if r["prior"] is None else 0.5 * r["std"] + 0.5 * r["prior"]
                            else:
                                val = r.get(key)
                        pool.append({"pid": p["id"], "pos": pos.get(p["id"], ""), "is_taxi": False, "is_ir": False, "v": val or 0.0,
                                     "ros": r["ros"] if r else 0.0})
                    slots = LE.fill_slots(pool, lambda x: x["v"])
                    byid = {x["pid"]: x for x in pool}
                    for sid, pid in slots.items():
                        if not pid:
                            continue
                        x = byid[pid]; grp = LE.pos_group(x["pos"])
                        team_pred[grp][f["id"]] = team_pred[grp].get(f["id"], 0.0) + x["v"]
                        team_real[grp][f["id"]] = team_real[grp].get(f["id"], 0.0) + x["ros"]
                        team_pred["ALL"][f["id"]] = team_pred["ALL"].get(f["id"], 0.0) + x["v"]
                        team_real["ALL"][f["id"]] = team_real["ALL"].get(f["id"], 0.0) + x["ros"]
                for grp in team_pred:
                    fids = sorted(team_pred[grp])
                    rho = spearman([team_pred[grp][f] for f in fids], [team_real[grp].get(f, 0.0) for f in fids])
                    out["team"][(grp, key)].append({"season": season, "t": t, "rho": rho})
    summ = {"player": {}, "team": {}}
    for lvl in ("player", "team"):
        for (g, key), lst in sorted(out[lvl].items()):
            rh = [x["rho"] for x in lst if x["rho"] is not None]
            entry = {"mean_rho": round(statistics.mean(rh), 3) if rh else None, "cells": len(rh)}
            if lvl == "player":
                entry["mean_mae"] = round(statistics.mean(x["mae"] for x in lst), 2)
                entry["n_avg"] = round(statistics.mean(x["n"] for x in lst))
                entry["by_t"] = {t: round(statistics.mean([x["rho"] for x in lst if x["t"] == t and x["rho"] is not None] or [float("nan")]), 3) for t in CUTS}
            summ[lvl]["%s|%s" % (g, key)] = entry
    json.dump(summ, open(OUT, "w"), indent=1)
    print("wrote", OUT)
    for lvl in ("player", "team"):
        print("==", lvl)
        for k, v in summ[lvl].items():
            print(k, v)


if __name__ == "__main__":
    main()
