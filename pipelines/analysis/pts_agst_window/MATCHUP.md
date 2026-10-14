# Stats → Pts Agst: does the defense add anything to the offense? (matchup decomposition)

Follow-up to the window backtest (README.md). Same 2019–2025 games and the same leak-free rules: every number below uses only games completed before the target week (and the previous season). One target = one defense × one position × that defense's next final game; the thing predicted is the UPS/MFL points that position scored against the defense in that game.

- **1. Offense baseline only:** the upcoming offense's own points at the position per game, season to date (previous season if none yet), shrunk toward the league average by k_o games.
- **2. Raw Allowed:** the defense's points allowed per game (Full season).
- **Offense × raw Allowed:** the baseline × (raw Allowed ÷ league average), i.e. using raw Allowed as the matchup multiplier.
- **3. Defense effect only:** the defense's schedule-adjusted effect = Σ allowed ÷ Σ the past opponents' own averages at the position (each opponent's average over its games before the target week, excluding the game against this defense). Scored as an ordering of the next game's points ÷ the upcoming offense's own pregame average, and as an above/below call against the trivial rule "always below" (offenses land below their own average a little more often than above it).
- **4. Combined:** offense baseline × defense effect; **4a** unshrunk, **4b** the effect shrunk toward the league ratio by k_d games. The difference form (baseline + mean of allowed − opponent average) is shown alongside.
- Rank accuracy = share of pairs of target games in the same week and position put in the right order (a coin flip = 50).
- Intervals: 95% paired bootstrap over season-weeks.

## 2019–2024 (k chosen leaving out the scored season): MAE in points (rank accuracy %)

| Pos | n | 1. Offense only | 2. Raw Allowed | Offense × raw Allowed | 3. Effect only: rank % | 4a. Combined unshrunk | 4b. Combined shrunk | 4b difference form |
|---|---|---|---|---|---|---|---|---|
| QB | 2816 | 8.55 (59.2) | 9.60 (52.1) | 9.20 (57.5) | 53.5 | 9.49 (57.7) | 8.59 (59.6) | 8.59 (59.7) |
| RB | 2816 | 8.22 (57.4) | 9.04 (54.3) | 8.72 (57.6) | 54.5 | 8.99 (57.3) | 8.16 (58.9) | 8.16 (59.0) |
| WR | 2816 | 11.82 (61.0) | 13.47 (51.5) | 12.75 (57.9) | 52.3 | 13.00 (57.6) | 11.86 (60.9) | 11.85 (60.9) |
| TE | 2816 | 6.32 (61.2) | 7.28 (52.0) | 6.82 (58.6) | 52.1 | 7.10 (58.6) | 6.32 (61.3) | 6.33 (61.3) |
| DL | 2816 | 8.81 (61.6) | 10.03 (54.2) | 9.40 (60.4) | 55.0 | 9.62 (60.7) | 8.85 (62.5) | 8.79 (62.6) |
| LB | 2816 | 6.02 (65.0) | 7.47 (50.9) | 6.75 (61.8) | 52.2 | 6.83 (62.4) | 6.06 (65.1) | 6.08 (65.1) |
| DB | 2816 | 8.42 (53.0) | 9.14 (53.4) | 9.09 (54.3) | 53.0 | 9.30 (54.0) | 8.39 (54.6) | 8.38 (54.7) |
| K | 2816 | 3.87 (52.5) | 4.19 (52.2) | 4.18 (52.8) | 52.5 | 4.37 (52.7) | 3.87 (53.4) | 3.86 (53.5) |
| P | 2816 | 3.89 (54.2) | 4.26 (51.2) | 4.24 (52.0) | 51.1 | 4.43 (52.3) | 3.90 (54.4) | 3.90 (54.3) |

**2019–2024 (k chosen leaving out the scored season): what the defense adds to the offense baseline** (4b − 1; MAE: negative = better; rank: positive = better; above/below: effect's call − "always below")

| Pos | MAE change, points | MAE change % | Rank accuracy change, points | Above/below vs "always below", points |
|---|---|---|---|---|
| QB | +0.05 [-0.02, +0.13] | +0.5% | +0.4 [-0.1, +0.8] | +1.4 [-1.6, +4.2] (53.0 vs 51.7) |
| RB | -0.06 [-0.11, -0.01] | -0.7% | +1.5 [+0.9, +2.2] | +1.5 [-1.0, +4.0] (55.3 vs 53.9) |
| WR | +0.04 [-0.02, +0.11] | +0.4% | -0.1 [-0.3, +0.2] | -1.3 [-3.8, +1.3] (53.2 vs 54.5) |
| TE | +0.00 [-0.02, +0.03] | +0.0% | +0.1 [-0.2, +0.4] | +0.5 [-2.2, +3.3] (51.9 vs 51.4) |
| DL | +0.05 [-0.13, +0.38] | +0.5% | +1.0 [+0.4, +1.6] | +4.8 [+2.2, +7.4] (55.9 vs 51.0) |
| LB | +0.04 [-0.01, +0.12] | +0.7% | +0.1 [-0.1, +0.3] | -0.9 [-3.8, +2.0] (51.9 vs 52.7) |
| DB | -0.03 [-0.08, +0.02] | -0.4% | +1.7 [+0.6, +2.8] | +0.4 [-2.0, +2.8] (53.6 vs 53.2) |
| K | +0.00 [-0.01, +0.03] | +0.1% | +0.8 [+0.0, +1.6] | -1.4 [-4.4, +1.4] (52.9 vs 54.2) |
| P | +0.01 [-0.00, +0.02] | +0.3% | +0.2 [-0.3, +0.7] | -3.2 [-5.7, -0.7] (51.7 vs 54.9) |

## 2025 holdout (k from 2019–2024): MAE in points (rank accuracy %)

| Pos | n | 1. Offense only | 2. Raw Allowed | Offense × raw Allowed | 3. Effect only: rank % | 4a. Combined unshrunk | 4b. Combined shrunk | 4b difference form |
|---|---|---|---|---|---|---|---|---|
| QB | 480 | 8.76 (56.7) | 9.59 (54.3) | 9.34 (57.8) | 55.3 | 9.98 (58.2) | 8.70 (57.8) | 8.69 (58.2) |
| RB | 480 | 8.48 (57.6) | 9.16 (52.0) | 8.85 (55.6) | 52.8 | 9.07 (55.3) | 8.53 (58.4) | 8.54 (58.1) |
| WR | 480 | 11.23 (62.4) | 13.10 (51.2) | 12.30 (59.0) | 53.7 | 12.68 (59.9) | 11.21 (62.9) | 11.20 (63.4) |
| TE | 480 | 7.96 (57.0) | 8.56 (54.0) | 8.39 (57.3) | 53.9 | 8.58 (57.4) | 7.96 (57.7) | 7.95 (57.5) |
| DL | 480 | 9.38 (58.3) | 10.07 (54.9) | 9.64 (58.7) | 55.8 | 10.08 (58.8) | 9.22 (59.9) | 9.22 (59.9) |
| LB | 480 | 4.92 (59.8) | 5.55 (50.0) | 5.31 (56.5) | 49.9 | 5.38 (55.4) | 4.92 (59.6) | 4.92 (59.2) |
| DB | 480 | 8.16 (53.7) | 9.05 (51.7) | 9.00 (52.9) | 53.9 | 9.09 (53.4) | 8.16 (54.7) | 8.16 (54.4) |
| K | 480 | 4.11 (53.7) | 4.40 (52.2) | 4.35 (53.6) | 52.3 | 4.47 (53.9) | 4.10 (54.8) | 4.10 (54.7) |
| P | 480 | 3.87 (48.4) | 4.10 (51.9) | 4.11 (51.6) | 51.4 | 4.38 (51.2) | 3.88 (49.2) | 3.89 (49.6) |

**2025 holdout (k from 2019–2024): what the defense adds to the offense baseline** (4b − 1; MAE: negative = better; rank: positive = better; above/below: effect's call − "always below")

| Pos | MAE change, points | MAE change % | Rank accuracy change, points | Above/below vs "always below", points |
|---|---|---|---|---|
| QB | -0.06 [-0.15, +0.02] | -0.7% | +1.1 [-0.0, +2.2] | +2.7 [-2.7, +8.3] (55.7 vs 53.0) |
| RB | +0.06 [-0.06, +0.19] | +0.7% | +0.8 [-0.7, +2.2] | +0.8 [-5.8, +7.8] (52.7 vs 51.9) |
| WR | -0.02 [-0.13, +0.10] | -0.1% | +0.5 [-0.1, +1.4] | -2.7 [-10.0, +4.5] (53.8 vs 56.5) |
| TE | -0.00 [-0.08, +0.09] | -0.0% | +0.8 [-0.1, +1.7] | +0.8 [-3.1, +5.3] (52.5 vs 51.7) |
| DL | -0.16 [-0.33, +0.04] | -1.7% | +1.6 [+0.1, +3.2] | +2.3 [-3.1, +7.7] (56.6 vs 54.3) |
| LB | +0.00 [-0.02, +0.02] | +0.0% | -0.3 [-0.9, +0.2] | -5.7 [-11.7, +0.0] (49.2 vs 54.8) |
| DB | -0.00 [-0.11, +0.12] | -0.0% | +1.0 [-2.1, +3.9] | +1.9 [-3.7, +7.7] (54.7 vs 52.8) |
| K | -0.01 [-0.03, +0.02] | -0.1% | +1.1 [-1.0, +3.3] | -4.0 [-8.5, +0.2] (52.4 vs 56.4) |
| P | +0.01 [-0.02, +0.06] | +0.3% | +0.8 [-0.1, +1.8] | -2.8 [-8.2, +2.8] (50.2 vs 53.0) |

## Ratio or difference?

Equally stable. Split-half check within each season (a defense's odd games vs its even games, Spearman, mean of 2019–2025):

| Pos | Ratio | Difference | k_o | k_d ratio | k_d difference |
|---|---|---|---|---|---|
| QB | 0.336 | 0.332 | 5 | 30 | 30 |
| RB | 0.306 | 0.310 | 5 | 20 | 20 |
| WR | 0.272 | 0.269 | 5 | 50 | 30 |
| TE | 0.182 | 0.180 | 5 | 50 | 50 |
| DL | 0.414 | 0.420 | 3 | 12 | 12 |
| LB | 0.152 | 0.156 | 3 | 80 | 50 |
| DB | 0.279 | 0.282 | 30 | 20 | 20 |
| K | 0.138 | 0.143 | 30 | 50 | 50 |
| P | 0.156 | 0.157 | 30 | 120 | 80 |

## Other comparisons (MAE, 2019–2024 → 2025)

| Pos | League average | Player baseline (knows who played; not pregame) | Best shrunk combined window |
|---|---|---|---|
| QB | 8.91 → 8.99 | 9.62 → 10.40 | Blend .5 8.57 → Blend .5 8.67 |
| RB | 8.46 → 8.70 | 9.38 → 9.40 | Blend .5 8.11 → Previous season 8.46 |
| WR | 12.42 → 12.17 | 12.77 → 11.99 | Blend .5 11.82 → Full season 11.21 |
| TE | 6.75 → 8.19 | 6.65 → 8.04 | Full season 6.32 → Blend .5 7.95 |
| DL | 9.37 → 9.71 | 9.31 → 9.92 | Blend .5 8.78 → Blend .5 9.21 |
| LB | 6.76 → 5.18 | 6.67 → 5.56 | Blend .5 6.05 → Full season 4.92 |
| DB | 8.46 → 8.19 | 9.85 → 9.26 | Full season 8.39 → Last 3 8.12 |
| K | 3.88 → 4.13 | 4.20 → 4.38 | Blend .5 3.86 → Blend .5 4.10 |
| P | 3.91 → 3.86 | 4.16 → 4.12 | Last 3 3.90 → Last 3 3.88 |

