#!/usr/bin/env python3
"""Evaluate /admin/health-summary for off-platform liveness problems.

Reads the health-summary JSON on stdin, prints one TAB-separated
"key<TAB>message" line per problem found, and nothing at all when healthy.
Lives in its own file rather than a heredoc inside cron_liveness_tick.sh
because a heredoc steals stdin from the pipe — the JSON never arrives.

Usage:  curl .../admin/health-summary | cron_liveness_eval.py [now_unix]
"""
import json
import sys
import datetime

# cron_cf is stamped by ANY Cloudflare cron firing (the */2 is the fastest),
# so anything past this means the whole scheduler has stopped — the
# 2026-07-15 "registration accepted, zero invocations" failure mode.
CRON_STALE_SEC = 600

# Grace after a report's ET slot before calling it a no-show. The job itself
# can take a couple of minutes; 45 is comfortably past that without letting a
# genuine miss sit unreported for long.
REPORT_GRACE_SEC = 2700

# A report heartbeat older than this can't be from today's slot (slots are
# 12h apart, so 20h unambiguously means "did not post today").
REPORT_STALE_SEC = 72000

# (mode, ET hour) — must match runFaNightlyJob's etHour gate in
# worker/src/auction_nudge.js.
REPORT_SLOTS = (("morning", 9), ("evening", 21))


def main() -> int:
    now = int(sys.argv[1]) if len(sys.argv) > 1 else int(
        datetime.datetime.now(datetime.timezone.utc).timestamp()
    )
    try:
        data = json.load(sys.stdin)
    except Exception:
        # Unparseable is handled by the caller (it treats that as
        # worker-unreachable); staying silent here avoids double-alerting.
        return 0

    hb = data.get("heartbeats") or {}

    def age(bot):
        row = hb.get(bot) or {}
        ts = int(row.get("last_ts") or 0)
        return None if ts <= 0 else now - ts

    problems = []

    cron_age = age("cron_cf")
    if cron_age is None:
        problems.append((
            "cron_dead",
            "🚨 **Cloudflare crons are NOT firing** — no `cron_cf` heartbeat at all. "
            "Nothing scheduled is running: no auction poll, no FA reports, no drop scan."
        ))
    elif cron_age > CRON_STALE_SEC:
        problems.append((
            "cron_dead",
            f"🚨 **Cloudflare crons appear STOPPED** — last cron fired {cron_age // 60} min ago "
            f"(expect under 2 min). Nothing scheduled is running. This is the 2026-07-15 failure mode: "
            f"the in-worker watchdog can't report this, because it rides the same dead scheduler."
        ))

    # ET is UTC-4 during EDT, which covers the auction window. A fixed offset
    # is deliberate: pulling a tz database in for a 45-minute grace check would
    # add a dependency for precision this doesn't need.
    et = datetime.datetime.fromtimestamp(now, datetime.timezone(datetime.timedelta(hours=-4)))
    for mode, hour in REPORT_SLOTS:
        slot = et.replace(hour=hour, minute=0, second=0, microsecond=0)
        if et < slot:
            continue                                  # slot not reached yet today
        overdue_sec = (et - slot).total_seconds()
        if overdue_sec < REPORT_GRACE_SEC:
            continue                                  # still inside the grace window
        a = age(f"fa_report_{mode}")
        if a is None or a > REPORT_STALE_SEC:
            label = f"{hour if hour < 12 else hour - 12} {'AM' if hour < 12 else 'PM'}"
            problems.append((
                f"report_{mode}",
                f"⚠️ **{label} FA report did not post** — no successful send recorded for today's slot "
                f"({int(overdue_sec // 60)} min overdue). The `0 1,2,13,14 * * *` cron likely didn't fire. "
                f"Re-run with `&live=1` on `/admin/auction/run-nightly-nudge` once you've checked the ledger is fresh."
            ))

    for key, msg in problems:
        print(f"{key}\t{msg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
