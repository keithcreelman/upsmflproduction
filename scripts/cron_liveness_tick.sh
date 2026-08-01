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

# Alert de-dup: ONE DM per episode, plus one when it clears (Keith 2026-08-01 —
# a single missed 9 AM report produced a DM every 30 minutes all day). A key
# stays "open" while its stamp file exists; the resolve pass at the bottom
# closes it and says so. There is deliberately no periodic re-alert: a problem
# that is still open just stays open silently until it clears.

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
  local now
  now="$(date +%s)"
  # Already open ⇒ say nothing. The episode was announced once; the next DM
  # about this key will be the "resolved" one.
  if [ -f "$stamp_file" ]; then
    log "suppressed ${key} (already open since $(cat "$stamp_file" 2>/dev/null))"
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

# The other half of the contract: an alert that never clears is just noise you
# learn to ignore. Fires once, when a previously-open key stops being reported.
resolve() {
  local key="$1" what="$2"
  local stamp_file="${STATE_DIR}/${key}.last"
  [ -f "$stamp_file" ] || return 0            # was never open
  local opened now mins
  opened="$(cat "$stamp_file" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  mins=$(( (now - opened) / 60 ))
  local msg="✅ **Resolved — ${what}.** Back to normal after ${mins} min. No action needed."
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
  rm -f "$stamp_file"
  log "RESOLVED ${key} (open ${mins}m)"
}

# Human label per key, for the resolved DM.
label_for() {
  case "$1" in
    worker_unreachable) echo "the worker is reachable again" ;;
    cron_dead)          echo "Cloudflare crons are firing again" ;;
    report_morning)     echo "the 9 AM FA report posted" ;;
    report_evening)     echo "the 9 PM FA report posted" ;;
    *)                  echo "$1" ;;
  esac
}

RESP="$(curl -sS -m 25 "${WORKER_BASE}/admin/health-summary?L=${LEAGUE_ID}&APIKEY=${APIKEY}" 2>/dev/null || true)"

if [ -z "$RESP" ] || ! echo "$RESP" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; then
  notify "worker_unreachable" "🚨 **UPS worker unreachable** — \`/admin/health-summary\` returned nothing usable from Keith's Mac. Cloudflare may be down or the worker is erroring on every request. The auction poll, the board, and all Discord narration depend on it."
  log "worker unreachable"
  # Deliberately does NOT resolve the report/cron keys: with no health-summary
  # we cannot tell whether those are fine, and silently declaring them fixed
  # would be worse than staying quiet. They clear on the next good tick.
  exit 0
fi
resolve "worker_unreachable" "$(label_for worker_unreachable)"

# Evaluate cron liveness + scheduled-report freshness. The evaluator is a
# separate file, NOT a heredoc: a heredoc takes over stdin, so the piped JSON
# would never reach it (caught in testing — it silently evaluated nothing).
EVAL_PY="$(cd "$(dirname "$0")" && pwd)/cron_liveness_eval.py"
EVAL="$(echo "$RESP" | python3 "$EVAL_PY" "$(date +%s)" 2>/dev/null || true)"

# Everything the evaluator is flagging RIGHT NOW. Anything currently open that
# is absent from this set has recovered.
FIRING=""
if [ -n "$EVAL" ]; then
  while IFS=$'\t' read -r key msg; do
    [ -z "$key" ] && continue
    FIRING="${FIRING} ${key}"
    notify "$key" "$msg"
  done <<< "$EVAL"
fi

# Resolve pass — close any open key the evaluator no longer reports. Driven off
# the stamp files rather than a hardcoded list, so a new problem key added to
# the evaluator gets recovery DMs for free.
for stamp in "${STATE_DIR}"/*.last; do
  [ -e "$stamp" ] || continue
  k="$(basename "$stamp" .last)"
  [ "$k" = "worker_unreachable" ] && continue      # handled above
  case " ${FIRING} " in
    *" ${k} "*) : ;;                               # still firing — leave open
    *) resolve "$k" "$(label_for "$k")" ;;
  esac
done

[ -z "$EVAL" ] && log "ok — crons alive, reports current"
exit 0
