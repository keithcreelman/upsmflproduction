#!/usr/bin/env bash
# Nightly D1 source-table refresh.
#
# Runs load_local_to_d1.py (installed alongside this script in
# ~/Library/Scripts/) against the remote D1 database so Worker
# endpoints that read src_* tables (most importantly
# /api/player-bundle) reflect the latest contracts, transactions,
# weekly scores, and draft results from mfl_database.db.
#
# Schedule: 03:45 local — 30 minutes after the local DB backup
# (03:15) so the D1 sync reads the same consistent snapshot.
#
# The Python loader is idempotent (DELETE-then-INSERT per table with
# INSERT OR IGNORE for rare dupes) and retries each chunk up to 4
# times for transient D1 errors.
#
# The loader expects a `worker/` dir as its cwd ancestor (for
# wrangler.toml). We pass a checkout path via UPSMFL_WORKER_DIR so
# the loader can cd there to invoke wrangler, even though the
# loader itself is the copy in ~/Library/Scripts/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOADER="${UPSMFL_LOADER:-$SCRIPT_DIR/upsmfl-load-local-to-d1.py}"
WRANGLER_CONFIG="${UPSMFL_WRANGLER_CONFIG:-$SCRIPT_DIR/upsmfl-wrangler.toml}"
TMP_DIR="${UPSMFL_TMP_DIR:-$HOME/Library/Caches/upsmfl-d1-load-tmp}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

for f in "$LOADER" "$WRANGLER_CONFIG"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: missing required file $f" >&2
    echo "Re-run scripts/install_d1_sync_cron.sh from the repo." >&2
    exit 1
  fi
done

log "starting D1 sync"
log "  loader:  $LOADER"
log "  config:  $WRANGLER_CONFIG"
log "  tmpdir:  $TMP_DIR"

# PATH for launchd — node/npx live in /opt/homebrew/bin which isn't in
# launchd's default PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

python3 "$LOADER" \
  --wrangler-config "$WRANGLER_CONFIG" \
  --worker-cwd "$SCRIPT_DIR" \
  --tmp-dir "$TMP_DIR"
rc=$?
if [ $rc -eq 0 ]; then
  log "D1 sync finished ok"
else
  log "D1 sync failed with exit code $rc"
  exit $rc
fi
