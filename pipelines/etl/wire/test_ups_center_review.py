#!/usr/bin/env python3
"""UPS Center review email + approval gate, offline.

Drives draft -> review email -> approval gate with a fake gh/git runner and a fake SMTP server.
Nothing is sent, nothing is posted to GitHub or Discord, nothing is published.

Usage:
  python3 pipelines/etl/wire/test_ups_center_review.py
"""
import calendar
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ups_center_review as R  # noqa: E402

AID = "2026-wk08-ups-center"
ARTICLE = ('<html><head><title>UPS Center: Week 8</title></head><body><p class="wire-dek">Dek line.</p>'
           '<section class="wire-sec" id="story" data-title="The Big Story"><div class="label"><span class="seg">1</span> '
           'The Big Story <small>&mdash; Synthetic</small></div><div class="desk-lines"><div class="lt stuart">'
           '<div class="who">Stuart</div><p>Team A is at 50.0% &amp; rising.</p></div></div></section>'
           '<div class="editor-gap" data-editor-gap="plays:X" style="x">EDITOR REVIEW &mdash; No link for X &amp; Y.</div>'
           '<div><b>Still to come.</b> The Elias segment.</div></body></html>')
DIGEST = R.article_hash(ARTICLE)
BODY = "### Editor review needed\n- stale automated-draft gap that must NOT be emailed\n"


def utc(s):
    return calendar.timegm(time.strptime(s, "%Y-%m-%d %H:%M"))


def c(cid, who, body, at="2026-10-29T10:00:00Z", upd=None):
    return {"id": cid, "created_at": at, "updated_at": upd or at, "user": {"login": who}, "body": body}


OK = R.approval_line(AID, DIGEST)
fails = []


def check(name, cond):
    if not cond:
        fails.append(name)
        print("FAIL", name)


# ---- gate ----
def state(*cs):
    return R.evaluate(list(cs), AID, DIGEST)["state"]


check("no comments awaiting", state() == "awaiting")
check("keith exact line approves", state(c(1, "keithcreelman", OK)) == "approved")
check("login case-insensitive", state(c(1, "KeithCreelman", OK)) == "approved")
check("someone else's line is ignored", state(c(1, "mallory", OK)) == "awaiting")
check("wrong article hash is stale", state(c(1, "keithcreelman", R.approval_line(AID, "0" * 12))) == "stale-approval")
check("other issue id ignored", state(c(1, "keithcreelman", R.approval_line("2026-wk07-ups-center", DIGEST))) == "awaiting")
check("status line prefix does not count", state(c(1, "keithcreelman", "AI-SPRINT v2 | " + OK)) == "awaiting")
check("agent header does not count", state(c(1, "keithcreelman", "**Agent update (Claude):**\n" + OK)) == "awaiting")
check("trailing text does not count", state(c(1, "keithcreelman", OK + " please")) == "awaiting")
check("quoted in prose does not count", state(c(1, "keithcreelman", "To approve, comment: " + OK)) == "awaiting")
check("edited comment does not count", state(c(1, "keithcreelman", OK, upd="2026-10-29T11:00:00Z")) == "awaiting")
check("later CHANGES revokes", state(c(1, "keithcreelman", OK), c(2, "keithcreelman", "CHANGES %s fix the lead" % AID,
                                                                   at="2026-10-29T12:00:00Z")) == "changes-requested")
check("later APPROVE after CHANGES approves", state(c(1, "keithcreelman", "CHANGES %s x" % AID),
                                                    c(2, "keithcreelman", OK, at="2026-10-29T12:00:00Z")) == "approved")
check("generic 'go' is not approval", state(c(1, "keithcreelman", "go")) == "awaiting")
check("edited article voids approval", R.evaluate([c(1, "keithcreelman", OK)], AID, R.article_hash(ARTICLE + " ")) ["state"]
      == "stale-approval")

# ---- readiness ----
FINAL = utc("2026-10-27 04:00")                       # Mon night, after the last game
THU = utc("2026-10-29 14:00")
FRI_AFTER = utc("2026-10-30 14:00")
posted = {"officialChanges": [{"id": 1}], "checkedAtUtc": "2026-10-29T13:00:00Z"}
none = {"officialChanges": [], "checkedAtUtc": "2026-10-29T13:00:00Z"}
check("elias posted+checked is settled", R.elias_settled(posted, THU, FINAL)[0])
check("elias silent on Thursday is not settled", not R.elias_settled(none, THU, FINAL)[0])
check("elias silent after Friday 09:00 ET is settled", R.elias_settled(none, FRI_AFTER, FINAL)[0])
check("elias silent just before Friday 09:00 ET is not", not R.elias_settled(none, utc("2026-10-30 12:59"), FINAL)[0])
check("elias missing file before Friday is not settled", not R.elias_settled(None, THU, FINAL)[0])
check("validation errors block", not R.ready({"errors": ["bad"]}, posted, THU, FINAL)[0])
check("clean + settled is ready", R.ready({"errors": []}, posted, THU, FINAL)[0])

# ---- compose ----
parts = R.story_parts(ARTICLE)
check("story parsed", parts["lines"] == [("Stuart", "Team A is at 50.0% & rising.")] and parts["dek"] == "Dek line.")
gaps = R.gaps_from_article(ARTICLE)
check("gaps come from the article, not the PR body", gaps == ["plays:X: No link for X & Y.", "Still to come: The Elias segment."])
msg = R.compose(AID, 8, "https://github.com/o/r/pull/9", DIGEST, parts, gaps, "no Elias changes", pdf=None, now=utc("2026-10-30 14:00"))
body = msg.get_body(("plain",)).get_content()
check("email says not an approval", "not an approval" in body.lower() and "NOT PUBLISHED" in body)
check("email carries exact approve line", OK in body and "CHANGES %s" % AID in body)
check("email carries story + gaps + pr", "Team A is at 50.0%" in body and "plays:X" in body and "pull/9" in body)
check("email goes to Keith only", msg["To"] == R.TO and not msg["Cc"] and not msg["Bcc"])
check("update flag in subject", R.compose(AID, 8, "u", DIGEST, parts, gaps, "n", update=True)["Subject"].startswith("UPDATED "))


# ---- send: fake SMTP, recipient lock ----
class FakeSMTP:
    sent = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def login(self, u, p):
        self.u = u

    def send_message(self, m, from_addr=None, to_addrs=None):
        FakeSMTP.sent.append((m["Subject"], to_addrs))


R.send(msg, smtp_factory=FakeSMTP, password="x")
check("one message to Keith", FakeSMTP.sent == [(msg["Subject"], [R.TO])])
bad = R.compose(AID, 8, "u", DIGEST, parts, gaps, "n")
bad.replace_header("To", "someone@example.com")
try:
    R.send(bad, smtp_factory=FakeSMTP, password="x")
    check("other recipient refused", False)
except RuntimeError:
    check("other recipient refused", True)
cc = R.compose(AID, 8, "u", DIGEST, parts, gaps, "n")
cc["Cc"] = "x@example.com"
try:
    R.send(cc, smtp_factory=FakeSMTP, password="x")
    check("Cc refused", False)
except RuntimeError:
    check("Cc refused", True)
check("refusals sent nothing", len(FakeSMTP.sent) == 1)

# ---- end to end through load_pr/comments_for with a fake gh/git (draft -> email -> gate) ----
calls = []
thread = []


def fake(cmd, cwd=None):
    calls.append(cmd)
    if cmd[:3] == ["gh", "pr", "view"]:
        return 0, json.dumps({"number": 9, "url": "https://github.com/o/r/pull/9", "body": BODY, "headRefName": "wire/x",
                              "headRefOid": "abc", "isDraft": True, "state": "OPEN"})
    if cmd[:2] == ["git", "fetch"]:
        return 0, ""
    if cmd[:2] == ["git", "diff"]:
        return 0, "site/wire/articles/2026/%s.html\nsite/wire/data/elias_2026_wk08.json\n" % AID
    if cmd[:2] == ["git", "show"]:
        p = cmd[2].split(":", 1)[1]
        if p.endswith(".html"):
            return 0, ARTICLE
        if p.endswith("validation.json"):
            return 0, json.dumps({"errors": []})
        if "elias_" in p:
            return 0, json.dumps(posted)
    if cmd[:2] == ["gh", "api"]:
        return 0, "\n".join(json.dumps(x) for x in thread)
    return 1, "unexpected " + " ".join(cmd)


d = R.load_pr(9, ".", run=fake)
check("load_pr finds the article", d["aid"] == AID and R.article_hash(d["html"]) == DIGEST and d["week"] == 8)
check("gate awaiting after email alone", R.evaluate(R.comments_for(9, ".", run=fake), d["aid"], DIGEST)["state"] == "awaiting")
thread.append(c(5, "keithcreelman", OK))
check("gate approved after Keith's line", R.evaluate(R.comments_for(9, ".", run=fake), d["aid"], DIGEST)["state"] == "approved")
check("module only read from gh/git (no writes)", all(x[:3] in (["gh", "pr", "view"],) or x[:2] in (["gh", "api"], ["git", "fetch"],
      ["git", "diff"], ["git", "show"]) for x in calls) and not any(w in x for x in calls for w in ("merge", "ready", "comment", "create")))

# ---- sent marker is per article version ----
with tempfile.TemporaryDirectory() as t:
    R.STATE_DIR = t
    check("not sent yet", not R.already_sent(AID, DIGEST) and not R.previously_sent(AID))
    json.dump({}, open(R.sent_marker(AID, DIGEST), "w"))
    check("sent once", R.already_sent(AID, DIGEST) and R.previously_sent(AID) and not R.already_sent(AID, "f" * 12))

if fails:
    print("%d FAILED" % len(fails))
    sys.exit(1)
print("ups_center_review: all checks passed")
