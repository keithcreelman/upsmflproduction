#!/usr/bin/env python3
"""Is a weekly UPS Center issue overdue -- and would publishing one duplicate it?

WHY (2026-10-08). The Week 4 UPS Center never published, and nothing noticed.
There is no scheduled trigger for UPS Center anywhere: no GitHub workflow, no
launchd job, no Claude scheduled task or cloud routine. Weeks 1-3 were each
hand-built and published from a Claude session (Week 1 Thu Sep 17, Week 2 Thu
Sep 24, Week 3 Wed Sep 30); no session was started for Week 4, so no step ever
ran, failed or alerted. The same gap left Week 3's official Elias corrections
(posted Wed Sep 30, 10:25 PM ET) out of the published Week 3 article, against
the standing rule that every correction is published.

This module does not generate or publish anything. It makes the gap visible:

  due        exit 1 when
               - a finished week has no LIVE `<season>-wk<NN>-ups-center` entry in
                 site/wire/index.json after its deadline (8 hours before the next
                 week's first NFL kickoff -- the Week 5 preview inside the issue
                 is stale once that game starts), or
               - Elias posted official changes for a week whose issue is live, and
                 no site/wire/data/elias_<season>_wk<NN>.json records the check.
  preflight  --stage publish (default): exit 1 when ANY destination already has
             the issue -- the repo index, the live Pages page or index, a
             ups_wire_threads row, or a post in #league-announcements. Run it
             before a catch-up build and again before the publish merge.
             --stage announce: exit 1 unless the page IS live, or when an
             announcement already exists (ups_wire_threads row or a post).
             --candidate: run on the catch-up branch once the draft exists.
             `wire.py index` lists drafts in site/wire/index.json, so the
             branch's own draft entry is the issue being published, not a
             copy of it; one DRAFT entry there is allowed. A live entry, and
             every other destination, still blocks.

Usage:
  python3 pipelines/etl/wire/ups_center_due.py due --season 2026
  python3 pipelines/etl/wire/ups_center_due.py preflight --season 2026 --week 4
  python3 pipelines/etl/wire/ups_center_due.py preflight --season 2026 --week 4 --stage announce
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PAGES = "https://keithcreelman.github.io/upsmflproduction/wire/"
ANNOUNCE_CHANNEL = "1057657441011109898"          # #league-announcements
DEADLINE_LEAD_S = 8 * 3600                        # due 8h before the next week's first kickoff
FINAL_AFTER_LAST_KICKOFF_S = 5 * 3600             # a week is final ~5h after its last kickoff
LAST_REGULAR_NFL_WEEK = 17                        # UPS weeks 1-17


def article_id(season, week):
    return "%d-wk%02d-ups-center" % (int(season), int(week))


def article_title(week):
    return "UPS Center: Week %d" % int(week)


def index_articles(index):
    """Every article dict in a site/wire/index.json document, however nested."""
    out = []

    def walk(o):
        if isinstance(o, dict):
            if "id" in o and "path" in o:
                out.append(o)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(index or {})
    return out


def live_ids(index):
    return {a["id"] for a in index_articles(index) if str(a.get("status", "")).lower() == "live"}


# ------------------------------------------------------------------ decisions (pure, tested)
def due_findings(season, kickoffs_by_week, index, elias_posted_weeks, elias_check_files, now):
    """kickoffs_by_week: {week: [kickoff_unix, ...]} for weeks 1..N+1 (as far as known).
    elias_posted_weeks: weeks with official changes posted. elias_check_files: weeks
    with a committed elias_<season>_wk<NN>.json. now: unix seconds."""
    findings = []
    live = live_ids(index)
    for week in sorted(kickoffs_by_week):
        ks = kickoffs_by_week[week]
        if not ks or week > LAST_REGULAR_NFL_WEEK:
            continue
        if now < max(ks) + FINAL_AFTER_LAST_KICKOFF_S:
            continue                                   # not finished yet
        nxt = kickoffs_by_week.get(week + 1)
        deadline = (min(nxt) - DEADLINE_LEAD_S) if nxt else (max(ks) + 4 * 86400)
        aid = article_id(season, week)
        if aid not in live and now >= deadline:
            findings.append({"kind": "missing_issue", "week": week, "article": aid,
                             "deadlineUnix": deadline,
                             "detail": "Week %d is final but %s is not live (due %s)"
                                       % (week, aid, _utc(deadline))})
        if aid in live and week in elias_posted_weeks and week not in elias_check_files:
            findings.append({"kind": "elias_unchecked", "week": week, "article": aid,
                             "detail": "Elias posted Week %d changes; no site/wire/data/elias_%d_wk%02d.json "
                                       "records the check, so the published issue may be uncorrected"
                                       % (week, int(season), week)})
    return findings


def preflight_findings(season, week, repo_index, live_index, live_page_status, wire_thread_article_ids,
                       discord_messages, stage="publish", candidate=False):
    """Reasons NOT to proceed. Empty list = safe.
    stage "publish": the issue must exist nowhere yet.
    stage "announce": the page must be live, and no announcement may exist yet.
    candidate: the working copy is the catch-up branch, so a single DRAFT entry
    for this issue in the repo index is the candidate itself (wire.py index
    lists drafts). Anything live, or a second entry, still blocks."""
    aid, title = article_id(season, week), article_title(week)
    path = "articles/%d/%s.html" % (int(season), aid)
    found = []
    if stage == "announce":
        if live_page_status != 200 or aid not in live_ids(live_index):
            found.append("%s is not live on Pages yet (page HTTP %s) -- publish before announcing"
                         % (aid, live_page_status))
        found.extend(_announced(aid, title, wire_thread_article_ids, discord_messages))
        return found
    mine = [a for a in index_articles(repo_index) if a.get("id") == aid or a.get("path") == path]
    if candidate and len(mine) == 1 and str(mine[0].get("status", "")).lower() == "draft":
        mine = []                                      # the draft being published, not a duplicate
    for a in mine:
        found.append("repo site/wire/index.json lists %s (status %s)" % (a.get("id"), a.get("status")))
    for a in index_articles(live_index):
        if a.get("id") == aid or a.get("path") == path:
            found.append("live Pages index.json lists %s (status %s)" % (a.get("id"), a.get("status")))
    if live_page_status == 200:
        found.append("live Pages serves %s%s (HTTP 200)" % (PAGES, path))
    found.extend(_announced(aid, title, wire_thread_article_ids, discord_messages))
    return found


def _announced(aid, title, wire_thread_article_ids, discord_messages):
    found = []
    if aid in (wire_thread_article_ids or ()):
        found.append("ups_wire_threads already has a row for %s (an announcement was posted)" % aid)
    for m in discord_messages or ():
        text = " ".join([m.get("content") or ""] + [(e.get("title") or "") + " " + (e.get("url") or "")
                                                     for e in m.get("embeds") or []])
        if title in text or aid in text:
            found.append("#league-announcements message %s (%s) already announces it" % (m.get("id"), m.get("timestamp")))
    return found


def _utc(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d %H:%MZ")


# ------------------------------------------------------------------ I/O
def _get(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": "ups-center-due"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def _status(url):
    try:
        return _get(url)[0]
    except urllib.error.HTTPError as e:
        return e.code


def repo_index():
    return json.load(open(os.path.join(REPO, "site", "wire", "index.json"), encoding="utf-8"))


def elias_check_weeks(season):
    out = set()
    for name in os.listdir(os.path.join(REPO, "site", "wire", "data")):
        pre = "elias_%d_wk" % int(season)
        if name.startswith(pre) and name.endswith(".json"):
            out.add(int(name[len(pre):-5]))
    return out


def cmd_due(args):
    sys.path.insert(0, HERE)
    import wire_data as D      # noqa: E402  (MFL nflSchedule via api.myfantasyleague.com)
    import elias as E          # noqa: E402  (MFL "Official Statistics Changes" news)
    now = int(args.now or datetime.now(timezone.utc).timestamp())
    kick = {}
    for wk in range(1, LAST_REGULAR_NFL_WEEK + 1):
        try:
            kick[wk] = sorted(D.nfl_kickoffs(args.season, wk).values())
        except D.DataError:
            break
        if min(kick[wk]) > now:
            break                                       # the first future week is enough for a deadline
    raw = E._get(E.NEWS_URL % int(args.season))
    posted = {wk for wk in kick if E.official_changes(args.season, wk, raw=raw)}
    findings = due_findings(args.season, kick, repo_index(), posted, elias_check_weeks(args.season), now)
    print("checked at %s; weeks with kickoffs: %s; Elias posted for weeks %s; elias check files for weeks %s"
          % (_utc(now), sorted(kick), sorted(posted), sorted(elias_check_weeks(args.season))))
    for f in findings:
        print(("::error::" if os.environ.get("GITHUB_ACTIONS") else "OVERDUE: ") + f["detail"])
    if not findings:
        print("UPS Center is up to date.")
    return 1 if findings else 0


def cmd_preflight(args):
    aid = article_id(args.season, args.week)
    try:
        live_index = json.loads(_get(PAGES + "index.json?v=%d" % int(datetime.now().timestamp()))[1])
    except Exception as e:                              # noqa: BLE001
        print("cannot read the live Pages index (%s) -- refusing to call this safe" % e)
        return 2
    page = _status(PAGES + "articles/%d/%s.html?v=%d" % (args.season, aid, int(datetime.now().timestamp())))
    threads, messages = [], []
    if not args.no_d1:
        sys.path.insert(0, HERE)
        import wire_data as D  # noqa: E402
        threads = [r["article_id"] for r in D.d1("SELECT article_id FROM ups_wire_threads")]
    if not args.no_discord:
        sys.path.insert(0, os.path.join(REPO, "pipelines", "etl", "scripts"))
        import ingest_discord_chat as I  # noqa: E402  (Keychain bot token, 429-aware GET)
        I.TOKEN = I.keychain_token()
        messages = I.api("/channels/%s/messages?limit=100" % ANNOUNCE_CHANNEL)
    found = preflight_findings(args.season, args.week, repo_index(), live_index, page, threads, messages,
                               stage=args.stage, candidate=args.candidate)
    skipped = [n for n, off in (("ups_wire_threads", args.no_d1), ("#league-announcements", args.no_discord)) if off]
    for f in found:
        print("STOP: " + f)
    note = (" (NOT checked: %s)" % ", ".join(skipped)) if skipped else ""
    if found:
        print("%s: do NOT %s." % (aid, args.stage))
    elif args.stage == "announce":
        print("%s is live and has not been announced%s -- safe to announce once." % (aid, note))
    else:
        print("No %s anywhere checked%s." % (aid, note))
    return 1 if found else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("due")
    d.add_argument("--season", type=int, default=datetime.now(timezone.utc).year)
    d.add_argument("--now", type=int, help="unix seconds (testing)")
    p = sub.add_parser("preflight")
    p.add_argument("--season", type=int, default=datetime.now(timezone.utc).year)
    p.add_argument("--week", type=int, required=True)
    p.add_argument("--stage", choices=("publish", "announce"), default="publish")
    p.add_argument("--no-d1", action="store_true")
    p.add_argument("--no-discord", action="store_true")
    p.add_argument("--candidate", action="store_true",
                   help="catch-up branch: this issue's own DRAFT entry in the repo index is allowed")
    args = ap.parse_args()
    return cmd_due(args) if args.cmd == "due" else cmd_preflight(args)


if __name__ == "__main__":
    sys.exit(main())
