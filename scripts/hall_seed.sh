#!/usr/bin/env bash
# Seed UPS League Hall with the queued proposals as DRAFTS.
#
# Usage:
#   COMMISH_API_KEY=<your-key> ./scripts/hall_seed.sh                # post all to default worker URL
#   COMMISH_API_KEY=<key> WORKER_URL=https://... ./scripts/hall_seed.sh
#   COMMISH_API_KEY=<key> ./scripts/hall_seed.sh path/to/seed.json   # custom seed file
#
# Each proposal is POSTed as a draft. Use the Hall admin page to review
# and Publish (which posts to Discord and opens responses).

set -eu -o pipefail

WORKER_URL="${WORKER_URL:-https://upsmflproduction.keith-creelman.workers.dev}"
SEED_FILE="${1:-$(cd "$(dirname "$0")" && pwd)/hall_seed_2026-05.json}"

if [ -z "${COMMISH_API_KEY:-}" ]; then
  echo "ERROR: COMMISH_API_KEY env var is required." >&2
  exit 1
fi
if [ ! -f "$SEED_FILE" ]; then
  echo "ERROR: seed file not found: $SEED_FILE" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required." >&2
  exit 1
fi

count=$(jq 'length' "$SEED_FILE")
echo "Seeding $count proposals from $SEED_FILE → $WORKER_URL"
echo

ok=0
fail=0
for i in $(seq 0 $((count - 1))); do
  payload=$(jq -c ".[$i]" "$SEED_FILE")
  id=$(echo "$payload" | jq -r '.id')
  title=$(echo "$payload" | jq -r '.title')
  printf "  [%2d/%d] %-46s " "$((i + 1))" "$count" "$id"
  resp=$(curl -sS -X POST "$WORKER_URL/admin/hall/proposals" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Auth: $COMMISH_API_KEY" \
    --data "$payload")
  if echo "$resp" | jq -e '.ok == true' >/dev/null 2>&1; then
    action=$(echo "$resp" | jq -r '.action')
    echo "✓ $action"
    ok=$((ok + 1))
  else
    echo "✗ FAILED"
    echo "      $resp" | head -c 400
    echo
    fail=$((fail + 1))
  fi
done

echo
echo "Done: $ok ok, $fail failed."
echo "Next: open the Hall admin page, review each draft, and Publish (which posts to Discord)."
