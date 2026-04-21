# Backup strategy

Where each piece of UPS league data lives and how it's protected.

## Layers

### 1. MFL (the upstream)
Everything ultimately comes from MFL's public API. MFL is durable but
rate-limited and occasionally lossy on historical seasons (e.g. 2016
`draftResults` export returns "Invalid league ID" even though the data
is in MFL's UI — that's why `mfl_database.db` has a `draftresults_legacy`
table populated once and kept).

### 2. GitHub: daily MFL snapshots (Phase 1, live)
`.github/workflows/mfl-daily-snapshot.yml` runs 09:05 UTC every day,
fetches the public exports (`salaries`, `transactions`, `rosters`,
`injuries`, `league`, `freeAgents`, `draftResults`) and commits them to
`data/mfl-snapshots/YYYY-MM-DD/`. This is the permanent contract /
transaction log — every roster move, salary, and contract adjustment we
can see from MFL is preserved in git history with date-stamped folders
and readable JSON (pretty-printed, sorted keys, delta-friendly).

Manual trigger: `gh workflow run "MFL daily snapshot"` or the GitHub UI.

### 3. Local SQLite (`mfl_database.db`)
Lives at `/Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db`.
Authoritative for historical seasons (pre-MFL-API coverage) and holds
derived tables the ETL scripts populate (baselines, z-scores, etc).

Not in git — too big and changes too often. Protected by:
- `scripts/backup_mfl_db.sh` — uses `sqlite3 .backup` for a consistent
  snapshot, gzips it, keeps the last 30 days under
  `~/Documents/mfl/backups/mfl_database/`.
- `scripts/com.upsmfl.db-backup.plist` — launchd job that runs the
  script nightly at 03:15 local.
- Manual upgrade path: set `DEST` env var to an iCloud-synced folder for
  off-device redundancy until R2 is online (Phase 2).

Install:
```
cp scripts/com.upsmfl.db-backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.upsmfl.db-backup.plist
```

### 4. Cloudflare R2 (Phase 2, not yet enabled)
**Blocker:** R2 needs to be enabled once on the Cloudflare account via
the dashboard (`Storage & Databases → R2 → Enable`). Free tier gives
10 GB storage + plenty of ops/month, more than enough.

Once enabled, two pieces switch over:
1. The daily MFL snapshot Worker action (currently a GitHub Action)
   writes to R2 instead of committing to the repo — cleaner history,
   longer retention, queryable.
2. The local-DB backup script uploads each gzipped snapshot to R2 for
   off-device redundancy.

### 5. Cloudflare D1 (Phase 3, future)
Port the tables the Worker needs (contracts, transactions, rosters,
draft history, weekly scoring) into D1 so the Worker can serve live
lookups without any dependency on Keith's laptop. At that point:
- `/api/player-bundle` can return `career_summary` tier percentages,
  `weekly` game logs, `last_add` with salary parsed — everything the
  Python bridge returns.
- The ETL can optionally run on a Worker schedule instead of on the
  laptop.

### 6. Override layer (Phase 3)
Corrections like "2014 4.06 should be Ryan Bousquet, not Eric Mannila"
and "2016 1.06 should be pid 12652, not 11613" currently require
mutating both `draftresults_legacy` AND `rookie_draft_history.json`
(see `docs/ups_v2/V2_GOVERNED/rules/claude_canonical_rules.md`
— RULE-DATA-003). Cleaner design:
- A `corrections` table in D1: `(season, pick_id, field,
  original_value, corrected_value, reason, reviewer, timestamp)`.
- Merge at query time: `final = COALESCE(correction.corrected,
  source.value)`.
- Corrections are auditable forever (reason + reviewer), reversible
  via one DELETE.

## Summary table

| Data | Primary source | Phase 1 backup | Phase 2 backup |
|---|---|---|---|
| Current-season contracts, rosters, transactions, injuries | MFL public API | GH Action daily snapshot in `data/mfl-snapshots/` | R2 snapshots |
| Historical ETL-derived tables (baselines, z-scores, draft history pre-2017) | local `mfl_database.db` | `scripts/backup_mfl_db.sh` (local + optional iCloud) | R2 gzipped uploads |
| Governance docs + rulebook | repo `docs/ups_v2/` | git (already) | git (same) |
| ETL scripts | repo `pipelines/etl/scripts/` | git (already) | git (same) |
| Corrections / overrides | source DB + JSON hand-edits (fragile) | git commit trail | dedicated `corrections` table (Phase 3) |

## Verifying the pipeline

After the first GitHub-Actions run, check that
`data/mfl-snapshots/YYYY-MM-DD/` appears on `main` with seven JSON
files + `_snapshot_meta.json`. Any fetch that fails would fail the
workflow (`curl -f`), so a green workflow run = complete data.
