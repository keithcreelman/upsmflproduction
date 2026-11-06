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
Archived: `data/punter/projections/projections_2026_wk08-09_20261029T224918Z.csv` and its manifest. Notes: Week 9 games without a posted line use the no-Vegas model; outdoor weather is neutral because no forecast is stored; each team's punter is the one who punted in its last game; teams on bye are absent (e.g. NYG in Week 8).

### Week 8
| # | Player | Team | Opp | Exp punts | Exp I20 | Exp gross | UPS mean | Median | 10th | 90th | P(top-3) | P(top-6) | Why |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | C.Johnston | PIT | CLE | 4.32 | 1.76 | 47.91 | 8.42 | 8.00 | 2.00 | 15.00 | 0.18 | 0.32 | +Vegas 0.7; +punter skill 0.5 |
| 2 | J.Crawshaw | DEN | KC | 4.33 | 1.64 | 49.06 | 8.23 | 8.00 | 1.00 | 15.00 | 0.17 | 0.31 | +Vegas 0.8; +volume 0.3 |
| 3 | M.Araiza | KC | DEN | 4.05 | 1.58 | 49.83 | 8.21 | 7.00 | 3.00 | 15.00 | 0.16 | 0.30 | +Vegas 0.6; +matchup 0.4; coaching -0.2; volume -0.2 |
| 4 | B.Mann | PHI | WAS | 4.35 | 1.67 | 47.64 | 7.98 | 8.00 | 1.00 | 15.00 | 0.16 | 0.29 | +Vegas 1.1; +volume 0.2 |
| 5 | C.Bojorquez | CLE | PIT | 4.65 | 1.61 | 48.06 | 7.85 | 7.00 | 1.00 | 15.00 | 0.15 | 0.28 | +Vegas 1.0; +volume 0.3; punter skill -0.4 |
| 6 | J.Scott | LAC | LA | 4.06 | 1.58 | 47.01 | 7.56 | 7.00 | 1.00 | 15.00 | 0.14 | 0.26 | +weather/venue 0.6; +Vegas 0.5; punter skill -0.2 |
| 7 | T.Townsend | TEN | CIN | 3.92 | 1.52 | 47.97 | 7.53 | 7.00 | 1.00 | 13.00 | 0.13 | 0.26 | +Vegas 0.5; +punter skill 0.2 |
| 8 | T.Way | WAS | PHI | 3.86 | 1.55 | 47.19 | 7.53 | 7.00 | 1.00 | 13.00 | 0.13 | 0.25 | +punter skill 0.3; +Vegas 0.3 |
| 9 | R.Sanchez | IND | JAX | 3.60 | 1.42 | 48.34 | 7.22 | 7.00 | 1.00 | 13.00 | 0.12 | 0.23 | +punter skill 0.6; +Vegas 0.5; coaching -0.2 |
| 10 | J.Fox | DET | MIN | 3.35 | 1.39 | 48.37 | 7.18 | 7.00 | 1.00 | 13.00 | 0.11 | 0.22 | +weather/venue 0.4; +punter skill 0.2; coaching -0.2 |
| 11 | J.Bailey | ATL | TB | 3.92 | 1.46 | 46.98 | 7.08 | 7.00 | 1.00 | 13.00 | 0.12 | 0.23 | +Vegas 0.3; +matchup 0.3; punter skill -0.2; weather/venue -0.2 |
| 12 | A.Cole | LV | NYJ | 3.65 | 1.34 | 48.89 | 7.06 | 7.00 | 1.00 | 13.00 | 0.11 | 0.22 | weather/venue -0.2 |
| 13 | E.Evans | LA | LAC | 3.59 | 1.39 | 47.88 | 7.00 | 7.00 | 1.00 | 13.00 | 0.10 | 0.22 | +weather/venue 0.4; +matchup 0.2; Vegas -0.3; punter skill -0.3 |
| 14 | T.Taylor | CHI | SEA | 3.74 | 1.38 | 47.66 | 6.90 | 7.00 | 1.00 | 13.00 | 0.10 | 0.21 | +matchup 0.3 |
| 15 | M.Dickson | SEA | CHI | 3.47 | 1.38 | 47.16 | 6.83 | 7.00 | 1.00 | 13.00 | 0.10 | 0.20 | Vegas -0.3 |
| 16 | L.Cooke | JAX | IND | 3.25 | 1.31 | 47.64 | 6.73 | 7.00 | 1.00 | 13.00 | 0.09 | 0.19 | +punter skill 0.3; Vegas -0.6 |
| 17 | S.Martin | CAR | GB | 3.48 | 1.38 | 46.55 | 6.71 | 7.00 | 1.00 | 13.00 | 0.09 | 0.20 | +offense 0.2; matchup -0.3 |
| 18 | B.Pinion | MIA | NE | 3.77 | 1.42 | 45.69 | 6.70 | 7.00 | 0.00 | 13.00 | 0.10 | 0.20 | +Vegas 0.5; punter skill -0.4; offense -0.2 |
| 19 | B.Thorson | MIN | DET | 3.50 | 1.39 | 45.87 | 6.62 | 5.00 | 1.00 | 13.00 | 0.09 | 0.19 | +weather/venue 0.4; punter skill -0.5; offense -0.2 |
| 20 | A.McNamara | NYJ | LV | 3.54 | 1.34 | 46.58 | 6.58 | 5.00 | 1.00 | 13.00 | 0.09 | 0.19 | near league average |
| 21 | R.Rehkow | CIN | TEN | 3.13 | 1.25 | 47.80 | 6.57 | 7.00 | 1.00 | 13.00 | 0.08 | 0.18 | +punter skill 0.2; +coaching 0.2; Vegas -0.7; volume -0.2 |
| 22 | D.Whelan | GB | CAR | 3.26 | 1.24 | 48.25 | 6.55 | 7.00 | 1.00 | 13.00 | 0.09 | 0.18 | +punter skill 0.2; Vegas -0.2; coaching -0.2 |
| 23 | R.Dixon | TB | ATL | 3.71 | 1.37 | 45.47 | 6.45 | 5.00 | 0.00 | 13.00 | 0.09 | 0.18 | punter skill -0.6 |
| 24 | M.Wishnowsky | NE | MIA | 3.12 | 1.21 | 46.52 | 6.12 | 5.00 | 0.00 | 12.00 | 0.07 | 0.16 | matchup -0.3 |
| 25 | B.Gillikin | ARI | DAL | 3.07 | 1.12 | 46.77 | 5.80 | 5.00 | 0.00 | 11.00 | 0.06 | 0.13 | Vegas -0.5; matchup -0.3 |
| 26 | R.Eckley | BAL | BUF | 2.97 | 1.11 | 46.39 | 5.73 | 5.00 | 0.00 | 11.00 | 0.06 | 0.13 | Vegas -0.6; punter skill -0.3 |
| 27 | B.Anger | DAL | ARI | 2.53 | 0.98 | 47.62 | 5.52 | 5.00 | 0.00 | 11.00 | 0.05 | 0.11 | +punter skill 0.3; Vegas -1.0; volume -0.2 |
| 28 | T.Doman | BUF | BAL | 2.75 | 1.05 | 46.30 | 5.52 | 5.00 | 0.00 | 11.00 | 0.05 | 0.12 | Vegas -0.8; punter skill -0.2 |

### Week 9
| # | Player | Team | Opp | Exp punts | Exp I20 | Exp gross | UPS mean | Median | 10th | 90th | P(top-3) | P(top-6) | Why |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | J.Scott | LAC | HOU | 4.35 | 1.71 | 47.07 | 8.05 | 8.00 | 1.00 | 15.00 | 0.16 | 0.29 | +Vegas 0.8; +weather/venue 0.5 |
| 2 | J.Stout | NYG | PHI | 4.04 | 1.62 | 48.54 | 8.05 | 8.00 | 1.00 | 15.00 | 0.15 | 0.28 | +punter skill 0.6; +Vegas 0.6; matchup -0.2 |
| 3 | B.Mann | PHI | NYG | 4.25 | 1.65 | 47.70 | 7.92 | 8.00 | 1.00 | 15.00 | 0.15 | 0.28 | +Vegas 0.9; +coaching 0.3 |
| 4 | R.Wright | NO | CLE | 3.86 | 1.59 | 47.89 | 7.84 | 7.00 | 1.00 | 15.00 | 0.14 | 0.27 | +weather/venue 0.4; +matchup 0.3; coaching -0.2 |
| 5 | C.Bojorquez | CLE | NO | 4.15 | 1.56 | 48.57 | 7.82 | 7.00 | 1.00 | 15.00 | 0.14 | 0.27 | +weather/venue 0.5; +Vegas 0.5; punter skill -0.3; offense -0.2 |
| 6 | S.Martin | CAR | DEN | 4.12 | 1.63 | 46.61 | 7.63 | 7.00 | 1.00 | 13.00 | 0.14 | 0.26 | +matchup 0.4; +Vegas 0.4 |
| 7 | T.Way | WAS | LA | 3.83 | 1.56 | 47.19 | 7.54 | 7.00 | 1.00 | 13.00 | 0.14 | 0.25 | +punter skill 0.4 |
| 8 | B.Gillikin | ARI | SEA | 4.38 | 1.60 | 46.77 | 7.49 | 7.00 | 1.00 | 13.00 | 0.14 | 0.25 | +Vegas 0.9; +matchup 0.3; punter skill -0.3 |
| 9 | K.Kroeger | HOU | LAC | 4.06 | 1.57 | 46.73 | 7.41 | 7.00 | 1.00 | 13.00 | 0.12 | 0.24 | +weather/venue 0.5; +Vegas 0.3; punter skill -0.6 |
| 10 | A.McNamara | NYJ | KC | 3.99 | 1.51 | 46.52 | 7.16 | 7.00 | 1.00 | 13.00 | 0.12 | 0.23 | +Vegas 0.8 |
| 11 | J.Crawshaw | DEN | CAR | 3.84 | 1.43 | 47.36 | 7.03 | 7.00 | 1.00 | 13.00 | 0.11 | 0.22 | +volume 0.3; +coaching 0.2 |
| 12 | A.Cole | LV | SF | 3.57 | 1.32 | 48.89 | 6.96 | 7.00 | 1.00 | 13.00 | 0.10 | 0.21 | +Vegas 0.2; +punter skill 0.2; matchup -0.3; weather/venue -0.2 |
| 13 | L.Cooke | JAX | BAL | 3.49 | 1.38 | 47.58 | 6.94 | 7.00 | 1.00 | 13.00 | 0.10 | 0.20 | +punter skill 0.3; +coaching 0.2 |
| 14 | R.Rehkow | CIN | ATL | 3.28 | 1.30 | 47.74 | 6.71 | 7.00 | 1.00 | 13.00 | 0.09 | 0.19 | +coaching 0.2; +punter skill 0.2; Vegas -0.5 |
| 15 | M.Dickson | SEA | ARI | 3.40 | 1.34 | 47.16 | 6.69 | 7.00 | 1.00 | 13.00 | 0.09 | 0.18 | Vegas -0.4 |
| 16 | M.Araiza | KC | NYJ | 3.19 | 1.25 | 48.25 | 6.62 | 7.00 | 1.00 | 13.00 | 0.08 | 0.18 | +punter skill 0.3; coaching -0.2 |
| 17 | D.Whelan | GB | NE | 3.38 | 1.27 | 48.19 | 6.62 | 7.00 | 1.00 | 13.00 | 0.08 | 0.18 | +punter skill 0.2 |
| 18 | R.Dixon | TB | CHI | 3.83 | 1.42 | 45.41 | 6.60 | 5.00 | 0.00 | 13.00 | 0.09 | 0.19 | +Vegas 0.2; +volume 0.2; punter skill -0.6 |
| 19 | T.Doman | BUF | MIN | 3.28 | 1.33 | 46.76 | 6.58 | 5.00 | 1.00 | 13.00 | 0.09 | 0.18 | +weather/venue 0.3; Vegas -0.3; punter skill -0.2 |
| 20 | T.Taylor | CHI | TB | 3.33 | 1.22 | 47.71 | 6.34 | 5.00 | 1.00 | 12.00 | 0.08 | 0.17 | +matchup 0.2; Vegas -0.4; coaching -0.2 |
| 21 | R.Sanchez | IND | DAL | 2.94 | 1.15 | 48.40 | 6.32 | 5.00 | 1.00 | 12.00 | 0.07 | 0.16 | +punter skill 0.5; coaching -0.2; Vegas -0.2 |
| 22 | J.Bailey | ATL | CIN | 3.34 | 1.24 | 47.04 | 6.29 | 5.00 | 1.00 | 12.00 | 0.08 | 0.16 | punter skill -0.2; Vegas -0.2 |
| 23 | B.Thorson | MIN | BUF | 3.25 | 1.29 | 45.93 | 6.24 | 5.00 | 0.00 | 12.00 | 0.07 | 0.16 | +weather/venue 0.4; punter skill -0.5 |
| 24 | E.Evans | LA | WAS | 3.28 | 1.20 | 47.31 | 6.19 | 5.00 | 1.00 | 12.00 | 0.08 | 0.16 | Vegas -0.4; punter skill -0.2 |
| 25 | B.Pinion | MIA | DET | 3.43 | 1.29 | 45.69 | 6.19 | 5.00 | 0.00 | 12.00 | 0.08 | 0.16 | punter skill -0.3 |
| 26 | R.Eckley | BAL | JAX | 3.23 | 1.21 | 46.45 | 6.04 | 5.00 | 0.00 | 12.00 | 0.07 | 0.15 | punter skill -0.3; Vegas -0.3 |
| 27 | M.Wishnowsky | NE | GB | 3.05 | 1.18 | 46.58 | 5.97 | 5.00 | 0.00 | 12.00 | 0.06 | 0.14 | matchup -0.3; Vegas -0.2 |
| 28 | B.Anger | DAL | IND | 2.80 | 1.08 | 47.56 | 5.89 | 5.00 | 0.00 | 11.00 | 0.06 | 0.13 | +punter skill 0.3; Vegas -0.7; volume -0.3 |
| 29 | J.Fox | DET | MIA | 2.74 | 1.07 | 47.79 | 5.88 | 5.00 | 0.00 | 11.00 | 0.06 | 0.13 | +punter skill 0.2; Vegas -0.4; matchup -0.4 |
| 30 | C.Waitman | SF | LV | 2.80 | 1.10 | 46.59 | 5.77 | 5.00 | 0.00 | 11.00 | 0.06 | 0.13 | Vegas -0.5; volume -0.2 |

## 2026 smoke tests
| punter | team | g26 | punts/g | I20% | gross | UPS avg 2026 | career_punts_pre26 | model gross skill | Wk8 proj | Wk9 proj |
|---|---|---|---|---|---|---|---|---|---|---|
| Tommy Townsend | TEN | 7 | 4.29 | 0.33 | 49.17 | 6.86 | 349 | 46.91 | 7.53 |  |
| Jordan Stout | NYG | 7 | 3.86 | 0.44 | 51.63 | 8.29 | 231 | 47.27 |  | 8.05 |
| Ryan Rehkow | CIN | 6 | 3.33 | 0.65 | 45.10 | 7.00 | 118 | 46.90 | 6.57 | 6.71 |
| Corey Bojorquez | CLE | 7 | 4.86 | 0.32 | 50.06 | 7.00 | 546 | 46.98 | 7.85 | 7.82 |
| Tress Way | WAS | 6 | 4.67 | 0.36 | 48.75 | 8.50 | 832 | 46.47 | 7.53 | 7.54 |
| Braden Mann | PHI | 7 | 5.14 | 0.47 | 47.89 | 9.43 | 376 | 47.15 | 7.98 | 7.92 |
| Jeremy Crawshaw | DEN | 7 | 5.14 | 0.44 | 48.64 | 9.29 | 75 | 46.55 | 8.23 | 7.03 |
| Daniel Whelan | GB | 7 | 3.86 | 0.52 | 49.70 | 9.86 | 162 | 47.19 | 6.55 | 6.62 |

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
