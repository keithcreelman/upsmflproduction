#!/usr/bin/env bash
# Installs the launchd agent that fires the 9 AM / 9 PM FA-auction reports
# while Cloudflare's cron triggers are dead (2026-07-15 incident).
#
#   ./scripts/install_auction_reports_cron.sh          # install
#   ./scripts/install_auction_reports_cron.sh remove   # stop + uninstall
set -euo pipefail

LABEL="com.keith.mfl.auction-reports"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO_ROOT/scripts/scheduler/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "remove" ]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "✓ removed $LABEL"
  exit 0
fi

if ! security find-generic-password -a "$USER" -s ups-commish-api-key -w >/dev/null 2>&1; then
  echo "No keychain item 'ups-commish-api-key' — run ./scripts/install_auction_poll_cron.sh first" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✓ loaded launchd job '$LABEL' — fires 9:00 AM + 9:00 PM local, logs at /tmp/ups_auction_reports.log"
echo "  (no immediate run — this job posts to the league, so it only fires on schedule)"
