#!/usr/bin/env bash
# Weekly live-season D1 sync — direct from MFL, no local-DB dependency.
#
# Two kinds of firing (scripts/install_live_season_sync_cron.sh):
#
#   Tuesday 01:00 local -- "await-new-week". MNF has usually wrapped ~2h
#     earlier; MFL's export may still be settling, so this re-runs the sync(s)
#     hourly until EVERY script has caught up to a new week.
#   Thursday + Friday 08:00 local -- "refresh". Elias's official stat changes
#     land in MFL Wednesday night or just after midnight (2026 weeks 1-4: Wed
#     10:49 PM, Thu 12:10 AM, Wed 10:25 PM, Wed 11:32 PM ET), days AFTER the
#     Tuesday run. One pass: re-sync if MFL's scores moved, else exit 0.
#
# WHY THE FINGERPRINT (2026-10-08). The only state used to be "highest week
# synced". Week 4's correction moved Eric Martel 251.2 -> 250.2, below Shawn
# Blake's 250.9: MFL's all-play became Martel 34-10, Blake 32-12, but D1 (and
# /api/standings, and every standings page) kept 35-9 and 31-13, because a
# correction doesn't change the week number and nothing fired after Tuesday.
# Each script now prints SYNC_FINGERPRINT=<hash of exactly what MFL reported>;
# the state file holds "<max_week> <fingerprint>", and a run counts as caught
# up when it finds a new week OR a new fingerprint. The scripts are passed
# --skip-if-fingerprint so an unchanged refresh writes nothing.
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
# checkout needed) without editing this file, and let the tests drive it.
STANDINGS_SCRIPT="${UPSMFL_LIVE_SYNC_SCRIPT:-$REPO_ROOT/pipelines/etl/scripts/sync_live_season_from_mfl_to_d1.py}"
WEEKLY_SCRIPT="${UPSMFL_LIVE_WEEKLY_SCRIPT:-$REPO_ROOT/pipelines/etl/scripts/sync_live_weekly_scores_to_d1.py}"
STATE_DIR="${UPSMFL_LIVE_SYNC_STATE_DIR:-$HOME/Library/Caches/upsmfl-live-sync}"
MAX_ATTEMPTS="${UPSMFL_LIVE_SYNC_MAX_ATTEMPTS:-12}"   # hourly from 01:00 -> covers through ~13:00
RETRY_SLEEP="${UPSMFL_LIVE_SYNC_RETRY_SLEEP:-3600}"
MODE="${UPSMFL_LIVE_SYNC_MODE:-}"
if [ -z "$MODE" ]; then
  if [ "$(date +%u)" = "2" ]; then MODE="await-new-week"; else MODE="refresh"; fi
fi
if [ "$MODE" = "refresh" ]; then MAX_ATTEMPTS=1; fi

LABELS=("standings" "weekly")
PATHS=("$STANDINGS_SCRIPT" "$WEEKLY_SCRIPT")
N=${#LABELS[@]}

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# node/npm/npx on this machine are mise shims (~/.local/share/mise/shims/npx
# -> /opt/homebrew/bin/mise), not real binaries in /opt/homebrew/bin itself.
# mise's PATH injection (`eval "$(mise activate zsh)"`) lives only in
# ~/.zshrc; launchd invokes this wrapper via `/bin/bash -lc`, and bash never
# sources a zsh rc file, so every real firing (first one: 2026-09-22 01:00)
# failed at the first `npx wrangler ...` call with FileNotFoundError: 'npx' —
# 12/12 hourly attempts, both scripts, every time, so D1 sat on week-1 data
# through week 2 (Keith reported stale standings on mobile 2026-09-22).
# (This fix was applied to the INSTALLED copy only; it is carried back into
# the repo here so a reinstall doesn't undo it.)
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
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
LAST_FP=()
DONE_TODAY=()
i=0
while [ $i -lt $N ]; do
  state_file="$STATE_DIR/last_week_${LABELS[$i]}_${SEASON}.txt"
  w=0; fp=""
  if [ -f "$state_file" ]; then read -r w fp < "$state_file" || true; fi
  LAST_WEEK[$i]=${w:-0}
  LAST_FP[$i]=${fp:-}
  DONE_TODAY[$i]=0
  log "${LABELS[$i]}: last recorded max_week=${LAST_WEEK[$i]} fingerprint=${LAST_FP[$i]:-<none>} (mode=$MODE)"
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
    if [ -n "${LAST_FP[$i]}" ]; then
      out=$(python3 "${PATHS[$i]}" --season "$SEASON" --skip-if-fingerprint "${LAST_FP[$i]}" 2>&1)
    else
      out=$(python3 "${PATHS[$i]}" --season "$SEASON" 2>&1)
    fi
    rc=$?
    echo "$out"
    cur_week=$(echo "$out" | grep -o 'max_week=[0-9]*' | tail -1 | cut -d= -f2)
    cur_fp=$(echo "$out" | grep -o 'SYNC_FINGERPRINT=[^[:space:]]*' | tail -1 | cut -d= -f2-)
    if [ $rc -ne 0 ] || [ -z "$cur_week" ]; then
      log "$label: sync failed or produced no parseable result this attempt (rc=$rc)"
      overall_rc=1
    elif [ "$cur_week" -gt "${LAST_WEEK[$i]}" ]; then
      echo "$cur_week $cur_fp" > "$state_file"
      LAST_WEEK[$i]=$cur_week; LAST_FP[$i]=$cur_fp; DONE_TODAY[$i]=1
      log "$label: new week $cur_week synced — done, no more retries needed today"
    elif [ -n "$cur_fp" ] && [ "$cur_fp" != "${LAST_FP[$i]}" ]; then
      echo "$cur_week $cur_fp" > "$state_file"
      LAST_FP[$i]=$cur_fp; DONE_TODAY[$i]=1
      log "$label: MFL's scores changed inside week(s) already synced (stat corrections) — re-synced through week $cur_week"
    elif [ "$MODE" = "refresh" ]; then
      DONE_TODAY[$i]=1
      log "$label: no change since the last sync (week ${LAST_WEEK[$i]}) — nothing to write"
    else
      log "$label: no new week yet (still at ${LAST_WEEK[$i]})"
    fi
    i=$((i + 1))
  done

  remaining=0
  i=0
  while [ $i -lt $N ]; do
    if [ "${DONE_TODAY[$i]}" != "1" ]; then remaining=$((remaining + 1)); fi
    i=$((i + 1))
  done
  if [ "$all_done" = "1" ] || [ "$remaining" = "0" ]; then
    log "all scripts caught up — exiting"
    exit 0
  fi
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    log "sleeping ${RETRY_SLEEP}s before retry"
    sleep "$RETRY_SLEEP"
  fi
done

i=0
while [ $i -lt $N ]; do
  if [ "${DONE_TODAY[$i]}" != "1" ]; then
    log "gave up on ${LABELS[$i]} after $MAX_ATTEMPTS attempt(s) without a new week beyond ${LAST_WEEK[$i]}"
    overall_rc=1
  fi
  i=$((i + 1))
done
exit $overall_rc
