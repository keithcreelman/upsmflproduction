#!/usr/bin/env python3
"""UPDATE-ONLY D1 writes: an augmenting writer never creates a row (#1503 D1, 2026-11-23).

fetch_pfr_advstats.py pushed its PFR columns to D1 with an upsert, so a PFR player-week with no
nflverse row was INSERTED into nfl_player_weekly with no team, opponent or position, and `source`
defaulted to 'nflverse'. The local path was always UPDATE-only. This runs the real generated SQL on
SQLite with D1's expression-depth limit (100) and counts rows with total_changes().

Proves:
  1. update_only updates existing rows (COALESCE keeps a value when the batch has NULL) and never
     inserts a row whose key is absent;
  2. unchanged existing rows still write 0 rows (the changed-only rule survives);
  3. a 100-column table builds and runs within the depth limit;
  4. update_only without a key or without update columns refuses instead of falling back to INSERT;
  5. the default (update_only=False) still inserts, so other writers are unchanged;
  6. fetch_pfr_advstats.py sends nfl_player_weekly update-only and keeps nfl_player_weekly_ext as an
     upsert (a sparse table it fills itself).

Offline: no D1, no wrangler, no network.
  python3 pipelines/etl/scripts/test_d1_io_update_only.py
"""
import importlib.util
import sqlite3
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from lib import d1_io  # noqa: E402
from lib.d1_io import build_insert  # noqa: E402

D1_EXPR_DEPTH = 100

SCHEMA = """
CREATE TABLE nfl_player_weekly (
  season INTEGER, week INTEGER, gsis_id TEXT,
  team TEXT, opponent TEXT, position TEXT,
  def_missed_tackles INTEGER, def_pressures INTEGER,
  source TEXT DEFAULT 'nflverse',
  PRIMARY KEY (season, week, gsis_id)
);
INSERT INTO nfl_player_weekly (season, week, gsis_id, team, opponent, position, def_missed_tackles, def_pressures)
VALUES (2026, 10, 'A', 'BUF', 'MIA', 'LB', 1, 2),
       (2026, 10, 'B', 'KC',  'DEN', 'DB', NULL, NULL);
"""
COLS = ["season", "week", "gsis_id", "def_missed_tackles", "def_pressures"]
PK = ["season", "week", "gsis_id"]
AUG = ["def_missed_tackles", "def_pressures"]


def db(schema: str = SCHEMA) -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, D1_EXPR_DEPTH)
    c.executescript(schema)
    return c


def run(c, sql) -> int:
    before = c.total_changes
    c.executescript(sql)
    return c.total_changes - before


class UpdateOnly(unittest.TestCase):
    def test_updates_existing_never_inserts(self):
        c = db()
        rows = [(2026, 10, "A", 3, None),    # exists: missed tackles 1 -> 3, pressures NULL keeps 2
                (2026, 10, "B", 4, 5),       # exists with NULLs: fill
                (2026, 10, "Z", 9, 9)]       # no nflverse row: must NOT appear
        sql = build_insert("nfl_player_weekly", COLS, rows, pk_cols=PK, coalesce_cols=AUG, update_only=True)
        written = run(c, sql)
        self.assertEqual(written, 2)
        got = {r[0]: r[1:] for r in c.execute(
            "SELECT gsis_id, team, def_missed_tackles, def_pressures FROM nfl_player_weekly ORDER BY gsis_id")}
        self.assertEqual(set(got), {"A", "B"}, "a key with no existing row was inserted")
        self.assertEqual(got["A"], ("BUF", 3, 2))
        self.assertEqual(got["B"], ("KC", 4, 5))

    def test_unchanged_rows_write_nothing(self):
        c = db()
        sql = build_insert("nfl_player_weekly", COLS, [(2026, 10, "A", 1, 2), (2026, 10, "Z", 1, 1)],
                           pk_cols=PK, coalesce_cols=AUG, update_only=True)
        self.assertEqual(run(c, sql), 0)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM nfl_player_weekly").fetchone()[0], 2)

    def test_wide_table_within_depth_limit(self):
        extra = [f"c{i}" for i in range(97)]                    # 3 key + 97 = 100 columns
        schema = ("CREATE TABLE w (season INTEGER, week INTEGER, gsis_id TEXT, "
                  + ", ".join(f"{x} INTEGER" for x in extra) + ", PRIMARY KEY (season, week, gsis_id));"
                  "INSERT INTO w (season, week, gsis_id) VALUES (2026, 1, 'A');")
        c = db(schema)
        cols = ["season", "week", "gsis_id"] + extra
        rows = [tuple([2026, 1, "A"] + list(range(97))), tuple([2026, 1, "NEW"] + list(range(97)))]
        sql = build_insert("w", cols, rows, pk_cols=PK, coalesce_cols=extra, update_only=True)
        self.assertEqual(run(c, sql), 1)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM w").fetchone()[0], 1)

    def test_refuses_without_key_or_update_columns(self):
        with self.assertRaises(ValueError):
            build_insert("nfl_player_weekly", COLS, [(2026, 10, "A", 1, 2)], update_only=True)
        with self.assertRaises(ValueError):
            build_insert("nfl_player_weekly", PK, [(2026, 10, "A")], pk_cols=PK, update_only=True)

    def test_default_still_inserts(self):
        c = db()
        sql = build_insert("nfl_player_weekly", COLS, [(2026, 10, "Z", 9, 9)], pk_cols=PK, coalesce_cols=AUG)
        self.assertEqual(run(c, sql), 1)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM nfl_player_weekly").fetchone()[0], 3)


class FetcherWiring(unittest.TestCase):
    def test_pfr_sends_weekly_update_only_and_ext_as_upsert(self):
        spec = importlib.util.spec_from_file_location("fetch_pfr_advstats", HERE / "fetch_pfr_advstats.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        seen = {}

        class Capture:
            def __init__(self, table, cols, pk_cols=None, coalesce_cols=None, update_only=False, **kw):
                seen[table] = {"update_only": update_only, "cols": cols}

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def add(self, r):
                pass

        mod.D1Writer = Capture
        mod._dual_write_d1("nfl_player_weekly", PK, AUG, [(1, 2, 2026, 10, "A")], skip_d1=False, label="t")
        mod._dual_write_d1("nfl_player_weekly_ext", PK, ["def_targets"], [(3, 2026, 10, "A")], skip_d1=False,
                           label="t")
        self.assertTrue(seen["nfl_player_weekly"]["update_only"])
        self.assertFalse(seen["nfl_player_weekly_ext"]["update_only"])
        self.assertEqual(seen["nfl_player_weekly"]["cols"], PK + AUG)


if __name__ == "__main__":
    unittest.main(verbosity=2)
