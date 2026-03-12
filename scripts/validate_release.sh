#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Checking for absolute machine-specific paths"
if rg -n "/Users/|Desktop/MFL_Scripts" "$ROOT_DIR/pipelines/etl/scripts" "$ROOT_DIR/services/rulebook" "$ROOT_DIR/services/mcm" "$ROOT_DIR/apps/mfl_site" "$ROOT_DIR/site" "$ROOT_DIR/worker"; then
  echo "Found disallowed absolute paths."
  exit 1
fi

echo "==> Checking for embedded API keys"
if rg -n "APIKEY=[A-Za-z0-9]{12,}" "$ROOT_DIR/pipelines/etl/scripts" "$ROOT_DIR/services/rulebook" "$ROOT_DIR/services/mcm" "$ROOT_DIR/site" "$ROOT_DIR/worker"; then
  echo "Found embedded API key material."
  exit 1
fi

echo "==> Python syntax compile check"
python3 -m py_compile \
  "$ROOT_DIR"/pipelines/etl/scripts/*.py \
  "$ROOT_DIR"/services/rulebook/api/rulebook_api.py \
  "$ROOT_DIR"/services/rulebook/tools/build_rulebook_json.py \
  "$ROOT_DIR"/services/mcm/api/mcm_api.py

echo "Validation passed."
