#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INPUT_DIR="$ROOT_DIR/pipelines/etl/inputs"
DATA_DIR="$ROOT_DIR/pipelines/etl/data"

mkdir -p "$INPUT_DIR" "$DATA_DIR"

link_if_set() {
  local source_path="$1"
  local target_path="$2"
  local label="$3"

  if [[ -z "$source_path" ]]; then
    echo "Skip $label: source path not set."
    return
  fi

  ln -sfn "$source_path" "$target_path"
  echo "Linked $label -> $source_path"
}

link_if_set "${DISCORD_CONTRACT_ACTIVITY_PATH:-}" "$INPUT_DIR/discord_contract_activity.csv" "discord_contract_activity.csv"
link_if_set "${DISCORD_SLACK_HISTORY_PATH:-}" "$INPUT_DIR/discord_slack_history.csv" "discord_slack_history.csv"
link_if_set "${CONTRACT_LOG_2019_PATH:-}" "$INPUT_DIR/2019_contract_transaction_log.xlsx" "2019_contract_transaction_log.xlsx"
link_if_set "${CONTRACT_LOG_2020_PATH:-}" "$INPUT_DIR/2020_contract_transaction_log.xlsx" "2020_contract_transaction_log.xlsx"
link_if_set "${CONTRACT_LOG_2021_PATH:-}" "$INPUT_DIR/2021_contract_transaction_log.xlsx" "2021_contract_transaction_log.xlsx"
link_if_set "${TAG_TRACKING_SOURCE_PATH:-}" "$INPUT_DIR/tag_tracking.json" "tag_tracking.json"
link_if_set "${TAG_EXCLUSIONS_SOURCE_PATH:-}" "$INPUT_DIR/tagging_2026_exclusions.json" "tagging_2026_exclusions.json"
link_if_set "${MFL_DB_SOURCE_PATH:-}" "$DATA_DIR/mfl_database.db" "mfl_database.db"

echo "Live input symlinks configured under: $INPUT_DIR"
echo "Live DB symlink configured at: $DATA_DIR/mfl_database.db"
