# Decision-based validation

Each week, every punter is compared with every other punter (pairwise lineup/waiver choices). "win" = the higher-projected punter scored more (ties dropped). Top-3/top-5 hit = overlap with the week's actual best 3/5. Regret = best actual score that week minus the model's top pick. Waiver-pool accuracy uses a **proxy pool** (everyone outside the 12 best by weighted prior UPS points that week) because historical roster ownership is not reconstructed (archive roster status is unreliable before 2020).

## 2024 (selection)
| projection | rmse | pairwise win | win <0.5 | win 0.5–1 | win 1–2 | win >2 | top3_hit | top5_hit | regret_vs_best | top-pick gain vs EW | waiver-pool order acc |
|---|---|---|---|---|---|---|---|---|---|---|---|
| random |  | 0.493 | 0.500 | 0.472 |  |  | 0.176 | 0.188 | 8.394 | 2.135 | 0.475 |
| prior4_UPS | 5.316 | 0.554 | 0.526 | 0.482 | 0.512 | 0.580 | 0.196 | 0.282 | 11.235 | -0.706 | 0.527 |
| season_to_date_UPS | 5.328 | 0.559 | 0.524 | 0.552 | 0.517 | 0.582 | 0.235 | 0.271 | 11.824 | -1.294 | 0.550 |
| prior_season_UPS | 5.150 | 0.530 | 0.507 | 0.519 | 0.520 | 0.548 | 0.137 | 0.165 | 11.588 | -1.059 | 0.498 |
| EW_UPS (baseline) | 5.000 | 0.536 | 0.504 | 0.530 | 0.539 | 0.566 | 0.098 | 0.200 | 10.529 | 0.000 | 0.506 |
| component_MC_mean (model) | 4.915 | 0.550 | 0.520 | 0.514 | 0.564 | 0.617 | 0.118 | 0.235 | 11.529 | -1.000 | 0.545 |
| ridge_full | 4.959 | 0.529 | 0.502 | 0.516 | 0.533 | 0.588 | 0.098 | 0.153 | 10.059 | 0.471 | 0.515 |
| gbm_full | 4.994 | 0.529 | 0.505 | 0.530 | 0.541 | 0.545 | 0.059 | 0.200 | 11.529 | -1.000 | 0.523 |

## 2025 (locked)
| projection | rmse | pairwise win | win <0.5 | win 0.5–1 | win 1–2 | win >2 | top3_hit | top5_hit | regret_vs_best | top-pick gain vs EW | waiver-pool order acc |
|---|---|---|---|---|---|---|---|---|---|---|---|
| random |  | 0.516 | 0.515 | 0.522 |  |  | 0.118 | 0.165 | 9.324 | 0.424 | 0.538 |
| prior4_UPS | 5.219 | 0.478 | 0.492 | 0.498 | 0.481 | 0.471 | 0.078 | 0.165 | 8.706 | 1.041 | 0.469 |
| season_to_date_UPS | 5.029 | 0.480 | 0.486 | 0.484 | 0.479 | 0.476 | 0.078 | 0.176 | 9.529 | 0.218 | 0.458 |
| prior_season_UPS | 4.901 | 0.505 | 0.478 | 0.503 | 0.512 | 0.512 | 0.196 | 0.235 | 7.471 | 2.276 | 0.501 |
| EW_UPS (baseline) | 4.765 | 0.490 | 0.484 | 0.490 | 0.484 | 0.514 | 0.059 | 0.176 | 9.747 | 0.000 | 0.484 |
| component_MC_mean (model) | 4.618 | 0.522 | 0.497 | 0.518 | 0.545 | 0.574 | 0.118 | 0.224 | 8.794 | 0.953 | 0.509 |
| ridge_full | 4.643 | 0.523 | 0.515 | 0.527 | 0.528 | 0.525 | 0.078 | 0.200 | 9.324 | 0.424 | 0.513 |
| gbm_full | 4.656 | 0.517 | 0.494 | 0.548 | 0.517 | 0.506 | 0.059 | 0.200 | 9.735 | 0.012 | 0.519 |

Confidence intervals (week-clustered bootstrap), 2024: 

| metric | estimate | CI low | CI high |
|---|---|---|---|
| pairwise_win_rate_model | 0.5496 | 0.5250 | 0.5749 |
| pairwise_win_rate_EW_UPS_baseline | 0.5363 | 0.5000 | 0.5709 |
| pairwise_win_rate_model_minus_EW | 0.0133 | -0.0207 | 0.0508 |
| rmse_improvement_vs_league_mean_pct | 0.9455 | -0.0244 | 1.9862 |
| rmse_improvement_vs_best_simple_pct | 0.8394 | -0.3315 | 1.9249 |
| weekly_spearman_model | 0.1411 | 0.1028 | 0.1747 |

2025: 

| metric | estimate | CI low | CI high |
|---|---|---|---|
| pairwise_win_rate_model | 0.5183 | 0.4863 | 0.5553 |
| pairwise_win_rate_EW_UPS_baseline | 0.4875 | 0.4235 | 0.5367 |
| pairwise_win_rate_model_minus_EW | 0.0307 | -0.0202 | 0.0985 |
| rmse_improvement_vs_league_mean_pct | 0.1705 | -1.0644 | 1.5672 |
| rmse_improvement_vs_best_simple_pct | 0.1686 | -1.0644 | 1.5672 |
| weekly_spearman_model | 0.0527 | -0.0039 | 0.0972 |

## Is a projected one-point advantage actionable?
Win rate of the higher-projected punter by projected gap:

2024: 0-0.5 pts: 52.0% (1837 pairs), 0.5-1 pts: 51.4% (1610 pairs), 1-1.5 pts: 56.3% (1220 pairs), 1.5-2 pts: 56.5% (805 pairs), 2-3 pts: 61.2% (938 pairs), 3-99 pts: 63.2% (315 pairs).

2025: 0-0.5 pts: 49.9% (2344 pairs), 0.5-1 pts: 50.8% (1892 pairs), 1-1.5 pts: 53.8% (1250 pairs), 1.5-2 pts: 55.3% (638 pairs), 2-3 pts: 58.8% (408 pairs), 3-99 pts: 57.5% (47 pairs).

A gap under 1 point is a coin flip (50–52%). Gaps of 1.5–2 points win about 55%, 2–3 points about 59–61%, and only 3+ points reached 57–63% on small samples. A one-point projected edge should not drive a lineup change on its own.

## Verdict on decisions
The model's pairwise win-rate point estimate is above 50% in 2024 (55.0%, CI 52.5–57.5%), 2025 (51.8%, CI 48.6–55.5%, which includes 50%) and 2026 Weeks 1–7 (55.1%), but **the improvement over the weighted prior-UPS baseline is not statistically supportable** (difference +1.3 pts, CI −2.1 to +5.1 in 2024; +3.1 pts, CI −2.0 to +9.9 in 2025). Its top-pick gain over the weighted prior-UPS pick is −1.0 points per week in 2024 and +0.95 in 2025; the week-clustered intervals span zero (columns `pick_gain_ci95` in `decisions_*.csv`). It does not reliably find the week's best punter (top-3 hit 12%, random 18% in 2024 / 12% in 2025).
