#!/usr/bin/env python3
"""Render reports/punter/*.md from the saved result files (data/punter/processed/results, projections, audit tables)."""
import os, sys, json, glob, pandas as pd, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from punter_common import *
R = REPORTS; os.makedirs(R, exist_ok=True)
def md(df, floatfmt=3):
    df = df.copy()
    for c in df.columns:
        if df[c].dtype.kind == "f": df[c] = df[c].map(lambda v: "" if pd.isna(v) else ("%.*f" % (floatfmt, v)))
    return "| " + " | ".join(map(str, df.columns)) + " |\n|" + "---|" * len(df.columns) + "\n" + "\n".join("| " + " | ".join(map(str, r)) + " |" for r in df.astype(str).values.tolist())
def rj(n): return json.load(open(os.path.join(RES, n)))
def w(name, text): open(os.path.join(R, name), "w").write(text.strip() + "\n")

hyp = rj("hypotheses_dev.json"); st = rj("report_stats.json"); locked = rj("LOCKED_2025_RUN.json"); sh = rj("shadow_2026_wk1_7.json")
dsum24, dsum25 = rj("decision_summary_dev_2024.json"), rj("decision_summary_final_2025.json")
cv = pd.read_csv(os.path.join(RES, "rolling_origin_cv.csv")); dec24 = pd.read_csv(os.path.join(RES, "decisions_dev_2024.csv")); dec25 = pd.read_csv(os.path.join(RES, "decisions_final_2025.csv"))
vol24, vol25 = pd.read_csv(os.path.join(RES, "volume_models_dev_2024.csv")), pd.read_csv(os.path.join(RES, "volume_models_final_2025.csv"))
ab24, ab25 = pd.read_csv(os.path.join(RES, "punter_ablation_dev_2024.csv")), pd.read_csv(os.path.join(RES, "punter_ablation_final_2025.csv"))
aud = pd.read_csv(os.path.join(R, "scoring_audit_by_season.csv")); aud["exact_%"] = 100 * aud.exact / aud.n; aud["within_1pt_%"] = 100 * aud.within1 / aud.n
proj_f = sorted(glob.glob(os.path.join(ROOT, "data", "punter", "projections", "projections_2026_wk08-09_*.csv")))[0]; proj = pd.read_csv(proj_f)
smoke = pd.read_csv(os.path.join(RES, "smoke_tests_2026.csv"))

# ---------------------------------------------------------------- scoring audit
rules = json.load(open(os.path.join(P, "pn_rules_by_season.json")))
reasons = pd.read_csv(os.path.join(R, "scoring_audit_rows.csv")).assign(kind=lambda d: d.Reason.fillna("").str.split(":").str[0].str.slice(0, 60)).groupby("kind").size().reset_index(name="rows")
w("scoring_audit.md", f"""
# UPS punter scoring audit (MFL league 74598 is canonical)

Pulled **2026-10-29** from MFL `TYPE=rules` for every season (league ids: 2011 40832, 2012 37227, 2013 42721, 2014 30590, 2015 29015, 2016 27191, 2017+ 74598). Files: `data/punter/raw/rules_<year>.json`; extraction: `scripts/punter/extract_pn_rules.py` → `data/punter/processed/pn_rules_by_season.json`.

## Translation table (events that score a punter, 2012–2026)

| MFL event code | Meaning (MFL definition) | nflverse source used to rebuild it | UPS points |
|---|---|---|---|
| `PI` | Punts Inside 20 (punt ends inside the opponent's 20) | `punt_inside_twenty` | **+4 each** (2011: +2) |
| `ANY` | Average Yards per Punt, gross (total punt yards ÷ punts, evaluated per game) | `sum(kick_distance) / non-blocked punts` | **under 45.00: 0, 45.00–49.99: +1, 50.00–59.99: +3, 60.00+: +5** (not in 2011) |
| `HBP` | Punts Had Blocked | `punt_blocked` | **−2 each** |
| `PNY` | Punt Yards | `kick_distance` | 2011 only: 0.1 per 2 yards; removed in 2012 |

Everything else in a position group that includes PN (passing, rushing, receiving, tackles, fumbles, returns) applies to punters in principle but only fires on fakes, tackles and rare returns. There is **no scoring event for punt count, touchbacks, net average or fair catches.** Punt count and touchbacks matter only through `PI` and the `ANY` tier.

## Rule changes by season (core punter events)
- **2011 → 2012:** `PI` 2→4 points; `PNY` (yards) removed; `ANY` tiers added. **2011 is excluded from the model window** (reconstruction matched 1 of 479 rows).
- **2012–2026:** `PI`, `ANY` and `HBP` are identical in every season (verified by `tests/punter/test_scoring_reconstruction.py`). Other changes in those years (FG scoring 2016, return TD ranges 2025, first-down scoring 2021–22, decimal notation 2020) do not touch punters' main events.

## Reconstruction vs official MFL points
Method: nflverse play-by-play punts per punter-game scored with the table above, matched to MFL `playerScores` (PN) through the nflverse ID crosswalk. Official scores for 2011–2025 come from `player_weeklyscoringresults` in the 2026-06-05 local archive (a mirror of MFL `playerScores`); 2026 scores were read from MFL directly. The mirror was also cross-checked against live MFL reads for 2012, 2013, 2020 and 2025 (1,919 matched player-weeks, all identical).

{md(aud[['season','n','exact_%','within_1pt_%','mean_abs']].rename(columns={'season':'Season','n':'Punter-games','mean_abs':'Mean abs diff'}), 2)}

All of 2012–2026 clears the gate (every season ≥ 89% exact, ≥ 97% within one point, mean absolute difference ≤ 0.15; 2012 is the weakest year). **2026 Week 7 is not in this table:** MFL had not posted Week 7 punter scores when the data was pulled (they summed to exactly 0.0), so those rows are treated as missing and Week 7 "actual" points are reconstructed from play-by-play.

### Why the remaining rows differ (all 2012–2026 rows listed in `reports/punter/scoring_audit_rows.csv`)
Audit table columns: Season | Week | Player | MFL UPS points | Reconstructed points | Difference | Reason.

{md(reasons.rename(columns={'kind':'Reason (grouped)'}), 0)}

Typical causes: fractional differences are a non-punt event (a fake punt pass or rush, a tackle, fumble or return yardage) that play-by-play punt rows do not carry; ±1/±3/±5 differences are the 45/50/60 average-yards tier flipping because MFL's stat feed and nflverse differ by a yard on one punt; multiples of 4 are one inside-20 punt counted differently; and some MFL rows have no nflverse punter (ID crosswalk gap or a player with no punt).
""")

# ---------------------------------------------------------------- data dictionary
w("data_dictionary.md", f"""
# Data dictionary (punter model)

All point-in-time columns use only games played **strictly before** the game being projected (test: `tests/punter/test_point_in_time_features.py`, which scrambles every 2025+ outcome and requires every 2012–2024 feature to be unchanged).

## Sources
| Source | What | Pulled | Notes |
|---|---|---|---|
| MFL `TYPE=rules`, `allRules` | scoring rules, event dictionary | 2026-10-29 | public export, league 74598 and its pre-2017 ids |
| MFL `playerScores` (PN) | official weekly punter points | 2011–2025 from local archive `mfl_database_2026-06-05.db` (not re-read from production D1); 2026 direct from MFL | MFL had not posted 2026 Week 7 |
| nflverse play-by-play (`nflreadpy.load_pbp`) | every punt, drive, EPA | 2010–2026 | 2026 through Week 7 |
| nflverse schedules | spread, total, roof, temp, wind, coaches, stadium | 2010–2026 | see Vegas/weather caveats |
| nflverse `load_ff_playerids` | MFL id ↔ gsis id crosswalk | 2026-10-29 | stable player identity |

## Files (git-ignored parquet, rebuilt by scripts)
| File | Grain | Built by |
|---|---|---|
| `pbp_slim.parquet`, `schedules.parquet`, `ff_playerids.parquet` | play / game / player | `build_pbp_slim.py` |
| `team_games.parquet` | team-game outcomes (post-game facts) incl. scheduled-but-unplayed rows | `build_team_games.py` |
| `team_features.parquet` | team-game **pre-game** features | `build_weekly_features.py` |
| `punts.parquet`, `los_curve_coef.npy` | one row per non-blocked punt; expected inside-20 from the LOS curve | `build_drive_dataset.py` |
| `punter_games_pbp.parquet`, `scoring_audit_all_rows.csv` | punter-game box from play-by-play; audit | `build_scoring_audit.py` |
| `punter_games.parquet`, `punter_state_current.parquet` | punter-game table with point-in-time punter skill; state after last game | `build_punter_games.py` |

## Team features (`o_*` = team offense, `d_*` = defense allowed, `opp_*` = the same for the opponent)
Each is an exponentially weighted mean over the team's **prior games** (half-life 6 games, ×0.65 weight for games from an earlier season, shrunk toward the league mean as of that date with 2 pseudo-games). Byes are not games, so they are never zeros.

| Column | Meaning |
|---|---|
| `o_epa`, `o_sr`, `o_early_epa` | EPA/play, success rate, 1st–2nd down EPA (run + pass plays, regular season) |
| `o_pass_rate`, `o_sack_rate`, `o_third_rate`, `o_third_ytg` | pass rate; sacks per dropback; third-down conversion; avg third-down distance |
| `o_to_rate`, `o_tod_rate`, `o_fg_rate`, `o_td_rate`, `o_tno_rate`, `o_punt_rate` | per-drive rates: turnover, turnover on downs, field goal attempt, touchdown, three-and-out, punt |
| `o_ppd`, `o_ypd`, `o_start_yl`, `o_drives`, `o_plays` | points/drive, yards/drive, avg starting yard line, drives/game, plays/game |
| `o_go_rate` | fourth-down attempts ÷ (go + punt + field goal decisions) |
| `o_punt_los` | average distance to the opponent goal line at the team's punts |
| `spread`, `total_line`, `implied` | pregame spread (+ = this team favored), game total, team implied total = (total ± spread)/2 |
| `home`, `dome`, `wind`, `temp`, `altitude` | home team; dome/closed roof; mph; °F (NaN→0 / 68 when closed); Denver home = 5,280 ft |
| `coach` | head coach name (used by the hierarchical model only) |
| `lg_punt_rate`, `lg_i20_rate`, `lg_gross` | league-wide punts/drive, inside-20 rate and gross average over the previous 6 played weeks (captures year-to-year drift) |

## Punter state (`pk_*`; the punter's own earlier games on any team)
| Column | Meaning |
|---|---|
| `pk_gross` | gross yards/punt, game-decayed (half-life 24 games), shrunk to the league mean with 80 pseudo-punts |
| `pk_i20_resid` | (inside-20 − expected inside-20 from the league LOS/weather curve) per punt, shrunk with 100 pseudo-punts |
| `pk_tb_resid`, `pk_blk`, `pk_ppg` | end-zone punt residual, blocked-punt rate (shrunk), punts per appearance |
| `pk_ups_last4`, `pk_ups_std`, `pk_ups_prev`, `pk_ups_ew` | prior UPS points: last 4 games, season-to-date, prior season, weighted |
| `pk_n_games`, `pk_n_punts` | his earlier games and punts (0 = no history) |

## Caveats that matter
- **Vegas:** nflverse stores one spread/total per game (close to the closing line), so "pregame Vegas" is a proxy for what was knowable at the projection cutoff; for upcoming games the posted line is used and games with no posted line use a no-Vegas model.
- **Weather:** observed game-time weather stands in for the forecast historically; for upcoming games no forecast is stored and outdoor weather is set to neutral (8 mph, 58°F).
- **Starting QB, injuries, depth charts and offensive-line injuries are not used** (not available point-in-time in the sources). A team's punter is the punter from its previous game.
- **Net average, hang time, directional and fair-catch rates** exist only as descriptive statistics (H6); hang time is not in the sources.
""")

# ---------------------------------------------------------------- feature ablation / model comparison
def poisson_ablation(v):
    p = v[v.model == "poisson"].copy(); p["ΔRMSE"] = p.rmse.diff(); p["ΔMAE"] = p.mae.diff(); p["ΔR²"] = p.r2.diff(); return p[["features", "rmse", "mae", "r2", "ΔRMSE", "ΔMAE", "ΔR²"]]
def ridge_ablation(a):
    r = a[a.model == "ridge"].copy(); r["ΔRMSE"] = r.rmse.diff(); r["Δrank corr"] = r.spearman_weekly.diff(); return r[["group", "rmse", "mae", "r2", "spearman_weekly", "ΔRMSE", "Δrank corr"]]
h2 = pd.DataFrame(hyp["H2"])
w("feature_ablation.md", f"""
# Feature ablation and model comparison

Rule followed: features, hyperparameters and structure chosen with training (≤2023) and 2024 only. The 2025 columns below were produced by the **one-shot locked run** (`scripts/punter/run_locked_test.py`, git head `{locked['git_head'][:8]}`), trained through 2024, with no change after seeing them.

## 1. Team punts per game (Poisson, cumulative groups)  — baseline 2024 RMSE of "last-known punts/drive × drives" = 1.759
Groups: volume (rolling punts/drive, drives) → +A offense efficiency → +B opponent defense → +C Vegas → +D coaching/4th-down → +F environment.

**2024 (selection season, trained ≤2023)**

{md(poisson_ablation(vol24), 4)}

**2025 (untouched test season, trained ≤2024; locked run)**

{md(poisson_ablation(vol25), 4)}

Reading it: opponent defense (B) and Vegas (C) are what move forecasts in both seasons; offense efficiency on top of volume (A) adds almost nothing once drives and punt rate are in; coaching (D) and environment (F) are within noise. The direction of B and C persists in 2025.

## 2. Model families, team punts (full groups, RMSE; lower is better)
{md(pd.concat([vol24.assign(season='2024'), vol25.assign(season='2025')])[lambda d: d.features.isin(['volume+A+B+C+D+F']) | d.model.str.startswith('baseline')].pivot_table(index=['model','features'], columns='season', values='rmse').reset_index(), 4)}

- **Negative binomial collapses to Poisson** (estimated dispersion α = 0.0001): punt counts are *under*-dispersed relative to Poisson (variance ≈ 3.6 vs mean 4.3), not over-dispersed. Poisson is adequate; the drive-level binomial in the Monte Carlo is the natural count model.
- Gradient boosting never beat the Poisson GLM; the team/coach hierarchical model did not either; the drives × punt-rate decomposition was slightly worse than direct Poisson. Complexity did not pay.

## 3. Punter UPS points (Ridge, cumulative groups; Baseline 1 = prior UPS averages)
**2024:** 

{md(ridge_ablation(ab24), 4)}

**2025 (locked):** 

{md(ridge_ablation(ab25), 4)}

Every direct-regression variant stays within ±0.3 RMSE of the league mean: weekly UPS points are almost entirely unpredictable by regression on these groups. The component Monte Carlo (expected punts × inside-20 probability × gross average × exact scoring) is the model that holds up, see `historical_validation.md`.

## 4. H2 – Vegas variants (team punts RMSE, fit ≤2023, scored 2024)
{md(h2[['variant','rmse','mae','r2']], 4)}
Implied total beats the spread in every comparison. It stays useful **after** offense and opponent-defense terms (base + implied 0.0756 R² vs base + spread 0.0490, base + total 0.0667). Spread, total and implied are exactly collinear (implied = (total ± spread)/2), so coefficients are not interpretable; only out-of-sample accuracy is.
""")

# ---------------------------------------------------------------- historical validation
c24, c25 = st["components_2024"], st["components_2025"]
def comp_row(c, key, base):
    return {"model": c[key]["model"]["rmse"], base: c[key][base]["rmse"], "improvement %": 100 * (1 - c[key]["model"]["rmse"] / c[key][base]["rmse"])}
comps = pd.DataFrame([{"season": y, "component": n, **comp_row(c, k, b)} for y, c in ((2024, c24), (2025, c25)) for n, k, b in (("punt attempts", "punt_attempts", "league mean"), ("inside-20 count", "inside20_count", "league mean count"), ("gross average", "gross_average", "league mean"))]).rename(columns={"league mean count": "league mean", "model": "model RMSE", "league mean": "league-mean RMSE"})
comps = comps.rename(columns=lambda x: x)
cvt = cv.copy(); cvt = cvt[['year','n','rmse_league_mean','rmse_EW_UPS','rmse_component_MC','mc_vs_league_pct','mc_vs_best_simple_pct','rho_EW_UPS','rho_component_MC']]
w("historical_validation.md", f"""
# Historical validation

## Rolling-origin cross-validation (fit on seasons before each year, score that year; 2018–2024)
{md(cvt, 3)}

The component Monte Carlo beats the league mean in **7 of 7** seasons (mean {cv.mc_vs_league_pct.mean():.2f}% lower RMSE) and has the best weekly rank correlation in 6 of 7. Best simple baseline here is the league mean or the weighted prior UPS average (every history-based average is worse than the league mean in most years).

## Selection season 2024 (train ≤2023)
Component MC mean: RMSE **{dsum24['model_rmse']:.3f}** vs league mean 4.951 (**{dsum24['rmse_improvement_vs_league_mean_pct']:.2f}%** better; week-clustered 95% CI {st['decision_cis_2024']['rmse_improvement_vs_league_mean_pct'][1]:.2f}% to {st['decision_cis_2024']['rmse_improvement_vs_league_mean_pct'][2]:.2f}%); vs the weighted prior-UPS baseline {dsum24['rmse_improvement_vs_best_simple_baseline_pct']:.2f}%. Weekly Spearman {st['decision_cis_2024']['weekly_spearman_model'][0]:.3f} (CI {st['decision_cis_2024']['weekly_spearman_model'][1]:.3f} to {st['decision_cis_2024']['weekly_spearman_model'][2]:.3f}). Projected p10–p90 band holds {dsum24['p10_p90_coverage']:.0%} of outcomes (nominal 80%, i.e. slightly too wide).

## Locked test 2025 (train ≤2024; ran once)
Component MC mean: RMSE **{dsum25['model_rmse']:.3f}** vs league mean {dsum25['model_rmse']/(1-dsum25['rmse_improvement_vs_league_mean_pct']/100):.3f} (**{dsum25['rmse_improvement_vs_league_mean_pct']:.2f}%** better; CI {st['decision_cis_2025']['rmse_improvement_vs_league_mean_pct'][1]:.2f}% to {st['decision_cis_2025']['rmse_improvement_vs_league_mean_pct'][2]:.2f}%). Against the history-based baselines it is 3.1% better (best of them, weighted prior UPS, 4.765), but in 2025 those baselines were all *worse than the league mean*, so the honest comparator is the league mean: **0.15%**. Weekly Spearman {st['decision_cis_2025']['weekly_spearman_model'][0]:.3f} (CI {st['decision_cis_2025']['weekly_spearman_model'][1]:.3f} to {st['decision_cis_2025']['weekly_spearman_model'][2]:.3f}). p10–p90 coverage {dsum25['p10_p90_coverage']:.0%}.

## 2026 Weeks 1–7 (trained through 2025; all inputs pre-game; Week 7 actuals reconstructed because MFL had not posted them)
RMSE: component MC {sh['component_MC_mean']['rmse']:.3f}, league mean {sh['league_mean']['rmse']:.3f}, weighted prior UPS {sh['EW_UPS']['rmse']:.3f}, prior-4 {sh['prior4']['rmse']:.3f}. Weekly Spearman {sh['component_MC_mean']['spearman_weekly']:.3f}. Pairwise lineup win rate {sh['decisions_MC']['pairwise_win_rate']:.3f}. p10–p90 coverage {sh['p10_p90_coverage']:.0%}. *(The first copy of this block in the locked-run log used the unposted Week 7 zeros as truth and is invalid; this file was regenerated by `run_shadow_2026.py`.)*

## Component accuracy (2024 | 2025)
{md(comps, 3)}

- **Punt attempts and gross average are forecastable; inside-20 count is not.** For inside-20 count the model is no better than the league average (RMSE 1.201 vs 1.200 in 2024; 1.146 vs 1.157 in 2025). Inside-20 punts are worth 4 points each and explain 93% of UPS-point variance, so this component decides whether the whole projection can rank punters.
- Calibration of the per-punt inside-20 probability by quintile (2025, predicted → observed): {', '.join('%.3f→%.3f' % (r['mean_pred'], r['observed']) for r in c25['i20_calibration'])}.
- Touchbacks are not modeled: UPS has no touchback event, and nflverse's `punt_in_endzone` flags only end-zone catches (0.06% of punts).

## Hypotheses (training + 2024 only; nothing here touches 2025)

**H1 – Is volume king?** Contemporaneous share of UPS-point variance (2012–2024): punts alone {hyp['H1_contemporaneous_R2']['punts']:.1%}; inside-20 count alone {hyp['H1_contemporaneous_R2']['inside-20 count']:.1%}; gross average alone {hyp['H1_contemporaneous_R2']['gross avg']:.1%}; punts + inside-20 + gross {hyp['H1_contemporaneous_R2']['punts + I20 + gross']:.1%}. Predictive (fit ≤2023, scored 2024): 

{md(pd.DataFrame(hyp['H1_predictive']), 4)}

**H2** – see feature_ablation §4: implied total > spread.

**H3 – Spread buckets (2012–2024, per team-game):**

{md(pd.DataFrame(hyp['H3_buckets']), 3)}

Underdogs punt more (3.84 punts for 7+ favorites vs 4.92 for >10 underdogs), but **that is explained by offensive quality**: with offense EPA, drives and opponent defense controlled, bucket effects on punts are small (7+ favorite −4% p≈0.04; every underdog bucket within ±2.4% of a pick'em game, none significant). Large underdogs do not lose punt volume: their punt-per-drive rate is the highest (0.43), and turnovers (1.42/g) and fourth-down attempts (1.60/g) rise with them. UPS points by bucket are flat and noisy (7.0–7.7); the best bucket is 3–6.5-point underdog (7.66) but the gaps are inside sampling error.

**H4 – Bad vs functional-but-stalled offenses (per punt):** inside-20 rate rises with offense quality (worst-EPA quintile 34.9% → best 38.5%) **because their punts start closer to the goal line (66.8 vs 65.4 yards out), not because of better placement**; after the opportunity adjustment all four offense types land within ±1 pt of expected (stalled: 0.0). The "functional but stalled" hypothesis is not supported.

**H5 – Opportunity adjustment:** next-game inside-20 deviance per punt (lower is better): league constant {hyp['H5_deviance_per_punt']['league constant']:.4f}; LOS curve only {hyp['H5_deviance_per_punt']['opportunity only (LOS curve)']:.4f}; raw punter I20% only {hyp['H5_deviance_per_punt']['raw punter I20% only']:.4f}; raw + opportunity {hyp['H5_deviance_per_punt']['raw punter I20% + opportunity']:.4f}; opportunity + adjusted punter skill {hyp['H5_deviance_per_punt']['opportunity + adjusted punter skill (pk_i20_resid)']:.4f}. Opportunity matters (it is the main signal) and punter skill adds almost nothing on top; the adjusted and raw versions are practically tied, so adjustment is correct in principle but not a material forecast gain.

**H6 – Persistence ({hyp['H6_pairs']} punter-season pairs, ≥40 punts both years):** year-to-year r — gross average {hyp['H6_year_to_year_r']['gross']:.2f}, net average {hyp['H6_year_to_year_r']['net']:.2f}, fair-catch rate {hyp['H6_year_to_year_r']['fc']:.2f}, inside-20 rate {hyp['H6_year_to_year_r']['i20']:.2f} (opportunity-adjusted {hyp['H6_year_to_year_r']['i20_adj']:.2f}), end-zone rate {hyp['H6_year_to_year_r']['tb']:.2f}. Full-season reliability from odd/even split halves (Spearman-Brown): gross {hyp['H6_spearman_brown']['gross']:.2f}, net {hyp['H6_spearman_brown']['net']:.2f}, fair catch {hyp['H6_spearman_brown']['fc']:.2f}, inside-20 {hyp['H6_spearman_brown']['i20']:.2f}. **Distance is far more persistent than placement**; placement is largely noise within a season.
""")

# ---------------------------------------------------------------- decision validation
def fmt_dec(d): return d[['projection', 'rmse', 'pairwise_win_rate', 'win_rate_diff_0_0.5', 'win_rate_diff_0.5_1', 'win_rate_diff_1_2', 'win_rate_diff_2_99', 'top3_hit', 'top5_hit', 'regret_vs_best', 'pick_gain_vs_baseline', 'waiver_pool_pair_accuracy']].rename(columns={'win_rate_diff_0_0.5': 'win <0.5', 'win_rate_diff_0.5_1': 'win 0.5–1', 'win_rate_diff_1_2': 'win 1–2', 'win_rate_diff_2_99': 'win >2', 'pairwise_win_rate': 'pairwise win', 'pick_gain_vs_baseline': 'top-pick gain vs EW', 'waiver_pool_pair_accuracy': 'waiver-pool order acc'})
def cirows(k): return pd.DataFrame([{"metric": m, "estimate": v[0], "CI low": v[1], "CI high": v[2]} for m, v in st[k].items() if isinstance(v, list) and len(v) == 3])
w("decision_validation.md", f"""
# Decision-based validation

Each week, every punter is compared with every other punter (pairwise lineup/waiver choices). "win" = the higher-projected punter scored more (ties dropped). Top-3/top-5 hit = overlap with the week's actual best 3/5. Regret = best actual score that week minus the model's top pick. Waiver-pool accuracy uses a **proxy pool** (everyone outside the 12 best by weighted prior UPS points that week) because historical roster ownership is not reconstructed (archive roster status is unreliable before 2020).

## 2024 (selection)
{md(fmt_dec(dec24), 3)}

## 2025 (locked)
{md(fmt_dec(dec25), 3)}

Confidence intervals (week-clustered bootstrap), 2024: 

{md(cirows('decision_cis_2024'), 4)}

2025: 

{md(cirows('decision_cis_2025'), 4)}

## Is a projected one-point advantage actionable?
Win rate of the higher-projected punter by projected gap:

2024: {', '.join('%s pts: %.1f%% (%d pairs)' % (r['proj_diff'], 100*r['win_rate'], r['pairs']) for r in st['decision_cis_2024']['win_rate_by_projected_difference'])}.

2025: {', '.join('%s pts: %.1f%% (%d pairs)' % (r['proj_diff'], 100*r['win_rate'], r['pairs']) for r in st['decision_cis_2025']['win_rate_by_projected_difference'])}.

A gap under 1 point is a coin flip (50–52%). Gaps of 1.5–2 points win about 55%, 2–3 points about 59–61%, and only 3+ points reached 57–63% on small samples. A one-point projected edge should not drive a lineup change on its own.

## Verdict on decisions
The model's pairwise win-rate point estimate is above 50% in 2024 (55.0%, CI 52.5–57.5%), 2025 (51.8%, CI 48.6–55.5%, which includes 50%) and 2026 Weeks 1–7 (55.1%), but **the improvement over the weighted prior-UPS baseline is not statistically supportable** (difference +1.3 pts, CI −2.1 to +5.1 in 2024; +3.1 pts, CI −2.0 to +9.9 in 2025). Its top-pick gain over the weighted prior-UPS pick is −1.0 points per week in 2024 and +0.95 in 2025; the week-clustered intervals span zero (columns `pick_gain_ci95` in `decisions_*.csv`). It does not reliably find the week's best punter (top-3 hit 12%, random 18% in 2024 / 12% in 2025).
""")

# ---------------------------------------------------------------- production recommendation
rank = proj.copy()
def table_week(wk):
    t = rank[rank.week == wk].sort_values("ups_mean", ascending=False).reset_index(drop=True); t.index += 1
    t = t[['punter_name', 'team', 'opp', 'exp_punts', 'exp_i20', 'exp_gross', 'ups_mean', 'median', 'p10', 'p90', 'p_top3', 'p_top6', 'reasons']]
    t.columns = ['Player', 'Team', 'Opp', 'Exp punts', 'Exp I20', 'Exp gross', 'UPS mean', 'Median', '10th', '90th', 'P(top-3)', 'P(top-6)', 'Why']
    return md(t.reset_index().rename(columns={'index': '#'}), 2)
sm = smoke.rename(columns={'punts_g': 'punts/g', 'i20_pct': 'I20%', 'gross26': 'gross', 'ups_avg26': 'UPS avg 2026', 'pk_gross': 'model gross skill', 'pk_i20_resid': 'I20 skill (adj)', 'wk8_mean': 'Wk8 proj', 'wk9_mean': 'Wk9 proj'})[['punter', 'team', 'g26', 'punts/g', 'I20%', 'gross', 'UPS avg 2026', 'career_punts_pre26', 'model gross skill', 'Wk8 proj', 'Wk9 proj']]
w("production_recommendation.md", f"""
# Production recommendation (Draft; nothing merged or deployed)

## Verdict: keep it as a **shadow model**. Do not replace the current UPS punter process.

Adoption gate (from the spec) and result:

| Requirement | Result |
|---|---|
| Beats best simple baseline on 2024 | Yes, marginally: 0.96% below the league-mean RMSE (CI −0.02% to 1.99%); 1.7% below the best history-based baseline |
| Beats it on untouched 2025 | Barely: 0.15% below the league mean (CI −1.1% to 1.6%); 3.1% below the best history baseline, which itself was worse than the league mean |
| Improves weekly ranking quality | Yes vs history baselines in 6/7 rolling years (ρ 0.09–0.23); 2025 ρ only 0.053 (CI −0.004 to 0.097) |
| Positive lineup-decision gains | Pairwise win-rate point estimate above 50% each season, but gain over baseline not statistically supportable |
| Not reliant on one season / outliers | Beats the league mean in 7/7 rolling years, but by ~1–3% each time |
| Calibrated uncertainty | Reasonable: p10–p90 holds 85% / 86% / 90% (2024 / 2025 / 2026 shadow) against 80% nominal; slightly wide |
| Regenerable from documented inputs | Yes: manifests, SHA-stamped archive, tests |
| Gate: ≥2% RMSE gain, or smaller gain with statistically supportable decision/waiver gains | **Not met** |

**Which component failed:** inside-the-20 placement. Punt attempts (RMSE 12.9% below league in 2025) and gross average (5.2%) are forecastable, but inside-20 count is not (0.9% better than league in 2025; none in 2024), and each inside-20 punt is 4 UPS points. The model captures the forecastable parts and is honest about the rest, but the remaining variance is luck.

### What to do with it
- Use it as a **volume/distance guide** and tie-breaker, not as a lineup authority. A projected gap under 1 point is a coin flip; at 2+ points the better punter wins about 58–62% of the time.
- Keep the archive running weekly (`scripts/punter/run_weekly_projection.py`) and re-test after 2026 finishes (prospective evidence; Weeks 1–7 so far: pairwise 55.1%, rank ρ 0.14).
- Possible improvements (not done): starting QB/offense injuries, depth charts and forecast weather feeds, true historical Vegas open/close lines, and net/hang-time data.

## Week 8 and Week 9 rankings (generated 2026-10-29 from data through Week 7; 10,000 simulated games per punter)
Archived: `data/punter/projections/{os.path.basename(proj_f)}` and its manifest. Notes: Week 9 games without a posted line use the no-Vegas model; outdoor weather is neutral because no forecast is stored; each team's punter is the one who punted in its last game; teams on bye are absent (e.g. NYG in Week 8).

### Week 8
{table_week(8)}

### Week 9
{table_week(9)}

## 2026 smoke tests
{md(sm, 2)}

- **Townsend (TEN):** strong team volume (4.3 punts/g, 349 prior punts) but only a 33% inside-20 rate; the model keeps the volume and shrinks placement toward average → 7.5 in Week 8.
- **Stout (NYG):** best-in-group gross average (51.6) → highest gross skill adjustment; solid volume; Week 9 projection 8.1 (bye in Week 8).
- **Rehkow (CIN):** 65% inside-20 on only 3.3 punts/g and a 45.1 gross; the model regresses the placement hard (118 prior career punts) and projects ~6.6, below his 7.0 average, because low volume and weak distance are stable while placement is not.
- **Mann, Crawshaw, Whelan:** the three highest 2026 averages (9.4, 9.3, 9.9) are rated 6.6–8.2. Mann and Crawshaw carry real volume (5.1 punts/g); Whelan's 9.9 sits on 3.9 punts/g plus a 52% inside-20 rate and the model projects only 6.6: same-looking averages, but his rests on the least stable ingredient (placement) and the thinnest volume.
- Two punters with similar UPS averages can differ in forward-looking stability because volume and distance carry (r ≈ 0.5 year to year, reliability 0.6–0.7), while inside-20 rate does not (r ≈ 0.25, reliability 0.3).

## Answers to the 12 questions
1. **Is volume king?** It is the biggest forecastable piece, but not "king" of the outcome. Punts alone explain 25% of realized UPS-point variance; inside-20 count explains 93% (4 points each). Prospectively, expected punts correlates 0.15 with next-game points and explains almost none of the variance (R² ≈ 0).
2. **Best model for expected punts:** a Poisson GLM on rolling punts/drive × drives + opponent defense + Vegas (+ coaching, environment): RMSE 1.66 / R² 0.11 on 2025 vs 1.75 for the rolling-rate baseline. Negative binomial adds nothing (counts are under-dispersed); GBM and hierarchical models were no better.
3. **Implied total vs spread:** implied total (and game total) beats spread; base + implied R² 0.076 vs base + spread 0.049 (2024). It remains useful after offense and opponent-defense terms.
4. **Underdog type:** moderate underdogs (3–6.5) show the highest average UPS points (7.66) but differences are not distinguishable from noise. Big underdogs do not lose punt volume: they punt most per drive (0.43) while also turning it over (1.42/g) and going for it on fourth down (1.60/g) more. After controlling for offense quality there is no underdog effect on punts.
5. **Offensive stats that add value:** drives/game and punt rate carry the volume; EPA, success rate and similar efficiency stats add almost nothing once those are in. Opponent-defense and Vegas terms are the useful additions; the team-level improvement from groups B+C was 0.05–0.08 RMSE.
6. **Opponent stats that add value:** opponent defensive EPA/success/punt-rate allowed and opponent pace (drives) improved team punt forecasts (−0.012 RMSE in 2024, −0.063 in 2025).
7. **Stability:** gross average is stable (year-to-year r 0.47, reliability 0.73); inside-20 rate is not (r 0.26; opportunity-adjusted 0.22; reliability 0.31).
8. **Punter skill vs environment:** for punt volume, environment is everything (it is a team property). For inside-20, opportunity (punt field position, weather) explains the little that is predictable and punter skill adds almost nothing; skill matters most for distance.
9. **Improved 2024 and untouched 2025?** Yes, but marginally: 0.96% and 0.15% below the league-mean RMSE; below the 2% gate.
10. **Improved lineup and waiver decisions?** Not measurably: win rates beat a coin flip but not the baseline with statistical support; top-pick gains are within noise.
11. **Replace the current UPS punter process?** No. Run as a shadow model.
12. **Week 8 and Week 9 rankings:** see the tables above (top of Week 8: Johnston, Crawshaw, Araiza, Mann, Bojorquez; top of Week 9: Scott, Stout, Mann, Wright, Bojorquez). The gap between #1 and #15 is about 1.5 points, below the actionable threshold.
""")

w("methodology.md", f"""
# Methodology and provenance

**Scope:** a point-in-time model of weekly UPS punter points, built as a draft; nothing merged, deployed or written to MFL or production D1. Window: 2012–2026 (2010–2011 are burn-in history; 2011 UPS scoring differs). Training ≤2023, selection 2024, **locked test 2025 (run once)**, prospective 2026.

**Pipeline (all in `scripts/punter/`):** `extract_pn_rules.py` → `build_scoring_audit.py` (gate) → `build_pbp_slim.py` → `build_team_games.py` → `build_weekly_features.py` → `build_drive_dataset.py` → `build_punter_games.py` → `train_volume_model.py` / `run_hypotheses.py` / `run_backtest.py` / `run_rolling_cv.py` / `run_decision_validation.py` → `run_locked_test.py` (one-shot; refuses a second run) → `run_shadow_2026.py`, `report_stats.py`, `report_smoke_tests.py` → `run_weekly_projection.py` → `build_reports.py`.

**Model:** expected punts = team Poisson GLM (volume + opponent + Vegas + coaching + league drift); drives from a ridge model; drive count drawn around the forecast and punts as Binomial(drives, punt rate); inside-20 ~ Binomial with probability from a logistic GLM on a league line-of-scrimmage/weather curve + punter opportunity-adjusted skill + league drift; gross average from a ridge model on punter skill, field position, weather and league drift, with per-punt standard deviation 8.9 and a game-level shock; blocked punts at the punter's shrunk rate; exact UPS scoring applied to each simulated game; 10,000 games per punter for projections.

**Rules followed:** only earlier games feed any feature (tests include scrambling all 2025+ outcomes); byes are not games; punter skill follows the punter, team context follows his current team; 2025 was not used for any choice and the locked run is attributable to commit `{locked['git_head'][:8]}`; 2026 projections are archived with UTC cutoff, data-through date, code commit and input hashes.

**Departures and honest limits**
1. The "drive-level multinomial outcome model" was approximated: drive results were modeled as TD/FG/punt/turnover/downs counts in the team Poisson/binomial structure and the Monte Carlo, not as a separate drive-by-drive multinomial classifier. The decomposed drives × punt-rate comparison is included; a per-drive multinomial was not built.
2. Vegas: nflverse lines (close to closing) stand in for the Wednesday/Sunday number; weather is observed, not forecast. Both likely overstate the information available at a Tuesday lineup deadline.
3. Not available point-in-time in these sources: starting QB, injuries, depth chart, offensive-line injuries, hang time, coverage-unit effects, coach fourth-down aggressiveness over expected (only raw go rates). A punter's team is assumed from his previous game.
4. Hyperparameters (half-lives, shrinkage constants) were fixed a priori, not tuned.
5. Official 2011–2025 MFL scores came from the 2026-06-05 local archive rather than production D1 (to avoid metered reads); the archive's values were cross-checked against live MFL reads for 2012, 2013 (15 weeks), 2020 and 2025: all 1,919 matched player-weeks were identical.
6. 2026 Week 7 MFL scores were unposted at pull time; that week uses reconstructed points. The first 2026 shadow block printed by the locked-run log used those zeros and was replaced.
7. The proxy waiver pool is not true availability.
8. Touchbacks are not a UPS scoring event and are not forecast.
9. Dev-mode runs tuned nothing on 2025; after the lock, only descriptive statistics (`report_stats.py`) and the unposted-week fix (which cannot touch 2025) were added.
""")
print("reports written:", sorted(os.listdir(R)))
