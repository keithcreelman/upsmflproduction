#!/usr/bin/env python3
"""UPS Center due/preflight test -- the missing Week 4 issue must be detected,
and a catch-up must never duplicate one.

WHAT HAPPENED (2026-10-08): Week 4 finished Mon Oct 5 and no UPS Center issue
was ever generated -- there was no trigger to fail, so nothing reported it. The
same gap left Week 3's Elias corrections (posted Wed Sep 30) unchecked.

Offline: every input is a fixture shaped like the real 2026 data (Week 4's last
kickoff Mon Oct 5, 8:15 PM ET; Week 5's first Thu Oct 8, 8:15 PM ET).

Usage:
  python3 pipelines/etl/wire/test_ups_center_due.py
"""
import calendar
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ups_center_due as U  # noqa: E402


def utc(s):
    return calendar.timegm(time.strptime(s, "%Y-%m-%d %H:%M"))


KICKOFFS = {                         # first and last kickoff of each 2026 week, UTC
    1: [utc("2026-09-11 00:20"), utc("2026-09-15 00:15")],
    2: [utc("2026-09-18 00:15"), utc("2026-09-22 00:15")],
    3: [utc("2026-09-25 00:15"), utc("2026-09-29 00:15")],
    4: [utc("2026-10-02 00:15"), utc("2026-10-06 00:15")],
    5: [utc("2026-10-09 00:15"), utc("2026-10-13 00:15")],
}


def index(*entries):
    return {"families": [{"id": "weekly", "articles": [
        {"id": "2026-wk%02d-ups-center" % wk, "path": "articles/2026/2026-wk%02d-ups-center.html" % wk, "status": st}
        for wk, st in entries]}]}


PUBLISHED_1_3 = [(1, "live"), (2, "live"), (3, "live")]
fails = 0


def check(name, cond, detail=""):
    global fails
    if cond:
        print("  ok   " + name)
    else:
        fails += 1
        print("  FAIL " + name + ("\n         " + str(detail) if detail else ""))


def kinds(f):
    return sorted((x["kind"], x["week"]) for x in f)


print("1. the missing Week 4 issue is detected (the 2026-10-08 failure)")
after = utc("2026-10-08 16:30")      # Thu 12:30 PM ET, after the 12:15 PM ET deadline
before = utc("2026-10-08 12:00")
f = U.due_findings(2026, KICKOFFS, index(*PUBLISHED_1_3), {1, 2, 4}, {1, 2}, after)
check("Week 4 missing after its deadline", kinds(f) == [("missing_issue", 4)], f)
check("...deadline is 8h before Week 5's first kickoff",
      f and f[0]["deadlineUnix"] == utc("2026-10-09 00:15") - 8 * 3600, f)
check("not yet flagged before the deadline", U.due_findings(2026, KICKOFFS, index(*PUBLISHED_1_3), set(), {1, 2}, before) == [])
f = U.due_findings(2026, KICKOFFS, index(*PUBLISHED_1_3, (4, "draft")), set(), set(), after)
check("a DRAFT Week 4 still counts as missing", kinds(f) == [("missing_issue", 4)], f)
f = U.due_findings(2026, KICKOFFS, index(*PUBLISHED_1_3, (4, "live")), set(), set(), after)
check("a LIVE Week 4 clears it", f == [], f)
mid = utc("2026-10-05 22:00")        # MNF still to come
f = U.due_findings(2026, {4: KICKOFFS[4], 5: KICKOFFS[5]}, index(), set(), set(), mid)
check("an unfinished week is never flagged", f == [], f)
f = U.due_findings(2026, KICKOFFS, index((1, "live"), (3, "live")), set(), set(), after)
check("an older gap (Week 2) is flagged too", ("missing_issue", 2) in kinds(f), f)

print("2. an unchecked Elias correction on a published week is detected")
f = U.due_findings(2026, KICKOFFS, index(*PUBLISHED_1_3, (4, "live")), {1, 2, 3, 4}, {1, 2, 4}, after)
check("Week 3: Elias posted, issue live, no elias file", kinds(f) == [("elias_unchecked", 3)], f)
f = U.due_findings(2026, KICKOFFS, index(*PUBLISHED_1_3, (4, "live")), {1, 2, 3, 4}, {1, 2, 3, 4}, after)
check("with the file committed it clears", f == [], f)
f = U.due_findings(2026, KICKOFFS, index(*PUBLISHED_1_3), {4}, set([1, 2, 3]), after)
check("an unpublished week reports the missing issue, not the Elias check", kinds(f) == [("missing_issue", 4)], f)

print("3. preflight finds the issue at every destination, and nowhere else")
empty = U.preflight_findings(2026, 4, index(*PUBLISHED_1_3), index(*PUBLISHED_1_3), 404, ["2026-wk03-ups-center"],
                             [{"id": "1", "content": "UPS Center: Week 3 is up", "embeds": []}])
check("nothing anywhere -> safe (Week 3 artifacts don't count)", empty == [], empty)
cases = {
    "repo index (even as a draft)": dict(repo_index=index((4, "draft"))),
    "live Pages index": dict(live_index=index((4, "live"))),
    "live Pages page (HTTP 200)": dict(live_page_status=200),
    "ups_wire_threads row": dict(wire_thread_article_ids=["2026-wk04-ups-center"]),
    "Discord message content": dict(discord_messages=[{"id": "9", "content": "**UPS Center: Week 4** is up."}]),
    "Discord embed url": dict(discord_messages=[{"id": "9", "content": "", "embeds": [
        {"title": "", "url": "https://x/wire/articles/2026/2026-wk04-ups-center.html"}]}]),
}
for name, kw in cases.items():
    args = dict(repo_index=index(), live_index=index(), live_page_status=404, wire_thread_article_ids=[],
                discord_messages=[])
    args.update(kw)
    found = U.preflight_findings(2026, 4, **args)
    check("detects it in the " + name, len(found) == 1, found)

print("4. announce stage: page must be live, and only an existing announcement blocks")
live4 = index(*PUBLISHED_1_3, (4, "live"))
ok = U.preflight_findings(2026, 4, live4, live4, 200, ["2026-wk03-ups-center"], [], stage="announce")
check("published, not announced -> safe to announce", ok == [], ok)
f = U.preflight_findings(2026, 4, live4, index(*PUBLISHED_1_3), 404, [], [], stage="announce")
check("not live yet -> blocked", len(f) == 1 and "not live" in f[0], f)
f = U.preflight_findings(2026, 4, live4, live4, 200, ["2026-wk04-ups-center"], [], stage="announce")
check("already has a ups_wire_threads row -> blocked", len(f) == 1, f)
f = U.preflight_findings(2026, 4, live4, live4, 200, [], [{"id": "5", "content": "**UPS Center: Week 4** is up."}],
                         stage="announce")
check("already posted in Discord -> blocked", len(f) == 1, f)

print("\n" + ("ALL PASS" if not fails else "%d FAILURE(S)" % fails))
sys.exit(1 if fails else 0)
