#!/usr/bin/env bash
# One-shot installer for the weekly live-season D1 sync (direct from MFL,
# no local-DB dependency — see sync_live_season_weekly.sh).
#
# Unlike install_d1_sync_cron.sh, this does NOT stage a standalone copy of
# the Python sync script: sync_live_season_from_mfl_to_d1.py resolves
# worker/wrangler.toml relative to its own location (3 parents up) to find
# the D1 binding, so it must run from inside a real checkout of this repo.
# Only the lightweight bash wrapper is staged; it always invokes the
# checkout at $UPSMFL_REPO_ROOT (default: ~/Code/MFL/upsmflproduction, the
# main checkout — NOT a worktree, which may not persist). Re-running this
# installer after `git pull` on main is not required: the wrapper reads the
# .py fresh out of the checkout every time it fires, so a merged
# improvement to the sync script is picked up automatically on the next
# Tuesday run.
# Reinstall-safe.

set -euo pipefail

REPO_SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER_SRC="$REPO_SCRIPTS_DIR/sync_live_season_weekly.sh"

WRAPPER_DST="$HOME/Library/Scripts/upsmfl-live-season-sync.sh"
PLIST_DST="$HOME/Library/LaunchAgents/com.upsmfl.live-season-sync.plist"
LABEL="com.upsmfl.live-season-sync"
LOG_PATH="$HOME/Library/Logs/upsmfl-live-season-sync.log"

if [ ! -f "$WRAPPER_SRC" ]; then
  echo "ERROR: missing required source file $WRAPPER_SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$WRAPPER_DST")" "$(dirname "$PLIST_DST")" "$(dirname "$LOG_PATH")"
cp -f "$WRAPPER_SRC" "$WRAPPER_DST" && chmod +x "$WRAPPER_DST"
echo "✓ installed wrapper -> $WRAPPER_DST"
echo "  (it will call \$UPSMFL_REPO_ROOT/pipelines/etl/scripts/sync_live_season_from_mfl_to_d1.py,"
echo "   default \$UPSMFL_REPO_ROOT = \$HOME/Code/MFL/upsmflproduction — the MAIN checkout,"
echo "   so this PR must be merged to main and pulled there before Tuesday's first real run.)"

cat > "$PLIST_DST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>$WRAPPER_DST</string>
  </array>
  <!-- Every Tuesday 01:00 local. The wrapper itself retries hourly (up to
       12x) if MFL's data hasn't landed/settled yet, so this single firing
       covers the whole "keep checking until populated" window. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>2</integer>
    <key>Hour</key><integer>1</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_PATH</string>
  <key>StandardErrorPath</key><string>$LOG_PATH</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF
echo "✓ wrote plist -> $PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✓ loaded launchd job '$LABEL'"

echo ""
echo "Installed. Runs every Tuesday at 01:00 local, retrying hourly (up to 12x)"
echo "until a new week's data shows up in MFL."
echo "Log: $LOG_PATH"
echo "Unload with: launchctl unload $PLIST_DST"
echo ""
echo "To smoke-test now without waiting: bash $WRAPPER_DST"
