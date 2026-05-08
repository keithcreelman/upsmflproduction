#!/usr/bin/env bash
# Seed the LIVE round with all 12 active owners.
#
# Pulls owners from remote D1 `discord_owners` (active_owner = 'Y'),
# loads the 5 proposals from scripts/hall_seed_2026-05.json,
# and POSTs to /admin/hall/discord-round/seed with test_only = false.
#
# This does NOT fire any DMs or threads — it only primes D1.
# DM fanout + thread creation only happens when you run
# `/rules start round_id:May2026` in Discord.
#
# Usage:
#   COMMISH_API_KEY=<key> ./scripts/discord_seed_round_prod.sh
#
# Optional overrides:
#   ROUND_ID=May2026
#   ROUND_TITLE="UPS rules — May 2026 round"
#   DRAFT_DATE_UTC=2026-08-15T17:00:00Z   (the worker re-derives this from
#                                          league_events.ups_rookieextension_deadline
#                                          on /rules start, so this is just a
#                                          placeholder seed value)
#   WORKER_URL=https://upsmflproduction.keith-creelman.workers.dev
#   PROPOSALS_FILE=scripts/hall_seed_2026-05.json
#
# Idempotent — re-running clears old responses/comments and resets the
# round to a fresh 'open' state.

set -eu -o pipefail

: "${COMMISH_API_KEY:?COMMISH_API_KEY env var required}"

WORKER_URL="${WORKER_URL:-https://upsmflproduction.keith-creelman.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROPOSALS_FILE="${PROPOSALS_FILE:-${SCRIPT_DIR}/hall_seed_2026-05.json}"
ROUND_ID="${ROUND_ID:-May2026}"
ROUND_TITLE="${ROUND_TITLE:-UPS rules — May 2026 round}"
DRAFT_DATE_UTC="${DRAFT_DATE_UTC:-2026-08-15T17:00:00Z}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq required (brew install jq)" >&2
  exit 1
fi
if [ ! -f "$PROPOSALS_FILE" ]; then
  echo "ERROR: proposals file not found: $PROPOSALS_FILE" >&2
  exit 1
fi
WORKER_DIR="$(cd "${SCRIPT_DIR}/../worker" && pwd)"

# 5 proposals, in the order they show up in Discord threads.
KEEP_IDS='[
  "realignment-captain-draft-2026",
  "dynasty-pot-50-dues-3year-prize",
  "taxi-squad-flexibility-temporary-callups",
  "salary-depreciation-true-prorated",
  "tagging-early-lock-in-tradeable"
]'

# Compute deadline timestamps. Note: the worker overrides these on
# /rules start using league_events.ups_rookieextension_deadline, so the
# values here are only relevant if that lookup fails.
DRAFT_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$DRAFT_DATE_UTC" "+%s" 2>/dev/null || gdate -d "$DRAFT_DATE_UTC" +%s)
VOTING_DEADLINE_EPOCH=$((DRAFT_EPOCH - 7*24*3600))
SUBMISSION_CLOSES_EPOCH=$((VOTING_DEADLINE_EPOCH - 14*24*3600))
VOTING_DEADLINE_UTC=$(date -u -r "$VOTING_DEADLINE_EPOCH" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || gdate -u -d "@$VOTING_DEADLINE_EPOCH" "+%Y-%m-%dT%H:%M:%SZ")
SUBMISSION_CLOSES_UTC=$(date -u -r "$SUBMISSION_CLOSES_EPOCH" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || gdate -u -d "@$SUBMISSION_CLOSES_EPOCH" "+%Y-%m-%dT%H:%M:%SZ")

# Pull active owners from remote D1.
echo "Fetching active owners from remote D1..."
OWNERS_JSON=$(cd "$WORKER_DIR" && npx wrangler d1 execute ups-mfl-db --remote --json \
  --command="SELECT discord_user_id, COALESCE(owner_name,'') AS owner_name, COALESCE(team_name,'') AS team_name, COALESCE(franchise_id,'') AS franchise_id FROM discord_owners WHERE active_owner = 'Y' ORDER BY franchise_id;" \
  | jq '[.[0].results[] | {
      discord_user_id: .discord_user_id,
      display_name: (if .owner_name != "" and .team_name != "" then "\(.owner_name) · \(.team_name)" elif .owner_name != "" then .owner_name else .team_name end),
      franchise_id: (if .franchise_id == "" then null else .franchise_id end)
    }]')

OWNER_COUNT=$(echo "$OWNERS_JSON" | jq 'length')
if [ "$OWNER_COUNT" -lt 1 ]; then
  echo "ERROR: no active owners found in discord_owners table" >&2
  exit 1
fi

echo
echo "Round:      ${ROUND_ID}"
echo "Title:      ${ROUND_TITLE}"
echo "Draft:      ${DRAFT_DATE_UTC} (worker overrides via league_events on /rules start)"
echo "Voting:     closes ${VOTING_DEADLINE_UTC}"
echo "Submission: closes ${SUBMISSION_CLOSES_UTC}"
echo "Owners:     ${OWNER_COUNT} (LIVE — every active owner)"
echo "Mode:       LIVE (test_only = false)"
echo
echo "Owners to be DMed when /rules start fires:"
echo "$OWNERS_JSON" | jq -r '.[] | "  - " + .display_name + " (" + .discord_user_id + ")"'
echo

# Confirm before submitting.
read -p "Proceed with seed? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

REQ_BODY=$(jq -n \
  --argjson keep "$KEEP_IDS" \
  --argjson owners "$OWNERS_JSON" \
  --arg round_id "$ROUND_ID" \
  --arg title "$ROUND_TITLE" \
  --arg draft_date "$DRAFT_DATE_UTC" \
  --arg voting_deadline "$VOTING_DEADLINE_UTC" \
  --arg submission_closes "$SUBMISSION_CLOSES_UTC" \
  --slurpfile all "$PROPOSALS_FILE" \
  '{
    round: {
      round_id: $round_id,
      title: $title,
      draft_date_utc: $draft_date,
      voting_deadline_utc: $voting_deadline,
      proposal_submission_closes_at: $submission_closes,
      test_only: false,
      started_by: "commish"
    },
    proposals: ($keep | map(. as $id | ($all[0] | map(select(.id == $id)) | .[0])) | map(select(. != null))),
    owners: $owners
  }')

echo "POSTing to ${WORKER_URL}/admin/hall/discord-round/seed ..."
RESPONSE=$(curl -sS -X POST "${WORKER_URL}/admin/hall/discord-round/seed" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Auth: ${COMMISH_API_KEY}" \
  --data "$REQ_BODY")

if echo "$RESPONSE" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "✓ Seeded:"
  echo "$RESPONSE" | jq .
  echo
  echo "Next: in Discord run  /rules start round_id:${ROUND_ID}"
  echo "(That's when the public threads + per-owner DMs actually fire.)"
else
  echo "✗ Seed failed:"
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
  exit 1
fi
