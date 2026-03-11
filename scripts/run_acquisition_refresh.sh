#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETL_DIR="$ROOT_DIR/pipelines/etl"
SCRIPT_PATH="$ETL_DIR/scripts/build_acquisition_hub_artifacts.py"
LIVE_ENV="$ETL_DIR/config/runtime.env.live"

if [[ -f "$LIVE_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$LIVE_ENV"
fi

export MFL_DB_PATH="${MFL_DB_PATH:-/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db}"
CURRENT_SEASON="${CURRENT_SEASON:-$(date +%Y)}"
ACTIVE_MONTHS="${UPS_ACQ_ACTIVE_MONTHS:-7,8,9}"
CURRENT_MONTH="$(date +%-m)"
CURRENT_HOUR="$(date +%-H)"

within_active_window=0
IFS=',' read -r -a active_month_list <<< "$ACTIVE_MONTHS"
for month in "${active_month_list[@]}"; do
  if [[ "$CURRENT_MONTH" == "${month// /}" ]]; then
    within_active_window=1
    break
  fi
done

if [[ "$within_active_window" -ne 1 ]]; then
  if (( CURRENT_HOUR % 4 != 0 )); then
    echo "Acquisition refresh skipped outside active window; next run allowed at a 4-hour boundary."
    exit 0
  fi
fi

python3 "$SCRIPT_PATH" \
  --db-path "$MFL_DB_PATH" \
  --current-season "$CURRENT_SEASON" \
  --out-dir "$ROOT_DIR/site/acquisition"
