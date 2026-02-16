#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${MFL_DB_PATH:-$ROOT_DIR/pipelines/etl/data/mfl_database.db}"
SEASON="${TAG_BASE_SEASON:-2025}"
OUT_PATH="$ROOT_DIR/site/ccc/tag_tracking.json"

mkdir -p "$(dirname "$OUT_PATH")"

python3 "$ROOT_DIR/pipelines/etl/scripts/build_tag_tracking.py" \
  --db-path "$DB_PATH" \
  --season "$SEASON" \
  --out-path "$OUT_PATH"

echo "Wrote: $OUT_PATH"
