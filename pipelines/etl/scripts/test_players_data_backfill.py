#!/usr/bin/env python3
"""The backfill's swap and rollback SQL, run in SQLite transactions (no D1).

    python3 pipelines/etl/scripts/test_players_data_backfill.py

D1 runs an import file as one transaction; here each generated file runs
inside BEGIN … COMMIT and is rolled back on any error, the same contract.
Checks: the swap replaces exactly the season and leaves others; a failed
guard (stale snapshot, changed staging, empty season) changes nothing; the
rollback restores the snapshot, refuses when live moved on after the swap
(unless forced), and puts back only nfl_team_weekly's red-zone columns.
"""
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import players_data_backfill as B  # noqa: E402

fails = 0
def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"   got {got!r}, want {want!r}"))

def run_file(db, sql):
    """One transaction, like a D1 import: all or nothing."""
    db.execute("BEGIN")
    try:
        for stmt in [x for x in sql.split(";\n") if x.strip()]:
            db.execute(stmt.rstrip(";"))
        db.execute("COMMIT"); return None
    except sqlite3.Error as e:
        db.execute("ROLLBACK"); return str(e)

RZ = ", ".join(f"{c} INTEGER" for c in B.RZ_PLAYER_COLS)
TW = ", ".join(f"{c} INTEGER" for c in B.RZ_TEAM_COLS)
EPA = ", ".join(f"{c} {'INTEGER' if c.endswith(('_plays', '_n', '_tgt', 'week')) else 'REAL'}" for c in B.EPA_COLS)
DDL = {"nfl_player_redzone": f"(season INTEGER, week INTEGER, gsis_id TEXT, {RZ}, PRIMARY KEY (season, week, gsis_id))",
       "nfl_team_weekly": f"(season INTEGER, week INTEGER, team TEXT, fourth_down_total INTEGER, team_punts INTEGER, {TW}, PRIMARY KEY (season, week, team))",
       "nfl_player_epa": f"(season INTEGER, gsis_id TEXT, {EPA}, updated_at TEXT, PRIMARY KEY (season, gsis_id))"}

def fresh():
    db = sqlite3.connect(":memory:", isolation_level=None)
    for t, d in DDL.items():
        db.execute(f"CREATE TABLE {t} {d}")
    z = lambda n: ", ".join(["0"] * n)  # noqa: E731
    # live 2026: old rows (completions/sacks unknown), plus a 2025 row the swap must not touch
    for season, w, g in ((2026, 1, "00-A"), (2026, 1, "nan"), (2026, 2, "00-A"), (2025, 1, "00-A")):
        db.execute(f"INSERT INTO nfl_player_redzone VALUES ({season}, {w}, '{g}', {', '.join(['1'] * 14)}, NULL, NULL)")
    for w in (1, 2):
        db.execute(f"INSERT INTO nfl_team_weekly VALUES (2026, {w}, 'AAA', 5, 4, {', '.join(['NULL'] * len(B.RZ_TEAM_COLS))})")
    db.execute(f"INSERT INTO nfl_player_epa VALUES (2026, '00-A', 10, 1.5, 0, 0, 5, {z(6)}, NULL, 'old')")
    n = B.names("tag1")
    db.execute(f"CREATE TABLE {n['guard']} (ok INTEGER CHECK (ok = 1))")
    db.execute(f"CREATE TABLE {n['meta']} (k TEXT PRIMARY KEY, v TEXT)")
    for k, (t, key, cols) in B.TABLES.items():
        db.execute(f"CREATE TABLE {n[k]['bk']} AS SELECT * FROM {t} WHERE season = 2026")
        db.execute(f"CREATE TABLE {n[k]['stg']} {DDL[t]}")
    # staged: new rules (nan row gone, completions/sacks known, Wk 3 added); team red zone for both games + a new Wk 3 row
    for w, g in ((1, "00-A"), (2, "00-A"), (3, "00-B")):
        db.execute(f"INSERT INTO {n['rz']['stg']} VALUES (2026, {w}, '{g}', {', '.join(['2'] * 16)})")
    for w in (1, 2, 3):
        db.execute(f"INSERT INTO {n['tw']['stg']} (season, week, team, {', '.join(B.RZ_TEAM_COLS)}) VALUES (2026, {w}, 'AAA', {', '.join(['3'] * len(B.RZ_TEAM_COLS))})")
    db.execute(f"INSERT INTO {n['epa']['stg']} VALUES (2026, '00-A', 11, 1.25, 0, 0, 6, {z(6)}, 4, NULL)")
    rep = {"season": 2026, "snapshot": {}, "staged": {}}
    for k, (t, key, cols) in B.TABLES.items():
        rep["snapshot"][k] = {"fp": db.execute(B.fp_sql(n[k]["bk"], 2026, key, cols)).fetchone()[0],
                              "all_columns": [r[1] for r in db.execute(f"PRAGMA table_info({n[k]['bk']})")]}
        rep["staged"][k] = {"fp": db.execute(B.fp_sql(n[k]["stg"], 2026, key, cols)).fetchone()[0]}
    cols = {k: [r[1] for r in db.execute(f"PRAGMA table_info({t})")] for k, (t, _, _) in B.TABLES.items()}
    return db, n, rep, cols

rows = lambda db, sql: db.execute(sql).fetchall()  # noqa: E731

db, n, rep, cols = fresh()
before = rows(db, "SELECT * FROM nfl_player_redzone ORDER BY season, week, gsis_id")
err = run_file(db, B.swap_sql(n, 2026, rep, cols) + f";\nINSERT INTO {n['meta']} (k, v) VALUES ('x', 'a');\nINSERT INTO {n['meta']} (k, v) VALUES ('x', 'b');")
check("a failure AFTER every write rolls the whole file back", (bool(err and "UNIQUE" in err), rows(db, "SELECT * FROM nfl_player_redzone ORDER BY season, week, gsis_id") == before), (True, True))

err = run_file(db, B.swap_sql(n, 2026, rep, cols))
check("swap commits", err, None)
check("2026 red zone now equals stage; 2025 untouched", rows(db, "SELECT season, week, gsis_id, pass_cmp_i20 FROM nfl_player_redzone ORDER BY season, week, gsis_id"),
      [(2025, 1, "00-A", None), (2026, 1, "00-A", 2), (2026, 2, "00-A", 2), (2026, 3, "00-B", 2)])
check("team red-zone columns filled, 4th-down columns kept, new team-game added", rows(db, "SELECT week, fourth_down_total, rz_pass_att FROM nfl_team_weekly ORDER BY week"),
      [(1, 5, 3), (2, 5, 3), (3, None, 3)])
check("EPA replaced", rows(db, "SELECT pass_plays, through_week FROM nfl_player_epa"), [(11, 4)])

err = run_file(db, B.swap_sql(n, 2026, rep, cols))
check("a second swap is refused: live no longer matches the snapshot", bool(err and "CHECK" in err), True)

# a refresh writes after the swap -> rollback refuses unless forced
db.execute("UPDATE nfl_player_redzone SET targets_i20 = 9 WHERE season = 2026 AND week = 3")
err = run_file(db, B.rollback_sql(n, 2026, rep, cols))
check("rollback refuses when live moved on after the swap", bool(err and "CHECK" in err), True)
db.execute("UPDATE nfl_player_redzone SET targets_i20 = 2 WHERE season = 2026 AND week = 3")
db.execute("UPDATE nfl_team_weekly SET fourth_down_total = 7 WHERE week = 2")   # a later 4th-down refresh: not ours
err = run_file(db, B.rollback_sql(n, 2026, rep, cols))
check("rollback commits", err, None)
check("red zone + EPA restored exactly", (rows(db, "SELECT * FROM nfl_player_redzone ORDER BY season, week, gsis_id") == before,
                                          rows(db, "SELECT pass_plays, updated_at FROM nfl_player_epa")), (True, [(10, "old")]))
check("team weekly: red-zone columns back to NULL, the added Wk 3 row gone, the later 4th-down value KEPT",
      rows(db, "SELECT week, fourth_down_total, rz_pass_att FROM nfl_team_weekly ORDER BY week"), [(1, 5, None), (2, 7, None)])

# empty / NULL safety: a staged set that changed after validation is refused
db, n, rep, cols = fresh()
db.execute(f"DELETE FROM {n['rz']['stg']}")
err = run_file(db, B.swap_sql(n, 2026, rep, cols))
check("staging emptied after validation: refused, nothing changed", (bool(err and "CHECK" in err), len(rows(db, "SELECT * FROM nfl_player_redzone"))), (True, 4))
check("an empty season fingerprints as zeros, never NULL", db.execute(B.fp_sql("nfl_player_redzone", 2030, ["season", "week", "gsis_id"], B.RZ_PLAYER_COLS)).fetchone()[0] is not None, True)
check("a NULL guard condition fails", run_file(db, B.guard(n, "NULL")) is not None, True)
check("tag must be ASCII", (lambda: (B.names("ok_1"), "ok"))()[1], "ok")
try:
    B.names("bad-tag; DROP"); check("bad tag refused", False, True)
except SystemExit:
    check("bad tag refused", True, True)

print(f"\n{'FAILED ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
