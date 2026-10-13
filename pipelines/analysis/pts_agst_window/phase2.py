"""PHASE 2 — the locked 2025 holdout. Reads the FROZEN selection.json (sha256 checked), scores 2025,
applies the confirmation step of the pre-registered rule, and writes final_defaults.json.
2026 is scored as an illustration only (never used for any decision)."""
import json, math, os, sys, hashlib, pickle
sys.path.insert(0, os.path.dirname(__file__))
from wf_core import *
from wf_metrics import *
import phase1 as P1

HERE = os.path.dirname(os.path.abspath(__file__))

def _clean(o):
    """Valid JSON: an undefined metric (e.g. rank accuracy of a constant baseline) is null, not NaN."""
    if isinstance(o, float): return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict): return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list): return [_clean(v) for v in o]
    return o
FROZEN_SHA = sys.argv[1]

def main():
    blob = open(os.path.join(HERE, "selection.json")).read()
    sha = hashlib.sha256(blob.encode()).hexdigest()
    assert sha == FROZEN_SHA, f"selection.json changed: {sha} != {FROZEN_SHA}"
    sel = json.loads(blob)
    T_all = P1.get_targets()
    hold = [t for t in T_all if t["y"] == 2025]
    illus = [t for t in T_all if t["y"] == 2026]
    names = list(hold[0]["pred"].keys())
    out = {"frozen_selection_sha256": sha, "positions": {}, "illustration_2026": {}}
    final = {"rule": sel["rule"], "selection_sha256": sha, "positions": {}}
    for g in GROUPS + ["ALL"]:
        ts = [t for t in hold if g == "ALL" or t["g"] == g]
        res = {}
        for fam in ("raw", "adj"):
            res[fam] = {}
            for nm in ["No defensive adjustment", "League average"] + names:
                res[fam][nm] = P1.score(P1.rows_for(ts, fam, nm), fam)
        s = sel["positions"][g]
        winner, default0 = s["winner_by_rank_acc"], s["default"]
        A = res["adj"]
        # confirmation: a replacement must still beat Full season on 2025
        default = default0
        if default0 != "Season to date" and not (A[default0]["rank_acc"] > A["Season to date"]["rank_acc"]):
            default = "Season to date"
        # predictive claim: default ordering above a coin flip on 2019–2024 (CI) AND on 2025
        s_def = P1.slate_stats(P1.rows_for(ts, "adj", default), "adj"); keys = sorted(s_def)
        coin = {k: (0, 0, v[3] / 2.0, v[3]) for k, v in s_def.items()}
        vs_coin = P1.boot(s_def, coin, keys, "rank")
        s_std = P1.slate_stats(P1.rows_for(ts, "adj", "Season to date"), "adj")
        s_win = P1.slate_stats(P1.rows_for(ts, "adj", winner), "adj")
        win_vs_std = P1.boot(s_win, s_std, keys, "rank")
        # predictive = the FINAL default's own 2019–2024 coin-flip interval is above 0 (audit fix:
        # a replacement that reverts must not inherit the winner's verdict) AND above 50% on 2025
        ci_train = (s["full_season_vs_coinflip"] if default == "Season to date" else s["winner_vs_coinflip"])["ci95"]
        predictive = bool(ci_train[0] > 0 and A[default]["rank_acc"] > 0.5)
        # the shrunk estimate frozen in phase 1 (method + k from 2019–2024) vs no adjustment, on 2025
        bs = s["best_shrunk"]
        shr = P1.score(P1.rows_for(ts, "adj", bs["method"], bs["k"]), "adj")
        noadj = A["No defensive adjustment"]["MAE"]
        res["frozen_shrunk"] = {"method": bs["method"], "k": bs["k"], "MAE": shr["MAE"], "no_adjustment_MAE": noadj,
                                "improvement_pct": 100 * (noadj - shr["MAE"]) / noadj}
        res["decision"] = {"winner_2019_2024": winner, "default_after_2019_2024": default0, "default_final": default,
                           "winner_vs_full_2025": {"diff": win_vs_std[0], "ci95": [win_vs_std[1], win_vs_std[2]]},
                           "default_vs_coinflip_2025": {"diff": vs_coin[0], "ci95": [vs_coin[1], vs_coin[2]]},
                           "predictive": predictive}
        out["positions"][g] = res
        final["positions"][g] = {"default": default, "predictive": predictive,
                                 "rank_acc_2019_2024": s["rank_acc"][default], "rank_acc_2025": A[default]["rank_acc"]}
        # 2026 illustration
        ti = [t for t in illus if g == "ALL" or t["g"] == g]
        if ti:
            out["illustration_2026"][g] = {nm: P1.score(P1.rows_for(ti, "adj", nm), "adj")["rank_acc"] for nm in ["Season to date", "Last 3", "Last 8", "Previous season"]}
        print(g, "| frozen default", default0, "| 2025: default", f"{A[default]['rank_acc']:.3f}", "full", f"{A['Season to date']['rank_acc']:.3f}",
              "winner", winner, f"{A[winner]['rank_acc']:.3f}", "| final", default, "| predictive", predictive,
              "| shrunk vs no-adj", f"{res['frozen_shrunk']['improvement_pct']:.2f}%", flush=True)
    json.dump(_clean(out), open(os.path.join(HERE, "results_2025.json"), "w"), indent=1, default=float, allow_nan=False)
    fb = json.dumps(final, indent=1, sort_keys=True, default=float)
    open(os.path.join(HERE, "final_defaults.json"), "w").write(fb)
    print("final_defaults.json sha256", hashlib.sha256(fb.encode()).hexdigest())

if __name__ == "__main__":
    main()
