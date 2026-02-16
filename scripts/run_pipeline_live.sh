#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETL_DIR="$ROOT_DIR/pipelines/etl"
SCRIPT_DIR="$ETL_DIR/scripts"
LIVE_ENV="$ETL_DIR/config/runtime.env.live"

if [[ -f "$LIVE_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$LIVE_ENV"
fi

export MFL_DB_PATH="${MFL_DB_PATH:-$ETL_DIR/data/mfl_database.db}"
export MFL_ETL_ARTIFACT_DIR="${MFL_ETL_ARTIFACT_DIR:-$ETL_DIR/artifacts}"
export MFL_TAG_TRACKING_JSON="${MFL_TAG_TRACKING_JSON:-$ETL_DIR/inputs/tag_tracking.json}"
export MFL_TAG_EXCLUSIONS_JSON="${MFL_TAG_EXCLUSIONS_JSON:-$ETL_DIR/inputs/tagging_2026_exclusions.json}"
export MFL_SALARY_ADJUSTMENTS_URL="${MFL_SALARY_ADJUSTMENTS_URL:-}"

mkdir -p "$MFL_ETL_ARTIFACT_DIR"

python3 "$SCRIPT_DIR/ingest_contract_logs_2019_2021.py" --db-path "$MFL_DB_PATH"
python3 "$SCRIPT_DIR/ingest_discord_contracts.py" --db-path "$MFL_DB_PATH" --write-v3-all
python3 "$SCRIPT_DIR/migrate_legacy_contract_xml.py" --db-path "$MFL_DB_PATH"
python3 "$SCRIPT_DIR/load_mym_submissions_2025.py" --db-path "$MFL_DB_PATH"

python3 "$SCRIPT_DIR/build_auction_value_model.py" --db-path "$MFL_DB_PATH" --start-year 2025 --end-year 2025 --current-season 2025
python3 "$SCRIPT_DIR/build_early_projection.py" --db-path "$MFL_DB_PATH" --adp-source sleeper_sf --tag-tracking-json "$MFL_TAG_TRACKING_JSON" --tag-exclusions-json "$MFL_TAG_EXCLUSIONS_JSON"
python3 "$SCRIPT_DIR/build_roster_rollforward_csv.py" --db-path "$MFL_DB_PATH" --base-season 2025 --target-season 2026 --out-full "$MFL_ETL_ARTIFACT_DIR/rosters_rollforward_2026_full.csv" --out-import "$MFL_ETL_ARTIFACT_DIR/mfl_roster_import_2026.csv"
python3 "$SCRIPT_DIR/build_roster_import_xml.py" --in-csv "$MFL_ETL_ARTIFACT_DIR/mfl_roster_import_2026.csv" --season 2026 --db-path "$MFL_DB_PATH" --salaries-out "$MFL_ETL_ARTIFACT_DIR/mfl_roster_import_2026_salaries.xml" --rosters-out "$MFL_ETL_ARTIFACT_DIR/mfl_roster_overlay_2026.xml"
python3 "$SCRIPT_DIR/build_standings_snapshot.py" --league-id 25625 --season 2026 --out "$ROOT_DIR/site/standings/standings_25625_2026.json"
python3 "$SCRIPT_DIR/build_player_points_history_json.py" --db-path "$MFL_DB_PATH" --target-season 2026 --years-back 3 --out-path "$ROOT_DIR/site/ccc/player_points_history.json"
python3 "$SCRIPT_DIR/build_tag_submissions_json.py" --db-path "$MFL_DB_PATH" --out-path "$ROOT_DIR/site/ccc/tag_submissions.json"
python3 "$SCRIPT_DIR/build_restructure_submissions_json.py" --db-path "$MFL_DB_PATH" --out-path "$ROOT_DIR/site/ccc/restructure_submissions.json"

echo "Pipeline complete. Artifacts in: $MFL_ETL_ARTIFACT_DIR"
