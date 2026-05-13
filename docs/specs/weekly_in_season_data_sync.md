# Weekly In-Season Data Sync — Spec

**Status:** Planning. Tabled post-2026-05-24 draft.
**Owner:** Keith
**Filed:** 2026-05-13

## Why this exists

Keith 2026-05-13: "We actually need all of our data updated weekly in-season."

Today only some pipelines are automated. Most run from Keith's iCloud
`MFL_Scripts/` directory by hand or on an ad-hoc basis. Result:

- `src_weekly.win_chunks` in D1 is NULL for all 90K+ rows because the
  local scoring pipeline ran but the D1 loader hasn't been re-run since
  migration `0004` added the column.
- `metadata_positionalwinprofile` (drives `src_baselines`) gets stale
  each week as new starter scores roll in.
- Roster/contract snapshots refresh daily (already cron'd) but the
  scoring + leverage tables are weekly-cadence work product.

We need a single weekly job that runs after the NFL week settles so
every D1 table reflects current reality through Tuesday morning.

## Current automation inventory (verified 2026-05-13)

### Cloudflare Worker crons (`worker/wrangler.toml`)

```toml
crons = ["5 * * * *", "*/2 * * * *", "5 0,12,18 * * *"]
```

- Hourly at :05 — scheduled D1 writes (rollups)
- Every 2 min — short polling job
- 00:05 / 12:05 / 18:05 UTC — daily refresh batches

These run **inside** the worker — they read MFL API + write to D1.
They do NOT sync from the local mfl_database.db.

### GitHub Actions workflows (`.github/workflows/`)

| File | Schedule | Purpose |
|---|---|---|
| `mfl-daily-snapshot.yml` | `5 9 * * *` (05:05 ET) | MFL roster/cap daily R2 snapshot |
| `refresh-acquisition-hub.yml` | cron | Acquisition hub JSON refresh |
| `refresh-mym-dashboard.yml` | cron | MYM dashboard refresh |
| `post-deadline-reminders.yml` | cron | Discord reminders |
| `purge-jsdelivr.yml` | on push to main | jsDelivr cache purge |

None of these run the local-DB → D1 sync.

### Local-only (no automation)

- `pipelines/etl/scripts/build_metadata_positionalwinprofile.py` —
  builds the baseline scoring percentiles per (season, pos_group).
  Reads local `mfl_database.db`, writes back to it.
- `scripts/load_local_to_d1.py` — copies local SQLite tables → D1
  (`src_weekly`, `src_baselines`, `src_pointssummary`, etc.).
- All scripts under `pipelines/etl/scripts/` that produce intermediate
  tables in the local DB (the upstream scoring engine, etc.).

The upstream scoring engine itself (the thing that POPULATES
`player_weeklyscoringresults.win_chunks`) lives outside this repo in
`/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Desktop/MFL_Scripts/`
and runs by hand.

## What "all data updated weekly" needs to cover

Every D1 table whose source lives in the local SQLite DB. Inventory
pulled from `scripts/load_local_to_d1.py`:

| D1 table | Local source | Cadence |
|---|---|---|
| `src_weekly` | `player_weeklyscoringresults` | weekly (in-season) — has `win_chunks` |
| `src_baselines` | `metadata_positionalwinprofile` | weekly (in-season) |
| `src_pointssummary` | `player_seasonscoringresults` | weekly |
| `src_contracts` | `contract_history_snapshots` | weekly + offseason events |
| `src_adddrop` | `transactions_adddrop` | weekly |
| `src_trades` | `transactions_trades` | weekly + ad-hoc |
| `src_draft_picks` | `draftresults_*` | annual (Rookie Draft) + ad-hoc |
| `player_contracts` | event-chain reconstruction | weekly post-Sun games |
| `player_contract_stints` | event-chain reconstruction | weekly post-Sun games |
| `nfl_player_weekly` | nflverse | weekly Tue/Wed (data settles) |
| `nfl_player_snaps` | nflverse | weekly Tue/Wed |
| `nfl_player_redzone` | nflverse | weekly Tue/Wed |
| `nfl_player_advstats_season` | nflverse | weekly Tue/Wed |
| `nfl_team_weekly` | nflverse | weekly Tue/Wed |
| `player_id_crosswalk` | crosswalk build | weekly |
| `metric_stickiness` | analytical compute | as needed |

## Proposed pipeline

Three options, increasing in robustness:

### Option A — Local cron on Keith's Mac (simplest, fragile)

`launchd` job that runs every Tuesday at 09:00 ET:

1. Fetch fresh MFL exports → write to local SQLite (existing fetcher scripts).
2. Run scoring pipeline (`build_metadata_positionalwinprofile.py` +
   upstream scoring engine) → updates `player_weeklyscoringresults.win_chunks`.
3. Run `scripts/load_local_to_d1.py` → push everything to D1.
4. Log to a file Keith can grep.

**Pros:** simplest, uses existing scripts unchanged, $0 cost.
**Cons:** requires Keith's Mac powered on + iCloud-synced + on network at
trigger time. Brittle. Silently misses a week if any of those break.
launchd's behavior with sleeping Macs varies by macOS version.

### Option B — GitHub Actions runner (robust, needs DB upload)

The Mac uploads `mfl_database.db` to a private bucket (R2 or S3) after
the upstream scoring engine finishes; a GH Action triggers on the
upload (or on a Tuesday cron), downloads the DB, runs
`load_local_to_d1.py` from the runner, and writes to D1 via
`wrangler d1 execute --remote`.

**Pros:** robust, observable in GH Actions UI, retriable, free for
public repos / well within the free tier for private.
**Cons:** requires the upstream scoring engine (which currently runs
locally) to publish artifacts to a bucket. Adds a dependency on the
Mac being the only thing that runs the scoring engine.

### Option C — Move scoring engine into the worker (robust + cloud-native)

The upstream scoring engine (the part that writes
`player_weeklyscoringresults`) is the only piece that has to run
locally today. If that work were re-implemented as worker code reading
MFL API + nflverse directly, every D1 table would be a worker write
and no Mac dependency would exist.

**Pros:** zero local dependencies, runs even if Keith's Mac is off,
trivial to monitor (single worker logs).
**Cons:** rewrites a significant Python codebase as JS. Substantial
effort. Defer until after-draft sprint.

## Recommendation

**Ship Option A pre-draft (May 24) as the baseline.** A `launchd`
plist + a shell wrapper that:

1. `cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/Desktop/MFL_Scripts && python3 run_weekly_scoring.py`
   (the existing thing Keith runs by hand on Tuesdays)
2. `cd /Users/keithcreelman/Code/MFL/upsmflproduction && python3 scripts/load_local_to_d1.py`
3. Log everything to `~/Library/Logs/ups-weekly-sync.log`

**Schedule Option B as the post-draft H1 priority.** Run side-by-side
with Option A for 2-3 weeks, then cut over.

**Option C only if scoring-engine maintenance becomes a pain point** —
it's a significant rewrite and the local Python is well-tested.

## Acceptance criteria (Option A)

- [ ] `launchd` plist installed in `~/Library/LaunchAgents/`, loaded.
- [ ] Runs Tuesday 09:00 ET regardless of Mac sleep state (uses
      `StartCalendarInterval` + `RunAtLoad: false` + waking the Mac
      via Energy Saver schedule).
- [ ] Log file readable at `~/Library/Logs/ups-weekly-sync.log`.
- [ ] On failure, log + send Keith a Discord ping (reuse existing
      Discord webhook from `worker/src/index.js`).
- [ ] Verifiable: query `SELECT MAX(week) FROM src_weekly WHERE
      win_chunks IS NOT NULL` post-run; should equal latest played week.
- [ ] One-off: do the current win_chunks backfill (already scripted
      at `scripts/backfill_d1_win_chunks.py`) so the FIRST run doesn't
      have to do a full 279K-row reload.

## Open questions for Keith

1. **When does the scoring engine actually run today?** Need to know the
   trigger sequence: does it run automatically after MFL settles, or
   does Keith click something Monday/Tuesday?
2. **Is iCloud-DB latency a problem?** The DB lives in iCloud Drive —
   if the sync daemon hasn't pulled the latest scoring writes by the
   time `load_local_to_d1.py` runs, we'd push stale data. Possible
   fix: use `brctl evict` or `brctl download` to force iCloud sync
   before reading.
3. **Should the worker's daily 12:05 / 18:05 crons stay separate from
   the weekly Tuesday sync?** Those handle different tables. Keep
   isolated unless they start stepping on each other.

## Out of scope (deferred)

- Hot-fix path when the upstream scoring engine breaks mid-season
  (manual run from another machine? Slack ping to Keith?)
- A staging DB for verifying the weekly sync before it hits prod
  (use Option B's GH Actions runner to dry-run against a `staging`
  D1 binding before promoting to `ups-mfl-db`)
- Backfilling pre-2020 win_chunks (analytical work — different track)

## Linked work

- `scripts/backfill_d1_win_chunks.py` — surgical one-off, ready to run
  with explicit auth. Bridge until Option A ships.
- `scripts/load_local_to_d1.py` — the full reloader Option A wraps.
- `pipelines/etl/scripts/build_metadata_positionalwinprofile.py` — the
  baseline-percentile builder that has to run BEFORE the loader.
- `docs/specs/contract_stints_integration.md` — sibling spec, same
  pattern (data-pipeline work parked for post-draft).
