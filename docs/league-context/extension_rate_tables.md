# Extension Rate by Position × Round (UPS Rookie Draft, 2014-2022 cohort)

Cohort: rookies drafted 2014–2022 (9 seasons). `extension_worthy` = any `extension_flag=1` in contract_history snapshots in the season window [rookie_year, rookie_year+4].


## RB vs WR (production hit + extension_worthy)

| Round | RB n | RB prod_hit% | RB ext% | WR n | WR prod_hit% | WR ext% | Δ ext (RB−WR) | p (two-prop) |
|------:|-----:|-------------:|--------:|-----:|-------------:|--------:|--------------:|-------------:|
| R1 | 42 | 50.0% | 59.5% | 55 | 38.2% | 54.5% | +5.0pp | 0.624 |
| R2 | 41 | 14.6% | 31.7% | 42 | 21.4% | 33.3% | -1.6pp | 0.874 |
| R3 | 34 | 5.9% | 14.7% | 41 | 12.2% | 22.0% | -7.2pp | 0.423 |
| R4 | 31 | 3.2% | 3.2% | 28 | 0.0% | 10.7% | -7.5pp | 0.253 |
| R5 | 19 | 5.3% | 5.3% | 30 | 0.0% | 6.7% | -1.4pp | 0.842 |

## TE and QB (smaller samples; reference only)

| Position | Round | n | prod_hit% | ext_n | ext% |
|---------:|------:|--:|----------:|------:|-----:|
| TE | R1 | 7 | 57.1% | 7 | 57.1% |
| TE | R2 | 8 | 12.5% | 8 | 50.0% |
| TE | R3 | 7 | 28.6% | 7 | 57.1% |
| TE | R4 | 9 | 0.0% | 9 | 11.1% |
| TE | R5 | 16 | 6.2% | 16 | 6.2% |
| QB | R2 | 12 | 33.3% | 12 | 58.3% |
| QB | R3 | 10 | 30.0% | 10 | 30.0% |
| QB | R4 | 9 | 22.2% | 9 | 22.2% |
| QB | R5 | 15 | 26.7% | 15 | 20.0% |

## Pooled by position (all rounds R1-R3)

| Position | n | prod_hit% | ext_n | ext% |
|---------:|--:|----------:|------:|-----:|
| QB | 26 | 26.9% | 26 | 50.0% |
| RB | 117 | 24.8% | 117 | 36.8% |
| WR | 138 | 25.4% | 138 | 38.4% |
| TE | 22 | 31.8% | 22 | 54.5% |

## Caveats

- `mym_flag`, `cap_penalty_flag`, and `drop_in_season_flag` in `pipelines/reports/contract_history_*.csv` are all unpopulated as of 2026-04-28. **MYM is intentionally excluded** from this extension analysis — MYM signings are a separate decision class (cheap lotto-ticket commitments, not multi-year cap extensions) and warrant their own analysis with their own decision rules. This memo is scoped to actual extension events only.
- The 2022 cohort's extension window extends through 2026, but only 2017–2025 snapshots exist; a 2022 rookie extended in 2026 wouldn't appear yet. Effect on the headline rates is small (most extensions land at Y3 = 2024 or earlier).
- Production_hit and extension_worthy are partially correlated by definition (productive players are more likely to be extended) but not redundant — see the matrix JSON for the joint distribution.
