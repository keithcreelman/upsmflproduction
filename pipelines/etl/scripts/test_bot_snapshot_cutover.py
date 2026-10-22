#!/usr/bin/env python3
"""The bot's snapshot cutover and the held-trade retry (Keith 2026-10-21/22, companion to #1357).

bot_snapshot_cutover.py runs on a throwaway git repository: the bot's "checkout", whose
refs/remotes/origin/main the test advances from a worktree (the safe suite allows no clone, fetch
or push, so Ops.fetch is a no-op here), with a fake bot process: restart = a new pid, a "Trade
polling started" log line, a heartbeat with that pid and commit, and (when asked) the bot's one
retry of each held trade. Each stage's failure is shown to leave the checkout, the runtime state
and the running bot as they were (or restored) and to alert naming the stage.

Fail closed (Keith 2026-10-22): a missing, corrupt or unwritable held-trades file is never zero
held trades; a hold that cannot be recorded keeps the bot's cursor; the cutover succeeds only if
every exact held entry finishes "posted" (anything else is manual review, nothing retried twice);
trades match on their full key; every GitHub alert call is checked, with a local record and a
Mac notification when one fails; a failed dispatch does not use up the day.

Offline: local git only, no MFL, no D1, no Discord, no launchctl, no gh, no osascript.
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
HELD = "pipelines/etl/data/held_trades_no_grade.json"
NO_LOG = lambda *_: None  # noqa: E731


def sh(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, env=GIT_ENV)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def snap(as_of, weeks, broken=False):
    return json.dumps({"as_of": as_of, "season_state": {"weeks_completed": weeks}, "broken": broken}, indent=1) + "\n"


def trade(ts, a, b):
    return {"timestamp": str(ts), "franchise": a, "franchise2": b}


class FakeOps(bc.Ops):
    """The bot process, its Python, the suite and GitHub, simulated. GitHub calls go through a fake
    gh() so the real Ops.alert / Ops.resolve logic (every call checked) is what runs."""

    def __init__(self, cfg, live_weeks=6):
        super().__init__(cfg)
        self.pid, self.restarts, self.dispatches, self.notices = 1000, 0, 0, []
        self.live_weeks, self.suite_rc, self.restart_works, self.dispatch_ok = live_weeks, 0, True, True
        self.fail_validate_in = set()            # "worktree" | "checkout"
        self.gh_fail = set()                     # "label" | "list" | "create" | "comment" | "close"
        self.issues, self.gh_calls = {}, []      # number -> {"open", "title", "comments"}
        self.bot_retry = None                    # callable(held_path) the restarted bot runs once

    # GitHub, faked at the gh() boundary
    def gh(self, *args):
        self.gh_calls.append(args)
        op = "label" if args and args[0] == "label" else args[1] if args and args[0] == "issue" else ""
        if op in self.gh_fail:
            return subprocess.CompletedProcess(args, 1, "", f"HTTP 502 ({op})")
        if args[:2] == ("issue", "list"):
            open_ = [n for n, i in self.issues.items() if i["open"]]
            return subprocess.CompletedProcess(args, 0, f"{open_[0]}\n" if open_ else "\n", "")
        if args[:2] == ("issue", "create"):
            n = str(len(self.issues) + 1)
            self.issues[n] = {"open": True, "title": args[args.index("--title") + 1], "comments": []}
            return subprocess.CompletedProcess(args, 0, f"https://github.com/x/y/issues/{n}\n", "")
        if args[:2] == ("issue", "comment"):
            self.issues[args[2]]["comments"].append(args[args.index("--body") + 1])
        if args[:2] == ("issue", "close"):
            self.issues[args[2]]["open"] = False
        return subprocess.CompletedProcess(args, 0, "", "")

    def notify(self, title, text):
        self.notices.append((title, text))
        return True

    @property
    def alerts(self):
        out = []
        for n, i in sorted(self.issues.items(), key=lambda kv: int(kv[0])):
            out.append(i["title"].rsplit(": ", 1)[-1])
            out += [c.split("stage: ", 1)[1].split("**", 1)[0] for c in i["comments"] if c.startswith("**Trade bot")]
        return out

    def open_issue(self):
        return any(i["open"] for i in self.issues.values())

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
        if self.bot_retry:
            self.bot_retry(self.cfg.held_file)

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
        return self.dispatch_ok


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
        (co / ".gitignore").write_text("pipelines/etl/data/\n")
        sh(co, "add", "-A")
        sh(co, "commit", "-q", "-m", "seed")
        sh(co, "update-ref", "refs/remotes/origin/main", "HEAD")
        self.dev = self.tmp / "dev"                      # where "main on GitHub" gets new commits
        sh(co, "worktree", "add", "-q", "-b", "upstream", str(self.dev), "HEAD")
        data = co / "pipelines/etl/data"
        data.mkdir(parents=True)
        (data / "last_trade_timestamp.txt").write_text("1791320240")
        (data / "roast_tracker.json").write_text('{"m1": {"trade": 1}}')
        held_trades.init(co / HELD)
        (co / "local_notes.db").write_bytes(b"untracked runtime file")
        self.cfg = bc.Config(checkout=co, state_dir=self.tmp / "state", bot_log=self.tmp / "bot.log",
                             heartbeat=self.tmp / "heartbeat.json", restart_timeout=1, held_wait=0,
                             ops_alert_file=self.tmp / "ops_alerts.json")
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

    def week7(self):
        self.ops.live_weeks = 7
        return self.publish({bc.SNAPSHOT: snap("2026-10-27", 7)}, "data(valuation): week 7")

    def hold(self, *trades):
        for t in trades:
            held_trades.record_hold(t, "VALUATION INPUTS UNAVAILABLE — NO GRADE (stale)", self.checkout / HELD)

    def head(self):
        return sh(self.checkout, "rev-parse", "HEAD")

    def runtime(self):
        return bc.runtime_state(self.checkout)

    def close(self):
        for p in [self.tmp, *self.tmp.rglob("*")]:
            try:
                p.chmod(0o755 if p.is_dir() else 0o644)
            except OSError:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)


def bot_retries(outcome_for):
    """The restarted bot's one retry of each pending held entry: outcome_for(key) -> outcome,
    or "CRASH" (marked started, never finished)."""
    def run(path):
        for e in held_trades.pending(held_trades.load(path)):
            held_trades.mark_started(e, path)
            o = outcome_for(held_trades.key(e))
            if o != "CRASH":
                held_trades.mark_finished(e, o, path)
    return run


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
        self.assertEqual(self.e.ops.alerts[-1], stage)
        self.assertEqual(sh(self.e.checkout, "worktree", "list").count("\n"), 1)   # only dev: temp worktree removed

    def test_week_7_snapshot_reaches_the_bot_and_a_second_run_does_nothing(self):
        target = self.e.week7()
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
        self.e.week7()
        (self.e.checkout / "README.md").write_text("local edit\n")
        self.start_runtime = self.e.runtime()
        self.assertEqual(self.e.job.run()["stage"], "dirty")
        self.assertEqual((self.e.checkout / "README.md").read_text(), "local edit\n")
        self.assert_untouched("dirty")

    def test_not_a_fast_forward(self):
        self.e.week7()
        (self.e.checkout / "README.md").write_text("local commit\n")
        sh(self.e.checkout, "commit", "-q", "-am", "local")
        self.start_head = self.e.head()
        self.assertEqual(self.e.job.run()["stage"], "pull")
        self.assert_untouched("pull")

    def test_bot_code_change_needs_a_manual_cutover(self):
        self.e.ops.live_weeks = 7
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7), f"{bc.SCRIPTS}/valuation_snapshot.py": "Y = 2\n"})
        res = self.e.job.run()
        self.assertEqual(res["stage"], "code-gate")
        self.assertIn("valuation_snapshot.py", res["reason"])
        self.assert_untouched("code-gate")

    def test_unrelated_script_change_is_not_bot_code(self):
        self.e.ops.live_weeks = 7
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7), f"{bc.SCRIPTS}/unrelated_report.py": "Z = 2\n"})
        self.assertEqual(self.e.job.run()["result"], "cutover")

    def test_ci_failure(self):
        self.e.week7()
        self.e.ops.suite_rc = 1
        self.assertEqual(self.e.job.run()["stage"], "ci")
        self.assert_untouched("ci")

    def test_validation_failure_before_the_pull(self):
        self.e.ops.live_weeks = 7
        self.e.publish({bc.SNAPSHOT: snap("2026-10-27", 7, broken=True)})
        self.assertEqual(self.e.job.run()["stage"], "validate")
        self.assert_untouched("validate")

    def test_validation_failure_after_the_pull_rolls_back(self):
        self.e.week7()
        self.e.ops.fail_validate_in = {"checkout"}
        self.assertEqual(self.e.job.run()["stage"], "validate")
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
        self.e.week7()
        self.e.ops.restart_works = False
        self.assertEqual(self.e.job.run()["stage"], "restart")
        self.assertEqual(self.e.head(), self.start_head)
        self.assertEqual(self.e.runtime(), self.start_runtime)
        self.assertEqual(self.e.ops.restarts, 2)                              # the try, then the rollback's

    def test_runtime_state_changed_during_the_pull_rolls_back(self):
        self.e.week7()
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
        body = " ".join(c for i in self.e.ops.issues.values() for c in [i["title"], *i["comments"]])
        self.assertNotIn("pipelines/etl/data", body)                          # alerts never name runtime files

    def test_overlapping_runs_are_locked_out(self):
        self.e.week7()
        held = self.e.job.lock()
        try:
            self.assertEqual(self.e.job.run()["result"], "locked")
        finally:
            held.close()
        self.assertEqual((self.e.head(), self.e.ops.restarts), (self.start_head, 0))

    def test_pulled_but_not_restarted_is_finished_next_run(self):
        target = self.e.week7()
        self.e.ops.restart_works = False
        self.e.job.run()                                                      # rolled back
        self.e.ops.restart_works = True
        self.assertEqual(self.e.job.recover()["result"], "cutover")
        self.assertEqual(self.e.head(), target)

    def test_manual_rollback_keeps_runtime_state(self):
        self.e.week7()
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

    # ── 1. held state fails closed ─────────────────────────────────────────
    def test_corrupt_or_missing_held_file_stops_before_the_pull(self):
        for name, damage in (("corrupt", lambda p: p.write_text("{not json")), ("missing", lambda p: p.unlink()),
                             ("not a list", lambda p: p.write_text('{"a": 1}'))):
            with self.subTest(name):
                e = Env()
                try:
                    e.week7()
                    damage(e.checkout / HELD)
                    head, rt = e.head(), e.runtime()
                    res = e.job.run()
                    self.assertEqual((res["result"], res["stage"]), ("stopped", "held-state"))
                    self.assertEqual((e.head(), e.runtime(), e.ops.restarts), (head, rt, 0))
                    self.assertEqual(e.ops.alerts, ["held-state"])
                finally:
                    e.close()

    # ── 2. exact held entries reconciled across the restart ───────────────
    def test_all_exact_held_entries_posted_is_a_cutover(self):
        a, b = trade(1792900000, "0003", "0010"), trade(1792900000, "0001", "0005")
        self.e.hold(a, b)
        self.e.week7()
        self.e.ops.bot_retry = bot_retries(lambda k: "posted")
        res = self.e.job.run()
        self.assertEqual(res["result"], "cutover", res)
        self.assertEqual(sorted(k for k, _ in res["held"]["outcomes"]),
                         sorted([held_trades.key(a), held_trades.key(b)]))
        self.assertFalse(self.e.ops.open_issue())

    def test_held_again_error_crash_or_missing_is_manual_review(self):
        cases = {"held_again": "held_again", "error": "error: RuntimeError", "crash after started": "CRASH"}
        for name, outcome in cases.items():
            with self.subTest(name):
                e = Env()
                try:
                    a, b = trade(1792900000, "0003", "0010"), trade(1792901000, "0004", "0002")
                    e.hold(a, b)
                    e.week7()
                    e.ops.bot_retry = bot_retries(lambda k: outcome if k == held_trades.key(a) else "posted")
                    res = e.job.run()
                    self.assertEqual(res["result"], "manual_review", res)
                    got = dict(res["held"]["outcomes"])
                    self.assertEqual(got[held_trades.key(b)], "posted")
                    self.assertEqual(got[held_trades.key(a)],
                                     "started, never finished" if outcome == "CRASH" else outcome)
                    self.assertTrue(e.ops.open_issue())                       # alert kept open
                    self.assertIn("held-review", e.ops.alerts)
                    e.ops.bot_retry = bot_retries(lambda k: self.fail(f"second attempt of {k}"))
                    self.assertEqual(e.job.run()["result"], "up_to_date")     # nothing attempted twice
                    self.assertEqual(held_trades.pending(held_trades.load(e.checkout / HELD)), [])
                finally:
                    e.close()

    def test_entry_missing_or_file_unreadable_after_restart_is_manual_review(self):
        a = trade(1792900000, "0003", "0010")
        self.e.hold(a)
        self.e.week7()
        self.e.ops.bot_retry = lambda path: path.write_text("{garbled")
        res = self.e.job.run()
        self.assertEqual(res["result"], "manual_review")
        self.assertIn("unreadable", res["held"]["outcomes"][0][1])

    def test_a_retry_started_before_this_cutover_is_manual_review(self):
        a = trade(1792900000, "0003", "0010")
        self.e.hold(a)
        held_trades.mark_started(a, self.e.checkout / HELD)                   # a crash on an earlier poll
        self.e.week7()
        res = self.e.job.run()
        self.assertEqual(res["result"], "manual_review")
        self.assertIn("never finished", res["held"]["outcomes"][0][1])

    # ── 4. alert delivery is verified ──────────────────────────────────────
    def test_failed_issue_create_label_or_list_is_recorded_and_notified(self):
        for op in ("create", "label", "list"):
            with self.subTest(op):
                e = Env()
                try:
                    e.week7()
                    e.ops.suite_rc = 1
                    e.ops.gh_fail = {op}
                    res = e.job.run()
                    self.assertEqual((res["result"], res["stage"]), ("stopped", "ci"))
                    self.assertIn("alert_delivery", res)
                    fails = json.loads((e.cfg.state_dir / "alert_failures.json").read_text())
                    self.assertEqual(fails[-1]["stage"], "ci")
                    self.assertTrue(e.ops.notices)
                finally:
                    e.close()

    def test_failed_comment_on_an_open_incident(self):
        self.e.week7()
        self.e.ops.suite_rc = 1
        self.e.job.run()                                                      # opens the incident
        self.e.ops.gh_fail = {"comment"}
        res = bc.Cutover(self.e.cfg, self.e.ops).run()
        self.assertIn("alert_delivery", res)
        self.assertTrue(self.e.ops.notices)

    def test_failed_close_never_reports_success(self):
        self.e.week7()
        self.e.ops.suite_rc = 1
        self.e.job.run()                                                      # incident open
        self.e.ops.suite_rc = 0
        self.e.ops.gh_fail = {"close"}
        res = bc.Cutover(self.e.cfg, self.e.ops).run()
        self.assertEqual(res["result"], "cutover_unconfirmed")
        self.assertIn("incident", res)
        self.assertTrue(self.e.ops.open_issue())
        self.assertEqual(json.loads((self.e.cfg.state_dir / "alert_failures.json").read_text())[-1]["stage"], "resolve")
        self.assertTrue(self.e.ops.notices)

    def test_main_exit_code_is_nonzero_when_alerting_failed(self):
        self.e.week7()
        self.e.ops.suite_rc = 1
        self.e.ops.gh_fail = {"create"}
        real_cfg, real_cut = bc.Config, bc.Cutover
        bc.Config = lambda: self.e.cfg
        bc.Cutover = lambda cfg, log=None: real_cut(cfg, self.e.ops, log)
        try:
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bc.main(["run"]), 1)
        finally:
            bc.Config, bc.Cutover = real_cfg, real_cut

    def test_bot_ops_alerts_are_forwarded_and_kept_until_delivered(self):
        self.e.cfg.ops_alert_file.write_text(json.dumps([{"at": "x", "stage": "held-state",
                                                          "text": "hold could not be recorded", "forwarded": False}]))
        self.e.ops.gh_fail = {"create"}
        self.e.job.run()
        self.assertFalse(json.loads(self.e.cfg.ops_alert_file.read_text())[0]["forwarded"])
        self.e.ops.gh_fail = set()
        bc.Cutover(self.e.cfg, self.e.ops).run()
        self.assertTrue(json.loads(self.e.cfg.ops_alert_file.read_text())[0]["forwarded"])
        self.assertIn("bot-held-state", self.e.ops.alerts)

    # ── 5. a failed dispatch does not use up the day ───────────────────────
    def test_failed_dispatch_alerts_once_and_retries_a_bounded_number_of_times(self):
        self.e.ops.live_weeks = 7                                             # MFL counts week 7; no snapshot yet
        self.e.ops.dispatch_ok = False
        for _ in range(6):
            bc.Cutover(self.e.cfg, self.e.ops).run()
        self.assertEqual(self.e.ops.dispatches, self.e.cfg.dispatch_attempts_per_day)   # bounded
        self.assertEqual(self.e.ops.alerts.count("inputs"), 1)                # no alert spam
        self.assertIsNone(self.e.job.state().get("dispatched_day"))           # the day was not used up
        e2 = Env()
        try:
            e2.ops.live_weeks, e2.ops.dispatch_ok = 7, False
            e2.job.run()
            e2.ops.dispatch_ok = True
            bc.Cutover(e2.cfg, e2.ops).run()
            self.assertEqual(e2.ops.dispatches, 2)
            self.assertEqual(e2.job.state()["dispatched_day"], datetime.now(timezone.utc).strftime("%Y-%m-%d"))
            bc.Cutover(e2.cfg, e2.ops).run()
            self.assertEqual(e2.ops.dispatches, 2)                            # once it succeeded: once a day
        finally:
            e2.close()

    def test_stale_waiting_alerts_once_after_six_hours(self):
        self.e.ops.live_weeks = 7
        r1 = self.e.job.run()
        self.assertEqual((r1["result"], r1["bot_would_grade"]), ("up_to_date", False))
        self.assertEqual([a for a in self.e.ops.alerts if a != "inputs"], [])
        past = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
        self.e.job.save_state(stale_since=past)
        self.e.job.run()
        self.e.job.run()
        self.assertEqual([a for a in self.e.ops.alerts if a == "stale"], ["stale"])   # one alert per stale episode
        self.assertEqual((self.e.head(), self.e.ops.restarts), (self.start_head, 0))


class Ops(unittest.TestCase):
    """The real Ops.alert / Ops.resolve, every gh call checked."""

    def setUp(self):
        self.e = Env()

    def tearDown(self):
        self.e.close()

    def test_alert_and_resolve_results(self):
        o = self.e.ops
        self.assertTrue(o.alert("ci", "x")[0])
        self.assertTrue(o.alert("ci", "y")[0])                                # comments on the open issue
        o.gh_fail = {"comment"}
        self.assertFalse(o.alert("ci", "z")[0])
        o.gh_fail = {"close"}
        self.assertFalse(o.resolve("ok")[0])
        self.assertTrue(o.open_issue())
        o.gh_fail = set()
        self.assertTrue(o.resolve("ok")[0])
        self.assertFalse(o.open_issue())
        self.assertEqual(o.resolve("ok"), (True, "no open incident"))
        o.gh_fail = {"list"}
        self.assertFalse(o.resolve("ok")[0])                                  # cannot ask: never "resolved"
        o.gh_fail = {"create"}
        self.assertFalse(o.alert("ci", "w")[0])


class HeldTrades(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.path = self.tmp / "held.json"
        held_trades.init(self.path)
        self.cursor = self.tmp / "last_trade_timestamp.txt"
        self.cursor.write_text("1791320240")
        self.trade = trade(1792900000, "0003", "0010")

    def tearDown(self):
        for p in [self.tmp, *self.tmp.rglob("*")]:
            p.chmod(0o755 if p.is_dir() else 0o644)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def retry(self, trades, post, validate=lambda: []):
        return held_trades.retry_pending(validate=validate, trades=trades, grade_and_post=post, path=self.path,
                                         log=NO_LOG)

    def test_a_trade_is_held_once(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)
        held_trades.record_hold(self.trade, "NO GRADE: stale again", self.path)
        entries = held_trades.load(self.path)
        self.assertEqual(len(entries), 1)
        self.assertEqual(len(entries[0]["holds"]), 1)

    def test_missing_corrupt_unreadable_or_unwritable_is_an_error_never_zero(self):
        self.path.unlink()
        with self.assertRaises(held_trades.HeldStateError):
            held_trades.load(self.path)
        with self.assertRaises(held_trades.HeldStateError):
            held_trades.record_hold(self.trade, "x", self.path)              # never creates it silently
        self.assertFalse(self.path.exists())
        self.path.write_text("{not json")
        with self.assertRaises(held_trades.HeldStateError):
            held_trades.retry_pending(validate=lambda: [], trades=[], grade_and_post=None, path=self.path, log=NO_LOG)
        self.assertEqual(self.path.read_text(), "{not json")
        held_trades.save([], self.path)
        self.path.chmod(0o000)
        if not os.access(self.path, os.R_OK):                                 # (root ignores modes)
            with self.assertRaises(held_trades.HeldStateError):
                held_trades.load(self.path)
        self.path.chmod(0o644)
        self.tmp.chmod(0o555)                                                 # folder read-only: unwritable
        try:
            if not os.access(self.tmp, os.W_OK):
                with self.assertRaises(held_trades.HeldStateError):
                    held_trades.record_hold(self.trade, "x", self.path)
                self.assertEqual(held_trades.load(self.path), [])             # unchanged
        finally:
            self.tmp.chmod(0o755)

    def test_stale_snapshot_never_uses_up_the_retry(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)
        posted = []
        out = self.retry([self.trade], lambda e, t: posted.append(t) or "posted",
                         validate=lambda: ["stale: week 7 is complete"])
        self.assertEqual((out, posted), ([], []))
        self.assertEqual(len(held_trades.pending(held_trades.load(self.path))), 1)

    def test_exactly_once_marked_before_the_attempt(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)
        seen = []

        def post(entry, t):
            seen.append(held_trades.load(self.path)[0].get("retry"))           # already marked started
            return "posted"
        cursor_before = hashlib.sha256(self.cursor.read_bytes()).hexdigest()
        self.assertEqual(self.retry([self.trade], post), [(held_trades.key(self.trade), "posted")])
        self.assertIn("started_at", seen[0])
        self.assertEqual((self.retry([self.trade], post), len(seen)), ([], 1))
        self.assertEqual(hashlib.sha256(self.cursor.read_bytes()).hexdigest(), cursor_before)

    def test_crash_after_started_before_finished_is_never_retried(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)

        def crash(entry, t):
            raise SystemExit("the bot process died mid-retry")
        with self.assertRaises(SystemExit):
            self.retry([self.trade], crash)
        e = held_trades.load(self.path)[0]
        self.assertIn("started_at", e["retry"])
        self.assertNotIn("outcome", e["retry"])
        self.assertEqual(held_trades.unfinished(held_trades.load(self.path)), [e])
        self.assertEqual(self.retry([self.trade], lambda *_: self.fail("retried twice")), [])

    def test_held_again_and_errors_are_recorded_not_retried(self):
        held_trades.record_hold(self.trade, "NO GRADE: stale", self.path)

        def still_no_grade(entry, t):
            held_trades.record_hold(t, "NO GRADE: player missing", self.path)    # the bot's hold path
            return "held_again"
        self.retry([self.trade], still_no_grade)
        e = held_trades.load(self.path)[0]
        self.assertEqual(e["retry"]["outcome"], "held_again")
        self.assertEqual(e["holds"][-1]["report"], "NO GRADE: player missing")   # the hold survived
        other = trade(1792950000, "0001", "0002")
        held_trades.record_hold(other, "NO GRADE", self.path)

        def boom(entry, t):
            raise RuntimeError("discord down")
        self.retry([other], boom)
        self.assertEqual(held_trades.load(self.path)[1]["retry"]["outcome"], "error: RuntimeError")
        self.assertEqual(held_trades.pending(held_trades.load(self.path)), [])

    # ── 3. full key, never timestamp alone ─────────────────────────────────
    def test_two_trades_sharing_a_timestamp_select_the_exact_one(self):
        held = trade(1792900000, "0003", "0010")
        same_second = trade(1792900000, "0001", "0005")                      # a different trade, same timestamp
        history = [trade(ts, "0006", "0007") for ts in (1774623376, 1791320240)]
        held_trades.record_hold(held, "NO GRADE: stale", self.path)
        self.assertIs(held_trades.find_trade({**held}, [same_second, *history, held]), held)
        graded = []
        self.retry([same_second, *history, held], lambda e, t: graded.append(t) or "posted")
        self.assertEqual(graded, [held])                                      # nothing outside the exact held set
        self.assertIsNone(held_trades.find_trade(held, [same_second]))        # never by timestamp alone
        self.assertIsNone(held_trades.find_trade(held, [held, dict(held)]))   # ambiguous: not attempted
        mw = {"timestamp": "1792900000", "franchise": "multiway", "franchise2": "uuid-1"}
        self.assertEqual(held_trades.find_trade(mw, [], {"uuid-1": ["leg1", "leg2"], "uuid-2": ["x"]}), ["leg1", "leg2"])

    def test_a_held_trade_grades_after_cutover_on_the_real_grader(self):
        """The pinned 10-20 snapshot (#1365 fixture): stale under week 7 (stays held), then graded
        non-provisional when the snapshot is fresh."""
        import test_valuation_snapshot as T
        txn = T.grader_inputs(T.TRADES[T.GRIDE_BLAKE])[0]
        held_trades.record_hold(txn, "NO GRADE: stale", self.path)
        stale = T.grade(T.snapshot(), T.live_state(7))
        self.assertTrue(stale.no_grade)
        self.assertEqual(self.retry([txn], lambda e, t: "posted", validate=lambda: list(stale.no_grade_reasons)), [])
        graded = {}

        def grade_and_post(entry, t):
            graded["an"] = an = T.grade(T.snapshot(), T.live_state(6))
            return "held_again" if an.no_grade else "posted"
        self.assertEqual(self.retry([txn], grade_and_post), [(held_trades.key(txn), "posted")])
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

    def calls(self, node):
        return [(n.lineno, getattr(n.func, "attr", None) or getattr(n.func, "id", None))
                for n in ast.walk(node) if isinstance(n, ast.Call)]

    def first(self, fn, name):
        return min(l for l, c in self.calls(fn) if c == name)

    def test_retry_validates_then_matches_by_full_key_then_marks_then_posts(self):
        fn = self.fn("retry_held_trades")
        self.assertLess(self.first(fn, "_in_executor"), self.first(fn, "mark_started"))
        self.assertLess(self.first(fn, "find_trade"), self.first(fn, "mark_started"))
        self.assertLess(self.first(fn, "mark_started"), self.first(fn, "analyze_and_post"))
        self.assertLess(self.first(fn, "mark_started"), self.first(fn, "analyze_and_post_multiway"))
        src = ast.unparse(fn)
        for banned in ("save_last_trade_ts", "get_last_trade_ts", "LAST_TRADE_FILE", "by_ts"):
            self.assertNotIn(banned, src)
        self.assertIn("_ops_alert", src)                                      # unreadable / unfinished alert

    def test_a_hold_that_cannot_be_recorded_keeps_the_cursor(self):
        hold = self.fn("hold_no_grade")
        self.assertFalse([n for n in ast.walk(hold) if isinstance(n, ast.Try)])   # errors propagate
        self.assertIn("record_hold", [c for _, c in self.calls(hold)])
        poll = self.fn("poll_for_trades")
        tries = [n for n in ast.walk(poll) if isinstance(n, ast.Try)
                 and any(h.type is not None and "HeldStateError" in ast.unparse(h.type) for h in n.handlers)]
        self.assertEqual(len(tries), 2)                                       # 2-party and multi-team paths
        for t in tries:
            first = t.handlers[0]                                             # caught before the generic handler
            self.assertIn("HeldStateError", ast.unparse(first.type))
            names = [c for _, c in self.calls(first)]
            self.assertIn("_ops_alert", names)
            self.assertNotIn("save_last_trade_ts", names)
            self.assertTrue(any(isinstance(n, ast.Break) for n in ast.walk(first)))
        self.assertIn("retry_held_trades", [c for _, c in self.calls(poll)])
        self.assertIn("return True", ast.unparse(self.fn("analyze_and_post")).splitlines()[-1])

    def test_ops_alert_is_durable_and_never_discord(self):
        src = ast.unparse(self.fn("_ops_alert"))
        self.assertIn("OPS_ALERT_FILE", src)
        self.assertIn("osascript", src)
        for banned in ("_dm_commish", ".send(", "discord."):
            self.assertNotIn(banned, src)


if __name__ == "__main__":
    unittest.main()
