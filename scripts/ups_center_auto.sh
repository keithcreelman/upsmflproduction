#!/usr/bin/env bash
# Scheduled UPS Center draft builder -- runs pipelines/etl/wire/ups_center_auto.py from an
# automation-owned git worktree (reset to origin/main every run), never from Keith's checkouts.
#
# SCHEDULE (scripts/install_ups_center_auto.sh, installed 2026-10-08):
#   Tue 10:00  first draft: the week ended Monday night; the 01:00 live sync has settled D1,
#              and this freezes the projection evidence before Wednesday's ingest re-stamps it
#   Wed 10:00  retry/update (xFP and late D1 settles)
#   Thu 09:00  Elias update (after the 08:00 live-sync refresh): changed claims, same PR
#   Fri 09:00  second Elias look
# Each run is idempotent: one draft PR per week; nothing is ever merged, published or posted.
#
# NEVER SILENT (Keith 2026-10-21). From Oct 15 to Oct 20 every run died at `git checkout`: an
# editor-owned Week 5 run had left generated files in this worktree, the checkout refused to
# overwrite them, and the script exited before Python could write a status or raise an alert.
# Now:
#   * a dirty worktree (or one left on a branch) is PRESERVED first -- status, patch and a copy
#     of every changed or untracked file under $STATE/preserved/<UTC>-auto/ (the newest 10 are
#     kept) -- and then forced to a clean detached origin/main;
#   * any step that fails before the build starts writes $STATE/wrapper_status.json, raises a
#     macOS notification and opens or comments on ONE GitHub issue ("UPS Center automation could
#     not start"), then exits non-zero;
#   * every run records start, stage and exit code in $STATE/wrapper_status.json.
set -uo pipefail
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"   # same fix as the live sync
REPO_ROOT="${UPSMFL_REPO_ROOT:-$HOME/Code/MFL/upsmflproduction}"
STATE="${UPS_CENTER_AUTO_STATE:-$HOME/Library/Caches/upsmfl-ups-center-auto}"
WORK="$STATE/repo"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$STATE"
echo "[$STARTED] ups-center-auto start"

status() {  # stage rc detail
  printf '{"startedAt": "%s", "at": "%s", "stage": "%s", "rc": %s, "detail": %s}\n' "$STARTED" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$(printf '%s' "$3" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[-1500:]))')" \
    > "$STATE/wrapper_status.json"
}

fail() {  # stage detail -- loud, then exit 1
  local stage="$1" detail="$2"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ups-center-auto FAILED at $stage: $detail"
  status "$stage" 1 "$detail"
  if [ -z "${UPS_CENTER_AUTO_QUIET:-}" ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"Stopped at $stage. No draft was built.\" with title \"UPS Center automation could not start\"" || true
  fi
  local title="UPS Center automation could not start"
  local body
  body="$(printf 'The scheduled UPS Center job stopped at **%s** on %s, before it could build a draft.\n\n```\n%s\n```\n\nNothing was published or posted. The worktree state (if any) is preserved under `%s/preserved/`. Re-run: `%s`.' \
    "$stage" "$STARTED" "$(printf '%s' "$detail" | tail -c 1500)" "$STATE" "bash scripts/ups_center_auto.sh")"
  if [ -n "${UPS_CENTER_AUTO_ALERT_DRY:-}" ]; then
    printf 'ALERT-DRY %s\n%s\n' "$title" "$body" >> "$STATE/alerts_dry.log"
  elif command -v gh >/dev/null 2>&1; then
    local n
    n="$(cd "$REPO_ROOT" && gh issue list --state open --search "\"$title\" in:title" --json number -q '.[0].number' 2>/dev/null)"
    if [ -n "$n" ]; then
      (cd "$REPO_ROOT" && gh issue comment "$n" --body "$body") >/dev/null 2>&1 || true
    else
      (cd "$REPO_ROOT" && gh issue create --title "$title" --body "$body") >/dev/null 2>&1 || true
    fi
  fi
  exit 1
}

preserve() {  # copy a dirty worktree's state aside before it is reset
  local dirty branch
  dirty="$(git -C "$WORK" status --porcelain 2>/dev/null)"
  branch="$(git -C "$WORK" branch --show-current 2>/dev/null)"
  [ -z "$dirty" ] && [ -z "$branch" ] && return 0
  local dest="$STATE/preserved/$(date -u +%Y-%m-%dT%H%M%SZ)-auto"
  mkdir -p "$dest/files"
  { echo "preserved by ups_center_auto.sh before resetting to origin/main"; echo "branch: ${branch:-detached}";
    echo "HEAD: $(git -C "$WORK" rev-parse HEAD 2>/dev/null)"; printf '%s\n' "$dirty"; } > "$dest/STATE.txt"
  git -C "$WORK" diff > "$dest/tracked-changes.patch" 2>/dev/null || true
  printf '%s\n' "$dirty" | sed -E 's/^.{3}//; s/^.* -> //' | while IFS= read -r p; do
    [ -n "$p" ] && [ -e "$WORK/$p" ] && mkdir -p "$dest/files/$(dirname "$p")" && cp -R "$WORK/$p" "$dest/files/$p"
  done
  echo "preserved the worktree state in $dest"
  local kept
  kept="$(ls -1d "$STATE"/preserved/*-auto 2>/dev/null | sort)"
  printf '%s\n' "$kept" | awk -v n="$(printf '%s\n' "$kept" | grep -c .)" 'NF && NR <= n - 10' | while IFS= read -r old; do rm -rf "$old"; done
  return 0
}

status "starting" 0 ""
if [ ! -e "$WORK/.git" ]; then
  out="$(git -C "$REPO_ROOT" fetch -q origin 2>&1)" || fail "fetch (new worktree)" "$out"
  out="$(git -C "$REPO_ROOT" worktree add -q --detach "$WORK" origin/main 2>&1)" || fail "worktree add" "$out"
fi
out="$(git -C "$WORK" fetch -q origin 2>&1)" || fail "git fetch" "$out"
preserve
out="$(git -C "$WORK" checkout -q -f --detach origin/main 2>&1)" || fail "git checkout origin/main" "$out"
out="$(git -C "$WORK" clean -qfd 2>&1)" || fail "git clean" "$out"
[ -z "$(git -C "$WORK" status --porcelain)" ] || fail "clean worktree" "$(git -C "$WORK" status --porcelain)"
status "running" 0 "$(git -C "$WORK" rev-parse HEAD)"
python3 "$WORK/pipelines/etl/wire/ups_center_auto.py" run --season "${UPSMFL_SEASON:-2026}" --workdir "$WORK" "$@"
rc=$?
status "finished" "$rc" "ups_center_auto.py exit $rc (see <id>.status.json for each week)"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ups-center-auto exit $rc"
exit $rc
