# Positional Scarcity & VOR — UPS 2026 Bid Sheet Input

Cohort: 2024 + 2025 NFL seasons (the SF / SF + TE Premium era; the only era that matches the 2026 lineup demand). Source: `site/reports/player_scoring/player_scoring_<season>.json`.

VOR per position = avg(top-N starter tier) − avg(replacement tier). Larger spread = more scarcity = higher per-pick valuation premium for that position.


## Per-position VOR

### RB — starter `top-24` vs replacement `25-48`

| Season | Pool | Starter avg | Replacement avg | Spread | Spread % |
|-------:|-----:|------------:|----------------:|-------:|---------:|
| 2024 | 149 | 257.5 | 134.7 | 122.8 | 91.2% |
| 2025 | 154 | 263.7 | 132.3 | 131.4 | 99.3% |
| **avg** | — | — | — | **127.1** | **95.2%** |

### WR — starter `top-36` vs replacement `37-60`

| Season | Pool | Starter avg | Replacement avg | Spread | Spread % |
|-------:|-----:|------------:|----------------:|-------:|---------:|
| 2024 | 229 | 240.8 | 154.5 | 86.4 | 55.9% |
| 2025 | 236 | 229.6 | 139.6 | 90.0 | 64.5% |
| **avg** | — | — | — | **88.2** | **60.2%** |

### TE — starter `top-12` vs replacement `13-24`

| Season | Pool | Starter avg | Replacement avg | Spread | Spread % |
|-------:|-----:|------------:|----------------:|-------:|---------:|
| 2024 | 124 | 195.4 | 122.6 | 72.9 | 59.4% |
| 2025 | 133 | 236.3 | 153.2 | 83.1 | 54.2% |
| **avg** | — | — | — | **78.0** | **56.8%** |

### QB — starter `top-24` vs replacement `25-36`

| Season | Pool | Starter avg | Replacement avg | Spread | Spread % |
|-------:|-----:|------------:|----------------:|-------:|---------:|
| 2024 | 68 | 334.3 | 151.3 | 183.0 | 120.9% |
| 2025 | 68 | 319.1 | 150.8 | 168.3 | 111.6% |
| **avg** | — | — | — | **175.7** | **116.2%** |


## Cross-position spread (sorted desc)

| Position | Avg spread | Avg spread % | Implication |
|---------:|-----------:|-------------:|:------------|
| QB | 175.7 | 116.2% | SF era — 2 starters/team makes QB depth thinner than in 1QB days |
| RB | 127.1 | 95.2% | Big drop-off after the starter tier — RB scarcity is real, premium justified |
| WR | 88.2 | 60.2% | Deeper pool — WR replacement is closer to starter tier, smaller premium |
| TE | 78.0 | 56.8% | TE Premium era only; check if the spread persists past 2025 |

## What this means for the 2026 bid sheet & rookie draft

1. **Compare the spread % column across positions.** The position with the highest spread % is the one where missing on a starter is most punishing — that position deserves a VOR premium in the bid sheet's value formula.
2. **At equal hit rates, prefer the higher-spread position.** `E[value] = P(hit) × starter_avg + (1 − P(hit)) × replacement_avg`. The starter-vs-replacement gap directly multiplies the value of a hit.
3. **Two-season sample is small.** Re-run after the 2026 season to add a third data point; 2018–2023 data lives behind the legacy `mfl_database.db` which wasn't queried here. If we want longer trend lines, the next step is to regenerate `site/reports/player_scoring/player_scoring_<year>.json` for 2018–2023.


## Caveats

- 2024 and 2025 only — TE Premium scoring kicked in for 2025, so the TE numbers shown blend 1 year of pre-Premium with 1 year of Premium. The 2025-only TE spread is the cleaner forward-looking input.
- Replacement tiers assume the listed starter counts. If lineup rules change for 2026 (extra flex, etc.), `TIERS` in this script needs an update.
- Ranks are computed within position from total_points alone — not VAM-weighted. If we want VAM-weighted rankings (which already exist in `player_scoring_<year>.json` as the `vam` and `dominance_total_vam` fields), it's a one-line swap.
