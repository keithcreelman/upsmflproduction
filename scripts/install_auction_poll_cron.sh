#!/usr/bin/env bash
# Installs the launchd agent that drives the auction poll every 5 minutes
# while Cloudflare's cron triggers are dead (2026-07-15 incident).
#
#   ./scripts/install_auction_poll_cron.sh          # install + start
#   ./scripts/install_auction_poll_cron.sh remove   # stop + uninstall
set -euo pipefail

LABEL="com.keith.mfl.auction-poll"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO_ROOT/scripts/scheduler/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "remove" ]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "✓ removed $LABEL (keychain item left in place)"
  exit 0
fi

# The key goes in Keychain ONCE, typed by you, seen by nothing else.
if ! security find-generic-password -a "$USER" -s ups-commish-api-key -w >/dev/null 2>&1; then
  echo "No keychain item 'ups-commish-api-key' yet."
  echo "Paste the COMMISH_API_KEY (input hidden), then Enter:"
  read -rs COMMISH_KEY
  security add-generic-password -a "$USER" -s ups-commish-api-key -w "$COMMISH_KEY"
  unset COMMISH_KEY
  echo "✓ stored in Keychain"
fi

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✓ loaded launchd job '$LABEL' — ticks every 5 min, logs at /tmp/ups_auction_poll.log"
echo "  first tick runs immediately (RunAtLoad); check: tail -f /tmp/ups_auction_poll.log"
