#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$ROOT_DIR/pipelines/etl/scripts"
API_SCRIPT="$ROOT_DIR/services/rulebook/api/rulebook_api.py"
RULES_PATH="$ROOT_DIR/services/rulebook/data/rules.json"
TMP_DB="/tmp/rule_feedback_smoke_$$.db"
PORT="8879"

bash "$ROOT_DIR/scripts/validate_release.sh"

for f in \
  build_adp_auction_value_model.py \
  build_early_projection_2026.py \
  extract_discord_contracts.py \
  load_contract_logs_2019_2021.py \
  load_2025_mym_into_v3.py \
  migrate_contracts_xml_legacy.py; do
  python3 "$SCRIPTS/$f" --help >/dev/null
  echo "wrapper_ok=$f"
done

RULEBOOK_DB_PATH="$TMP_DB" RULEBOOK_RULES_PATH="$RULES_PATH" python3 "$API_SCRIPT" --host 127.0.0.1 --port "$PORT" --cors-origin "*" >/tmp/rulebook_smoke_${PORT}.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -f "$TMP_DB"' EXIT
sleep 1
curl -sS "http://127.0.0.1:${PORT}/health" >/dev/null
curl -sS "http://127.0.0.1:${PORT}/api/rules" >/dev/null

echo "operational_smoke_test=passed"
