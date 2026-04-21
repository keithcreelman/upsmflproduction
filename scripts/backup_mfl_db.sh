#!/usr/bin/env bash
# Local-DB disaster-recovery backup.
#
# The authoritative historical dataset (contracts, transactions, weekly
# scoring, draft history) lives in a SQLite DB at
#   /Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db
# Too big for git. This script makes a timestamped, compressed local
# copy AND — when R2 credentials are configured — also uploads it to
# the ups-mfl-backups bucket for off-device redundancy.
#
# Run manually or install as a launchd job (see
# scripts/install_db_backup_cron.sh for the one-shot installer).
#
# Local-copy switches:
#   DEST       backup directory (default: ~/Documents/mfl/backups/mfl_database)
#   KEEP_DAYS  retention in days (default: 30)
#
# R2 upload (optional — skipped silently if credentials are absent):
#   Looks for credentials file at ~/.config/r2/ups-mfl-backups.env.
#   That file must be 0600 and define:
#     R2_ACCESS_KEY_ID       — S3-compat access key for the R2 token
#     R2_SECRET_ACCESS_KEY   — S3-compat secret
#     R2_ACCOUNT_ID          — Cloudflare account id
#     R2_BUCKET              — default ups-mfl-backups
#   Uploads to db-backups/YYYY/MM/DD/mfl_database.<stamp>.sqlite.gz.

set -euo pipefail

SRC="/Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db"
DEST="${DEST:-$HOME/Documents/mfl/backups/mfl_database}"
KEEP_DAYS="${KEEP_DAYS:-30}"
R2_ENV_FILE="${R2_ENV_FILE:-$HOME/.config/r2/ups-mfl-backups.env}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if [ ! -f "$SRC" ]; then
  echo "ERROR: source DB not found at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
OUT="$DEST/mfl_database.$STAMP.sqlite"

# Consistent snapshot via sqlite3 .backup — safe even under concurrent writes.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SRC" ".backup '$OUT'"
else
  cp -p "$SRC" "$OUT"
fi

gzip -9 "$OUT"
OUT_GZ="$OUT.gz"
SIZE=$(du -h "$OUT_GZ" | awk '{print $1}')
log "wrote $OUT_GZ ($SIZE)"

# Retention sweep (local only)
find "$DEST" -name "mfl_database.*.sqlite.gz" -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
REMAINING=$(find "$DEST" -name "mfl_database.*.sqlite.gz" | wc -l | tr -d ' ')
log "retained $REMAINING snapshot(s) under $DEST"

# --- R2 upload (optional) -------------------------------------------------
upload_to_r2() {
  if [ ! -f "$R2_ENV_FILE" ]; then
    log "R2 env file not found ($R2_ENV_FILE) — skipping upload (local copy only)"
    return 0
  fi
  # shellcheck disable=SC1090
  set -a
  . "$R2_ENV_FILE"
  set +a
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID missing in $R2_ENV_FILE}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY missing in $R2_ENV_FILE}"
  : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID missing in $R2_ENV_FILE}"
  R2_BUCKET="${R2_BUCKET:-ups-mfl-backups}"

  local y m d key endpoint
  y=$(date -u +%Y); m=$(date -u +%m); d=$(date -u +%d)
  key="db-backups/$y/$m/$d/$(basename "$OUT_GZ")"
  endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

  if ! command -v aws >/dev/null 2>&1; then
    log "aws CLI not installed — skipping R2 upload. Install via: brew install awscli"
    log "(local copy is still written to $OUT_GZ)"
    return 0
  fi

  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="auto" \
    aws s3 cp "$OUT_GZ" "s3://${R2_BUCKET}/${key}" \
      --endpoint-url "$endpoint" --only-show-errors \
    && log "uploaded to r2://${R2_BUCKET}/${key}" \
    || { echo "WARN: R2 upload failed (local copy still intact at $OUT_GZ)" >&2; }
}

upload_to_r2
