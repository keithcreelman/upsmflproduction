#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INPUT_DIR="$ROOT_DIR/pipelines/etl/inputs"
DATA_DIR="$ROOT_DIR/pipelines/etl/data"

mkdir -p "$INPUT_DIR" "$DATA_DIR"

ln -sfn "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/Discord Chat/UPS Dynasty FFL - Automated League Updates - contract-activity [1059113303059730494].csv" "$INPUT_DIR/discord_contract_activity.csv"
ln -sfn "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/Discord Chat/UPS Dynasty FFL - archived_channels - slack-history [1063835430878969886].csv" "$INPUT_DIR/discord_slack_history.csv"
ln -sfn "/Users/keithcreelman/Downloads/2019_Contract_Tansaction_Log.xlsx" "$INPUT_DIR/2019_contract_transaction_log.xlsx"
ln -sfn "/Users/keithcreelman/Downloads/2020 Contract_Transaction_Log.xlsx" "$INPUT_DIR/2020_contract_transaction_log.xlsx"
ln -sfn "/Users/keithcreelman/Downloads/2021_Contract_Transaction_Log.xlsx" "$INPUT_DIR/2021_contract_transaction_log.xlsx"
ln -sfn "/Users/keithcreelman/Documents/mfl_app_codex/tag_tracking.json" "$INPUT_DIR/tag_tracking.json"
ln -sfn "/Users/keithcreelman/Documents/mfl_app_codex/reports/tagging_2026_exclusions.json" "$INPUT_DIR/tagging_2026_exclusions.json"
ln -sfn "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db" "$DATA_DIR/mfl_database.db"

echo "Live input symlinks configured under: $INPUT_DIR"
echo "Live DB symlink configured at: $DATA_DIR/mfl_database.db"
