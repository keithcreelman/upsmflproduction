#!/usr/bin/env python3
"""Builds MATCHUP.md from matchup_results.json and matchup_direction.json (run matchup_eval.py and
matchup_direction.py first)."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, "matchup_results.json")))
dr = json.load(open(os.path.join(HERE, "matchup_direction.json")))
G = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]; LBL = {"PK": "K", "PN": "P"}
PER = [("2019-2024 (LOSO)", "2019-2024", "2019–2024 (k chosen leaving out the scored season)"), ("2025 holdout", "2025", "2025 holdout (k from 2019–2024)")]
md = []
def P(s=""): md.append(s)
def pc(x): return "—" if x is None else f"{100 * x:.1f}"
def m(x): return f"{x:.2f}"
def ci(v, k, s=1.0, dp=2): a, b = v[k + "_ci"]; return f"{s * v[k]:+.{dp}f} [{s * a:+.{dp}f}, {s * b:+.{dp}f}]"

P("# Stats → Pts Agst: does the defense add anything to the offense? (matchup decomposition)")
P()
P("Follow-up to the window backtest (README.md). Same 2019–2025 games and the same leak-free rules: every number below uses only games completed "
  "before the target week (and the previous season). One target = one defense × one position × that defense's next final game; the thing predicted "
  "is the UPS/MFL points that position scored against the defense in that game.")
P()
P("- **1. Offense baseline only:** the upcoming offense's own points at the position per game, season to date (previous season if none yet), shrunk toward the league average by k_o games.")
P("- **2. Raw Allowed:** the defense's points allowed per game (Full season).")
P("- **Offense × raw Allowed:** the baseline × (raw Allowed ÷ league average), i.e. using raw Allowed as the matchup multiplier.")
P("- **3. Defense effect only:** the defense's schedule-adjusted effect = Σ allowed ÷ Σ the past opponents' own averages at the position "
  "(each opponent's average over its games before the target week, excluding the game against this defense). Scored as an ordering of the next "
  "game's points ÷ the upcoming offense's own pregame average, and as an above/below call against the trivial rule \"always below\" "
  "(offenses land below their own average a little more often than above it).")
P("- **4. Combined:** offense baseline × defense effect; **4a** unshrunk, **4b** the effect shrunk toward the league ratio by k_d games. "
  "The difference form (baseline + mean of allowed − opponent average) is shown alongside.")
P("- Rank accuracy = share of pairs of target games in the same week and position put in the right order (a coin flip = 50).")
P("- Intervals: 95% paired bootstrap over season-weeks.")
P()
for key, dk, title in PER:
    P(f"## {title}: MAE in points (rank accuracy %)")
    P()
    P("| Pos | n | 1. Offense only | 2. Raw Allowed | Offense × raw Allowed | 3. Effect only: rank % | 4a. Combined unshrunk | 4b. Combined shrunk | 4b difference form |")
    P("|---|---|---|---|---|---|---|---|---|")
    for g in G:
        R = d["positions"][g][key]
        ob = R["Offense baseline"]; ra = R["Raw Allowed [Full season]"]; ox = R["Offense x raw Allowed ratio [Full season]"]
        eo = R["_effect_only"]["Full season"]; cu = R["Combined ratio [Full season] unshrunk"]; cs = R["Combined ratio [Full season] shrunk"]
        cd = R["Combined difference [Full season] shrunk"]
        P(f"| {LBL.get(g, g)} | {ob['n']} | {m(ob['MAE'])} ({pc(ob['rank_acc'])}) | {m(ra['MAE'])} ({pc(ra['rank_acc'])}) | {m(ox['MAE'])} ({pc(ox['rank_acc'])}) | "
          f"{pc(eo['rank_acc'])} | {m(cu['MAE'])} ({pc(cu['rank_acc'])}) | {m(cs['MAE'])} ({pc(cs['rank_acc'])}) | {m(cd['MAE'])} ({pc(cd['rank_acc'])}) |")
    P()
    P(f"**{title}: what the defense adds to the offense baseline** (4b − 1; MAE: negative = better; rank: positive = better; above/below: effect's call − \"always below\")")
    P()
    P("| Pos | MAE change, points | MAE change % | Rank accuracy change, points | Above/below vs \"always below\", points |")
    P("|---|---|---|---|---|")
    for g in G:
        R = d["positions"][g][key]; ob = R["Offense baseline"]
        v = R["_incremental_vs_offense_baseline"]["Combined ratio [Full season] shrunk"]
        rk = {"dRank": 100 * v["dRank"], "dRank_ci": [100 * x for x in v["dRank_ci"]]}
        acc, base, diff, lo, hi, n = dr[f"{g}|{dk}"]
        P(f"| {LBL.get(g, g)} | {ci(v, 'dMAE')} | {100 * v['dMAE'] / ob['MAE']:+.1f}% | {ci(rk, 'dRank', dp=1)} | "
          f"{100 * diff:+.1f} [{100 * lo:+.1f}, {100 * hi:+.1f}] ({100 * acc:.1f} vs {100 * base:.1f}) |")
    P()
P("## Ratio or difference?")
P()
P("Equally stable. Split-half check within each season (a defense's odd games vs its even games, Spearman, mean of 2019–2025):")
P()
P("| Pos | Ratio | Difference | k_o | k_d ratio | k_d difference |")
P("|---|---|---|---|---|---|")
for g in G:
    s = d["stability"][g]; p = d["positions"][g]
    P(f"| {LBL.get(g, g)} | {s['ratio_split_half_spearman']:.3f} | {s['difference_split_half_spearman']:.3f} | {p['k_offense_all_train']} | "
      f"{p['k_defense_all_train']['Combined ratio|Full season']} | {p['k_defense_all_train']['Combined difference|Full season']} |")
P()
P("## Other comparisons (MAE, 2019–2024 → 2025)")
P()
P("| Pos | League average | Player baseline (knows who played; not pregame) | Best shrunk combined window |")
P("|---|---|---|---|")
for g in G:
    cells = []
    for key, _, _ in PER:
        R = d["positions"][g][key]
        best = min([k for k in R if k.startswith("Combined ratio") and k.endswith(" shrunk")], key=lambda k: R[k]["MAE"])
        cells.append((R["League average"]["MAE"], R["Player baseline (knows lineup)"]["MAE"], best.split("[")[1].split("]")[0], R[best]["MAE"]))
    a, b = cells
    P(f"| {LBL.get(g, g)} | {m(a[0])} → {m(b[0])} | {m(a[1])} → {m(b[1])} | {a[2]} {m(a[3])} → {b[2]} {m(b[3])} |")
P()
open(os.path.join(HERE, "MATCHUP.md"), "w").write("\n".join(md) + "\n")
print("wrote MATCHUP.md")
