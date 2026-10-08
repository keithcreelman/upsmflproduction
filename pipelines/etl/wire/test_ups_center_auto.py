#!/usr/bin/env python3
"""Offline tests for the scheduled UPS Center draft builder.
   python3 pipelines/etl/wire/test_ups_center_auto.py

Fixture: 2026 Week 4, recorded 2026-10-08 from live sources (MFL, D1, the worker,
ups_discord_messages) and the Week 4 pack. Nothing here touches the network, D1,
GitHub or Discord: the PR manager runs against a fake `gh`/`git`.
"""
import copy
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_auto as AUTO            # noqa: E402
import ups_center_issue as ISSUE          # noqa: E402
import ups_center_pr as PR                # noqa: E402
import ups_center_validate as VAL         # noqa: E402

FX = os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "ups_center_auto", "2026_wk04")
PACK = json.load(open(os.path.join(FX, "pack.json")))
CTX = json.load(open(os.path.join(FX, "context.json")))
T0 = 1791475200
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:400]))
    if not cond:
        fails += 1


def build(ctx=None, pack=None, local=True):
    p, c = copy.deepcopy(pack or PACK), copy.deepcopy(ctx or CTX)
    res = ISSUE.render(p, c, generated_at=T0, local_candidates=local)
    return res, VAL.validate(res, c, p), c


print("1. Week 4 renders in the real UPS Center format and validates against its sources")
res, rep, _ = build()
ids = re.findall(r'<section class="wire-sec" id="([^"]+)"', res["html"])
check("eight segments in show order", ids == ["open", "boomer", "desk", "plays", "bb", "landscape", "coffee", "elias"], ids)
check(".uc show markup: desk cards, game deck with one page per division, play cards, bust/bargain lists",
      all(x in res["html"] for x in ('class="wire-wrap uc"', 'class="lt stuart"', 'class="lt boomer"',
                                     'data-wire-gamedeck', 'class="play"', 'class="bbl"'))
      and res["html"].count('class="division wire-gamepage"') == 4)
check("always status: draft", "status: draft" in res["html"] and "status: live" not in res["html"])
check("validation passes", rep["ok"], rep["errors"])
check("every class of claim was checked (scores, margins, records, all-play, PF, projections, quotes, posts)",
      all(rep["checkedClaims"].get(k) for k in ("score", "margin", "rec", "ap", "pf", "wkap", "proj", "quote", "posts")),
      rep["checkedClaims"])
check("not publishable while editor items remain", not rep["publishable"] and res["gaps"])
check("Coffee Shop jokes are an editor gap, with verbatim candidates", any(g["id"] == "coffee:kenny" for g in res["gaps"]))
check("the site's order differs from the F.1 order in the recorded snapshot -> flagged, not hidden",
      any(g["id"] == "landscape:site-order" for g in res["gaps"]))
rows = re.findall(r"MFL proj\. ([^<]+?) ET &middot; kickoff ([^<]+?) ET", res["html"])
check("every bust/bargain row prints its projection capture time and kickoff", len(rows) == 20, len(rows))
check("deterministic: a second render has the same claims", ISSUE.render(copy.deepcopy(PACK), copy.deepcopy(CTX), generated_at=T0,
                                                                        local_candidates=True)["claimsDigest"] == res["claimsDigest"])

pub, pubrep, _ = build(local=False)
chat_lines = [" ".join((m["content"] or "").split()) for m in CTX["d1"]["chat"]]
check("the committed draft (public repo) carries no raw chat: no quote links, no message text",
      'class="rcpt"' not in pub["html"] and not any(len(x) > 20 and x in pub["html"] for x in chat_lines) and pubrep["ok"],
      pubrep["errors"])

print("2. it fails closed")
bad = dict(res, html=res["html"].replace("294.7", "295.7", 1))
r2 = VAL.validate(bad, CTX, PACK)
check("a changed score on the page fails (it is no longer a registered claim)", not r2["ok"], r2["errors"])
bad = dict(res, html=res["html"].replace("<p>Stu, Rich, that is your", "<p>Exactly 412.5 points. Stu, Rich, that is your", 1))
check("an invented number fails", not VAL.validate(bad, CTX, PACK)["ok"])
claims = copy.deepcopy(res["claims"])
claims["score:0011"]["value"] = 300.1
check("a claim that disagrees with MFL fails", any("score:0011" in e for e in VAL.validate(dict(res, claims=claims), CTX, PACK)["errors"]))
claims = copy.deepcopy(res["claims"])
k = next(x for x in claims if x.startswith("proj:"))
claims[k]["value"] = dict(claims[k]["value"], captured=claims[k]["value"]["kickoff"] + 60)
check("a postgame projection capture fails", any("POSTGAME" in e for e in VAL.validate(dict(res, claims=claims), CTX, PACK)["errors"]))

c2 = copy.deepcopy(CTX)
victim = c2["evidence"]["ranked"][0]
listed = [r for r in c2["evidence"]["ranked"] if r["player"] in res["html"]]
victim = listed[0]
victim["captured"] = victim["kickoff"] + 3600            # this player's only capture is now after his kickoff
r3, v3, _ = build(c2)
check("a starter whose capture is postgame is left off the list, with an editor note", victim["player"] in
      " ".join(g["why"] for g in r3["gaps"] if g["id"] == "bb:unproven") and v3["ok"], [g["id"] for g in r3["gaps"]])

c3 = copy.deepcopy(CTX)
c3["evidence"] = {"basis": "first_pregame_fallback", "ranked": [], "unranked": c3["evidence"]["unranked"]}
r4, v4, _ = build(c3)
check("no pregame evidence at all -> no graded lists and a gap (never a postgame number)",
      any(g["id"] == "bb:no-evidence" for g in r4["gaps"]) and not any(k.startswith("proj:") for k in r4["claims"]), v4["errors"])

c4 = copy.deepcopy(CTX)
qid = next(k.split(":", 1)[1] for k in res["claims"] if k.startswith("quote:"))
for m in c4["d1"]["chat"]:
    if m["message_id"] == qid:
        m["content"] = m["content"] + " (edited)"
check("a quote that is not verbatim fails", not VAL.validate(res, c4, PACK)["ok"])

c5 = copy.deepcopy(CTX)
c5["d1"]["chat"].append({"message_id": "999", "channel_id": "1", "channel_name": "the-coffee-shop", "owner_name": "Brian Cross",
                          "franchise_id": "0006", "posted_at_unix": c5["chatWindow"]["since"] + 60,
                          "content": "Talked to my wife about the trade last night, she laughed"})
r6, v6, _ = build(c5)
check("a family/health line is never offered as material", "my wife" not in r6["html"] and v6["ok"])

c6 = copy.deepcopy(CTX)
player = next(iter(c6["links"]))
c6["links"][player] = {"url": None, "verified": False, "why": "no NFL.com page or NFL-channel upload could be confirmed"}
r7, v7, _ = build(c6)
check("an unverified highlight gets no link and an editor gap", any(g["id"] == "plays:" + player for g in r7["gaps"]) and v7["ok"])
forged = dict(r7, html=r7["html"].replace('<div class="editor-gap" data-editor-gap="plays:%s"' % player,
                                          '<a class="wire-play-watch" href="https://example.com/x">Watch</a><div class="editor-gap"'
                                          ' data-editor-gap="plays:%s"' % player, 1))
check("a link nobody verified fails", any("not verified" in e for e in VAL.validate(forged, c6, PACK)["errors"]))

print("3. corrections: an Elias change updates the same week and lists the changed claims")
c7 = copy.deepcopy(CTX)
c7["mfl"]["elias"] = []
r8, _, _ = build(c7)
check("Elias not posted yet -> a gap saying the Thursday/Friday runs will re-check", any(g["id"] == "elias:not-posted" for g in r8["gaps"]))
c8 = copy.deepcopy(CTX)
c8["mfl"]["scores"]["0005"] = 250.7
c8["d1"]["teamScores"]["0005"] = 250.7
c8["eliasReport"] = {"teams": [{"fid": "0005", "before": 250.2, "after": 250.7, "delta": 0.5}]}
_, stale, _ = build(c8)
check("a pack built before the correction is BLOCKED (its graded finals no longer match MFL)",
      not stale["ok"] and any(e.startswith("grade:") for e in stale["errors"]), stale["errors"][:3])
p8 = copy.deepcopy(PACK)                                  # the run rebuilds the pack from the corrected D1
for t_ in p8["tables"]:
    if t_["id"] == "t.grade.games":
        for row in t_["rows"]:
            row[2] = row[2].replace("250.2", "250.7")
r9, v9, _ = build(c8, p8)
ch = PR.changed_claims(res["claims"], r9["claims"])
check("the corrected draft validates", v9["ok"], v9["errors"])
check("changed claims name the moved score and the margins it touched",
      {"claim": "score:0005", "was": 250.2, "now": 250.7} in ch and any(c["claim"].startswith("margin:0005") for c in ch), ch[:6])
check("the corrections segment lists it", "Elias moved 1 team score" in r9["html"])
ed = VAL.check_editor_draft(res["html"], c8, {"0005": 250.2})
check("an editor-owned draft gets the same changed claim from its frozen scores", ed["changedClaims"] ==
      [{"claim": "score:0005", "was": 250.2, "now": 250.7}], ed)


class FakeGH:
    """Records every command; answers gh pr list / git log / git show from a script."""

    def __init__(self, prs=(), log="", old_claims=None, comments=""):
        self.calls, self.prs, self.log, self.old, self.comments = [], list(prs), log, old_claims, comments

    def __call__(self, cmd, cwd=None):
        self.calls.append(cmd)
        if cmd[:3] == ["gh", "pr", "list"]:
            return 0, json.dumps(self.prs)
        if cmd[:2] == ["git", "log"]:
            return 0, self.log
        if cmd[:2] == ["git", "show"]:
            return (0, json.dumps(self.old)) if self.old is not None else (128, "")
        if cmd[:3] == ["gh", "pr", "view"]:
            return 0, self.comments
        if cmd[:3] == ["gh", "pr", "create"]:
            return 0, "https://github.com/keithcreelman/upsmflproduction/pull/4242"
        return 0, ""

    def used(self, *words):
        return [c for c in self.calls if all(w in c for w in words)]


AID, PATH = "2026-wk04-ups-center", "site/wire/articles/2026/2026-wk04-ups-center.html"
pushed = []
wb = lambda: pushed.append(1)   # noqa: E731

print("4. one draft PR per week")
g = FakeGH()
o = PR.sync(g, AID, PATH, res, rep, wb)
check("no PR -> creates ONE draft PR", o["action"] == "created" and len(g.used("gh", "pr", "create", "--draft")) == 1 and pushed, o)
mine = {"number": 4242, "headRefName": PR.branch_for(AID), "isDraft": True, "url": "u", "files": [{"path": PATH}],
        "body": PR.body(AID, res, rep, [], "")}
g = FakeGH([mine], log="abc|%s\n" % res["claimsDigest"])
pushed.clear()
check("same claims -> no-op, nothing pushed", PR.sync(g, AID, PATH, res, rep, wb)["action"] == "noop" and not pushed)
g = FakeGH([mine], log="abc|%s\n" % res["claimsDigest"], old_claims=res["claims"])
o = PR.sync(g, AID, PATH, r9, v9, wb)
check("Elias moved a score -> UPDATE the same PR (rebuilt branch, new body, changed-claims comment)",
      o["action"] == "updated" and pushed and g.used("gh", "pr", "edit") and g.used("gh", "pr", "comment")
      and any(c["claim"] == "score:0005" for c in o["changes"]), o["action"])
editor = dict(mine, number=1195, headRefName="wire/2026-wk04-ups-center")
pushed.clear()
g = FakeGH([editor])
check("a PR on another branch (hand-built #1195) is editor-owned: never overwritten",
      PR.sync(g, AID, PATH, r9, v9, wb)["action"] == "editor-owned" and not pushed)
g = FakeGH([mine], log="abc|%s\ndef|\n" % res["claimsDigest"])
check("a commit on the auto branch without the automation trailer makes it editor-owned",
      PR.sync(g, AID, PATH, r9, v9, wb)["action"] == "editor-owned" and not pushed)
g = FakeGH([mine, editor])
check("two open PRs for one issue -> stop (duplicate), touch nothing", PR.sync(g, AID, PATH, res, rep, wb)["action"] == "stop-duplicate")
g = FakeGH()
check("dry mode decides without writing", PR.sync(g, AID, PATH, res, rep, wb, dry=True)["action"] == "would-create"
      and not g.used("gh", "pr", "create"))
for verb in ("merge", "ready", "close"):
    try:
        PR._gh(FakeGH(), ["pr", verb, "1"])
        refused = False
    except RuntimeError:
        refused = True
    check("refuses `gh pr %s`" % verb, refused)
g = FakeGH(comments="... ups-center-auto-recheck=%s ..." % PR.comment_editor_pr(FakeGH(), 1195, AID, ed, dry=True)["digest"])
check("the editor re-check comment is posted once per distinct result", PR.comment_editor_pr(g, 1195, AID, ed)["action"] == "noop")

print("5. alerts and the no-publish guarantee")
a = AUTO.alert_issue(FakeGH(), AID, ["D1 does not match MFL yet: 0005 251.2 vs 250.2"], None, dry=True)
check("the failure alert is plain English with the reason and says nothing was published",
      "D1 does not match MFL yet" in a["text"] and "Nothing was published or posted" in a["text"], a)
src = "".join(open(os.path.join(HERE, f)).read() for f in ("ups_center_auto.py", "ups_center_pr.py", "ups_center_issue.py",
                                                            "ups_center_validate.py", "ups_center_sources.py"))
check("no Discord write anywhere in the pipeline (no POST, no send, no webhook)",
      not re.search(r"send_discord|/webhooks/|method=\"POST\"|method='POST'|urlopen\([^)]*data=", src))
check("no publish path: nothing sets status: live or runs a merge", "status: live" not in src and '"merge"' in src
      and "gh pr merge" not in src.replace("`gh pr merge/ready/close`", "").replace("`gh pr %s`", ""))

print("6. ruled-out chat never reaches a pack, a draft, a preview or a review copy")
import tempfile                                                           # noqa: E402
import chat_exclusions as CX                                              # noqa: E402
import ups_center_sources as SRC                                          # noqa: E402
import wire_data as WD                                                    # noqa: E402
INJURY, FAMILY = "1556369890321899692", "1557163194651254845"            # site/wire/data/chat_exclusions.json
ids = CX.excluded_ids()
check("both ruled-out posts are on the id list (ids only -- the text never enters the repo)",
      ids.get(INJURY) and ids.get(FAMILY) and "content" not in open(CX.PATH).read())
check("excluded BY ID even when the text looks harmless", CX.reason(INJURY, "nice win this week", ids)
      and CX.reason(FAMILY, "nice win this week", ids))
check("the pattern net catches family and graphic-injury lines (synthetic text)",
      CX.reason("1", "my wife says hi to the league", ids) and CX.reason("1", "hope he tears his ACL on the first snap", ids)
      and CX.reason("1", "that hit looked career-ending", ids))
check("ordinary trash talk is kept", CX.reason("1", "Bijan carried my whole week, sorry fellas", ids) is None)
check("an editor can clear a pattern-only match (NFL injury news) but never an id ruling",
      CX.reason("1", "Dart could need season ending surgery", ids, cleared=True) is None
      and CX.reason(INJURY, "nice win this week", ids, cleared=True))
try:
    CX.excluded_ids(os.path.join(tempfile.mkdtemp(), "missing.json"))
    closed = False
except (OSError, ValueError):
    closed = True
check("a missing exclusion list raises (fails closed, never allows everything)", closed)
tmp = tempfile.mkdtemp()
json.dump({"terms": ["Zorblax Quinn"]}, open(os.path.join(tmp, CX.PRIVATE_FILE), "w"))
pat, where = CX.private_terms([tmp])
check("private names come from a local-only file and are matched", where and pat.search("congrats to Zorblax Quinn")
      and not pat.search("congrats to the champ"))
saved = CX._PRIVATE
CX._PRIVATE = (pat, where)
try:
    check("a private name is withheld even when an editor clears the pattern",
          CX.reason("1", "congrats to Zorblax Quinn on the win", {}, cleared=True))
finally:
    CX._PRIVATE = saved
local_pat, local_file = CX.private_terms()                 # Keith's Mac only; absent in CI
public = "".join(open(os.path.join(HERE, f)).read() for f in ("chat_exclusions.py", "ups_center_issue.py",
                                                             "ups_center_validate.py", "test_ups_center_auto.py"))
check("the public code names no one (private names live only in the gitignored file%s)"
      % ("" if local_file else "; no local file here, so only its absence from the repo is checked"),
      (local_pat is None or not local_pat.search(public))
      and not os.path.exists(os.path.join(HERE, "..", "..", "..", "site", "wire", "data", CX.PRIVATE_FILE)))

rows = [{"message_id": INJURY, "owner_name": "A", "franchise_id": "0001", "content": "synthetic text for the ruled-out id",
         "posted_at_unix": 1, "channel_name": "c"},
        {"message_id": "2", "owner_name": "B", "franchise_id": "0002", "content": "my daughter picked my lineup this week",
         "posted_at_unix": 2, "channel_name": "c"},
        {"message_id": "3", "owner_name": "C", "franchise_id": "0003", "content": "that trade is going to age like milk",
         "posted_at_unix": 3, "channel_name": "c"}]
real_d1 = WD.d1
WD.d1 = lambda *a, **k: copy.deepcopy(rows)
try:
    got = [r["message_id"] for r in WD.week_quotes(2026, 4)]
finally:
    WD.d1 = real_d1
check("pack auto-picks (wire_data.week_quotes) drop ruled-out and never-material lines", got == ["3"], got)
w = SRC.withhold(copy.deepcopy(rows))
check("the sources snapshot blanks withheld text at the source but keeps the post for the counts",
      [m["content"] is None for m in w] == [True, True, False] and all(m.get("withheld") for m in w[:2]))
src_recap = open(os.path.join(HERE, "packs", "weekly_recap.py")).read()
check("an editor's quote pick of a ruled-out post fails the pack build",
      "chat_exclusions.reason(pk[\"messageId\"]" in src_recap and "may not be used" in src_recap)

local, lrep, _ = build(local=True)
check("the LOCAL review copy lists candidates but neither ruled-out post (not its link, not its id)",
      'class="rcpt"' in local["html"] and INJURY not in local["html"] and FAMILY not in local["html"]
      and not any(k.endswith(INJURY) or k.endswith(FAMILY) for k in local["claims"]) and lrep["ok"], lrep["errors"])
check("the committed draft carries neither id either", INJURY not in pub["html"] and FAMILY not in pub["html"])
check("the editor box says how many were withheld",
      re.search(r"(\d+) message\(s\) ruled out by an editor", local["html"])
      and int(re.search(r"(\d+) message\(s\) ruled out", local["html"]).group(1)) >= 2)
forced = copy.deepcopy(local)
txt = next(m["content"] for m in CTX["d1"]["chat"] if m["message_id"] == INJURY)
qk = next(k for k in local["claims"] if k.startswith("quote:"))
forced["claims"]["quote:" + INJURY] = dict(local["claims"][qk], value=txt, shown=txt)
fv = VAL.validate(forced, copy.deepcopy(CTX), copy.deepcopy(PACK))
check("a ruled-out quote forced into a draft fails validation", not fv["ok"]
      and any("may not be used" in x and INJURY in x for x in fv["errors"]), fv["errors"])

print("7. catch-up after a missed Mac run, and the sandbox demo")
from datetime import datetime as _dt                                      # noqa: E402
from zoneinfo import ZoneInfo as _Z                                       # noqa: E402
ny = _Z("America/New_York")
last = int(_dt(2026, 10, 5, 23, 0, tzinfo=ny).timestamp())               # Mon night: the Mac went to sleep
now = int(_dt(2026, 10, 8, 14, 0, tzinfo=ny).timestamp())                # Thu 2 PM: it woke up
miss = AUTO.missed_slots(last, now)
check("slots slept through are reported (Tue 10:00, Wed 10:00, Thu 09:00)", len(miss) == 3 and miss[0].startswith("Tue Oct 06"),
      miss)
check("a run right on its own slot is not reported as missed",
      AUTO.missed_slots(int(_dt(2026, 10, 6, 10, 0, tzinfo=ny).timestamp()),
                        int(_dt(2026, 10, 7, 10, 1, tzinfo=ny).timestamp())) == [])
check("the first ever run reports nothing missed", AUTO.missed_slots(None, now) == [])
check("each run also rebuilds any of the last three finished weeks (newest first)", AUTO.weeks_to_build(2026, now, latest=5) == [5, 4, 3]
      and AUTO.weeks_to_build(2026, now, latest=1) == [1])
plist = open(os.path.join(HERE, "..", "..", "..", "scripts", "install_ups_center_auto.sh")).read()
check("the LaunchAgent also runs at login (RunAtLoad), so a Mac that was off catches up", "<key>RunAtLoad</key><true/>" in plist)
g = FakeGH()
out = PR.sync(g, AID + "-sandbox", "site/wire/articles/_sandbox/%s-sandbox.html" % AID, res, rep, wb,
              title_prefix="[SANDBOX demo -- will be closed] ")
check("a sandbox PR is titled as a demo and lives under articles/_sandbox (never indexed or published)",
      out["action"] == "created" and any("[SANDBOX demo" in " ".join(c) for c in g.calls if "create" in c))
import ups_center_due as DUE                                              # noqa: E402
sb = DUE.preflight_findings(2026, 4, {"articles": [{"id": AID, "status": "live", "path": "articles/2026/%s.html" % AID}]},
                            None, None, [], [], stage="publish", aid=AID + "-sandbox",
                            path="articles/_sandbox/%s-sandbox.html" % AID, title="UPS Center sandbox")
real = DUE.preflight_findings(2026, 4, {"articles": [{"id": AID, "status": "live", "path": "articles/2026/%s.html" % AID}]},
                              None, None, [], [], stage="publish")
check("the duplicate check still stops the real week (live) but not its sandbox twin", real and not sb, (real, sb))

print("\n" + ("ALL PASS" if not fails else "%d FAILURE(S)" % fails))
sys.exit(1 if fails else 0)
