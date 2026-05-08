#!/usr/bin/env bash
# Test-fire summary threads for every proposal in the May 2026 round.
# Posts to whatever channel DISCORD_RULES_CHANNEL_ID points at.
# Each fire generates: 1 announcement message + 1 thread + 1 AI impact analysis post.
# Does NOT mutate round state — these are pure preview fires.
#
# Usage:
#   COMMISH_API_KEY=<key> ./scripts/hall_test_summaries.sh
#
# Optional: WORKER_URL (default: prod URL), SLEEP_BETWEEN (default 6 sec).

set -eu -o pipefail

WORKER_URL="${WORKER_URL:-https://upsmflproduction.keith-creelman.workers.dev}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-6}"

if [ -z "${COMMISH_API_KEY:-}" ]; then
  echo "ERROR: COMMISH_API_KEY env var required" >&2
  exit 1
fi

# Realistic tallies as if each proposal had passed in a 12-owner league.
# MYM is discussion-only — outcome auto-converts to 'discussion' regardless of input.
declare -a items=(
  "realignment-captain-draft-2026|passed|8|2|2"
  "tagging-early-lock-in-tradeable|passed|7|3|2"
  "salary-depreciation-true-prorated|passed|9|1|2"
  "taxi-squad-flexibility-temporary-callups|passed|10|1|1"
  "dynasty-pot-50-dues-3year-prize|passed|9|2|1"
  "mym-end-of-season-restriction|passed|8|2|2"
)

i=0
total=${#items[@]}
for entry in "${items[@]}"; do
  i=$((i + 1))
  IFS='|' read -r pid outcome yes no abstain <<< "$entry"
  echo "[$i/$total] Firing summary for: $pid (outcome=$outcome  $yes-$no-$abstain)"
  resp=$(curl -sS -X POST "$WORKER_URL/admin/hall/test-summary" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Auth: $COMMISH_API_KEY" \
    --data "$(jq -n \
      --arg pid "$pid" \
      --arg outcome "$outcome" \
      --argjson yes "$yes" --argjson no "$no" --argjson abstain "$abstain" \
      '{proposal_id: $pid, outcome: $outcome, yes: $yes, no: $no, abstain: $abstain}')")
  if echo "$resp" | jq -e '.ok == true' >/dev/null 2>&1; then
    msg=$(echo "$resp" | jq -r '.message_id')
    thr=$(echo "$resp" | jq -r '.thread_id')
    echo "       ✓ posted (message=$msg  thread=$thr)"
  else
    echo "       ✗ FAILED: $resp"
  fi
  if [ "$i" -lt "$total" ]; then
    echo "       sleeping ${SLEEP_BETWEEN}s before next..."
    sleep "$SLEEP_BETWEEN"
  fi
done

echo
echo "Done. Check your rules channel ($WORKER_URL DISCORD_RULES_CHANNEL_ID) for $total announcement messages, each with a discussion thread."
