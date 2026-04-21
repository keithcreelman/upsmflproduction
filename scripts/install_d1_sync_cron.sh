#!/usr/bin/env bash
# One-shot installer for the nightly D1 sync job.
#
# Stages everything needed to run the loader as a standalone launchd
# job — no git checkout dependency. Copies:
#   * sync_d1.sh               → ~/Library/Scripts/upsmfl-sync-d1.sh
#   * load_local_to_d1.py      → ~/Library/Scripts/upsmfl-load-local-to-d1.py
#   * worker/wrangler.toml     → ~/Library/Scripts/upsmfl-wrangler.toml
# The wrapper script invokes the loader with --wrangler-config so
# wrangler finds its config regardless of cwd, and with --tmp-dir
# pointing into a home-dir scratch location.
# Reinstall-safe.

set -euo pipefail

REPO_SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$REPO_SCRIPTS_DIR/.." && pwd)"

WRAPPER_SRC="$REPO_SCRIPTS_DIR/sync_d1.sh"
LOADER_SRC="$REPO_SCRIPTS_DIR/load_local_to_d1.py"
WRANGLER_SRC="$REPO_ROOT/worker/wrangler.toml"

WRAPPER_DST="$HOME/Library/Scripts/upsmfl-sync-d1.sh"
LOADER_DST="$HOME/Library/Scripts/upsmfl-load-local-to-d1.py"
WRANGLER_DST="$HOME/Library/Scripts/upsmfl-wrangler.toml"
TMP_DST="$HOME/Library/Caches/upsmfl-d1-load-tmp"

PLIST_DST="$HOME/Library/LaunchAgents/com.upsmfl.d1-sync.plist"
LABEL="com.upsmfl.d1-sync"
LOG_PATH="$HOME/Library/Logs/upsmfl-d1-sync.log"

for f in "$WRAPPER_SRC" "$LOADER_SRC" "$WRANGLER_SRC"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: missing required source file $f" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$WRAPPER_DST")" "$(dirname "$PLIST_DST")" "$(dirname "$LOG_PATH")" "$TMP_DST"
cp -f "$WRAPPER_SRC" "$WRAPPER_DST" && chmod +x "$WRAPPER_DST"
cp -f "$LOADER_SRC" "$LOADER_DST" && chmod +x "$LOADER_DST"
cp -f "$WRANGLER_SRC" "$WRANGLER_DST"
echo "✓ installed wrapper → $WRAPPER_DST"
echo "✓ installed loader  → $LOADER_DST"
echo "✓ installed config  → $WRANGLER_DST"
echo "✓ scratch dir       → $TMP_DST"

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
  <!-- 03:45 local — 30 min after DB backup (03:15). -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>45</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_PATH</string>
  <key>StandardErrorPath</key><string>$LOG_PATH</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF
echo "✓ wrote plist → $PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✓ loaded launchd job '$LABEL'"

echo ""
echo "Installed. Nightly D1 sync runs at 03:45 local."
echo "Log: $LOG_PATH"
echo "Unload with: launchctl unload $PLIST_DST"
echo ""
echo "To smoke-test now without waiting: bash $WRAPPER_DST"
