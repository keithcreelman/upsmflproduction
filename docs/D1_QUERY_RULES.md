# D1 query rules (UPS production)

**Why this exists.** Production D1 (`ups-mfl-db`) serves every owner, and it is metered.

**Cloudflare plans:**
- **Free plan:** 5,000,000 rows read and 100,000 rows written per day.
- **Workers Paid:** Keith upgraded on 2026-09-08 after the 2026-09-02 outage. Writes were rejected for about 9 hours when an ETL exceeded the free daily write limit.
- **The goal:** Keith wants to go back to Free (2026-10-13).

**What one day looked like (2026-10-13):**
- **954M rows read:**
  - 642M (two-thirds) from one test script's query, about 214M rows per run (fixed in #1264);
  - most of the rest from heavy testing that day.
- **510k rows written:**
  - about 90% from the nflverse stats refresh, which re-upserts unchanged rows (finished seasons, all-eras names, the full ID crosswalk) 4 times a week.

## Before you ship a query
1. **Measure it.**
   - `wrangler d1 execute ups-mfl-db --remote --json --command "<sql>"` returns `meta.rows_read`.
   - Run `EXPLAIN QUERY PLAN <sql>` and look for `SCAN` (a full table scan) where you expected `SEARCH … USING INDEX`.
   - Put the measured `rows_read` in the PR.
2. **Budget.**
   - A request path (worker route) should read thousands of rows, not hundreds of thousands.
   - **Over ~100k rows per run** needs an index, a precompute or a stored copy, plus a stated reason.
   - A daily job's whole run must fit far below the daily limits.
3. **Check the indexes:** `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='<table>'`. Adding an index is a production migration and needs Keith's go.

## Reads
- **Filter and join on indexed columns.** A JOIN on an unindexed column re-scans the other table for every row.
  - Example: `nfl_player_snaps JOIN ff_player_ids ON pfr_id`. `ff_player_ids` has no `pfr_id` index, so it read about 214M rows per run.
  - Fix: aggregate first, then join, or fetch the small sets and join in code (#1264).
- **No `OR` across columns, and no functions or `COALESCE` on an indexed column in `WHERE`.** Either forces a full scan. Example: `WHERE pfr_id = 'NA' OR pfr_id IS NULL` read all 332k rows of `nfl_player_snaps`.
- **Type affinity.** Joining TEXT to INTEGER disables the index. Cast once on the small side.
- **`ORDER BY … LIMIT` is only cheap when the index order matches.** Otherwise D1 sorts the whole table before it limits.
- **Leading index column.** `nfl_player_snaps` has `(pfr_id, season)` and no season-first index, so `WHERE season = ?` alone scans the table (about 53k rows for one season). That's acceptable in a job; avoid it on a hot path.
- **Don't recompute what can't change.** Precompute or store finished data. Examples: the leaderboard precompute (#988), frozen seasons not re-queried (#969), Pts Agst finished seasons stored once (#1258).
- **Cache per request shape**, and namespace cache keys. `caches.default` on workers.dev is shared and per data center.

## Writes
- **Every upserted row counts**, even if nothing changed. Each index entry counts too. An `INSERT … ON CONFLICT DO UPDATE` over 65k unchanged rows bills 65k or more rows written.
- **Write only changed rows.** `pipelines/etl/lib/d1_io.py` (`build_insert` / `D1Writer`) does this by default since #1267: it adds `WHERE <some value differs>` to `DO UPDATE`, built as a balanced `OR` tree so even 100-column tables fit D1's expression-depth limit of 100.
  - **Verified on a temporary D1 database (2026-10-13):** re-sending 12,719 unchanged depth-chart rows wrote **0 rows**, against 12,719 before. It read 12,719 instead.
  - **Stamp columns:** pass `change_ignore_cols` for a column stamped every run, such as `player_id_map.built_at`.
  - **Rollback switch:** `D1WRITER_ALWAYS_UPDATE=1` restores the old behavior.
  - **Other writers:** any writer that doesn't use `D1Writer` must do the same itself.
- **Don't rewrite finished seasons or whole reference tables** on a schedule. Limit refreshes to the current season and to rows that changed.
- **Bulk `--file` imports are invisible to `wrangler d1 insights`** (and therefore to `scripts/d1_usage.py`). Use `wrangler d1 info ups-mfl-db` (`rows_written_24h`) for the real total.

## Tests and scripts
- **No production D1 by default.**
  - A test or script that needs production must require an explicit opt-in (e.g. `--allow-prod-d1` or `UPS_ALLOW_PROD_D1_READS=1`).
  - Otherwise it prints `SKIPPED`, never `PASSED`.
  - Add a test proving a default run makes no `wrangler … --remote` call (see `pipelines/etl/scripts/test_asof_leakage_offline_default.py`).
- **Never glob-run `test_*.py` and assume it's offline.** It has posted to Discord before (#1233) and read production before (#1239).

## Checking usage
- `python3 scripts/d1_usage.py`: last hour, projected to a day, with the biggest readers named.
- `python3 scripts/d1_usage.py 1d`: the last day. One unusual event can dominate it.
- `npx wrangler d1 info ups-mfl-db`: `rows_read_24h` / `rows_written_24h`, including imports.
- `npx wrangler d1 insights ups-mfl-db --timePeriod 1d --sort-type sum --sort-by reads --json`: per query (excludes imports).
