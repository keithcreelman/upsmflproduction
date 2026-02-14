# ETL Pipeline

## Folders
- `scripts`: executable ETL jobs.
- `config`: static configuration files.
- `inputs`: raw source files and optional supplemental JSON.
- `data`: SQLite DB file location (runtime).
- `artifacts`: generated CSV outputs (runtime).

## Script Inventory
- `build_auction_value_model.py`
- `build_early_projection.py`
- `ingest_contract_logs_2019_2021.py`
- `ingest_discord_contracts.py`
- `load_mym_submissions_2025.py`
- `migrate_legacy_contract_xml.py`

## Runtime Contract
- Scripts default to relative paths under this `etl` folder.
- `MFL_DB_PATH` can override the SQLite DB location.
- `MFL_ETL_ARTIFACT_DIR` can override CSV artifact output location.
- Year-specific external inputs should be supplied via CLI flags where available.
