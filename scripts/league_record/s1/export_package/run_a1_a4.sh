#!/usr/bin/env bash
# League Record S1: the approved local export runner (requests A1 to A4 of docs/league_record/S1_MFL_EXPORT_REQUESTS.md).
#
# FOR THE COMMISSIONER'S OWN USE, on the commissioner's own machine, with the commissioner's own keys.
#   - It sends exactly four HTTP GET requests to MFL `export` endpoints and nothing else.
#   - It never reads the repository, the environment, a keychain or any connected account for a credential: each key is typed at a prompt (read -s).
#   - A key is kept in a shell variable only and handed to curl on its standard input, so it is in no file, no history, no printed line and no process argument.
#   - Raw responses go to a private folder OUTSIDE the repository (mode 700, files 600). They are never to be committed, pasted or uploaded.
#   - It stops at the first problem: any HTTP status other than 200 (a redirect is a stop, never followed), a curl failure, or an MFL error body.
#
#   ./run_a1_a4.sh --print      prints the four requests with the key replaced by REDACTED and exits. No key is read, no network is used. Use it to review.
#   ./run_a1_a4.sh              runs them (asks for the 2025 key and the 2026 key).
#   OUT=/some/private/dir ./run_a1_a4.sh   to choose the private folder (default: $HOME/ups_league_record_exports/2026-11).
set -u
umask 077
# Every variable that will ever hold a key has a private _LR_ / _lr_ name, and each of those names (and the plain names an earlier version or a caller might have exported) is unset before anything
# runs, so a variable the caller exported can never carry a key into a child process; `read` below then creates UNEXPORTED shell variables. allexport is switched off as well.
set +a
unset _LR_K2025 _LR_K2026 _lr_key _lr_enc KEY_2025 KEY_2026 key enc k v 2>/dev/null

HOST='www48.myfantasyleague.com'
UA='ups-league-record-readonly/1'
# name | key variable | path and query (no key). This list is the approved set; a test compares it with the approved requests and fails if it changes.
REQUESTS=(
  'A1_transactions_2025_trade|2025|/2025/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1'
  'A2_transactions_2026_trade|2026|/2026/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1'
  'A3_futurepicks_2025|2025|/2025/export?TYPE=futureDraftPicks&L=74598&JSON=1'
  'A4_futurepicks_2026|2026|/2026/export?TYPE=futureDraftPicks&L=74598&JSON=1'
)

if [ "${1:-}" = "--print" ]; then
  echo "Four GET requests, host $HOST, User-Agent $UA, redirects not followed, any non-200 stops:"
  for r in "${REQUESTS[@]}"; do IFS='|' read -r name keyyear pathq <<<"$r"; echo "  GET https://$HOST$pathq&APIKEY=REDACTED   ($name, key for the $keyyear instance)"; done
  exit 0
fi

OUT="${OUT:-$HOME/ups_league_record_exports/2026-11}"
RAW="$OUT/raw"
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required (it URL-encodes the key; it never sees the network)" >&2; exit 1; }
case "$OUT" in *upsmflproduction*|*/.git*) echo "refusing: the output folder must be outside the repository: $OUT" >&2; exit 1;; esac
# refuse any folder inside a git work tree (checked on the nearest existing parent, before anything is created)
probe="$OUT"; while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe=$(dirname "$probe"); done
if command -v git >/dev/null 2>&1 && git -C "$probe" rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "refusing: $OUT is inside a git work tree; raw responses must never be near a repository" >&2; exit 1; fi
mkdir -p "$RAW" && chmod 700 "$OUT" "$RAW" || { echo "cannot create the private folder $RAW" >&2; exit 1; }

# Keys are typed here, one per league-year. Nothing is echoed; nothing is exported.
read -r -s -p "MFL key for the 2025 instance (league 74598): " _LR_K2025; echo
read -r -s -p "MFL key for the 2026 instance (league 74598): " _LR_K2026; echo
case "$_LR_K2025" in ''|*[[:space:]]*) echo "refusing: the 2025 key is empty or contains whitespace" >&2; exit 1;; esac
case "$_LR_K2026" in ''|*[[:space:]]*) echo "refusing: the 2026 key is empty or contains whitespace" >&2; exit 1;; esac

: > "$OUT/requests.log"; chmod 600 "$OUT/requests.log"
get() {  # name, key year, path and query (no key). Returns non-zero on anything but a clean HTTP 200 with a non-error body.
  local name="$1" keyyear="$2" pathq="$3" _lr_key code _lr_enc captured
  if [ "$keyyear" = "2025" ]; then _lr_key="$_LR_K2025"; else _lr_key="$_LR_K2026"; fi
  _lr_enc=$(printf '%s' "$_lr_key" | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=""))') || return 1
  captured=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # the key goes to curl on stdin as a config line; --max-redirs 0 and no --location: a redirect is a stop
  code=$(printf 'url = "https://%s%s&APIKEY=%s"\n' "$HOST" "$pathq" "$_lr_enc" | \
    curl --silent --show-error --max-time 60 --max-redirs 0 --header "User-Agent: $UA" \
         --output "$RAW/$name.json" --write-out '%{http_code}' --config -) || { echo "$name: curl failed; stop and report" >&2; return 1; }
  chmod 600 "$RAW/$name.json" 2>/dev/null
  local bytes; bytes=$(wc -c < "$RAW/$name.json" | tr -d ' ')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$HOST" "$pathq" "$code" "$bytes" "$captured" >> "$OUT/requests.log"
  echo "$name HTTP $code $bytes bytes"
  [ "$code" = "200" ] || { echo "$name: HTTP $code (a redirect or an error); stop and report" >&2; return 1; }
  if head -c 400 "$RAW/$name.json" | grep -qi '"error"'; then echo "$name: MFL returned an error body; stop and report" >&2; return 1; fi
  sleep 1
}

status=0
for r in "${REQUESTS[@]}"; do
  IFS='|' read -r name keyyear pathq <<<"$r"
  get "$name" "$keyyear" "$pathq" || { status=1; break; }       # the first failure stops everything after it
done
unset _LR_K2025 _LR_K2026 _lr_key _lr_enc
if [ "$status" = "0" ]; then
  (cd "$RAW" && shasum -a 256 ./*.json)
  echo "Done. Raw responses stay in $RAW (private). Next: node sanitize_exports.mjs --dir \"$OUT\""
else
  echo "Stopped. Do not retry with another credential. Report the line above (it contains no key)." >&2
fi
exit "$status"
