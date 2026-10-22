#!/usr/bin/env python3
"""Offline tests for run_1307_src_weekly_batches.py (#1307 guarded executor).

The guard must refuse a batch that could push the account past 90,000 rows
written in the UTC day, count every index entry, stop on the first statement
whose D1 meta differs from the plan, do nothing remote without its opt-in, and
let each approval start exactly one attempt.

Usage:
  python3 pipelines/etl/scripts/test_run_1307_src_weekly_batches.py
"""
import importlib.util
import io
import json
import sys
import tempfile
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

# Never touch the real attempt ledger from a test.
rb.ATTEMPT_DIR = Path(tempfile.mkdtemp(prefix="rb1307_test_")) / "attempts"
APPROVAL = "https://github.com/keithcreelman/upsmflproduction/issues/1307#issuecomment-%d"

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
        rb.load_batch = self.saved[3]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"plan_version": rb.PLAN_VERSION, "batches": [{"batch": "1A", "status": "ready"}],
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


class OneAttemptPerApproval(unittest.TestCase):
    """Keith 2026-10-21: an attempt consumes its approval whatever happens; another attempt needs a new approval."""
    def setUp(self):
        rb.ATTEMPT_DIR = Path(tempfile.mkdtemp(prefix="rb1307_test_")) / "attempts"
        self.calls = []
        self.saved = (rb.d1, rb.preflight, rb.season_playoff_rows, rb.statements, rb.load_batch,
                      rb.usage_report, rb.verify)
        ins = "INSERT INTO src_weekly (a) VALUES\n" + ",\n".join(["(1)"] * 80) + "\nON CONFLICT (a) DO NOTHING;"
        self.billing = 5   # rows written per inserted row on the calibration statement
        def fake_d1(sql, allow_write=False):
            self.calls.append(sql.split()[0])
            if sql.startswith("INSERT"):
                return [{"meta": {"rows_written": 80 * self.billing, "changes": 80}}]
            return [{"meta": {"rows_written": 1, "changes": 1}} for _ in sql.split(";\n") if _.strip()]
        def fake_preflight(args, b, enforce_window=True):
            self.calls.append("PREFLIGHT")
            return {"stops": list(self.stops), "hourly_at_start": {}}
        self.stops = []
        rb.d1, rb.preflight = fake_d1, fake_preflight
        rb.season_playoff_rows = lambda season: ([], 0)
        rb.statements = lambda args, b, key: [ins] if key == "forward" else ["DELETE FROM src_weekly WHERE season = 2025 AND week = 15 AND player_id IN ('1');"]
        rb.load_batch = lambda args: {"batch": "1A", "season": 2025, "billed_writes": 320, "rollback_reserve": 320,
                                      "reads": {"reserve_total": 1_000, "rollback_worst_case": 100},
                                      "preimage": {"rows": 0, "sha256": rb.rows_hash([])}}
        rb.usage_report = lambda forward=0, reserve=0, now=None, read_reserve=0: {
            "projected": 1, "ceiling": 90_000, "_hourly": {}, "reads": {"ok": True}, "cross_check": {"ok": True}}
        self.art = tempfile.mkdtemp(prefix="rb1307_art_")

    def tearDown(self):
        (rb.d1, rb.preflight, rb.season_playoff_rows, rb.statements, rb.load_batch,
         rb.usage_report, rb.verify) = self.saved

    def run_cmd(self, fn, n):
        with redirect_stdout(io.StringIO()):
            try:
                return fn(SimpleNamespace(plan="p", artifacts=self.art, batch="1A", execute=True, approval=APPROVAL % n))
            except SystemExit as e:
                return "exit: " + str(e)

    def test_a_failed_run_and_its_automatic_rollback_consume_the_approval(self):
        self.assertIn("rolled back", self.run_cmd(rb.cmd_apply, 9))
        self.assertEqual(self.calls, ["PREFLIGHT", "INSERT", "DELETE"])
        self.billing = 4   # even if the cause were fixed, the same approval cannot retry
        out = self.run_cmd(rb.cmd_apply, 9)
        self.assertIn("NEW approval", out)
        self.assertIn("Nothing was done", out)
        self.assertEqual(self.calls, ["PREFLIGHT", "INSERT", "DELETE"], "no production read or write on the retry")
        (a,) = rb.attempts("1A")
        self.assertEqual(a["approval_comment_id"], 9)
        self.assertIn("automatic_rollback", [o["outcome"] for o in a["outcomes"]])

    def test_a_preflight_stop_or_a_crash_still_consumes_it(self):
        self.stops = ["outside the 22:05-23:30 UTC start window"]
        self.assertIn("approval is now used", self.run_cmd(rb.cmd_apply, 20))
        self.assertIn("NEW approval", self.run_cmd(rb.cmd_apply, 20))
        def crash(args, b, enforce_window=True):
            raise RuntimeError("network down")
        rb.preflight = crash
        with redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
            rb.cmd_apply(SimpleNamespace(plan="p", artifacts=self.art, batch="1A", execute=True, approval=APPROVAL % 21))
        self.assertIn("NEW approval", self.run_cmd(rb.cmd_apply, 21))
        self.assertEqual([o["outcome"] for o in rb.attempts("1A")[1]["outcomes"]], ["stopped"])

    def test_another_attempt_needs_a_newer_approval(self):
        self.run_cmd(rb.cmd_apply, 30)
        self.assertIn("NEW approval", self.run_cmd(rb.cmd_apply, 29), "an older approval cannot be held in reserve")
        n = len(self.calls)
        self.billing = 4
        rb.verify = lambda b: {"after_hash_ok": True, "reconciliation_ok": True, "reconciliation": {}}
        rb.account_hourly_writes, saved = (lambda days=8: {}), rb.account_hourly_writes
        rb.time.sleep, sleep = (lambda s: None), rb.time.sleep
        try:
            self.assertEqual(self.run_cmd(rb.cmd_apply, 31), 0, "a new approval starts a new attempt")
        finally:
            rb.account_hourly_writes, rb.time.sleep = saved, sleep
        self.assertEqual(self.calls[n:], ["PREFLIGHT", "INSERT"])
        self.assertEqual([a["approval_comment_id"] for a in rb.attempts("1A")], [30, 31])

    def test_rollback_approvals_are_single_use_and_never_an_apply_approval(self):
        self.billing = 4
        rb.verify = lambda b: {"after_hash_ok": True, "reconciliation_ok": True, "reconciliation": {}}
        rb.account_hourly_writes, saved = (lambda days=8: {}), rb.account_hourly_writes
        rb.time.sleep, sleep = (lambda s: None), rb.time.sleep
        try:
            self.assertEqual(self.run_cmd(rb.cmd_apply, 40), 0)
        finally:
            rb.account_hourly_writes, rb.time.sleep = saved, sleep
        self.assertIn("NEW approval", self.run_cmd(rb.cmd_rollback, 40), "the apply approval cannot roll back")
        self.assertEqual(self.run_cmd(rb.cmd_rollback, 41), 0)
        self.assertIn("NEW approval", self.run_cmd(rb.cmd_rollback, 41))
        self.assertEqual([(a["kind"], a["approval_comment_id"]) for a in rb.attempts("1A")], [("apply", 40), ("rollback", 41)])

    def test_two_runs_cannot_both_start(self):
        rb.consume_approval("1A", "apply", APPROVAL % 50, NOW)
        with self.assertRaises(SystemExit):
            rb.consume_approval("1A", "apply", APPROVAL % 50, NOW)
        # Even a racing run that slipped past the check cannot create the same record twice.
        with self.assertRaises(FileExistsError):
            rb.os.open(rb.ATTEMPT_DIR / "batch_1A_apply_50.json", rb.os.O_WRONLY | rb.os.O_CREAT | rb.os.O_EXCL)

    def test_verify_and_the_ledger_stay_read_only_and_need_no_approval(self):
        self.run_cmd(rb.cmd_apply, 60)
        rb.verify = lambda b: {"after_hash_ok": True, "reconciliation_ok": True}
        with redirect_stdout(io.StringIO()):
            self.assertEqual(rb.cmd_verify(SimpleNamespace(plan="p", artifacts=self.art, batch="1A", allow_prod_d1_read=True)), 0)
            self.assertEqual(rb.cmd_verify(SimpleNamespace(plan="p", artifacts=self.art, batch="1A", allow_prod_d1_read=True)), 0)
        out = io.StringIO()
        with redirect_stdout(out):
            rb.cmd_attempts(SimpleNamespace(batch="1A"))
        self.assertEqual(json.loads(out.getvalue())["attempts"][0]["approval_comment_id"], 60)


class PanelCheckExpectsTheSafeguard(unittest.TestCase):
    """After 1A the panel reads the live bundle; a rank PR #1372 holds must come back null with rank_pending."""
    def test_held_rank_must_be_null_with_rank_pending(self):
        ex = {"player_id": "13307", "name": "Milano, Matt", "after": [74.0, 12], "rank_basis": [74.0, 12],
              "stored_rank": [46, 45], "shows_after": True, "rank_pending_fields": ["pos_ppg_rank"]}
        saved = (rb.load_batch, rb.worker_bundle)
        rb.load_batch = lambda args: {"season": 2025, "panel_examples": [ex]}
        def run(row):
            rb.worker_bundle = lambda pid: {"career_summary": [row]}
            with redirect_stdout(io.StringIO()):
                return rb.cmd_panel_check(SimpleNamespace(plan="p", batch="1A", allow_prod_read=True))
        try:
            held = {"season": 2025, "season_points": 74.0, "games_played": 12, "pos_rank": 46, "pos_ppg_rank": None,
                    "rank_pending": {"fields": ["pos_ppg_rank"], "reason": "Rank pending historical reconciliation (#1307)"}}
            self.assertEqual(run(held), 0)
            self.assertEqual(run({**held, "pos_ppg_rank": 45, "rank_pending": None}), 1, "#1372 not live: fail")
            self.assertEqual(run({**held, "pos_rank": None, "rank_pending": {"fields": ["pos_rank", "pos_ppg_rank"]}}), 1)
        finally:
            rb.load_batch, rb.worker_bundle = saved


class ReadCapacity(unittest.TestCase):
    """Keith 2026-10-22: account-wide reads, the whole batch's reads reserved, 90% of 5M, fail closed."""
    def test_read_ceiling_is_ninety_percent_and_counts_every_reserved_read(self):
        self.assertEqual(rb.READ_CEILING, 4_500_000)
        self.assertTrue(rb.read_guard(4_000_000, 378_807, 121_193)["ok"])   # exactly 4,500,000
        g = rb.read_guard(4_000_000, 378_807, 121_194)
        self.assertFalse(g["ok"])
        self.assertEqual(g["reads_unused_after_worst_case"], 5_000_000 - 4_500_001)

    def test_reads_are_forecast_like_writes(self):
        h = hourly(7, 50_000)
        h[f"{(NOW - timedelta(days=3)):%Y-%m-%d}T23"] = 2_000_000     # a heavy recent hour counts
        self.assertEqual(rb.forecast_rest_of_day(h, NOW), 50_000 + 2_000_000)
        h[f"{(NOW - timedelta(days=9)):%Y-%m-%d}T22"] = 700_000_000   # older than 7 days: ignored
        self.assertEqual(rb.forecast_rest_of_day(h, NOW), 2_050_000)

    def test_plan_reserves_the_complete_read_budget(self):
        b = json.loads((HERE.parents[2] / "docs/data_fixes/2026-10-21-1307-execution-plan.json").read_text())["batches"][0]
        r = b["reads"]
        parts = ("preflight_d1", "during_writes_worst_case", "apply_verify_d1", "runbook_verify_d1",
                 "rollback_worst_case", "panel_check_reserve")
        self.assertEqual(r["reserve_total"], sum(r[k] for k in parts))
        self.assertEqual(r["panel_check_reserve"], 8 * rb.BUNDLE_READ_RESERVE)

    def cross(self, info_reads, info_writes=24_000):
        now = NOW
        reads = {(now - timedelta(hours=i)).strftime("%Y-%m-%dT%H"): 200_000 for i in range(25)}
        writes = {k: 1_000 for k in reads}
        return rb.usage_cross_check(reads, writes, {"rows_read_24h": info_reads, "rows_written_24h": info_writes}, now)

    def test_sources_must_agree_within_five_percent(self):
        # GraphQL: lower 24 x 200k = 4.8M, upper 5.0M (the edge hour too).
        self.assertTrue(self.cross(4_900_000)["ok"])
        self.assertTrue(self.cross(4_560_000)["ok"])    # 5% under the lower bound
        self.assertFalse(self.cross(4_550_000)["ok"])
        self.assertFalse(self.cross(5_260_000)["ok"])   # beyond 5% over the upper bound
        self.assertFalse(self.cross(0)["ok"], "a zero from `wrangler d1 info` is a disagreement")
        self.assertFalse(self.cross(4_900_000, info_writes=0)["ok"], "writes are cross-checked too")

    def test_preflight_stops_before_any_d1_read_on_bad_metrics(self):
        saved = (rb.usage_report, rb.season_playoff_rows, rb.running_write_jobs)
        def no_d1(*a, **k):
            raise AssertionError("read D1 after a failed usage check")
        rb.season_playoff_rows, rb.running_write_jobs = no_d1, (lambda: [])
        b = {"batch": "1A", "season": 2025, "billed_writes": 10_656, "rollback_reserve": 10_656, "reads": {"reserve_total": 121_193}}
        try:
            for reads_ok, cross_ok, why in ((True, False, "disagree"), (False, True, "read ceiling")):
                rb.usage_report = lambda forward=0, reserve=0, now=None, read_reserve=0: {
                    "_hourly": {}, "projected": 1, "ceiling": 90_000, "in_window": True, "anomalous_hours_today": [],
                    "reads": {"ok": reads_ok, "projected_reads": 5_000_000, "read_reserve": read_reserve, "read_ceiling": 4_500_000},
                    "cross_check": {"ok": cross_ok}}
                facts = rb.preflight(SimpleNamespace(artifacts=tempfile.mkdtemp()), b)
                self.assertTrue(any(why in x for x in facts["stops"]), facts["stops"])
        finally:
            rb.usage_report, rb.season_playoff_rows, rb.running_write_jobs = saved

    def test_a_metrics_failure_fails_closed(self):
        saved = rb.urllib.request.urlopen
        def down(*a, **k):
            raise OSError("network down")
        rb.urllib.request.urlopen = down
        try:
            with self.assertRaises(OSError):
                rb.account_hourly_usage()
        finally:
            rb.urllib.request.urlopen = saved


class SafeguardCheck(unittest.TestCase):
    """The deployed bundle must hold exactly what the PR #1372 manifest says."""
    manifest = {"season": 2025, "reason": "Rank pending historical reconciliation (#1307)",
                "held": {"pos_rank": [{"player_id": "17086"}], "pos_ppg_rank": [{"player_id": "17086"}, {"player_id": "17124"}]},
                "not_held_already_visible": {"pos_rank": ["11348"], "pos_ppg_rank": ["11348"]}}
    stored = {"17086": {"pos_rank": 211, "pos_ppg_rank": 225}, "17124": {"pos_rank": 40, "pos_ppg_rank": 54},
              "12620": {"pos_rank": 4, "pos_ppg_rank": 5}}

    def bundle(self, row):
        return {"career_summary": [{"season": 2025, **row}, {"season": 2024, "pos_rank": 9, "pos_ppg_rank": 9}]}

    def test_held_and_controls(self):
        r = self.manifest["reason"]
        ok = lambda pid, row, **k: rb.safeguard_compare(pid, self.bundle(row), self.manifest, self.stored, **k)["ok"]
        self.assertTrue(ok("17086", {"pos_rank": None, "pos_ppg_rank": None, "rank_pending": {"fields": ["pos_rank", "pos_ppg_rank"], "reason": r}}))
        self.assertTrue(ok("17124", {"pos_rank": 40, "pos_ppg_rank": None, "rank_pending": {"fields": ["pos_ppg_rank"], "reason": r}}))
        self.assertTrue(ok("12620", {"pos_rank": 4, "pos_ppg_rank": 5}))
        self.assertFalse(ok("17124", {"pos_rank": 40, "pos_ppg_rank": 54}), "a held rank that shows")
        self.assertFalse(ok("17124", {"pos_rank": None, "pos_ppg_rank": None, "rank_pending": {"fields": ["pos_rank", "pos_ppg_rank"], "reason": r}}), "an unheld rank hidden")
        self.assertFalse(ok("17124", {"pos_rank": 40, "pos_ppg_rank": None, "rank_pending": {"fields": ["pos_ppg_rank"], "reason": "x"}}), "wrong reason")
        self.assertFalse(ok("12620", {"pos_rank": 4, "pos_ppg_rank": 5, "rank_pending": {"fields": [], "reason": r}}), "a control marked pending")
        # A held player with no weekly rows yet (pre-1A): both null, nothing to hold.
        self.assertTrue(ok("17086", {"pos_rank": None, "pos_ppg_rank": None}, has_rows=False))
        self.assertFalse(ok("17086", {"pos_rank": None, "pos_ppg_rank": None}))

    def test_sample_is_deterministic_and_covers_every_kind(self):
        m = json.loads((HERE.parents[2] / "docs/data_fixes/1307_rank_pending/manifest_2025.json").read_text())
        s = rb.safeguard_sample(m)
        self.assertEqual(s, rb.safeguard_sample(m))
        for pid in ("17086", "16390", "17124", "12620", "12616", "17039", m["not_held_already_visible"]["pos_rank"][0]):
            self.assertIn(pid, s)
        self.assertLessEqual(len(s), 16)


if __name__ == "__main__":
    unittest.main(verbosity=2)
