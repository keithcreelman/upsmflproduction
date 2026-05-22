#!/bin/bash
# rotate_discord_bot_token.sh — rotate the Discord bot token everywhere
# it's stored, in one command.
#
# Updates ALL of:
#   1. macOS Keychain (`discord_bot_token`) — used by the local bot + watchdog
#   2. Cloudflare worker secret (`DISCORD_BOT_TOKEN`) — used by the worker
#   3. Restarts the local bot via launchd so it picks up the new value
#
# Prompts for the new value once. The token never appears in shell
# history or in any file.
#
# Usage:
#   ./rotate_discord_bot_token.sh
#
# Prerequisites:
#   - wrangler is logged in to your Cloudflare account
#   - launchd agent com.keith.mfl.roast-bot is installed (skipped silently
#     if not present)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/worker"

echo "Rotating Discord bot token across all stores."
echo "Generate a fresh token in the Discord developer portal first,"
echo "then paste it below. Input is hidden — nothing echoes."
echo

# read -s hides input; never echoed, never in shell history
read -s -p "New Discord bot token: " NEW_TOKEN
echo
read -s -p "Confirm (paste again): " CONFIRM_TOKEN
echo

if [ -z "$NEW_TOKEN" ]; then
  echo "ERROR: empty token, aborting."
  exit 1
fi
if [ "$NEW_TOKEN" != "$CONFIRM_TOKEN" ]; then
  echo "ERROR: token confirmation didn't match, aborting."
  exit 1
fi

# Basic sanity check — Discord bot tokens are 70+ chars
if [ ${#NEW_TOKEN} -lt 50 ]; then
  echo "ERROR: token looks too short (${#NEW_TOKEN} chars). Discord bot tokens are typically 70+. Aborting."
  exit 1
fi

# Stash CONFIRM_TOKEN, we don't need two copies in memory
unset CONFIRM_TOKEN

# ── 1. macOS Keychain ─────────────────────────────────────────────────
echo "[1/3] Updating macOS Keychain..."
security delete-generic-password -a "$USER" -s "discord_bot_token" >/dev/null 2>&1 || true
security add-generic-password -a "$USER" -s "discord_bot_token" -w "$NEW_TOKEN"
echo "      ✓ Keychain entry updated"

# ── 2. Cloudflare worker secret ───────────────────────────────────────
echo "[2/3] Updating Cloudflare worker secret..."
if [ ! -d "$WORKER_DIR" ]; then
  echo "      ⚠ Worker dir not found at $WORKER_DIR — skipping Cloudflare update"
else
  # wrangler secret put reads value from stdin via printf (no temp file,
  # no shell history exposure)
  if ! (cd "$WORKER_DIR" && printf '%s' "$NEW_TOKEN" | wrangler secret put DISCORD_BOT_TOKEN); then
    echo "      ⚠ wrangler secret put failed. Keychain WAS updated, but Cloudflare worker still has the OLD token."
    echo "        Fix wrangler auth and re-run, OR manually: cd $WORKER_DIR && wrangler secret put DISCORD_BOT_TOKEN"
    exit 1
  fi
  echo "      ✓ Cloudflare worker secret updated"
fi

# Token is now in two secure stores. Clear it from this script's memory.
unset NEW_TOKEN

# ── 3. Restart local bot so it picks up the new token ─────────────────
echo "[3/3] Restarting local bot..."
LAUNCH_LABEL="com.keith.mfl.roast-bot"
if launchctl list | grep -q "$LAUNCH_LABEL"; then
  launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL"
  echo "      ✓ Bot restarted (launchctl kickstart)"
else
  echo "      ⓘ launchd agent $LAUNCH_LABEL not loaded — skipping restart"
fi

echo
echo "✅ Done. Token rotated:"
echo "   • macOS Keychain          (local bot + watchdog)"
echo "   • Cloudflare worker secret (production worker)"
echo "   • Local bot restarted to pick up new value"
echo
echo "If any OTHER scripts use the token, you'll need to update those separately."
echo "The worker is the only Cloudflare consumer; Keychain covers all local consumers."
