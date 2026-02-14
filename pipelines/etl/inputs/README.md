# ETL Inputs

Place runtime input files in this folder before running ingestion jobs.

## Expected Filenames
- `discord_contract_activity.csv`
- `discord_slack_history.csv`
- `2019_contract_transaction_log.xlsx`
- `2020_contract_transaction_log.xlsx`
- `2021_contract_transaction_log.xlsx`
- `tag_tracking.json` (optional for projection workflow)
- `tagging_2026_exclusions.json` (optional for projection workflow)

Use CLI flags to override any default filename.
