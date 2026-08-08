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

# The FA reports are gated in the worker on BOTH of these (auction_nudge.js
# runFaNightlyJob: "nudge_disabled" / "faa_not_live"), so this watchdog is gated
# on exactly the same pair. With the auction over, both are "0" and the report
# is CORRECTLY silent — asserting a 9 AM report every day forever turned that
# expected silence into a daily page (Keith 2026-08-08).
#
# The values come from /admin/health-summary's `flags` block, which the tick
# script is already fetching — it resolves the D1 ups_settings 'feature_flags'
# override ON TOP of the wrangler.toml default, so it is the EFFECTIVE state.
# Reading wrangler.toml from this script would be wrong (the file and D1
# disagree today), and going to D1 directly would give a local script a database
# dependency it does not otherwise need.
#
# The same response carries `flags_readable`, the worker stating outright whether
# that D1 read succeeded. It has to, because the flags fail CLOSED: a failed read
# reports every flag as false, so the values alone cannot distinguish "the
# commish switched the auction off" from "we have no idea". report_gate() below
# will only go quiet on the former.
REPORT_FLAGS = ("AUCTION_NIGHTLY_NUDGE_ENABLED", "AUCTION_FAA_ENABLED")


def report_gate(data):
    """Should today's FA reports have posted? -> (check_them, unreadable_reason)

    (True, None)   flags say the reports are armed — check the slots as before.
    (False, None)  flags say FA reports are off — "no report" is the expected
                   state, not a problem.
    (True, reason) the flag state could NOT be established. Keep checking and
                   SAY SO. This direction is deliberate and load-bearing: a
                   watchdog whose failure mode is silence would hide a real
                   outage mid-auction, which is the exact thing this file
                   exists to catch. Never treat unreadable as "auction over".

    Every check below demands an EXPLICIT answer. A field that is absent, or
    present with a shape we don't recognise, is unreadable — it is never read as
    "off". The whole (False, None) branch is a decision to stay silent, and the
    only thing allowed to buy that silence is the worker positively stating that
    it read the flags and they are off.
    """
    # The worker's own statement that it could read the D1 override at all
    # (index.js /admin/health-summary -> getFeatureFlagsWithReadState). On a failed
    # read it reports every flag false, so the rows alone cannot tell "switched
    # off" from "we don't know" — this field is what separates them.
    readable = data.get("flags_readable")
    if readable is False:
        return True, (
            "the worker could not read the D1 feature-flag overrides "
            "(in that state it reports every flag OFF, which is not the same as the auction being over)"
        )
    if readable is not True:
        # Absent, null, or some other type. Most likely a deployed worker older
        # than the field — which is exactly the case that must not be allowed to
        # talk this watchdog into silence, because such a worker's per-flag
        # `unknown` may also be missing and would read as a confident "false".
        return True, (
            "the worker's health-summary did not state `flags_readable`, so nothing in it "
            "can vouch for the flag values (deployed worker probably predates the field)"
        )

    flags = data.get("flags")
    if not isinstance(flags, list) or not flags:
        # health-summary initialises flags to [] and pushes "flags: …" into
        # errors when the flag read throws; anything else non-list is a payload
        # we don't understand. Both mean "no usable flag state".
        return True, "the worker reported no feature-flag state at all"

    by_key = {}
    for f in flags:
        if isinstance(f, dict) and f.get("key"):
            by_key[str(f["key"])] = f

    missing = [k for k in REPORT_FLAGS if k not in by_key]
    if missing:
        return True, "the worker did not report " + " / ".join(missing)

    # Per-flag confirmation, and it must be the literal False. `.get("unknown")`
    # being falsy is NOT good enough: a missing key is falsy too, and would let a
    # payload that never answered the question pass as "readable".
    hazy = [k for k in REPORT_FLAGS if by_key[k].get("unknown") is not False]
    if hazy:
        return True, (
            "the worker did not mark " + " / ".join(hazy) +
            " as a confirmed read (no explicit `unknown: false`)"
        )

    values = {}
    for k in REPORT_FLAGS:
        v = by_key[k].get("value")
        if not isinstance(v, bool):
            return True, f"{k} came back without a usable on/off value"
        values[k] = v

    if all(values.values()):
        return True, None
    return False, None


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

    # Are FA reports even supposed to be running? (cron_cf above is checked
    # unconditionally — it covers EVERY cron, not just this one.)
    check_reports, flag_note = report_gate(data)

    # An unreadable flag state is its OWN alert, not merely a footnote on a
    # report alert that may or may not fire. Two reasons it has to stand alone:
    # the kill-switch layer fails closed, so a D1 override read that keeps
    # failing means EVERY feature — trade DMs, drop tracker, auction poller — is
    # silently off league-wide; and if the reports happen to be posting fine, the
    # footnote below never prints and the condition would go completely unseen.
    # Being unable to read the switches is a fault in its own right.
    if flag_note:
        problems.append((
            "flags_unreadable",
            f"⚠️ **Feature-flag state is UNREADABLE** — {flag_note}. Kill switches fail CLOSED, so "
            f"while this lasts the worker may be treating every feature as OFF (trade DMs, drop tracker, "
            f"FA reports, auction poller). I am NOT trusting the flags to tell me whether FA reports are "
            f"expected, so the report checks below stay armed. Check `/admin/health-summary` — its `errors` "
            f"block names the failure."
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
            msg = (
                f"⚠️ **{label} FA report did not post** — no successful send recorded for today's slot "
                f"({int(overdue_sec // 60)} min overdue). The `0 1,2,13,14 * * *` cron likely didn't fire. "
                f"Re-run with `&live=1` on `/admin/auction/run-nightly-nudge` once you've checked the ledger is fresh."
            )
            if flag_note:
                # Single line, deliberately: see the print protocol below.
                msg += (
                    "  ⚠️ Caveat: the flag state is unreadable (see the separate flags_unreadable alert), "
                    "so I can't tell whether FA reports are even armed right now — alerting anyway rather "
                    "than going quiet. If the auction is over, this one is probably noise."
                )
            problems.append((f"report_{mode}", msg))

    for key, msg in problems:
        print(f"{key}\t{msg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
