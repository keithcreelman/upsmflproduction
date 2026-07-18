#!/usr/bin/env bash
# One drop-penalty tracker tick, driven from launchd.
#
# WHY THIS EXISTS: Cloudflare stopped invoking scheduled() on 2026-07-15
# (registration accepted, zero invocations). The auction poll got a launchd
# stand-in (auction_poll_tick.sh) but the DROP-PENALTY scan did NOT — it lived
# only in the dead cron, so no drop had its cap penalty auto-charged after the
# outage. Verified 2026-07-18: the only missed drops were taxi-squad cuts
# (cap-free, $0), so nothing real was lost — but a contracted (non-taxi) drop
# would slip through, which is unacceptable ("a drop is a drop must calculate
# regardless"). This restores it.
#
# WHAT IT DOES — mirrors the dead */5 cron's drop-tracker, in order:
#   1. scan-and-record : read MFL's FREE_AGENT transaction log (EVERY drop, any
#                        source — MFL's own Drop page, add/drop, or the UPS
#                        modal), compute §6/§D2 penalty, record new ones to D1.
#   2. post-mfl        : write owed cap penalties to MFL as salaryAdjustments
#                        (skips $0/exempt automatically).
#   3. post-discord    : announce each real penalty in the drops channel
#                        (skips $0/exempt — verified 2026-07-18).
# All three are idempotent (D1 dedup + discord_posted flag), so re-running is a
# cheap no-op when there are no new drops.
#
# The key lives in macOS Keychain (same pattern as auction_poll_tick.sh — never
# in the plist, this file, or the log):
#   security add-generic-password -a "$USER" -s ups-commish-api-key -w
set -euo pipefail

WORKER_BASE="https://upsmflproduction.keith-creelman.workers.dev"
LEAGUE_ID="74598"
YEAR="2026"

APIKEY="$(security find-generic-password -a "$USER" -s ups-commish-api-key -w 2>/dev/null || true)"
if [ -z "$APIKEY" ]; then
  echo "$(date -u '+%F %T') no keychain item 'ups-commish-api-key' — run the installer" >&2
  exit 1
fi

ts() { date -u '+%F %T'; }
hit() {
  # $1 = path, $2 = json body. URL (with key) is NOT logged; the response is.
  curl -sS -m 55 -X POST \
    "${WORKER_BASE}${1}?L=${LEAGUE_ID}&YEAR=${YEAR}&APIKEY=${APIKEY}" \
    -H "Content-Type: application/json" -d "${2}" \
    || echo '{"ok":false,"error":"curl_failed"}'
}

# 7-day lookback so a multi-tick outage still catches up; scan is dedup'd in D1.
echo "$(ts) scan: $(hit /admin/drops/scan-and-record '{"season":"'"${YEAR}"'","league_id":"'"${LEAGUE_ID}"'","days":7}')"
echo "$(ts) mfl:  $(hit /admin/drops/post-mfl '{"season":"'"${YEAR}"'","league_id":"'"${LEAGUE_ID}"'"}')"
echo "$(ts) disc: $(hit /admin/drops/post-discord '{"season":"'"${YEAR}"'","league_id":"'"${LEAGUE_ID}"'","target":"prod","limit":20}')"
