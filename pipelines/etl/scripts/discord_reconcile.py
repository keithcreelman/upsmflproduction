#!/usr/bin/env python3
"""discord_reconcile.py -- scheduled REST reconciliation for the Discord
message archive (migration 0158_discord_message_ingestion.sql).

    python pipelines/etl/scripts/discord_reconcile.py
    python pipelines/etl/scripts/discord_reconcile.py --dry-run

WHY THIS EXISTS (Keith 2026-09-16 spec, "Shared Discord intelligence
service"): the Wire's forecast work exposed a real gap in this same
conversation -- big rank/odds swings need a named, real cause, and league
sentiment is one of the places that cause lives, but every Discord "quote"
surface in this repo today is Keith hand-editing owner_profiles.json and
running a sync script by hand. That's fine for roast/therapy ammo; it can't
answer "what is the league saying right now."

SCOPE OF THIS PASS, confirmed with Keith before building (two AskUserQuestion
rounds, 2026-09-16): FOUNDATION ONLY -- raw message capture, edit/delete
tracking, per-channel cursors, and freshness monitoring via REST
reconciliation. Deliberately NOT built here, by explicit choice:
  * The real-time Gateway listener. The only process in this repo that
    already holds a Discord Gateway (WebSocket) connection is
    trade_roast_bot.py; a second, competing Gateway session on the same bot
    token risks session conflicts, so the agreed next step is to extend
    THAT process rather than start a new one -- not done in this pass.
  * The 8-method shared query API (get_recent_discord_messages() etc.) --
    comes after this reconciliation path is proven live.
  * discord_quotes extraction -- the table exists (migration 0158) but this
    script does not populate it. "What counts as quote-worthy" is a real
    product decision (the Coffee Shop's 11,652 messages have documented
    ~3.9% retrieval value, docs/DISCORD_REDESIGN_2026.md) that was not part
    of the confirmed scope.
  * Archived-thread backfill. Only active threads under the target channels
    are reconciled; paginating archived public threads by timestamp is a
    reasonable next increment, not included here.
  * Any cron/launchd/GitHub Action wiring. This runs by hand
    (`python pipelines/etl/scripts/discord_reconcile.py`) until a schedule
    is explicitly requested -- same "no new scheduled job without asking"
    norm this session already applied to season_sim.py's run_live().

DELETION DETECTION IS INFERRED, NOT AUTHORITATIVE. Discord's REST API has no
"list deleted messages" endpoint -- deletions are only delivered live, over
the Gateway, which this pass does not hold. What this script does instead:
re-fetch the last RECONCILE_WINDOW_HOURS of each channel/thread on every run,
and treat a message that was previously stored as ORIGIN_INFERRED (not
event-sourced) missing from that re-fetch as deleted. This can be wrong (a
message can scroll out of the reconciliation window's page bounds under
enough channel volume) -- discord_message_events.detail says
"inferred_missing_on_refetch", never silently claims a real MESSAGE_DELETE
event, and discord_messages_raw.is_deleted is a best-effort signal, not
ground truth, until the Gateway listener lands.

IDEMPOTENCY: every write is an upsert keyed on (guild_id, channel_id,
message_id) for discord_messages_raw, and (guild_id, channel_id, message_id,
revision) for discord_message_revisions -- the exact uniqueness key the spec
asked for. Re-running this script twice on the same data produces the same
rows, never duplicates.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WORKER_DIR = os.path.join(REPO, "worker")
DISCORD_API = "https://discord.com/api/v10"

# Coffee Shop / On the Sofa, per docs/DISCORD_REDESIGN_2026.md's own channel
# ID table (the spec's named channels) -- not guessed, cited from the repo's
# existing documentation of its own server.
TARGET_CHANNELS = {
    "1087157907419840644": "the-coffee-shop",
    "1291737646665699420": "on-the-sofa",
}
RECONCILE_WINDOW_HOURS = 24
PAGE_LIMIT = 100


def _keychain_secret(env_name, keychain_service):
    """Same lookup trade_roast_bot.py uses: env var first, then macOS
    Keychain, so this script shares the one already-configured bot token
    rather than asking for a second secret."""
    env_val = os.environ.get(env_name, "").strip()
    if env_val:
        return env_val
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ.get("USER", ""),
             "-s", keychain_service, "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


BOT_TOKEN = _keychain_secret("DISCORD_BOT_TOKEN", "discord_bot_token")
GUILD_ID = os.environ.get("DISCORD_GUILD_ID", "").strip()


def discord_get(path, params=None):
    """GET against Discord's REST API with the bot token, honoring 429s.
    No fail-open: a non-2xx that is not a retryable 429 raises."""
    if not BOT_TOKEN:
        raise SystemExit("discord_reconcile: no DISCORD_BOT_TOKEN (env or Keychain "
                         "'discord_bot_token') -- refusing to run without real auth")
    url = DISCORD_API + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    req = urllib.request.Request(url, headers={
        "Authorization": "Bot %s" % BOT_TOKEN,
        "User-Agent": "ups-wire-discord-reconcile (https://github.com/keithcreelman/upsmflproduction, 1.0)",
    })
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                body = json.loads(e.read().decode("utf-8") or "{}")
                wait = float(body.get("retry_after", 2.0)) + 0.25
                print("discord_reconcile: 429, waiting %.1fs" % wait, file=sys.stderr)
                time.sleep(wait)
                continue
            detail = e.read().decode("utf-8", "replace")
            raise SystemExit("discord_reconcile: GET %s failed: %s %s" % (path, e.code, detail[:300]))
    raise SystemExit("discord_reconcile: GET %s -- exhausted retries on repeated 429s" % path)


def fetch_messages_since(channel_id, after_id=None, oldest_utc=None):
    """Every message in this channel newer than `after_id` (cursor mode) OR
    newer than `oldest_utc` (window mode, when after_id is None) -- paginates
    forward from the oldest qualifying message using Discord's `after` param
    so results come back oldest-first, matching how a cursor should advance."""
    out = []
    since = after_id
    while True:
        batch = discord_get("/channels/%s/messages" % channel_id,
                            {"after": since, "limit": PAGE_LIMIT} if since else {"limit": PAGE_LIMIT})
        if not batch:
            break
        batch.sort(key=lambda m: int(m["id"]))
        if oldest_utc and not since:
            batch = [m for m in batch if _parse_dt(m["timestamp"]) >= oldest_utc]
            if not batch:
                break
        out.extend(batch)
        if len(batch) < PAGE_LIMIT:
            break
        since = batch[-1]["id"]
    return out


def fetch_active_threads(guild_id, parent_channel_ids):
    """Active (not yet archived) threads under the target channels --
    "relevant threads and replies" per the spec, scoped to what's live right
    now. Archived-thread backfill is an explicit scope cut; see the module
    docstring."""
    data = discord_get("/guilds/%s/threads/active" % guild_id)
    threads = data.get("threads", []) if isinstance(data, dict) else []
    return [t for t in threads if t.get("parent_id") in parent_channel_ids]


def _parse_dt(iso_ts):
    return datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))


def _now_utc_str():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sql_quote(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'%s'" % str(v).replace("'", "''")


def d1_execute(sql_text, label, dry_run=False):
    if dry_run:
        print("  [dry-run] %s:\n%s" % (label, sql_text[:2000]))
        return
    if not sql_text.strip():
        return
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
        f.write(sql_text)
        sql_path = f.name
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--file", sql_path],
        capture_output=True, text=True, cwd=WORKER_DIR,
    )
    if result.returncode != 0:
        sys.stderr.write("discord_reconcile: D1 write failed for %s:\n%s\n" % (label, result.stderr))
        sys.exit(1)


def d1_query(sql_text):
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--command", sql_text, "--json"],
        capture_output=True, text=True, cwd=WORKER_DIR,
    )
    if result.returncode != 0:
        sys.stderr.write("discord_reconcile: D1 read failed:\n%s\n" % result.stderr)
        sys.exit(1)
    payload = json.loads(result.stdout)
    return payload[0]["results"]


def message_url(guild_id, channel_id, message_id):
    return "https://discord.com/channels/%s/%s/%s" % (guild_id, channel_id, message_id)


def reconcile_channel(channel_id, channel_name, guild_id, thread_id, dry_run):
    """One channel or thread: cursor-forward for new messages, a
    window re-fetch for edits/inferred deletions. Returns a
    discord_sync_health row (dict)."""
    t0 = time.time()
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=RECONCILE_WINDOW_HOURS)
    fetch_id = thread_id or channel_id

    cursor_rows = d1_query("SELECT last_message_id FROM discord_ingest_cursors WHERE channel_id = '%s'"
                           % fetch_id)
    cursor = cursor_rows[0]["last_message_id"] if cursor_rows else None

    new_from_cursor = fetch_messages_since(fetch_id, after_id=cursor) if cursor else []
    window_msgs = fetch_messages_since(fetch_id, oldest_utc=window_start)
    by_id = {m["id"]: m for m in (new_from_cursor + window_msgs)}
    all_fetched = sorted(by_id.values(), key=lambda m: int(m["id"]))

    existing = {r["message_id"]: r for r in d1_query(
        "SELECT message_id, edited_at_utc, current_revision, is_deleted "
        "FROM discord_messages_raw WHERE channel_id = '%s' AND created_at_utc >= '%s'"
        % (fetch_id, window_start.strftime("%Y-%m-%dT%H:%M:%SZ")))}

    new_count = edited_count = 0
    sql_parts = []
    events_parts = []
    now_str = _now_utc_str()

    for m in all_fetched:
        mid = m["id"]
        author = m.get("author") or {}
        content = m.get("content") or ""
        created = m["timestamp"]
        edited = m.get("edited_timestamp")
        url = message_url(guild_id, channel_id, mid)
        ref = m.get("message_reference") or {}
        parent_id = ref.get("message_id")

        prior = existing.get(mid)
        if prior is None:
            new_count += 1
            sql_parts.append(
                "INSERT INTO discord_messages_raw (guild_id, channel_id, message_id, thread_id, "
                "parent_message_id, author_id, author_display_name, content, message_url, "
                "created_at_utc, edited_at_utc, current_revision, is_deleted, first_captured_at_utc, "
                "last_verified_at_utc) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 1, 0, %s, %s) "
                "ON CONFLICT(guild_id, channel_id, message_id) DO UPDATE SET "
                "last_verified_at_utc = excluded.last_verified_at_utc;"
                % (sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid), sql_quote(thread_id),
                  sql_quote(parent_id), sql_quote(author.get("id")), sql_quote(author.get("username")),
                  sql_quote(content), sql_quote(url), sql_quote(created), sql_quote(edited),
                  sql_quote(now_str), sql_quote(now_str)))
            sql_parts.append(
                "INSERT INTO discord_message_revisions (guild_id, channel_id, message_id, revision, "
                "content, captured_at_utc) VALUES (%s, %s, %s, 1, %s, %s) "
                "ON CONFLICT(guild_id, channel_id, message_id, revision) DO NOTHING;"
                % (sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid), sql_quote(content),
                  sql_quote(now_str)))
            events_parts.append(
                "INSERT INTO discord_message_events (guild_id, channel_id, message_id, event_type, "
                "event_at_utc, detail) VALUES (%s, %s, %s, 'created', %s, NULL);"
                % (sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid), sql_quote(now_str)))
        elif edited and edited != prior.get("edited_at_utc"):
            edited_count += 1
            next_rev = int(prior["current_revision"]) + 1
            sql_parts.append(
                "UPDATE discord_messages_raw SET content = %s, edited_at_utc = %s, "
                "current_revision = %d, is_deleted = 0, last_verified_at_utc = %s "
                "WHERE guild_id = %s AND channel_id = %s AND message_id = %s;"
                % (sql_quote(content), sql_quote(edited), next_rev, sql_quote(now_str),
                  sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid)))
            sql_parts.append(
                "INSERT INTO discord_message_revisions (guild_id, channel_id, message_id, revision, "
                "content, captured_at_utc) VALUES (%s, %s, %s, %d, %s, %s) "
                "ON CONFLICT(guild_id, channel_id, message_id, revision) DO NOTHING;"
                % (sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid), next_rev,
                  sql_quote(content), sql_quote(now_str)))
            events_parts.append(
                "INSERT INTO discord_message_events (guild_id, channel_id, message_id, event_type, "
                "event_at_utc, detail) VALUES (%s, %s, %s, 'edited', %s, NULL);"
                % (sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid), sql_quote(now_str)))
        else:
            sql_parts.append(
                "UPDATE discord_messages_raw SET last_verified_at_utc = %s "
                "WHERE guild_id = %s AND channel_id = %s AND message_id = %s;"
                % (sql_quote(now_str), sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid)))

    # Deletion: previously-stored, not-yet-deleted messages in the window
    # that did not appear in this run's window re-fetch. INFERRED, not an
    # event -- see module docstring.
    seen_ids = set(by_id)
    deleted_count = 0
    for mid, prior in existing.items():
        if mid in seen_ids or int(prior["is_deleted"]):
            continue
        deleted_count += 1
        sql_parts.append(
            "UPDATE discord_messages_raw SET is_deleted = 1, deleted_inferred_at_utc = %s "
            "WHERE guild_id = %s AND channel_id = %s AND message_id = %s;"
            % (sql_quote(now_str), sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid)))
        events_parts.append(
            "INSERT INTO discord_message_events (guild_id, channel_id, message_id, event_type, "
            "event_at_utc, detail) VALUES (%s, %s, %s, 'deleted', %s, "
            "'inferred_missing_on_refetch -- not a real MESSAGE_DELETE event, no Gateway listener yet');"
            % (sql_quote(guild_id), sql_quote(channel_id), sql_quote(mid), sql_quote(now_str)))

    new_cursor = all_fetched[-1]["id"] if all_fetched else cursor
    sql_parts.append(
        "INSERT INTO discord_ingest_cursors (channel_id, channel_name, last_message_id, "
        "last_synced_at_utc, last_status) VALUES (%s, %s, %s, %s, 'ok') "
        "ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id, "
        "last_synced_at_utc = excluded.last_synced_at_utc, last_status = 'ok';"
        % (sql_quote(fetch_id), sql_quote(channel_name), sql_quote(new_cursor), sql_quote(now_str)))

    d1_execute("\n".join(sql_parts), "%s messages" % channel_name, dry_run)
    d1_execute("\n".join(events_parts), "%s events" % channel_name, dry_run)

    return {
        "channel_id": fetch_id, "channel_name": channel_name,
        "new_messages": new_count, "edited_messages": edited_count,
        "deleted_messages_inferred": deleted_count,
        "duration_ms": int((time.time() - t0) * 1000),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="fetch and print SQL, write nothing to D1")
    a = ap.parse_args()

    if not GUILD_ID:
        raise SystemExit("discord_reconcile: DISCORD_GUILD_ID is not set -- refusing to guess the guild")

    print("discord_reconcile: guild %s, %d target channel(s), %dh reconciliation window" %
          (GUILD_ID, len(TARGET_CHANNELS), RECONCILE_WINDOW_HOURS))

    threads = fetch_active_threads(GUILD_ID, set(TARGET_CHANNELS))
    print("  found %d active thread(s) under target channels" % len(threads))

    health_rows = []
    api_errors = []
    for cid, cname in TARGET_CHANNELS.items():
        try:
            health_rows.append(reconcile_channel(cid, cname, GUILD_ID, None, a.dry_run))
        except SystemExit as e:
            api_errors.append("%s: %s" % (cname, e))
            health_rows.append({"channel_id": cid, "channel_name": cname, "new_messages": 0,
                                "edited_messages": 0, "deleted_messages_inferred": 0, "duration_ms": 0})
    threads_reconciled = 0
    for t in threads:
        parent_name = TARGET_CHANNELS.get(t["parent_id"], "?")
        tname = "%s > %s" % (parent_name, t.get("name") or t["id"])
        try:
            reconcile_channel(t["parent_id"], tname, GUILD_ID, t["id"], a.dry_run)
            threads_reconciled += 1
        except SystemExit as e:
            api_errors.append("%s: %s" % (tname, e))

    now_str = _now_utc_str()
    status = "failed" if len(api_errors) == len(TARGET_CHANNELS) else ("partial" if api_errors else "ok")
    for h in health_rows:
        sql = ("INSERT INTO discord_sync_health (run_at_utc, channel_id, channel_name, new_messages, "
              "edited_messages, deleted_messages_inferred, threads_reconciled, api_errors, duration_ms, "
              "status) VALUES (%s, %s, %s, %d, %d, %d, %d, %s, %d, %s);"
              % (sql_quote(now_str), sql_quote(h["channel_id"]), sql_quote(h["channel_name"]),
                h["new_messages"], h["edited_messages"], h["deleted_messages_inferred"],
                threads_reconciled if h is health_rows[0] else 0, sql_quote("; ".join(api_errors) or None),
                h["duration_ms"], sql_quote(status)))
        d1_execute(sql, "sync_health(%s)" % h["channel_name"], a.dry_run)

    # Same freshness convention nflverse already uses -- one row per source,
    # read by GET /api/data-freshness.
    etl_detail = "channels=%d threads=%d new=%d edited=%d deleted=%d errors=%d" % (
        len(TARGET_CHANNELS), threads_reconciled,
        sum(h["new_messages"] for h in health_rows), sum(h["edited_messages"] for h in health_rows),
        sum(h["deleted_messages_inferred"] for h in health_rows), len(api_errors))
    d1_execute(
        "INSERT INTO etl_runs (source, last_run_utc, status, detail) VALUES "
        "('discord_reconciliation', %s, %s, %s) ON CONFLICT(source) DO UPDATE SET "
        "last_run_utc = excluded.last_run_utc, status = excluded.status, detail = excluded.detail;"
        % (sql_quote(now_str), sql_quote(status), sql_quote(etl_detail)),
        "etl_runs", a.dry_run)

    print("\ndiscord_reconcile: %s -- %s" % (status, etl_detail))
    if api_errors:
        for e in api_errors:
            print("  ERROR: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
