#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_SCRIPT="$ROOT_DIR/services/rulebook/api/rulebook_api.py"
RULES_PATH="$ROOT_DIR/services/rulebook/data/rules.json"
DB_PATH="$ROOT_DIR/services/rulebook/data/rule_feedback.db"
HOST="${1:-127.0.0.1}"
PORT="${2:-8787}"

RULEBOOK_RULES_PATH="$RULES_PATH" RULEBOOK_DB_PATH="$DB_PATH" python3 "$API_SCRIPT" --host "$HOST" --port "$PORT" --cors-origin "*"
