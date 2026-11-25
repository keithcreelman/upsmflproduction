#!/usr/bin/env python3
"""valuation_inputs_refresh.py: refresh the registry only when it must, only by additions, deliver safely.

A throwaway git repo (origin/main = a local ref) with a tiny registry and a daily folder; a fake extract
stands in for the league databases. Shown: nothing missing = nothing written; the happy path delivers one
inputs-only commit (PR by default, push only when configured, never forced); every guard refuses and
alerts without delivering: files outside the inputs, a changed existing value, players still missing, a
snapshot that would still not rebuild; the temporary worktree is always removed.

Offline: local git only; no gh, no network, no databases.
  python3 pipelines/etl/scripts/test_valuation_inputs_refresh.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import valuation_inputs_refresh as vr  # noqa: E402

ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t"}


def sh(repo, *args):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=ENV)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def write(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj))


class FakeOps(vr.Ops):
    def __init__(self, mutate=None, rebuild=(0, {}), add=True):
        super().__init__({})
        self.mutate, self.rebuild, self.add, self.calls, self.alerts = mutate, rebuild, add, [], []

    def fetch(self, repo):
        self.calls.append("fetch")

    def extract(self, tree, assets, adp):
        self.calls.append(("extract", assets[:7], adp[:7]))
        reg = tree / vr.INPUTS / "player_registry.json"
        d = json.loads(reg.read_text())
        if self.add:
            d["players"]["300"] = {"name": "New, Guy", "pos": "WR"}
        d["meta"]["assets_commit"] = assets
        write(reg, d)
        if self.mutate:
            self.mutate(tree)

    def rebuild_check(self, tree):
        self.calls.append("rebuild_check")
        return self.rebuild

    def push_main(self, tree, base):
        self.calls.append(("push_main", sh(tree, "rev-parse", "HEAD")))

    def open_pr(self, tree, branch, title, body):
        self.calls.append(("open_pr", branch, sh(tree, "rev-parse", "HEAD")))

    def alert(self, text):
        self.alerts.append(text)


class Refresh(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        sh(self.repo, "init", "-q", "-b", "main")
        write(self.repo / vr.INPUTS / "player_registry.json",
              {"meta": {"assets_commit": "x"}, "players": {"100": {"name": "A", "pos": "QB"}, "200": {"name": "B", "pos": "RB"}}})
        write(self.repo / vr.INPUTS / "player_ages.json", {"meta": {}, "ages": {"100": [2025, 30]}})
        write(self.repo / vr.ASSETS, {"a": 1})
        write(self.repo / vr.ADP, {"b": 1})
        folder = self.repo / vr.FOLDERS / "2026-11-25"
        write(folder / "rosters.json", {"rosters": {"franchise": [{"id": "0001", "player": [{"id": "100"}, {"id": "300"}]},
                                                                  {"id": "0002", "player": {"id": "200"}}]}})
        write(folder / "leagueStandings.json", {})
        write(folder / "_snapshot_meta.json", {})
        sh(self.repo, "add", "-A")
        sh(self.repo, "commit", "-qm", "base")
        sh(self.repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        self.base = sh(self.repo, "rev-parse", "HEAD")
        self.saved_state = vr.STATE
        vr.STATE = self.tmp / "state"
        self.cfg = {"repo": str(self.repo), "deliver": "pr"}

    def tearDown(self):
        vr.STATE = self.saved_state
        shutil.rmtree(self.tmp, ignore_errors=True)

    def worktrees(self):
        return [l for l in sh(self.repo, "worktree", "list", "--porcelain").splitlines() if l.startswith("worktree ")]

    def test_nothing_missing_writes_nothing(self):
        reg = self.repo / vr.INPUTS / "player_registry.json"
        d = json.loads(reg.read_text())
        d["players"]["300"] = {"name": "C", "pos": "WR"}
        write(reg, d)
        sh(self.repo, "commit", "-qam", "covered")
        sh(self.repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        ops = FakeOps()
        self.assertEqual(vr.run(self.cfg, ops), "nothing_to_do")
        self.assertNotIn("extract", [c[0] if isinstance(c, tuple) else c for c in ops.calls])
        self.assertEqual(len(self.worktrees()), 1)

    def test_happy_path_opens_one_inputs_only_pr_on_the_fetched_commit(self):
        ops = FakeOps()
        self.assertEqual(vr.run(self.cfg, ops), "pr_opened")
        kind, branch, head = ops.calls[-1]
        self.assertEqual(kind, "open_pr")
        self.assertTrue(branch.startswith("data/valuation-inputs-"))
        self.assertEqual(sh(self.repo, "rev-parse", f"{head}^"), self.base)          # one commit on the base
        self.assertEqual(sh(self.repo, "diff", "--name-only", self.base, head), f"{vr.INPUTS}player_registry.json")
        self.assertIn(vr.TAG, sh(self.repo, "log", "-1", "--format=%s", head))
        self.assertEqual(ops.alerts, [])
        self.assertEqual(len(self.worktrees()), 1)                                    # temp worktree removed
        self.assertEqual(sh(self.repo, "rev-parse", "main"), self.base)                # main untouched

    def test_commits_with_no_git_identity_in_the_environment(self):
        """CI and launchd have no user.name/user.email: the job must name author and committer itself."""
        home = self.tmp / "home"
        home.mkdir()
        stripped = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        stripped.update({"HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_COUNT": "1",
                         "GIT_CONFIG_KEY_0": "user.useConfigOnly", "GIT_CONFIG_VALUE_0": "true"})
        saved = dict(os.environ)
        os.environ.clear()
        os.environ.update(stripped)
        try:
            ops = FakeOps()
            self.assertEqual(vr.run(self.cfg, ops), "pr_opened", ops.alerts)
        finally:
            os.environ.clear()
            os.environ.update(saved)
        head = ops.calls[-1][2]
        self.assertEqual(sh(self.repo, "log", "-1", "--format=%an|%cn", head),
                         "valuation-inputs-refresh|valuation-inputs-refresh")

    def test_push_only_when_configured(self):
        ops = FakeOps()
        self.assertEqual(vr.run({**self.cfg, "deliver": "push"}, ops), "pushed")
        self.assertEqual(ops.calls[-1][0], "push_main")
        self.assertNotIn("--force", Path(vr.__file__).read_text().split("def push_main")[1].split("def ")[0])

    def test_dry_run_delivers_nothing(self):
        ops = FakeOps()
        self.assertEqual(vr.run(self.cfg, ops, dry_run=True), "dry_run")
        self.assertFalse([c for c in ops.calls if isinstance(c, tuple) and c[0] in ("push_main", "open_pr")])
        with self.assertRaises(ValueError):
            vr.run(self.cfg, ops, base_rev=self.base)                                  # --base only in a dry run

    def assertRefused(self, ops, needle):
        self.assertEqual(vr.run(self.cfg, ops), "refused")
        self.assertFalse([c for c in ops.calls if isinstance(c, tuple) and c[0] in ("push_main", "open_pr")])
        self.assertTrue(any(needle in a for a in ops.alerts), ops.alerts)
        self.assertEqual(len(self.worktrees()), 1)

    def test_a_change_outside_the_inputs_is_refused(self):
        self.assertRefused(FakeOps(mutate=lambda t: write(t / "site" / "x.json", {})), "outside")

    def test_a_changed_existing_value_is_refused(self):
        def bump(t):
            p = t / vr.INPUTS / "player_ages.json"
            d = json.loads(p.read_text())
            d["ages"]["100"] = [2025, 31]
            write(p, d)
        self.assertRefused(FakeOps(mutate=bump), "already had")

    def test_a_removed_player_is_refused(self):
        def drop(t):
            p = t / vr.INPUTS / "player_registry.json"
            d = json.loads(p.read_text())
            del d["players"]["200"]
            write(p, d)
        self.assertRefused(FakeOps(mutate=drop), "already had")

    def test_players_still_missing_is_refused(self):
        self.assertRefused(FakeOps(add=False), "still not in the registry")

    def test_a_snapshot_that_still_will_not_rebuild_is_refused(self):
        self.assertRefused(FakeOps(rebuild=(2, {"failures": ["source coverage: still short"]})), "would still not rebuild")


if __name__ == "__main__":
    unittest.main()
