"""PHASE 1 — selection on 2019–2024 ONLY. 2025 targets are built but never scored here.
Writes results_2019_2024.json and selection.json (frozen; sha256 printed)."""
import json, math, sys, pickle, hashlib, os, random
from collections import defaultdict
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from wf_core import *
from wf_metrics import *

HERE = os.path.dirname(os.path.abspath(__file__))

def _clean(o):
    """Valid JSON: an undefined metric (e.g. rank accuracy of a constant baseline) is null, not NaN."""
    if isinstance(o, float): return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict): return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list): return [_clean(v) for v in o]
    return o
TRAIN = [2019, 2020, 2021, 2022, 2023, 2024]
DISPLAY = ["Season to date"] + [f"Last {n}" for n in LAST_N] + ["Previous season"]
BINS = [(1, 2, "1–2"), (3, 4, "3–4"), (5, 7, "5–7"), (8, 11, "8–11"), (12, 99, "12+")]

def get_targets():
    pk = os.path.join(HERE, "targets.pkl")
    if os.path.exists(pk): return pickle.load(open(pk, "rb"))
    data = load(os.path.join(HERE, "dataset.json"))
    targets, S = build_targets(data, [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026])
    # league points per player-game of the group in weeks < T (for no-baseline players in the raw baseline)
    ppm = {}
    for y in range(2019, 2027):
        cur = S[y]; acc = defaultdict(lambda: [0.0, 0])
        for (wk, d, g), lst in cur.faced.items():
            a = acc[(wk, g)]; a[0] += sum(p for _, p in lst); a[1] += len(lst)
        for g in GROUPS:
            s = n = 0
            for T in range(1, 19):
                ppm[(y, g, T)] = (s / n) if n else None
                if (T, g) in acc: s += acc[(T, g)][0]; n += acc[(T, g)][1]
    lr = league_ratio(targets)
    for t in targets:
        t["ppm"] = ppm.get((t["y"], t["g"], t["T"])) or 0.0
        t["lr"] = lr.get((t["y"], t["g"], t["T"]), 1.0)
        t["base_raw"] = t["Efull"] + t["nmiss"] * t["ppm"]
        t["pred"] = predictors(t, lr)
    pickle.dump(targets, open(pk, "wb"))
    return targets

def methods_of(t):
    return list(t["pred"].keys())

def rows_for(ts, fam, name, k=None):
    """Predictions for targets ts. fam 'raw' predicts A; 'adj' predicts Ab via Eb*ratio."""
    out = []
    for t in ts:
        if name == "No defensive adjustment":
            praw, prat = t["base_raw"], 1.0
        elif name == "League average":
            praw, prat = t["lg"], t["lr"]
        else:
            x, r, n = t["pred"][name]
            if k is not None:
                x = shrink(x, n, t["lg"], k); r = shrink(r, n, t["lr"], k)
            praw, prat = (x if x is not None else t["lg"]), (r if r is not None else t["lr"])
        if fam == "raw":
            out.append((t, praw, t["A"]))
        else:
            out.append((t, prat, t["Ab"] / t["Eb"]))
    return out

def fast_mae(ts, fam, nm, k):
    tot = 0.0
    for t in ts:
        x, r, n = t["pred"][nm]
        if fam == "raw":
            tot += abs(t["A"] - shrink(x, n, t["lg"], k))
        else:
            rr = shrink(r, n, t["lr"], k)
            tot += abs(t["Ab"] - t["Eb"] * (rr if rr is not None else t["lr"]))
    return tot / len(ts)

def score(rows, fam):
    if fam == "raw":
        err = [a - p for t, p, a in rows]
        pe, se = corr([p for _, p, _ in rows], [a for _, _, a in rows])
        conc = concordance([((t["y"], t["T"], t["g"]), p, a) for t, p, a in rows])
        lift = quartile_lift([((t["y"], t["T"], t["g"]), p, a) for t, p, a in rows])
        dirn = direction([(p - t["base_raw"], a - t["base_raw"]) for t, p, a in rows])
    else:
        err = [t["Ab"] - t["Eb"] * p for t, p, a in rows]            # in points
        pe, se = corr([t["Eb"] * (p - 1) for t, p, _ in rows], [t["Ab"] - t["Eb"] for t, _, _ in rows])
        conc = concordance([((t["y"], t["T"], t["g"]), p, a) for t, p, a in rows])
        lift = quartile_lift([((t["y"], t["T"], t["g"]), p, a) for t, p, a in rows])
        dirn = direction([(p - 1, t["Ab"] - t["Eb"]) for t, p, a in rows])
    return {"n": len(rows), "MAE": mae(err), "RMSE": rmse(err), "pearson": pe, "spearman": se,
            "rank_acc": (conc[0] / conc[1]) if conc[1] else float("nan"), "pairs": conc[1],
            "q_lift": lift, "dir_acc": dirn[0], "dir_n": dirn[1]}

def slate_stats(rows, fam):
    """Per slate (y,T,g): [abs-error sum, n, concordant, pairs] for cluster bootstraps."""
    by = defaultdict(list)
    for t, p, a in rows: by[(t["y"], t["T"], t["g"])].append((t, p, a))
    out = {}
    for k, v in by.items():
        e = sum(abs((a - p) if fam == "raw" else (t["Ab"] - t["Eb"] * p)) for t, p, a in v)
        c, n = concordance([(k, p, a) for t, p, a in v])
        out[k] = (e, len(v), c, n)
    return out

def boot(sa, sb, keys, metric, B=600, seed=11):
    rnd = random.Random(seed)
    def val(ks, s):
        if metric == "MAE":
            e = sum(s[k][0] for k in ks); n = sum(s[k][1] for k in ks); return e / n
        c = sum(s[k][2] for k in ks); n = sum(s[k][3] for k in ks); return c / n if n else 0.5
    pt = val(keys, sa) - val(keys, sb); vals = []
    for _ in range(B):
        ks = [keys[rnd.randrange(len(keys))] for _ in range(len(keys))]
        vals.append(val(ks, sa) - val(ks, sb))
    vals.sort()
    return pt, vals[int(0.025 * B)], vals[int(0.975 * B) - 1]

def main():
    T_all = get_targets()
    train = [t for t in T_all if t["y"] in TRAIN]
    names = methods_of(train[0])
    res = {"sample": {}, "positions": {}, "combined": {}}
    sel = {"rule": None, "positions": {}, "frozen_from": "2019–2024 only", "train": TRAIN}
    for g in GROUPS + ["ALL"]:
        ts = [t for t in train if g == "ALL" or t["g"] == g]
        res["sample"][g] = {"targets": len(ts), "by_season": {y: sum(1 for t in ts if t["y"] == y) for y in TRAIN}}
        P = {}
        for fam in ("raw", "adj"):
            P[fam] = {}
            base_names = ["No defensive adjustment", "League average"] + names
            for nm in base_names:
                rows = rows_for(ts, fam, nm)
                m = score(rows, fam)
                m["by_season"] = {}
                for y in TRAIN:
                    ry = [r for r in rows if r[0]["y"] == y]
                    sy = score(ry, fam); m["by_season"][y] = {"MAE": sy["MAE"], "rank_acc": sy["rank_acc"]}
                # bins by completed games before the target
                m["by_bin"] = {}
                for lo, hi, lab in BINS:
                    rb = [r for r in rows if lo <= r[0]["k"] <= hi]
                    sb = score(rb, fam); m["by_bin"][lab] = {"n": sb["n"], "MAE": sb["MAE"], "rank_acc": sb["rank_acc"]}
                # shrunk version, k chosen leave-one-season-out (never on the season it is scored on)
                if nm in names:
                    loso_err = []; ks = {}
                    for hold in TRAIN:
                        fit = [t for t in ts if t["y"] != hold]
                        best = min(SHRINK_K, key=lambda kk: fast_mae(fit, fam, nm, kk))
                        ks[hold] = best
                        loso_err.append(rows_for([t for t in ts if t["y"] == hold], fam, nm, best))
                    flat = [r for part in loso_err for r in part]
                    sm = score(flat, fam)
                    m["shrunk_loso"] = {"MAE": sm["MAE"], "RMSE": sm["RMSE"], "rank_acc": sm["rank_acc"], "k_by_heldout": ks,
                                        "k_all_train": min(SHRINK_K, key=lambda kk: fast_mae(ts, fam, nm, kk))}
                P[fam][nm] = m
        res["positions"][g] = P
        # ---- selection (adjusted family = the board's ranking); display windows only ----
        A = P["adj"]
        disp = {w: A[w]["rank_acc"] for w in DISPLAY}
        winner = max(DISPLAY, key=lambda w: disp[w])
        # leave-one-season-out: choose on 5 seasons, score on the 6th
        loso = {}
        for hold in TRAIN:
            def pooled(w):
                c = n = 0
                for y in TRAIN:
                    if y == hold: continue
                    s = slate_cache(g, w, train, y)
                    c += sum(v[2] for v in s.values()); n += sum(v[3] for v in s.values())
                return c / n
            pick = max(DISPLAY, key=pooled)
            loso[hold] = {"picked": pick, "rank_acc_on_heldout": A[pick]["by_season"][hold]["rank_acc"],
                          "season_to_date_on_heldout": A["Season to date"]["by_season"][hold]["rank_acc"]}
        tsg = [t for t in train if g == "ALL" or t["g"] == g]
        s_w = slate_stats(rows_for(tsg, "adj", winner), "adj"); s_std = slate_stats(rows_for(tsg, "adj", "Season to date"), "adj")
        keys = sorted(s_w.keys())
        vs_std = boot(s_w, s_std, keys, "rank")
        s_half = {k: (0, 0, v[3] / 2.0, v[3]) for k, v in s_std.items()}     # a coin flip: 50% concordance
        std_vs_coin = boot(s_std, s_half, keys, "rank")
        win_vs_coin = boot(s_w, s_half, keys, "rank")
        seasons_beat_std = sum(1 for y in TRAIN if A[winner]["by_season"][y]["rank_acc"] > A["Season to date"]["by_season"][y]["rank_acc"])
        replaces_full = (winner != "Season to date" and vs_std[1] > 0 and seasons_beat_std >= 4)
        default = winner if replaces_full else "Season to date"
        sig = std_vs_coin if default == "Season to date" else win_vs_coin
        predictive = sig[1] > 0
        # best SHRUNK estimate vs no defensive adjustment (MAE, LOSO) — for a separate "Prediction" field
        best_shr = min(names, key=lambda w: A[w]["shrunk_loso"]["MAE"])
        noadj = A["No defensive adjustment"]["MAE"]
        sel["positions"][g] = {
            "winner_by_rank_acc": winner, "rank_acc": disp, "loso": loso,
            "winner_vs_full_season": {"diff": vs_std[0], "ci95": [vs_std[1], vs_std[2]], "seasons_better": seasons_beat_std},
            "full_season_vs_coinflip": {"diff": std_vs_coin[0], "ci95": [std_vs_coin[1], std_vs_coin[2]]},
            "winner_vs_coinflip": {"diff": win_vs_coin[0], "ci95": [win_vs_coin[1], win_vs_coin[2]]},
            "default": default, "ordering_predictive_2019_2024": predictive,
            "best_shrunk": {"method": best_shr, "k": A[best_shr]["shrunk_loso"]["k_all_train"],
                            "MAE": A[best_shr]["shrunk_loso"]["MAE"], "no_adjustment_MAE": noadj,
                            "improvement_pct": 100 * (noadj - A[best_shr]["shrunk_loso"]["MAE"]) / noadj},
        }
        print(g, "winner", winner, f"{disp[winner]:.3f}", "| STD", f"{disp['Season to date']:.3f}",
              "| vs STD", [round(x, 4) for x in vs_std], "beat STD in", seasons_beat_std, "| default", default,
              "| predictive", predictive, "| best shrunk", best_shr, f"{sel['positions'][g]['best_shrunk']['improvement_pct']:.2f}%", flush=True)
    sel["rule"] = RULE
    json.dump(_clean(res), open(os.path.join(HERE, "results_2019_2024.json"), "w"), indent=1, default=float, allow_nan=False)
    blob = json.dumps(sel, indent=1, sort_keys=True, default=float)
    open(os.path.join(HERE, "selection.json"), "w").write(blob)
    print("selection.json sha256", hashlib.sha256(blob.encode()).hexdigest())

_SL = {}
def slate_cache(g, w, train, y):
    key = (g, w, y)
    if key not in _SL:
        ts = [t for t in train if t["y"] == y and (g == "ALL" or t["g"] == g)]
        _SL[key] = slate_stats(rows_for(ts, "adj", w), "adj")
    return _SL[key]

RULE = ("Per position, on 2019–2024 only: among the displayable windows (Full season = season to date, "
        "Last 1/2/3/4/5/6/8 completed games, Previous season), pick the one whose Allowed÷Usual ORDER best "
        "matches the next game's actual Allowed÷Usual (pairwise rank accuracy within each week's slate). "
        "It replaces Full season only if it beats Full season with a 95% cluster-bootstrap interval above 0 "
        "AND in at least 4 of the 6 seasons. The default is then confirmed on the locked 2025 holdout: a "
        "replacement must still beat Full season there, otherwise Full season stays. The board is called "
        "predictive for a position only if its default window's rank accuracy is above a coin flip (50%) "
        "with a 95% interval above 0 on 2019–2024 AND above 50% on 2025.")

if __name__ == "__main__":
    main()
