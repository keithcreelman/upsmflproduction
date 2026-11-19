#!/usr/bin/env python3
"""Announce a live weekly UPS Center issue, once, in #ups-wire.

Replaces the per-week copies (announce_wk07.py ... announce_wk10.py in ~/.ups_jobs/ups_wire). One script, one
channel (announce_config.WEEKLY_CHANNEL_ID), so a stale copy cannot post somewhere else.

  python3 announce_weekly.py --season 2026 --week 11 --dek "<one sentence>" --content-file msg.txt          # DRY RUN
  python3 announce_weekly.py --season 2026 --week 11 --dek "..." --content-file msg.txt --post              # posts

Default is a dry run: it checks everything and prints what it WOULD post, with no Discord or D1 write.
--post additionally needs the preflight (`ups_center_due.py preflight --stage announce`) to pass and takes an O_EXCL lock
so a second run cannot post. The message gets the "Challenge this" button, a thread, and a ups_wire_threads row.
The channel is not an option: there is no flag to change it.
"""
import argparse
import html as H
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
import announce_config as AC  # noqa: E402

PAGES = "https://keithcreelman.github.io/upsmflproduction/wire/"
HERO = PAGES + "images/hero_ups_center_2026.jpg"
JOBS = os.path.expanduser("~/.ups_jobs/ups_wire")


def build_message(season, week, dek, content):
    aid = "%d-wk%02d-ups-center" % (season, week)
    url = "%sarticles/%d/%s.html" % (PAGES, season, aid)
    if url not in content:
        content = content.rstrip() + "\n\nRead it here: " + url
    assert len(content) < 2000, "Discord content limit is 2000 characters"
    embed = {"title": "UPS Center: Week %d" % week, "url": url, "description": dek, "color": 6242170, "image": {"url": HERO}}
    return {"aid": aid, "url": url, "content": content, "embed": embed,
            "payload": {"content": content, "allowed_mentions": {"parse": []}, "embeds": [embed]}}


def thread_row_sql(mid, aid, tid, channel, week, dek, url, sections):
    ctx = "UPS Center: Week %d (%s)\n%s\n\n%s" % (week, url, dek, "\n\n".join(sections))
    return ("INSERT INTO ups_wire_threads (wire_message_id, article_id, thread_id, channel_id, article_title, context_text, posted_at) "
            "VALUES ('%s','%s','%s','%s','%s','%s',%d);" % (mid, aid, tid, channel, "UPS Center: Week %d" % week, ctx.replace("'", "''"), int(time.time())))


def section_texts(live_html):
    secs = re.findall(r'<section class="wire-sec"[\s\S]*?(?=<section class="wire-sec"|<div class="wire-method">)', live_html)

    def txt(f):
        f = re.sub(r"<(script|style)[\s\S]*?</\1>", "", f)
        f = re.sub(r"</(p|div|li|tr|h\d)>", " ", f)
        return re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", f))).strip()
    return [txt(s) for s in secs]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--week", type=int, required=True)
    ap.add_argument("--dek", required=True, help="the one-sentence embed description")
    ap.add_argument("--content-file", required=True, help="the message text (the article link is appended if missing)")
    ap.add_argument("--post", action="store_true", help="actually post (default is a dry run)")
    a = ap.parse_args(argv)
    channel = AC.assert_weekly_channel(AC.WEEKLY_CHANNEL_ID)         # the only channel there is
    m = build_message(a.season, a.week, a.dek, open(a.content_file).read().strip())
    print("channel: %s (%s)" % (AC.channel_name(channel), channel))
    print("article: %s" % m["url"])
    print("message (%d chars):\n%s" % (len(m["content"]), m["content"]))
    if not a.post:
        print("\nDRY RUN: nothing was posted and nothing was written. Add --post to announce.")
        return 0
    live = urllib.request.urlopen(m["url"]).read().decode()
    assert "status: live" in live, "the article is not live"
    rc = subprocess.run([sys.executable, os.path.join(HERE, "ups_center_due.py"), "preflight", "--season", str(a.season),
                         "--week", str(a.week), "--stage", "announce"], capture_output=True, text=True)
    print(rc.stdout.strip())
    if rc.returncode != 0:
        print(rc.stderr.strip())
        return 1
    sys.path.insert(0, os.path.join(REPO, "pipelines", "etl", "scripts"))
    import ingest_discord_chat as I  # noqa: E402
    tok = I.keychain_token()

    def api(method, path, body=None):
        r = urllib.request.Request("https://discord.com/api/v10" + path, method=method,
                                   data=json.dumps(body).encode() if body is not None else None,
                                   headers={"Authorization": "Bot " + tok, "Content-Type": "application/json", "User-Agent": "DiscordBot (ups,1)"})
        return json.load(urllib.request.urlopen(r))
    fd = os.open(os.path.join(JOBS, "announce_%s.lock" % m["aid"]), os.O_CREAT | os.O_EXCL | os.O_WRONLY)   # a second run dies here
    os.write(fd, str(time.time()).encode())
    os.close(fd)
    msg = api("POST", "/channels/%s/messages" % channel, m["payload"])
    mid = msg["id"]
    api("PATCH", "/channels/%s/messages/%s" % (channel, mid), {"components": [{"type": 1, "components": [
        {"type": 2, "style": 1, "label": "\U0001F4AC Challenge this", "custom_id": "wire_reply:" + mid}]}]})
    th = api("POST", "/channels/%s/messages/%s/threads" % (channel, mid), {"name": "UPS Center: Week %d" % a.week, "auto_archive_duration": 10080})
    sql = thread_row_sql(mid, m["aid"], th["id"], channel, a.week, a.dek, m["url"], section_texts(live))
    out = os.path.join(JOBS, "announce_%s.json" % m["aid"])
    open(out + ".sql", "w").write(sql)
    json.dump({"message": mid, "thread": th["id"], "channel": channel, "content": m["content"]}, open(out, "w"))
    print("POSTED", mid, th["id"])
    r = subprocess.run(["wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--file", out + ".sql"], capture_output=True, text=True, cwd=REPO)
    print("d1 row rc", r.returncode, (r.stdout + r.stderr)[-300:])
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
