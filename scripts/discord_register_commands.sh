#!/usr/bin/env bash
# Register UPS Hall slash commands with Discord.
#
# Phase 2 command set: /hall ping, start, status, close, resume, nudge.
#
# Usage:
#   DISCORD_BOT_TOKEN=<token> DISCORD_APPLICATION_ID=<app_id> DISCORD_GUILD_ID=<guild_id> \
#     ./scripts/discord_register_commands.sh
#
# Guild commands propagate INSTANTLY (vs global which takes ~1hr).
# Re-running this script overwrites the previous command set for this guild.

set -eu -o pipefail

: "${DISCORD_BOT_TOKEN:?DISCORD_BOT_TOKEN env var required}"
: "${DISCORD_APPLICATION_ID:?DISCORD_APPLICATION_ID env var required}"
: "${DISCORD_GUILD_ID:?DISCORD_GUILD_ID env var required - the UPS Discord server ID}"

PAYLOAD=$(cat <<'JSON'
[
  {
    "name": "rules",
    "description": "UPS League rules — owner discussion and voting",
    "options": [
      {
        "name": "ping",
        "type": 1,
        "description": "Test the bot wiring (returns pong + open round count)"
      },
      {
        "name": "start",
        "type": 1,
        "description": "Open a round — pin anchor in rules channel + spawn per-rule threads (commish only)",
        "options": [
          { "name": "round_id", "type": 3, "description": "Round slug, e.g. May2026", "required": true }
        ]
      },
      {
        "name": "status",
        "type": 1,
        "description": "Show progress for the active round + live tally"
      },
      {
        "name": "close",
        "type": 1,
        "description": "Close the active round — disable buttons + freeze tallies (commish only)"
      },
      {
        "name": "nudge",
        "type": 1,
        "description": "DM owners who haven't voted on every item with thread links (commish only)"
      }
    ]
  }
]
JSON
)

URL="https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands"

echo "Registering /rules command set with guild ${DISCORD_GUILD_ID}..."
echo

RESPONSE=$(curl -sS -X PUT "$URL" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -w "\n__HTTP_STATUS__:%{http_code}\n" \
  --data "$PAYLOAD")

STATUS=$(echo "$RESPONSE" | grep -o "__HTTP_STATUS__:[0-9]*" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/__HTTP_STATUS__:/d')

if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
  echo "✓ Registered."
  echo
  if command -v jq >/dev/null 2>&1; then
    echo "$BODY" | jq '[.[] | { name, options: ([.options[]?.name] // []) }]'
  else
    echo "$BODY"
  fi
  echo
  echo "Try in Discord: /rules ping  (then /rules start round_id:May2026 once you've seeded a round)"
else
  echo "✗ Failed (HTTP $STATUS):"
  echo "$BODY"
  exit 1
fi
