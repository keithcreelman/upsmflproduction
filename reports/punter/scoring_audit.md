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

| Season | Punter-games | exact_% | within_1pt_% | Mean abs diff |
|---|---|---|---|---|
| 2011 | 479 | 0.21 | 3.55 | 7.17 |
| 2012 | 479 | 89.35 | 98.12 | 0.15 |
| 2013 | 477 | 91.40 | 98.74 | 0.11 |
| 2014 | 476 | 92.44 | 98.74 | 0.07 |
| 2015 | 463 | 92.22 | 99.35 | 0.08 |
| 2016 | 464 | 91.38 | 97.63 | 0.12 |
| 2017 | 462 | 92.64 | 98.27 | 0.09 |
| 2018 | 475 | 93.26 | 99.16 | 0.07 |
| 2019 | 476 | 92.02 | 98.53 | 0.12 |
| 2020 | 469 | 93.60 | 99.15 | 0.07 |
| 2021 | 502 | 94.82 | 99.20 | 0.06 |
| 2022 | 504 | 93.85 | 99.40 | 0.07 |
| 2023 | 509 | 95.68 | 98.82 | 0.06 |
| 2024 | 501 | 95.41 | 99.00 | 0.05 |
| 2025 | 499 | 95.99 | 99.60 | 0.04 |
| 2026 | 184 | 94.57 | 98.91 | 0.06 |

All of 2012–2026 clears the gate (every season ≥ 89% exact, ≥ 97% within one point, mean absolute difference ≤ 0.15; 2012 is the weakest year). **2026 Week 7 is not in this table:** MFL had not posted Week 7 punter scores when the data was pulled (they summed to exactly 0.0), so those rows are treated as missing and Week 7 "actual" points are reconstructed from play-by-play.

### Why the remaining rows differ (all 2012–2026 rows listed in `reports/punter/scoring_audit_rows.csv`)
Audit table columns: Season | Week | Player | MFL UPS points | Reconstructed points | Difference | Reason.

| Reason (grouped) | rows |
|---|---|
| MFL scored a player with no nflverse punt (ID crosswalk gap  | 43 |
| average-yards tier boundary or blocked-punt handling differs | 318 |
| fractional | 150 |
| inside-20 count differs by 1 between nflverse and MFL's stat | 2 |

Typical causes: fractional differences are a non-punt event (a fake punt pass or rush, a tackle, fumble or return yardage) that play-by-play punt rows do not carry; ±1/±3/±5 differences are the 45/50/60 average-yards tier flipping because MFL's stat feed and nflverse differ by a yard on one punt; multiples of 4 are one inside-20 punt counted differently; and some MFL rows have no nflverse punter (ID crosswalk gap or a player with no punt).
