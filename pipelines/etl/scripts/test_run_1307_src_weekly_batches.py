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
    def test_ceiling_holds_forward_writes_and_the_full_rollback(self):
        # used + forecast + forward + rollback reserve <= 90,000 leaves >= 10,000 unused.
        self.assertTrue(rb.guard(60_000, 13_500, 13_500, 3_000)["ok"])   # exactly 90,000
        g = rb.guard(60_000, 13_500, 13_501, 3_000)
        self.assertFalse(g["ok"])
        self.assertEqual(g["unused_after_worst_case"], 100_000 - 90_001)
        # Batch 1A: 2,664 inserts -> 10,656 forward and 10,656 reserved for its rollback.
        self.assertEqual(rb.rollback_reserve(2_664, 0), 10_656)
        self.assertFalse(rb.guard(70_000, 10_656, 10_656, 2_193)["ok"])  # fits without the reserve, not with it

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

    def test_writes_since_spans_the_utc_reset(self):
        h = {"2026-10-21T22": 500, "2026-10-21T23": 700, "2026-10-22T00": 900, "2026-10-21T21": 5_000}
        self.assertEqual(rb.writes_since(h, NOW), 2_100)

    def test_calendar_waits_instead_of_overrunning(self):
        b = lambda i, w: {"batch": i, "billed_writes": w, "rollback_reserve": w}
        # Night 1 fits batch 1 with its reserve; batch 2 waits; order kept.
        self.assertEqual(rb.calendar([b(1, 10_656), b(2, 14_420), b(3, 10_000)], [60_000, 62_000, 30_000], 2_193),
                         [(0, [1]), (1, []), (2, [2, 3])])

    def test_showable_is_the_player_card_rule(self):
        basis = {"a": (361.1, 15), "b": (245.7, 14), "c": (60.5, 5), "d": (10.0, 1)}
        totals = {"a": (361.10000001, 15), "b": (151.2, 8), "c": (60.5, 5)}
        pts, ppg = rb.showable(totals, basis, 17)
        self.assertEqual(pts, {"a", "c"})      # b: duplicate-inflated basis; d: no weekly rows
        self.assertEqual(ppg, {"a"})           # c: 5 wks < half of 17


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
        self.assertEqual((d["kind"], d["rows"], d["changes"], d["rows_written"]), ("delete", 3, None, None))

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
        rb.load_batch = lambda args: {"batch": "1A", "season": 2025, "phases": ["B"], "rows_inserted": 1,
                                      "rows_updated": 0, "billed_writes": 4, "rollback_reserve": 4}

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

    def test_only_a_ready_batch_runs(self):
        import json, tempfile
        rb.load_batch = self.saved[3]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"plan_version": 2, "batches": [{"batch": "1A", "status": "ready"}],
                       "held": [{"batch": "1C", "status": "held"}]}, f)
        for bid in ("1C", "2", "1B"):
            with self.assertRaises(SystemExit):
                rb.load_batch(SimpleNamespace(plan=f.name, batch=bid, artifacts=None))


    def test_reads_need_their_flag(self):
        for fn in (rb.cmd_preflight, rb.cmd_verify):
            rc, out = self.run_cmd(fn, allow_prod_d1_read=False)
            self.assertEqual(rc, 0)
            self.assertIn("SKIPPED", out)
        rc, out = self.run_cmd(rb.cmd_panel_check, allow_prod_read=False)
        self.assertIn("SKIPPED", out)

    def test_read_path_runs_select_only(self):
        rb.d1 = self.saved[0]
        for sql in ("DELETE FROM src_weekly", "UPDATE src_weekly SET x = 1", "INSERT INTO src_weekly VALUES (1)"):
            with self.assertRaises(ValueError):
                rb.d1(sql)


class AutomaticRollback(unittest.TestCase):
    """A billing deviation on the 80-row calibration statement rolls back at once."""
    def test_invariant_triggers_restore(self):
        import tempfile
        calls = []
        def fake_d1(sql, allow_write=False):
            calls.append(sql.split()[0])
            if sql.startswith("INSERT"):
                return [{"meta": {"rows_written": 400, "changes": 80}}]  # production bills 5/row
            return [{"meta": {"rows_written": 1, "changes": 1}} for _ in sql.split(";\n") if _.strip()]
        saved = (rb.d1, rb.preflight, rb.season_playoff_rows, rb.statements, rb.load_batch, rb.account_hourly_writes)
        try:
            rb.d1 = fake_d1
            rb.preflight = lambda args, b, enforce_window=True: {"stops": [], "hourly_at_start": {}}
            rb.season_playoff_rows = lambda season: ([], 0)
            ins = "INSERT INTO src_weekly (a) VALUES\n" + ",\n".join(["(1)"] * 80) + "\nON CONFLICT (a) DO NOTHING;"
            rb.statements = lambda args, b, key: [ins, ins] if key == "forward" else ["DELETE FROM src_weekly WHERE season = 2025 AND week = 15 AND player_id IN ('1');"]
            rb.load_batch = lambda args: {"batch": "1A", "season": 2025, "billed_writes": 640,
                                          "preimage": {"rows": 0, "sha256": rb.rows_hash([])}}
            with tempfile.TemporaryDirectory() as d:
                with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
                    rb.cmd_apply(SimpleNamespace(plan="p", artifacts=d, batch="1A", execute=True,
                                                 approval="https://github.com/keithcreelman/upsmflproduction/issues/1307#issuecomment-9"))
            self.assertIn("rolled back", str(cm.exception))
            self.assertEqual(calls, ["INSERT", "DELETE"])  # stopped after the first statement, then restored
        finally:
            rb.d1, rb.preflight, rb.season_playoff_rows, rb.statements, rb.load_batch, rb.account_hourly_writes = saved


if __name__ == "__main__":
    unittest.main(verbosity=2)
