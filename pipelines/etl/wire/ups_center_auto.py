#!/usr/bin/env python3
"""Scheduled UPS Center draft builder: gather -> build -> render -> validate -> one draft PR.

Keith 2026-10-08: "Build a scheduled process that, after a week finishes, gathers MFL
results, the corrected D1 standings, player scoring, saved pre-kickoff projections,
expected fantasy points, league chat, transactions and any Elias changes. It must
create or update one reviewable draft PR and rendered preview for that week in the
actual UPS Center format ... The schedule should prepare the complete draft and tell
me when it is ready; it should never publish or post on its own."

One run, for the newest finished week (or --week):
  1. duplicate check (ups_center_due.preflight_findings, publish stage) -- an issue
     that is already live or announced is never rebuilt; the run stops quietly
  2. evidence that would otherwise be lost: projection_evidence (before the Wednesday
     ingest re-stamps the week) and scores_published (the first numbers, so a later
     Elias change becomes a list of changed claims); then elias.py check
  3. D1 must equal MFL for the week's scores and the standings (the Tuesday/Thursday/
     Friday live sync keeps it so); if not, the run is BLOCKED, not guessed
  4. league chat (ingest_discord_chat.py --incremental), xFP (wire_xfp.py fetch)
  5. wire.py build --pack, then ups_center_sources.gather (independent snapshot),
     ups_center_issue.render, ups_center_validate.validate
  6. ups_center_pr.sync: create / update / no-op / editor-owned comment -- one PR
  7. tell Keith (macOS notification + status file); BLOCKED or failed runs past
     the alert point open or update one GitHub issue for the week, readable

Nothing here can publish: the article is always status: draft, ups_center_pr refuses
`gh pr merge/ready/close`, and no Discord write exists in this pipeline (the chat
ingest only reads Discord).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_due as DUE          # noqa: E402
import ups_center_issue as ISSUE      # noqa: E402
import ups_center_pr as PR            # noqa: E402
import ups_center_sources as SRC      # noqa: E402
import ups_center_validate as VAL     # noqa: E402

STATE_DIR = os.path.expanduser("~/Library/Caches/upsmfl-ups-center-auto")
ALERT_LEAD_S = 24 * 3600              # within a day of the deadline, a not-ready draft raises an alert
# The LaunchAgent's slots (install_ups_center_auto.sh): (Python weekday, hour, minute), local time.
SLOTS = ((1, 10, 0), (2, 10, 0), (3, 9, 0), (4, 9, 0))           # Tue 10:00, Wed 10:00, Thu 09:00, Fri 09:00
CATCH_UP_WEEKS = 3                    # each run also rebuilds any of the last 3 finished weeks not yet live


def missed_slots(last_run, now, tz="America/New_York"):
    """Scheduled slots that passed while no run happened (the Mac was off or asleep),
    excluding the slot this run belongs to. [] on the first ever run."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo
    if not last_run:
        return []
    z = ZoneInfo(tz)
    start, end = datetime.fromtimestamp(int(last_run), z), datetime.fromtimestamp(int(now), z) - timedelta(minutes=30)
    out, d = [], start.replace(hour=0, minute=0, second=0, microsecond=0)
    while d <= end:
        for wd, h, m in SLOTS:
            if d.weekday() == wd:
                s = d.replace(hour=h, minute=m)
                if start < s <= end:
                    out.append(s.strftime("%a %b %d %I:%M %p"))
        d += timedelta(days=1)
    return out


def weeks_to_build(season, now, latest=None):
    """Newest first: the latest finished week and the CATCH_UP_WEEKS-1 before it. A week
    that is already live stops at the duplicate check, so this only costs a lookup."""
    latest = latest or SRC.latest_finished_week(season, now)
    return [w for w in range(latest, max(0, latest - CATCH_UP_WEEKS), -1)] if latest else []


def sh(cmd, cwd=None, check=False, env=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    out = (p.stdout or "") + (p.stderr or "")
    if check and p.returncode != 0:
        raise RuntimeError("%s failed (%d): %s" % (" ".join(cmd[:4]), p.returncode, out[-800:]))
    return p.returncode, out


def notify(title, text):
    """A local macOS notification (the job runs as Keith's LaunchAgent). Never a Discord post."""
    if sys.platform == "darwin" and not os.environ.get("UPS_CENTER_AUTO_QUIET"):
        sh(["osascript", "-e", 'display notification %s with title %s' % (json.dumps(text[:200]), json.dumps(title))])


def alert_issue(run, aid, reasons, cwd, dry=False):
    """One GitHub issue per week, created or updated, in plain words. Not a league post."""
    title = "UPS Center %s: draft not ready" % aid
    text = ("The scheduled UPS Center job could not produce a reviewable draft for **%s**.\n\n%s\n\n"
            "Nothing was published or posted. Re-run: `python3 pipelines/etl/wire/ups_center_auto.py run --week N`."
            % (aid, "\n".join("- " + r for r in reasons)))
    if dry:
        return {"action": "would-alert", "title": title, "text": text}
    rc, out = run(["gh", "issue", "list", "--state", "open", "--search", title + " in:title", "--json", "number"], cwd)
    found = json.loads(out or "[]") if rc == 0 else []
    if found:
        run(["gh", "issue", "comment", str(found[0]["number"]), "--body", text], cwd)
        return {"action": "alert-updated", "issue": found[0]["number"]}
    run(["gh", "issue", "create", "--title", title, "--body", text], cwd)
    return {"action": "alert-created"}


CODE_PATHS = ("pipelines/etl/wire", "pipelines/etl/scripts", "site/wire/data/chat_exclusions.json")


def run_week(season, week, workdir, now, pr_mode="live", ingest=True, chat_since=None, log=print, sandbox=False,
             missed=(), code_ref=None):
    """One idempotent pass for one week. Returns a status dict (also written to STATE_DIR).
    sandbox: build under a DEMO id in site/wire/articles/_sandbox/ (wire.py never indexes,
    verifies or publishes a "_" folder) so draft-PR creation and update can be shown on
    GitHub without a second real issue. A sandbox PR commits only its own files.
    code_ref (sandbox only): run the build steps with a branch's pipeline code -- overlaid
    on the work tree, never staged -- to demonstrate a change before it merges."""
    if code_ref and not sandbox:
        raise ValueError("--code-ref is for the sandbox demo only; a real draft is built from origin/main")
    aid = "%d-wk%02d-ups-center%s" % (season, week, "-sandbox" if sandbox else "")
    article_rel = ("articles/_sandbox/%s.html" if sandbox else "articles/%d/" % season + "%s.html") % aid
    article_path = os.path.join(workdir, "site/wire", article_rel)
    dry = pr_mode != "live"
    st = {"id": aid, "season": season, "week": week, "at": SRC.iso(now), "status": "started", "reasons": [],
          "sandbox": sandbox, "missedSlots": list(missed)}
    os.makedirs(STATE_DIR, exist_ok=True)
    py = sys.executable

    def runner(cmd, cwd=None):
        return sh(cmd, cwd=cwd or workdir)

    timing = SRC.week_timing(season, week)
    st["deadline"] = SRC.iso(timing["deadline"])
    if now < timing["finalAt"]:
        st.update(status="not-final", reasons=["Week %d is not final until %s" % (week, SRC.iso(timing["finalAt"]))])
        return st

    # 1. duplicate check: never rebuild a published or announced issue
    sh(["git", "fetch", "-q", "origin"], workdir)
    rc, idx = sh(["git", "show", "origin/main:site/wire/index.json"], workdir)
    live_index = json.loads(DUE._get(DUE.PAGES + "index.json?v=%d" % now)[1])
    page = DUE._status(DUE.PAGES + "%s?v=%d" % (article_rel, now))
    threads = [r["article_id"] for r in SRC.D.d1("SELECT article_id FROM ups_wire_threads")]
    sys.path.insert(0, os.path.join(DUE.REPO, "pipelines", "etl", "scripts"))
    import ingest_discord_chat as ING          # noqa: E402  (Keychain token, 429-aware GET; reads only)
    ING.TOKEN = ING.keychain_token()
    msgs = ING.api("/channels/%s/messages?limit=100" % DUE.ANNOUNCE_CHANNEL)
    dup = DUE.preflight_findings(season, week, json.loads(idx), live_index, page, threads, msgs, stage="publish",
                                 aid=aid if sandbox else None, path=article_rel if sandbox else None,
                                 title=("UPS Center sandbox %s" % aid) if sandbox else None)
    live_or_announced = [d for d in dup if "status draft" not in d]
    if live_or_announced:
        st.update(status="already-published", reasons=live_or_announced)
        log("%s is already published or announced -- nothing to build (%s)" % (aid, "; ".join(live_or_announced)[:400]))
        return st

    # clean, automation-owned tree at origin/main on the week's branch
    sh(["git", "checkout", "-q", "-B", PR.branch_for(aid), "origin/main"], workdir, check=True)
    sh(["git", "reset", "-q", "--hard", "origin/main"], workdir, check=True)
    sh(["git", "clean", "-qfd", "site/wire", "docs/wire/auto"] + list(CODE_PATHS[:2]), workdir)   # incl. a past overlay
    if code_ref:
        sh(["git", "fetch", "-q", "origin", code_ref], workdir, check=True)
        sh(["git", "restore", "--source", "origin/" + code_ref, "--worktree", "--"] + list(CODE_PATHS), workdir, check=True)
        st["codeRef"] = code_ref

    # 2. evidence + Elias
    data = os.path.join(workdir, "site/wire/data")
    if not os.path.exists(os.path.join(data, "scores_published_%d_wk%02d.json" % (season, week))):
        sh([py, "pipelines/etl/wire/elias.py", "freeze", "--season", str(season), "--week", str(week)], workdir, check=True)
    ev_path = os.path.join(data, "projection_evidence_%d_wk%02d.json" % (season, week))
    if not os.path.exists(ev_path):
        freeze_projection_evidence(season, week, ev_path, now)
    sh([py, "pipelines/etl/wire/elias.py", "check", "--season", str(season), "--week", str(week)], workdir)

    # 3. D1 == MFL, or stop
    probe = SRC.gather(season, week, now=now, chat_since=chat_since)
    mismatch = SRC.d1_matches_mfl(probe)
    if mismatch:
        st.update(status="blocked", reasons=["D1 does not match MFL yet (the live sync has not caught up): " + m
                                             for m in mismatch[:8]])
        return finish(st, runner, aid, timing, now, dry, log)

    # 4. chat + xFP
    if ingest:
        sh([py, "pipelines/etl/scripts/ingest_discord_chat.py", "--incremental"], workdir)
    if not os.path.exists(os.path.join(data, "xfp_%d_wk%02d.json" % (season, week))):
        rc, out = sh([py, "pipelines/etl/wire/wire_xfp.py", "fetch", "--season", str(season), "--week", str(week)], workdir)
        if rc != 0:
            st["reasons"].append("expected points not available yet: " + out.strip()[-200:])

    # 5. build, gather, render, validate
    rc, out = sh([py, "pipelines/etl/wire/wire.py", "build", "--pack", "%d-wk%02d-recap" % (season, week)], workdir)
    if rc != 0:
        st.update(status="blocked", reasons=st["reasons"] + ["pack build failed: " + out.strip()[-400:]])
        return finish(st, runner, aid, timing, now, dry, log)
    pack = json.load(open(os.path.join(workdir, "site/wire/packs/%d/%d-wk%02d-recap.pack.json" % (season, season, week))))
    ctx = SRC.gather(season, week, now=now, chat_since=chat_since, pack=pack)
    rep_path = os.path.join(data, "elias_%d_wk%02d.json" % (season, week))
    ctx["eliasReport"] = json.load(open(rep_path)) if os.path.exists(rep_path) else None
    res = ISSUE.render(pack, ctx, generated_at=now)                            # committed: no raw chat
    report = VAL.validate(res, ctx, pack)
    local = ISSUE.render(pack, ctx, generated_at=now, local_candidates=True)  # review copy with quote candidates
    local_report = VAL.validate(local, ctx, pack)
    if not local_report["ok"]:
        report = dict(report, ok=False, errors=report["errors"] + ["review copy: " + e for e in local_report["errors"]])
    out_dir = os.path.join(workdir, "docs/wire/auto", aid)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.dirname(article_path), exist_ok=True)
    open(article_path, "w").write(res["html"])
    json.dump(res["claims"], open(os.path.join(out_dir, "claims.json"), "w"), indent=1, sort_keys=True, default=str)
    json.dump(report, open(os.path.join(out_dir, "validation.json"), "w"), indent=1, default=str)
    json.dump(ctx, open(os.path.join(STATE_DIR, aid + ".sources.json"), "w"), default=str)
    sh([py, "pipelines/etl/wire/wire.py", "index"], workdir, check=True)
    local_path = os.path.join(STATE_DIR, aid + ".review-source.html")
    open(local_path, "w").write(local["html"])
    preview = render_preview(local_path, os.path.join(STATE_DIR, aid + ".review.pdf"))
    st.update(claims=res["claimsDigest"], gaps=[g["id"] for g in res["gaps"]], errors=report["errors"], preview=preview)
    if not report["ok"]:
        st.update(status="blocked", reasons=st["reasons"] + ["validation failed: " + e for e in report["errors"][:10]])
        return finish(st, runner, aid, timing, now, dry, log)

    # 6. one PR
    def write_branch():
        if sandbox:                          # only the demo's own files; never a real pack, data file or index
            sh(["git", "add", "site/wire/" + article_rel, "docs/wire/auto/" + aid], workdir, check=True)
        else:
            sh(["git", "add", "site/wire", "docs/wire/auto"], workdir, check=True)
        sh(["git", "commit", "-q", "-m", "wire(auto): UPS Center %s draft (claims %s, %d gaps)\n\n%s: %s"
            % (aid, res["claimsDigest"], len(res["gaps"]), PR.TRAILER, res["claimsDigest"])], workdir, check=True)
        sh(["git", "push", "-q", "-f", "origin", PR.branch_for(aid)], workdir, check=True)

    note = "Local preview: `%s`. Every segment and division page is expanded in it." % preview if preview else "No preview"
    if missed:
        note += "\n\nBuilt late: scheduled run(s) missed while the Mac was off or asleep -- %s." % ", ".join(missed)
    outcome = PR.sync(runner, aid, "site/wire/" + article_rel, res, report, write_branch, note, workdir, dry=dry,
                      title_prefix="[SANDBOX demo -- will be closed] " if sandbox else "")
    if outcome["action"] == "editor-owned":
        # Re-check the EDITOR's draft against the numbers it was frozen at (its own branch), never ours.
        rc2, ref = sh(["gh", "pr", "view", str(outcome["pr"]), "--json", "headRefName", "-q", ".headRefName"], workdir)
        ref = ref.strip()
        sh(["git", "fetch", "-q", "origin", ref], workdir)
        rc3, doc = sh(["git", "show", "origin/%s:site/wire/%s" % (ref, article_rel)], workdir)
        rc4, sp = sh(["git", "show", "origin/%s:site/wire/data/scores_published_%d_wk%02d.json" % (ref, season, week)],
                     workdir)
        published = (json.loads(sp).get("teams") or {}) if rc4 == 0 else {}
        recheck = VAL.check_editor_draft(doc if rc3 == 0 else "", ctx, published)
        recheck["frozenScoresFrom"] = ref if rc4 == 0 else None
        outcome["recheck"] = recheck
        outcome["comment"] = PR.comment_editor_pr(runner, outcome["pr"], aid, recheck, workdir, dry=dry)
    if outcome["action"] == "stop-duplicate":
        st.update(status="blocked", reasons=["more than one open PR touches %s: %s" % (article_rel, outcome["pr"])])
        return finish(st, runner, aid, timing, now, dry, log)
    st.update(status="ready" if not res["gaps"] else "ready-with-gaps", pr=outcome)
    return finish(st, runner, aid, timing, now, dry, log)


def crashed(season, week, now, exc, workdir, dry, sandbox, missed, log=print):
    import traceback
    aid = "%d-wk%02d-ups-center%s" % (season, week, "-sandbox" if sandbox else "")
    where = traceback.extract_tb(exc.__traceback__)[-1]
    st = {"id": aid, "season": season, "week": week, "at": SRC.iso(now), "status": "failed", "sandbox": sandbox,
          "missedSlots": list(missed), "reasons": ["the builder stopped with an error: %s: %s (%s line %d)" % (
              type(exc).__name__, str(exc)[:300], os.path.basename(where.filename), where.lineno)]}
    try:
        timing = SRC.week_timing(season, week)
    except Exception as exc2:                         # cannot even read the schedule: alert now, not never
        timing = {"deadline": now}
        st["reasons"].append("could not read the week's schedule either: %s" % str(exc2)[:200])
    return finish(st, lambda cmd, cwd=None: sh(cmd, cwd=cwd or workdir), aid, timing, now, dry, log)


def finish(st, runner, aid, timing, now, dry, log):
    os.makedirs(STATE_DIR, exist_ok=True)
    if st["status"].startswith("ready"):
        pr = st.get("pr") or {}
        notify("UPS Center %s" % aid, "Draft %s (PR #%s, %d editor items)%s. Not published."
               % (pr.get("action"), pr.get("pr"), len(st.get("gaps") or []),
                  "; caught up after a missed run" if st.get("missedSlots") else ""))
    elif st["status"] in ("blocked", "failed") and st.get("sandbox"):
        notify("UPS Center %s (sandbox) not built" % aid, "; ".join(st["reasons"])[:200])   # never a GitHub alert
    elif st["status"] in ("blocked", "failed") and now >= timing["deadline"] - ALERT_LEAD_S:
        st["alert"] = alert_issue(runner, aid, st["reasons"] + ["deadline: %s" % SRC.iso(timing["deadline"])], None, dry)
        notify("UPS Center %s NOT READY" % aid, "; ".join(st["reasons"])[:200])
    json.dump(st, open(os.path.join(STATE_DIR, aid + ".status.json"), "w"), indent=1, default=str)
    log(json.dumps({k: st[k] for k in st if k not in ("pr",)}, default=str)[:2000])
    if st.get("pr"):
        log("PR: " + json.dumps(st["pr"], default=str)[:1500])
    return st


def freeze_projection_evidence(season, week, path, now):
    """Same freeze the Week 3/4 catch-ups wrote by hand: every stored row's value and
    capture time, so the Wednesday ingest cannot erase what was pregame."""
    rows = SRC.D.d1("SELECT player_id, projected_score, updated_at FROM ups_player_projections WHERE season = %d AND "
                    "week = %d" % (season, week))
    doc = {"season": season, "week": week, "writtenAtUtc": SRC.iso(now),
           "why": "Frozen by ups_center_auto.py right after the week finished, before the Wednesday projection ingest "
                  "can re-stamp it (mfl_projection_ingest_wednesday_overwrite).",
           "overwrite": {"at": SRC.iso(now), "note": "Freeze time, not an observed overwrite."},
           "starterProjectionsInTime": {"source": "not used", "players": []},
           "captures": {"source": "ups_player_projections (D1), read %s" % SRC.iso(now), "authoritative": True,
                        "authoritativeWhy": "Direct D1 read after the week's games and before any re-capture.",
                        "players": [{"player_id": str(r["player_id"]), "projected_score": float(r["projected_score"]),
                                     "captured_at": SRC.iso(r["updated_at"])} for r in rows
                                    if r["projected_score"] is not None]}}
    json.dump(doc, open(path, "w"), indent=1)


def render_preview(article_path, out_pdf):
    """Every segment and division page expanded, printed with headless Chrome. Local only."""
    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if not os.path.exists(chrome):
        return None
    import re
    t = open(article_path, encoding="utf-8").read()
    t = re.sub(r"<script data-wire-runtime>[\s\S]*?</script>", "", t)
    t = t.replace("</head>", "<style>.wire-sec,.wire-gamepage{display:block!important}.wire-rail,.wire-gamedeck-rail,"
                  ".wire-topbar{display:none!important}.lt,.play,.bbl li,tr{break-inside:avoid}.tablebox{overflow:visible"
                  "!important}.tablebox table{min-width:0!important;width:100%!important;font-size:12px!important}"
                  "html,body,.wire-page,.wire-wrap{min-height:0!important;height:auto!important}@page{size:Letter;"
                  "margin:.4in}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head>", 1)
    os.makedirs(os.path.dirname(out_pdf), exist_ok=True)
    tmp = out_pdf[:-4] + ".html"
    open(tmp, "w", encoding="utf-8").write(t)
    prof = os.path.join(os.path.dirname(out_pdf), "chrome-profile")
    shutil.rmtree(prof, ignore_errors=True)
    sh(["perl", "-e", "alarm 120; exec @ARGV", chrome, "--headless=new", "--user-data-dir=" + prof, "--disable-gpu",
        "--virtual-time-budget=20000", "--no-pdf-header-footer", "--print-to-pdf=" + out_pdf, "file://" + tmp])
    return out_pdf if os.path.exists(out_pdf) else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--season", type=int, default=datetime.now(timezone.utc).year)
    r.add_argument("--week", type=int, help="default: the newest finished week")
    r.add_argument("--workdir", default=os.path.join(STATE_DIR, "repo"),
                   help="an automation-owned git worktree (it is reset to origin/main every run)")
    r.add_argument("--pr-mode", choices=("live", "dry"), default="live")
    r.add_argument("--no-ingest", action="store_true")
    r.add_argument("--chat-since", type=int, help="unix start of the Coffee Shop window")
    r.add_argument("--sandbox", action="store_true", help="demo id under site/wire/articles/_sandbox (never published)")
    r.add_argument("--code-ref", help="sandbox only: overlay this branch's pipeline code (unstaged) for a pre-merge demo")
    a = ap.parse_args()
    now = int(datetime.now(timezone.utc).timestamp())
    os.makedirs(STATE_DIR, exist_ok=True)
    last_path = os.path.join(STATE_DIR, "last_run%s.json" % ("_sandbox" if a.sandbox else ""))
    last = json.load(open(last_path)).get("at") if os.path.exists(last_path) else None
    missed = missed_slots(last, now)
    if missed:
        print("catching up: scheduled run(s) missed since the last run -- %s" % ", ".join(missed))
    weeks = [a.week] if a.week else weeks_to_build(a.season, now)[:1 if a.sandbox else None]   # one demo PR at most
    if not weeks:
        print("no finished week yet")
        return 0
    rc = 0
    for wk in weeks:
        try:
            st = run_week(a.season, wk, a.workdir, now, pr_mode=a.pr_mode, ingest=not a.no_ingest,
                          chat_since=a.chat_since, sandbox=a.sandbox, missed=missed, code_ref=a.code_ref)
        except Exception as exc:                      # a crash is a failed draft: same readable alert path
            st = crashed(a.season, wk, now, exc, a.workdir, a.pr_mode != "live", a.sandbox, missed)
        if st["status"] not in ("ready", "ready-with-gaps", "already-published", "not-final"):
            rc = 1
    json.dump({"at": now, "weeks": weeks, "missedSlots": missed}, open(last_path, "w"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
