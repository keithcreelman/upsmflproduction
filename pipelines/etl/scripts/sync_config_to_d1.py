#!/usr/bin/env python3
"""
sync_config_to_d1.py — keep the current-season CONFIG tables in D1 fresh.

Why this exists
---------------
The legacy chain MFL -> ~/Desktop/MFL_Scripts -> local SQLite -> load_local_to_d1.py
was MANUAL end-to-end, so at season rollover the CONFIG tables (src_franchises,
src_league_season_meta) had no rows for the new season — which broke the V2
standings divisions, owners, etc. (see docs/DATA_AUTHORITY_MAP.md).

This script replaces that chain for the CONFIG tables: it fetches TYPE=league
LIVE from MFL (with the commissioner cookie, which is what unlocks owner names),
and upserts:

  * src_franchises          (season, franchise_id, owner_name, team_name, division, logo)
  * src_league_season_meta  (season, league_id, mfl_server, weeks...)

RESULTS tables (src_standings, src_schedule, weekly scores) fill as games are
played and are handled separately; the standings worker also synthesizes 0-0
preseason rows when they're empty.

Auth
----
Owner names are private; MFL only returns them to a commissioner session. Pass
the cookie via the MFL_COOKIE env var (same secret the worker uses). Without it
the sync still runs but owner_name comes back empty.

Usage
-----
  # local test — read a committed snapshot, print SQL, write nothing:
  python3 sync_config_to_d1.py --season 2026 --from-file data/mfl-snapshots/2026-05-15/league.json --dry-run

  # CI — fetch live + load D1:
  MFL_COOKIE=... CLOUDFLARE_API_TOKEN=... \
    python3 sync_config_to_d1.py --season 2026
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile
import urllib.request


def active_season(today=None):
    """The active UPS season for data purposes.

    UPS's final week is endWeek (17), which completes in early January (~NFL
    Week 18 kickoff). A raw calendar year would roll on Jan 1 while Week 17 is
    still being played, so keep January days 1-7 on the PRIOR season and roll at
    ~Week 18 kickoff (Jan 8). Override anytime with --season / MFL_YEAR.
    """
    d = today or datetime.datetime.now(datetime.timezone.utc)
    if d.month == 1 and d.day < 8:
        return d.year - 1
    return d.year


def fetch_league(season, league_id, server):
    url = (f"https://{server}.myfantasyleague.com/{season}/export"
           f"?TYPE=league&L={league_id}&JSON=1")
    cookie = (os.environ.get("MFL_COOKIE") or "").strip()
    cookie_hdr = cookie if "=" in cookie else (f"MFL_USER_ID={cookie}" if cookie else "")
    req = urllib.request.Request(url, headers={
        "User-Agent": "upsmflproduction-config-sync",
        **({"Cookie": cookie_hdr} if cookie_hdr else {}),
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def sql_str(v):
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def pad_fid(fid):
    s = "".join(ch for ch in str(fid) if ch.isdigit())
    return s.rjust(4, "0")[:4]


def build_sql(season, league_id, server, league_obj):
    lg = league_obj.get("league", {}) or {}
    franchises = as_list((lg.get("franchises") or {}).get("franchise"))

    rows = []
    for f in franchises:
        if not f or f.get("id") is None:
            continue
        rows.append((
            int(season),
            pad_fid(f.get("id")),
            f.get("owner_name"),                       # populated only with commish cookie
            f.get("name"),
            (str(f.get("division")) if f.get("division") is not None else None),
            (f.get("logo") or f.get("icon") or None),
        ))

    stmts = []
    # src_franchises — upsert per (season, franchise_id)
    for (s, fid, owner, team, div, logo) in rows:
        stmts.append(
            "INSERT INTO src_franchises (season, franchise_id, owner_name, team_name, division, logo) "
            f"VALUES ({s}, {sql_str(fid)}, {sql_str(owner)}, {sql_str(team)}, {sql_str(div)}, {sql_str(logo)}) "
            "ON CONFLICT(season, franchise_id) DO UPDATE SET "
            # Preserve an existing owner if this run had no cookie (owner_name NULL),
            # so a cookie-less run never wipes good owner data.
            "owner_name=COALESCE(excluded.owner_name, src_franchises.owner_name), "
            "team_name=excluded.team_name, division=excluded.division, logo=excluded.logo;"
        )

    # src_league_season_meta — upsert per season
    reg = lg.get("lastRegularSeasonWeek")
    end = lg.get("endWeek")
    reg_i = int(reg) if str(reg or "").isdigit() else None
    end_i = int(end) if str(end or "").isdigit() else None
    playoff_i = (end_i - reg_i) if (reg_i is not None and end_i is not None) else None
    stmts.append(
        "INSERT INTO src_league_season_meta "
        "(season, league_id, mfl_server, last_regular_season_week, total_weeks, reg_weeks, playoff_weeks, notes) "
        f"VALUES ({int(season)}, {sql_str(league_id)}, {sql_str(server)}, "
        f"{reg_i if reg_i is not None else 'NULL'}, {end_i if end_i is not None else 'NULL'}, "
        f"{reg_i if reg_i is not None else 'NULL'}, {playoff_i if playoff_i is not None else 'NULL'}, "
        f"{sql_str('synced by sync_config_to_d1.py')}) "
        "ON CONFLICT(season) DO UPDATE SET "
        "league_id=excluded.league_id, mfl_server=excluded.mfl_server, "
        "last_regular_season_week=excluded.last_regular_season_week, "
        "total_weeks=excluded.total_weeks, reg_weeks=excluded.reg_weeks, "
        "playoff_weeks=excluded.playoff_weeks;"
    )
    return rows, stmts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default=None, help="UPS season year; default = computed active season (rolls at ~Week 18 kickoff, not Jan 1)")
    ap.add_argument("--league-id", default="74598")
    ap.add_argument("--server", default="www48")
    ap.add_argument("--db", default="ups-mfl-db")
    ap.add_argument("--from-file", default=None, help="read league JSON from a file instead of fetching")
    ap.add_argument("--dry-run", action="store_true", help="print SQL, do not touch D1")
    args = ap.parse_args()
    season = args.season or str(active_season())

    if args.from_file:
        league_obj = json.load(open(args.from_file))
    else:
        league_obj = fetch_league(season, args.league_id, args.server)

    rows, stmts = build_sql(season, args.league_id, args.server, league_obj)
    owners = sum(1 for r in rows if r[2])
    print(f"[config-sync] season={season} franchises={len(rows)} with_owner={owners}", file=sys.stderr)
    if not rows:
        print("[config-sync] no franchises parsed — aborting (won't wipe D1)", file=sys.stderr)
        sys.exit(2)

    sql = "\n".join(stmts) + "\n"
    if args.dry_run:
        print(sql)
        return

    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as tf:
        tf.write(sql)
        path = tf.name
    cmd = ["npx", "wrangler", "d1", "execute", args.db, "--remote", f"--file={path}"]
    print(f"[config-sync] running: {' '.join(cmd)}", file=sys.stderr)
    subprocess.run(cmd, check=True)
    print(f"[config-sync] loaded {len(rows)} franchises + season meta for {args.season}", file=sys.stderr)


if __name__ == "__main__":
    main()
