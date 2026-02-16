#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 "$ROOT_DIR/services/mcm/api/mcm_api.py" --host 0.0.0.0 --port 8799 --cors-origin "*"

