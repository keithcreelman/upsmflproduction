#!/usr/bin/env bash
# Install the scheduled UPS Center draft builder as a LaunchAgent.
#   --print-plist   print the plist and exit (DEFAULT; changes nothing)
#   --install       copy the wrapper and load the agent -- only after Keith approves the schedule
set -euo pipefail
LABEL="com.upsmfl.ups-center-auto"
DEST_SCRIPT="$HOME/Library/Scripts/upsmfl-ups-center-auto.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/upsmfl-ups-center-auto.log"
HERE="$(cd "$(dirname "$0")" && pwd)"
plist() {
cat <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>$DEST_SCRIPT</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
}
case "${1:---print-plist}" in
  --print-plist) plist ;;
  --install)
    mkdir -p "$(dirname "$DEST_SCRIPT")" "$(dirname "$PLIST")"
    cp "$HERE/ups_center_auto.sh" "$DEST_SCRIPT" && chmod +x "$DEST_SCRIPT"
    plist > "$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed $LABEL (Tue 10:00, Wed 10:00, Thu 09:00, Fri 09:00, and at login to catch up); log: $LOG" ;;
  *) echo "usage: $0 [--print-plist|--install]" >&2; exit 2 ;;
esac
