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
export MFL_PLAYER_SCORING_REPORT_OUT_DIR="${MFL_PLAYER_SCORING_REPORT_OUT_DIR:-$ROOT_DIR/site/reports/player_scoring}"
export MFL_PLAYER_SCORING_REPORT_SQL_PATH="${MFL_PLAYER_SCORING_REPORT_SQL_PATH:-$ROOT_DIR/site/reports/player_scoring/player_scoring_sql.sql}"
export MFL_PLAYER_SCORING_REPORT_MIN_SEASON="${MFL_PLAYER_SCORING_REPORT_MIN_SEASON:-}"
export MFL_PLAYER_SCORING_REPORT_MAX_SEASON="${MFL_PLAYER_SCORING_REPORT_MAX_SEASON:-}"
export MFL_SALARY_ADJUSTMENTS_REPORT_OUT_DIR="${MFL_SALARY_ADJUSTMENTS_REPORT_OUT_DIR:-$ROOT_DIR/site/reports/salary_adjustments}"
export MFL_SALARY_ADJUSTMENTS_REPORT_SQL_PATH="${MFL_SALARY_ADJUSTMENTS_REPORT_SQL_PATH:-$ROOT_DIR/site/reports/salary_adjustments/salary_adjustments_sql.sql}"
export MFL_SALARY_ADJUSTMENTS_REPORT_MIN_SEASON="${MFL_SALARY_ADJUSTMENTS_REPORT_MIN_SEASON:-}"
export MFL_SALARY_ADJUSTMENTS_REPORT_MAX_SEASON="${MFL_SALARY_ADJUSTMENTS_REPORT_MAX_SEASON:-}"

mkdir -p "$MFL_ETL_ARTIFACT_DIR"

PLAYER_SCORING_REPORT_ARGS=(
  --db-path "$MFL_DB_PATH"
  --out-dir "$MFL_PLAYER_SCORING_REPORT_OUT_DIR"
  --sql-path "$MFL_PLAYER_SCORING_REPORT_SQL_PATH"
)
if [[ -n "$MFL_PLAYER_SCORING_REPORT_MIN_SEASON" ]]; then
  PLAYER_SCORING_REPORT_ARGS+=(--min-season "$MFL_PLAYER_SCORING_REPORT_MIN_SEASON")
fi
if [[ -n "$MFL_PLAYER_SCORING_REPORT_MAX_SEASON" ]]; then
  PLAYER_SCORING_REPORT_ARGS+=(--max-season "$MFL_PLAYER_SCORING_REPORT_MAX_SEASON")
fi

SALARY_ADJUSTMENTS_REPORT_ARGS=(
  --db-path "$MFL_DB_PATH"
  --out-dir "$MFL_SALARY_ADJUSTMENTS_REPORT_OUT_DIR"
  --sql-path "$MFL_SALARY_ADJUSTMENTS_REPORT_SQL_PATH"
)
if [[ -n "$MFL_SALARY_ADJUSTMENTS_REPORT_MIN_SEASON" ]]; then
  SALARY_ADJUSTMENTS_REPORT_ARGS+=(--min-season "$MFL_SALARY_ADJUSTMENTS_REPORT_MIN_SEASON")
fi
if [[ -n "$MFL_SALARY_ADJUSTMENTS_REPORT_MAX_SEASON" ]]; then
  SALARY_ADJUSTMENTS_REPORT_ARGS+=(--max-season "$MFL_SALARY_ADJUSTMENTS_REPORT_MAX_SEASON")
fi

python3 "$SCRIPT_DIR/ingest_contract_logs_2019_2021.py" --db-path "$MFL_DB_PATH"
python3 "$SCRIPT_DIR/ingest_discord_contracts.py" --db-path "$MFL_DB_PATH" --write-v3-all
python3 "$SCRIPT_DIR/migrate_legacy_contract_xml.py" --db-path "$MFL_DB_PATH"
python3 "$SCRIPT_DIR/load_mym_submissions_2025.py" --db-path "$MFL_DB_PATH"

python3 "$SCRIPT_DIR/build_auction_value_model.py" --db-path "$MFL_DB_PATH" --start-year 2025 --end-year 2025 --current-season 2025
python3 "$SCRIPT_DIR/build_early_projection.py" --db-path "$MFL_DB_PATH" --adp-source sleeper_sf --tag-tracking-json "$MFL_TAG_TRACKING_JSON" --tag-exclusions-json "$MFL_TAG_EXCLUSIONS_JSON"
python3 "$SCRIPT_DIR/build_roster_rollforward_csv.py" --db-path "$MFL_DB_PATH" --base-season 2025 --target-season 2026 --out-full "$MFL_ETL_ARTIFACT_DIR/rosters_rollforward_2026_full.csv" --out-import "$MFL_ETL_ARTIFACT_DIR/mfl_roster_import_2026.csv"
python3 "$SCRIPT_DIR/repair_rosters_current_rollforward.py" --db-path "$MFL_DB_PATH" --base-season 2025 --target-season 2026
python3 "$SCRIPT_DIR/repair_extension_previews_from_current_extensions.py" --db-path "$MFL_DB_PATH" --base-season 2025 --target-season 2026
python3 "$SCRIPT_DIR/export_extension_previews_json.py" --db-path "$MFL_DB_PATH" --season 2026 --out-path "$ROOT_DIR/site/trades/extension_previews_2026.json"
python3 "$SCRIPT_DIR/build_roster_import_xml.py" --in-csv "$MFL_ETL_ARTIFACT_DIR/mfl_roster_import_2026.csv" --season 2026 --db-path "$MFL_DB_PATH" --salaries-out "$MFL_ETL_ARTIFACT_DIR/mfl_roster_import_2026_salaries.xml" --rosters-out "$MFL_ETL_ARTIFACT_DIR/mfl_roster_overlay_2026.xml"
python3 "$SCRIPT_DIR/build_standings_snapshot.py" --league-id 25625 --season 2025 --out "$ROOT_DIR/site/standings/standings_25625_2025.json"
python3 "$SCRIPT_DIR/build_standings_snapshot.py" --league-id 25625 --season 2026 --out "$ROOT_DIR/site/standings/standings_25625_2026.json"
python3 "$SCRIPT_DIR/build_standings_snapshot.py" --league-id 74598 --season 2025 --out "$ROOT_DIR/site/standings/standings_74598_2025.json"
python3 "$SCRIPT_DIR/build_standings_snapshot.py" --league-id 74598 --season 2026 --out "$ROOT_DIR/site/standings/standings_74598_2026.json"
python3 "$SCRIPT_DIR/build_player_points_history_json.py" --db-path "$MFL_DB_PATH" --target-season 2026 --years-back 3 --out-path "$ROOT_DIR/site/ccc/player_points_history.json"
python3 "$SCRIPT_DIR/build_roster_points_history_json.py" --db-path "$MFL_DB_PATH" --roster-season 2026 --history-start-season 2010 --out-path "$ROOT_DIR/site/rosters/player_points_history.json"
echo "==> Build player scoring report artifacts"
python3 "$SCRIPT_DIR/build_player_scoring_report.py" "${PLAYER_SCORING_REPORT_ARGS[@]}"
echo "==> Build salary adjustments report artifacts and MFL XML imports"
python3 "$SCRIPT_DIR/build_salary_adjustments_report.py" --import-out-dir "$MFL_ETL_ARTIFACT_DIR" "${SALARY_ADJUSTMENTS_REPORT_ARGS[@]}"
echo "==> Build Acquisition Hub artifacts"
python3 "$SCRIPT_DIR/build_acquisition_hub_artifacts.py" --db-path "$MFL_DB_PATH" --current-season 2026 --out-dir "$ROOT_DIR/site/acquisition"
python3 "$SCRIPT_DIR/build_tag_submissions_json.py" --db-path "$MFL_DB_PATH" --out-path "$ROOT_DIR/site/ccc/tag_submissions.json"
python3 "$SCRIPT_DIR/build_restructure_submissions_json.py" --db-path "$MFL_DB_PATH" --out-path "$ROOT_DIR/site/ccc/restructure_submissions.json"

echo "Pipeline complete. Artifacts in: $MFL_ETL_ARTIFACT_DIR"
