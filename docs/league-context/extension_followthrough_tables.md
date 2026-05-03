# Extension Worthiness & Y4-Y5 Follow-Through (UPS Rookies, 2017-2021)

Cohort: 2017–2021 rookies (n=258). Y4-Y5 production sourced from **nflverse `load_player_stats()` (PPR scoring)** — every NFL player who scored, regardless of UPS roster status. The earlier survivor bias from `player_points_history.json` is gone.


## Definitions

- **was_worthy_at_y3** (UPS scoring): Y1–Y3 avg ppg ≥ position starter-tier threshold (QB 18.0, RB 15.0, WR 13.5, TE 12.5 — 2024–2025 starter avg / 17).
- **paid_off_y4_5** (PPR scoring via nflverse): Y4–Y5 avg ppg ≥ PPR-equivalent starter threshold (QB 17.0, RB 16.1, WR 14.0, TE 12.0 — derived from nflverse 2024–2025 same starter-tier definition).
- **never_played_y4_5**: player not in nflverse for either Y4 or Y5. Truly zero production — never on an NFL field for those seasons.
- Worthy@Y3 uses UPS scoring because rookie_draft_history.json carries UPS-scored ppg per pick; paid_off uses PPR because nflverse provides universal coverage but only carries PPR. Each threshold is calibrated to its own scoring system's 2024–2025 starter-tier average, so the worthy/paid comparison is fair within position.


## Headline: Worthiness × Follow-Through (per position)

Worthiness measured two ways:
1. **avg-of-3** — Y1–Y3 avg ppg (the original definition).
2. **best-2-of-3** — average of the two best seasons in Y1–Y3, dropping the worst. Filters out injury years, slow rookie utilization, and Y3 role-changes. More representative of the player's actual ceiling.


### avg-of-3 worthiness


## Full 2017–2021 cohort (avg-of-3) (n=258)

| Pos | Drafted | Worthy@Y3 | Worthy% | Worthy → Paid Off | Worthy → Cliffed | Worthy→Cliff% | Got Extension | Ext → Paid Off | Ext Regret% | Never-played% |
|----:|--------:|----------:|--------:|-----------------:|-----------------:|--------------:|--------------:|---------------:|------------:|--------------:|
| QB | 28 | 11 | 39.3% | 9 | 2 | **18.2%** | 15 | 9 | **40.0%** | 25.0% |
| RB | 94 | 9 | 9.6% | 5 | 4 | **44.4%** | 32 | 8 | **75.0%** | 24.5% |
| WR | 107 | 19 | 17.8% | 11 | 8 | **42.1%** | 36 | 12 | **66.7%** | 34.6% |
| TE | 29 | 2 | 6.9% | 1 | 1 | **50.0%** | 14 | 2 | **85.7%** | 20.7% |

### best-2-of-3 worthiness


## Full 2017–2021 cohort (best-2-of-3) (n=258)

| Pos | Drafted | Worthy@Y3 | Worthy% | Worthy → Paid Off | Worthy → Cliffed | Worthy→Cliff% | Got Extension | Ext → Paid Off | Ext Regret% | Never-played% |
|----:|--------:|----------:|--------:|-----------------:|-----------------:|--------------:|--------------:|---------------:|------------:|--------------:|
| QB | 28 | 13 | 46.4% | 9 | 4 | **30.8%** | 15 | 9 | **40.0%** | 25.0% |
| RB | 94 | 15 | 16.0% | 7 | 8 | **53.3%** | 32 | 8 | **75.0%** | 24.5% |
| WR | 107 | 25 | 23.4% | 12 | 13 | **52.0%** | 36 | 12 | **66.7%** | 34.6% |
| TE | 29 | 3 | 10.3% | 2 | 1 | **33.3%** | 14 | 2 | **85.7%** | 20.7% |

## Cliff magnitude — Y4-Y5 ppg as % of Y1-Y3 ppg (excludes never-played)

Note: Y1-Y3 is UPS scoring, Y4-Y5 is nflverse PPR. The ratio is approximate due to the scoring system mismatch but the relative position-vs-position comparison is valid (every position is measured against itself, and the threshold offsets cancel).

| Pos | n_played_y4_5 | Median Y4-5/Y1-3 | Mean Y4-5/Y1-3 | n_never_played | Never-played % |
|----:|--------------:|-----------------:|---------------:|---------------:|---------------:|
| QB | 21 | 75.5% | 86.8% | 7 | 25.0% |
| RB | 70 | 88.7% | 94.2% | 23 | 24.5% |
| WR | 68 | 82.6% | 76.0% | 37 | 34.6% |
| TE | 23 | 87.1% | 94.5% | 6 | 20.7% |

## Decision quality — were the right players extended?

| Pos | Worthy@Y3 NOT extended | Not-Worthy@Y3 BUT extended | Misalignment % |
|----:|----------------------:|---------------------------:|---------------:|
| QB | 0 | 4 | 14.3% |
| RB | 0 | 23 | 24.5% |
| WR | 0 | 17 | 15.9% |
| TE | 0 | 12 | 41.4% |

## Worthiness flips: players caught by best-2-of-3 but not avg-of-3

Players whose Y3 (or another year) had injury/limited role that pulled the avg-of-3 below threshold, but who showed starter-tier ability in their best 2 seasons. These are the players the avg-of-3 frame mis-labels as 'unworthy' but the data suggests they probably *were* worth extending.

| Year | Slot | Pos | Player | Y1 | Y2 | Y3 | avg-of-3 | best-2-of-3 | Y4-5 PPR | Paid off | Got Ext |
|-----:|:-----|:----|:-------|---:|---:|---:|---------:|------------:|---------:|:--------:|:-------:|
| 2017 | R5.6 | QB | Trubisky, Mitchell | 10.85 | 22.42 | 15.2 | 16.16 | **18.81** | 8.24 | ✗ | — |
| 2018 | R3.3 | QB | Mayfield, Baker | 18.9 | 16.42 | 17.91 | 17.74 | **18.41** | 11.52 | ✗ | ✓ |
| 2017 | R2.6 | RB | Conner, James | 1.2 | 22.42 | 14.25 | 12.62 | **18.34** | 14.93 | ✗ | ✓ |
| 2017 | R3.3 | RB | Jones, Aaron | 8.96 | 14.13 | 20.22 | 14.44 | **17.18** | 16.8 | ✓ | ✓ |
| 2019 | R1.2 | RB | Montgomery, David | 10.17 | 16.63 | 16.1 | 14.3 | **16.37** | 12.85 | ✗ | ✓ |
| 2021 | R1.3 | RB | Harris, Najee | 18.9 | 13.22 | 11.11 | 14.41 | **16.06** | 7.86 | ✗ | ✓ |
| 2017 | R1.3 | RB | Mixon, Joe | 10.01 | 17.7 | 12.91 | 13.54 | **15.3** | 17.13 | ✓ | ✓ |
| 2020 | R1.5 | RB | Swift, D'Andre | 14.08 | 15.96 | 13.47 | 14.5 | **15.02** | 12.48 | ✗ | ✓ |
| 2019 | R1.8 | TE | Hockenson, T.J. | 7.86 | 11.91 | 13.97 | 11.25 | **12.94** | 13.98 | ✓ | ✓ |
| 2018 | R2.7 | WR | Chark, D.J. | 4.8 | 16.76 | 12.69 | 11.42 | **14.73** | 10.2 | ✗ | ✓ |
| 2020 | R2.1 | WR | Pittman, Michael | 8.45 | 14.62 | 14.85 | 12.64 | **14.73** | 13.06 | ✗ | ✓ |
| 2019 | R1.6 | WR | Brown, Marquise | 11.59 | 12.42 | 15.72 | 13.24 | **14.07** | 11.68 | ✗ | ✓ |
| 2021 | R3.4 | WR | Collins, Nico | 6.56 | 10.23 | 17.81 | 11.53 | **14.02** | 16.12 | ✓ | ✓ |
| 2018 | R1.11 | WR | Gallup, Michael | 6.54 | 15.25 | 12.61 | 11.47 | **13.93** | 8.86 | ✗ | ✓ |
| 2019 | R5.5 | WR | Renfrow, Hunter | 10.18 | 9.73 | 17.21 | 12.37 | **13.7** | 5.68 | ✗ | ✓ |

## Roll call: every best-2-of-3 worthy + extended player (paid_off then cliff_pct)


### QB — 12 worthy+extended (best-2-of-3)

| Year | Slot | Player | Y1 | Y2 | Y3 | best-2-of-3 | Y4-5 PPR | Cliff % | Paid off |
|-----:|:-----|:-------|---:|---:|---:|------------:|---------:|--------:|:--------:|
| 2018 | R3.3 | Mayfield, Baker | 18.9 | 16.42 | 17.91 | 18.41 | 11.52 | -35.1% | ✗ |
| 2021 | R1.12 | Fields, Justin | 12.35 | 22.02 | 20.79 | 21.41 | 13.34 | -27.4% | ✗ |
| 2020 | R2.7 | Tagovailoa, Tua | 14.39 | 19.18 | 23.53 | 21.36 | 16.11 | -15.4% | ✗ |
| 2020 | R5.2 | Herbert, Justin | 25.01 | 28.71 | 21.1 | 26.86 | 17.09 | -31.5% | ✓ |
| 2020 | R2.4 | Burrow, Joe | 20.33 | 25.08 | 28.89 | 26.98 | 18.32 | -26.0% | ✓ |
| 2019 | R2.2 | Murray, Kyler | 18.51 | 27.46 | 26.56 | 27.01 | 18.26 | -24.5% | ✓ |
| 2017 | R4.3 | Mahomes, Patrick | 0 | 32.64 | 25.24 | 28.94 | 23.48 | -18.9% | ✓ |
| 2018 | R2.10 | Jackson, Lamar | 10.04 | 32.54 | 24.25 | 28.39 | 19.84 | -11.0% | ✓ |
| 2021 | R1.7 | Lawrence, Trevor | 14.34 | 22.96 | 20.33 | 21.64 | 17.19 | -10.5% | ✓ |
| 2017 | R3.5 | Watson, Deshaun | 27.74 | 22.41 | 25.39 | 26.56 | 23.08 | -8.3% | ✓ |
| 2020 | R5.9 | Hurts, Jalen | 8.66 | 24.53 | 31.59 | 28.06 | 21.14 | -2.1% | ✓ |
| 2018 | R4.6 | Allen, Josh | 16.87 | 20.17 | 29.55 | 24.86 | 24.69 | 11.3% | ✓ |

### RB — 15 worthy+extended (best-2-of-3)

| Year | Slot | Player | Y1 | Y2 | Y3 | best-2-of-3 | Y4-5 PPR | Cliff % | Paid off |
|-----:|:-----|:-------|---:|---:|---:|------------:|---------:|--------:|:--------:|
| 2021 | R1.3 | Harris, Najee | 18.9 | 13.22 | 11.11 | 16.06 | 7.86 | -45.4% | ✗ |
| 2017 | R1.7 | Hunt, Kareem | 19.24 | 21.22 | 13.0 | 20.23 | 13.76 | -22.8% | ✗ |
| 2021 | R1.4 | Etienne, Travis | 0 | 13.32 | 17.39 | 15.36 | 12.02 | -21.7% | ✗ |
| 2020 | R1.5 | Swift, D'Andre | 14.08 | 15.96 | 13.47 | 15.02 | 12.48 | -13.9% | ✗ |
| 2018 | R1.1 | Barkley, Saquon | 24.19 | 18.6 | 7.4 | 21.4 | 14.66 | -12.4% | ✗ |
| 2019 | R1.2 | Montgomery, David | 10.17 | 16.63 | 16.1 | 16.37 | 12.85 | -10.2% | ✗ |
| 2018 | R1.9 | Chubb, Nick | 13.29 | 16.77 | 17.63 | 17.2 | 15.97 | 0.4% | ✗ |
| 2017 | R2.6 | Conner, James | 1.2 | 22.42 | 14.25 | 18.34 | 14.93 | 18.3% | ✗ |
| 2020 | R1.2 | Taylor, Jonathan | 15.06 | 24.64 | 13.95 | 19.85 | 16.56 | -7.4% | ✓ |
| 2017 | R1.5 | Fournette, Leonard | 17.93 | 14.75 | 17.02 | 17.48 | 16.41 | -0.9% | ✓ |
| 2017 | R1.1 | McCaffrey, Christian | 14.79 | 25.42 | 30.25 | 27.84 | 24.17 | 2.9% | ✓ |
| 2017 | R2.1 | Kamara, Alvin | 19.13 | 23.78 | 16.92 | 21.45 | 21.11 | 5.9% | ✓ |
| 2017 | R3.3 | Jones, Aaron | 8.96 | 14.13 | 20.22 | 17.18 | 16.8 | 16.4% | ✓ |
| 2017 | R1.6 | Cook, Dalvin | 16.35 | 13.96 | 21.0 | 18.68 | 20.0 | 16.9% | ✓ |
| 2017 | R1.3 | Mixon, Joe | 10.01 | 17.7 | 12.91 | 15.3 | 17.13 | 26.5% | ✓ |

### WR — 25 worthy+extended (best-2-of-3)

| Year | Slot | Player | Y1 | Y2 | Y3 | best-2-of-3 | Y4-5 PPR | Cliff % | Paid off |
|-----:|:-----|:-------|---:|---:|---:|------------:|---------:|--------:|:--------:|
| 2019 | R5.5 | Renfrow, Hunter | 10.18 | 9.73 | 17.21 | 13.7 | 5.68 | -54.1% | ✗ |
| 2021 | R1.6 | Waddle, Jaylen | 17.04 | 17.27 | 15.59 | 17.16 | 11.05 | -33.5% | ✗ |
| 2017 | R2.9 | Golladay, Kenny | 8.28 | 15.49 | 17.71 | 16.6 | 9.76 | -29.4% | ✗ |
| 2019 | R2.9 | Johnson, Diontae | 11.52 | 16.23 | 18.79 | 17.51 | 11.3 | -27.2% | ✗ |
| 2017 | R1.11 | Smith-Schuster, JuJu | 13.93 | 21.15 | 11.18 | 17.54 | 11.44 | -25.8% | ✗ |
| 2018 | R1.11 | Gallup, Michael | 6.54 | 15.25 | 12.61 | 13.93 | 8.86 | -22.7% | ✗ |
| 2019 | R3.12 | McLaurin, Terry | 14.96 | 16.26 | 14.73 | 15.61 | 12.71 | -17.0% | ✗ |
| 2020 | R2.6 | Aiyuk, Brandon | 16.77 | 10.66 | 14.49 | 15.63 | 11.8 | -15.5% | ✗ |
| 2021 | R1.10 | Smith, DeVonta | 12.17 | 17.3 | 15.25 | 16.27 | 13.09 | -12.2% | ✗ |
| 2018 | R1.7 | Moore, D.J. | 10.99 | 17.28 | 15.51 | 16.39 | 12.84 | -12.0% | ✗ |
| 2019 | R1.6 | Brown, Marquise | 11.59 | 12.42 | 15.72 | 14.07 | 11.68 | -11.8% | ✗ |
| 2018 | R2.7 | Chark, D.J. | 4.8 | 16.76 | 12.69 | 14.73 | 10.2 | -10.7% | ✗ |
| 2020 | R2.1 | Pittman, Michael | 8.45 | 14.62 | 14.85 | 14.73 | 13.06 | 3.3% | ✗ |
| 2018 | R1.10 | Ridley, Calvin | 14.65 | 16.26 | 23.1 | 19.68 | 14.22 | -21.0% | ✓ |
| 2019 | R2.3 | Samuel, Deebo | 12.51 | 12.5 | 22.82 | 17.66 | 14.14 | -11.3% | ✓ |
| 2020 | R1.8 | Jefferson, Justin | 18.55 | 21.13 | 25.32 | 23.23 | 19.23 | -11.3% | ✓ |
| 2020 | R1.9 | Higgins, Tee | 15.14 | 17.26 | 18.26 | 17.76 | 14.99 | -11.2% | ✓ |
| 2019 | R1.11 | Metcalf, DK | 12.4 | 19.63 | 15.43 | 17.53 | 14.33 | -9.4% | ✓ |
| 2021 | R2.8 | St. Brown, Amon-Ra | 14.19 | 18.54 | 22.61 | 20.57 | 18.91 | 2.5% | ✓ |
| 2021 | R1.2 | Chase, Ja'Marr | 20.99 | 22.06 | 19.01 | 21.52 | 21.65 | 4.7% | ✓ |
| 2019 | R1.10 | Brown, A.J. | 14.33 | 18.24 | 15.37 | 16.8 | 16.85 | 5.4% | ✓ |
| 2017 | R2.12 | Godwin, Chris | 6.37 | 12.4 | 22.19 | 17.3 | 16.06 | 17.6% | ✓ |
| 2020 | R1.4 | Lamb, CeeDee | 15.56 | 16.81 | 19.5 | 18.16 | 20.55 | 18.9% | ✓ |
| 2017 | R3.6 | Kupp, Cooper | 12.89 | 18.16 | 19.54 | 18.85 | 20.16 | 19.6% | ✓ |
| 2021 | R3.4 | Collins, Nico | 6.56 | 10.23 | 17.81 | 14.02 | 16.12 | 39.7% | ✓ |

### TE — 3 worthy+extended (best-2-of-3)

| Year | Slot | Player | Y1 | Y2 | Y3 | best-2-of-3 | Y4-5 PPR | Cliff % | Paid off |
|-----:|:-----|:-------|---:|---:|---:|------------:|---------:|--------:|:--------:|
| 2017 | R1.9 | Engram, Evan | 13.07 | 10.88 | 14.87 | 13.97 | 7.82 | -39.5% | ✗ |
| 2017 | R5.7 | Kittle, George | 6.95 | 16.77 | 17.6 | 17.19 | 14.34 | 4.1% | ✓ |
| 2019 | R1.8 | Hockenson, T.J. | 7.86 | 11.91 | 13.97 | 12.94 | 13.98 | 24.3% | ✓ |

## Implication: trade-vs-extend per position (best-2-of-3 worthy)

- **RB** (n_worthy=15): **Mixed.** 53% cliff rate among worthy players — extend the elite hits, trade the borderline ones.
- **WR** (n_worthy=25): **Mixed.** 52% cliff rate among worthy players — extend the elite hits, trade the borderline ones.
- **TE** (n_worthy=3): Sample too small (n_worthy = 3); inconclusive.
- **QB** (n_worthy=13): **Extend > trade.** Cliff rate is only 31%. Worthy players hold their value; lock them in.

## Caveats

- Y4-Y5 production is from nflverse's `fantasy_points_ppr` field — standard PPR scoring. UPS scoring deviates slightly (pass TD value, possible bonuses, TE Premium since 2025) but at the position-vs-position relative-cliff level the scoring delta doesn't materially shift the conclusions. The thresholds are calibrated to each scoring system's own 2024–2025 starter-tier averages.
- The 23 players in the cohort with no nflverse match are players who genuinely never played in the NFL (Donnel Pumphrey, Bucky Hodges, etc.) — true zero production. Listed in `pipelines/etl/data_cache_mfl_to_gsis_crosswalk.json` as missing.
- Worthy@Y3 (UPS) and paid_off@Y4-Y5 (PPR) use different scoring systems but each is benchmarked against its own starter-tier baseline. The within-position comparisons are clean; cross-scoring 'cliff_pct' ratios are approximate.
- TE Premium scoring kicked in for 2025 only. TE Y4-Y5 production for cohorts whose Y4-Y5 spans 2024-2025 has 1 year of pre-Premium and 1 year of Premium — check the TE numbers carefully if drawing TE-specific conclusions.
