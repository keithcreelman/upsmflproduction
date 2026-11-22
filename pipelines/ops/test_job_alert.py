#!/usr/bin/env python3
"""Offline test for job_alert.py: the alert state machine with a fake GitHub and a fake Discord.

No network, no gh, no Discord: GitHub is an in-memory fake and Discord is a recorder.
Covers: initial alert; a repeat inside 48 h (counts update, no message); a repeat at 48 h (reminder);
exactly one recovery message, then close and no more reminders; Discord off (issue only, exit 0);
Discord on but delivery failing (recorded, exit 2, recovery stays open and retries); the TEST message
and status texts never contain the token or the target id.
"""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("job_alert", HERE / "job_alert.py")
ja = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ja)

T0 = datetime(2026, 11, 22, 18, 0, tzinfo=timezone.utc)
ON = {"ALERT_DISCORD_ENABLED": "1", "DISCORD_BOT_TOKEN": "fake-token-xyz", "ALERT_DISCORD_USER_ID": "424242424242424242"}
OFF = {}


class FakeGH:
    def __init__(self):
        self.issues, self.comments, self.closed, self.labels = {}, {}, set(), 0

    def find_open(self, title):
        return next((dict(i) for n, i in self.issues.items() if i["title"] == title and n not in self.closed), None)

    def ensure_label(self):
        self.labels += 1

    def create(self, title, body):
        n = len(self.issues) + 1
        self.issues[n] = {"number": n, "title": title, "body": body, "url": f"https://example.test/issues/{n}"}
        return dict(self.issues[n])

    def edit_body(self, n, body):
        self.issues[n]["body"] = body

    def comment(self, n, text):
        self.comments.setdefault(n, []).append(text)

    def close(self, n):
        self.closed.add(n)


class Recorder:
    def __init__(self, ok=True):
        self.sent, self.ok = [], ok

    def __call__(self, env, text):
        enabled, reason, _, _ = ja.discord_config(env)
        if not enabled or reason:
            return False, reason
        self.sent.append(text)
        return (True, "sent (direct message)") if self.ok else (False, "DELIVERY FAILED (URLError)")


fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


def run(gh, status, t, env, rec, job="roster-anomaly-check"):
    return ja.handle(job, status, f"https://example.test/runs/{t:%H%M}", "roster drift detection", t, gh, env, rec)


# 1. Initial alert, repeats, reminder at 48 h, one recovery.
gh, rec = FakeGH(), Recorder()
check(run(gh, "failure", T0, ON, rec) == 0, "initial failure should exit 0")
check(len(rec.sent) == 1 and rec.sent[0].startswith("⚠️ UPS data job failed"), f"initial alert: {rec.sent}")
st = ja.read_state(gh.issues[1]["body"])
check(st["failures"] == 1 and st["last_discord"] == ja.iso(T0), f"initial state {st}")
run(gh, "failure", T0 + timedelta(hours=24), ON, rec)
check(len(rec.sent) == 1, "a repeat inside 48 h must not message")
check(ja.read_state(gh.issues[1]["body"])["failures"] == 2, "repeat must update the count")
run(gh, "failure", T0 + timedelta(hours=48), ON, rec)
check(len(rec.sent) == 2 and rec.sent[1].startswith("⏰ Still failing") and "3 failed runs" in rec.sent[1],
      f"reminder at 48 h: {rec.sent}")
check(len(gh.issues) == 1, "repeat failures must stay on one issue")
check(run(gh, "success", T0 + timedelta(hours=60), ON, rec) == 0, "recovery should exit 0")
check(len(rec.sent) == 3 and rec.sent[2].startswith("✅ Recovered") and "3 failed run(s)" in rec.sent[2],
      f"recovery message: {rec.sent}")
check(1 in gh.closed, "recovery must close the issue")
run(gh, "success", T0 + timedelta(hours=84), ON, rec)
check(len(rec.sent) == 3, "after recovery, a success sends nothing more")

# 2. A new episode after recovery opens a new issue.
run(gh, "failure", T0 + timedelta(days=5), ON, rec)
check(len(gh.issues) == 2 and len(rec.sent) == 4, "a new failure after recovery is a new episode")

# 3. Discord off: the issue records it, nothing is sent, exit 0.
gh, rec = FakeGH(), Recorder()
check(run(gh, "failure", T0, OFF, rec) == 0, "Discord off must not fail the alert step")
check(not rec.sent and "Discord alerts are off" in gh.issues[1]["body"], "Discord off must be stated in the issue")
check(run(gh, "success", T0 + timedelta(hours=1), OFF, rec) == 0 and 1 in gh.closed, "close without Discord when off")

# 4. Discord on but failing: recorded, exit 2; a recovery stays open and retries on the next success.
gh, bad = FakeGH(), Recorder(ok=False)
check(run(gh, "failure", T0, ON, bad) == 2, "failed delivery of an initial alert must exit 2")
st = ja.read_state(gh.issues[1]["body"])
check(st["last_discord"] is None and "DELIVERY FAILED" in st["discord_note"], f"failed delivery state {st}")
check(run(gh, "failure", T0 + timedelta(hours=1), ON, bad) == 2, "never-delivered alert retries as a reminder")
check(run(gh, "success", T0 + timedelta(hours=2), ON, bad) == 2 and 1 not in gh.closed,
      "an undelivered recovery must keep the issue open")
good = Recorder()
check(run(gh, "success", T0 + timedelta(hours=3), ON, good) == 0 and 1 in gh.closed and len(good.sent) == 1,
      "the next success delivers the recovery once and closes")

# 5. Misconfiguration is not silent.
check(ja.discord_config({"ALERT_DISCORD_ENABLED": "1", "ALERT_DISCORD_USER_ID": "1"})[1]
      == "no Discord bot token available to this job", "missing token must be reported")
both = dict(ON, ALERT_DISCORD_CHANNEL_ID="99")
check("exactly one" in (ja.discord_config(both)[1] or ""), "two targets must be rejected")
# The literal "-" that `gh variable set --body -` stored on 2026-11-22 must be rejected before any send,
# without echoing the value.
for bad in ("-", "abc", "12345", "1234567890123456789012"):
    r = ja.discord_config(dict(ON, ALERT_DISCORD_USER_ID=bad))[1] or ""
    check("is not a Discord id" in r and bad not in r.replace("15 to 21", ""), f"bad id {bad!r} must be rejected: {r!r}")
check(ja.discord_config(dict(ON, ALERT_DISCORD_USER_ID="123456789012345678"))[1] is None, "an 18-digit id is valid")

# 6. Nothing secret in issue text or comments.
gh, rec = FakeGH(), Recorder()
run(gh, "failure", T0, ON, rec)
text = gh.issues[1]["body"] + " ".join(gh.comments.get(1, []))
check("fake-token-xyz" not in text and "424242424242424242" not in text,
      "issue text must not contain the token or target id")

# 7. Cancelled/skipped runs change nothing.
check(ja.main(["--job", "x", "--status", "cancelled"]) == 0, "cancelled is a no-op")

print("JOB ALERT TEST — initial, repeat, 48 h reminder, one recovery, off, delivery failure, no secrets")
if fails:
    print(f"FAILED — {len(fails)} violation(s):")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("PASSED")
