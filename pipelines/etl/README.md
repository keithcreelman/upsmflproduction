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
- `build_contract_history_snapshots.py`
- `build_contract_lineage_versions.py`
- `build_early_projection.py`
- `ingest_contract_logs_2019_2021.py`
- `ingest_discord_contracts.py`
- `load_mym_submissions_2025.py`
- `log_extension_submission.py`
- `migrate_legacy_contract_xml.py`
- `sync_contract_submissions_to_db.py`

## Runtime Contract
- Scripts default to relative paths under this `etl` folder.
- `MFL_DB_PATH` can override the SQLite DB location.
- `MFL_ETL_ARTIFACT_DIR` can override CSV artifact output location.
- `MFL_SALARY_ADJUSTMENTS_URL` can provide live drop-marker evidence for salary-adjustment builds.
- `MFL_SALARY_ADJUSTMENTS_REQUIRE_LIVE_DROP_FEED` controls review-only gating for post-auction carryover cuts in the live salary-adjustments build.
- Year-specific external inputs should be supplied via CLI flags where available.
- `build_acquisition_hub_artifacts.py` writes the history payloads consumed by the Acquisition Hub worker routes under `site/acquisition/`.
- `build_calculation_registry.py` generates the Acquisition Value Score review registry under `docs/calculations/`.
