#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Checking for absolute machine-specific paths"
if rg -n "/Users/|Desktop/MFL_Scripts" "$ROOT_DIR/pipelines/etl/scripts" "$ROOT_DIR/services/rulebook" "$ROOT_DIR/apps/mfl_site"; then
  echo "Found disallowed absolute paths."
  exit 1
fi

echo "==> Checking for embedded API keys"
if rg -n "APIKEY=" "$ROOT_DIR/pipelines/etl/scripts" "$ROOT_DIR/services/rulebook"; then
  echo "Found embedded API key material."
  exit 1
fi

echo "==> Python syntax compile check"
python3 -m py_compile \
  "$ROOT_DIR"/pipelines/etl/scripts/*.py \
  "$ROOT_DIR"/services/rulebook/api/rulebook_api.py \
  "$ROOT_DIR"/services/rulebook/tools/build_rulebook_json.py

echo "Validation passed."
