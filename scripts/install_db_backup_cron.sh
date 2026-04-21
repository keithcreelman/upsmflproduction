#!/usr/bin/env bash
# One-shot installer for the nightly mfl_database.db backup job.
#
# Copies backup_mfl_db.sh to a stable home-dir location (no dependency
# on a specific repo worktree), generates a launchd plist pointing at
# that path, loads it, and runs it once to verify.
#
# Reinstall-safe: unloads any previous instance before loading the new.

set -euo pipefail

SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/backup_mfl_db.sh"
SCRIPT_DST="$HOME/Library/Scripts/upsmfl-backup-db.sh"
PLIST_DST="$HOME/Library/LaunchAgents/com.upsmfl.db-backup.plist"
LABEL="com.upsmfl.db-backup"
LOG_PATH="$HOME/Library/Logs/upsmfl-db-backup.log"

if [ ! -f "$SCRIPT_SRC" ]; then
  echo "ERROR: $SCRIPT_SRC not found. Run this from the repo's scripts/ dir." >&2
  exit 1
fi

mkdir -p "$(dirname "$SCRIPT_DST")" "$(dirname "$PLIST_DST")" "$(dirname "$LOG_PATH")"
cp -f "$SCRIPT_SRC" "$SCRIPT_DST"
chmod +x "$SCRIPT_DST"
echo "✓ installed script → $SCRIPT_DST"

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
    <string>$SCRIPT_DST</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>15</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_PATH</string>
  <key>StandardErrorPath</key><string>$LOG_PATH</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF
echo "✓ wrote plist → $PLIST_DST"

# Unload any previous version before loading (safe to fail silently)
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✓ loaded launchd job '$LABEL'"

# Sanity-run once to prove the script + DB source work.
echo ""
echo "=== Smoke test (running backup now) ==="
"$SCRIPT_DST"
echo ""
echo "Installed. Nightly backup will run at 03:15 local. Log: $LOG_PATH"
echo "Unload later with: launchctl unload $PLIST_DST"
