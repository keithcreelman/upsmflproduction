#!/usr/bin/env bash
# Off-platform watchdog: is Cloudflare actually RUNNING anything?
#
# WHY THIS EXISTS, and why it lives on Keith's Mac instead of in the worker:
# every alarm we had was inside the thing it was watching. The auction-poll
# watchdog rides Cloudflare's */2 cron, so when Cloudflare stopped invoking
# scheduled() entirely on 2026-07-15 (registration accepted, zero invocations)
# the alarm died with the patient. Same shape again on 2026-07-27: the
# "0 1,2,13,14 * * *" cron never fired, the 9 AM FA report never posted, and
# NOTHING said a word — it surfaced only because Keith asked.
#
# So this check runs off-platform and alerts Discord DIRECTLY with its own bot
# token. It never calls the worker to deliver a message, because a dead worker
# is precisely the case it has to survive. Three independent things fail it:
#
#   1. the worker is unreachable at all (curl fails / non-JSON)
#   2. cron_cf is stale  -> Cloudflare crons have stopped firing
#   3. a scheduled FA report is overdue -> that specific cron isn't firing
#
# Secrets come from macOS Keychain, never the plist and never this file:
#   security add-generic-password -a "$USER" -s ups-commish-api-key -w
#   security add-generic-password -a "$USER" -s discord_bot_token -w
set -uo pipefail

WORKER_BASE="https://upsmflproduction.keith-creelman.workers.dev"
LEAGUE_ID="74598"
STATE_DIR="${HOME}/.ups_cron_liveness"
mkdir -p "$STATE_DIR"

# Alert de-dup: one alert per condition per 30 min, so a multi-hour outage
# doesn't turn into a DM every 5 minutes.
REALERT_SEC=1800

APIKEY="$(security find-generic-password -a "$USER" -s ups-commish-api-key -w 2>/dev/null || true)"
BOT_TOKEN="$(security find-generic-password -a "$USER" -s discord_bot_token -w 2>/dev/null || true)"
# Both of Keith's Discord accounts — same list the worker uses.
COMMISH_IDS="621530026831118346 1057654821638897715"

log() { echo "$(date -u '+%F %T') $*"; }

if [ -z "$APIKEY" ] || [ -z "$BOT_TOKEN" ]; then
  log "missing keychain item (ups-commish-api-key / discord_bot_token) — run the installer"
  exit 1
fi

# DM every commish account directly via Discord's API. Deliberately does NOT
# go through the worker.
notify() {
  local key="$1" msg="$2"
  local stamp_file="${STATE_DIR}/${key}.last"
  local now last
  now="$(date +%s)"
  last="$(cat "$stamp_file" 2>/dev/null || echo 0)"
  if [ $((now - last)) -lt "$REALERT_SEC" ]; then
    log "suppressed ${key} (alerted $((now - last))s ago)"
    return 0
  fi
  for uid in $COMMISH_IDS; do
    ch="$(curl -sS -m 15 -X POST "https://discord.com/api/v10/users/@me/channels" \
      -H "Authorization: Bot ${BOT_TOKEN}" -H "Content-Type: application/json" \
      -d "{\"recipient_id\":\"${uid}\"}" 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
    [ -z "$ch" ] && continue
    curl -sS -m 15 -X POST "https://discord.com/api/v10/channels/${ch}/messages" \
      -H "Authorization: Bot ${BOT_TOKEN}" -H "Content-Type: application/json" \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1], "allowed_mentions": {"parse": []}}))' "$msg")" \
      >/dev/null 2>&1 || true
  done
  echo "$now" > "$stamp_file"
  log "ALERTED ${key}"
}

RESP="$(curl -sS -m 25 "${WORKER_BASE}/admin/health-summary?L=${LEAGUE_ID}&APIKEY=${APIKEY}" 2>/dev/null || true)"

if [ -z "$RESP" ] || ! echo "$RESP" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; then
  notify "worker_unreachable" "🚨 **UPS worker unreachable** — \`/admin/health-summary\` returned nothing usable from Keith's Mac. Cloudflare may be down or the worker is erroring on every request. The auction poll, the board, and all Discord narration depend on it."
  log "worker unreachable"
  exit 0
fi

# Evaluate cron liveness + scheduled-report freshness. The evaluator is a
# separate file, NOT a heredoc: a heredoc takes over stdin, so the piped JSON
# would never reach it (caught in testing — it silently evaluated nothing).
EVAL_PY="$(cd "$(dirname "$0")" && pwd)/cron_liveness_eval.py"
EVAL="$(echo "$RESP" | python3 "$EVAL_PY" "$(date +%s)" 2>/dev/null || true)"

if [ -z "$EVAL" ]; then
  log "ok — crons alive, reports current"
  exit 0
fi

while IFS=$'\t' read -r key msg; do
  [ -z "$key" ] && continue
  notify "$key" "$msg"
done <<< "$EVAL"
