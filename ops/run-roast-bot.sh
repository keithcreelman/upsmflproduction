#!/usr/bin/env bash
# UPS Roast Bot launcher — sources ops/roast-bot.env.local and starts the bot.
# Used by launchd plist (or call directly to run in foreground).

set -euo pipefail

# Resolve repo root (script lives at <repo>/ops/run-roast-bot.sh)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Load secrets (never echoed to logs)
ENV_FILE="${REPO_ROOT}/ops/roast-bot.env.local"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Copy ops/roast-bot.env.local.example and fill in." >&2
    exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Verify required vars are set
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY not set in $ENV_FILE}"
: "${DISCORD_BOT_TOKEN:?DISCORD_BOT_TOKEN not set in $ENV_FILE}"

# Resolve Python from .venv if present, otherwise system python3
if [ -x "${REPO_ROOT}/.venv/bin/python" ]; then
    PYTHON="${REPO_ROOT}/.venv/bin/python"
else
    PYTHON="$(command -v python3)"
fi

echo "[run-roast-bot] $(date -u +%FT%TZ) starting bot from $REPO_ROOT"
echo "[run-roast-bot] ROAST_BOT_ENV=${ROAST_BOT_ENV:-test}"
exec "$PYTHON" pipelines/etl/scripts/trade_roast_bot.py "$@"
