# Stage R2: database reads of the two added routes (local replica)

**Status: measurement record, 2026-11-20.** Covers `/api/player-status` and `/api/lineup-matchups`, the two reads Team › Roster adds (PR #1482). **No production query was run**: not a SELECT, not an EXPLAIN. Nothing here changes a worker, a table or a flag.

## Method
- The tables the routes read are rebuilt in a **local Miniflare D1** from the repository's own migrations: real column names, primary keys and indexes (`0170_player_id_map.sql`, `0082_ff_player_ids.sql`, `0081_nfl_team_pace.sql`, `0006_advanced_stats_schema.sql` for `nfl_player_weekly`).
- They are filled with **synthetic rows** at production-like sizes. Miniflare's D1 reports `meta.rows_read`, the same counter D1 bills.
- The queries are copied character for character from `worker/src/player_status.js` and `worker/src/fpa_engine.js` (`fpaLoadSeasonContext`). The script is `docs/beta2027/measure/d1_rows_read.mjs` (`node d1_rows_read.mjs '{"weeks":10}'`).
- What this measures is the **query plan and the row counts**. It does not measure real data.

## Which code path reads D1
| Route | D1 reads | Worker cache in front of them |
|---|---|---|
| `/api/player-status` | One query on **every** call: `SELECT mfl_id, gsis_id, accepted FROM player_id_map` | **None.** The response carries `Cache-Control: public, max-age=120`, which a browser honors but a Worker's response is not edge-cached by it. The beta's loader sends `cache: "no-store"`, so every ask reaches the Worker and D1. |
| `/api/lineup-matchups` | Only when **both** caches miss: the three season-context queries (`nfl_player_weekly` join `ff_player_ids`, plays by team, `nfl_team_pace`) | (1) the response, 2 to 5 minutes (Cache API, per data center); (2) the season context, **6 hours** for a live season. A response hit costs 0 D1 reads; a context hit costs 0 D1 reads and still reads MFL. |

`fpaSnaps` (the snap-count queries) is **not** on this route's path; it belongs to the Pts Agst route.

## Sizes used (and where each came from)
| Table | Rows | Source of the number |
|---|---|---|
| `player_id_map` | 2,295 (2,274 accepted) | the live `/api/player-status` answer's own `id_map_rows` and `mapped_mfl_ids` (2026-11-20), not a query |
| `ff_player_ids` | 12,500 | "all eras" count recorded in the 2026-10 D1 usage investigation |
| `nfl_player_weekly`, season 2026, Weeks 1 to 10 | 9,139 (about 914 a week) | the same investigation: 6,571 rows for about 7 weeks. Older seasons (2024, 2025) are also in the local table so the season filter has something not to read |
| `nfl_team_pace` | 32 per season | one row per team |

## Results (Week 10 of the season, as of 2026-11-20)
| Query | rows returned | `rows_read` | Plan |
|---|---|---|---|
| `player_id_map` full select | 2,295 | **2,295** | `SCAN player_id_map` |
| season context 1: players' teams by week | 5,981 | **79,668** | search `nfl_player_weekly` by primary key prefix (season, week range) then `ff_player_ids` by its `gsis_id` index, twice (once per side of the UNION) |
| season context 2: plays per team per week | 320 | **18,278** | search by primary key prefix, temp b-tree for the group |
| season context 3: pace | 32 | **32** | primary key `(season, team)` |
| **Season context, one cold load** | | **97,978** | about 10.7 reads per 2026 weekly row |

Only 2026 rows are read: the table held 42,083 rows in all, and the cold load read 97,978, in proportion to the 9,139 rows of 2026.

### Sensitivity
| Case | 2026 weekly rows | season context, cold |
|---|---|---|
| Smaller tables (800 a week, 11,000 `ff_player_ids`) | 7,724 | 82,910 |
| Base (Week 10) | 9,139 | 97,978 |
| Larger tables (1,100 a week, 14,000) | 10,541 | 112,918 |
| Week 17 | 15,530 | 162,314 |
| Week 1 | 920 | 10,376 |

**Cross-check with a production number.** The 2026-10-22 investigation measured "about 65k per cold load" when the 2026 table held about 6,571 rows. Scaling this model to that size gives 98k × 6,571 / 9,139 ≈ 70k, within 8% of the production figure.

## Cold and warm
| State | `/api/player-status` | `/api/lineup-matchups` |
|---|---|---|
| **Cold** (response cache and season-context cache both empty in that data center) | 2,295 | about **98,000** (Week 10); grows by about 10.7 per new weekly row, so about 160,000 by Week 17 |
| **Context warm, response cold** (the usual case within 6 hours) | 2,295 | **0** D1 reads (MFL reads only) |
| **Fully warm** (the same answer asked again within 2 to 5 minutes) | 2,295 (there is no cache) | **0** |

## What the beta adds, against the free plan (5M rows read a day, account-wide)
- **`/api/player-status`: 2,295 rows per ask, with no cache.** The beta asks once per visit and again only after 4.5 minutes of use (tested). At 12 owners opening it 10 times a day with one refresh each, that is about 240 asks, or about **0.55M rows a day (11%)**; at one visit a day each, about 0.05M. The current phone app and Game Day already call the same route, so this is added to their use, not instead of it.
- **`/api/lineup-matchups`: at most one cold season-context load per data center per 6 hours**, about 98k at Week 10, so a worst case of about **0.4M rows a day per data center (8%)** if the route is asked in each 6-hour window. The beta only adds cold loads in windows when nobody else asked.
- Neither number is a reason to block the preview. Both are worth a decision before the beta has many users (below).

## Differences from production (assumptions, stated)
1. **The data is synthetic.** Row counts follow the sources above; real value distributions (how many players share a team in a season, how many appear in the join) are not reproduced. The join's fan-out is one player to one `ff_player_ids` row in both.
2. **Plans.** Both are SQLite. Production D1 may plan differently if `sqlite_stat1` exists; the 2026-10 investigation found none, and this replica has none. The primary-key and index plans above would change only if statistics were added.
3. **The weekly table is narrowed** to the columns these queries touch (the real table has 100 columns, D1's cap). Width does not change `rows_read`.
4. **Counting.** Miniflare reports `rows_read` as D1 does (rows scanned, index entries included). The 8% agreement with the October production number is the check on that.
5. **Cache behavior is read from the code, not measured**: the response and season-context caches are the Cache API, which is per data center and not exercised locally. Their TTLs are the ones in the code (2 to 5 minutes, 6 hours).
6. **Table growth.** `nfl_player_weekly` grows about 914 rows a week, so the cold figure rises through the season (table above).

## Options (none is part of R2; each needs its own decision)
- **A. Do nothing.** Within the free plan at beta size.
- **B. A 120-second worker cache on `/api/player-status`** (the same Cache API pattern the matchup route uses): at most 30 D1 reads of 2,295 rows an hour, 69k an hour at worst. A worker change, so a separately approved PR.
- **C. A slim read-only schedule route** for opponent and kickoff only, so the beta does not use the heavy matchup route. A worker change.
