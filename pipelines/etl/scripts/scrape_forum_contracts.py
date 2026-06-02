#!/usr/bin/env python3
"""Scrape UPS Forumotion contract/extension/tag subforums (2012-2017).

The forum (https://upsdynastycap.forumotion.com) organizes commissioner-side
contract records into per-year subforums. Each topic = one player's
contract/extension/tag; the OP body carries the terms. This is the cleanest
historical record for pre-2018 contract events that MFL's transaction stream
doesn't expose.

Two modes:
  --list   : list every topic (title + url + reply count) in the given subforums
  --threads: fetch + parse each topic's original post (author, date, body)

Subforum IDs (from the homepage nav tree):
  Extensions:  f22=2012 f21=2013 f27=2014 f35=2015 f41=2016 f3=2017
  Mid-Season:  f25=2013 f26=2014 f36=2015 f43=2016 f45=2017  (f23 general)
  FA Auction:  f13=2012 f14=2013 f24=2014 f34=2015 f42=2016 f44=2017

Usage:
  python3 scrape_forum_contracts.py --list f35 f41 f3
  python3 scrape_forum_contracts.py --threads f35 > /tmp/2015_ext.json
"""
import json
import re
import sys
import time
import urllib.request

BASE = "https://upsdynastycap.forumotion.com"
UA = {"User-Agent": "Mozilla/5.0 (ups-forum-archive)"}


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "replace")


def strip_tags(s):
    s = re.sub(r"<(script|style|svg)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"&nbsp;", " ", s)
    s = re.sub(r"&amp;", "&", s)
    s = re.sub(r"&#0*39;|&#x27;|&rsquo;", "'", s)
    s = re.sub(r"&quot;", '"', s)
    s = re.sub(r"&[a-z]+;", " ", s)
    return re.sub(r"[ \t]+", " ", s)


def list_topics(fid):
    """Return [{tid, title, url, replies}] for a subforum, following pagination."""
    topics, start, seen = [], 0, set()
    while True:
        url = f"{BASE}/{fid}-x" if start == 0 else f"{BASE}/{fid}p{start}-x"
        try:
            html = fetch(url)
        except Exception as e:
            sys.stderr.write(f"  {fid} start={start}: {e}\n")
            break
        # topic links: /tNNN-slug  (title in the anchor text)
        found = re.findall(r'href="/(t\d+)-([a-z0-9-]+)"[^>]*?(?:class="topictitle"[^>]*)?>([^<]{1,160})</a>', html)
        new = 0
        for tid, slug, title in found:
            if tid in seen:
                continue
            t = strip_tags(title).strip()
            if not t or t.lower() in ("last", "next", "previous"):
                continue
            seen.add(tid)
            topics.append({"tid": tid, "slug": slug, "url": f"{BASE}/{tid}-{slug}", "title": t})
            new += 1
        # pagination: stop when a page adds no new topics
        if new == 0:
            break
        start += 25
        time.sleep(0.4)
    return topics


POST_RE = re.compile(
    r"Post n°(\d+)\s*Re:[^<]*?by\s*([\w .'-]+?)\s*(\d{1,2}/\d{1,2}/\d{4},?\s*\d{1,2}:\d{2}\s*[ap]m)",
    re.I,
)


def parse_op(tid, slug):
    """Fetch a topic and return the ORIGINAL (first) post: author, date, body.

    Forumotion labels every post 'Post n°N'; the OP is n°1 and (unlike replies)
    its heading is the bare title, NOT 'Re: title'. The post text lives in a
    `class="post-entry"` div right after the marker. (The older Re:-anchored
    regex skipped the OP and grabbed the first reply.)"""
    raw_html = fetch(f"{BASE}/{tid}-{slug}")
    parts = re.split(r"Post n°(\d+)", raw_html)
    if len(parts) < 3:
        return {"author": "", "date": "", "body": strip_tags(raw_html)[:800].strip()}
    seg = parts[2]  # everything from the OP marker to the next post
    m = re.search(r'class="post-entry">(.*?)(?:<div class="post-(?:foot|options|attach)|Like\b|Back to top|Sponsored content)', seg, re.S)
    body = strip_tags(m.group(1) if m else seg[:2500]).strip()
    by = re.search(r"by\s+([\w .'-]+?)\s+(?:on\s+)?(\w+ \w+ \d+,?\s*\d+:\d+\s*[ap]m|\d+/\d+/\d+,?\s*\d+:\d+\s*[ap]m)", seg[:500])
    return {"author": (by.group(1).strip() if by else ""), "date": (by.group(2).strip() if by else ""), "body": body[:1500]}


def main():
    args = sys.argv[1:]
    mode = "--list"
    if args and args[0].startswith("--"):
        mode = args.pop(0)
    fids = args or ["f35", "f41", "f3"]
    if mode == "--list":
        for fid in fids:
            tops = list_topics(fid)
            print(f"\n=== {fid}: {len(tops)} topics ===")
            for t in tops:
                print(f"  {t['tid']:8} {t['title']}")
    else:  # --threads
        out = []
        for fid in fids:
            for t in list_topics(fid):
                op = parse_op(t["tid"], t["slug"])
                out.append({**t, "fid": fid, **op})
                time.sleep(0.4)
        json.dump(out, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
