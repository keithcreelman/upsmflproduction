#!/usr/bin/env bash
# Weekly live-season D1 sync — direct from MFL, no local-DB dependency.
#
# Fires once via launchd (Tuesday 01:00 local, ~2h after MNF typically
# wraps). Stat corrections can still trickle in Tuesday morning, so this
# doesn't just run once: it re-runs the sync hourly, comparing the max
# played week it found against the last week we successfully recorded, and
# stops as soon as a NEW week shows up (idempotent either way — re-running
# with no new week just rewrites the same season data).
#
# Reinstall-safe: pipelines/etl/scripts/sync_live_season_from_mfl_to_d1.py
# always DELETE+INSERTs the whole season, so a stale re-run never leaves
# half-written rows.
#
# SEASON is hardcoded — bump it once a year when the new MFL season starts.

set -uo pipefail

SEASON="${UPSMFL_LIVE_SYNC_SEASON:-2026}"
REPO_ROOT="${UPSMFL_REPO_ROOT:-$HOME/Code/MFL/upsmflproduction}"
# UPSMFL_LIVE_SYNC_SCRIPT overrides with a direct path (the launchd install
# stages the .py standalone under ~/Library/Scripts, no git checkout needed).
SYNC_SCRIPT="${UPSMFL_LIVE_SYNC_SCRIPT:-$REPO_ROOT/pipelines/etl/scripts/sync_live_season_from_mfl_to_d1.py}"
STATE_DIR="$HOME/Library/Caches/upsmfl-live-sync"
STATE_FILE="$STATE_DIR/last_week_${SEASON}.txt"
MAX_ATTEMPTS=12   # hourly from 01:00 -> covers through ~13:00 before giving up

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p "$STATE_DIR"

if [ ! -f "$SYNC_SCRIPT" ]; then
  log "ERROR: sync script not found at $SYNC_SCRIPT (UPSMFL_REPO_ROOT wrong?)"
  exit 1
fi

last_week=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
log "starting weekly live sync for season $SEASON (last recorded max_week=$last_week)"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  log "attempt $attempt/$MAX_ATTEMPTS"
  out=$(python3 "$SYNC_SCRIPT" --season "$SEASON" 2>&1)
  rc=$?
  echo "$out"
  cur_week=$(echo "$out" | grep -o 'max_week=[0-9]*' | tail -1 | cut -d= -f2)

  if [ $rc -ne 0 ] || [ -z "$cur_week" ]; then
    log "sync failed or produced no parseable result this attempt (rc=$rc)"
  elif [ "$cur_week" -gt "$last_week" ]; then
    echo "$cur_week" > "$STATE_FILE"
    log "new week $cur_week synced (was $last_week) — done, no more retries needed today"
    exit 0
  else
    log "no new week yet (still at $last_week) — MFL/stat corrections may not be posted yet"
  fi

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    log "sleeping 1h before retry"
    sleep 3600
  fi
done

log "gave up after $MAX_ATTEMPTS hourly attempts without detecting a new week beyond $last_week"
exit 1
