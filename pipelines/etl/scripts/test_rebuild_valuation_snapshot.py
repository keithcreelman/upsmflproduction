#!/usr/bin/env python3
"""Snapshot automation (Keith 2026-10-21): rebuild after each completed week, validate freshness and source coverage,
keep the previous valid snapshot on failure, and report NO GRADE risk instead of letting the grader grade stale data.

Runs rebuild_valuation_snapshot.py on copies of the real 2026-10-20 MFL daily snapshot in a temporary folder (a Week 7
copy has 11 more All-Play games per team). The clock is pinned. Offline: no MFL, no D1, no network, no git writes.

Pinned (#1365): the starting snapshot, its inputs and the 2026-10-20 MFL folder are the frozen copies in
tests/fixtures/valuation_snapshot_2026-10-20/, and every build and validation here resolves paths in that tree.
The committed production snapshot is never read, so the automation's own weekly commits (or a registry
refresh) cannot change these results.
  python3 pipelines/etl/scripts/test_rebuild_valuation_snapshot.py
"""
import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import rebuild_valuation_snapshot as rb  # noqa: E402
import valuation_snapshot as vs  # noqa: E402
import trade_grader as tg  # noqa: E402

BASE_DAY = "2026-10-20"
PINNED_ROOT = REPO / "tests" / "fixtures" / "valuation_snapshot_2026-10-20"
BASE = PINNED_ROOT / "data" / "mfl-snapshots" / BASE_DAY
COMMITTED = PINNED_ROOT / "data" / "valuation" / "trade_valuation_snapshot.json"   # the pinned 10-20 / week 6 snapshot
_SAVED = {}


def setUpModule():
    """Resolve every input, coefficient and recorded path in the pinned tree, not the live repo."""
    _SAVED.update(bvs_repo=rb.bvs.REPO, inputs=rb.bvs.INPUT_DIR, coef=rb.bvs.COEFFICIENTS, vs_repo=vs.REPO,
                  ident=rb.bvs.generator_identity)
    identity = rb.bvs.generator_identity(False)          # the committed generator, read from the real checkout
    rb.bvs.generator_identity = lambda allow_dirty=False: identity
    rb.bvs.REPO = PINNED_ROOT
    rb.bvs.INPUT_DIR = PINNED_ROOT / "pipelines" / "etl" / "inputs" / "valuation"
    rb.bvs.COEFFICIENTS = PINNED_ROOT / "pipelines" / "etl" / "config" / "future_pick_inseason_coefficients.json"
    vs.REPO = PINNED_ROOT


def tearDownModule():
    rb.bvs.REPO, rb.bvs.INPUT_DIR, rb.bvs.COEFFICIENTS, vs.REPO, rb.bvs.generator_identity = (
        _SAVED["bvs_repo"], _SAVED["inputs"], _SAVED["coef"], _SAVED["vs_repo"], _SAVED["ident"])


def utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def add_week(standings: dict) -> dict:
    """One more completed week: every team gets 11 more All-Play results (6-5 here)."""
    s = json.loads(json.dumps(standings))
    for r in s["leagueStandings"]["franchise"]:
        w, l, t = (int(x) for x in str(r["all_play_wlt"]).split("-"))
        r["all_play_wlt"] = f"{w + 6}-{l + 5}-{t}"
    return s


class Env:
    """A temporary data/mfl-snapshots and a copy of the committed valuation snapshot."""
    def __init__(self):
        # inside the pinned tree (a dot-directory, removed after each test): the builder records inputs as paths
        # relative to it
        self.td = tempfile.TemporaryDirectory(prefix=".valuation-rebuild-test-", dir=PINNED_ROOT)
        self.root = Path(self.td.name)
        self.snaps = self.root / "mfl-snapshots"
        self.out = self.root / "trade_valuation_snapshot.json"
        shutil.copy(COMMITTED, self.out)

    def folder(self, day, weeks_plus=0, edit=None):
        d = self.snaps / day
        shutil.copytree(BASE, d)
        st = json.loads((d / "leagueStandings.json").read_text())
        for _ in range(weeks_plus):
            st = add_week(st)
        (d / "leagueStandings.json").write_text(json.dumps(st))
        if edit:
            edit(d)
        return d

    def rebuild(self, now, **kw):
        return rb.do_rebuild(now=utc(now), generated_at=now, out=self.out, snapshots_dir=self.snaps, **kw)

    def close(self):
        self.td.cleanup()


class Rebuild(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.before = self.env.out.read_bytes()

    def tearDown(self):
        self.env.close()

    def test_rebuilds_after_a_completed_week_and_the_bot_accepts_it(self):
        self.env.folder("2026-10-27", weeks_plus=1)
        st = self.env.rebuild("2026-10-27T09:30:00Z")
        self.assertEqual(st["result"], "rebuilt", st)
        self.assertEqual((st["exit"], st["weeks_completed"], st["as_of"]), (0, 7, "2026-10-27"))
        self.assertIn("week 7 is complete; the snapshot covers week 6", st["why"])
        new = json.loads(self.env.out.read_text())
        self.assertEqual(new["season_state"]["weeks_completed"], 7)
        # exactly the bot's check with Week 7 complete: no failures
        self.assertEqual(vs.validate_snapshot(new, now=utc("2026-10-27T09:30:00Z").timestamp(), league_season=2026,
                                              live_weeks_completed=7), [])
        # and the old one, under the same conditions, is what the bot would refuse
        old = json.loads(self.before)
        self.assertTrue(any("but week 7 is complete" in str(f) for f in vs.validate_snapshot(
            old, now=utc("2026-10-27T09:30:00Z").timestamp(), league_season=2026, live_weeks_completed=7)))

    def test_not_due_when_nothing_newer(self):
        self.env.folder(BASE_DAY)
        st = self.env.rebuild("2026-10-21T10:00:00Z")
        self.assertEqual((st["result"], st["exit"]), ("up_to_date", 0))
        self.assertEqual(self.env.out.read_bytes(), self.before)

    def test_never_goes_backwards(self):
        self.env.folder("2026-10-19")
        st = self.env.rebuild("2026-10-21T10:00:00Z")
        self.assertEqual(st["result"], "up_to_date")
        self.assertEqual(self.env.out.read_bytes(), self.before)

    def test_refreshes_before_the_age_limit_when_no_week_completed(self):
        self.env.folder("2026-10-26")                     # same Week 6 standings, newer data
        early = self.env.rebuild("2026-10-26T10:00:00Z")  # 5.4 days old: not yet
        self.assertEqual(early["result"], "up_to_date", early)
        self.assertEqual(self.env.out.read_bytes(), self.before)
        late = self.env.rebuild("2026-10-27T12:00:00Z")   # 6.5 days: refresh (limit 8)
        self.assertEqual(late["result"], "rebuilt", late)
        self.assertIn("days old (refresh at 6 in season)", late["why"])

    def test_stale_with_no_newer_data_fails_and_keeps_the_file(self):
        self.env.folder(BASE_DAY)
        st = self.env.rebuild("2026-10-30T10:00:00Z")     # 9 days old, nothing newer to build from
        self.assertEqual((st["result"], st["exit"]), ("failed", 2))
        self.assertTrue(any("stale: built from data as of 2026-10-20" in f for f in st["failures"]), st)
        self.assertEqual(self.env.out.read_bytes(), self.before)

    def _fails_and_keeps(self, edit, needle, weeks_plus=1):
        self.env.folder("2026-10-27", weeks_plus=weeks_plus, edit=edit)
        st = self.env.rebuild("2026-10-27T09:30:00Z")
        self.assertEqual((st["result"], st["exit"]), ("failed", 2), st)
        self.assertTrue(any(needle in f for f in st["failures"]), st["failures"])
        self.assertEqual(self.env.out.read_bytes(), self.before, "the previous valid snapshot is kept byte for byte")

    def test_unregistered_player_fails_and_keeps_the_previous_snapshot(self):
        def add_unknown(d):
            r = json.loads((d / "rosters.json").read_text())
            fr = r["rosters"]["franchise"][0]
            fr["player"] = (fr["player"] if isinstance(fr["player"], list) else [fr["player"]]) + [{"id": "99999", "status": "ROSTER"}]
            (d / "rosters.json").write_text(json.dumps(r))
        self._fails_and_keeps(add_unknown, "not in the valuation registry")

    def test_truncated_roster_export_fails_and_keeps_the_previous_snapshot(self):
        def truncate(d):
            r = json.loads((d / "rosters.json").read_text())
            for fr in r["rosters"]["franchise"][1:]:
                ps = fr["player"] if isinstance(fr["player"], list) else [fr["player"]]
                fr["player"] = ps[:5]
            (d / "rosters.json").write_text(json.dumps(r))
        self._fails_and_keeps(truncate, "a truncated roster export?")

    def test_short_standings_fail_and_keep_the_previous_snapshot(self):
        def drop_team(d):
            s = json.loads((d / "leagueStandings.json").read_text())
            s["leagueStandings"]["franchise"] = s["leagueStandings"]["franchise"][:11]
            (d / "leagueStandings.json").write_text(json.dumps(s))
        self._fails_and_keeps(drop_team, "standings list 11 franchises, expected 12")

    def test_missing_folder_fails_without_touching_the_file(self):
        st = self.env.rebuild("2026-10-27T09:30:00Z", as_of="2026-10-27")
        self.assertEqual((st["result"], st["exit"]), ("failed", 2))
        self.assertEqual(self.env.out.read_bytes(), self.before)

    def test_a_valid_rebuild_is_byte_identical_to_the_builder(self):
        d = self.env.folder("2026-10-27", weeks_plus=1)
        self.env.rebuild("2026-10-27T09:30:00Z")
        direct = rb.bvs.render(rb.bvs.build("2026-10-27", "2026-10-27T09:30:00Z", snapshot_dir=d))
        self.assertEqual(self.env.out.read_bytes(), direct)


class Check(unittest.TestCase):
    """check = the bot's own decision: valuation_snapshot.validate_snapshot with trade_grader's live weeks."""
    def state(self, weeks, status="in_season"):
        return tg.SeasonState(2026, status, weeks_completed=weeks)

    def test_ok_while_current(self):
        st = rb.do_check(now=utc("2026-10-21T12:00:00Z"), season_state=self.state(6), path=COMMITTED)
        self.assertEqual((st["result"], st["exit"]), ("ok", 0), st)

    def test_no_grade_once_mfl_counts_week_7(self):
        st = rb.do_check(now=utc("2026-10-27T06:00:00Z"), season_state=self.state(7), path=COMMITTED)
        self.assertEqual((st["result"], st["exit"]), ("no_grade", 3))
        self.assertIn("valuation snapshot: stale: covers 2026 standings through week 6, but week 7 is complete", st["failures"])

    def test_no_grade_past_the_age_limit(self):
        st = rb.do_check(now=utc("2026-10-29T12:00:00Z"), season_state=self.state(6), path=COMMITTED)
        self.assertEqual(st["result"], "no_grade")
        self.assertTrue(any("days old (limit 8 days in season)" in f for f in st["failures"]))

    def test_unknown_when_mfl_is_unreadable(self):
        st = rb.do_check(now=utc("2026-10-21T12:00:00Z"), path=COMMITTED,
                         season_state=tg.SeasonState(2026, "unavailable", reason="MFL leagueStandings unavailable (URLError)"))
        self.assertEqual((st["result"], st["exit"]), ("unknown", 4))

    def test_same_failures_as_the_validator_the_grader_calls(self):
        now = utc("2026-10-29T12:00:00Z")
        snap = json.loads(COMMITTED.read_text())
        st = rb.do_check(now=now, season_state=self.state(7), path=COMMITTED)
        self.assertEqual(st["failures"], [str(f) for f in vs.validate_snapshot(snap, now=now.timestamp(), league_season=tg.LEAGUE_SEASON,
                                                                               live_weeks_completed=7)])


class Workflow(unittest.TestCase):
    """The workflow file: rebuild after the daily MFL pull, commit only a rebuilt snapshot, alert, never post."""
    WF = REPO / ".github" / "workflows" / "valuation-snapshot-rebuild.yml"

    def test_shape(self):
        y = self.WF.read_text()
        self.assertIn('workflows: ["MFL daily snapshot"]', y)
        self.assertIn("rebuild_valuation_snapshot.py rebuild", y)
        self.assertIn("rebuild_valuation_snapshot.py check", y)
        self.assertIn("git add data/valuation/trade_valuation_snapshot.json", y)
        self.assertIn("valuation-snapshot-alert", y)
        self.assertNotRegex(y, r"(?i)secrets\.\w*discord|webhook|discord\.com/api")   # it never posts to Discord
        self.assertNotIn("CLOUDFLARE", y)


def workflow_step(name: str) -> list:
    """The lines of one workflow step, by indentation (no YAML library: CI does not install one)."""
    lines = Workflow.WF.read_text().splitlines()
    start = next(i for i, l in enumerate(lines) if l.strip() == f"- name: {name}")
    indent = len(lines[start]) - len(lines[start].lstrip())
    end = next((j for j in range(start + 1, len(lines)) if lines[j].strip().startswith("- ")
                and len(lines[j]) - len(lines[j].lstrip()) <= indent), len(lines))
    return lines[start:end]


def workflow_run_script(name: str) -> str:
    """A step's `run: |` block, dedented."""
    import textwrap
    block = workflow_step(name)
    i = next(k for k, l in enumerate(block) if l.strip() == "run: |")
    return textwrap.dedent("\n".join(block[i + 1:])) + "\n"


class UnpushedSnapshot(unittest.TestCase):
    """A rebuilt snapshot committed but never pushed is not delivered (Keith 2026-10-22): the health check reads
    origin/main, and a failed push alerts."""

    def git(self, *a):
        import subprocess
        env = {**__import__("os").environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        r = subprocess.run(["git", "-C", str(self.repo), *a], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def setUp(self):
        self.td = tempfile.TemporaryDirectory(prefix=".valuation-unpushed-test-", dir=PINNED_ROOT)
        self.repo = Path(self.td.name) / "repo"
        shutil.copytree(PINNED_ROOT, self.repo, ignore=shutil.ignore_patterns(".valuation-*"))
        self.git("init", "-q", "-b", "main")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "the 10-20 snapshot on main")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")             # what GitHub has
        week7 = self.repo / "data" / "mfl-snapshots" / "2026-10-27"
        shutil.copytree(self.repo / "data" / "mfl-snapshots" / BASE_DAY, week7)
        (week7 / "leagueStandings.json").write_text(json.dumps(add_week(json.loads((week7 / "leagueStandings.json").read_text()))))
        saved = (rb.bvs.REPO, rb.bvs.INPUT_DIR, rb.bvs.COEFFICIENTS)
        rb.bvs.REPO = self.repo
        rb.bvs.INPUT_DIR = self.repo / "pipelines" / "etl" / "inputs" / "valuation"
        rb.bvs.COEFFICIENTS = self.repo / "pipelines" / "etl" / "config" / "future_pick_inseason_coefficients.json"
        try:
            st = rb.do_rebuild(now=utc("2026-10-27T16:00:00Z"), generated_at="2026-10-27T16:00:00Z",
                               out=self.repo / "data" / "valuation" / "trade_valuation_snapshot.json",
                               snapshots_dir=self.repo / "data" / "mfl-snapshots", repo=self.repo)
        finally:
            rb.bvs.REPO, rb.bvs.INPUT_DIR, rb.bvs.COEFFICIENTS = saved
        self.assertEqual(st["result"], "rebuilt", st)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "data(valuation): week 7 (committed, push FAILED)")

    def tearDown(self):
        self.td.cleanup()

    def test_health_check_reads_origin_main_not_the_unpushed_local_snapshot(self):
        week7 = tg.SeasonState(2026, "in_season", weeks_completed=7)
        now = utc("2026-10-27T17:00:00Z")
        local = rb.check_ref("HEAD", now=now, season_state=week7, repo=self.repo)
        self.assertEqual((local["result"], local["snapshot_weeks"]), ("ok", 7), local)
        remote = rb.check_ref("origin/main", now=now, season_state=week7, repo=self.repo)
        self.assertEqual((remote["result"], remote["exit"], remote["snapshot_weeks"]), ("no_grade", 3, 6), remote)
        self.assertIn("but week 7 is complete", " ".join(remote["failures"]))
        self.assertEqual(remote["ref_sha"], self.git("rev-parse", "origin/main"))
        self.assertEqual(self.git("worktree", "list").count("\n"), 0)         # temporary worktree removed
        missing = rb.check_ref("origin/nope", now=now, season_state=week7, repo=self.repo)
        self.assertEqual(missing["exit"], 3)                                 # an unreadable ref is never "ok"

    def test_workflow_checks_origin_main_even_after_a_failed_push(self):
        commit = [l.strip() for l in workflow_step("Commit a rebuilt snapshot")]
        self.assertIn("id: commit", commit)
        check = [l.strip() for l in workflow_step("Check what the bot would do now")]
        self.assertIn("if: always()", check)
        run = workflow_run_script("Check what the bot would do now")
        self.assertIn("check --ref origin/main", run)
        self.assertIn("git fetch --quiet origin main", run)
        alert = [l.strip() for l in workflow_step("Alert (one issue labeled valuation-snapshot-alert)")]
        self.assertIn("COMMIT_OUTCOME: ${{ steps.commit.outcome }}", alert)

    def _alert_step(self, commit_outcome, check_exit):
        import os
        import subprocess
        script = workflow_run_script("Alert (one issue labeled valuation-snapshot-alert)")
        tmp = Path(self.td.name)
        fakebin, calls = tmp / "bin", tmp / "gh_calls.log"
        fakebin.mkdir(exist_ok=True)
        (fakebin / "gh").write_text(f"#!/bin/sh\necho \"$*\" >> {calls}\nexit 0\n")
        (fakebin / "gh").chmod(0o755)
        (tmp / "rebuild.json").write_text(json.dumps({"result": "rebuilt", "why": "week 7 is complete", "failures": []}))
        (tmp / "check.json").write_text(json.dumps({"result": "ok" if check_exit == "0" else "no_grade",
                                                    "snapshot_as_of": "2026-10-20", "snapshot_weeks": 6,
                                                    "live_weeks_completed": 7, "failures": []}))
        calls.write_text("")
        env = {**os.environ, "PATH": f"{fakebin}:{os.environ['PATH']}", "RUNNER_TEMP": str(tmp), "GH_TOKEN": "x",
               "REBUILD_EXIT": "0", "COMMIT_OUTCOME": commit_outcome, "CHECK_EXIT": check_exit, "RUN_URL": "https://run"}
        r = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
        return r.returncode, calls.read_text(), (tmp / "alert.md").read_text() if (tmp / "alert.md").exists() else ""

    def test_failed_push_opens_the_alert(self):
        rc, calls, body = self._alert_step("failure", "0")
        self.assertEqual(rc, 1)                                              # the run fails: GitHub emails
        self.assertIn("issue create", calls)
        self.assertIn("NOT pushed", body)
        rc, calls, _ = self._alert_step("success", "0")
        self.assertEqual(rc, 0)
        self.assertNotIn("issue create", calls)


if __name__ == "__main__":
    unittest.main(verbosity=2)
