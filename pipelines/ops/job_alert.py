#!/usr/bin/env python3
"""Job-failure alerts: one GitHub issue per job, plus brief private Discord messages.

Keith's BL-I03 ruling (2026-11-22). Called as the last step of a scheduled workflow with the job's status.

  failure, no open issue  -> open "[data-alert] <job>" (label data-alert), send the INITIAL alert
  failure, open issue     -> update its counts and timestamps, comment the run link, and send a
                             REMINDER only if the last Discord message is 48 h or more old
  success, open issue     -> send ONE recovery message, comment, close the issue (reminders stop)
  success, no open issue  -> nothing
  --test                  -> one clearly labeled TEST message, no issue change

State lives in the issue body, in one HTML comment (`<!-- job-alert-state {...} -->`), so it is
visible and auditable. No D1, no repo file.

Discord is OFF unless ALERT_DISCORD_ENABLED is "1". Then it needs DISCORD_BOT_TOKEN and exactly one
target: ALERT_DISCORD_USER_ID (a direct message) or ALERT_DISCORD_CHANNEL_ID, a 15-21 digit id.
The target ids are repository SECRETS, not variables: GitHub masks secrets in the public Actions
logs, but prints variables in each step's environment. When Discord is off,
the issue still records the failure and says Discord was not sent. When Discord is on and delivery
fails, the issue says so and this script exits 2, so a broken alert path is never silent.
A recovery whose Discord message fails leaves the issue open; the next success retries it.

Reminders go out only when the job runs again and fails: a daily job is checked daily, so a
48-hour reminder is sent within a day of being due. A job that stops running sends no reminder.

Public repository: the issue carries the job name, what it affects, counts, timestamps and Actions
run links only. Never log contents, owner text, tokens or ids.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

LABEL = "data-alert"
REMINDER_EVERY = timedelta(hours=48)
STATE_RE = re.compile(r"<!-- job-alert-state (\{.*?\}) -->", re.S)
DISCORD_API = "https://discord.com/api/v10"


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str | None) -> datetime | None:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if s else None


def title_for(job: str) -> str:
    return f"[data-alert] {job}"


def read_state(body: str) -> dict:
    m = STATE_RE.search(body or "")
    return json.loads(m.group(1)) if m else {}


def render_body(st: dict) -> str:
    return "\n".join([
        f"**Scheduled job failing: `{st['job']}`**",
        "",
        f"- **Affects:** {st.get('affects') or 'not stated'}",
        f"- **Failing since:** {st['first_failure']} (first failed run: {st['first_run']})",
        f"- **Latest failure:** {st['last_failure']} ({st['last_run']})",
        f"- **Failed runs in this episode:** {st['failures']}",
        f"- **Last Discord message:** {st.get('last_discord') or 'none sent'}",
        f"- **Discord status:** {st.get('discord_note') or 'n/a'}",
        "",
        "Each failed run is listed in the comments with its Actions log link. This issue closes itself, with one "
        "recovery message, on the job's next successful run. Reminders go out every 48 hours while it stays open.",
        "",
        f"<!-- job-alert-state {json.dumps(st, sort_keys=True)} -->",
    ])


class GitHub:
    """The few `gh` calls this needs. Tests replace it with an in-memory fake."""

    def _gh(self, *args: str) -> str:
        return subprocess.run(["gh", *args], capture_output=True, text=True, check=True).stdout

    def find_open(self, title: str) -> dict | None:
        out = self._gh("issue", "list", "--label", LABEL, "--state", "open", "--limit", "100",
                       "--json", "number,title,body,url")
        return next((it for it in json.loads(out or "[]") if it.get("title") == title), None)

    def ensure_label(self) -> None:
        self._gh("label", "create", LABEL, "--color", "B60205", "--force",
                 "--description", "A scheduled data job is failing")

    def create(self, title: str, body: str) -> dict:
        url = self._gh("issue", "create", "--title", title, "--label", LABEL, "--body", body).strip()
        return {"number": int(url.rstrip("/").split("/")[-1]), "url": url, "title": title, "body": body}

    def edit_body(self, number: int, body: str) -> None:
        self._gh("issue", "edit", str(number), "--body", body)

    def comment(self, number: int, text: str) -> None:
        self._gh("issue", "comment", str(number), "--body", text)

    def close(self, number: int) -> None:
        self._gh("issue", "close", str(number))


def discord_config(env: dict) -> tuple:
    """-> (enabled, reason_if_not_ready, kind, target)."""
    if env.get("ALERT_DISCORD_ENABLED", "") != "1":
        return False, "Discord alerts are off (ALERT_DISCORD_ENABLED is not 1)", None, None
    user = env.get("ALERT_DISCORD_USER_ID", "").strip()
    chan = env.get("ALERT_DISCORD_CHANNEL_ID", "").strip()
    if not env.get("DISCORD_BOT_TOKEN", "").strip():
        return True, "no Discord bot token available to this job", None, None
    if bool(user) == bool(chan):
        return True, "set exactly one of ALERT_DISCORD_USER_ID or ALERT_DISCORD_CHANNEL_ID", None, None
    if not re.fullmatch(r"\d{15,21}", user or chan):
        # The value itself is never echoed: it is private, and it may be a stray placeholder such as "-".
        return True, (f"ALERT_DISCORD_{'USER' if user else 'CHANNEL'}_ID is not a Discord id "
                      "(expected 15 to 21 digits)"), None, None
    return True, None, ("user" if user else "channel"), (user or chan)


def _post(url: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers={
        "Authorization": f"Bot {token}", "Content-Type": "application/json",
        "User-Agent": "ups-data-alert (github actions)"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"{}")


def send_discord(env: dict, text: str) -> tuple:
    """-> (sent, note). Never raises; the note never contains the token or the target id."""
    enabled, reason, kind, target = discord_config(env)
    if not enabled or reason:
        return False, reason
    token = env["DISCORD_BOT_TOKEN"].strip()
    try:
        channel = target
        if kind == "user":
            channel = _post(f"{DISCORD_API}/users/@me/channels", token, {"recipient_id": target})["id"]
        _post(f"{DISCORD_API}/channels/{channel}/messages", token,
              {"content": text[:1900], "allowed_mentions": {"parse": []}})
        return True, f"sent ({'direct message' if kind == 'user' else 'private channel'})"
    except Exception as exc:  # a delivery failure is recorded, never hidden
        return False, f"DELIVERY FAILED ({exc.__class__.__name__})"


def handle(job: str, status: str, run_url: str, affects: str, now: datetime, gh, env: dict,
           send=send_discord) -> int:
    title = title_for(job)
    issue = gh.find_open(title)
    enabled = discord_config(env)[0]

    if status == "success":
        if not issue:
            print(f"{job}: success, nothing open")
            return 0
        st = read_state(issue["body"])
        sent, note = send(env, f"✅ Recovered: `{job}` succeeded at {iso(now)} after "
                               f"{st.get('failures', '?')} failed run(s). Record: {issue['url']}")
        if enabled and not sent:
            gh.comment(issue["number"], f"Job succeeded at {iso(now)} ({run_url}), but the recovery message "
                                        f"was not delivered: {note}. Left open; the next success retries it.")
            print(f"{job}: recovered; recovery message NOT delivered ({note})")
            return 2
        gh.comment(issue["number"], f"✅ Recovered at {iso(now)}: {run_url}. Discord: {note}. "
                                    "Closing; reminders stop.")
        gh.close(issue["number"])
        print(f"{job}: recovered; issue #{issue['number']} closed ({note})")
        return 0

    gh.ensure_label()
    if not issue:
        st = {"job": job, "affects": affects, "first_failure": iso(now), "first_run": run_url,
              "last_failure": iso(now), "last_run": run_url, "failures": 1, "last_discord": None,
              "discord_note": None}
        issue = gh.create(title, render_body(st))
        kind = "initial alert"
        sent, note = send(env, f"⚠️ UPS data job failed: `{job}`. Affects: {affects or 'not stated'}. "
                               f"Record: {issue['url']}")
    else:
        st = read_state(issue["body"]) or {"job": job, "first_failure": iso(now), "first_run": run_url,
                                           "failures": 0, "last_discord": None}
        st.update({"affects": affects or st.get("affects"), "last_failure": iso(now), "last_run": run_url,
                   "failures": int(st.get("failures", 0)) + 1})
        last = parse_iso(st.get("last_discord"))
        if last is None or now - last >= REMINDER_EVERY:
            kind = "reminder"
            sent, note = send(env, f"⏰ Still failing: `{job}`, {st['failures']} failed runs since "
                                   f"{st['first_failure']}. Record: {issue['url']}")
        else:
            kind, sent, note = None, False, f"no message this run (last {st['last_discord']}; next after 48 h)"
    if sent:
        st["last_discord"] = iso(now)
    if kind:
        st["discord_note"] = f"{kind}: {note}"
    gh.edit_body(issue["number"], render_body(st))
    gh.comment(issue["number"], f"Failed run {st['failures']} at {iso(now)}: {run_url}"
                                + (f" · Discord {kind}: {note}" if kind else f" · {note}"))
    print(f"{job}: failure {st['failures']} recorded on #{issue['number']}; Discord: {note}")
    return 2 if (enabled and kind and not sent) else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--job", required=True)
    ap.add_argument("--status", choices=("success", "failure", "cancelled", "skipped"))
    ap.add_argument("--run-url", default="")
    ap.add_argument("--affects", default="")
    ap.add_argument("--test", action="store_true", help="send one clearly labeled TEST message and exit")
    a = ap.parse_args(argv)
    env = dict(os.environ)
    if a.test:
        sent, note = send_discord(env, f"[TEST] UPS data-alert path check from `{a.job}`. No job failed. "
                                       f"Run: {a.run_url}")
        print(f"TEST message: {note}")
        return 0 if sent else 2
    if a.status not in ("success", "failure"):
        print(f"{a.job}: status {a.status}; no alert change")
        return 0
    return handle(a.job, a.status, a.run_url, a.affects, datetime.now(timezone.utc), GitHub(), env)


if __name__ == "__main__":
    sys.exit(main())
