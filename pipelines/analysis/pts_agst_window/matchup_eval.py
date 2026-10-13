"""Evaluates the matchup decomposition (see matchup.py). Writes matchup_results.json."""
import json, math, os, sys, pickle, random
from collections import defaultdict
import numpy as np
from scipy import stats
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wf_core import load, GROUPS
import matchup as MU

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN = MU.TRAIN

def _clean(o):
    """Valid JSON: an undefined metric is null, not NaN."""
    if isinstance(o, float): return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict): return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list): return [_clean(v) for v in o]
    return o

def get():
    pk = os.path.join(HERE, "matchup_targets.pkl")
    if os.path.exists(pk): return pickle.load(open(pk, "rb"))
    data = load(os.path.join(HERE, "dataset.json"))
    ts = MU.targets(data, [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026])
    refs = MU.league_refs(ts)
    for t in ts:
        t["lr"], t["ld"], t["lrp"] = refs.get((t["y"], t["g"], t["T"]), (1.0, 0.0, 1.0))
        t["W"] = MU.windows(t)
    pickle.dump(ts, open(pk, "wb"))
    return ts

def off_base(t, ko):
    n = t["n_o"] if t["n_o"] > 0 else 2          # a previous-season mean counts as 2 games
    return MU.shr(t["O"], n, t["lg"], ko)

def predict(t, name, ko, kd, W="Full season"):
    ob = off_base(t, ko)
    w = t["W"][W]
    if name == "League average": return t["lg"]
    if name == "Offense baseline": return ob
    if name == "Player baseline (knows lineup)": return t["offp"]
    if name == "Raw Allowed": return w["raw"] if w else t["lg"]
    if name == "Offense x raw Allowed ratio": return ob * ((w["raw"] / t["lg"]) if (w and t["lg"] > 0) else 1.0)
    if name == "Combined ratio": return ob * MU.shr(w["eff"] if w else None, w["n"] if w else 0, t["lr"], kd)
    if name == "Combined difference": return ob + MU.shr(w["diff"] if w else None, w["n"] if w else 0, t["ld"], kd)
    if name == "Combined player-level": return t["offp"] * MU.shr(w["effp"] if w else None, w["n"] if w else 0, t["lrp"], kd)
    raise KeyError(name)

TUNED_D = ["Combined ratio", "Combined difference", "Combined player-level"]

def mae(ts, name, ko, kd, W):
    return sum(abs(t["A"] - predict(t, name, ko, kd, W)) for t in ts) / len(ts)

def concord(rows):
    by = defaultdict(list)
    for key, p, a in rows: by[key].append((p, a))
    c = n = 0
    for v in by.values():
        for i in range(len(v)):
            for j in range(i + 1, len(v)):
                dp, da = v[i][0] - v[j][0], v[i][1] - v[j][1]
                if dp == 0 or da == 0: continue
                n += 1; c += (dp * da > 0)
    return c, n

def metrics(ts, preds, base):
    A = np.array([t["A"] for t in ts]); P = np.array(preds); B = np.array(base)
    err = A - P
    c, n = concord([((t["y"], t["T"], t["g"]), p, t["A"]) for t, p in zip(ts, preds)])
    d = [(np.sign(p - b), np.sign(a - b)) for p, b, a in zip(P, B, A) if p != b and a != b]
    return {"n": len(ts), "MAE": float(np.mean(np.abs(err))), "RMSE": float(np.sqrt(np.mean(err ** 2))),
            "rank_acc": c / n if n else None, "dir_acc": (sum(1 for x, y in d if x == y) / len(d)) if d else None,
            "pearson": float(stats.pearsonr(P, A)[0]) if np.std(P) > 0 else None}

def slates(ts, preds):
    by = defaultdict(list)
    for t, p in zip(ts, preds): by[(t["y"], t["T"])].append((t, p))
    return by

def boot(ts, pa, pb, B=1000, seed=5):
    """Paired cluster bootstrap over season-week clusters of MAE(a)-MAE(b) and rank_acc(a)-rank_acc(b).
    Per-cluster sums are computed once, then clusters are resampled."""
    by = defaultdict(list)
    for i, t in enumerate(ts): by[(t["y"], t["T"])].append(i)
    keys = list(by); cs = []
    for k in keys:
        idx = by[k]
        ea = sum(abs(ts[i]["A"] - pa[i]) for i in idx); eb = sum(abs(ts[i]["A"] - pb[i]) for i in idx)
        ca = concord([((ts[i]["y"], ts[i]["T"], ts[i]["g"]), pa[i], ts[i]["A"]) for i in idx])
        cb = concord([((ts[i]["y"], ts[i]["T"], ts[i]["g"]), pb[i], ts[i]["A"]) for i in idx])
        cs.append((ea, eb, len(idx), ca[0], ca[1], cb[0], cb[1]))
    def stat(sel):
        ea = sum(cs[j][0] for j in sel); eb = sum(cs[j][1] for j in sel); n = sum(cs[j][2] for j in sel)
        ra = sum(cs[j][3] for j in sel) / max(1, sum(cs[j][4] for j in sel)); rb = sum(cs[j][5] for j in sel) / max(1, sum(cs[j][6] for j in sel))
        return ea / n - eb / n, ra - rb
    pt = stat(range(len(cs)))
    rnd = random.Random(seed); m, r = [], []
    for _ in range(B):
        sel = [rnd.randrange(len(cs)) for _ in range(len(cs))]
        a, b2 = stat(sel); m.append(a); r.append(b2)
    m.sort(); r.sort()
    return {"dMAE": pt[0], "dMAE_ci": [m[int(.025 * B)], m[int(.975 * B) - 1]], "dRank": pt[1], "dRank_ci": [r[int(.025 * B)], r[int(.975 * B) - 1]]}

def effect_only(ts, W="Full season"):
    """Item 3: does the defense's adjusted effect predict ABOVE/BELOW the offense's own pregame normal?"""
    rows, d, below = [], [], 0
    for t in ts:
        w = t["W"][W]; e = w["eff"] if w else None
        if e is None or not t["O"] or t["O"] <= 0: continue
        act = t["A"] / t["O"]
        rows.append(((t["y"], t["T"], t["g"]), e, act))
        if e != t["lr"] and t["A"] != t["O"]: d.append((e > t["lr"], t["A"] > t["O"]))
        below += t["A"] < t["O"]
    c, n = concord(rows)
    return {"n": len(rows), "rank_acc": c / n if n else None, "dir_acc": sum(1 for x, y in d if x == y) / len(d) if d else None,
            "share_below_normal": below / len(rows) if rows else None,
            "pearson": float(stats.pearsonr([r[1] for r in rows], [r[2] for r in rows])[0]) if rows else None}

def split_half(ts_all):
    """Stability of the defense effect within a season: odd vs even games, ratio vs difference.
    Uses each season's full set of D's games (descriptive), offense usual = its season mean excluding that game."""
    res = {}
    for g in GROUPS:
        rr, rd = [], []
        for y in range(2019, 2026):
            last = {}
            for t in ts_all:
                if t["y"] == y and t["g"] == g and (t["D"] not in last or t["k"] > last[t["D"]]["k"]): last[t["D"]] = t
            xs_r, ys_r, xs_d, ys_d = [], [], [], []
            for D, t in last.items():
                games = t["cur"]
                odd, even = games[0::2], games[1::2]
                if len(odd) < 3 or len(even) < 3: continue
                def r(gs): sA = sum(x[0] for x in gs); sO = sum((x[1] or 0) for x in gs); return sA / sO if sO > 0 else None
                def dd(gs): return sum(x[0] - (x[1] or 0) for x in gs) / len(gs)
                if r(odd) is None or r(even) is None: continue
                xs_r.append(r(odd)); ys_r.append(r(even)); xs_d.append(dd(odd)); ys_d.append(dd(even))
            if len(xs_r) > 5:
                rr.append(stats.spearmanr(xs_r, ys_r)[0]); rd.append(stats.spearmanr(xs_d, ys_d)[0])
        res[g] = {"ratio_split_half_spearman": float(np.mean(rr)), "difference_split_half_spearman": float(np.mean(rd))}
    return res

def main():
    T_all = get()
    out = {"positions": {}, "stability": split_half([t for t in T_all if t["y"] <= 2025])}
    names = ["League average", "Offense baseline", "Player baseline (knows lineup)", "Raw Allowed", "Offense x raw Allowed ratio"] + TUNED_D
    for g in GROUPS + ["ALL"]:
        tr = [t for t in T_all if t["y"] in TRAIN and (g == "ALL" or t["g"] == g)]
        ho = [t for t in T_all if t["y"] == 2025 and (g == "ALL" or t["g"] == g)]
        # tune k_o (offense baseline) and, given it, k_d for each combined variant x window — LOSO on 2019–2024
        def tune(fit):
            ko = min(MU.K, key=lambda k: mae(fit, "Offense baseline", k, 0, "Full season"))
            kd = {(nm, W): min(MU.K, key=lambda k: mae(fit, nm, ko, k, W)) for nm in TUNED_D for W in MU.WIN}
            return ko, kd
        loso = {}
        for hold in TRAIN:
            loso[hold] = tune([t for t in tr if t["y"] != hold])
        ko_all, kd_all = tune(tr)
        P = {}
        def preds_for(ts, nm, W, unshrunk, use_loso):
            out_ = []
            for t in ts:
                ko, kd = (loso[t["y"]] if use_loso else (ko_all, kd_all))
                k = 0 if unshrunk else kd.get((nm, W), 0)
                out_.append(predict(t, nm, ko, k, W))
            return out_
        res = {"k_offense_all_train": ko_all, "k_defense_all_train": {f"{a}|{b}": v for (a, b), v in kd_all.items()}}
        for period, ts, use in (("2019-2024 (LOSO)", tr, True), ("2025 holdout", ho, False)):
            base = preds_for(ts, "Offense baseline", "Full season", False, use)
            R = {}
            for nm in names:
                for W in (MU.WIN if nm in TUNED_D + ["Raw Allowed", "Offense x raw Allowed ratio"] else ["Full season"]):
                    for unshr in ((False, True) if nm in TUNED_D else (False,)):
                        p = preds_for(ts, nm, W, unshr, use)
                        key = nm + ("" if W == "Full season" and nm not in TUNED_D + ["Raw Allowed", "Offense x raw Allowed ratio"] else f" [{W}]") + (" unshrunk" if unshr else (" shrunk" if nm in TUNED_D else ""))
                        R[key] = metrics(ts, p, base)
                        if nm in TUNED_D and W == "Full season": P[(period, key)] = p
            # incremental value over the offense baseline (Full season effect, shrunk and unshrunk)
            inc = {}
            for key in [k for (pp, k) in P if pp == period]:
                inc[key] = boot(ts, P[(period, key)], base)
            R["_incremental_vs_offense_baseline"] = inc
            R["_effect_only"] = {W: effect_only(ts, W) for W in MU.WIN}
            res[period] = R
        out["positions"][g] = res
        R1, R2 = res["2019-2024 (LOSO)"], res["2025 holdout"]
        print(g, "| offense-only MAE", round(R1["Offense baseline"]["MAE"], 3), "| comb ratio shrunk", round(R1["Combined ratio [Full season] shrunk"]["MAE"], 3),
              "unshrunk", round(R1["Combined ratio [Full season] unshrunk"]["MAE"], 3), "| inc", {k.split(" [")[0][:14] + k[-9:]: (round(v["dMAE"], 3), [round(x, 3) for x in v["dMAE_ci"]]) for k, v in R1["_incremental_vs_offense_baseline"].items()},
              "| 2025 inc", {k.split(" [")[0][:14] + k[-9:]: round(v["dMAE"], 3) for k, v in R2["_incremental_vs_offense_baseline"].items()}, flush=True)
    json.dump(_clean(out), open(os.path.join(HERE, "matchup_results.json"), "w"), indent=1, default=float, allow_nan=False)
    print("stability", json.dumps(out["stability"]))

if __name__ == "__main__":
    main()
