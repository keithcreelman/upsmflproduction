# Verifying dual-write: local SQLite + D1 stay in sync

**Status: 2 of 4 fetchers converted to dual-write.**
- ✅ `fetch_pfr_season_advstats.py` — proof-of-concept
- ✅ `fetch_pfr_advstats.py` — weekly PFR rec/rush/pass/def
- ⏳ `fetch_nflverse_pbp.py`
- ⏳ `fetch_nflverse_weekly.py`

Local SQLite remains the primary, authoritative path. D1Writer adds a parallel UPSERT to D1 in the same fetch run. After a few runs that confirm equivalence, individual fetchers can be flipped to `--skip-local` (D1-only) and eventually cut from the SQLite hop entirely.

## How to verify the proof-of-concept

On the old Mac, with `MFL_DB_PATH` already exported:

```bash
cd ~/Code/upsmflproduction && git pull

# Dual-write run — writes to BOTH local SQLite AND D1.
python3 pipelines/etl/scripts/fetch_pfr_season_advstats.py --seasons 2024-2025
```

Expected output ends with:
```
  local SQLite: upserted 8070 rows
  D1: writing 8070 rows to nfl_player_advstats_season ...
[D1Writer nfl_player_advstats_season] chunk 1: +80 (total 80)
[D1Writer nfl_player_advstats_season] chunk 2: +80 (total 160)
…
[D1Writer nfl_player_advstats_season] DONE: 8070 rows in N chunks
DONE: 8070 player-season rows across 2 seasons
```

## Equivalence check

After the fetch, compare a sample player between local + D1:

```bash
# Local
sqlite3 "$MFL_DB_PATH" "SELECT season, rec_adot, rec_yac_per_r FROM nfl_player_advstats_season WHERE gsis_id='00-0037744' ORDER BY season DESC;"

# D1
cd worker && npx wrangler d1 execute ups-mfl-db --remote \
  --command "SELECT season, rec_adot, rec_yac_per_r FROM nfl_player_advstats_season WHERE gsis_id='00-0037744' ORDER BY season DESC;"
```

Numbers should match exactly. Any drift = bug in D1Writer, file an issue.

## Failure modes + recovery

- **D1 chunk fails mid-run** — local SQLite has all rows (it ran first); fetcher exits non-zero. Re-run safely; UPSERT is idempotent.
- **Network drops during D1 write** — `wrangler_execute()` retries 4× with backoff. After exhaustion, fetcher aborts. Re-run.
- **Don't want to write to D1 today** — `--skip-d1` skips the D1Writer entirely. Acts like the legacy local-only fetcher.
- **D1-only mode (after verification)** — `--skip-local` + `--skip-d1` together would do nothing; `--skip-local` alone runs D1-only.

## Known limitations

- D1 daily write quota: 100K writes on the free tier. Single-season `fetch_pfr_season_advstats.py` run = ~1K writes (chunks × 80 rows). Fits comfortably.
- The wide-table fetchers (weekly, pbp) push more — verify daily quota headroom before converting those.
- Schema: D1 column list must already be migrated. If a fetcher adds a new column, run the migration first or D1Writer will fail.
