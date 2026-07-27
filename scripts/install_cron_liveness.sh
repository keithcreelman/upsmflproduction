#!/usr/bin/env bash
# Installs the OFF-PLATFORM watchdog: alerts when Cloudflare stops running
# crons at all, or when a scheduled FA report doesn't post.
#
# Every alarm before this one lived inside the thing it watched — the
# auction-poll watchdog rides Cloudflare's own */2 cron, so a dead scheduler
# takes the alarm down with it (2026-07-15), and a cron that silently doesn't
# fire produces nothing at all (the 9 AM report, 2026-07-27). This job runs on
# Keith's Mac and DMs Discord directly, so it survives a dead worker.
#
#   ./scripts/install_cron_liveness.sh          # install + start
#   ./scripts/install_cron_liveness.sh remove   # stop + uninstall
set -euo pipefail

LABEL="com.keith.mfl.cron-liveness"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO_ROOT/scripts/scheduler/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "remove" ]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "✓ removed $LABEL (keychain items left in place)"
  exit 0
fi

# Two secrets, both from Keychain, never from the plist or the script.
if ! security find-generic-password -a "$USER" -s ups-commish-api-key -w >/dev/null 2>&1; then
  echo "No keychain item 'ups-commish-api-key' yet."
  echo "Paste the COMMISH_API_KEY (input hidden), then Enter:"
  read -rs COMMISH_KEY
  security add-generic-password -a "$USER" -s ups-commish-api-key -w "$COMMISH_KEY"
  unset COMMISH_KEY
  echo "✓ stored in Keychain"
fi

# The bot token is what makes this independent — it lets the watchdog reach
# Discord WITHOUT going through the worker it is watching.
if ! security find-generic-password -a "$USER" -s discord_bot_token -w >/dev/null 2>&1; then
  echo "No keychain item 'discord_bot_token' yet."
  echo "Paste the DISCORD_BOT_TOKEN (input hidden), then Enter:"
  read -rs BOT_TOKEN
  security add-generic-password -a "$USER" -s discord_bot_token -w "$BOT_TOKEN"
  unset BOT_TOKEN
  echo "✓ stored in Keychain"
fi

chmod +x "$REPO_ROOT/scripts/cron_liveness_tick.sh"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✓ loaded launchd job '$LABEL' — checks every 5 min, logs at /tmp/ups_cron_liveness.log"
echo "  alerts on: worker unreachable · Cloudflare crons stopped · FA report no-show"
echo "  first check runs immediately (RunAtLoad); watch: tail -f /tmp/ups_cron_liveness.log"
