#!/usr/bin/env python3
"""Applies the PRODUCT rule to the locked backtest results and writes locked/pts_agst_default_window.json,
the file the mobile app's FPA_DEFAULT_WINDOW / FPA_EVIDENCE must match (tests/pts_agst_default_window.test.mjs).

Product rule (on top of the pre-registered statistical rule in locked/selection.json):
  * A window other than Full season becomes a position's default only if it beats Full season by at
    least MATERIAL_GAIN of rank accuracy on BOTH 2019–2024 and the 2025 holdout, with both 95% intervals
    above 0. Otherwise the default is Full season (through the latest completed game).
  * "signal" = the default's rank accuracy is above a coin flip (95% interval above 0) on BOTH periods.
  * pct = the default's pooled 2019–2025 rank accuracy, in whole percent (for the screen).
  * k   = the LOSO-tuned shrinkage (games) of Full season on 2019–2024, used only to decide color."""
import json, hashlib, os
HERE = os.path.dirname(os.path.abspath(__file__)); L = os.path.join(HERE, "locked")
MATERIAL_GAIN = 0.02
GROUPS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]
WINDOW_KEY = {"Season to date": "full"}
def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()
def main():
    sel = json.load(open(os.path.join(L, "selection.json"))); fin = json.load(open(os.path.join(L, "final_defaults.json")))
    r24 = json.load(open(os.path.join(L, "results_2019_2024.json"))); r25 = json.load(open(os.path.join(L, "results_2025.json")))
    assert fin["selection_sha256"] == sha(os.path.join(L, "selection.json")) == r25["frozen_selection_sha256"]
    out = {"material_gain": MATERIAL_GAIN, "selection_sha256": sha(os.path.join(L, "selection.json")),
           "final_defaults_sha256": sha(os.path.join(L, "final_defaults.json")), "positions": {}}
    for g in GROUPS:
        s, d = sel["positions"][g], r25["positions"][g]["decision"]
        stat_default = fin["positions"][g]["default"]
        tr = s["winner_vs_full_season"]; ho = d["winner_vs_full_2025"]
        material = (s["winner_by_rank_acc"] != "Season to date" and tr["diff"] >= MATERIAL_GAIN and tr["ci95"][0] > 0
                    and ho["diff"] >= MATERIAL_GAIN and ho["ci95"][0] > 0)
        default = s["winner_by_rank_acc"] if material else "Season to date"
        A24 = r24["positions"][g]["adj"][default]; A25 = r25["positions"][g]["adj"][default]
        ci24 = (s["full_season_vs_coinflip"] if default == "Season to date" else s["winner_vs_coinflip"])["ci95"]
        ci25 = d["default_vs_coinflip_2025"]["ci95"] if stat_default == default else None
        signal = bool(ci24[0] > 0 and ci25 is not None and ci25[0] > 0)
        pooled = (A24["rank_acc"] * A24["pairs"] + A25["rank_acc"] * A25["pairs"]) / (A24["pairs"] + A25["pairs"])
        out["positions"][g] = {
            "statistical_default": stat_default, "product_default": WINDOW_KEY.get(default, default),
            "winner_2019_2024": s["winner_by_rank_acc"], "gain_vs_full_2019_2024": tr["diff"], "gain_vs_full_2025": ho["diff"],
            "material": material, "signal": signal, "rank_acc_2019_2024": A24["rank_acc"], "rank_acc_2025": A25["rank_acc"],
            "pct": round(100 * pooled), "k": r24["positions"][g]["adj"]["Season to date"]["shrunk_loso"]["k_all_train"] if signal else None,
            "ci_vs_coin_2019_2024": ci24, "ci_vs_coin_2025": ci25,
        }
    json.dump(out, open(os.path.join(L, "pts_agst_default_window.json"), "w"), indent=1, sort_keys=True)
    for g, v in out["positions"].items(): print(g, v["product_default"], "signal" if v["signal"] else "no signal", v["pct"], v["k"], "| stat:", v["statistical_default"], "material:", v["material"])
if __name__ == "__main__": main()
