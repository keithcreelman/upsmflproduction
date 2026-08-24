"""Remind the commish to drop the MFL roster maximum 35 -> 30 at the contract deadline.

WHY THIS EXISTS
    The UPS roster maximum MOVES: 35 until the September contract deadline, then
    30. MFL holds ONE number on Roster Position Limits Setup and does NOT switch
    it on a date, so dropping it is a manual commish edit. Miss it and MFL keeps
    enforcing 35 for the rest of the season while canon says 30 — and nothing
    errors, so nobody notices until someone is carrying 33 players in November.

    Deliberately NOT added to DEADLINE_REMINDER_CALENDAR: those reminders go to
    all 12 owners, and this is a commish chore, not league news. Posts to the
    TEST channel instead.

    Reads the deadline from the league calendar rather than hardcoding a date —
    it moves every season, and this chore recurs every season.

Usage:  ci_roster_max_reminder.py [--force]
        --force posts regardless of date (for testing).
"""
import json, os, sys, urllib.request
from datetime import datetime, timedelta, timezone

WORKER = "https://upsmflproduction.keith-creelman.workers.dev"
LEAGUE = "74598"
TEST_CHANNEL = "1089538054236160010"
ET = timezone(timedelta(hours=-4))
UA = "upsmflproduction-roster-max-reminder"


def main(force: bool) -> int:
    today = datetime.now(ET).date()
    season = str(today.year)
    url = f"{WORKER}/api/league-events?season={season}&from=all&limit=50"
    # A default python-urllib User-Agent gets 403'd (seen 2026-08-24). Every
    # request here sets one explicitly — a reminder that cannot read its own
    # date is worse than no reminder, because it fails on the one day it matters.
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
    except Exception as e:
        print(f"FAILED to read the league calendar: {e}")
        return 1  # loud, not silent — a reminder that cannot read its date is broken

    row = next((e for e in (data.get("events") or [])
                if str(e.get("event")) == "ups_contract_deadline"), None)
    deadline = str(row.get("date"))[:10] if row else ""
    if not deadline:
        print(f"FAILED: no ups_contract_deadline on file for {season}.")
        return 1

    d = datetime.strptime(deadline, "%Y-%m-%d").date()
    days = (d - today).days
    print(f"today={today} deadline={deadline} days_out={days}")

    # Fire the day before (so it can be done in advance) and on the day itself.
    if not force and days not in (1, 0):
        print("Not a reminder day — nothing to send.")
        return 0

    when = "TOMORROW" if days == 1 else ("TODAY" if days == 0 else f"in {days} days")
    content = (
        f"🗓️ **Commish chore — roster maximum**\n"
        f"The contract deadline is **{when}** ({deadline}). "
        f"The UPS roster max drops **35 → 30** when it passes.\n\n"
        f"MFL holds one number and will not switch it on a date — change it by hand:\n"
        f"`csetup` → **Roster Position Limits Setup** → *Total across all positions* → "
        f"set the maximum to **30** (leave the minimum at 27).\n\n"
        f"If this is missed, MFL keeps enforcing 35 all season while canon says 30, "
        f"and nothing will error to tell you."
    )
    key = os.environ.get("COMMISH_API_KEY", "")
    if not key:
        print("REFUSE: COMMISH_API_KEY not set."); return 2

    body = json.dumps({"channel_id": TEST_CHANNEL, "content": content}).encode()
    req = urllib.request.Request(
        f"{WORKER}/admin/discord/post?APIKEY={urllib.parse.quote(key)}&L={LEAGUE}",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": UA}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    print("posted:", json.dumps(out)[:200])
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    import urllib.parse
    sys.exit(main("--force" in sys.argv))
