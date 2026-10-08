#!/usr/bin/env bash
# Scheduled UPS Center draft builder -- runs pipelines/etl/wire/ups_center_auto.py from an
# automation-owned git worktree (reset to origin/main every run), never from Keith's checkouts.
#
# PROPOSED SCHEDULE (scripts/install_ups_center_auto.sh; NOT installed until Keith approves):
#   Tue 10:00  first draft: the week ended Monday night; the 01:00 live sync has settled D1,
#              and this freezes the projection evidence before Wednesday's ingest re-stamps it
#   Wed 10:00  retry/update (xFP and late D1 settles)
#   Thu 09:00  Elias update (after the 08:00 live-sync refresh): changed claims, same PR
#   Fri 09:00  second Elias look
# Each run is idempotent: one draft PR per week; nothing is ever merged, published or posted.
set -uo pipefail
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"   # same fix as the live sync
REPO_ROOT="${UPSMFL_REPO_ROOT:-$HOME/Code/MFL/upsmflproduction}"
STATE="${UPS_CENTER_AUTO_STATE:-$HOME/Library/Caches/upsmfl-ups-center-auto}"
WORK="$STATE/repo"
mkdir -p "$STATE"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ups-center-auto start"
if [ ! -e "$WORK/.git" ]; then
  git -C "$REPO_ROOT" fetch -q origin || exit 1
  git -C "$REPO_ROOT" worktree add -q --detach "$WORK" origin/main || exit 1
fi
git -C "$WORK" fetch -q origin && git -C "$WORK" checkout -q --detach origin/main || exit 1
python3 "$WORK/pipelines/etl/wire/ups_center_auto.py" run --season "${UPSMFL_SEASON:-2026}" --workdir "$WORK" "$@"
rc=$?
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ups-center-auto exit $rc"
exit $rc
