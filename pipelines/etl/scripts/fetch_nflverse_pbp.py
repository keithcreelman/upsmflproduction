#!/usr/bin/env python3
"""Parse nflverse PBP into per-player aggregates across 3 domains:

  1) Yardline-banded rush/target/pass counts (Red-Zone bands) →
     nfl_player_redzone
  2) FG attempts + makes bucketed by kick distance (0-39 / 40-49 /
     50-59 / 60+) and PBP-derived sum-of-distance → nfl_player_weekly
     (fg_att_0_39 ... fg_att_60plus, fg_distance_sum_made, fg_made_pbp)
  3) Punter volume / distance / inside-20 / touchbacks → nfl_player_weekly
     (punts, punt_yds, punt_long, punt_inside20, punt_tb). The nflverse
     weekly `load_player_stats` payload has zero punter coverage, so PBP
     is our only source for those.

PBP is heavy: ~45k plays per season × 15 seasons ≈ 700k plays. We scan
each play once and dispatch into whichever aggregator(s) apply.

Dependencies:
  pip install nflreadpy pandas

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_pbp.py --seasons 2011-2025
  python3 pipelines/etl/scripts/fetch_nflverse_pbp.py --seasons 2024,2025
  # Domain flags (all default on):
  #   --skip-redzone   skip red-zone band aggregator
  #   --skip-fg        skip FG distance buckets
  #   --skip-punts     skip punter volume/distance

Override DB path with $MFL_DB_PATH.
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from pathlib import Path

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)


def parse_seasons(spec: str) -> list[int]:
    out = set()
    for piece in spec.split(","):
        piece = piece.strip()
        if not piece:
            continue
        if "-" in piece:
            a, b = piece.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(piece))
    return sorted(out)


def ensure_table(db: sqlite3.Connection) -> None:
    # Mirrors worker/migrations/0007_nfl_player_redzone.sql so this
    # script works standalone on fresh machines.
    db.execute("""
        CREATE TABLE IF NOT EXISTS nfl_player_redzone (
          season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL,
          rush_att_i20 INTEGER, rush_att_i10 INTEGER, rush_att_i5 INTEGER,
          rush_yds_i20 INTEGER, rush_tds_i20 INTEGER,
          targets_i20 INTEGER, targets_i10 INTEGER, targets_i5 INTEGER,
          targets_ez INTEGER, rec_i20 INTEGER, rec_tds_i20 INTEGER,
          pass_att_i20 INTEGER, pass_tds_i20 INTEGER, pass_att_ez INTEGER,
          PRIMARY KEY (season, week, gsis_id)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_redzone_player ON nfl_player_redzone (gsis_id, season)")
    db.commit()


def process_season(db: sqlite3.Connection, season: int,
                   do_redzone: bool = True,
                   do_fg: bool = True,
                   do_punts: bool = True,
                   do_team: bool = True) -> dict:
    try:
        import nflreadpy as nfl
    except Exception as e:
        sys.exit(f"FATAL: could not import nflreadpy: {type(e).__name__}: {e}")

    print(f"  loading PBP for {season}...", file=sys.stderr)
    df = nfl.load_pbp(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})

    # Filter to reg + post (skip preseason)
    if "season_type" in df.columns:
        df = df[df["season_type"].isin(["REG", "POST"])]

    # We want: run/pass (redzone + team 4th-down go), field_goal (FG
    # buckets + team 4th-down fg), punt (punter totals + team stall-punt
    # + team 4th-down punt). Team-level 4th-down aggregator needs ALL
    # four play types on 4th down so union them up here.
    want_types = set()
    if do_redzone: want_types.update(["run", "pass"])
    if do_fg:      want_types.add("field_goal")
    if do_punts:   want_types.add("punt")
    if do_team:    want_types.update(["run", "pass", "field_goal", "punt"])
    if not want_types:
        print("  (no domains enabled — skipping season)", file=sys.stderr)
        return {"redzone": 0, "fg": 0, "punt": 0, "team": 0}
    df = df[df["play_type"].isin(list(want_types))]

    # ---- Aggregators (each domain has its own dict keyed by (season,week,gsis)) ----
    rz_agg = {}   # redzone (player)
    fg_agg = {}   # kicker FG (player)
    pt_agg = {}   # punter (player)
    tw_agg = {}   # team-weekly (keyed by (season,week,team))

    def rz_bucket(gsis, week):
        if not gsis:
            return None
        key = (season, int(week), str(gsis))
        if key not in rz_agg:
            rz_agg[key] = {
                "rush_att_i20": 0, "rush_att_i10": 0, "rush_att_i5": 0,
                "rush_yds_i20": 0, "rush_tds_i20": 0,
                "targets_i20": 0, "targets_i10": 0, "targets_i5": 0,
                "targets_ez": 0, "rec_i20": 0, "rec_tds_i20": 0,
                "pass_att_i20": 0, "pass_tds_i20": 0, "pass_att_ez": 0,
            }
        return rz_agg[key]

    def fg_bucket(gsis, week):
        if not gsis:
            return None
        key = (season, int(week), str(gsis))
        if key not in fg_agg:
            fg_agg[key] = {
                "fg_att_0_39": 0, "fg_made_0_39": 0,
                "fg_att_40_49": 0, "fg_made_40_49": 0,
                "fg_att_50_59": 0, "fg_made_50_59": 0,
                "fg_att_60plus": 0, "fg_made_60plus": 0,
                "fg_distance_sum_made": 0, "fg_made_pbp": 0,
            }
        return fg_agg[key]

    def pt_bucket(gsis, week):
        if not gsis:
            return None
        key = (season, int(week), str(gsis))
        if key not in pt_agg:
            pt_agg[key] = {
                "punts": 0, "punt_yds": 0, "punt_long": 0,
                "punt_inside20": 0, "punt_tb": 0,
                # Avg punt spot — own-yardline at LoS.
                "punt_spot_sum": 0, "punt_spot_count": 0,
                # Net yardage (gross - return_yards). Sum + count derive
                # client-side as net_avg = sum / punts.
                "punt_net_yds_sum": 0,
                # Inside-N buckets — where the ball ended up after the
                # play. End yardline_100 = 100 - end_yard_line (offense
                # perspective). Using nflverse 'punt_inside_twenty'
                # as the canonical I20 source (parity check against
                # bucket-derived I20 lives in the worker).
                "punt_inside5": 0, "punt_inside10": 0, "punt_inside15": 0,
            }
        return pt_agg[key]

    def tw_bucket(team, week):
        if not team:
            return None
        key = (season, int(week), str(team))
        if key not in tw_agg:
            tw_agg[key] = {
                "fourth_down_total": 0, "fourth_down_go": 0,
                "fourth_down_punt": 0, "fourth_down_fg": 0,
                "stall_punts": 0, "team_punts": 0,
            }
        return tw_agg[key]

    for row in df.to_dict(orient="records"):
        week = row.get("week") or 0
        ptype = row.get("play_type")
        posteam = row.get("posteam") or row.get("pos_team")

        # yardline_100 parsed once per row — needed by redzone, stall-punt,
        # and punt-spot branches below.
        yl100 = row.get("yardline_100")
        try:
            yl100 = int(yl100) if yl100 is not None else None
        except (ValueError, TypeError):
            yl100 = None

        # ---- Team 4th-down bookkeeping (runs on every play — cheap) ----
        if do_team and row.get("down") == 4 and posteam and ptype in ("run","pass","field_goal","punt"):
            tb = tw_bucket(posteam, week)
            if tb is not None:
                tb["fourth_down_total"] += 1
                if ptype in ("run","pass"): tb["fourth_down_go"]   += 1
                elif ptype == "punt":       tb["fourth_down_punt"] += 1
                elif ptype == "field_goal": tb["fourth_down_fg"]   += 1

        # ---- FG play: distance-bucket + PBP avg ----
        if ptype == "field_goal" and do_fg:
            kicker = row.get("kicker_player_id") or row.get("kicker_id")
            if kicker:
                dist = row.get("kick_distance")
                try:
                    dist = int(dist) if dist is not None else None
                except (ValueError, TypeError):
                    dist = None
                if dist is not None:
                    b = fg_bucket(kicker, week)
                    result = (row.get("field_goal_result") or "").lower()
                    is_made = result == "made"
                    if dist < 40:
                        b["fg_att_0_39"]  += 1
                        if is_made: b["fg_made_0_39"]  += 1
                    elif dist < 50:
                        b["fg_att_40_49"] += 1
                        if is_made: b["fg_made_40_49"] += 1
                    elif dist < 60:
                        b["fg_att_50_59"] += 1
                        if is_made: b["fg_made_50_59"] += 1
                    else:
                        b["fg_att_60plus"] += 1
                        if is_made: b["fg_made_60plus"] += 1
                    if is_made:
                        b["fg_distance_sum_made"] += dist
                        b["fg_made_pbp"] += 1
            continue  # FG plays don't also fall into redzone bucketing

        # ---- Punt play: punter volume/distance/inside20/touchbacks ----
        if ptype == "punt":
            # Team-level: every punt counts toward team_punts; stall-punt
            # = yardline_100 in [40, 50] (midfield → opp 40 zone).
            if do_team and posteam:
                tb = tw_bucket(posteam, week)
                if tb is not None:
                    tb["team_punts"] += 1
                    if yl100 is not None and 40 <= yl100 <= 50:
                        tb["stall_punts"] += 1

            if do_punts:
                punter = row.get("punter_player_id") or row.get("punter_id")
                if punter:
                    dist = row.get("kick_distance")
                    try:
                        dist = int(dist) if dist is not None else None
                    except (ValueError, TypeError):
                        dist = None
                    ret_yds = row.get("return_yards")
                    try:
                        ret_yds = int(ret_yds) if ret_yds is not None else 0
                    except (ValueError, TypeError):
                        ret_yds = 0
                    b = pt_bucket(punter, week)
                    b["punts"] += 1
                    if dist is not None:
                        b["punt_yds"] += dist
                        b["punt_net_yds_sum"] += max(0, dist - ret_yds)
                        if dist > b["punt_long"]:
                            b["punt_long"] = dist
                    if yl100 is not None:
                        b["punt_spot_sum"] += (100 - yl100)  # own-yardline
                        b["punt_spot_count"] += 1
                    # touchback + inside-N flag (nullable 0/1)
                    if row.get("touchback") in (1, True, "1"):
                        b["punt_tb"] += 1
                    if row.get("punt_inside_twenty") in (1, True, "1"):
                        b["punt_inside20"] += 1
                    # Inside-5/10/15 from end-of-play yardline. nflverse
                    # PBP exposes the receiving team's resulting LoS as
                    # `yardline_100` on the FOLLOWING play; the punt row
                    # itself doesn't carry the end-spot directly. We
                    # reconstruct: end_spot_100 = max(0, yl100_at_punt -
                    # net_yards). Only when both inputs are known.
                    if yl100 is not None and dist is not None:
                        # Net yards on this punt — gross - return. Touchbacks
                        # are conventionally 20-yard returns from the goal
                        # line, but nflverse's return_yards already reflects
                        # touchback-adjusted distance, so plain subtract.
                        net = max(0, dist - ret_yds)
                        end_100 = yl100 - net  # offense perspective: yardline_100 of receiving team's LoS
                        # end_100 < 0 = ball pushed into / past the EZ;
                        # touchbacks cap at 20 in the official stat. Skip
                        # negative + zero (touchback) for inside-N buckets.
                        if end_100 is not None and 0 < end_100:
                            if end_100 <= 5:  b["punt_inside5"]  += 1
                            if end_100 <= 10: b["punt_inside10"] += 1
                            if end_100 <= 15: b["punt_inside15"] += 1
            continue  # punt plays don't also fall into redzone bucketing

        # ---- Redzone aggregation (only run/pass) ----
        if not do_redzone or yl100 is None:
            continue
        yl = yl100  # reuse the top-of-loop parse
        bucket = rz_bucket
        if ptype == "run":
            rusher = row.get("rusher_player_id") or row.get("rusher_id")
            if not rusher:
                continue
            b = bucket(rusher, week)
            if b is None:
                continue
            if yl <= 20: b["rush_att_i20"] += 1
            if yl <= 10: b["rush_att_i10"] += 1
            if yl <= 5:  b["rush_att_i5"]  += 1
            if yl <= 20:
                yds = row.get("yards_gained") or 0
                try: b["rush_yds_i20"] += int(yds)
                except (ValueError, TypeError): pass
                if row.get("touchdown") in (1, True, "1"):
                    b["rush_tds_i20"] += 1

        elif ptype == "pass":
            passer = row.get("passer_player_id") or row.get("passer_id")
            receiver = row.get("receiver_player_id") or row.get("receiver_id")
            air_yards = row.get("air_yards")

            # End-zone target = pass with air_yards sufficient to reach end zone
            # (air_yards ≥ yl). Account for nullable.
            is_ez = False
            try:
                if air_yards is not None:
                    is_ez = int(air_yards) >= yl
            except (ValueError, TypeError):
                pass

            if passer:
                bp = bucket(passer, week)
                if bp is not None:
                    if yl <= 20:
                        bp["pass_att_i20"] += 1
                        if row.get("touchdown") in (1, True, "1") and row.get("td_team") == row.get("posteam"):
                            bp["pass_tds_i20"] += 1
                    if is_ez:
                        bp["pass_att_ez"] += 1

            if receiver:
                br = bucket(receiver, week)
                if br is not None:
                    if yl <= 20:
                        br["targets_i20"] += 1
                        if row.get("complete_pass") in (1, True, "1"):
                            br["rec_i20"] += 1
                            if row.get("touchdown") in (1, True, "1"):
                                br["rec_tds_i20"] += 1
                    if yl <= 10: br["targets_i10"] += 1
                    if yl <= 5:  br["targets_i5"]  += 1
                    if is_ez:    br["targets_ez"]  += 1

    counts = {"redzone": 0, "fg": 0, "punt": 0, "team": 0}

    # ---- Redzone upsert ----
    if do_redzone and rz_agg:
        rz_rows = []
        for (s, wk, gid), v in rz_agg.items():
            rz_rows.append((s, wk, gid, v["rush_att_i20"], v["rush_att_i10"], v["rush_att_i5"],
                            v["rush_yds_i20"], v["rush_tds_i20"],
                            v["targets_i20"], v["targets_i10"], v["targets_i5"],
                            v["targets_ez"], v["rec_i20"], v["rec_tds_i20"],
                            v["pass_att_i20"], v["pass_tds_i20"], v["pass_att_ez"]))
        db.executemany("""
            INSERT INTO nfl_player_redzone
                (season, week, gsis_id, rush_att_i20, rush_att_i10, rush_att_i5,
                 rush_yds_i20, rush_tds_i20,
                 targets_i20, targets_i10, targets_i5,
                 targets_ez, rec_i20, rec_tds_i20,
                 pass_att_i20, pass_tds_i20, pass_att_ez)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(season, week, gsis_id) DO UPDATE SET
              rush_att_i20 = excluded.rush_att_i20,
              rush_att_i10 = excluded.rush_att_i10,
              rush_att_i5  = excluded.rush_att_i5,
              rush_yds_i20 = excluded.rush_yds_i20,
              rush_tds_i20 = excluded.rush_tds_i20,
              targets_i20  = excluded.targets_i20,
              targets_i10  = excluded.targets_i10,
              targets_i5   = excluded.targets_i5,
              targets_ez   = excluded.targets_ez,
              rec_i20      = excluded.rec_i20,
              rec_tds_i20  = excluded.rec_tds_i20,
              pass_att_i20 = excluded.pass_att_i20,
              pass_tds_i20 = excluded.pass_tds_i20,
              pass_att_ez  = excluded.pass_att_ez
        """, rz_rows)
        counts["redzone"] = len(rz_rows)

    # ---- FG upsert (updates nfl_player_weekly — row must already exist via
    # fetch_nflverse_weekly.py; UPDATE leaves other columns alone) ----
    if do_fg and fg_agg:
        fg_rows = []
        for (s, wk, gid), v in fg_agg.items():
            fg_rows.append((
                v["fg_att_0_39"], v["fg_made_0_39"],
                v["fg_att_40_49"], v["fg_made_40_49"],
                v["fg_att_50_59"], v["fg_made_50_59"],
                v["fg_att_60plus"], v["fg_made_60plus"],
                v["fg_distance_sum_made"], v["fg_made_pbp"],
                s, wk, gid,
            ))
        db.executemany("""
            UPDATE nfl_player_weekly SET
              fg_att_0_39 = ?, fg_made_0_39 = ?,
              fg_att_40_49 = ?, fg_made_40_49 = ?,
              fg_att_50_59 = ?, fg_made_50_59 = ?,
              fg_att_60plus = ?, fg_made_60plus = ?,
              fg_distance_sum_made = ?, fg_made_pbp = ?
            WHERE season = ? AND week = ? AND gsis_id = ?
        """, fg_rows)
        counts["fg"] = db.total_changes  # approximate — we reset before each season
        # More accurate FG count: how many row updates had at least one attempt
        counts["fg"] = sum(1 for r in fg_rows if any(x > 0 for x in r[:8]))

    # ---- Punter upsert ----
    # Some punter-only weeks may have no existing row in nfl_player_weekly
    # (the weekly payload omits punters entirely). Use INSERT OR IGNORE of
    # a stub row first, then UPDATE, so punter data lands even when the
    # weekly fetcher never saw the player.
    if do_punts and pt_agg:
        # Stub inserts: minimal row keyed by (season, week, gsis_id). The stubs
        # have all NULL non-key fields, so the subsequent UPDATE sets punt
        # columns cleanly without stomping on anything real.
        stubs = [(s, wk, gid) for (s, wk, gid) in pt_agg.keys()]
        db.executemany("""
            INSERT OR IGNORE INTO nfl_player_weekly (season, week, gsis_id)
            VALUES (?, ?, ?)
        """, stubs)
        pt_rows = []
        for (s, wk, gid), v in pt_agg.items():
            pt_rows.append((
                v["punts"], v["punt_yds"], v["punt_long"],
                v["punt_inside20"], v["punt_tb"],
                v["punt_spot_sum"], v["punt_spot_count"],
                v["punt_net_yds_sum"],
                v["punt_inside5"], v["punt_inside10"], v["punt_inside15"],
                s, wk, gid,
            ))
        db.executemany("""
            UPDATE nfl_player_weekly SET
              punts = ?, punt_yds = ?, punt_long = ?,
              punt_inside20 = ?, punt_tb = ?,
              punt_spot_sum = ?, punt_spot_count = ?,
              punt_net_yds_sum = ?,
              punt_inside5 = ?, punt_inside10 = ?, punt_inside15 = ?
            WHERE season = ? AND week = ? AND gsis_id = ?
        """, pt_rows)
        counts["punt"] = len(pt_rows)

    # ---- Team-weekly upsert (nfl_team_weekly, migration 0016) ----
    if do_team and tw_agg:
        tw_rows = []
        for (s, wk, team), v in tw_agg.items():
            tw_rows.append((
                s, wk, team,
                v["fourth_down_total"], v["fourth_down_go"],
                v["fourth_down_punt"], v["fourth_down_fg"],
                v["stall_punts"], v["team_punts"],
            ))
        db.executemany("""
            INSERT INTO nfl_team_weekly
                (season, week, team, fourth_down_total, fourth_down_go,
                 fourth_down_punt, fourth_down_fg, stall_punts, team_punts)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(season, week, team) DO UPDATE SET
              fourth_down_total = excluded.fourth_down_total,
              fourth_down_go    = excluded.fourth_down_go,
              fourth_down_punt  = excluded.fourth_down_punt,
              fourth_down_fg    = excluded.fourth_down_fg,
              stall_punts       = excluded.stall_punts,
              team_punts        = excluded.team_punts
        """, tw_rows)
        counts["team"] = len(tw_rows)

    db.commit()
    print(f"  {season}: redzone={counts['redzone']} fg={counts['fg']} punt={counts['punt']} team={counts['team']}", file=sys.stderr)
    return counts


def ensure_weekly_columns(db: sqlite3.Connection) -> None:
    """Mirror of migrations 0015 + 0016 for standalone runs on fresh local DBs."""
    for stmt in [
        "ALTER TABLE nfl_player_weekly ADD COLUMN fg_att_50_59 INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN fg_made_50_59 INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN fg_att_60plus INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN fg_made_60plus INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN punt_tb INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN punt_spot_sum INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN punt_spot_count INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN punt_net_yds_sum INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN punt_inside5 INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN punt_inside10 INTEGER",
        "ALTER TABLE nfl_player_weekly ADD COLUMN punt_inside15 INTEGER",
    ]:
        try:
            db.execute(stmt)
        except sqlite3.OperationalError:
            pass  # column already exists
    db.execute("""
        CREATE TABLE IF NOT EXISTS nfl_team_weekly (
          season            INTEGER NOT NULL,
          week              INTEGER NOT NULL,
          team              TEXT    NOT NULL,
          fourth_down_total INTEGER,
          fourth_down_go    INTEGER,
          fourth_down_punt  INTEGER,
          fourth_down_fg    INTEGER,
          stall_punts       INTEGER,
          team_punts        INTEGER,
          PRIMARY KEY (season, week, team)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_team_weekly_team ON nfl_team_weekly (team, season)")
    db.commit()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2011-2025")
    ap.add_argument("--skip-redzone", action="store_true",
                    help="Skip redzone band aggregator (nfl_player_redzone)")
    ap.add_argument("--skip-fg", action="store_true",
                    help="Skip FG distance buckets (nfl_player_weekly)")
    ap.add_argument("--skip-punts", action="store_true",
                    help="Skip punter volume/distance (nfl_player_weekly)")
    ap.add_argument("--skip-team", action="store_true",
                    help="Skip team-level 4th-down + stall-punt (nfl_team_weekly)")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}\n"
                 f"(set MFL_DB_PATH env var if DB lives elsewhere)")
    print(f"DB: {LOCAL_DB}", file=sys.stderr)
    db = sqlite3.connect(str(LOCAL_DB))
    ensure_table(db)
    ensure_weekly_columns(db)

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)

    totals = {"redzone": 0, "fg": 0, "punt": 0, "team": 0}
    for s in seasons:
        c = process_season(
            db, s,
            do_redzone=not args.skip_redzone,
            do_fg=not args.skip_fg,
            do_punts=not args.skip_punts,
            do_team=not args.skip_team,
        )
        for k in totals: totals[k] += c.get(k, 0)
    print(f"DONE: redzone={totals['redzone']} fg={totals['fg']} punt={totals['punt']} "
          f"team={totals['team']} rows across {len(seasons)} seasons", file=sys.stderr)


if __name__ == "__main__":
    main()
