#!/usr/bin/env bash
# One auction-poll tick, driven from launchd every 5 minutes.
#
# This exists because Cloudflare's cron triggers stopped being invoked on
# 2026-07-15 (registration accepted, zero invocations — confirmed from the
# dashboard, wrangler tail, and D1 write timestamps) and the */5 poll is the
# ONLY thing feeding ups_auction_bids, which the won-announcements, the
# 9 AM/9 PM reports, and the §F RULE 2 fine counts all read. The worker-side
# route this hits is serially idempotent and holds an advisory lock, so this
# tick is safe to run alongside the cron if/when Cloudflare revives it.
#
# The key lives in macOS Keychain (same pattern as the roast-bot watchdog —
# never in the plist, never in this file, never in the log):
#   security add-generic-password -a "$USER" -s ups-commish-api-key -w
set -euo pipefail

WORKER_BASE="https://upsmflproduction.keith-creelman.workers.dev"
LEAGUE_ID="74598"

APIKEY="$(security find-generic-password -a "$USER" -s ups-commish-api-key -w 2>/dev/null || true)"
if [ -z "$APIKEY" ]; then
  echo "$(date -u '+%F %T') no keychain item 'ups-commish-api-key' — run the installer" >&2
  exit 1
fi

# The key stays out of argv logging concerns by being the only secret and this
# being Keith's own machine; the response is logged, the URL is not.
RESP="$(curl -sS -m 55 -X POST \
  "${WORKER_BASE}/admin/auction/poll-now?L=${LEAGUE_ID}&APIKEY=${APIKEY}" || echo '{"ok":false,"error":"curl_failed"}')"
echo "$(date -u '+%F %T') ${RESP}"
