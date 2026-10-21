#!/usr/bin/env python3
"""Offline tests for run_1307_src_weekly_batches.py (#1307 guarded executor).

The guard must refuse a batch that could push the account past 90,000 rows
written in the UTC day, count every index entry, stop on the first statement
whose D1 meta differs from the plan, and do nothing remote without its opt-in.

Usage:
  python3 pipelines/etl/scripts/test_run_1307_src_weekly_batches.py
"""
import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
spec = importlib.util.spec_from_file_location("rb1307", HERE / "run_1307_src_weekly_batches.py")
rb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rb)
from lib.d1_io import build_insert  # noqa: E402

NOW = datetime(2026, 10, 21, 22, 10, tzinfo=timezone.utc)


def hourly(days_back: int, per_hour: int, today: dict | None = None) -> dict:
    out = {}
    for i in range(1, days_back + 1):
        d = (NOW - timedelta(days=i)).strftime("%Y-%m-%d")
        for h in range(24):
            out[f"{d}T{h:02d}"] = per_hour
    for h, v in (today or {}).items():
        out[f"{NOW:%Y-%m-%d}T{h:02d}"] = v
    return out


class Guard(unittest.TestCase):
    def test_ceiling_leaves_ten_thousand_unused(self):
        self.assertTrue(rb.guard(60_000, 27_000, 3_000)["ok"])          # exactly 90,000
        g = rb.guard(60_000, 27_001, 3_000)
        self.assertFalse(g["ok"])
        self.assertEqual(g["unused_after"], 100_000 - 90_001)

    def test_forecast_uses_last_seven_complete_days_and_counts_the_current_hour(self):
        h = hourly(7, 1_000)
        h[f"{(NOW - timedelta(days=9)):%Y-%m-%d}T23"] = 195_155  # older than 7 days: ignored
        self.assertEqual(rb.forecast_rest_of_day(h, NOW), 2_000)  # hours 22 and 23
        h[f"{(NOW - timedelta(days=3)):%Y-%m-%d}T23"] = 5_000    # a recent heavy hour counts
        self.assertEqual(rb.forecast_rest_of_day(h, NOW), 6_000)

    def test_used_today_and_anomaly(self):
        h = hourly(7, 1_000, today={1: 900, 12: 6_500})
        self.assertEqual(rb.used_today(h, NOW), 7_400)
        self.assertEqual(rb.anomalous_hours_today(h, NOW), [f"{NOW:%Y-%m-%d}T12"])
        self.assertEqual(rb.anomalous_hours_today(hourly(7, 1_000, today={12: 5_900}), NOW), [])

    def test_start_window(self):
        at = lambda h, m: NOW.replace(hour=h, minute=m)
        self.assertFalse(rb.in_window(at(22, 4)))
        self.assertTrue(rb.in_window(at(22, 5)))
        self.assertTrue(rb.in_window(at(23, 30)))
        self.assertFalse(rb.in_window(at(23, 31)))
        self.assertEqual(rb.next_window(at(23, 45)), at(22, 5) + timedelta(days=1))

    def test_calendar_waits_instead_of_overrunning(self):
        batches = [{"batch": 1, "billed_writes": 11_000}, {"batch": 2, "billed_writes": 14_420},
                   {"batch": 3, "billed_writes": 11_000}]
        # A heavy night fits batch 1 only; batch 2 waits for the lighter night; order kept.
        self.assertEqual(rb.calendar(batches, [74_000, 74_000, 30_000], 2_193), [(0, [1]), (1, []), (2, [2, 3])])


class Statements(unittest.TestCase):
    def test_insert_bills_table_plus_three_indexes(self):
        rows = [(2011, 14, str(i), "QB", None, 1.0, 0, None, None, 1, 1, None) for i in range(80)]
        sql = build_insert("src_weekly", rb.COLS, rows, pk_cols=["season", "week", "player_id"], changed_only=True)
        self.assertEqual(rb.statement_expectation(sql), {"kind": "insert", "rows": 80, "rows_written": 320, "changes": 80})

    def test_update_and_delete(self):
        self.assertEqual(rb.statement_expectation(
            "UPDATE src_weekly SET overall_rank = 5, pos_rank = 2 WHERE season = 2025 AND week = 15 "
            "AND player_id = '1' AND (overall_rank IS NOT 5 OR pos_rank IS NOT 2);")["rows_written"], 1)
        d = rb.statement_expectation("DELETE FROM src_weekly WHERE season = 2011 AND week = 14 AND player_id IN ('1','2','3');")
        self.assertEqual((d["kind"], d["changes"], d["rows_written"]), ("delete", 3, None))

    def test_meta_mismatch_stops(self):
        exp = {"kind": "insert", "rows": 80, "rows_written": 320, "changes": 80}
        self.assertIsNone(rb.check_meta(exp, {"rows_written": 320, "changes": 80}))
        self.assertIn("rows_written", rb.check_meta(exp, {"rows_written": 400, "changes": 80}))
        self.assertIn("changes", rb.check_meta(exp, {"rows_written": 320, "changes": 79}))

    def test_rows_hash_ignores_json_number_form(self):
        a = {c: None for c in rb.COLS} | {"season": 2025, "week": 15, "player_id": "1", "score": 12.0, "pos_rank": 3}
        b = dict(a, score=12, pos_rank=3.0)
        self.assertEqual(rb.rows_hash([a]), rb.rows_hash([b]))
        self.assertNotEqual(rb.rows_hash([a]), rb.rows_hash([dict(a, score=12.05)]))

    def test_mfl_facts_ignore_volatile_fields(self):
        x = {"playerScores": {"playerScore": [{"id": "1", "score": "4.0", "isAvailable": "0"}]}}
        y = {"playerScores": {"playerScore": [{"id": "1", "score": "4.0", "isAvailable": "1"}]}}
        z = {"playerScores": {"playerScore": [{"id": "1", "score": "4.5", "isAvailable": "0"}]}}
        self.assertEqual(rb.mfl_facts(x), rb.mfl_facts(y))
        self.assertNotEqual(rb.mfl_facts(x), rb.mfl_facts(z))


class NothingRemoteWithoutOptIn(unittest.TestCase):
    def setUp(self):
        def boom(*a, **k):
            raise AssertionError("reached a remote call")
        self.saved = (rb.d1, rb.account_hourly_writes, rb.mfl_get, rb.load_batch)
        rb.d1 = rb.account_hourly_writes = rb.mfl_get = boom
        rb.load_batch = lambda args: {"batch": 1, "season": 2025, "phases": ["B", "C"], "rows_inserted": 1,
                                      "rows_updated": 1, "billed_writes": 5}

    def tearDown(self):
        rb.d1, rb.account_hourly_writes, rb.mfl_get, rb.load_batch = self.saved

    def run_cmd(self, fn, **kw):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = fn(SimpleNamespace(plan="p", artifacts="a", batch=1, **kw))
        return rc, out.getvalue()

    def test_apply_and_rollback_need_execute_and_an_approval_url(self):
        for fn in (rb.cmd_apply, rb.cmd_rollback):
            for kw in ({"execute": False, "approval": ""}, {"execute": True, "approval": ""},
                       {"execute": False, "approval": "https://github.com/keithcreelman/upsmflproduction/issues/1307#issuecomment-1"},
                       {"execute": True, "approval": "https://example.com/approved"}):
                rc, out = self.run_cmd(fn, **kw)
                self.assertEqual(rc, 0)
                self.assertIn("Nothing was done", out)

    def test_reads_need_their_flag(self):
        for fn in (rb.cmd_preflight, rb.cmd_verify):
            rc, out = self.run_cmd(fn, allow_prod_d1_read=False)
            self.assertEqual(rc, 0)
            self.assertIn("SKIPPED", out)

    def test_read_path_runs_select_only(self):
        rb.d1 = self.saved[0]
        for sql in ("DELETE FROM src_weekly", "UPDATE src_weekly SET x = 1", "INSERT INTO src_weekly VALUES (1)"):
            with self.assertRaises(ValueError):
                rb.d1(sql)


if __name__ == "__main__":
    unittest.main(verbosity=2)
