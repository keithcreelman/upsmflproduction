#!/usr/bin/env bash
# Weekly live-season D1 sync — direct from MFL, no local-DB dependency.
#
# Fires once via launchd (Tuesday 01:00 local, ~2h after MNF typically
# wraps). Stat corrections can still trickle in Tuesday morning, so this
# doesn't just run once: it re-runs the sync(s) hourly, comparing the max
# played week each script found against the last week it successfully
# recorded, and stops as soon as EVERY script has caught up to a new week
# (idempotent either way — re-running with no new week just rewrites the
# same data).
#
# Runs two scripts (Keith 2026-09-16: "tackle src_weekly next"), each with
# its OWN state file since they can (rarely) disagree on "played weeks" for
# a given hour if one of MFL's exports settles before the other:
#   - standings : src_franchises/src_schedule/src_standings/...
#   - weekly    : src_weekly (per-player-week fantasy score)
# Add a new script by adding one entry to LABELS/PATHS below (same index).
#
# Indexed (parallel) arrays, not `declare -A`: launchd runs this via plain
# /bin/bash (macOS system bash, 3.2), which has no associative arrays.
#
# SEASON is hardcoded — bump it once a year when the new MFL season starts.

set -uo pipefail

SEASON="${UPSMFL_LIVE_SYNC_SEASON:-2026}"
REPO_ROOT="${UPSMFL_REPO_ROOT:-$HOME/Code/MFL/upsmflproduction}"
# Overrides let the launchd install stage scripts standalone (no git
# checkout needed) without editing this file.
STANDINGS_SCRIPT="${UPSMFL_LIVE_SYNC_SCRIPT:-$REPO_ROOT/pipelines/etl/scripts/sync_live_season_from_mfl_to_d1.py}"
WEEKLY_SCRIPT="${UPSMFL_LIVE_WEEKLY_SCRIPT:-$REPO_ROOT/pipelines/etl/scripts/sync_live_weekly_scores_to_d1.py}"
STATE_DIR="$HOME/Library/Caches/upsmfl-live-sync"
MAX_ATTEMPTS=12   # hourly from 01:00 -> covers through ~13:00 before giving up

LABELS=("standings" "weekly")
PATHS=("$STANDINGS_SCRIPT" "$WEEKLY_SCRIPT")
N=${#LABELS[@]}

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p "$STATE_DIR"

i=0
while [ $i -lt $N ]; do
  if [ ! -f "${PATHS[$i]}" ]; then
    log "ERROR: sync script not found at ${PATHS[$i]} (UPSMFL_REPO_ROOT wrong?)"
    exit 1
  fi
  i=$((i + 1))
done

LAST_WEEK=()
DONE_TODAY=()
i=0
while [ $i -lt $N ]; do
  state_file="$STATE_DIR/last_week_${LABELS[$i]}_${SEASON}.txt"
  LAST_WEEK[$i]=$(cat "$state_file" 2>/dev/null || echo 0)
  DONE_TODAY[$i]=0
  log "${LABELS[$i]}: last recorded max_week=${LAST_WEEK[$i]}"
  i=$((i + 1))
done

overall_rc=0
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  log "attempt $attempt/$MAX_ATTEMPTS"
  all_done=1
  i=0
  while [ $i -lt $N ]; do
    label="${LABELS[$i]}"
    if [ "${DONE_TODAY[$i]}" = "1" ]; then
      i=$((i + 1)); continue
    fi
    all_done=0
    state_file="$STATE_DIR/last_week_${label}_${SEASON}.txt"
    out=$(python3 "${PATHS[$i]}" --season "$SEASON" 2>&1)
    rc=$?
    echo "$out"
    cur_week=$(echo "$out" | grep -o 'max_week=[0-9]*' | tail -1 | cut -d= -f2)
    if [ $rc -ne 0 ] || [ -z "$cur_week" ]; then
      log "$label: sync failed or produced no parseable result this attempt (rc=$rc)"
      overall_rc=1
    elif [ "$cur_week" -gt "${LAST_WEEK[$i]}" ]; then
      echo "$cur_week" > "$state_file"
      LAST_WEEK[$i]=$cur_week
      DONE_TODAY[$i]=1
      log "$label: new week $cur_week synced — done, no more retries needed today"
    else
      log "$label: no new week yet (still at ${LAST_WEEK[$i]}) — MFL/stat corrections may not be posted yet"
    fi
    i=$((i + 1))
  done

  if [ "$all_done" = "1" ]; then
    log "all scripts caught up — exiting"
    exit 0
  fi
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    log "sleeping 1h before retry"
    sleep 3600
  fi
done

i=0
while [ $i -lt $N ]; do
  if [ "${DONE_TODAY[$i]}" != "1" ]; then
    log "gave up on ${LABELS[$i]} after $MAX_ATTEMPTS hourly attempts without a new week beyond ${LAST_WEEK[$i]}"
    overall_rc=1
  fi
  i=$((i + 1))
done
exit $overall_rc
