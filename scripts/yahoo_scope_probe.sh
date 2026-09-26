#!/usr/bin/env bash
# Is Yahoo's Fantasy read scope (fspt-r) actually provisioned on our app?
#
# WHY THIS EXISTS AS A SCRIPT: an ad-hoc version of this check produced a FALSE
# POSITIVE on 2026-08-21. It inferred success from "no Location header", but
# curl had failed outright (exit 3, malformed URL) and never made the request.
# "No error observed" is not "no error" when the request never left the machine.
# So this asserts on curl's exit code AND the HTTP status, and treats anything
# it cannot positively confirm as UNKNOWN rather than success.
#
# It also runs a CONTROL scope (openid). That is what separates the two failure
# modes that look identical from one probe:
#   fspt-r fails + openid works  -> client is fine, the SCOPE is not provisioned
#   both fail                    -> the client_id/registration itself is wrong
#
# Read-only: hits only the authorize endpoint, grants nothing, stores nothing.
# ⚠️ Do NOT extend this to sweep scope-string variants hunting for one that
# works. §14 of the signed agreement gives Yahoo audit rights, and that traffic
# reads as probing for access we were not granted.
set -uo pipefail

CID=$(security find-generic-password -a "${USER}" -s yahoo_client_id -w 2>/dev/null | tr -d '\n')

if [ -z "${CID}" ]; then
  echo "FAIL: no yahoo_client_id in the Keychain."; exit 2
fi
# Guard against the exact corruption that happened once: a shell command text
# stored as the credential because $(pbpaste) expanded to the copied command.
case "${CID}" in
  *pbpaste*|*" "*)
    echo "FAIL: stored yahoo_client_id is not a credential (contains a space or"
    echo "      shell text). Re-store it from developer.yahoo.com/apps/ with:"
    echo "        security add-generic-password -U -a \"\$USER\" -s yahoo_client_id -w"
    echo "      then confirm the length is ~96 chars."
    exit 2;;
esac
echo "client_id: ${#CID} chars (value never printed)"

probe () {
  local scope="$1" hdr rc http_status loc
  hdr=$(curl -sS -o /dev/null -D - --max-time 25 \
    "https://api.login.yahoo.com/oauth2/request_auth?client_id=${CID}&redirect_uri=https%3A%2F%2Flocalhost%3A8080&response_type=code&scope=${scope}&state=probe" 2>&1)
  rc=$?
  if [ $rc -ne 0 ]; then
    printf "  %-8s UNKNOWN — curl failed rc=%s (request never sent; NOT a result)\n" "$scope" "$rc"
    return 2
  fi
  http_status=$(printf '%s' "$hdr" | grep -oE '^HTTP/[0-9.]+ [0-9]+' | tail -1 | grep -oE '[0-9]+$')
  loc=$(printf '%s' "$hdr" | grep -i '^location:' | sed -E "s/${CID}/<CLIENT_ID>/g")
  if printf '%s' "$loc" | grep -q 'error='; then
    printf "  %-8s HTTP %s  DENIED: %s\n" "$scope" "${http_status:-?}" \
      "$(printf '%s' "$loc" | grep -oE 'error=[a-z_]+')"
    return 1
  fi
  if [ -n "$loc" ]; then
    printf "  %-8s HTTP %s  OK — redirects to Yahoo login, no error\n" "$scope" "${http_status:-?}"
    return 0
  fi
  printf "  %-8s HTTP %s  UNKNOWN — no Location header and no error\n" "$scope" "${http_status:-?}"
  return 2
}

probe "fspt-r"; fspt=$?
probe "openid"; ctrl=$?

echo
if [ $fspt -eq 0 ]; then
  echo "✅ fspt-r IS PROVISIONED — run the real auth flow:"
  echo "     export YAHOO_REDIRECT_URI='https://localhost:8080'   # must byte-match the registered value"
  echo "     python3 pipelines/fantasy/cli.py --platform yahoo auth"
  exit 0
fi
if [ $fspt -eq 1 ] && [ $ctrl -eq 0 ]; then
  echo "⛔ Still NOT provisioned. The client_id is valid (openid works), so this is"
  echo "   Yahoo's side: the Fantasy scope is not attached to this app yet."
  echo "   Per §2.a, Yahoo communicates a post-approval registration step — look for"
  echo "   their follow-up (fantasyapiapplications@yahoosports.com) or a Fantasy"
  echo "   Sports permission on the app at developer.yahoo.com/apps/."
  exit 1
fi
echo "❓ Inconclusive — fspt-r=$fspt control=$ctrl. Do not treat as either state."
exit 2
