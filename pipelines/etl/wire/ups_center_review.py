#!/usr/bin/env python3
"""Weekly UPS Center review email and the approval gate behind it.

Keith 2026-10-28: once a week is final and its sources are checked, email him the rendered
story-driven article to approve: a review link or PDF, the main story, the unresolved editorial
gaps and a clear approve / request-changes path. "An email sent or a scheduled build is never
approval." Publication and the league announcement stay behind his explicit approval for that
specific issue.

THE GATE. An issue is approved only by a comment on its draft PR that
  * is written by APPROVER (keithcreelman) -- the repo is public, anyone can comment;
  * is exactly one line: `APPROVE <issue id> article=<12 hex>`;
  * names the SHA-256 prefix of the article file as it is NOW, so any edit after review voids it;
  * has not been edited since it was posted (updated_at == created_at);
  * is not superseded by a later `CHANGES <issue id> ...` comment from APPROVER.
Agent comments also post through Keith's GitHub identity, so a status line, an "Agent update"
header or any text beyond that one line never counts. This module posts nothing to GitHub or
Discord and never writes the approval line itself.

THE EMAIL. Sent only to TO, only with --send, through Gmail SMTP with an app password read from
the macOS Keychain (service `upsmfl-ups-center-review`, account TO). Without --send the message
is written to disk as an .eml and nothing leaves the machine. One send per (issue, article hash);
a changed draft sends once more, marked as an update.

READY. A week is ready to send when the draft validates with no errors and Elias is settled:
Elias posted official changes (and they were checked), or the Friday 09:00 ET final look has
passed. Unresolved editorial gaps do not block the email; they are listed in it.

Usage:
  ups_center_review.py compose --pr 1405 --out DIR          # .eml + PDF + HTML, nothing sent
  ups_center_review.py compose --pr 1405 --preview --out DIR  # same, before the week is final
  ups_center_review.py send    --pr 1405 --send             # the one real send
  ups_center_review.py gate    --pr 1405                    # exit 0 only when approved
"""
import argparse
import email.utils
import hashlib
import html as H
import json
import os
import re
import smtplib
import ssl
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from zoneinfo import ZoneInfo

APPROVER = "keithcreelman"
TO = "keith.creelman@gmail.com"
FROM = TO                                   # Gmail SMTP sends as the authenticated account
KEYCHAIN_SERVICE = "upsmfl-ups-center-review"
STATE_DIR = os.path.expanduser("~/Library/Caches/upsmfl-ups-center-auto/reviews")
APPROVE_RE = re.compile(r"\AAPPROVE (\S+) article=([0-9a-f]{12})\Z")
CHANGES_RE = re.compile(r"\ACHANGES (\S+)(?: .*)?\Z", re.S)
ET = ZoneInfo("America/New_York")


def article_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


# ---- the gate ---------------------------------------------------------------------------

def evaluate(comments, aid, digest):
    """comments: GitHub issue comments ({id, created_at, updated_at, user:{login}, body}).
    Returns {"state": approved | changes-requested | stale-approval | awaiting, "by": comment id}."""
    verdict = {"state": "awaiting", "by": None}
    for c in sorted(comments, key=lambda c: (c.get("created_at") or "", c.get("id") or 0)):
        if ((c.get("user") or {}).get("login") or "").lower() != APPROVER:
            continue
        if (c.get("updated_at") or c.get("created_at")) != c.get("created_at"):
            continue                                   # edited after posting: not what was reviewed
        body = c.get("body") or ""
        m = APPROVE_RE.match(body)
        if m and m.group(1) == aid:
            if m.group(2) == digest:
                verdict = {"state": "approved", "by": c.get("id")}
            else:
                verdict = {"state": "stale-approval", "by": c.get("id")}
            continue
        m = CHANGES_RE.match(body)
        if m and m.group(1) == aid:
            verdict = {"state": "changes-requested", "by": c.get("id")}
    return verdict


def approval_line(aid, digest):
    return "APPROVE %s article=%s" % (aid, digest)


# ---- readiness ------------------------------------------------------------------------------

def elias_settled(elias, now, week_final_at):
    """Posted-and-checked, or the Friday 09:00 ET final look after the week has passed."""
    if elias and (elias.get("officialChanges") or []) and elias.get("checkedAtUtc"):
        return True, "Elias posted %d official change(s); checked %s" % (
            len(elias["officialChanges"]), elias["checkedAtUtc"])
    fin = datetime.fromtimestamp(week_final_at, ET)
    friday = (fin + timedelta(days=(4 - fin.weekday()) % 7 or 7)).replace(hour=9, minute=0, second=0, microsecond=0)
    if datetime.fromtimestamp(now, ET) >= friday:
        return True, "no Elias changes posted by the Friday 09:00 ET final look"
    return False, "Elias has not posted official changes yet and the Friday final look (%s ET) has not passed" % \
        friday.strftime("%a %b %d")


def ready(validation, elias, now, week_final_at):
    reasons = []
    if (validation or {}).get("errors"):
        reasons.append("validation errors: %s" % "; ".join(validation["errors"][:5]))
    ok, why = elias_settled(elias, now, week_final_at)
    if not ok:
        reasons.append(why)
    return (not reasons), reasons, why


# ---- content --------------------------------------------------------------------------------

def _text(fragment):
    fragment = re.sub(r"<(script|style)[\s\S]*?</\1>", "", fragment)
    fragment = re.sub(r"</(p|div|li|tr|h\d)>", "\n", fragment)
    return H.unescape(re.sub(r"<[^>]+>", "", fragment))


def story_parts(article_html):
    """Title, dek and the lead segment's desk lines, as plain text."""
    t = re.search(r"<title>([\s\S]*?)</title>", article_html)
    dek = re.search(r'<p class="wire-dek">([\s\S]*?)</p>', article_html)
    sec = re.search(r'<section class="wire-sec" id="story"[^>]*>([\s\S]*?)</section>', article_html)
    label = re.search(r'<div class="label"[^>]*>([\s\S]*?)</div>', sec.group(1)) if sec else None
    lines = []
    if sec:
        for who, p in re.findall(r'<div class="lt[^"]*"><div class="who">([\s\S]*?)</div><p>([\s\S]*?)</p>', sec.group(1)):
            lines.append((_text(who).strip(), re.sub(r"\s+", " ", _text(p)).strip()))
    return {"title": re.sub(r"\s+", " ", _text(t.group(1))).strip() if t else "",
            "dek": re.sub(r"\s+", " ", _text(dek.group(1))).strip() if dek else "",
            "segment": re.sub(r"\s+", " ", _text(label.group(1))).strip() if label else "",
            "lines": lines}


def gaps_from_article(article_html):
    """What the article itself still says is open: every EDITOR REVIEW box (data-editor-gap) and the
    editor's own `Still to come.` note. The draft PR body is not used: it describes the automated
    draft, which an editor's rewrite replaces."""
    gaps = []
    for gid, why in re.findall(r'<div class="editor-gap" data-editor-gap="([^"]*)"[^>]*>EDITOR REVIEW[^<]*?([^<]*)</div>',
                               article_html):
        gaps.append("%s: %s" % (H.unescape(gid), re.sub(r"\s+", " ", _text(why)).strip(" \u2014-")))
    for m in re.findall(r"<div><b>Still to come\.</b>([\s\S]*?)</div>", article_html):
        gaps.append("Still to come:" + re.sub(r"\s+", " ", _text(m)))
    return gaps


def compose(aid, week, pr_url, digest, parts, gaps, elias_note, update=False, pdf=None, now=None):
    """-> EmailMessage. Plain text first; HTML alternative; PDF attached when given."""
    sub = "%sUPS Center Week %d: review the issue (article %s)" % ("UPDATED " if update else "", week, digest)
    appr = approval_line(aid, digest)
    chg = "CHANGES %s <what to fix>" % aid
    story = "\n\n".join("%s: %s" % (w, p) for w, p in parts["lines"][:6]) or "(the lead segment could not be read)"
    gap_txt = "\n".join("- " + g for g in gaps) or "- none found in the article"
    txt = ("%s\n\n%s\n\nNOT PUBLISHED. NOT ANNOUNCED. This email is not an approval.\n\n"
           "THE MAIN STORY: %s\n\n%s\n\nUNRESOLVED EDITORIAL GAPS\n%s\n\nSOURCES\n- Elias: %s\n\n"
           "REVIEW\n- Draft PR: %s\n- Rendered issue: attached PDF%s\n\n"
           "TO APPROVE this exact version, comment this single line on the PR from your own GitHub account:\n    %s\n"
           "TO REQUEST CHANGES, comment:\n    %s\n"
           "Any edit to the article after this email voids the approval line; you will get an UPDATED email.\n"
           "Publishing and the Discord announcement are separate steps and need your go for this issue.\n"
           % (parts["title"] or aid, parts["dek"], parts["segment"], story, gap_txt, elias_note, pr_url,
              "" if pdf else " (not produced: use the PR)", appr, chg))
    esc = H.escape
    htm = ("<div style='font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;line-height:1.45'>"
           "<h2 style='margin:0 0 4px'>%s</h2><p style='margin:0 0 12px;color:#555'>%s</p>"
           "<p style='background:#fff3cd;padding:8px 10px;border-radius:6px'><b>Not published. Not announced.</b> "
           "This email is not an approval.</p>"
           "<h3>The main story &mdash; %s</h3>%s"
           "<h3>Unresolved editorial gaps</h3><ul>%s</ul>"
           "<h3>Sources</h3><p>Elias: %s</p>"
           "<h3>Review</h3><p><a href='%s'>Draft PR</a> &middot; rendered issue in the attached PDF</p>"
           "<h3>Approve or request changes</h3>"
           "<p>Comment this one line on the PR from your own account to approve <b>this exact version</b>:</p>"
           "<pre style='background:#f4f4f4;padding:8px;overflow:auto'>%s</pre>"
           "<p>To request changes:</p><pre style='background:#f4f4f4;padding:8px;overflow:auto'>%s</pre>"
           "<p style='color:#555'>An edit after this email voids the approval line; an UPDATED email follows. "
           "Publishing and the Discord announcement are separate steps that need your go for this issue.</p></div>"
           % (esc(parts["title"] or aid), esc(parts["dek"]), esc(parts["segment"]),
              "".join("<p><b>%s</b>: %s</p>" % (esc(w), esc(p)) for w, p in parts["lines"][:6]),
              "".join("<li>%s</li>" % esc(g) for g in gaps) or "<li>none found in the article</li>",
              esc(elias_note), esc(pr_url), esc(appr), esc(chg)))
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = sub, FROM, TO
    msg["Date"] = email.utils.format_datetime(datetime.fromtimestamp(now, timezone.utc)) if now else email.utils.formatdate()
    msg["X-UPS-Center-Issue"], msg["X-UPS-Center-Article"] = aid, digest
    msg.set_content(txt)
    msg.add_alternative(htm, subtype="html")
    if pdf and os.path.exists(pdf):
        msg.add_attachment(open(pdf, "rb").read(), maintype="application", subtype="pdf", filename=aid + ".pdf")
    return msg


# ---- sending --------------------------------------------------------------------------------

def keychain_password(run=subprocess.run):
    p = run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", TO, "-w"],
            capture_output=True, text=True)
    if p.returncode != 0 or not p.stdout.strip():
        raise RuntimeError("no Gmail app password in the Keychain (service %s, account %s)" % (KEYCHAIN_SERVICE, TO))
    return p.stdout.strip()


def send(msg, smtp_factory=None, password=None):
    """Refuses any recipient but TO. smtp_factory is injectable for tests."""
    if msg["To"] != TO or any(msg.get(h) for h in ("Cc", "Bcc")):
        raise RuntimeError("review email goes to %s only" % TO)
    pw = password or keychain_password()
    factory = smtp_factory or (lambda: smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context()))
    with factory() as s:
        s.login(TO, pw)
        s.send_message(msg, from_addr=FROM, to_addrs=[TO])


def sent_marker(aid, digest):
    return os.path.join(STATE_DIR, "%s.%s.sent.json" % (aid, digest))


def already_sent(aid, digest):
    return os.path.exists(sent_marker(aid, digest))


def previously_sent(aid):
    return os.path.isdir(STATE_DIR) and any(f.startswith(aid + ".") and f.endswith(".sent.json") for f in os.listdir(STATE_DIR))


# ---- gh / git -------------------------------------------------------------------------------

def sh(cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def load_pr(pr, repo_dir, run=sh):
    rc, out = run(["gh", "pr", "view", str(pr), "--json", "number,url,body,headRefName,headRefOid,isDraft,state"], repo_dir)
    if rc != 0:
        raise RuntimeError("gh pr view failed: " + out[:200])
    meta = json.loads(out)
    run(["git", "fetch", "-q", "origin", meta["headRefName"]], repo_dir)
    ref = "origin/" + meta["headRefName"]
    rc, files = run(["git", "diff", "--name-only", "origin/main...%s" % ref], repo_dir)
    art = [f for f in files.split() if re.fullmatch(r"site/wire/articles/\d{4}/\d{4}-wk\d\d-ups-center\.html", f)]
    if len(art) != 1:
        raise RuntimeError("expected exactly one UPS Center article in PR %s, found %s" % (pr, art))
    aid = os.path.basename(art[0])[:-5]
    show = lambda p: run(["git", "show", "%s:%s" % (ref, p)], repo_dir)
    rc, html_text = show(art[0])
    rc2, val = show("docs/wire/auto/%s/validation.json" % aid)
    wk = int(re.search(r"wk(\d\d)", aid).group(1))
    season = int(aid[:4])
    rc3, el = show("site/wire/data/elias_%d_wk%02d.json" % (season, wk))
    return {"meta": meta, "aid": aid, "article_path": art[0], "html": html_text,
            "validation": json.loads(val) if rc2 == 0 else {"errors": ["validation.json missing from the PR"]},
            "elias": json.loads(el) if rc3 == 0 else None, "season": season, "week": wk}


def comments_for(pr, repo_dir, run=sh):
    rc, out = run(["gh", "api", "--paginate", "repos/{owner}/{repo}/issues/%s/comments" % pr, "--jq", ".[]"], repo_dir)
    if rc != 0:
        raise RuntimeError("could not read PR comments: " + out[:200])
    return [json.loads(ln) for ln in out.splitlines() if ln.strip()]


def process(cmd, pr, repo=".", out=None, do_send=False, preview=False, log=print):
    """compose | send | gate for one PR. Returns the exit code (0 ok, 1 gate not approved, 2 not ready)."""
    d = load_pr(pr, repo)
    digest = article_hash(d["html"])
    if cmd == "gate":
        v = evaluate(comments_for(pr, repo), d["aid"], digest)
        log(json.dumps(dict(v, id=d["aid"], article=digest)))
        return 0 if v["state"] == "approved" else 1
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ups_center_auto as AUTO
    import ups_center_sources as SRC
    now = int(datetime.now(timezone.utc).timestamp())
    timing = SRC.week_timing(d["season"], d["week"])
    ok, reasons, elias_note = ready(d["validation"], d["elias"], now, timing["finalAt"])
    if not ok and not preview:
        log("not ready: " + "; ".join(reasons))
        return 2
    out_dir = out or os.path.join(STATE_DIR, "outbox")
    os.makedirs(out_dir, exist_ok=True)
    src = os.path.join(out_dir, d["aid"] + ".review-source.html")
    open(src, "w", encoding="utf-8").write(d["html"])
    pdf = AUTO.render_preview(src, os.path.join(out_dir, d["aid"] + "." + digest + ".pdf"))
    msg = compose(d["aid"], d["week"], d["meta"]["url"], digest, story_parts(d["html"]), gaps_from_article(d["html"]),
                  elias_note, update=previously_sent(d["aid"]) and not already_sent(d["aid"], digest), pdf=pdf, now=now)
    if not ok:
        msg.replace_header("Subject", "PREVIEW, NOT FINAL: " + msg["Subject"])
    eml = os.path.join(out_dir, "%s.%s.eml" % (d["aid"], digest))
    open(eml, "wb").write(bytes(msg))
    log("wrote %s (%s)" % (eml, "with PDF" if pdf else "NO PDF"))
    if cmd == "send":
        if not do_send:
            log("dry: pass --send to email it")
            return 0
        if already_sent(d["aid"], digest):
            log("already sent for this article version; not sending again")
            return 0
        send(msg)
        os.makedirs(STATE_DIR, exist_ok=True)
        json.dump({"at": now, "to": TO, "article": digest}, open(sent_marker(d["aid"], digest), "w"))
        log("sent to %s" % TO)
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=("compose", "send", "gate"))
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--out", help="directory for the .eml and PDF (default: STATE_DIR/outbox)")
    ap.add_argument("--send", action="store_true", help="actually send (needs the Keychain app password)")
    ap.add_argument("--preview", action="store_true",
                    help="compose even though the week is not final (subject marked PREVIEW); never combined with --send")
    a = ap.parse_args()
    if a.preview and (a.send or a.cmd != "compose"):
        ap.error("--preview only works with `compose` and can never be sent")
    return process(a.cmd, a.pr, a.repo, a.out, a.send, a.preview)


if __name__ == "__main__":
    sys.exit(main())
