# Feature ablation and model comparison

Rule followed: features, hyperparameters and structure chosen with training (≤2023) and 2024 only. The 2025 columns below were produced by the **one-shot locked run** (`scripts/punter/run_locked_test.py`, git head `e80b7070`), trained through 2024, with no change after seeing them.

## 1. Team punts per game (Poisson, cumulative groups)  — baseline 2024 RMSE of "last-known punts/drive × drives" = 1.759
Groups: volume (rolling punts/drive, drives) → +A offense efficiency → +B opponent defense → +C Vegas → +D coaching/4th-down → +F environment.

**2024 (selection season, trained ≤2023)**

| features | rmse | mae | r2 | ΔRMSE | ΔMAE | ΔR² |
|---|---|---|---|---|---|---|
| volume | 1.7509 | 1.3993 | 0.0397 |  |  |  |
| volume+A | 1.7570 | 1.4048 | 0.0329 | 0.0061 | 0.0055 | -0.0067 |
| volume+A+B | 1.7455 | 1.3973 | 0.0455 | -0.0115 | -0.0075 | 0.0126 |
| volume+A+B+C | 1.7095 | 1.3746 | 0.0846 | -0.0361 | -0.0227 | 0.0390 |
| volume+A+B+C+D | 1.7094 | 1.3738 | 0.0846 | -0.0001 | -0.0008 | 0.0001 |
| volume+A+B+C+D+F | 1.7127 | 1.3758 | 0.0811 | 0.0033 | 0.0019 | -0.0036 |

**2025 (untouched test season, trained ≤2024; locked run)**

| features | rmse | mae | r2 | ΔRMSE | ΔMAE | ΔR² |
|---|---|---|---|---|---|---|
| volume | 1.7492 | 1.4467 | 0.0130 |  |  |  |
| volume+A | 1.7428 | 1.4315 | 0.0202 | -0.0064 | -0.0152 | 0.0072 |
| volume+A+B | 1.6800 | 1.3657 | 0.0896 | -0.0628 | -0.0658 | 0.0694 |
| volume+A+B+C | 1.6666 | 1.3501 | 0.1041 | -0.0134 | -0.0157 | 0.0145 |
| volume+A+B+C+D | 1.6625 | 1.3460 | 0.1085 | -0.0041 | -0.0041 | 0.0044 |
| volume+A+B+C+D+F | 1.6595 | 1.3434 | 0.1116 | -0.0029 | -0.0026 | 0.0032 |

Reading it: opponent defense (B) and Vegas (C) are what move forecasts in both seasons; offense efficiency on top of volume (A) adds almost nothing once drives and punt rate are in; coaching (D) and environment (F) are within noise. The direction of B and C persists in 2025.

## 2. Model families, team punts (full groups, RMSE; lower is better)
| model | features | 2024 | 2025 |
|---|---|---|---|
| baseline_league | - | 1.8818 | 1.9296 |
| baseline_rolling | rolling punts/drive x drives (no fit) | 1.7586 | 1.7536 |
| decomposed_drives_x_rate | volume+A+B+C+D+F | 1.7176 | 1.6733 |
| gbm | volume+A+B+C+D+F | 1.7481 | 1.6870 |
| hier | volume+A+B+C+D+F | 1.7192 | 1.6665 |
| negbin | volume+A+B+C+D+F | 1.7127 | 1.6596 |
| poisson | volume+A+B+C+D+F | 1.7127 | 1.6595 |
| ridge | volume+A+B+C+D+F | 1.7149 | 1.6589 |

- **Negative binomial collapses to Poisson** (estimated dispersion α = 0.0001): punt counts are *under*-dispersed relative to Poisson (variance ≈ 3.6 vs mean 4.3), not over-dispersed. Poisson is adequate; the drive-level binomial in the Monte Carlo is the natural count model.
- Gradient boosting never beat the Poisson GLM; the team/coach hierarchical model did not either; the drives × punt-rate decomposition was slightly worse than direct Poisson. Complexity did not pay.

## 3. Punter UPS points (Ridge, cumulative groups; Baseline 1 = prior UPS averages)
**2024:** 

| group | rmse | mae | r2 | spearman_weekly | ΔRMSE | Δrank corr |
|---|---|---|---|---|---|---|
| B1_history | 4.9290 | 3.9346 | 0.0080 | 0.1391 |  |  |
| +volume | 4.9497 | 3.9300 | -0.0003 | 0.1092 | 0.0207 | -0.0299 |
| +A_offense | 4.9526 | 3.9270 | -0.0015 | 0.1026 | 0.0029 | -0.0066 |
| +B_opp_defense | 4.9725 | 3.9452 | -0.0095 | 0.0721 | 0.0199 | -0.0305 |
| +C_vegas | 4.9688 | 3.9512 | -0.0080 | 0.0763 | -0.0037 | 0.0041 |
| +D_coaching | 4.9720 | 3.9548 | -0.0093 | 0.0747 | 0.0032 | -0.0016 |
| +E_punter | 4.9755 | 3.9628 | -0.0108 | 0.0704 | 0.0036 | -0.0043 |
| +F_environment | 4.9593 | 3.9501 | -0.0042 | 0.0854 | -0.0162 | 0.0151 |

**2025 (locked):** 

| group | rmse | mae | r2 | spearman_weekly | ΔRMSE | Δrank corr |
|---|---|---|---|---|---|---|
| B1_history | 4.6455 | 3.7717 | -0.0168 | -0.0374 |  |  |
| +volume | 4.6307 | 3.7316 | -0.0103 | 0.0162 | -0.0148 | 0.0536 |
| +A_offense | 4.6356 | 3.7420 | -0.0124 | -0.0062 | 0.0049 | -0.0225 |
| +B_opp_defense | 4.6320 | 3.7405 | -0.0109 | 0.0249 | -0.0035 | 0.0311 |
| +C_vegas | 4.6480 | 3.7543 | -0.0179 | 0.0101 | 0.0160 | -0.0148 |
| +D_coaching | 4.6468 | 3.7531 | -0.0174 | 0.0169 | -0.0012 | 0.0069 |
| +E_punter | 4.6594 | 3.7796 | -0.0229 | 0.0282 | 0.0126 | 0.0113 |
| +F_environment | 4.6425 | 3.7791 | -0.0155 | 0.0545 | -0.0169 | 0.0263 |

Every direct-regression variant stays within ±0.3 RMSE of the league mean: weekly UPS points are almost entirely unpredictable by regression on these groups. The component Monte Carlo (expected punts × inside-20 probability × gross average × exact scoring) is the model that holds up, see `historical_validation.md`.

## 4. H2 – Vegas variants (team punts RMSE, fit ≤2023, scored 2024)
| variant | rmse | mae | r2 |
|---|---|---|---|
| volume only (no Vegas, no matchup) | 1.7509 | 1.3993 | 0.0397 |
| spread alone (+volume) | 1.7503 | 1.3966 | 0.0403 |
| implied total alone (+volume) | 1.7443 | 1.3982 | 0.0469 |
| game total alone (+volume) | 1.7434 | 1.4043 | 0.0479 |
| spread + total (+volume) | 1.7417 | 1.4040 | 0.0497 |
| offense EPA + opponent defense (no Vegas) | 1.7459 | 1.3976 | 0.0451 |
| base + spread | 1.7424 | 1.3951 | 0.0490 |
| base + implied | 1.7178 | 1.3774 | 0.0756 |
| base + total | 1.7261 | 1.3881 | 0.0667 |
| base + all Vegas | 1.7097 | 1.3749 | 0.0843 |
Implied total beats the spread in every comparison. It stays useful **after** offense and opponent-defense terms (base + implied 0.0756 R² vs base + spread 0.0490, base + total 0.0667). Spread, total and implied are exactly collinear (implied = (total ± spread)/2), so coefficients are not interpretable; only out-of-sample accuracy is.
