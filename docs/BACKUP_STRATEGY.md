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

### 4. Cloudflare R2 (Phase 2, live)
Bucket: `ups-mfl-backups`. Bound to the Worker as `env.UPS_MFL_BACKUPS`.

**Worker-scheduled daily snapshot.** The `scheduled` handler in
`worker/src/index.js` fires every hour at :05. When the UTC hour is 9
(≈05:05 ET), it runs `snapshotMflToR2(env, now)` which fetches seven
MFL public exports — `salaries`, `transactions`, `rosters`, `injuries`,
`league`, `freeAgents`, `draftResults` — in parallel and writes them
to R2 under `snapshots/YYYY-MM-DD/{type}.json`, plus a
`_snapshot_meta.json` with byte counts and per-export success flags.

**Manual trigger.** `GET /admin/snapshot-mfl-now` (requires
`X-Internal-Auth: <COMMISH_API_KEY>` if that env var is set). Idempotent
— re-running overwrites the same date folder.

**The GitHub Action snapshot still runs in parallel.** Two independent
backup paths (git-committed + R2-stored) is intentional redundancy —
if either one breaks, the other keeps capturing contract / transaction
data. Once R2 proves stable over a few months we can retire the GH
Action side.

**Still TODO — local DB → R2.** `backup_mfl_db.sh` writes the gzipped
SQLite snapshot to `~/Documents/mfl/backups/` today. To also push it to
R2, the script needs an R2 API token exported as `CLOUDFLARE_API_TOKEN`
(or equivalent S3-compat creds). Straightforward once Keith issues a
scoped token from the CF dashboard.

### 5. Cloudflare D1 (Phase 3, foundation live)
Database: `ups-mfl-db`. Bound to the Worker as `env.UPS_MFL_DB`.
Migrations under `worker/migrations/`, applied via
`wrangler d1 migrations apply ups-mfl-db --remote`.

**What's live (migration 0001):** the `corrections` override table
(see Phase 3 section below). Five real corrections seeded — the
Bortles 4.06 reassignment (commit `07e46cf`) and the Michael Thomas
1.06 DB→WR identity fix (`e16f0b9`).

**Endpoint:** `GET /api/corrections` returns the active (non-superseded)
corrections as JSON. Optional filters `?entity_kind=draft_pick` and
`?entity_id=2016.R1.06`. No auth — the data is derived, not secret.

**Still TODO (tables to port from local SQLite):**
- `contracts` snapshots
- `transactions` (add/drop + trade + auction)
- `player_weeklyscoringresults` (game logs)
- `draftresults_legacy` + `draftresults_mfl`
- `contract_history_snapshots`

Once ported, `/api/player-bundle` can return `career_summary` tier
percentages, `weekly` game logs, `last_add` with salary — i.e. full
parity with the Python bridge — with no dependency on Keith's laptop.

### 6. Corrections override layer (Phase 3, live)
Schema (see `worker/migrations/0001_corrections.sql`):
```
correction_id   INTEGER PRIMARY KEY AUTOINCREMENT
entity_kind     TEXT    -- 'draft_pick', 'player', 'trade', 'contract', ...
entity_id       TEXT    -- e.g. '2016.R1.06' or a player_id
field_path      TEXT    -- dotted path, supports nested structures
original_value  TEXT    -- JSON-encoded (scalar or structure)
corrected_value TEXT    -- JSON-encoded
reason          TEXT
reviewer        TEXT
created_at_utc  TEXT
effective_from  TEXT    -- nullable, for time-scoped fixes
superseded_by   INTEGER -- replace-in-place semantics
commit_sha      TEXT    -- traceability to the git change that logged it
notes           TEXT
```

**Idempotency + audit.** A corrected entity/field combo is
updated-in-place by pointing the old row's `superseded_by` at the new
one. The `idx_corrections_active` partial index lets the read path
stay fast (`WHERE superseded_by IS NULL`). Rolling back a correction
is a single UPDATE-to-null, not a data rewrite.

**How consumers should use it.** Read at merge time, not write time.
`build_rookie_draft_hub.py` should fetch `/api/corrections?entity_kind=draft_pick`
at the end of an ETL run and overlay corrections on the draft-history
rows before writing the JSON. That way source tables stay pristine
(next MFL refresh doesn't regress the fix) and every correction has a
traceable reason + reviewer + commit_sha forever.

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
