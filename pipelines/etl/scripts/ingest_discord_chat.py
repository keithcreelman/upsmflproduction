#!/usr/bin/env python3
"""Archive UPS Discord chat into D1 for UPS Wire recaps.

    # one-off backfill of a past window
    python pipelines/etl/scripts/ingest_discord_chat.py --since 2025-09-01 --until 2026-01-15

    # ongoing: pick up everything newer than what is already stored
    python pipelines/etl/scripts/ingest_discord_chat.py --incremental

    # see what would be written, touch nothing
    python pipelines/etl/scripts/ingest_discord_chat.py --incremental --dry-run

WHY THIS EXISTS
    The weekly recaps had only team totals to work with, so they philosophised
    to fill space. The league's own chat is the missing ingredient -- real digs
    tied to real decisions, real injury reactions, real feuds. It lived only in
    Discord, unqueryable. This mirrors it into ups_discord_messages (migration
    0113) so pack builders can quote it verbatim.

WHAT IT DELIBERATELY DOES NOT DO
    No summarising, no sentiment scoring, no LLM. It stores messages verbatim.
    A recap may only quote what a human actually typed -- the whole point is to
    stop the writer inventing colour like "somewhere a kicker doinked one in".

SECRETS
    The bot token is read from the macOS Keychain (service `discord_bot_token`,
    the same entry the roast bot uses) or DISCORD_BOT_TOKEN. It is used only as
    an Authorization header: never printed, never logged, never written to disk.

PRIVACY
    CHANNELS below is an explicit ALLOWLIST. #private_league_discussion is
    excluded on purpose -- the bot cannot read it today and it should stay that
    way. Adding a channel here is a deliberate act.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WORKER_DIR = os.path.join(REPO, "worker")
D1_NAME = "ups-mfl-db"
API = "https://discord.com/api/v10"

# Explicit allowlist. Chat channels worth archiving for recap colour, plus the
# bot-driven channels that give a week its factual timeline.
CHANNELS = {
    "1087157907419840644": "the-coffee-shop",   # main chat -- by far the richest
    "1291737646665699420": "on-the-sofa",        # side chat / hot takes
    "1059111651846131833": "transactions",       # trades + adds, with owner reactions
    "1059113303059730494": "contract-activity",
    "1057657441011109898": "league-announcements",
    "1066399931574779914": "rules-discussion",
}

# Discord's epoch, for turning a timestamp into a snowflake cursor.
DISCORD_EPOCH_MS = 1420070400000


def keychain_token():
    env = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if env:
        return env
    try:
        p = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ.get("USER", ""),
             "-s", "discord_bot_token", "-w"],
            capture_output=True, text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip():
            return p.stdout.strip()
    except Exception:
        pass
    sys.exit("No Discord bot token. Set DISCORD_BOT_TOKEN or store it in the "
             "Keychain as 'discord_bot_token'.")


TOKEN = None


def api(path):
    """GET with 429 backoff. Discord rate-limits history walks aggressively."""
    for attempt in range(5):
        req = urllib.request.Request(
            API + path, headers={"Authorization": "Bot " + TOKEN,
                                 "User-Agent": "ups-wire-chat-ingest/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                body = e.read().decode("utf-8", "replace")
                wait = 1.0
                try:
                    wait = float(json.loads(body).get("retry_after", 1.0))
                except Exception:
                    pass
                time.sleep(wait + 0.4)
                continue
            raise SystemExit("Discord API %s on %s: %s"
                             % (e.code, path, e.read().decode("utf-8", "replace")[:200]))
        except Exception as e:                      # noqa: BLE001
            if attempt == 4:
                raise SystemExit("Discord API failed on %s: %s" % (path, e))
            time.sleep(1.5)
    raise SystemExit("Discord API exhausted retries on %s" % path)


def snowflake(dt):
    return str(int(dt.timestamp() * 1000 - DISCORD_EPOCH_MS) << 22)


# ---------------------------------------------------------------- week binning

def week1_thursday(season):
    """First Thursday on/after Sept 4 -- NFL week 1.

    Verified two ways before being trusted: it reproduces canon's own 2026
    dates exactly (docs/league_context_v1.md lists wk15/16/17 as Dec 17/24/31,
    all Thursdays), and it correctly bins real 2025 playoff-round-1 chat from
    Dec 13-14 into week 15.
    """
    d = datetime(season, 9, 4, tzinfo=timezone.utc)
    while d.weekday() != 3:
        d += timedelta(days=1)
    return d


def resolve_week(ts, total_weeks=17):
    """(season, week) for a timestamp, or (None, None) if outside a season.

    A fantasy week runs [Thursday, next Thursday). Chat about Sunday's games
    therefore lands in the right week. Off-season chatter returns (None, None)
    and is still stored -- it is useful for season reviews.
    """
    for season in (ts.year, ts.year - 1):
        start = week1_thursday(season)
        if ts < start:
            continue
        wk = int((ts - start).days // 7) + 1
        if 1 <= wk <= total_weeks:
            return season, wk
    return None, None


# --------------------------------------------------------------------- D1

def d1(sql):
    p = subprocess.run(["npx", "wrangler", "d1", "execute", D1_NAME, "--remote",
                        "--json", "--command", sql],
                       cwd=WORKER_DIR, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit("D1 query failed: %s" % (p.stderr or p.stdout)[:400])
    return json.loads(p.stdout)[0]["results"]


def d1_exec_file(path):
    p = subprocess.run(["npx", "wrangler", "d1", "execute", D1_NAME, "--remote",
                        "--file", path],
                       cwd=WORKER_DIR, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit("D1 write failed: %s" % (p.stderr or p.stdout)[:400])


def sq(v):
    """SQL string literal. Discord content is arbitrary user text."""
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def owner_map():
    """discord_user_id -> (franchise_id, owner_name).

    active_owner='Y' is mandatory: fid 0008 has two rows and the stale one would
    otherwise win on dict update order.
    """
    rows = d1("SELECT discord_user_id, franchise_id, owner_name FROM discord_owners "
              "WHERE active_owner = 'Y'")
    return dict((str(r["discord_user_id"]),
                 (str(r["franchise_id"]).zfill(4), r["owner_name"])) for r in rows)


# ------------------------------------------------------------------- ingest

def fetch_window(channel_id, since, until):
    """Every message in [since, until), oldest-first. Walks backwards."""
    out, before = [], snowflake(until)
    while True:
        msgs = api("/channels/%s/messages?limit=100&before=%s" % (channel_id, before))
        if not msgs:
            break
        stop = False
        for m in msgs:
            ts = datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00"))
            if ts < since:
                stop = True
                continue
            out.append(m)
        before = msgs[-1]["id"]
        if stop or len(msgs) < 100:
            break
    out.reverse()
    return out


def main():
    global TOKEN
    ap = argparse.ArgumentParser(description="Archive UPS Discord chat into D1")
    ap.add_argument("--since", help="ISO date, e.g. 2025-09-01")
    ap.add_argument("--until", help="ISO date (exclusive)")
    ap.add_argument("--incremental", action="store_true",
                    help="start from the newest message already stored per channel")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.incremental and not args.since:
        ap.error("give --since/--until for a backfill, or --incremental")

    TOKEN = keychain_token()
    owners = owner_map()
    print("resolved %d active owner Discord ids" % len(owners))

    until = (datetime.fromisoformat(args.until).replace(tzinfo=timezone.utc)
             if args.until else datetime.now(timezone.utc))

    cursors = {}
    if args.incremental:
        for r in d1("SELECT channel_id, MAX(posted_at_unix) AS newest "
                    "FROM ups_discord_messages GROUP BY channel_id"):
            cursors[str(r["channel_id"])] = int(r["newest"] or 0)

    total_new, rows = 0, []
    for cid, cname in CHANNELS.items():
        if args.incremental:
            newest = cursors.get(cid, 0)
            since = (datetime.fromtimestamp(newest, timezone.utc) + timedelta(seconds=1)
                     if newest else datetime.now(timezone.utc) - timedelta(days=30))
        else:
            since = datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)

        msgs = fetch_window(cid, since, until)
        kept = 0
        for m in msgs:
            content = (m.get("content") or "").strip()
            if not content:
                continue                     # pure attachment/embed posts carry no quotable text
            ts = datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00"))
            season, week = resolve_week(ts)
            author = m.get("author") or {}
            aid = str(author.get("id") or "")
            fid, owner = owners.get(aid, (None, None))
            ref = m.get("referenced_message") or {}
            rows.append((
                str(m["id"]), cid, cname, aid,
                author.get("global_name") or author.get("username"),
                fid, owner, content, int(ts.timestamp()), season, week,
                1 if author.get("bot") else 0,
                str(ref.get("id")) if ref.get("id") else None,
                len(m.get("attachments") or []),
            ))
            kept += 1
        total_new += kept
        print("  #%-22s %4d message(s) since %s" % (cname, kept, since.strftime("%Y-%m-%d")))

    if not rows:
        print("nothing new")
        return 0

    named = sum(1 for r in rows if r[6])
    print("\n%d message(s); %d attributed to a known owner, %d from bots/others"
          % (len(rows), named, len(rows) - named))

    if args.dry_run:
        print("(dry run -- nothing written)")
        for r in rows[:5]:
            print("   %s  %-16s %s" % (datetime.fromtimestamp(r[8], timezone.utc).strftime("%Y-%m-%d %H:%M"),
                                       r[6] or r[4], r[7][:90]))
        return 0

    # Chunked INSERT OR REPLACE. D1 caps a single statement around 100 KB, and
    # message text is unbounded user input, so batch conservatively by BYTES
    # rather than by row count.
    import tempfile
    written = 0
    batch, size = [], 0
    def flush(batch):
        if not batch:
            return
        sql = ("INSERT OR REPLACE INTO ups_discord_messages "
               "(message_id, channel_id, channel_name, author_id, author_display, "
               "franchise_id, owner_name, content, posted_at_unix, season, week, "
               "is_bot, reply_to_id, attachment_count, ingested_at_utc) VALUES "
               + ",".join(batch) + ";")
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
            f.write(sql)
            path = f.name
        try:
            d1_exec_file(path)
        finally:
            os.unlink(path)

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for r in rows:
        vals = "(%s,%s,%s,%s,%s,%s,%s,%s,%d,%s,%s,%d,%s,%d,%s)" % (
            sq(r[0]), sq(r[1]), sq(r[2]), sq(r[3]), sq(r[4]), sq(r[5]), sq(r[6]),
            sq(r[7]), r[8], r[9] if r[9] else "NULL", r[10] if r[10] else "NULL",
            r[11], sq(r[12]), r[13], sq(stamp))
        if size + len(vals) > 60000:
            flush(batch); written += len(batch); batch, size = [], 0
        batch.append(vals); size += len(vals) + 1
    flush(batch); written += len(batch)

    print("wrote %d row(s) to ups_discord_messages" % written)
    return 0


if __name__ == "__main__":
    sys.exit(main())
