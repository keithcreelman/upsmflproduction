# Operations Runbook

## Pre-Deploy
1. Confirm runtime paths and credentials are set from `pipelines/etl/config/runtime.env.example`.
2. Run release validation:
   - `bash scripts/validate_release.sh`
3. Confirm required inputs exist in `pipelines/etl/inputs`.

## Deploy Sequence
1. Deploy static site assets from `apps/mfl_site`.
2. Deploy rulebook service (`services/rulebook`) and verify:
   - `GET /health`
   - `GET /api/rules`
3. Run ETL jobs in this order when rebuilding state:
   - `ingest_contract_logs_2019_2021.py`
   - `ingest_discord_contracts.py --write-v3-all`
   - `migrate_legacy_contract_xml.py`
   - `load_mym_submissions_2025.py`
   - `build_auction_value_model.py`
   - `build_early_projection.py`

## Rollback
1. Restore previous code package.
2. Restore previous SQLite backup.
3. Re-run health checks and sample ETL dry-runs.

## Post-Deploy Checks
- Rulebook API returns rules and accepts valid feedback payloads.
- ETL scripts can open DB and write artifacts without path errors.
- No absolute machine-specific paths appear in script defaults.
