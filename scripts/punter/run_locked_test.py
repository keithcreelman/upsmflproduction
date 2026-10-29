#!/usr/bin/env python3
"""ONE-SHOT locked test. Runs the already-chosen configuration on 2025 (trained through 2024) exactly once and writes
results/LOCKED_2025_RUN.json. A second run is refused: 2025 may not be inspected, then tuned against. It also scores
2026 weeks 1-7 (trained through 2025) as prospective-style evidence; those scores use only information before each game."""
import os, sys, json, datetime as dt, subprocess
sys.path.insert(0, os.path.dirname(__file__))
from run_decision_validation import *
import train_volume_model as TV
LOCK = os.path.join(RES, "LOCKED_2025_RUN.json")

def main():
    if os.path.exists(LOCK):
        sys.exit("REFUSED: the 2025 locked test already ran (%s). Rerunning would turn it into a tuning set." % LOCK)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--", "scripts/punter"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if dirty: sys.exit("REFUSED: scripts/punter has uncommitted changes; commit the frozen model code first so the run is attributable:\n" + dirty)
    open(LOCK, "w").write(json.dumps({"started_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "git_head": head, "status": "running"}))
    print("== volume models, final (train<=2024 -> 2025)"); TV.main(final=True)
    print("\n== punter-level decisions, final (train<=2024 -> 2025)")
    ev, abl, res, summary = run(final=True, S=10000)
    res.to_csv(os.path.join(RES, "decisions_final_2025.csv"), index=False); abl.to_csv(os.path.join(RES, "punter_ablation_final_2025.csv"), index=False)
    json.dump(summary, open(os.path.join(RES, "decision_summary_final_2025.json"), "w"), indent=1)
    ev[["season", "week", "team", "gsis_id", "punter_name", "points", "punts", "i20", "gross", "mc_exp_punts", "mc_exp_i20", "mc_mean", "mc_median", "mc_p10", "mc_p90"]].to_csv(os.path.join(RES, "projections_vs_actual_2025.csv"), index=False)
    pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40)
    print(res[["projection", "rmse", "r2", "spearman_weekly", "pairwise_win_rate", "win_rate_diff_0_0.5", "win_rate_diff_0.5_1", "win_rate_diff_1_2", "win_rate_diff_2_99", "top3_hit", "top5_hit",
               "regret_vs_best", "pick_gain_vs_baseline", "waiver_pool_pair_accuracy"]].round(4).to_string(index=False)); print(json.dumps(summary, indent=1))
    print(abl.round(4)[["group", "model", "rmse", "mae", "r2", "spearman_weekly"]].to_string(index=False))
    # ---- 2026 weeks 1-7, trained through 2025 (point-in-time inputs; the model was frozen before these were scored)
    ev26, abl26, m26 = project_all(final=False, S=5000, year=2026)
    out26 = {}
    for name, c in [("EW_UPS", "base_ups_ew"), ("prior4", "base_ups_last4"), ("season_to_date", "base_ups_std"), ("component_MC_mean", "mc_mean")]:
        out26[name] = metrics(ev26["points"], ev26[c]); out26[name]["spearman_weekly"] = weekly_spearman(ev26, "points", c)
    out26["decisions_MC"] = decisions(ev26, "mc_mean", "base_ups_ew"); out26["p10_p90_coverage"] = float(((ev26.points >= ev26.mc_p10) & (ev26.points <= ev26.mc_p90)).mean())
    json.dump(out26, open(os.path.join(RES, "shadow_2026_wk1_7.json"), "w"), indent=1, default=float)
    print("\n== 2026 wk1-7 (trained <=2025)"); print(json.dumps({k: (v if not isinstance(v, dict) else {a: (round(b, 4) if isinstance(b, float) else b) for a, b in v.items() if not isinstance(b, list)}) for k, v in out26.items()}, indent=1, default=float))
    ev26[["season", "week", "team", "gsis_id", "punter_name", "points", "mc_mean", "mc_p10", "mc_p90", "base_ups_ew"]].to_csv(os.path.join(RES, "projections_vs_actual_2026_wk1_7.csv"), index=False)
    json.dump({"finished_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "git_head": head, "status": "done"}, open(LOCK, "w"))

if __name__ == "__main__":
    main()
