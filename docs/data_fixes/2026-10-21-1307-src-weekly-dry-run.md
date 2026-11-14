# #1307 dry run: src_weekly playoff weeks, free agents and ownership (2026-10-21)

**Class:** data discrepancy, DRY RUN. **Nothing was written** to production D1, MFL or Discord, and no worker route was called (`/admin/backfill-playoff-weekly` included). A write needs Keith's separate approval.

Machine-readable record: [`2026-10-21-1307-src-weekly-dry-run.summary.json`](2026-10-21-1307-src-weekly-dry-run.summary.json). Script: `pipelines/etl/scripts/dryrun_1307_src_weekly_backfill.py`.

## Plain English
- Every earlier-season **Pts Rk / PPG Rk** on the Front Office player panel can come back. Today the panel hides most of them because the weekly table is missing playoff weeks (2011–2020) and free agents' playoff weeks (2021–2025). After the repair, the weekly totals equal the rank table for **24,742 of 24,765** player-seasons (2011–2025). The 23 left are 11 inflated by duplicate rows in the old rank table (2023, 2024) and 12 moved by 2025 stat corrections.
- Example: **Dak Prescott 2019** goes from 308.2 pts over 12 wks to **361.1 over 15**, the rank's own basis, so "QB 2" (PPG "QB 5") can show.
- Who started or sat a player is taken from MFL's lineup records only. Where MFL can't prove ownership (most non-lineup players in 2011–2017, plus teams that submitted no lineup), the row gets its score and **no status**. Nothing is guessed.
- The write is about **226k D1 rows written**, 2.3× a Free-plan day, because every inserted row also writes 3 index entries. Spread over 5 days at ≤ 45k/day it stays inside the Free plan.

## Technical why
- **Source:** MFL `playerScores W=<n>` is the row set and score; MFL `weeklyResults W=<n> MISSING_AS_BYE=1` gives starter / bench and franchise; `rosters W=<n>` gives taxi / IR / free agent, but only in weeks where it agrees with the lineup record.
- **Transformation:** for each week, rank every player MFL scored with src_weekly's own rule. I **reproduced that rule on all 20,260 sampled D1 rows**: sequential by score, ties by numeric player id. Each row takes its season's `pos_group` vocabulary (`CB+S` / `DT+DE` for 2011–2023, `DB` / `DL` for 2024+) and the franchise name src_weekly already uses that season.
- **Storage:** changed-only upserts built with `lib/d1_io.build_insert`, the same statements D1Writer sends. Rollback deletes the inserted keys and restores updated cells, and only where they still hold the values the repair wrote.
- **API / UI:** `/api/player-bundle` reads `src_weekly` totals plus `src_pointssummary` ranks. #1353 shows a rank only when the two agree, and a PPG rank only with at least half the season's weeks.
- **Why this design:** it recomputes nothing on the read path and changes no reader. It fixes only the missing facts and leaves every unknown NULL.

## What was checked (sources and timestamps)
- **MFL:** 640 public export replies, fetched 2026-10-21 11:40–12:43 UTC (throttled, 0 rate-limit errors). They are cached locally and not committed.
- **Production D1, READ only:** **52,142 rows read** (budget 80,000) between 11:40 and 11:50 UTC. Every query was `EXPLAIN`ed first and SEARCHed an index. It covered: the playoff weeks of 2011–2025, 18 sample regular weeks, `src_pointssummary` 2010–2025, `src_franchises` team names (no owner names), and the two representative players.
- **Regular-season rows are not read from D1.** The archive `data/db-archives/mfl_database_2026-06-05.db.gz` stands in for them. It equals D1 on all 18 sampled weeks, every column (20,260 rows; the build refuses to run otherwise), and equals MFL's scores on every regular week 2011–2025 (0 missing, 0 extra, 0 differences).
- `wrangler d1 info` at 11:54 UTC: rows_read_24h **3,622,401**, rows_written_24h **39,502**.

## Corrections to the starting facts
- 2012–2019 rows hold `roster_franchise_id='FA'`, `roster_franchise_name='Free Agent'`, not NULL.
- **2011 is only partly attributed**: Wk 1 has 113 starters out of about 180. In 233 attributed 2011 rows the **franchise is wrong**: the legacy loader took it from MFL's retroactive rosters export, so it disagrees with MFL's lineup record.
- **MFL's `rosters&W=` export is retroactive for 2011–2017** (and 7 of 13 weeks in 2018). It shows a later owner: player 6997 is in franchise 0001's lineups in Wks 1–11, but the export puts him on 0006 all season. It agrees with the lineups 100% from late 2018 on. So "free agent", "taxi" and "IR" can be proven only in weeks where the export matches the lineup record.
- The old admin route ranked 2021–25 playoff rows 1,2,2,4, which disagrees with the rest of the table. Phase C fixes 3,063 of those rows.
- **`src_pointssummary` (the rank source).** Its totals are exact all-weeks sums of the legacy weekly table (weeks 1 to the last UPS week, playoffs included), and its ranks are DENSE ranks on the **unrounded** float. Float noise therefore decides ties. On clean 4-dp values, 20% of stored Pts ranks move 1–8 places. That is a separate follow-up, not part of this write.
- The write is **226k rows**, not about 50k: each insert bills 4 rows (table + PK index + 2 secondary indexes), measured.
- `docs/league_context_v1.md:1613` says "2012 had 4 playoff weeks". MFL says 13 regular weeks (fixed in #1162), so that canon line is stale. It was not edited here.

## 1. Rows proposed, by season, week and source
| Season | Phase | Wks | Insert | Started | Bench | Taxi | IR | FA | Not recorded (NULL) | D1 rows written |
|---|---|---|---|---|---|---|---|---|---|---|
| 2011 | A | 14–15–16 | 3,496 | 432 | 216 | 0 | 0 | 0 | 2,848 | 13,984 |
| 2012 | A | 14–15–16 | 3,445 | 487 | 304 | 0 | 0 | 0 | 2,654 | 13,780 |
| 2013 | A | 14–15–16 | 3,461 | 431 | 274 | 25 | 0 | 854 | 1,877 | 13,844 |
| 2014 | A | 14–15–16 | 3,466 | 499 | 326 | 24 | 1 | 850 | 1,766 | 13,864 |
| 2015 | A | 14–15–16 | 3,469 | 518 | 272 | 25 | 0 | 863 | 1,791 | 13,876 |
| 2016 | A | 14–15–16 | 3,473 | 504 | 286 | 35 | 0 | 850 | 1,798 | 13,892 |
| 2017 | A | 14–15–16 | 3,466 | 508 | 284 | 32 | 0 | 840 | 1,802 | 13,864 |
| 2018 | A | 14–15–16 | 3,490 | 605 | 354 | 116 | 1 | 2,414 | 0 | 13,960 |
| 2019 | A | 14–15–16 | 3,529 | 607 | 339 | 120 | 1 | 2,462 | 0 | 14,116 |
| 2020 | A | 14–15–16 | 3,605 | 573 | 351 | 148 | 2 | 2,480 | 51 | 14,420 |
| 2021 | B | 15–16–17 | 2,749 | 0 | 0 | 164 | 8 | 2,553 | 24 | 10,996 |
| 2022 | B | 15–16–17 | 2,613 | 0 | 0 | 154 | 0 | 2,459 | 0 | 10,452 |
| 2023 | B | 15–16–17 | 2,694 | 0 | 0 | 179 | 3 | 2,512 | 0 | 10,776 |
| 2024 | B | 15–16–17 | 2,672 | 0 | 0 | 171 | 3 | 2,498 | 0 | 10,688 |
| 2025 | B | 15–16–17 | 2,664 | 0 | 0 | 166 | 1 | 2,497 | 0 | 10,656 |

- **Phase A, 34,900 inserts:** started / bench from the MFL lineup record; taxi / IR / FA from a weekly-consistent rosters export. The 14,587 "not recorded" rows have status NULL, and a franchise only where a consistent export proves it.
- **Phase B, 13,392 inserts.** All scores come from `playerScores`.
- **Phase C, 3,063 updates** to existing 2021–25 playoff rows: `overall_rank` 3,058, `pos_rank` 1,613, `pos_group` filled 15. No score or status changes; MFL's 2025 Wk 17 corrections are already in D1.
- **Phase E (optional), 29,913 updates** to 2011–2019 regular-season rows, on positive evidence only: fa→starter 19,199, fa→bench 10,481, plus 233 franchise corrections in 2011.
  - Calibration: on 2020, which is already attributed, the same rules reproduce **all 14,456 rows** (0 changes).
  - Rows MFL can't prove stay as they are: 3,367 roster-but-not-in-lineup and 2,597 unproven taxi / IR.
- Per-week detail is in the appendix.

## 2. Before / after for representative players
Columns: D1 today → after the repair → the rank's own basis (pts / MFL wks).
| Player | Season | D1 today | After | Rank basis | Pts Rk / PPG Rk |
|---|---|---|---|---|---|
| Dak Prescott 12620 | 2016 | 267.4 / 12 | 321.4 / 15 | 321.4 / 15 | 6 / 9 (hidden → shown) |
| | 2017 | 209.0 / 12 | 256.1 / 15 | 256.1 / 15 | 14 / 16 (hidden → shown) |
| | 2018 | 203.9 / 12 | 258.5 / 15 | 258.5 / 15 | 15 / 23 (hidden → shown) |
| | **2019** | **308.2 / 12** | **361.1 / 15** | **361.1 / 15** | **2 / 5 (hidden → shown)** |
| | 2024 | 151.2 / 8 | 151.2 / 8 | 245.7 / 14 | stays hidden: legacy rank table has Wks 1–2 four times |
| | 2020–23, 2025 | unchanged | unchanged | equal | already shown |
| Jacoby Brissett 12616 | 2017 | 142.5 / 12 | 180.1 / 15 | 180.1 / 15 | 25 / 33 (hidden → shown) |
| | 2019 | 190.6 / 11 | 237.5 / 14 | 237.5 / 14 | 18 / 20 (hidden → shown) |
| | 2020 | 18.7 / 7 | 18.8 / 10 | 18.8 / 10 | 48 / 61 (hidden → shown) |
| | 2021 | 84.4 / 8 | 84.8 / 11 | 84.8 / 11 | 38 / 51 (hidden → shown) |
| | 2022 | 208.7 / 13 | 209.6 / 15 | 209.6 / 15 | 22 / 33 (hidden → shown) |
| | 2024 | 42.6 / 7 | 42.5 / 8 | 42.5 / 8 | 46 / 50 (hidden → shown) |

- Every "after" value equals MFL's own season total (`W=YTD`).
- The before-state totals rebuilt from the archive match D1's actual rows for both players.

## 3. Unresolved discrepancies (never inferred)
| What | Rows | Default in this plan |
|---|---|---|
| A: not in any lineup, and the week's rosters export is retroactive (2011–2017) | 13,717 | score written, status / franchise NULL |
| A: franchise submitted no lineup (mostly final weeks, e.g. 2013 Wk 16: 4 teams) | 379 | score written, status NULL, franchise if proven |
| A: rosters export lists the player on a team whose lineup omits him | 124 | score written, status / franchise NULL |
| A: taxi / IR on a retroactive export | 367 | score written, status / franchise NULL |
| B: franchise submitted no lineup (2021 Wk 17, one team) | 24 | score written, status NULL, franchise set |
| E: rostered on the export but not in the lineup | 3,367 | left as `fa` |
| E: taxi / IR on a retroactive export | 2,597 | left as `fa` |
| D1 2021–25 playoff rows with a NULL score (lineup players MFL did not score) | 553 | kept as they are |
| `src_pointssummary` inflated by duplicate legacy rows (2010, 2023, 2024) | 27 player-seasons | ranks stay hidden for 11 of them in 2011–2025 |
| `src_pointssummary` vs MFL stat corrections (2025) | 12 player-seasons | ranks stay hidden |
| `win_chunks` for new rows | all 48,292 | NULL: there is no MFL source. The archive holds legacy values for 472 of them (not used) |
| `pos_rank` vs the archive's copy, 2025 Wks 15–17 | 1,285 | follows MFL's season `pos_group`; 11 players changed position mid-season |

- **Legacy convention, for the decision below:** the old table labeled players on a no-lineup team `nonstarter` (75 such playoff rows in the archive).

## 4. D1 cost (index entries included)
- **This dry run:** 52,142 production rows read, 0 written.
- **The write, measured on a local Miniflare D1** with production's exact `src_weekly` schema and 3 indexes:

| Phase | Rows written | Rows read |
|---|---|---|
| A (inserts × 4) | 139,600 | 0 |
| B (inserts × 4) | 53,568 | 0 |
| C (updates × 1) | 3,063 | 3,063 |
| E optional (updates × 1) | 29,913 | 29,913 |
| **Total** | **226,144** | **32,976** |

- **Pre-write checks an approved run must add:** about 5.3k reads to re-read the 2021–25 playoff weeks and confirm the fingerprint, about 10 reads to confirm the 2011–2020 playoff weeks are still empty, and about 30k keyed reads to capture phase E's before-image. That is about 70k reads in total, spread over the days.
- **Daily plan at ≤ 45k rows written per day** (baseline is about 40k a day, so each day stays under 100k):
  - Day 1: B+C 2025, 2024, 2023 = 33,985
  - Day 2: B+C 2022, 2021 + A 2020 = 37,066
  - Day 3: A 2019, 2018, 2017 = 41,940
  - Day 4: A 2016, 2015, 2014 = 41,632
  - Day 5: A 2013, 2012, 2011 = 41,608
  - Day 6 (only if approved): E = 29,913
- **Not part of this write:**
  - Rebuilding `player_season_wc_rank` rewrites that whole table and reads all of `src_weekly`. It would also see 5,052 new playoff starters and 19,199 phase-E starters with NULL `win_chunks`, which lowers WC-per-game ranks.
  - Future full-season scans of `src_weekly` read about 16% more rows.

## 5. Idempotency and rollback (LOCAL copies only)
Both checks ran against copies built from the D1 snapshot.
- **SQLite:** before 35,204 rows (`6de1da9f…`) → forward → 83,496 rows (`cafb5231…`). Every touched row equals the proposal. A re-run changes 0 rows, with an identical hash. Rollback restores the exact before hash.
- **Miniflare D1:** forward writes 226,144 rows. A re-run writes **0**. Rollback writes 81,268 rows and restores the **identical** before hash.
- Each phase file carries a fingerprint (in the summary JSON). An approved run must rebuild from fresh MFL replies, match those fingerprints, and refuse if a target key changed since this dry run.
- D1 Time Travel is the backstop, but it restores the whole database, so the targeted rollback comes first.

## 6. Player-card fields and rankings restored
- **Front Office player panel (#1353), earlier seasons 2011–2025:**
  - Rows whose total equals the rank basis: 6,233 today → **24,742 after** (of 24,765).
  - PPG Rk shown (with at least half the weeks): 2,709 → **18,067**.
  - The season row's Pts / MFL wks / PPG become MFL's real totals.
  - The Game Log gains every playoff week, with Pos Rk, and status / team where MFL proves it.
- **Caveat:** 7,043 of those restored ranks differ from a clean recompute, mostly by 1–8 places: 5,611 from float-noise ties in every season, and 1,432 from duplicate rows and corrections in 2023–25. They are the ranks the table holds today. Fixing them is a separate `src_pointssummary` rebuild.
- **Desktop Stats:** MFL Pts / PPG and Consistency (Floor, Ceil, Boom%, Bust%, Trend) for any view that includes UPS playoff weeks (the #1307 readers).
- **Proposed all-time positional season rank:**
  - Definition: completed seasons 2011–2025; PPG over every UPS week; eligible with at least 75% of the season's weeks (12 of 16, 13 of 17); top 100 shown.
  - It can be computed only after phases A + B, because before the repair 2011–2020 lack 3 weeks each.
  - Examples: Dak 2021 is QB #42 (25.63 PPG) and 2019 is #71; Brissett 2025 is QB #161.
  - **Caveat:** these are as-scored points, so scoring eras differ. Example: 2011 punters (pre-2012 punter overhaul) fill the PN top 3.

## Decision needed
**One decision now:** approve phases **A + B + C** with the default policy (score always; status / franchise only where MFL proves it, otherwise NULL), written over 5 days at ≤ 45k rows/day. Recommended.

Later decisions, one at a time, after that:
1. Phase E (2011–2019 status).
2. Adopt the legacy rule that no-lineup players are `nonstarter`.
3. `win_chunks` for new rows.
4. Rebuild `src_pointssummary` ranks (duplicates + float-noise ties).
5. Rebuild `player_season_wc_rank`.
6. The all-time rank definition.

## Reproduce
```
python3 pipelines/etl/scripts/dryrun_1307_src_weekly_backfill.py fetch-mfl --cache <cache>
python3 pipelines/etl/scripts/dryrun_1307_src_weekly_backfill.py extract-d1 --out <d1> --allow-prod-d1   # production READ, budget-guarded
gunzip -k data/db-archives/mfl_database_2026-06-05.db.gz
python3 pipelines/etl/scripts/dryrun_1307_src_weekly_backfill.py build --cache <cache> --d1 <d1> --archive <db> --out <out> [--unproven null|hold|sync]
python3 pipelines/etl/scripts/dryrun_1307_src_weekly_backfill.py local-proof --out <out>
node pipelines/etl/scripts/dryrun_1307_measure_local_d1.mjs --out <out>
python3 pipelines/etl/scripts/dryrun_1307_src_weekly_backfill.py report --out <out>
```

## Not verified
- Production D1's rows_written for the write itself: it was measured on a local D1 only, never on production.
- Regular-season D1 rows outside the 18 sampled weeks: they are compared through the archive copy.
- 2021–2025 regular-season statuses: they were not re-derived.
- Authenticated #1353 panel behavior after the repair (no write, no preview).

## Appendix: generated tables
#### Rows proposed (inserts), by season and week

| Season | Wk | Phase | MFL scored | In D1 now | Insert | Started | Bench | Taxi | IR | FA | Not recorded | Rosters export = lineups |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2011 | 14 | A | 1173 | 0 | 1173 | 152 | 77 | 0 | 0 | 0 | 944 | **no** |
| 2011 | 15 | A | 1167 | 0 | 1167 | 168 | 83 | 0 | 0 | 0 | 916 | **no** |
| 2011 | 16 | A | 1156 | 0 | 1156 | 112 | 56 | 0 | 0 | 0 | 988 | **no** |
| 2012 | 14 | A | 1152 | 0 | 1152 | 167 | 107 | 0 | 0 | 0 | 878 | **no** |
| 2012 | 15 | A | 1147 | 0 | 1147 | 167 | 103 | 0 | 0 | 0 | 877 | **no** |
| 2012 | 16 | A | 1146 | 0 | 1146 | 153 | 94 | 0 | 0 | 0 | 899 | **no** |
| 2013 | 14 | A | 1158 | 0 | 1158 | 154 | 102 | 0 | 0 | 0 | 902 | **no** |
| 2013 | 15 | A | 1154 | 0 | 1154 | 166 | 104 | 0 | 0 | 0 | 884 | **no** |
| 2013 | 16 | A | 1149 | 0 | 1149 | 111 | 68 | 25 | 0 | 854 | 91 | yes |
| 2014 | 14 | A | 1165 | 0 | 1165 | 166 | 114 | 0 | 0 | 0 | 885 | **no** |
| 2014 | 15 | A | 1153 | 0 | 1153 | 166 | 106 | 0 | 0 | 0 | 881 | **no** |
| 2014 | 16 | A | 1148 | 0 | 1148 | 167 | 106 | 24 | 1 | 850 | 0 | yes |
| 2015 | 14 | A | 1158 | 0 | 1158 | 179 | 95 | 0 | 0 | 0 | 884 | **no** |
| 2015 | 15 | A | 1159 | 0 | 1159 | 177 | 100 | 0 | 0 | 0 | 882 | **no** |
| 2015 | 16 | A | 1152 | 0 | 1152 | 162 | 77 | 25 | 0 | 863 | 25 | yes |
| 2016 | 14 | A | 1160 | 0 | 1160 | 179 | 102 | 0 | 0 | 0 | 879 | **no** |
| 2016 | 15 | A | 1157 | 0 | 1157 | 177 | 101 | 0 | 0 | 0 | 879 | **no** |
| 2016 | 16 | A | 1156 | 0 | 1156 | 148 | 83 | 35 | 0 | 850 | 40 | yes |
| 2017 | 14 | A | 1159 | 0 | 1159 | 178 | 102 | 0 | 0 | 0 | 879 | **no** |
| 2017 | 15 | A | 1158 | 0 | 1158 | 180 | 98 | 0 | 0 | 0 | 880 | **no** |
| 2017 | 16 | A | 1149 | 0 | 1149 | 150 | 84 | 32 | 0 | 840 | 43 | yes |
| 2018 | 14 | A | 1171 | 0 | 1171 | 203 | 125 | 40 | 0 | 803 | 0 | yes |
| 2018 | 15 | A | 1158 | 0 | 1158 | 202 | 118 | 39 | 0 | 799 | 0 | yes |
| 2018 | 16 | A | 1161 | 0 | 1161 | 200 | 111 | 37 | 1 | 812 | 0 | yes |
| 2019 | 14 | A | 1174 | 0 | 1174 | 204 | 116 | 42 | 0 | 812 | 0 | yes |
| 2019 | 15 | A | 1178 | 0 | 1178 | 203 | 109 | 38 | 0 | 828 | 0 | yes |
| 2019 | 16 | A | 1177 | 0 | 1177 | 200 | 114 | 40 | 1 | 822 | 0 | yes |
| 2020 | 14 | A | 1198 | 0 | 1198 | 202 | 131 | 52 | 1 | 812 | 0 | yes |
| 2020 | 15 | A | 1198 | 0 | 1198 | 203 | 126 | 49 | 0 | 820 | 0 | yes |
| 2020 | 16 | A | 1209 | 0 | 1209 | 168 | 94 | 47 | 1 | 848 | 51 | yes |
| 2021 | 15 | B | 1220 | 351 | 910 | 0 | 0 | 58 | 3 | 849 | 0 | yes |
| 2021 | 16 | B | 1219 | 353 | 911 | 0 | 0 | 51 | 3 | 857 | 0 | yes |
| 2021 | 17 | B | 1213 | 327 | 928 | 0 | 0 | 55 | 2 | 847 | 24 | yes |
| 2022 | 15 | B | 1204 | 356 | 888 | 0 | 0 | 50 | 0 | 838 | 0 | yes |
| 2022 | 16 | B | 1212 | 352 | 891 | 0 | 0 | 51 | 0 | 840 | 0 | yes |
| 2022 | 17 | B | 1133 | 351 | 834 | 0 | 0 | 53 | 0 | 781 | 0 | yes |
| 2023 | 15 | B | 1221 | 357 | 892 | 0 | 0 | 59 | 0 | 833 | 0 | yes |
| 2023 | 16 | B | 1215 | 354 | 901 | 0 | 0 | 59 | 3 | 839 | 0 | yes |
| 2023 | 17 | B | 1215 | 358 | 901 | 0 | 0 | 61 | 0 | 840 | 0 | yes |
| 2024 | 15 | B | 1216 | 353 | 883 | 0 | 0 | 56 | 0 | 827 | 0 | yes |
| 2024 | 16 | B | 1206 | 356 | 888 | 0 | 0 | 56 | 1 | 831 | 0 | yes |
| 2024 | 17 | B | 1220 | 352 | 901 | 0 | 0 | 59 | 2 | 840 | 0 | yes |
| 2025 | 15 | B | 1208 | 359 | 879 | 0 | 0 | 53 | 0 | 826 | 0 | yes |
| 2025 | 16 | B | 1216 | 357 | 888 | 0 | 0 | 58 | 1 | 829 | 0 | yes |
| 2025 | 17 | B | 1212 | 355 | 897 | 0 | 0 | 55 | 0 | 842 | 0 | yes |

Totals: phase A 34,900 rows, phase B 13,392 rows.

#### Phase C updates: 3,063 rows

| Season | Rows |
|---|---|
| 2021 | 586 |
| 2022 | 612 |
| 2023 | 620 |
| 2024 | 615 |
| 2025 | 630 |

Columns changed: overall_rank 3,058, pos_group 15, pos_rank 1,613

#### Phase E updates: 29,913 rows

| Season | Rows |
|---|---|
| 2011 | 944 |
| 2012 | 3413 |
| 2013 | 3346 |
| 2014 | 3346 |
| 2015 | 3364 |
| 2016 | 3390 |
| 2017 | 3426 |
| 2018 | 4163 |
| 2019 | 4521 |

Columns changed: roster_franchise_id 29,913, roster_franchise_name 29,913, status 29,680

Status changes: fa->nonstarter 10,481, fa->starter 19,199

#### Dak Prescott (12620)

| Season | D1 today pts / wks | After pts / wks | Rank basis pts / wks | Pts Rk | PPG Rk | Recomputed (Pts, PPG) | MFL YTD |
|---|---|---|---|---|---|---|---|
| 2016 | 267.4 / 12 | 321.4 / 15 | 321.4 / 15 | 6 | 9 | [6, 9] | 321.4 |
| 2017 | 209.0 / 12 | 256.1 / 15 | 256.1 / 15 | 14 | 16 | [14, 16] | 256.1 |
| 2018 | 203.9 / 12 | 258.5 / 15 | 258.5 / 15 | 15 | 23 | [15, 23] | 258.5 |
| 2019 | 308.2 / 12 | 361.1 / 15 | 361.1 / 15 | 2 | 5 | [2, 5] | 361.1 |
| 2020 | 152.2 / 5 | 152.2 / 5 | 152.2 / 5 | 29 | 1 | [29, 1] | 152.2 |
| 2021 | 384.5 / 15 | 384.5 / 15 | 384.5 / 15 | 8 | 8 | [8, 8] | 384.5 |
| 2022 | 246.9 / 11 | 246.9 / 11 | 246.9 / 11 | 17 | 9 | [17, 9] | 246.9 |
| 2023 | 404.7 / 16 | 404.7 / 16 | 404.7 / 16 | 3 | 5 | [3, 5] | 404.7 |
| 2024 | 151.2 / 8 | 151.2 / 8 | 245.7 / 14 | 20 | 22 | [30, 18] | 151.2 |
| 2025 | 409.3 / 16 | 409.3 / 16 | 409.3 / 16 | 4 | 5 | [4, 5] | 409.3 |

#### Jacoby Brissett (12616)

| Season | D1 today pts / wks | After pts / wks | Rank basis pts / wks | Pts Rk | PPG Rk | Recomputed (Pts, PPG) | MFL YTD |
|---|---|---|---|---|---|---|---|
| 2016 | 23.7 / 3 | 23.7 / 3 | 23.7 / 3 | 44 | 44 | [44, 44] | 23.7 |
| 2017 | 142.5 / 12 | 180.1 / 15 | 180.1 / 15 | 25 | 33 | [25, 33] | 180.1 |
| 2018 | -0.6 / 4 | -0.6 / 4 | -0.6 / 4 | 62 | 63 | [62, 63] | -0.6 |
| 2019 | 190.6 / 11 | 237.5 / 14 | 237.5 / 14 | 18 | 20 | [18, 20] | 237.5 |
| 2020 | 18.7 / 7 | 18.8 / 10 | 18.8 / 10 | 48 | 61 | [48, 61] | 18.8 |
| 2021 | 84.4 / 8 | 84.8 / 11 | 84.8 / 11 | 38 | 51 | [38, 51] | 84.8 |
| 2022 | 208.7 / 13 | 209.6 / 15 | 209.6 / 15 | 22 | 33 | [22, 33] | 209.6 |
| 2023 | 30.9 / 3 | 30.9 / 3 | 30.9 / 3 | 49 | 43 | [49, 43] | 30.9 |
| 2024 | 42.6 / 7 | 42.5 / 8 | 42.5 / 8 | 46 | 50 | [46, 50] | 42.5 |
| 2025 | 259.9 / 13 | 259.9 / 13 | 259.9 / 13 | 17 | 17 | [17, 17] | 259.9 |

#### Earlier-season ranks the player card can show (totals agree)

| Season | Ranked rows | Pts Rk shown today | Pts Rk shown after | PPG Rk today | PPG Rk after | Still hidden: dup rows | Still hidden: MFL total differs | Still hidden: other | Shown but stale rank |
|---|---|---|---|---|---|---|---|---|---|
| 2011 | 1547 | 259 | 1547 | 72 | 1202 | 0 | 0 | 0 | 270 |
| 2012 | 1537 | 258 | 1537 | 84 | 1183 | 0 | 0 | 0 | 386 |
| 2013 | 1532 | 260 | 1532 | 58 | 1180 | 0 | 0 | 0 | 306 |
| 2014 | 1564 | 275 | 1564 | 78 | 1187 | 0 | 0 | 0 | 375 |
| 2015 | 1571 | 277 | 1571 | 89 | 1213 | 0 | 0 | 0 | 276 |
| 2016 | 1580 | 278 | 1580 | 85 | 1206 | 0 | 0 | 0 | 222 |
| 2017 | 1575 | 282 | 1575 | 79 | 1184 | 0 | 0 | 0 | 142 |
| 2018 | 1611 | 311 | 1611 | 68 | 1183 | 0 | 0 | 0 | 417 |
| 2019 | 1650 | 323 | 1650 | 94 | 1206 | 0 | 0 | 0 | 610 |
| 2020 | 1744 | 343 | 1744 | 86 | 1250 | 0 | 0 | 0 | 542 |
| 2021 | 1868 | 637 | 1868 | 353 | 1222 | 0 | 0 | 0 | 587 |
| 2022 | 1743 | 692 | 1743 | 388 | 1212 | 0 | 0 | 0 | 645 |
| 2023 | 1743 | 675 | 1739 | 393 | 1225 | 4 | 0 | 0 | 458 |
| 2024 | 1758 | 692 | 1751 | 398 | 1211 | 7 | 0 | 0 | 1134 |
| 2025 | 1742 | 671 | 1730 | 384 | 1203 | 0 | 12 | 0 | 673 |

#### Unresolved (never inferred)

| Phase and class | Rows |
|---|---|
| A unproven_fa_rosters_export_not_weekly | 13717 |
| A unproven_ir_rosters_export_not_weekly | 4 |
| A unproven_taxi_rosters_export_not_weekly | 363 |
| A unresolved_no_lineup | 379 |
| A unresolved_roster_not_in_lineup | 124 |
| B unresolved_no_lineup | 24 |
| E unproven_ir_rosters_export_not_weekly | 23 |
| E unproven_taxi_rosters_export_not_weekly | 2574 |
| E unresolved_roster_not_in_lineup | 3367 |

#### MFL season totals (W=YTD) vs the per-week sum

| Season | Match | Differ | YTD only | Weekly only | After = YTD | After != YTD |
|---|---|---|---|---|---|---|
| 2011 | 1547 | 0 | 0 | 0 | 1547 | 0 |
| 2012 | 1537 | 0 | 0 | 0 | 1537 | 0 |
| 2013 | 1532 | 0 | 0 | 0 | 1532 | 0 |
| 2014 | 1564 | 0 | 0 | 0 | 1564 | 0 |
| 2015 | 1571 | 0 | 0 | 0 | 1571 | 0 |
| 2016 | 1580 | 0 | 0 | 0 | 1580 | 0 |
| 2017 | 1575 | 0 | 0 | 0 | 1575 | 0 |
| 2018 | 1611 | 0 | 0 | 0 | 1611 | 0 |
| 2019 | 1650 | 0 | 0 | 0 | 1650 | 0 |
| 2020 | 1744 | 0 | 0 | 0 | 1744 | 0 |
| 2021 | 1868 | 0 | 0 | 0 | 1868 | 0 |
| 2022 | 1743 | 0 | 0 | 0 | 1743 | 0 |
| 2023 | 1743 | 0 | 0 | 0 | 1743 | 0 |
| 2024 | 1758 | 0 | 0 | 0 | 1758 | 0 |
| 2025 | 1746 | 0 | 0 | 0 | 1746 | 0 |

#### D1 cost, measured on a local Miniflare D1 (index entries included)

| Phase file | Statements | Rows written | Rows read | Re-run written | Rollback written |
|---|---|---|---|---|---|
| A_2011 | 44 | 13984 | 0 | 0 | 3496 |
| A_2012 | 44 | 13780 | 0 | 0 | 3445 |
| A_2013 | 44 | 13844 | 0 | 0 | 3461 |
| A_2014 | 44 | 13864 | 0 | 0 | 3466 |
| A_2015 | 44 | 13876 | 0 | 0 | 3469 |
| A_2016 | 44 | 13892 | 0 | 0 | 3473 |
| A_2017 | 44 | 13864 | 0 | 0 | 3466 |
| A_2018 | 44 | 13960 | 0 | 0 | 3490 |
| A_2019 | 45 | 14116 | 0 | 0 | 3529 |
| A_2020 | 46 | 14420 | 0 | 0 | 3605 |
| B_2021 | 35 | 10996 | 0 | 0 | 2749 |
| B_2022 | 33 | 10452 | 0 | 0 | 2613 |
| B_2023 | 34 | 10776 | 0 | 0 | 2694 |
| B_2024 | 34 | 10688 | 0 | 0 | 2672 |
| B_2025 | 34 | 10656 | 0 | 0 | 2664 |
| C_2021 | 586 | 586 | 586 | 0 | 586 |
| C_2022 | 612 | 612 | 612 | 0 | 612 |
| C_2023 | 620 | 620 | 620 | 0 | 620 |
| C_2024 | 615 | 615 | 615 | 0 | 615 |
| C_2025 | 630 | 630 | 630 | 0 | 630 |
| E_2011 | 944 | 944 | 944 | 0 | 944 |
| E_2012 | 3413 | 3413 | 3413 | 0 | 3413 |
| E_2013 | 3346 | 3346 | 3346 | 0 | 3346 |
| E_2014 | 3346 | 3346 | 3346 | 0 | 3346 |
| E_2015 | 3364 | 3364 | 3364 | 0 | 3364 |
| E_2016 | 3390 | 3390 | 3390 | 0 | 3390 |
| E_2017 | 3426 | 3426 | 3426 | 0 | 3426 |
| E_2018 | 4163 | 4163 | 4163 | 0 | 4163 |
| E_2019 | 4521 | 4521 | 4521 | 0 | 4521 |

Totals: {"forward_rows_written": 226144, "forward_rows_read": 32976, "rerun_rows_written": 0, "rerun_rows_read": 81268, "rollback_rows_written": 81268, "rollback_rows_read": 177849}; before/after-rollback hash equal: True


#### Proposed all-time positional season rank

completed seasons 2011-2025; PPG = all MFL points over every UPS week / weeks with a posted score; eligible when weeks scored >= ceil(0.75 x the season's UPS weeks) (12 of 16, 13 of 17); competition rank within src_weekly pos_group; top 100 shown

| Pos | Eligible | Top-100 entries that change | #1 | #2 | #3 |
|---|---|---|---|---|---|
| DB | 3335 | 100 | Winfield, Antoine 2023 13.22 | Ryan, Logan 2019 12.75 | Bates, Jessie 2023 12.71 |
| DL | 2790 | 89 | Watt, J.J. 2014 15.17 | Watt, J.J. 2012 14.53 | Garrett, Myles 2025 13.22 |
| LB | 2428 | 99 | Leonard, Shaquille 2018 14.07 | Watt, T.J. 2021 13.11 | David, Lavonte 2013 12.73 |
| PK | 424 | 92 | Zuerlein, Greg 2017 13.25 | Butker, Harrison 2017 13.12 | Myers, Jason 2025 12.94 |
| PN | 453 | 91 | Colquitt, Britton 2011 18.31 | Jones, Donnie 2011 18.26 | Ryan, Jon 2011 17.68 |
| QB | 376 | 93 | Mahomes, Patrick 2022 33.65 | Jackson, Lamar 2024 32.72 | Mahomes, Patrick 2018 32.64 |
| RB | 1346 | 98 | McCaffrey, Christian 2019 30.25 | Johnson, David 2016 26.77 | Gurley, Todd 2018 26.75 |
| TE | 1158 | 98 | McBride, Trey 2025 23.76 | Kelce, Travis 2020 22.77 | Gronkowski, Rob 2011 21.62 |
| WR | 1834 | 95 | Adams, Davante 2020 28.74 | Kupp, Cooper 2021 28.41 | Thomas, Michael 2019 27.1 |
