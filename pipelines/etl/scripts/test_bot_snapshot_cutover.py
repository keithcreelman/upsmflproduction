#!/usr/bin/env python3
"""The bot's snapshot cutover and the held-trade retry (Keith 2026-10-21, companion to #1357).

bot_snapshot_cutover.py runs on a throwaway git repository: the bot's "checkout", whose
refs/remotes/origin/main the test advances from a worktree (the safe suite allows no clone, fetch
or push, so Ops.fetch is a no-op here), with a fake bot process: restart = a new pid, a "Trade polling started" log line
and a heartbeat with that pid and commit. Each stage's failure is shown to leave the checkout,
the runtime state and the running bot as they were (or restored) and to alert naming the stage.
held_trades.py and the bot's retry hook are shown to retry a held trade exactly once, only on a
valid snapshot, without touching the cursor.

Offline: local git only, no MFL, no D1, no Discord, no launchctl. The clock is the real one.
  python3 pipelines/etl/scripts/test_bot_snapshot_cutover.py
"""
import ast
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import bot_snapshot_cutover as bc  # noqa: E402
import held_trades  # noqa: E402

GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}


def sh(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, env=GIT_ENV)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def snap(as_of, weeks, broken=False):
    return json.dumps({"as_of": as_of, "season_state": {"weeks_completed": weeks}, "broken": broken}, indent=1) + "\n"


class FakeOps(bc.Ops):
    """The bot process, its Python, the suite and GitHub, simulated."""

    def __init__(self, cfg, live_weeks=6):
        super().__init__(cfg)
        self.pid, self.restarts, self.alerts, self.resolved, self.dispatches = 1000, 0, [], [], 0
        self.live_weeks, self.suite_rc, self.restart_works = live_weeks, 0, True
        self.fail_validate_in = set()            # "worktree" | "checkout"

    def fetch(self, checkout):
        pass                                     # the test moves refs/remotes/origin/main itself

    def bot_pid(self):
        return self.pid

    def restart(self):
        self.restarts += 1
        if not self.restart_works:
            return                                # process never comes back healthy
        self.pid += 1
        commit = sh(self.cfg.checkout, "rev-parse", "HEAD")
        with open(self.cfg.bot_log, "a") as fh:
            fh.write(f"[{datetime.now()}] Trade polling started (every 300s)\n")
        self.cfg.heartbeat.write_text(json.dumps({"pid": self.pid, "commit": commit, "status": "ok"}))

    def validate(self, tree):
        where = "checkout" if Path(tree).resolve() == Path(self.cfg.checkout).resolve() else "worktree"
        s = json.loads((Path(tree) / bc.SNAPSHOT).read_text())
        fails = []
        if s.get("broken") or where in self.fail_validate_in:
            fails.append("valuation snapshot: content checksum does not match")
        if s["season_state"]["weeks_completed"] < self.live_weeks:
            fails.append(f"valuation snapshot: stale: covers 2026 standings through week "
                         f"{s['season_state']['weeks_completed']}, but week {self.live_weeks} is complete")
        return {"failures": fails, "as_of": s["as_of"], "weeks": s["season_state"]["weeks_completed"],
                "live_weeks": self.live_weeks}

    def run_suite(self, tree):
        return self.suite_rc, f"Safe offline tests: {'PASS' if self.suite_rc == 0 else 'FAIL'} (fake)"

    def dispatch_daily_pull(self):
        self.dispatches += 1
        return True

    def alert(self, stage, text):
        self.alerts.append((stage, text))

    def resolve(self, text):
        self.resolved.append(text)


class Env:
    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cutover-test-")).resolve()
        self.checkout = co = self.tmp / "checkout"
        co.mkdir()
        sh(co, "init", "-q", "-b", "main")
        (co / "data/valuation").mkdir(parents=True)
        (co / bc.SNAPSHOT).write_text(snap("2026-10-20", 6))
        (co / bc.SCRIPTS).mkdir(parents=True)
        (co / bc.SCRIPTS / "trade_roast_bot.py").write_text("import held_trades\nimport trade_grader\n")
        (co / bc.SCRIPTS / "held_trades.py").write_text("X = 1\n")
        (co / bc.SCRIPTS / "trade_grader.py").write_text("import valuation_snapshot\n")
        (co / bc.SCRIPTS / "valuation_snapshot.py").write_text("Y = 1\n")
        (co / bc.SCRIPTS / "unrelated_report.py").write_text("Z = 1\n")
        (co / "README.md").write_text("seed\n")
        (co / ".gitignore").write_text("pipelines/etl/data/\n/dev/\n")
        sh(co, "add", "-A")
        sh(co, "commit", "-q", "-m", "seed")
        sh(co, "update-ref", "refs/remotes/origin/main", "HEAD")
        self.dev = self.tmp / "dev"                      # where "main on GitHub" gets new commits
        sh(co, "worktree", "add", "-q", "-b", "upstream", str(self.dev), "HEAD")
        data = co / "pipelines/etl/data"
        data.mkdir(parents=True)
        (data / "last_trade_timestamp.txt").write_text("1791320240")
        (data / "roast_tracker.json").write_text('{"m1": {"trade": 1}}')
        (data / "held_trades_no_grade.json").write_text("[]")
        (co / "local_notes.db").write_bytes(b"untracked runtime file")
        self.cfg = bc.Config(checkout=co, state_dir=self.tmp / "state", bot_log=self.tmp / "bot.log",
                             heartbeat=self.tmp / "heartbeat.json", restart_timeout=1, held_wait=0)
        self.ops = FakeOps(self.cfg)
        self.job = bc.Cutover(self.cfg, self.ops)

    def publish(self, files: dict, msg="update"):
        for rel, text in files.items():
            p = self.dev / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        sh(self.dev, "add", "-A")
        sh(self.dev, "commit", "-q", "-m", msg)
        tip = sh(self.dev, "rev-parse", "HEAD")
        sh(self.checkout, "update-ref", "refs/remotes/origin/main", tip)   # = a push + the job's fetch
        return tip

    def head(self):
        return sh(self.checkout, "rev-parse", "HEAD")

    def runtime(self):
        return bc.runtime_state(self.checkout)

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class Cutover(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.start_head, self.start_runtime = self.e.head(), self.e.runtime()

    def tearDown(self):
        self.e.close()

    def assert_untouched(self, stage, restarts=0):
        self.assertEqual(self.e.head(), self.start_head)
        self.assertEqual(self.e.runtime(), self.start_runtime)
        self.assertEqual(self.e.ops.restarts, restarts)
        self.assertEqual(self.e.ops.alerts[-1][0], stage)
        self.assertEqual(sh(self.e.checkout, "worktree", "list").count("\n"), 1)   # only dev: temp worktree removed

    def test_week_7_snapshot_reaches_the_bot_and_a_second_run_does_nothing(self):
        target = self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)}, "data(valuation): week 7")
        self.e.ops.live_weeks = 7
        res = self.e.job.run()
        self.assertEqual(res["result"], "cutover", res)
        self.assertEqual((res["as_of"], res["weeks"]), ("2026-10-27", 7))
        self.assertEqual(self.e.head(), target)
        self.assertEqual(self.e.runtime(), self.start_runtime)               # byte for byte
        self.assertEqual(self.e.ops.restarts, 1)
        self.assertEqual(res["pid"], 1001)
        self.assertEqual(self.e.ops.alerts, [])
        self.assertEqual(sh(self.e.checkout, "symbolic-ref", "--short", "HEAD"), "main")
        again = self.e.job.run()
        self.assertEqual(again["result"], "up_to_date")
        self.assertEqual(self.e.ops.restarts, 1)                              # no unnecessary restart
        self.assertEqual(sh(self.e.checkout, "rev-list", "--count", "origin/main"), "2")   # the job never commits
        self.assertEqual(self.e.head(), target)

    def test_other_main_commits_without_a_new_snapshot_are_not_pulled(self):
        self.e.publish({"README.md": "docs only\n"})
        res = self.e.job.run()
        self.assertEqual(res["result"], "no_new_snapshot")
        self.assertEqual((self.e.head(), self.e.ops.restarts), (self.start_head, 0))

    def test_never_backwards(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-13", 5)})
        self.assertEqual(self.e.job.run()["result"], "no_new_snapshot")
        self.assertEqual(self.e.head(), self.start_head)

    def test_dirty_checkout_is_left_alone(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        (self.e.checkout / "README.md").write_text("local edit\n")
        self.start_runtime = self.e.runtime()
        res = self.e.job.run()
        self.assertEqual(res["stage"], "dirty")
        self.assertEqual((self.e.checkout / "README.md").read_text(), "local edit\n")
        self.assert_untouched("dirty")

    def test_not_a_fast_forward(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        (self.e.checkout / "README.md").write_text("local commit\n")
        sh(self.e.checkout, "commit", "-q", "-am", "local")
        self.start_head = self.e.head()
        self.assertEqual(self.e.job.run()["stage"], "pull")
        self.assert_untouched("pull")

    def test_bot_code_change_needs_a_manual_cutover(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7), f"{bc.SCRIPTS}/valuation_snapshot.py": "Y = 2\n"})
        res = self.e.job.run()
        self.assertEqual(res["stage"], "code-gate")
        self.assertIn("valuation_snapshot.py", res["reason"])
        self.assert_untouched("code-gate")

    def test_unrelated_script_change_is_not_bot_code(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7), f"{bc.SCRIPTS}/unrelated_report.py": "Z = 2\n"})
        self.e.ops.live_weeks = 7
        self.assertEqual(self.e.job.run()["result"], "cutover")

    def test_ci_failure(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        self.e.ops.suite_rc = 1
        self.assertEqual(self.e.job.run()["stage"], "ci")
        self.assert_untouched("ci")

    def test_validation_failure_before_the_pull(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7, broken=True)})
        self.assertEqual(self.e.job.run()["stage"], "validate")
        self.assert_untouched("validate")

    def test_validation_failure_after_the_pull_rolls_back(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        self.e.ops.live_weeks = 7
        self.e.ops.fail_validate_in = {"checkout"}
        res = self.e.job.run()
        self.assertEqual(res["stage"], "validate")
        self.assertEqual(self.e.head(), self.start_head)                      # restored (detached)
        self.assertEqual(self.e.runtime(), self.start_runtime)
        self.assertEqual(self.e.ops.restarts, 1)                              # the previous code, restarted once
        self.assertEqual(self.e.job.run()["stage"], "checkout")               # refuses until recovered
        self.e.ops.fail_validate_in = set()
        self.assertEqual(self.e.job.recover()["result"], "cutover")
        self.assertEqual(sh(self.e.checkout, "symbolic-ref", "--short", "HEAD"), "main")
        self.assertEqual(self.e.ops.restarts, 2)
        self.assertEqual(self.e.job.run()["result"], "up_to_date")           # and no further restart
        self.assertEqual(self.e.ops.restarts, 2)

    def test_restart_failure_rolls_back(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        self.e.ops.live_weeks = 7
        self.e.ops.restart_works = False
        res = self.e.job.run()
        self.assertEqual(res["stage"], "restart")
        self.assertEqual(self.e.head(), self.start_head)
        self.assertEqual(self.e.runtime(), self.start_runtime)
        self.assertEqual(self.e.ops.restarts, 2)                              # the try, then the rollback's

    def test_runtime_state_changed_during_the_pull_rolls_back(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        real, calls = bc.runtime_state, []

        def changing(tree):
            calls.append(1)
            out = real(tree)
            if len(calls) == 2:                                               # the hash right after the pull
                out = {**out, "pipelines/etl/data/roast_tracker.json": "changed"}
            return out
        bc.runtime_state = changing
        try:
            res = self.e.job.run()
        finally:
            bc.runtime_state = real
        self.assertEqual(res["stage"], "runtime-state")
        self.assertEqual(self.e.head(), self.start_head)
        self.assertNotIn("pipelines/etl/data", self.e.ops.alerts[-1][1])      # alerts never name runtime files

    def test_overlapping_runs_are_locked_out(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        held = self.e.job.lock()
        try:
            self.assertEqual(self.e.job.run()["result"], "locked")
        finally:
            held.close()
        self.assertEqual((self.e.head(), self.e.ops.restarts), (self.start_head, 0))

    def test_pulled_but_not_restarted_is_finished_next_run(self):
        target = self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        self.e.ops.live_weeks = 7
        self.e.ops.restart_works = False
        self.e.job.run()                                                      # rolled back
        self.e.ops.restart_works = True
        self.assertEqual(self.e.job.recover()["result"], "cutover")
        self.assertEqual(self.e.head(), target)

    def test_stale_waiting_dispatches_inputs_once_and_alerts_once(self):
        self.e.ops.live_weeks = 7                                             # MFL counts week 7; no new snapshot yet
        r1 = self.e.job.run()
        self.assertEqual((r1["result"], r1["bot_would_grade"]), ("up_to_date", False))
        self.e.job.run()
        self.assertEqual(self.e.ops.dispatches, 1)                            # once per UTC day
        self.assertEqual(self.e.ops.alerts, [])
        past = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
        self.e.job.save_state(stale_since=past)
        self.e.job.run()
        self.e.job.run()
        self.assertEqual([a[0] for a in self.e.ops.alerts], ["stale"])        # one alert per stale episode
        self.assertEqual((self.e.head(), self.e.ops.restarts), (self.start_head, 0))

    def test_manual_rollback_keeps_runtime_state(self):
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7)})
        self.e.ops.live_weeks = 7
        self.e.job.run()
        res = self.e.job.rollback(self.start_head)
        self.assertEqual((res["result"], self.e.head()), ("rolled_back", self.start_head))
        self.assertEqual(self.e.runtime(), self.start_runtime)
        self.assertEqual(self.e.ops.restarts, 2)

    def test_bot_code_files_follow_imports(self):
        files = bc.bot_code_files(self.e.checkout)
        self.assertTrue({f"{bc.SCRIPTS}/trade_roast_bot.py", f"{bc.SCRIPTS}/held_trades.py",
                         f"{bc.SCRIPTS}/trade_grader.py", f"{bc.SCRIPTS}/valuation_snapshot.py"} <= files)
        self.assertNotIn(f"{bc.SCRIPTS}/unrelated_report.py", files)
        real = bc.bot_code_files(REPO)          # the real bot: its grader and snapshot modules are gated
        for name in ("trade_roast_bot", "trade_grader", "valuation_snapshot", "pick_valuation", "held_trades",
                     "trade_roast_context", "trade_announcement", "content_engine"):
            self.assertIn(f"{bc.SCRIPTS}/{name}.py", real)


class HeldTrades(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.path = self.tmp / "held.json"
        self.cursor = self.tmp / "last_trade_timestamp.txt"
        self.cursor.write_text("1791320240")
        self.trade = {"timestamp": "1791400000", "franchise": "0003", "franchise2": "0010"}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_trade_is_held_once(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)
        held_trades.record_hold(self.trade, "NO GRADE: stale again", self.path)
        entries = held_trades.load(self.path)
        self.assertEqual(len(entries), 1)
        self.assertEqual(len(entries[0]["holds"]), 1)

    def test_stale_snapshot_never_uses_up_the_retry(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)
        posted = []
        out = held_trades.retry_pending(validate=lambda: ["stale: week 7 is complete"],
                                        find_trade=lambda e: self.trade,
                                        grade_and_post=lambda e, t: posted.append(t) or "posted", path=self.path,
                                        log=lambda *_: None)
        self.assertEqual((out, posted), ([], []))
        self.assertEqual(len(held_trades.pending(held_trades.load(self.path))), 1)

    def test_exactly_once_marked_before_the_attempt(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)
        seen = []

        def post(entry, trade):
            seen.append(held_trades.load(self.path)[0].get("retry"))           # already marked started
            return "posted"
        cursor_before = hashlib.sha256(self.cursor.read_bytes()).hexdigest()
        out = held_trades.retry_pending(validate=lambda: [], find_trade=lambda e: self.trade, grade_and_post=post,
                                        path=self.path, log=lambda *_: None)
        self.assertEqual(out, [("1791400000", "posted")])
        self.assertIn("started_at", seen[0])
        again = held_trades.retry_pending(validate=lambda: [], find_trade=lambda e: self.trade, grade_and_post=post,
                                          path=self.path, log=lambda *_: None)
        self.assertEqual((again, len(seen)), ([], 1))
        self.assertEqual(hashlib.sha256(self.cursor.read_bytes()).hexdigest(), cursor_before)

    def test_held_again_and_errors_are_recorded_not_retried(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)

        def still_no_grade(entry, trade):
            held_trades.record_hold(trade, "NO GRADE: player missing", self.path)   # the bot's hold path
            return "held_again"
        held_trades.retry_pending(validate=lambda: [], find_trade=lambda e: self.trade,
                                  grade_and_post=still_no_grade, path=self.path, log=lambda *_: None)
        e = held_trades.load(self.path)[0]
        self.assertEqual(e["retry"]["outcome"], "held_again")
        self.assertEqual(e["holds"][-1]["report"], "NO GRADE: player missing")     # the hold survived the retry record
        other = {"timestamp": "1791500000", "franchise": "0001", "franchise2": "0002"}
        held_trades.record_hold(other, "NO GRADE", self.path)

        def boom(entry, trade):
            raise RuntimeError("discord down")
        held_trades.retry_pending(validate=lambda: [], find_trade=lambda e: other, grade_and_post=boom,
                                  path=self.path, log=lambda *_: None)
        self.assertEqual(held_trades.load(self.path)[1]["retry"]["outcome"], "error: RuntimeError")
        self.assertEqual(held_trades.pending(held_trades.load(self.path)), [])

    def test_corrupt_file_is_not_silently_replaced(self):
        self.path.write_text("{not json")
        with self.assertRaises(ValueError):
            held_trades.record_hold(self.trade, "x", self.path)
        self.assertEqual(self.path.read_text(), "{not json")

    def test_a_held_trade_grades_after_cutover_on_the_real_grader(self):
        """The pinned 10-20 snapshot (#1365 fixture): stale under week 7 (stays held), then
        graded non-provisional when the snapshot is fresh."""
        import test_valuation_snapshot as T                      # pinned fixture + grade() helper
        trade = {"timestamp": T.grader_inputs(T.TRADES[T.GRIDE_BLAKE])[0]["timestamp"], "franchise": "0003",
                 "franchise2": "0010"}
        held_trades.record_hold(trade, "NO GRADE: stale", self.path)
        stale = T.grade(T.snapshot(), T.live_state(7))
        self.assertTrue(stale.no_grade)
        out = held_trades.retry_pending(validate=lambda: list(stale.no_grade_reasons), find_trade=lambda e: trade,
                                        grade_and_post=lambda e, t: "posted", path=self.path, log=lambda *_: None)
        self.assertEqual(out, [])                                 # still held, retry not used
        graded = {}

        def grade_and_post(entry, t):
            an = T.grade(T.snapshot(), T.live_state(6))
            graded["an"] = an
            return "held_again" if an.no_grade else "posted"
        out = held_trades.retry_pending(validate=lambda: [], find_trade=lambda e: trade,
                                        grade_and_post=grade_and_post, path=self.path, log=lambda *_: None)
        self.assertEqual(out, [(trade["timestamp"], "posted")])
        self.assertFalse(graded["an"].no_grade)
        self.assertEqual(graded["an"].provisional_reasons, [])


class BotHook(unittest.TestCase):
    """trade_roast_bot needs discord.py and Keychain secrets at import: checked on its source."""

    @classmethod
    def setUpClass(cls):
        cls.tree = ast.parse((SCRIPT_DIR / "trade_roast_bot.py").read_text())

    def fn(self, name):
        return next(n for n in ast.walk(self.tree)
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)

    def calls(self, fn):
        return [(n.lineno, getattr(n.func, "attr", None) or getattr(n.func, "id", None))
                for n in ast.walk(fn) if isinstance(n, ast.Call)]

    def first(self, fn, name):
        return min(l for l, c in self.calls(fn) if c == name)

    def test_retry_validates_then_marks_then_posts(self):
        fn = self.fn("retry_held_trades")
        self.assertLess(self.first(fn, "_in_executor"), self.first(fn, "mark_started"))
        self.assertLess(self.first(fn, "mark_started"), self.first(fn, "analyze_and_post"))
        self.assertLess(self.first(fn, "mark_started"), self.first(fn, "analyze_and_post_multiway"))
        src = ast.unparse(fn)
        for banned in ("save_last_trade_ts", "get_last_trade_ts", "LAST_TRADE_FILE"):
            self.assertNotIn(banned, src)
        self.assertIn("_snapshot_failures_now", src)

    def test_poll_loop_retries_after_new_trades_and_holds_record_once(self):
        poll = self.fn("poll_for_trades")
        self.assertIn("retry_held_trades", [c for _, c in self.calls(poll)])
        self.assertIn("record_hold", [c for _, c in self.calls(self.fn("hold_no_grade"))])
        self.assertIn("return True", ast.unparse(self.fn("analyze_and_post")).splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
