#!/usr/bin/env python3
"""Rules of pipelines/etl/lib/pbp_derived.py (migration 0182) on hand-built plays.

    python3 pipelines/etl/scripts/test_pbp_derived.py

No network, no D1: the pure functions get dict rows; the job-level check
replaces nflreadpy.load_pbp and writes to an in-memory SQLite with --skip-d1.
"""
import argparse
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))

from lib import pbp_derived as D  # noqa: E402

NAN = float("nan")
fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"   got {got!r}, want {want!r}"))


def approx(a, b, tol=1e-9):
    return a is not None and b is not None and abs(a - b) <= tol


# ── PROE ─────────────────────────────────────────────────────────────────────
neutral = dict(season_type="REG", week=1, posteam="AAA", two_point_attempt=0, wp=0.5, down=1, qtr=1,
               half_seconds_remaining=900, score_differential=0)


def play(pt, p, xp, **kw):
    r = {**neutral, "play_type": pt, "pass": p, "xpass": xp, "pass_oe": None if xp is None else 100 * (p - xp)}
    r.update(kw)
    return r


PROE_PLAYS = [
    play("pass", 1, 0.6),                                   # neutral dropback
    play("run", 0, 0.3),                                    # neutral run
    play("no_play", 1, 0.5),                                # penalty-nullified: never counted
    play("pass", 1, 0.9, two_point_attempt=1),              # two-point try: never counted
    play("qb_kneel", 0, 0.1),                               # kneel: never counted
    play("pass", 1, None),                                  # no xpass: never counted
    play("pass", 1, 0.5, wp=0.95),                          # all only (wp outside 0.2-0.8)
    play("run", 0, 0.4, down=3),                            # all, neutral_a (not b, not c)
    play("pass", 1, 0.7, half_seconds_remaining=100),       # all, neutral_c (not a/b: under 2:00 in the half)
    play("run", 0, 0.2, qtr=4),                             # all, a, b (not c: 4th quarter)
    play("pass", 1, 0.5, score_differential=-10),           # all, a, b (not c: margin 10)
    play("run", 0, 0.5, week=2),                            # week 2, all filters
    play("pass", 1, 0.5, posteam=NAN),                      # no team: never counted
]
agg = D.proe_team_week(PROE_PLAYS, 2026)
w1 = {f: agg.get((2026, f, 1, "AAA")) for f in D.PROE_FILTERS}
check("PROE plays per filter (week 1)", {f: (v or {}).get("plays") for f, v in w1.items()},
      {"all": 7, "neutral_a": 5, "neutral_b": 4, "neutral_c": 3})
check("dropbacks counted from `pass` (all, week 1)", w1["all"]["dropbacks"], 4)
check("xpass sum (all, week 1)", approx(w1["all"]["xpass_sum"], 0.6 + 0.3 + 0.5 + 0.4 + 0.7 + 0.2 + 0.5), True)
check("pass_oe_sum == 100 * (dropbacks - xpass_sum)",
      approx(w1["all"]["pass_oe_sum"], 100 * (w1["all"]["dropbacks"] - w1["all"]["xpass_sum"]), 1e-3), True)
check("no team / no_play / 2-pt / kneel / no-xpass rows form no key", sorted({k[3] for k in agg}), ["AAA"])
# play-weighted over weeks 1-2: (sum pass_oe) / plays, not the mean of the weekly values
rows12 = [agg[(2026, "all", 1, "AAA")], agg[(2026, "all", 2, "AAA")]]
pw = D.proe_from_sums(rows12)
gw = (D.proe_from_sums(rows12[:1]) + D.proe_from_sums(rows12[1:])) / 2
check("season PROE is play-weighted", approx(pw, (w1["all"]["pass_oe_sum"] - 50) / 8, 1e-6), True)
check("...and differs from the game-weighted mean here", approx(pw, gw, 1e-6), False)
check("no plays -> None, not 0", D.proe_from_sums([]), None)
check("stored row carries the definition version", D.proe_rows(agg)[0][-1], D.PROE_DEF_VERSION)

# ── Punt end distance and bands ──────────────────────────────────────────────
check("end = yl100 - kick + return", D.punt_end_distance({"yardline_100": 58, "kick_distance": 48, "return_yards": 3}), 13.0)
check("missing return yards = no return", D.punt_end_distance({"yardline_100": 58, "kick_distance": 48, "return_yards": NAN}), 10.0)
check("no kick distance -> unknown", D.punt_end_distance({"yardline_100": 58, "kick_distance": NAN}), None)
check("return past the line of scrimmage is not clamped",
      D.punt_end_distance({"yardline_100": 15, "kick_distance": 10, "return_yards": 30}), 35.0)
check("band boundaries", [D.punt_band(e) for e in (-1, 0, 1, 4, 5, 9, 10, 19, 20, None)],
      [None, None, "punt_i20_lt5", "punt_i20_lt5", "punt_i20_5to10", "punt_i20_5to10",
       "punt_i20_10to20", "punt_i20_10to20", None, None])

# ── Player-week columns ──────────────────────────────────────────────────────
base = dict(season_type="REG", week=1, posteam="AAA", two_point_attempt=0)
P = [
    # rushing: max, negative values, kneels count, two-point does not
    {**base, "play_type": "run", "rush_attempt": 1, "rusher_player_id": "RB1", "rushing_yards": -2},
    {**base, "play_type": "run", "rush_attempt": 1, "rusher_player_id": "RB1", "rushing_yards": 7},
    {**base, "play_type": "run", "rush_attempt": 1, "rusher_player_id": "RB1", "rushing_yards": 30, "two_point_attempt": 1},
    {**base, "play_type": "qb_kneel", "rush_attempt": 1, "rusher_player_id": "QB1", "rushing_yards": -1},
    {**base, "play_type": "no_play", "rush_attempt": 0, "rusher_player_id": "RB2", "rushing_yards": 50},
    # receiving / passing; a lateral's yards are not the lateral receiver's reception
    {**base, "play_type": "pass", "complete_pass": 1, "passer_player_id": "QB1", "receiver_player_id": "WR1",
     "receiving_yards": 12, "passing_yards": 12},
    {**base, "play_type": "pass", "complete_pass": 1, "passer_player_id": "QB1", "receiver_player_id": "WR1",
     "receiving_yards": 2, "passing_yards": 16, "lateral_receiver_player_id": "WR2", "lateral_receiving_yards": 14},
    {**base, "play_type": "pass", "complete_pass": 0, "passer_player_id": "QB1", "receiver_player_id": "WR2"},
    # sacks: lost to the defense, recovered by his own team, no fumble
    {**base, "play_type": "pass", "sack": 1, "passer_player_id": "QB1", "fumbled_1_player_id": "QB1",
     "fumble_lost": 1, "fumble_recovery_1_team": "BBB"},
    {**base, "play_type": "pass", "sack": 1, "passer_player_id": "QB1", "fumbled_1_player_id": "QB1",
     "fumble_lost": 0, "fumble_recovery_1_team": "AAA"},
    {**base, "play_type": "pass", "sack": 1, "passer_player_id": "QB2", "fumbled_1_player_id": NAN},
    # field goals
    {**base, "play_type": "field_goal", "kicker_player_id": "K1", "field_goal_result": "missed", "kick_distance": 40},
    {**base, "play_type": "field_goal", "kicker_player_id": "K1", "field_goal_result": "blocked", "kick_distance": 33},
    {**base, "play_type": "field_goal", "kicker_player_id": "K1", "field_goal_result": "made", "kick_distance": 50},
    {**base, "play_type": "field_goal", "kicker_player_id": "K1", "field_goal_result": "missed", "kick_distance": 52},
    {**base, "play_type": "field_goal", "kicker_player_id": "K2", "field_goal_result": "made", "kick_distance": 25},
    {**base, "play_type": "field_goal", "kicker_player_id": "K3", "field_goal_result": "missed", "kick_distance": NAN},
    # punts: P1 has one punt per band, a touchback, a ball at the 20 and a block
    {**base, "play_type": "punt", "punter_player_id": "P1", "yardline_100": 60, "kick_distance": 57, "return_yards": 0, "punt_inside_twenty": 1},
    {**base, "play_type": "punt", "punter_player_id": "P1", "yardline_100": 60, "kick_distance": 53, "return_yards": 0, "punt_inside_twenty": 1},
    {**base, "play_type": "punt", "punter_player_id": "P1", "yardline_100": 60, "kick_distance": 50, "return_yards": 9, "punt_inside_twenty": 1},
    {**base, "play_type": "punt", "punter_player_id": "P1", "yardline_100": 60, "kick_distance": 60, "return_yards": 0, "punt_inside_twenty": 0, "touchback": 1},
    {**base, "play_type": "punt", "punter_player_id": "P1", "yardline_100": 60, "kick_distance": 40, "return_yards": 0, "punt_inside_twenty": 0},
    {**base, "play_type": "punt", "punter_player_id": "P1", "yardline_100": 70, "kick_distance": 0, "return_yards": 0, "punt_inside_twenty": 0, "punt_blocked": 1},
    # P2: the flag says inside-20 but the end spot says 25 -> bands withheld
    {**base, "play_type": "punt", "punter_player_id": "P2", "yardline_100": 60, "kick_distance": 35, "return_yards": 0, "punt_inside_twenty": 1},
]
warns = []
E = D.player_week_ext(P, 2026, warn=warns.append)
g = lambda pid, c: E.get((2026, 1, pid), {}).get(c)  # noqa: E731
check("rush long = max carry, two-point and no_play excluded", g("RB1", "rush_long_pbp"), 7)
check("a kneel is a carry (negative long)", g("QB1", "rush_long_pbp"), -1)
check("no_play carrier gets no row", (2026, 1, "RB2") in E, False)
check("rec long from his receptions only", g("WR1", "rec_long_pbp"), 12)
check("lateral receiver: no reception, no rec long", g("WR2", "rec_long_pbp"), None)
check("pass long = longest completion", g("QB1", "pass_long_pbp"), 16)
check("sack fumbles / lost (lost only when the defense recovers)", (g("QB1", "sack_fumbles"), g("QB1", "sack_fumbles_lost")), (2, 1))
check("sacked, no fumble: measured zero", (g("QB2", "sack_fumbles"), g("QB2", "sack_fumbles_lost")), (0, 0))
check("never sacked: not applicable (NULL)", g("RB1", "sack_fumbles"), None)
check("missed / blocked FG distances in play order", (g("K1", "fg_missed_dists"), g("K1", "fg_blocked_dists")), ("40;52", "33"))
check("kicker with no misses: '' (applies, none)", (g("K2", "fg_missed_dists"), g("K2", "fg_blocked_dists")), ("", ""))
check("a miss without a distance withholds the lists", (g("K3", "fg_missed_dists"), g("K3", "fg_blocked_dists")), (None, None))
check("non-kicker: NULL", g("RB1", "fg_missed_dists"), None)
check("P1 bands lt5 / 5to10 / 10to20", (g("P1", "punt_i20_lt5"), g("P1", "punt_i20_5to10"), g("P1", "punt_i20_10to20")), (1, 1, 1))
check("P1 blocked punts", g("P1", "punts_blocked"), 1)
check("P2 bands withheld when they disagree with the official flag",
      (g("P2", "punt_i20_lt5"), g("P2", "punt_i20_5to10"), g("P2", "punt_i20_10to20"), g("P2", "punts_blocked")), (None, None, None, 0))
check("warnings name the withheld rows", sorted(re.sub(r" .*", "", w) for w in warns), ["fg", "inside-20"])
check("ext_row order follows EXT_COLS", D.ext_row((2026, 1, "K2"), E[(2026, 1, "K2")]),
      (2026, 1, "K2", *[E[(2026, 1, "K2")].get(c) for c in D.EXT_COLS]))

# ── Migration 0182 matches the writers ───────────────────────────────────────
mig = (ROOT / "worker" / "migrations" / "0182_pbp_team_proe_and_player_ext.sql").read_text()
m = sqlite3.connect(":memory:")
m.execute("CREATE TABLE nfl_player_weekly_ext (season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL,"
          " PRIMARY KEY (season, week, gsis_id))")
m.executescript(mig)
ext_cols = [r[1] for r in m.execute("PRAGMA table_info(nfl_player_weekly_ext)")]
check("migration adds every PBP ext column + rec_yac", sorted(set(D.EXT_COLS + ["rec_yac"]) - set(ext_cols)), [])
proe_info = {r[1]: r[5] for r in m.execute("PRAGMA table_info(nfl_team_proe_weekly)")}
check("PROE table columns = writer columns (+updated_at)", sorted(proe_info), sorted(D.PROE_COLS + ["updated_at"]))
check("PROE primary key order (season, filter, week, team)",
      [c for c, pk in sorted(proe_info.items(), key=lambda kv: kv[1]) if pk], ["season", "filter", "week", "team"])

# ── Weekly fetcher maps rec_yac into _ext ────────────────────────────────────
import fetch_nflverse_weekly as W  # noqa: E402
check("rec_yac routed to _ext", "rec_yac" in W.EXT_COLS, True)
check("rec_yac source column", W.PLAYERSTATS_MAP.get("rec_yac"), ["receiving_yards_after_catch"])

# ── Job level: process_season writes both tables, touches nothing else ───────
import pandas as pd  # noqa: E402
import nflreadpy  # noqa: E402
frame = pd.DataFrame([{**r, "season": 2026} for r in PROE_PLAYS + P])
nflreadpy.load_pbp = lambda seasons=None: frame.copy()
import fetch_nflverse_pbp as F  # noqa: E402
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE nfl_player_weekly_ext (season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL,"
           " pass_first_downs INTEGER, PRIMARY KEY (season, week, gsis_id))")
db.execute("INSERT INTO nfl_player_weekly_ext (season, week, gsis_id, pass_first_downs) VALUES (2026, 1, 'QB1', 9)")
c = F.process_season(db, 2026, argparse.Namespace(skip_d1=True, skip_local=False),
                     do_redzone=False, do_fg=False, do_punts=False, do_team=False)
check("job counts", (c.get("proe"), c.get("pbp_ext")), (len(agg), len(E)))
check("job PROE row = pure function", db.execute(
    "SELECT plays, dropbacks FROM nfl_team_proe_weekly WHERE season=2026 AND filter='all' AND week=1 AND team='AAA'").fetchone(),
    (7, 4))
check("weekly fetcher's _ext column untouched", db.execute(
    "SELECT pass_first_downs, pass_long_pbp, sack_fumbles_lost FROM nfl_player_weekly_ext WHERE gsis_id='QB1'").fetchone(), (9, 16, 1))
check("withheld bands stored as NULL", db.execute(
    "SELECT punt_i20_lt5, punts_blocked FROM nfl_player_weekly_ext WHERE gsis_id='P2'").fetchone(), (None, 0))
# A re-run with identical data changes nothing (the D1 path skips unchanged rows; locally, same values).
before = db.execute("SELECT * FROM nfl_team_proe_weekly ORDER BY 1,2,3,4").fetchall()
F.process_season(db, 2026, argparse.Namespace(skip_d1=True, skip_local=False),
                 do_redzone=False, do_fg=False, do_punts=False, do_team=False)
after = db.execute("SELECT * FROM nfl_team_proe_weekly ORDER BY 1,2,3,4").fetchall()
check("re-run produces byte-identical PROE rows", [r[:9] for r in after] == [r[:9] for r in before], True)

print(f"\n{'FAILED' if fails else 'PASSED'}: {fails} failure(s)")
sys.exit(1 if fails else 0)
