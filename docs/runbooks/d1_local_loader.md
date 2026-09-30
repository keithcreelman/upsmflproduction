# Local → D1 loader: refreshing the installed copy without enabling the schedule

**Status (September 29, 2026): the nightly D1 job is DISABLED and should stay
that way until Keith approves a schedule.** Do not run
`scripts/install_d1_sync_cron.sh` to "just update the files". It also writes
`~/Library/LaunchAgents/com.upsmfl.d1-sync.plist` and runs `launchctl load`,
which turns on a 03:45 nightly load.

## What is installed today

| Path | What it is | State |
|---|---|---|
| `~/Library/Scripts/upsmfl-load-local-to-d1.py` | copy of `scripts/load_local_to_d1.py` | from Sep 15; **lacks** the nflverse `ci_owned` guard and the `FIRST_POSTSEASON_WEEK` playoff-flag guard (#1162) |
| `~/Library/Scripts/upsmfl-sync-d1.sh` | copy of `scripts/sync_d1.sh` | from Sep 15 |
| `~/Library/Scripts/upsmfl-wrangler.toml` | copy of `worker/wrangler.toml` | from Sep 15 |
| `com.upsmfl.d1-sync` launchd job | the 03:45 schedule | **not installed, not loaded** |

The local source DB is the iCloud copy:
`~/Library/Mobile Documents/com~apple~CloudDocs/Desktop/MFL_Scripts/Datastorage/mfl_database.db`.
The loader's built-in default (`~/Desktop/MFL_Scripts/...`) does not exist on this
Mac, so **every run must export `MFL_DB_PATH`**.

## Refresh the installed files only (no schedule)

Run from the repo root on the merged `main`:

```bash
cp -f scripts/load_local_to_d1.py ~/Library/Scripts/upsmfl-load-local-to-d1.py && chmod +x ~/Library/Scripts/upsmfl-load-local-to-d1.py
cp -f scripts/sync_d1.sh ~/Library/Scripts/upsmfl-sync-d1.sh && chmod +x ~/Library/Scripts/upsmfl-sync-d1.sh
cp -f worker/wrangler.toml ~/Library/Scripts/upsmfl-wrangler.toml
```

Then verify:

```bash
diff scripts/load_local_to_d1.py ~/Library/Scripts/upsmfl-load-local-to-d1.py && echo "loader matches repo"
launchctl list | grep com.upsmfl.d1-sync || echo "nightly job still not loaded"
ls ~/Library/LaunchAgents/com.upsmfl.d1-sync.plist 2>/dev/null || echo "no nightly plist"
```

Check the installed copy's guards against the local DB. This is a dry run: it
counts rows locally and writes nothing to D1. A misflagged playoff week makes
it exit with `REFUSE playoff-flagged tables: ...`.

```bash
MFL_DB_PATH="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/MFL_Scripts/Datastorage/mfl_database.db" \
  python3 ~/Library/Scripts/upsmfl-load-local-to-d1.py --dry-run --only schedule,franchise_weekly_score,league_season_meta
```

Expected on September 29, 2026: `schedule: 3284 rows`,
`franchise_weekly_score: 3137 rows`, `league_season_meta: 16 rows`.

## When a schedule is approved

Only then run `scripts/install_d1_sync_cron.sh`. It copies the three files
above and loads the 03:45 job. To turn it off again:

```bash
launchctl unload ~/Library/LaunchAgents/com.upsmfl.d1-sync.plist && rm ~/Library/LaunchAgents/com.upsmfl.d1-sync.plist
```

## Keeping the guard current

`FIRST_POSTSEASON_WEEK` in `scripts/load_local_to_d1.py` covers 2010–2026. A
season missing from it makes the loader refuse the playoff-flagged tables. Add
each new season from MFL's `TYPE=playoffBrackets` export (the earliest bracket
`startWeek`), not from `lastRegularSeasonWeek`: 2010's setting says 16, but its
brackets start in Week 14.
