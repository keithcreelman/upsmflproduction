#!/usr/bin/env bash
# Fire the FA-auction report (9 AM verdict / 9 PM warning), driven from launchd
# at 9:00 and 21:00 local (this Mac runs ET, which is what the league runs on).
# Stand-in for the dead Cloudflare "0 1,2,13,14 * * *" cron (2026-07-15).
#
# Everything unsafe is handled worker-side, so this script can stay dumb:
#   - mode derives from the ET clock (9:00 -> morning, 21:00 -> evening)
#   - a stale bid ledger DEFERS the verdict + DMs the commish, never posts wrong
#   - the (mode, day) post claim means a revived CF cron + this tick = ONE post
#   - kill switches (AUCTION_NIGHTLY_NUDGE_ENABLED etc.) are respected; no force
# Key from macOS Keychain at runtime — never in this file, the plist, or the log.
set -euo pipefail

WORKER_BASE="https://upsmflproduction.keith-creelman.workers.dev"
LEAGUE_ID="74598"

APIKEY="$(security find-generic-password -a "$USER" -s ups-commish-api-key -w 2>/dev/null || true)"
if [ -z "$APIKEY" ]; then
  echo "$(date -u '+%F %T') no keychain item 'ups-commish-api-key' — run the installer" >&2
  exit 1
fi

RESP="$(curl -sS -m 120 -X POST \
  "${WORKER_BASE}/admin/auction/run-nightly-nudge?L=${LEAGUE_ID}&live=1&APIKEY=${APIKEY}" || echo '{"ok":false,"error":"curl_failed"}')"
echo "$(date -u '+%F %T') ${RESP}"
