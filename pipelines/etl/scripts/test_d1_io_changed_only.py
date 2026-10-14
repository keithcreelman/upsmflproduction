#!/usr/bin/env python3
"""D1Writer upserts write only rows whose values changed (Keith 2026-10-13).

D1 bills every row an UPSERT updates as written, even when nothing changed, and
the nflverse refresh re-sends ~138k mostly unchanged rows 4x a week (about 90%
of a day's writes on 2026-10-13). build_insert now adds `WHERE <some value
differs>` to `DO UPDATE`. This runs the real generated SQL on SQLite with D1's
expression-depth limit (100) and counts rows written with total_changes().

Offline: no D1, no network.
  python3 pipelines/etl/scripts/test_d1_io_changed_only.py
"""
import os
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import build_insert  # noqa: E402

D1_EXPR_DEPTH = 100


def db(schema: str) -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, D1_EXPR_DEPTH)
    c.executescript(schema)
    return c


def run(c, sql) -> int:
    """Execute a generated statement; return rows written by it."""
    before = c.total_changes
    c.executescript(sql)
    return c.total_changes - before


SCHEMA = """
CREATE TABLE t (season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, rank INTEGER,
                score REAL, note TEXT, air REAL, built_at TEXT,
                PRIMARY KEY (season, week, gsis_id));
CREATE INDEX t_team ON t(team);
CREATE INDEX t_rank ON t(season, rank);
"""
COLS = ["season", "week", "gsis_id", "team", "rank", "score", "note", "air", "built_at"]
PK = ["season", "week", "gsis_id"]


def rows(n, team="BUF", score=1.5, note="x", air=7.25, built="2026-10-13T00:00Z"):
    return [(2025, w, f"00-{i:07d}", team, i, score + i, note, air, built)
            for i in range(n) for w in (1,)]


class ChangedOnly(unittest.TestCase):
    def setUp(self):
        os.environ.pop("D1WRITER_ALWAYS_UPDATE", None)

    def sql(self, rs, **kw):
        return build_insert("t", COLS, rs, pk_cols=PK, coalesce_cols=["air"], change_ignore_cols=["built_at"], **kw)

    def test_identical_rerun_writes_nothing(self):
        c = db(SCHEMA)
        self.assertEqual(run(c, self.sql(rows(200))), 200)
        self.assertEqual(run(c, self.sql(rows(200))), 0, "an identical re-send must write 0 rows")

    def test_old_behaviour_rewrote_everything(self):
        c = db(SCHEMA)
        run(c, self.sql(rows(200)))
        self.assertEqual(run(c, self.sql(rows(200), changed_only=False)), 200)
        os.environ["D1WRITER_ALWAYS_UPDATE"] = "1"
        try:
            self.assertEqual(run(c, self.sql(rows(200))), 200, "rollback switch restores the old behaviour")
        finally:
            os.environ.pop("D1WRITER_ALWAYS_UPDATE", None)

    def test_changed_rows_update_and_new_rows_insert(self):
        c = db(SCHEMA)
        run(c, self.sql(rows(100)))
        rs = rows(100)
        rs[3] = rs[3][:5] + (99.0,) + rs[3][6:]                 # score changed
        rs[7] = rs[7][:3] + ("MIA",) + rs[7][4:]                # team (indexed) changed
        rs.append((2025, 1, "00-9999999", "NYJ", 1, 2.0, "new", None, "z"))  # new row
        self.assertEqual(run(c, self.sql(rs)), 3)
        self.assertEqual(c.execute("SELECT score FROM t WHERE gsis_id='00-0000003'").fetchone()[0], 99.0)
        self.assertEqual(c.execute("SELECT team FROM t WHERE gsis_id='00-0000007'").fetchone()[0], "MIA")
        self.assertEqual(c.execute("SELECT COUNT(*) FROM t").fetchone()[0], 101)

    def test_nulls(self):
        c = db(SCHEMA)
        run(c, self.sql(rows(10)))
        rs = rows(10)
        rs[0] = rs[0][:6] + (None,) + rs[0][7:]                 # note -> NULL is a change
        rs[1] = rs[1][:7] + (None,) + rs[1][8:]                 # air (coalesce) NULL keeps value: not a change
        self.assertEqual(run(c, self.sql(rs)), 1)
        self.assertIsNone(c.execute("SELECT note FROM t WHERE gsis_id='00-0000000'").fetchone()[0])
        self.assertEqual(c.execute("SELECT air FROM t WHERE gsis_id='00-0000001'").fetchone()[0], 7.25)
        rs2 = rows(10)
        rs2[2] = rs2[2][:7] + (8.5,) + rs2[2][8:]               # air value changed: a change
        self.assertEqual(run(c, self.sql(rs2)), 2)              # row 0 note back from NULL + row 2 air

    def test_type_affinity_is_not_a_change(self):
        c = db(SCHEMA)
        run(c, self.sql(rows(5)))
        rs = [(r[0], r[1], r[2], r[3], str(r[4]), int(r[5]) if r[5] == int(r[5]) else r[5], *r[6:]) for r in rows(5)]
        self.assertEqual(run(c, self.sql(rs)), 0, "'3' into INTEGER, 2 into REAL: same stored values")

    def test_ignored_stamp_column(self):
        c = db(SCHEMA)
        run(c, self.sql(rows(10, built="run-1")))
        self.assertEqual(run(c, self.sql(rows(10, built="run-2"))), 0, "a new built_at alone is not a change")
        self.assertEqual(c.execute("SELECT DISTINCT built_at FROM t").fetchall(), [("run-1",)])
        rs = rows(10, built="run-3"); rs[0] = rs[0][:6] + ("y",) + rs[0][7:]
        self.assertEqual(run(c, self.sql(rs)), 1)
        self.assertEqual(c.execute("SELECT built_at FROM t WHERE gsis_id='00-0000000'").fetchone()[0], "run-3")

    def test_wide_table_fits_d1_expression_depth(self):
        cols = ["season", "gsis_id"] + [f"c{i}" for i in range(110)]
        schema = f"CREATE TABLE w ({', '.join(c + (' TEXT' if c == 'gsis_id' else ' REAL') for c in cols)}, PRIMARY KEY (season, gsis_id));"
        c = db(schema)
        data = [(2025, f"g{j}", *[float(i + j) for i in range(110)]) for j in range(20)]
        self.assertEqual(run(c, build_insert("w", cols, data, pk_cols=["season", "gsis_id"])), 20)
        self.assertEqual(run(c, build_insert("w", cols, data, pk_cols=["season", "gsis_id"])), 0)
        # A flat OR chain over 110 columns is deeper than D1 allows: the balanced tree is required.
        flat = " OR ".join(f"w.{x} IS NOT excluded.{x}" for x in cols[2:])
        sql = build_insert("w", cols, data, pk_cols=["season", "gsis_id"], changed_only=False).rstrip(";\n") + f" WHERE {flat};"
        with self.assertRaises(sqlite3.OperationalError):
            c.executescript(sql)

    def test_insert_only_tables_unchanged(self):
        s = build_insert("t", COLS, rows(2))   # no pk_cols -> INSERT OR IGNORE, no WHERE
        self.assertTrue(s.startswith("INSERT OR IGNORE") and "WHERE" not in s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
