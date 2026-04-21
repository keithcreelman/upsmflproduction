#!/usr/bin/env bash
# Local-DB disaster-recovery backup.
#
# The authoritative historical dataset (contracts, transactions, weekly
# scoring, draft history) lives in a SQLite DB at
#   /Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db
# That file is too big for git. Until R2 is enabled (Phase 2 of the
# backup plan), this script makes a timestamped, compressed copy to a
# local backups folder — easy to also sync via iCloud / Dropbox / a
# USB drive for off-device redundancy.
#
# Run manually or install as a launchd job (see
# scripts/com.upsmfl.db-backup.plist for an example).
#
# Switches:
#   DEST       backup directory (default: ~/Documents/mfl/backups/mfl_database)
#   KEEP_DAYS  retention in days (default: 30)

set -euo pipefail

SRC="/Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db"
DEST="${DEST:-$HOME/Documents/mfl/backups/mfl_database}"
KEEP_DAYS="${KEEP_DAYS:-30}"

if [ ! -f "$SRC" ]; then
  echo "ERROR: source DB not found at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
OUT="$DEST/mfl_database.$STAMP.sqlite"

# Use sqlite3's .backup so we get a consistent snapshot even if something
# is writing to the DB during the copy. Falls back to cp if sqlite3 is absent.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SRC" ".backup '$OUT'"
else
  cp -p "$SRC" "$OUT"
fi

# Compress — typical ratio is ~4x; ~35MB raw -> ~8MB gz
gzip -9 "$OUT"
OUT_GZ="$OUT.gz"
SIZE=$(du -h "$OUT_GZ" | awk '{print $1}')
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] wrote $OUT_GZ ($SIZE)"

# Retention sweep — keep most recent KEEP_DAYS worth
find "$DEST" -name "mfl_database.*.sqlite.gz" -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
REMAINING=$(find "$DEST" -name "mfl_database.*.sqlite.gz" | wc -l | tr -d ' ')
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] retained $REMAINING snapshot(s) under $DEST"
