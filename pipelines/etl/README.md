# ETL Pipeline

## Folders
- `scripts`: executable ETL jobs.
- `config`: static configuration files.
- `inputs`: raw source files and optional supplemental JSON.
- `data`: SQLite DB file location (runtime).
- `artifacts`: generated CSV outputs (runtime).

## Script Inventory
- `build_acquisition_hub_artifacts.py`
- `build_auction_value_model.py`
- `build_early_projection.py`
- `ingest_contract_logs_2019_2021.py`
- `ingest_discord_contracts.py`
- `load_mym_submissions_2025.py`
- `log_extension_submission.py`
- `migrate_legacy_contract_xml.py`
- `sync_contract_submissions_to_db.py`

## External fetchers (not yet ported)

The following local-DB tables are **populated by a fetcher that lives outside
this repo** (legacy `~/Desktop/MFL_Scripts/`). They are read by `scripts/` here
but never written here, and `scripts/run_pipeline_live.sh` does **not** refresh
them:

- `franchises`         — per-season franchise/owner/division dim
- `schedule`           — per-week H2H matchup rows (multi-opponent rows ok)
- `weeklyresults`      — per-(season, week, franchise, player) raw scoring
- `weeklyresults_summary` — per-(season, week, franchise) score + all-play
- `standings`          — per-(season, franchise) season aggregates

These four feed the D1 `src_franchises` / `src_schedule` /
`src_weekly_franchise_summary` / `src_standings` tables (migration 0029).
`scripts/sync_d1.sh` enforces a 24h staleness check on the local DB so the
nightly cron fails loudly if the external fetcher stops running.

**Follow-up:** port these fetchers into `pipelines/etl/scripts/` so this repo
becomes the single source of truth.

## Runtime Contract
- Scripts default to relative paths under this `etl` folder.
- `MFL_DB_PATH` can override the SQLite DB location.
- `MFL_ETL_ARTIFACT_DIR` can override CSV artifact output location.
- `MFL_SALARY_ADJUSTMENTS_URL` can provide live drop-marker evidence for salary-adjustment builds.
- `MFL_SALARY_ADJUSTMENTS_REQUIRE_LIVE_DROP_FEED` controls review-only gating for post-auction carryover cuts in the live salary-adjustments build.
- Year-specific external inputs should be supplied via CLI flags where available.
- `build_acquisition_hub_artifacts.py` writes the history payloads consumed by the Acquisition Hub worker routes under `site/acquisition/`.
