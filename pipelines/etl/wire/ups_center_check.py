#!/usr/bin/env python3
"""Post-build check of an automated UPS Center draft (Keith 2026-10-15: "a permanent post-build
validation -- not a Week 6-only workaround -- so every future UPS Center draft receives the same
checks"). Runs in GitHub Actions on every automated draft PR (ups-center-post-build-check.yml), so it
needs neither Keith's Mac nor the Claude app; it also runs by hand:

    python3 pipelines/etl/wire/ups_center_check.py --season 2026 --week 6 [--out-dir DIR] [--comment]

What it reads, and nothing else:
  * the draft, as the job committed it on wire/auto/<id> -- the article, claims.json, validation.json,
    run.json (the build's recorded inputs: when the week went final, the forecast it rendered from),
    the two forecast files and the branch's index.json -- through `git show`, never by checking the
    branch out or running its code. These are the same recorded inputs the draft was built from.
  * live publication state: main's index, the Pages index and page, ups_wire_threads (a SELECT through
    wire_data.d1, which refuses anything else) and #league-announcements (a Discord GET).
It writes only its report (report.md / report.json) and, with --comment, one comment on the open
draft PR, edited in place on later runs. No publish, no announcement, no MFL, D1 or Discord write.

Checks (any failure exits 1; a check it cannot complete fails, it never passes by default):
  1 draft created            open DRAFT PR from wire/auto/<id> to main; the article, claims, validation
                             and run record are on it; validation clean; the branch index says draft
  2 forecast freshness       odds through this week, run after the week went final; next-week preview
                             through this week with inputs after final, same simulated seasons; the
                             committed files are the ones the draft recorded; Playoff Picture printed
  3 six playoff teams        playoff odds total six teams in every season, byes two, titles one;
                             bye <= division <= playoffs and title <= playoffs for each team
  4 division totals          each division's title odds total every season, and print as exactly 100.0
  5 scenario cells           each team's next-week cells sum to its playoff, division and bye counts
  6 every number sourced     every claim names a source; every number on the page is a claim; every
                             printed probability equals the committed forecast under its rounding
  7 review boxes block       every editor item has its EDITOR REVIEW box and every box is an editor
                             item; not publishable while one remains; `wire.py verify` refuses the
                             page as live while any box is on it
  8 still a draft            article is status: draft; PR not merged; not in main's or the Pages index,
                             not served, no ups_wire_threads row, no #league-announcements post
An editor-owned draft (head commit without the automation trailer) is checked the same way except
check 6 and the claim/box pairing in 7, which describe the automation's own render; the report says so.
"""
import argparse
import html as H
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import season_sim                     # noqa: E402  (display_percentages: the Playoff Picture's rounding)
import ups_center_prob as PROB       # noqa: E402  (100% / 0% only for a clinched / eliminated outcome)
import ups_center_due as DUE          # noqa: E402  (preflight_findings: the duplicate guard's own logic)
import ups_center_pr as PR            # noqa: E402  (branch_for, TRAILER)
import ups_center_validate as VAL     # noqa: E402  (visible_text, NUM_RE, TIME_RE)
import wire                           # noqa: E402  (live_editor_items: what `verify` refuses)

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
REG_SEASON_LAST_WEEK = 14
PLAYOFF_FIELD, PLAYOFF_BYES = 6, 2    # league_context F.1
COMMENT_MARK = "<!-- ups-center-post-build-check id=%s -->"
GROUPS = (("draft", "1. Draft created"), ("fresh", "2. Forecast freshness"), ("six", "3. Six playoff teams"),
          ("divisions", "4. Every division totals 100%"), ("cells", "5. Scenario cells reconcile"),
          ("sourced", "6. Every displayed number has a source"), ("boxes", "7. Editor-review boxes block publication"),
          ("unpublished", "8. Still a draft, no announcement"))


def aid_for(season, week):
    return "%d-wk%02d-ups-center" % (int(season), int(week))


def paths_for(season, week):
    aid = aid_for(season, week)
    return {"article": "site/wire/articles/%d/%s.html" % (season, aid), "claims": "docs/wire/auto/%s/claims.json" % aid,
            "validation": "docs/wire/auto/%s/validation.json" % aid, "run": "docs/wire/auto/%s/run.json" % aid,
            "sim": "site/wire/data/season_sim_%d_live_wk%02d.json" % (season, week),
            "preview": "site/wire/data/week_preview_%d_wk%02d.json" % (season, week + 1), "index": "site/wire/index.json"}


def _utc(s):
    try:
        return datetime.strptime(str(s), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return 0


def _status_of(doc):
    m = re.search(r"<!--wire-meta[\s\S]*?-->", doc or "")
    s = re.search(r"^\s*status:\s*(\S+)", m.group(0), re.M) if m else None
    return s.group(1).strip().lower() if s else None


# ------------------------------------------------------------------ the checks (pure: no I/O)
def check_draft(season, week, files, pr, automation_head, live):
    """files: the draft branch's article (str), claims, validation, run, sim, preview, index (parsed JSON),
    any of them None when missing. pr: {number, state, isDraft, headRefName, baseRefName} or None.
    automation_head: the branch's head commit carries the automation trailer. live: {mainIndex,
    pagesIndex, pageStatus, threads, messages}, each None when it could not be read.
    Returns [{group, check, ok, detail}]; ok None = not applicable (said in the report, never silent)."""
    aid = aid_for(season, week)
    out = []

    def add(group, name, ok, detail=""):
        out.append({"group": group, "check": name, "ok": ok, "detail": str(detail)[:500]})

    art, claims, val, run = files.get("article"), files.get("claims"), files.get("validation"), files.get("run")
    sim, prev, idx = files.get("sim"), files.get("preview"), files.get("index")
    auto = bool(automation_head)
    gaps = [g["id"] for g in (val or {}).get("gaps") or []]
    final_at = ((run or {}).get("timing") or {}).get("finalAt")

    # 1. draft created
    add("draft", "an automated draft PR exists for %s" % aid, bool(pr), pr)
    if pr:
        add("draft", "the PR is open, still a DRAFT, from %s into main" % PR.branch_for(aid),
            pr.get("state") == "OPEN" and pr.get("isDraft") is True and pr.get("headRefName") == PR.branch_for(aid)
            and pr.get("baseRefName") == "main", {k: pr.get(k) for k in ("state", "isDraft", "headRefName", "baseRefName")})
    for k in ("article", "claims", "validation", "run"):
        add("draft", "the draft branch has its %s (%s)" % ({"run": "run record: the build's recorded inputs"}.get(k, k),
                                                              paths_for(season, week)[k]), files.get(k) is not None)
    if auto:
        add("draft", "the build's validation passed with no errors", bool(val) and val.get("ok") is True and not val.get("errors"),
            (val or {}).get("errors"))
    else:
        add("draft", "head commit is the automation's (%s trailer)" % PR.TRAILER, None,
            "editor-owned draft: the automation's claim ledger describes its own render, not the editor's")
    ent = [a for a in (idx or {}).get("articles", []) if a.get("id") == aid]
    add("draft", "the branch's site/wire/index.json lists %s once, as draft" % aid,
        len(ent) == 1 and ent[0].get("status") == "draft", ent)

    # 2-5. the forecast
    if week > REG_SEASON_LAST_WEEK:
        for g in ("fresh", "six", "divisions", "cells"):
            add(g, "no regular-season forecast after Week %d" % REG_SEASON_LAST_WEEK, None)
    else:
        add("fresh", "the forecast file is on the draft", sim is not None, paths_for(season, week)["sim"])
        add("fresh", "the run record says when Week %d went final" % week, bool(final_at), (run or {}).get("timing"))
        need_prev = week < REG_SEASON_LAST_WEEK
        if need_prev:
            add("fresh", "the Week %d preview file is on the draft" % (week + 1), prev is not None, paths_for(season, week)["preview"])
        if sim:
            add("fresh", "the forecast runs through Week %d" % week, sim.get("throughWeek") == week, sim.get("throughWeek"))
            add("fresh", "the forecast was run after Week %d went final" % week,
                bool(final_at) and _utc(sim.get("generatedAtUtc")) >= final_at, (sim.get("generatedAtUtc"), final_at))
            rec = ((run or {}).get("forecast") or {}).get("sim") or {}
            add("fresh", "it is the forecast the draft recorded (same file, same run time)",
                rec.get("generatedAtUtc") == sim.get("generatedAtUtc") and rec.get("runs") == sim.get("runs"),
                (rec.get("generatedAtUtc"), sim.get("generatedAtUtc")))
        if need_prev and prev:
            cut = ((prev.get("model") or {}).get("cutoffs") or {}).get("rostersProjectionsInjuries") or prev.get("generatedAtUtc")
            add("fresh", "the preview is Week %d, through Week %d, with inputs taken after Week %d went final" % (week + 1, week, week),
                prev.get("week") == week + 1 and prev.get("throughWeek") == week and bool(final_at) and _utc(cut) >= final_at,
                (prev.get("week"), prev.get("throughWeek"), cut))
            recp = ((run or {}).get("forecast") or {}).get("preview") or {}
            add("fresh", "it is the preview the draft recorded", recp.get("generatedAtUtc") == prev.get("generatedAtUtc")
                and recp.get("inputsAtUtc") == cut, (recp.get("generatedAtUtc"), prev.get("generatedAtUtc")))
            if sim:
                add("fresh", "preview and odds are the same simulated seasons (runs and seed)",
                    prev.get("runs") == sim.get("runs") and prev.get("seed") == sim.get("seed"),
                    (prev.get("runs"), sim.get("runs"), prev.get("seed"), sim.get("seed")))
        odds_gaps = [g for g in gaps if g.startswith("odds:")]
        add("fresh", "no odds blocker on the draft", not odds_gaps, odds_gaps)
        if auto:
            add("fresh", "the Playoff Picture prints all twelve teams", sum(1 for k in (claims or {}) if k.startswith("odds:po:")) == 12)
        if sim:
            runs = sim.get("runs")
            teams = {t["franchiseId"]: t for t in sim.get("teams") or []}
            ok_runs = isinstance(runs, int) and runs > 0 and len(teams) == 12
            add("six", "twelve teams and a whole number of simulated seasons", ok_runs, (len(teams), runs))
            if ok_runs:
                n = {f: {k: int(round(t[k] * runs)) for k in ("currentPlayoffOdds", "currentByeOdds", "currentDivisionOdds",
                                                              "currentTitleOdds")} for f, t in teams.items()}
                tot = lambda k: sum(x[k] for x in n.values())
                add("six", "six playoff teams in every simulated season (%d team-seasons of %d)" % (tot("currentPlayoffOdds"),
                                                                                               PLAYOFF_FIELD * runs),
                    tot("currentPlayoffOdds") == PLAYOFF_FIELD * runs)
                add("six", "two first-round byes and one champion in every season",
                    tot("currentByeOdds") == PLAYOFF_BYES * runs and tot("currentTitleOdds") == runs,
                    (tot("currentByeOdds"), tot("currentTitleOdds")))
                order = [f for f, x in sorted(n.items()) if not (x["currentByeOdds"] <= x["currentDivisionOdds"]
                                                                 <= x["currentPlayoffOdds"] and x["currentTitleOdds"] <= x["currentPlayoffOdds"])]
                add("six", "for every team: bye <= division title <= playoffs, and title <= playoffs", not order, order)
                divs = {}
                for f, t in teams.items():
                    divs.setdefault(t["division"], []).append(f)
                for d, fs in sorted(divs.items()):
                    raw = sum(n[f]["currentDivisionOdds"] for f in fs)
                    shown = season_sim.display_percentages({f: teams[f]["currentDivisionOdds"] for f in fs})
                    printed = [((claims or {}).get("odds:div:" + f) or {}).get("lr", ((claims or {}).get("odds:div:" + f) or {}).get("value"))
                               for f in sorted(fs)] if auto else None
                    total = sum(printed) if printed and None not in printed else sum(float(x) for x in shown.values())
                    add("divisions", "%s: division titles in every season (%d of %d); printed %s = 100.0" % (
                        ", ".join(teams[f].get("team") or f for f in sorted(fs)), raw, runs,
                        " + ".join(str(x) for x in (printed or [shown[f] for f in sorted(fs)]))),
                        raw == runs and abs(total - 100.0) < 1e-9 and (not auto or None not in printed))
                if auto:
                    tp = [((claims or {}).get("odds:title:" + f) or {}).get("lr", ((claims or {}).get("odds:title:" + f) or {}).get("value"))
                          for f in teams]
                    add("divisions", "league title odds print as exactly 100.0", None not in tp and abs(sum(tp) - 100.0) < 1e-9)
                if need_prev and prev:
                    ws = prev.get("weekScenarios") or {}
                    bad = []
                    for f in sorted(teams):
                        cells = (ws.get(f) or {}).get("cells") or []
                        got = tuple(sum(int(c.get(k) or 0) for c in cells) for k in ("runs", "playoff", "division", "bye"))
                        want = (runs, n[f]["currentPlayoffOdds"], n[f]["currentDivisionOdds"], n[f]["currentByeOdds"])
                        if not cells or got != want:
                            bad.append({"team": f, "cells": got, "odds": want})
                    add("cells", "each team's Week %d cells sum to its playoff, division and bye seasons (12 teams)" % (week + 1),
                        not bad, bad)
                elif not need_prev:
                    add("cells", "no Week %d preview after the last regular-season week" % (week + 1), None)
        for g in ("six", "divisions", "cells"):
            if not any(r["group"] == g for r in out):
                add(g, "nothing to check: the forecast file is missing", False)

    # 6. every displayed number has a source
    if not auto:
        add("sourced", "claim ledger vs page", None, "editor-owned draft: numbers an editor adds are checked in the editor's review")
    elif art and claims is not None:
        nosrc = sorted(k for k, c in claims.items() if not str(c.get("source") or "").strip())
        add("sourced", "every claim names its source (%d claims)" % len(claims), bool(claims) and not nosrc, nosrc[:20])
        shown = set()
        for c in claims.values():
            for x in VAL.NUM_RE.findall(str(c.get("shown"))):
                shown.add(x.replace(",", "").lstrip("+-−"))
        text = VAL.TIME_RE.sub(" ", VAL.visible_text(art))
        stray = sorted({x for x in VAL.NUM_RE.findall(text) if x.replace(",", "").lstrip("+-−") not in shown})
        add("sourced", "every number on the page is a registered claim", not stray, stray[:20])
        if sim and week <= REG_SEASON_LAST_WEEK:
            teams = {t["franchiseId"]: t for t in sim.get("teams") or []}
            want = {}
            flags = (((run or {}).get("clinch") or {}).get("byFid")) or {}
            for f, t in teams.items():
                want["odds:po:" + f] = PROB.single(t["currentPlayoffOdds"], "po", flags.get(f))[1]
                want["odds:bye:" + f] = PROB.single(t["currentByeOdds"], "bye", flags.get(f))[1]
            for d in {t["division"] for t in teams.values()}:
                grp = {f: t["currentDivisionOdds"] for f, t in teams.items() if t["division"] == d}
                cells = PROB.group_cells(grp, season_sim.display_percentages(grp),
                                         {f for f in grp if PROB.certain("div", flags.get(f))[0]},
                                         {f for f in grp if PROB.certain("div", flags.get(f))[1]})
                want.update(("odds:div:" + f, v[1]) for f, v in cells.items())
            tp = {f: t["currentTitleOdds"] for f, t in teams.items()}
            cells = PROB.group_cells(tp, season_sim.display_percentages(tp), set(), {f for f in tp if PROB.certain("title", flags.get(f))[1]})
            want.update(("odds:title:" + f, v[1]) for f, v in cells.items())
            off = sorted(k for k, v in want.items() if k in claims and abs(claims[k]["value"] - v) > 1e-9)
            add("sourced", "every printed probability equals the committed forecast", not off,
                [(k, claims[k]["value"], want[k]) for k in off[:10]])
    else:
        add("sourced", "the article and its claims are on the draft", False)

    # 7. every editor-review box blocks publication
    boxes = re.findall(r'data-editor-gap="([^"]+)"', art or "")
    if auto:
        add("boxes", "every editor item has its EDITOR REVIEW box, and every box is an editor item",
            sorted(set(boxes)) == sorted(set(gaps)), {"boxesOnly": sorted(set(boxes) - set(gaps)), "itemsOnly": sorted(set(gaps) - set(boxes))})
        add("boxes", "the draft is not publishable while %d editor item(s) remain" % len(gaps),
            not gaps or (val or {}).get("publishable") is False, (val or {}).get("publishable"))
    live_art = re.sub(r"(<!--wire-meta[\s\S]*?^\s*status:\s*)\S+", r"\1live", art or "", count=1, flags=re.M)
    refused = wire.live_editor_items(live_art)
    add("boxes", "`wire.py verify` refuses this page as live while its %d box(es) remain" % len(boxes),
        sorted(refused) == sorted(boxes) and (bool(refused) or not boxes), refused[:10])

    # 8. still a draft, no announcement
    add("unpublished", "the article is status: draft", _status_of(art) == "draft", _status_of(art))
    if pr:
        add("unpublished", "the PR is not merged", pr.get("state") != "MERGED", pr.get("state"))
    for k, what in (("mainIndex", "main's site/wire/index.json"), ("pagesIndex", "the live Pages index"),
                    ("pageStatus", "the live Pages article URL"), ("threads", "ups_wire_threads (D1)"),
                    ("messages", "#league-announcements (Discord)")):
        if live.get(k) is None:
            add("unpublished", "read %s" % what, False, "could not be read; not assumed safe")
    if all(live.get(k) is not None for k in ("mainIndex", "pagesIndex", "pageStatus", "threads", "messages")):
        found = DUE.preflight_findings(season, week, live["mainIndex"], live["pagesIndex"], live["pageStatus"],
                                       live["threads"], live["messages"], stage="publish")
        add("unpublished", "not in main's or the Pages index, not served, no ups_wire_threads row, no announcement post",
            not found, found)
    return out


# ------------------------------------------------------------------ report
def report(season, week, results, pr=None, automation_head=True, ref=None, sha=None):
    aid = aid_for(season, week)
    failed = [r for r in results if r["ok"] is False]
    lines = [COMMENT_MARK % aid, "## UPS Center post-build check: %s" % aid, "",
             "%s. **%s** (%d passed, %d failed, %d not applicable)." % (
                 datetime.now(timezone.utc).strftime("Checked %Y-%m-%d %H:%M UTC"),
                 "Every check passed" if not failed else "%d check(s) FAILED" % len(failed),
                 sum(1 for r in results if r["ok"] is True), len(failed), sum(1 for r in results if r["ok"] is None)),
             "", "Draft: `%s`%s%s. Nothing was published, announced or written; this check only reads." % (
                 ref or PR.branch_for(aid), (" at `%s`" % sha[:8]) if sha else "",
                 "" if automation_head else " (editor-owned head commit)"), ""]
    for g, title in GROUPS:
        rs = [r for r in results if r["group"] == g]
        if not rs:
            continue
        mark = "❌" if any(r["ok"] is False for r in rs) else ("✅" if any(r["ok"] for r in rs) else "➖")
        lines.append("**%s %s**" % (mark, title))
        for r in rs:
            icon = {True: "✅", False: "❌", None: "➖"}[r["ok"]]
            lines.append("- %s %s%s" % (icon, r["check"], ("" if r["ok"] is True or not r["detail"] else " — `%s`" % r["detail"])))
        lines.append("")
    if pr:
        lines.append("Editorial review, publication and the announcement stay with Keith.")
    lines.append("")
    lines.append("🤖 Generated with [Claude Code](https://claude.com/claude-code)")
    return "\n".join(lines)


# ------------------------------------------------------------------ I/O (the only part that touches anything)
def _git(*args):
    p = subprocess.run(["git"] + list(args), cwd=REPO, capture_output=True, text=True)
    return p.returncode, p.stdout


def gather(season, week, ref=None):
    aid = aid_for(season, week)
    branch = PR.branch_for(aid)
    _git("fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main")
    _git("fetch", "-q", "origin", "+refs/heads/%s:refs/remotes/origin/%s" % (branch, branch))
    ref = ref or "origin/" + branch            # in Actions: the exact head commit the PR event named
    rc, sha = _git("rev-parse", "--verify", "-q", ref + "^{commit}")
    files = {}
    for k, p in paths_for(season, week).items():
        rc2, body = _git("show", "%s:%s" % (ref, p)) if rc == 0 else (1, "")
        files[k] = (body if k == "article" else json.loads(body)) if rc2 == 0 and body else None
    rc3, trailer = _git("log", "-1", "--format=%(trailers:key=" + PR.TRAILER + ",valueonly)", ref) if rc == 0 else (1, "")
    pr = None
    p = subprocess.run(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "10", "--json",
                        "number,state,isDraft,headRefName,baseRefName,url"], cwd=REPO, capture_output=True, text=True)
    prs = json.loads(p.stdout or "[]") if p.returncode == 0 else []
    pr = next((x for x in prs if x["state"] == "OPEN"), prs[0] if prs else None)
    live = {"mainIndex": None, "pagesIndex": None, "pageStatus": None, "threads": None, "messages": None}
    rc4, mi = _git("show", "origin/main:site/wire/index.json")
    live["mainIndex"] = json.loads(mi) if rc4 == 0 and mi else None
    now = int(datetime.now(timezone.utc).timestamp())
    try:
        live["pagesIndex"] = json.loads(DUE._get(DUE.PAGES + "index.json?v=%d" % now)[1])
    except Exception:                                            # noqa: BLE001
        pass
    try:
        live["pageStatus"] = DUE._status(DUE.PAGES + "articles/%d/%s.html?v=%d" % (season, aid, now))
    except Exception:                                            # noqa: BLE001
        pass
    try:
        import wire_data as D                                    # read-only by construction (SELECT/WITH only)
        live["threads"] = [r["article_id"] for r in D.d1("SELECT article_id FROM ups_wire_threads WHERE article_id = '%s'" % aid)]
    except BaseException as e:                                   # noqa: BLE001  (SystemExit from the helper included)
        print("ups_wire_threads not readable: %s" % str(e)[:200])
    try:
        sys.path.insert(0, os.path.join(REPO, "pipelines", "etl", "scripts"))
        import ingest_discord_chat as I                          # GET only here; token from DISCORD_BOT_TOKEN or the Keychain
        I.TOKEN = I.keychain_token()
        live["messages"] = I.api("/channels/%s/messages?limit=100" % DUE.ANNOUNCE_CHANNEL)
    except BaseException as e:                                   # noqa: BLE001
        print("#league-announcements not readable: %s" % str(e)[:200])
    return files, pr, bool(trailer.strip()), live, ref, (sha.strip() if rc == 0 else None)


def post_comment(pr, body):
    """One comment per draft PR, edited in place on later runs; only on an OPEN PR."""
    if not pr or pr.get("state") != "OPEN":
        return None
    repo = subprocess.run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd=REPO,
                          capture_output=True, text=True).stdout.strip()
    p = subprocess.run(["gh", "api", "repos/%s/issues/%d/comments?per_page=100" % (repo, pr["number"])], cwd=REPO,
                       capture_output=True, text=True)
    mark = body.splitlines()[0]
    mine = [c for c in json.loads(p.stdout or "[]") if (c.get("body") or "").startswith(mark)] if p.returncode == 0 else []
    tmp = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "ups_center_check_comment.md")
    open(tmp, "w", encoding="utf-8").write(body)
    if mine:
        q = subprocess.run(["gh", "api", "-X", "PATCH", "repos/%s/issues/comments/%d" % (repo, mine[-1]["id"]),
                            "-F", "body=@" + tmp], cwd=REPO, capture_output=True, text=True)
        if q.returncode == 0:
            return "edited"
    q = subprocess.run(["gh", "pr", "comment", str(pr["number"]), "--body-file", tmp], cwd=REPO, capture_output=True, text=True)
    return "created" if q.returncode == 0 else "failed: " + (q.stderr or q.stdout)[:200]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--week", type=int, required=True)
    ap.add_argument("--ref", help="git ref of the draft (default origin/wire/auto/<id>, fetched)")
    ap.add_argument("--out-dir", default=None, help="write report.md and report.json here")
    ap.add_argument("--comment", action="store_true", help="post the report on the open draft PR (one comment, edited in place)")
    a = ap.parse_args()
    if not (2000 < a.season < 2100 and 1 <= a.week <= 18):
        ap.error("season/week out of range")
    files, pr, auto, live, ref, sha = gather(a.season, a.week, a.ref)
    results = check_draft(a.season, a.week, files, pr, auto, live)
    body = report(a.season, a.week, results, pr, auto, ref, sha)
    print(body)
    if a.out_dir:
        os.makedirs(a.out_dir, exist_ok=True)
        open(os.path.join(a.out_dir, "report.md"), "w", encoding="utf-8").write(body)
        json.dump({"id": aid_for(a.season, a.week), "ref": ref, "sha": sha, "pr": pr, "automationHead": auto,
                   "results": results}, open(os.path.join(a.out_dir, "report.json"), "w"), indent=1, default=str)
    if a.comment:
        print("PR comment: %s" % post_comment(pr, body))
    return 1 if any(r["ok"] is False for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
