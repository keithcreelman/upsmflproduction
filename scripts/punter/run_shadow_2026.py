#!/usr/bin/env python3
"""2026 weeks 1-7 scored with the frozen model trained through 2025 (every input is pre-game). Week 7 'actual' points are reconstructed
from play-by-play because MFL had not posted Week 7 punter scores when the data was pulled (scores summed to 0.0 for the whole week)."""
import os, sys, json
sys.path.insert(0, os.path.dirname(__file__))
from run_decision_validation import *
def main():
    ev, abl, m = project_all(final=False, S=5000, year=2026)
    out = {"rows": len(ev), "weeks": sorted(ev.week.unique().tolist()), "week7_points_source": "reconstructed (MFL unposted at pull time)"}
    for name, c in [("EW_UPS", "base_ups_ew"), ("prior4", "base_ups_last4"), ("season_to_date", "base_ups_std"), ("component_MC_mean", "mc_mean")]:
        out[name] = metrics(ev["points"], ev[c]); out[name]["spearman_weekly"] = weekly_spearman(ev, "points", c)
    lg = pd.read_parquet(os.path.join(P, "punter_games.parquet")).query("season>=2012 and season<2026")["points"].mean()
    out["league_mean"] = metrics(ev["points"], np.full(len(ev), lg))
    out["decisions_MC"] = decisions(ev, "mc_mean", "base_ups_ew"); out["decisions_EW_UPS"] = decisions(ev, "base_ups_ew")
    out["p10_p90_coverage"] = float(((ev.points >= ev.mc_p10) & (ev.points <= ev.mc_p90)).mean())
    json.dump(out, open(os.path.join(RES, "shadow_2026_wk1_7.json"), "w"), indent=1, default=float)
    ev[["season", "week", "team", "gsis_id", "punter_name", "points", "mc_mean", "mc_p10", "mc_p90", "base_ups_ew"]].to_csv(os.path.join(RES, "projections_vs_actual_2026_wk1_7.csv"), index=False)
    pd.set_option("display.width", 200)
    print({k: (round(v["rmse"], 4), round(v["r2"], 4), round(v.get("spearman_weekly", np.nan), 3)) for k, v in out.items() if isinstance(v, dict) and "rmse" in v})
    print({k: round(v, 4) if isinstance(v, float) else v for k, v in out["decisions_MC"].items() if not isinstance(v, list)}); print("coverage", out["p10_p90_coverage"])
if __name__ == "__main__": main()
