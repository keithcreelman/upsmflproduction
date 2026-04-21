#!/usr/bin/env python3
"""Backfill missing bye-week franchise rows in weeklyresults + weeklyresults_summary.

MFL's weeklyResults endpoint omits franchises without a head-to-head matchup (byes
during playoff weeks). Those teams still submit lineups and score points — which is
why the `standings` table's season-aggregate AP totals are higher than what per-week
rows imply. Use MISSING_AS_BYE=1 to retrieve all 12 franchise scores per week, then
rebuild per-week AP (W/L/T) against the full 11-opponent slate.

Scope: playoff weeks only (14-16 for 2010-2020; 15-17 for 2021-2025).
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.request
from typing import Any

DB = os.environ.get(
    "MFL_DB_PATH",
    "/Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db",
)
APIKEY = os.environ.get("MFL_APIKEY", "aRBv1sCXvuWpx0OmP13EaDoeFbox")

PLAYOFF_WEEKS = {
    **{yr: (14, 15, 16) for yr in range(2010, 2021)},
    **{yr: (15, 16, 17) for yr in range(2021, 2026)},
}


def league_coords(conn: sqlite3.Connection) -> dict[int, tuple[str, str]]:
    """Return {season: (server, league_id)}."""
    return {
        season: (server, str(lid))
        for season, server, lid in conn.execute(
            "SELECT season, server, league_id FROM league_years"
        ).fetchall()
    }


def fetch_week(season: int, week: int, server: str, league_id: str) -> dict[str, Any]:
    url = (
        f"https://{server}.myfantasyleague.com/{season}/export?TYPE=weeklyResults"
        f"&L={league_id}&W={week}&MISSING_AS_BYE=1&JSON=1&APIKEY={APIKEY}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "mfl-backfill/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def parse_franchises(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Return one dict per franchise (excluding BYE sentinel) with score + players."""
    wr = payload.get("weeklyResults", {}) or {}
    matchups = wr.get("matchup", []) or []
    if isinstance(matchups, dict):
        matchups = [matchups]
    out = []
    for m in matchups:
        fr = m.get("franchise", []) or []
        if isinstance(fr, dict):
            fr = [fr]
        ids = [f.get("id") for f in fr]
        for f in fr:
            fid = f.get("id")
            if not fid or fid == "BYE":
                continue
            opp = next((i for i in ids if i != fid and i != "BYE"), None)
            players_raw = f.get("player", []) or []
            if isinstance(players_raw, dict):
                players_raw = [players_raw]
            score = f.get("score")
            try:
                score_f = float(score) if score not in (None, "") else None
            except ValueError:
                score_f = None
            opt = f.get("opt_pts")
            try:
                opt_f = float(opt) if opt not in (None, "") else None
            except ValueError:
                opt_f = None
            out.append({
                "id": fid,
                "opponent": opp,  # None when BYE
                "is_home": bool(f.get("isHome") == "1"),
                "result": f.get("result"),
                "score": score_f,
                "opt_pts": opt_f,
                "players": players_raw,
            })
    return out


def replace_week_rows(conn: sqlite3.Connection, season: int, week: int, franchises: list[dict[str, Any]]) -> None:
    """Delete existing rows for (season, week) and re-insert from API payload."""
    cur = conn.cursor()
    cur.execute("DELETE FROM weeklyresults WHERE season=? AND week=?", (season, week))
    is_playoff = 1  # we're only backfilling playoff weeks
    rows = []
    for f in franchises:
        fid = f["id"]
        score = f["score"]
        opt = f["opt_pts"]
        result = f["result"] or ("BYE" if f["opponent"] is None else None)
        is_home = 1 if f["is_home"] else 0
        for p in f["players"]:
            try:
                pscore = float(p.get("score")) if p.get("score") not in (None, "") else None
            except ValueError:
                pscore = None
            rows.append((
                season, week, fid, is_home, result,
                score, opt,
                str(p.get("id")),
                pscore,
                p.get("status"),
                int(p.get("shouldStart") or 0),
                is_playoff,
            ))
    cur.executemany(
        """INSERT OR REPLACE INTO weeklyresults
           (season, week, franchise_id, is_home, result, team_score, team_opt_pts,
            player_id, player_score, status, should_start, is_playoff)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )


def rebuild_summary_for_week(conn: sqlite3.Connection, season: int, week: int) -> None:
    """Rebuild weeklyresults_summary for (season, week) — compute AP against all present franchises."""
    cur = conn.cursor()
    # Team scores this week (one per franchise)
    team_scores = cur.execute(
        """SELECT franchise_id, team_score, result, team_opt_pts
           FROM (SELECT franchise_id, team_score, result, team_opt_pts,
                        ROW_NUMBER() OVER (PARTITION BY franchise_id ORDER BY player_id) AS rn
                 FROM weeklyresults WHERE season=? AND week=?)
           WHERE rn=1""",
        (season, week),
    ).fetchall()
    if not team_scores:
        return
    by_fid = {fid: score for fid, score, _r, _o in team_scores}

    # Metadata for franchise_name/owner_name
    meta = {fid: (name, owner) for fid, name, owner in cur.execute(
        "SELECT franchise_id, team_name, owner_name FROM franchises WHERE season=?",
        (season,),
    ).fetchall()}

    cur.execute("DELETE FROM weeklyresults_summary WHERE season=? AND week=?", (season, week))
    rows = []
    for fid, score, result, opt in team_scores:
        if score is None:
            continue
        name, owner = meta.get(fid, (None, None))
        ap_w = sum(1 for o_fid, o_sc in by_fid.items() if o_fid != fid and o_sc is not None and o_sc < score)
        ap_l = sum(1 for o_fid, o_sc in by_fid.items() if o_fid != fid and o_sc is not None and o_sc > score)
        ap_t = sum(1 for o_fid, o_sc in by_fid.items() if o_fid != fid and o_sc is not None and o_sc == score)
        ap_games = ap_w + ap_l + ap_t

        # h2h — we don't have matchup pairing reliably rebuilt here, leave nulls for opp1-3
        # but populate team_score and h2h_games=1/0 based on result presence
        h2h_result = result
        h2h_wins = 1 if result and result.upper().startswith("W") else 0
        h2h_losses = 1 if result and result.upper().startswith("L") else 0
        h2h_ties = 1 if result and result.upper().startswith("T") else 0
        h2h_games = 0 if result == "BYE" else (1 if result else 0)

        rows.append((
            season, week, fid, name, owner,
            score,  # h2h_team_score
            None, None, None, None,  # opp1
            None, None, None, None,  # opp2
            None, None, None, None,  # opp3
            h2h_result, h2h_wins, h2h_losses, h2h_ties, h2h_games,
            ap_w, ap_l, ap_t, ap_games,
            score, None,  # off_points, def_points — unchanged convention
            None, None, None,  # ap_off_w/l/t
            None, None, None,  # ap_def_w/l/t
        ))
    cur.executemany(
        """INSERT OR REPLACE INTO weeklyresults_summary
           (season, week, franchise_id, franchise_name, owner_name,
            h2h_team_score,
            h2h_opponent1_id, h2h_opponent1_name, h2h_opponent1_owner, h2h_opponent1_score,
            h2h_opponent2_id, h2h_opponent2_name, h2h_opponent2_owner, h2h_opponent2_score,
            h2h_opponent3_id, h2h_opponent3_name, h2h_opponent3_owner, h2h_opponent3_score,
            h2h_result, h2h_wins, h2h_losses, h2h_ties, h2h_games,
            allplay_wins, allplay_losses, allplay_ties, allplay_games,
            off_points, def_points,
            allplay_off_wins, allplay_off_losses, allplay_off_ties,
            allplay_def_wins, allplay_def_losses, allplay_def_ties)
           VALUES (?,?,?,?,?, ?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?, ?,?,?, ?,?,?)""",
        rows,
    )


def main() -> None:
    seasons = [int(s) for s in sys.argv[1:]] if len(sys.argv) > 1 else sorted(PLAYOFF_WEEKS)
    conn = sqlite3.connect(DB)
    try:
        coords = league_coords(conn)
        for season in seasons:
            weeks = PLAYOFF_WEEKS.get(season)
            if not weeks:
                continue
            server_lid = coords.get(season)
            if not server_lid:
                print(f"  {season}: no league_years entry, skipping", file=sys.stderr)
                continue
            server, league_id = server_lid
            for week in weeks:
                try:
                    payload = fetch_week(season, week, server, league_id)
                except Exception as exc:
                    print(f"  {season} W{week}: FETCH FAILED ({exc})", file=sys.stderr)
                    continue
                franchises = parse_franchises(payload)
                fid_set = {f["id"] for f in franchises}
                if not franchises:
                    print(f"  {season} W{week}: no franchise data")
                    continue
                replace_week_rows(conn, season, week, franchises)
                rebuild_summary_for_week(conn, season, week)
                conn.commit()
                print(f"  {season} W{week}: {len(fid_set)} franchises ({sorted(fid_set)})")
                time.sleep(0.3)  # be polite
    finally:
        conn.close()


if __name__ == "__main__":
    main()
