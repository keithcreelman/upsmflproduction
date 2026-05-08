#!/usr/bin/env bash
# Seed a Discord round into D1 — round metadata + 5 proposals + owner list.
# For Phase 2 SOLO TEST: only Keith is in the owner list.
#
# Usage:
#   COMMISH_API_KEY=<key> KEITH_DISCORD_USER_ID=<your-id> \
#     ./scripts/discord_seed_round.sh
#
# Optional overrides:
#   ROUND_ID=spring-2026
#   ROUND_TITLE="UPS Spring 2026 — 5 items for review"
#   DRAFT_DATE_UTC=2026-08-15T17:00:00Z
#   WORKER_URL=https://upsmflproduction.keith-creelman.workers.dev
#   PROPOSALS_FILE=scripts/hall_seed_2026-05.json   # the 5 proposals from your earlier seed
#
# Idempotent — re-run to update round metadata or proposal copy.

set -eu -o pipefail

: "${COMMISH_API_KEY:?COMMISH_API_KEY env var required}"
: "${KEITH_DISCORD_USER_ID:?KEITH_DISCORD_USER_ID env var required (the ID from your /hall ping)}"

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

# Phase 2 SOLO TEST scope: 5 vote items. Realignment is bundled into one item
# (captain-based draft + rolling 3-year All-Play together), per Keith's framing.
KEEP_IDS='[
  "realignment-captain-draft-2026",
  "dynasty-pot-50-dues-3year-prize",
  "taxi-squad-flexibility-temporary-callups",
  "salary-depreciation-true-prorated",
  "tagging-early-lock-in-tradeable"
]'

# Compute voting_deadline_utc = draft_date - 7 days
DRAFT_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$DRAFT_DATE_UTC" "+%s" 2>/dev/null || gdate -d "$DRAFT_DATE_UTC" +%s)
VOTING_DEADLINE_EPOCH=$((DRAFT_EPOCH - 7*24*3600))
SUBMISSION_CLOSES_EPOCH=$((VOTING_DEADLINE_EPOCH - 14*24*3600))
VOTING_DEADLINE_UTC=$(date -u -r "$VOTING_DEADLINE_EPOCH" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || gdate -u -d "@$VOTING_DEADLINE_EPOCH" "+%Y-%m-%dT%H:%M:%SZ")
SUBMISSION_CLOSES_UTC=$(date -u -r "$SUBMISSION_CLOSES_EPOCH" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || gdate -u -d "@$SUBMISSION_CLOSES_EPOCH" "+%Y-%m-%dT%H:%M:%SZ")

echo "Round:      ${ROUND_ID}"
echo "Title:      ${ROUND_TITLE}"
echo "Draft:      ${DRAFT_DATE_UTC}"
echo "Voting:     closes ${VOTING_DEADLINE_UTC}"
echo "Submission: closes ${SUBMISSION_CLOSES_UTC}"
echo "Owners:     1 (you, ${KEITH_DISCORD_USER_ID})"
echo "Mode:       TEST-ONLY"
echo

# Build the request body: filter PROPOSALS_FILE down to KEEP_IDS,
# then assemble round + owners.
# In TEST-ONLY mode, override pass_yes_count → 1 for every proposal so the
# auto-close logic resolves cleanly with a single voter (1 YES = pass,
# 1 NO = reject; abstain leaves the vote open).
REQ_BODY=$(jq -n \
  --argjson keep "$KEEP_IDS" \
  --arg round_id "$ROUND_ID" \
  --arg title "$ROUND_TITLE" \
  --arg draft_date "$DRAFT_DATE_UTC" \
  --arg voting_deadline "$VOTING_DEADLINE_UTC" \
  --arg submission_closes "$SUBMISSION_CLOSES_UTC" \
  --arg keith_id "$KEITH_DISCORD_USER_ID" \
  --slurpfile all "$PROPOSALS_FILE" \
  '{
    round: {
      round_id: $round_id,
      title: $title,
      draft_date_utc: $draft_date,
      voting_deadline_utc: $voting_deadline,
      proposal_submission_closes_at: $submission_closes,
      test_only: true,
      started_by: "commish"
    },
    proposals: ($keep | map(. as $id | ($all[0] | map(select(.id == $id)) | .[0])) | map(select(. != null)) | map(. + { pass_yes_count: 1 })),
    owners: [
      { discord_user_id: $keith_id, display_name: "Keith (commish)" }
    ]
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
  echo "Now in Discord: /hall start round_id:${ROUND_ID}"
  echo "(You'll receive a DM from the bot with a [▶ Start] button.)"
else
  echo "✗ Seed failed:"
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
  exit 1
fi
