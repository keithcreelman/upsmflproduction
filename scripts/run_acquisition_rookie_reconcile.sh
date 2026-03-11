#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE="${UPS_ACQ_WORKER_URL:-https://upsmflproduction.keith-creelman.workers.dev}"
CURRENT_SEASON="${CURRENT_SEASON:-$(date +%Y)}"
RECON_LEAGUES="${UPS_ACQ_RECON_LEAGUES:-74598}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for rookie reconcile."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for rookie reconcile."
  exit 1
fi

IFS=',' read -r -a league_ids <<< "$RECON_LEAGUES"

for raw_league in "${league_ids[@]}"; do
  league_id="$(echo "$raw_league" | tr -cd '0-9')"
  if [[ -z "$league_id" ]]; then
    continue
  fi

  live_url="${WORKER_BASE%/}/acquisition-hub/rookie-draft/live?L=${league_id}&YEAR=${CURRENT_SEASON}&NO_CACHE=1"
  live_json="$(curl -fsS "$live_url" || true)"
  if [[ -z "$live_json" ]]; then
    continue
  fi

  if ! echo "$live_json" | jq -e '
    .ok == true and
    .stale == false and
    (
      ((.current_pick.round // 0) > 0 and (.current_pick.pick // 0) > 0) or
      ((.live_board | length) > 0 and (.draft_status.message // "" | length) > 0)
    )
  ' >/dev/null 2>&1; then
    continue
  fi

  reconcile_url="${WORKER_BASE%/}/acquisition-hub/rookie-draft/reconcile-contracts?L=${league_id}&YEAR=${CURRENT_SEASON}"
  curl -fsS -X POST "$reconcile_url" >/dev/null || true
done
