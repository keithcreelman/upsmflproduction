#!/usr/bin/env python3
"""Offline tests for dryrun_1307_src_weekly_backfill.py (#1307).

Covers the rules every proposed row depends on, and the two safety properties
the dry run must prove before Keith approves a write:
  * status is never inferred: anything outside lineup / taxi / IR / free agent
    is held back as unresolved;
  * the forward SQL is idempotent and its rollback restores the exact
    before-state (here on an in-memory SQLite with src_weekly's real schema);
  * a default run reads nothing from production.

Usage:
  python3 pipelines/etl/scripts/test_dryrun_1307_src_weekly_backfill.py
"""
import importlib.util
import io
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("dryrun1307", HERE / "dryrun_1307_src_weekly_backfill.py")
dr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dr)

# src_weekly exactly as production's sqlite_master holds it (migrations 0002 + 0004).
SCHEMA = [
    """CREATE TABLE src_weekly (
      season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
      pos_group TEXT, status TEXT, score REAL, is_reg INTEGER,
      roster_franchise_id TEXT, roster_franchise_name TEXT, pos_rank INTEGER,
      overall_rank INTEGER, win_chunks REAL, PRIMARY KEY (season, week, player_id))""",
    "CREATE INDEX idx_src_weekly_player ON src_weekly (player_id, season DESC, week DESC)",
    "CREATE INDEX idx_src_weekly_season ON src_weekly (season, week)",
]


def row(season, week, pid, score, status="fa", fid="FA", name="Free Agent", pg="QB", pos_rank=1, overall=1):
    return {"season": season, "week": week, "player_id": pid, "pos_group": pg, "status": status,
            "score": score, "is_reg": 0, "roster_franchise_id": fid, "roster_franchise_name": name,
            "pos_rank": pos_rank, "overall_rank": overall, "win_chunks": None}


def db_with(rows):
    conn = sqlite3.connect(":memory:")
    for s in SCHEMA:
        conn.execute(s)
    conn.executemany(f"INSERT INTO src_weekly VALUES ({','.join('?' * len(dr.COLS))})",
                     [dr.row_tuple(r) for r in rows])
    conn.commit()
    return conn


def snapshot(conn):
    return conn.execute("SELECT * FROM src_weekly ORDER BY season, week, player_id").fetchall()


def run(conn, stmts):
    before = conn.total_changes
    for s in stmts:
        conn.execute(s)
    conn.commit()
    return conn.total_changes - before


class Classify(unittest.TestCase):
    lineup = {"1": ("0001", "starter"), "2": ("0001", "nonstarter"), "9": ("0003", "weird")}
    size = {"0001": 2, "0002": 0, "0003": 1}
    rosters = {"3": ("0001", "TAXI_SQUAD"), "4": ("0001", "INJURED_RESERVE"),
               "5": ("0002", "ROSTER"), "6": ("0001", "ROSTER")}

    def c(self, pid):
        return dr.classify(pid, self.lineup, self.size, self.rosters)

    def test_lineup_status_is_mfls_own(self):
        self.assertEqual(self.c("1"), ("starter", "0001", "lineup"))
        self.assertEqual(self.c("2"), ("nonstarter", "0001", "lineup"))

    def test_taxi_and_ir_follow_the_table_convention(self):
        self.assertEqual(self.c("3"), ("nonstarter", "0001", "taxi"))
        self.assertEqual(self.c("4"), ("nonstarter", "0001", "ir"))

    def test_free_agent_only_when_on_no_roster(self):
        self.assertEqual(self.c("7"), ("fa", "FA", "fa"))

    def test_never_guesses(self):
        # Rostered on a franchise that submitted no lineup: not benched, not FA.
        self.assertEqual(self.c("5"), (None, "0002", "unresolved_no_lineup"))
        # The rosters export says rostered but the lineup record does not list him.
        self.assertEqual(self.c("6"), (None, "0001", "unresolved_roster_not_in_lineup"))
        self.assertEqual(self.c("9"), (None, "0003", "unresolved_lineup_status"))

    def test_retroactive_rosters_export_proves_nothing(self):
        # 2011: lineups put 6997 on 0001, the rosters export shows a later owner.
        lineup = {"6997": ("0001", "starter")}
        self.assertFalse(dr.export_is_weekly(lineup, {"6997": ("0006", "ROSTER")}))
        self.assertTrue(dr.export_is_weekly(lineup, {"6997": ("0001", "ROSTER")}))
        args = (self.lineup, self.size, self.rosters)
        self.assertEqual(dr.classify_week("1", *args, False), ("starter", "0001", "lineup"))
        for pid, cls in (("3", "taxi"), ("4", "ir"), ("7", "fa")):
            self.assertEqual(dr.classify_week(pid, *args, False),
                             (None, None, f"unproven_{cls}_rosters_export_not_weekly"))
            self.assertEqual(dr.classify_week(pid, *args, True), dr.classify(pid, *args))


class Ranks(unittest.TestCase):
    def test_table_rank_is_sequential_with_numeric_id_ties(self):
        # 2019 Wk 13 QBs: Brady (5848) and Goff (12611) both 30.0 -> 10th and 11th, Brady first.
        scores = {"7836": 36.1, "12611": 30.0, "5848": 30.0, "12610": 29.8, "999": 5.0}
        groups = {"7836": "QB", "12611": "QB", "5848": "QB", "12610": "QB"}
        overall, pos = dr.table_ranks(scores, groups)
        self.assertEqual(overall, {"7836": 1, "5848": 2, "12611": 3, "12610": 4, "999": 5})
        self.assertEqual(pos, {"7836": 1, "5848": 2, "12611": 3, "12610": 4})
        self.assertNotIn("999", pos)  # no pos_group -> no pos rank

    def test_dense_rank_matches_pointssummary(self):
        # 2019 QBs: Brady and Murray tie at 277.7 -> both 12th, next is 13th.
        self.assertEqual(dr.dense_ranks({"x": 280.0, "brady": 277.7, "murray": 277.7, "jimmy": 265.2}),
                         {"x": 1, "brady": 2, "murray": 2, "jimmy": 3})

    def test_alltime_minimum_is_75_percent_of_ups_weeks(self):
        self.assertEqual(dr.alltime_min_games(16), 12)
        self.assertEqual(dr.alltime_min_games(17), 13)

    def test_canon_weeks(self):
        self.assertEqual(dr.canon_weeks(2020), (13, 16))
        self.assertEqual(dr.canon_weeks(2021), (14, 17))


class SqlIsIdempotentAndReversible(unittest.TestCase):
    def test_inserts_rerun_writes_nothing_and_rollback_is_exact(self):
        existing = [row(2021, 15, "100", 12.5, "starter", "0001", "Team", "WR")]
        conn = db_with(existing)
        before = snapshot(conn)
        new = [row(2021, 15, str(200 + i), float(i), pg="RB" if i % 2 else "WR") for i in range(170)]
        new.append(row(2021, 16, "o'neil", 3.0))  # quoting survives
        fwd = dr.insert_statements(new)
        self.assertGreater(len(fwd), 2)  # chunked like D1Writer
        self.assertEqual(run(conn, fwd), len(new))
        after = snapshot(conn)
        self.assertEqual(run(conn, fwd), 0)  # changed-only upsert: re-run writes nothing
        self.assertEqual(snapshot(conn), after)
        self.assertEqual(run(conn, dr.delete_statements(new)), len(new))
        self.assertEqual(snapshot(conn), before)

    def test_updates_rerun_writes_nothing_and_restore_is_exact(self):
        rows = [row(2015, w, str(p), 1.0 + p, "fa", "FA", "Free Agent") for w in (1, 2) for p in range(5)]
        conn = db_with(rows)
        before = snapshot(conn)
        ups = [{"season": 2015, "week": 1, "player_id": "1",
                "old": {"status": "fa", "roster_franchise_id": "FA", "roster_franchise_name": "Free Agent"},
                "new": {"status": "starter", "roster_franchise_id": "0004", "roster_franchise_name": "X"}},
               {"season": 2015, "week": 2, "player_id": "3",
                "old": {"pos_rank": 1, "score": 4.0}, "new": {"pos_rank": None, "score": 4.25}}]
        self.assertEqual(run(conn, dr.update_statements(ups)), 2)
        changed = snapshot(conn)
        self.assertEqual(run(conn, dr.update_statements(ups)), 0)
        self.assertEqual(snapshot(conn), changed)
        self.assertEqual(run(conn, dr.restore_statements(ups)), 2)
        self.assertEqual(snapshot(conn), before)

    def test_restore_leaves_a_row_someone_else_changed(self):
        conn = db_with([row(2015, 1, "1", 2.0)])
        ups = [{"season": 2015, "week": 1, "player_id": "1", "old": {"status": "fa"}, "new": {"status": "starter"}}]
        run(conn, dr.update_statements(ups))
        conn.execute("UPDATE src_weekly SET status = 'nonstarter'")
        self.assertEqual(run(conn, dr.restore_statements(ups)), 0)
        self.assertEqual(conn.execute("SELECT status FROM src_weekly").fetchone()[0], "nonstarter")

    def test_fingerprint_is_order_independent_and_value_sensitive(self):
        a = [row(2011, 14, "1", 1.0), row(2011, 14, "2", 2.0)]
        self.assertEqual(dr.rows_fingerprint(a), dr.rows_fingerprint(list(reversed(a))))
        b = [row(2011, 14, "1", 1.0), row(2011, 14, "2", 2.05)]
        self.assertNotEqual(dr.rows_fingerprint(a), dr.rows_fingerprint(b))


class ProductionStaysUntouched(unittest.TestCase):
    def test_default_extract_reads_nothing(self):
        def runner(sql):
            raise AssertionError("a default run reached production: " + sql)
        with tempfile.TemporaryDirectory() as d:
            out = io.StringIO()
            with redirect_stdout(out):
                rc = dr.cmd_extract_d1(SimpleNamespace(allow_prod_d1=False, out=d, max_rows_read=10), runner=runner)
            self.assertEqual(rc, 0)
            self.assertIn("SKIPPED", out.getvalue())
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_extract_refuses_a_table_scan(self):
        def runner(sql):
            if sql.startswith("EXPLAIN"):
                return [{"results": [{"detail": "SCAN src_weekly"}]}]
            raise AssertionError("ran a query whose plan scans a table")
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "schema.json").write_text('{"rows_read": 0}')
            with redirect_stdout(io.StringIO()):
                rc = dr.cmd_extract_d1(SimpleNamespace(allow_prod_d1=True, out=d, max_rows_read=10), runner=runner)
            self.assertEqual(rc, 2)

    def test_plan_guard(self):
        ok = [{"detail": "SEARCH src_weekly USING INDEX idx_src_weekly_season (season=? AND week>?)"}]
        self.assertTrue(dr.plan_is_indexed(ok)[0])
        for bad in ("SCAN src_weekly", "SCAN src_pointssummary USING COVERING INDEX idx_pointssummary_player"):
            self.assertFalse(dr.plan_is_indexed([{"detail": bad}])[0], bad)

    def test_only_selects_reach_the_d1_helper(self):
        for sql in ("DELETE FROM src_weekly", "INSERT INTO src_weekly VALUES (1)", "UPDATE src_weekly SET x=1"):
            with self.assertRaises(ValueError):
                dr.wrangler_json(sql)

    def test_every_planned_read_is_a_keyed_select(self):
        for name, sql in dr.d1_read_plan():
            self.assertTrue(sql.startswith("SELECT"), name)
            if name != "schema":
                self.assertRegex(sql, r"WHERE (season|player_id)", name)


class MflCache(unittest.TestCase):
    def test_cache_key_matches_store_convention(self):
        url = dr.mfl_url(2011, {"TYPE": "league", "L": "40832"})
        self.assertEqual(url, "https://api.myfantasyleague.com/2011/export?TYPE=league&L=40832&JSON=1")
        self.assertEqual(dr.cache_key(url), "api_myfantasyleague_com_2011_export_TYPE_league_L_40832_JSON_1.json")

    def test_offline_cache_never_fetches(self):
        with tempfile.TemporaryDirectory() as d:
            c = dr.MflCache(Path(d), offline=True)
            with self.assertRaises(FileNotFoundError):
                c.get(2011, {"TYPE": "league", "L": "40832"})

    def test_league_ids_before_2017(self):
        self.assertEqual(dr.league_id(2011), "40832")
        self.assertEqual(dr.league_id(2016), "27191")
        self.assertEqual(dr.league_id(2017), "74598")


if __name__ == "__main__":
    unittest.main(verbosity=2)
