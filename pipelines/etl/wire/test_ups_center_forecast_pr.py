#!/usr/bin/env python3
"""The forecast-only draft PR (ups_center_forecast_pr.py): Keith 2026-11-10 -- publish the week's forecast ahead of the UPS
Center package, each week only by his own merge.
  1. what may be offered: this season, exactly this week, valid odds, the Week 7+ place counts, run after the week went final
  2. one DRAFT PR on its own branch; nothing merges, readies, closes, enables auto-merge or dispatches a workflow
  3. a real git repo: the branch is origin/main plus exactly that one file, and the caller's work tree, index and branch are untouched
Offline: the committed Week 8 forecast and throwaway git repos.
    python3 pipelines/etl/wire/test_ups_center_forecast_pr.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_forecast_pr as F   # noqa: E402
import ups_center_pr as PR           # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SIM = open(os.path.join(REPO, "site/wire/data/season_sim_2026_live_wk08.json")).read()
D = json.loads(SIM)
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:500]))
    if not cond:
        fails += 1


def mutate(**kw):
    d = json.loads(SIM)
    for k, v in kw.items():
        if v is None:
            d.pop(k, None)
        else:
            d[k] = v
    return json.dumps(d)


print("1. what may be offered")
FINAL = "2026-11-03T09:00:00Z"
check("the real Week 8 forecast passes", F.problems_with(SIM, 2026, 8, FINAL) == [], F.problems_with(SIM, 2026, 8, FINAL))
check("another season is refused", any("season" in p for p in F.problems_with(SIM, 2025, 8, FINAL)))
check("another week is refused", any("through week" in p for p in F.problems_with(SIM, 2026, 9, FINAL)))
check("a forecast generated before the week went final is refused", any("before Week 8 went final" in p for p in F.problems_with(SIM, 2026, 8, "2099-01-01T00:00:00Z")))
check("no standingsForecast block in Week 7+ is refused", any("standingsForecast" in p for p in F.problems_with(mutate(standingsForecast=None), 2026, 8, FINAL)))
bad = json.loads(SIM); bad["teams"][0]["currentPlayoffOdds"] = 1.5
check("an odds value outside 0-1 is refused", any("currentPlayoffOdds" in p for p in F.problems_with(json.dumps(bad), 2026, 8, FINAL)))
check("garbage is refused", F.problems_with("{nope", 2026, 8, FINAL) != [] and F.problems_with("[]", 2026, 8, FINAL) != [])


class FakeRun:
    def __init__(self, prs=(), log="", on_main=None, list_rc=0):
        self.calls, self.prs, self.log, self.on_main, self.list_rc = [], list(prs), log, on_main, list_rc

    def __call__(self, cmd, cwd=None):
        self.calls.append(cmd)
        if cmd[:3] == ["gh", "pr", "list"]:
            return self.list_rc, json.dumps(self.prs)
        if cmd[:2] == ["git", "log"]:
            return 0, self.log
        if cmd[:2] == ["git", "show"]:
            return (0, self.on_main) if self.on_main is not None else (128, "")
        if cmd[:2] == ["git", "hash-object"]:
            return 0, "abc123\n"
        if "write-tree" in cmd:
            return 0, "tree123\n"
        if cmd[:2] == ["git", "commit-tree"]:
            return 0, "commit123\n"
        if cmd[:3] == ["gh", "pr", "create"]:
            return 0, "https://github.com/keithcreelman/upsmflproduction/pull/4343"
        return 0, ""

    def used(self, *words):
        return [c for c in self.calls if all(w in c for w in words)]


work = tempfile.mkdtemp(prefix="fpr_work_")
os.makedirs(os.path.join(work, "site/wire/data"))
open(os.path.join(work, F.sim_rel(2026, 8)), "w").write(SIM)
dg = __import__("hashlib").sha256(SIM.encode()).hexdigest()[:12]
mine = {"number": 4343, "headRefName": F.branch_for(2026, 8), "isDraft": True, "body": F.body(2026, 8, D, dg)}

print("2. one draft PR, never published")
g = FakeRun()
o = F.sync_forecast(g, 2026, 8, work, FINAL)
check("no PR -> writes the branch and creates ONE DRAFT PR", o["action"] == "created" and len(g.used("gh", "pr", "create", "--draft")) == 1 and g.used("git", "push", "-f"), o)
create = g.used("gh", "pr", "create")[0]
check("the PR targets main from wire/auto/2026-wk08-forecast", create[create.index("--base") + 1] == "main" and create[create.index("--head") + 1] == "wire/auto/2026-wk08-forecast")
check("the push is to the automation branch only", all(c[-1].endswith("refs/heads/wire/auto/2026-wk08-forecast") for c in g.used("git", "push")), g.used("git", "push"))
check("the commit carries the automation trailer", any(PR.TRAILER in " ".join(c) for c in g.used("git", "commit-tree")))
g = FakeRun(on_main=SIM)
check("already on main -> nothing to do", F.sync_forecast(g, 2026, 8, work, FINAL)["action"] == "already-published" and not g.used("gh", "pr", "create") and not g.used("git", "push"))
g = FakeRun(prs=[mine], log="abc|forecast-only\n")
check("same file, our PR -> no-op", F.sync_forecast(g, 2026, 8, work, FINAL)["action"] == "noop" and not g.used("git", "push"))
open(os.path.join(work, F.sim_rel(2026, 8)), "w").write(mutate(generatedAtUtc="2026-11-04T10:00:00Z"))
g = FakeRun(prs=[mine], log="abc|forecast-only\n")
o = F.sync_forecast(g, 2026, 8, work, FINAL)
check("the file changed (rebuilt forecast) -> UPDATE the same PR with a comment", o["action"] == "updated" and g.used("git", "push", "-f") and g.used("gh", "pr", "edit") and g.used("gh", "pr", "comment"), o)
g = FakeRun(prs=[mine], log="abc|\n")
check("a commit without the trailer = a person is working on it: never overwritten", F.sync_forecast(g, 2026, 8, work, FINAL)["action"] == "editor-owned" and not g.used("git", "push"))
g = FakeRun(prs=[mine, dict(mine, number=1)], log="abc|forecast-only\n")
check("two open PRs for the week -> stop, touch nothing", F.sync_forecast(g, 2026, 8, work, FINAL)["action"] == "stop-duplicate" and not g.used("git", "push"))
g = FakeRun()
check("dry mode decides without writing", F.sync_forecast(g, 2026, 8, work, FINAL, dry=True)["action"] == "would-create" and not g.used("git", "push") and not g.used("gh", "pr", "create"))
g = FakeRun()
check("a refused forecast opens nothing", F.sync_forecast(g, 2026, 9, work, FINAL)["action"] in ("no-file", "refused") and not g.used("gh", "pr", "create"))
open(os.path.join(work, F.sim_rel(2026, 8)), "w").write(mutate(throughWeek=7))
g = FakeRun()
o = F.sync_forecast(g, 2026, 8, work, FINAL)
check("a stale file (covers Week 7) is refused with the reason, no PR", o["action"] == "refused" and o["problems"] and not g.used("gh", "pr", "create"), o)
for verb in ("merge", "ready", "close"):
    try:
        PR._gh(FakeRun(), ["pr", verb, "1"]); ok = False
    except RuntimeError:
        ok = True
    check("`gh pr %s` is refused by the module this one uses" % verb, ok)
src = open(os.path.join(HERE, "ups_center_forecast_pr.py")).read()
code = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))
check("no auto-merge, no workflow dispatch, no ready/merge call anywhere in the module",
      not any(w in code.split('"""', 2)[2] for w in ("--auto", "gh workflow", "workflow run", '"merge"', '"ready"', "pr merge", "pr ready")))

print("3. a real git repo: origin/main plus exactly one file; the caller's tree is untouched")


def git(args, cwd, env=None):
    p = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, env=dict(os.environ, **(env or {})))
    return p.returncode, (p.stdout + p.stderr)


def real_run(cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


root = tempfile.mkdtemp(prefix="fpr_git_")
bare, clone = os.path.join(root, "origin.git"), os.path.join(root, "clone")
git(["init", "-q", "--bare", "-b", "main", bare], root)
git(["clone", "-q", bare, clone], root)
git(["config", "user.email", "t@example.com"], clone); git(["config", "user.name", "t"], clone)
os.makedirs(os.path.join(clone, "site/wire/data"))
open(os.path.join(clone, "site/wire/data/other.json"), "w").write("{}")
open(os.path.join(clone, "README.md"), "w").write("hi")
git(["add", "-A"], clone); git(["commit", "-q", "-m", "main"], clone); git(["push", "-q", "origin", "main"], clone)
git(["checkout", "-q", "-b", "wire/auto/2026-wk08-ups-center"], clone)
open(os.path.join(clone, "site/wire/data/package_in_progress.json"), "w").write("{\"wip\": 1}")   # the package build's own uncommitted work
git(["fetch", "-q", "origin"], clone)
open(os.path.join(clone, F.sim_rel(2026, 8)), "w").write(SIM)
status_before = git(["status", "--porcelain"], clone)[1]
head_before = git(["rev-parse", "HEAD"], clone)[1]
F._write_branch(real_run, 2026, 8, SIM, clone)
rc, tree = git(["ls-tree", "-r", "--name-only", "wire/auto/2026-wk08-forecast"], bare)
rc2, base = git(["diff", "--name-status", "main", "wire/auto/2026-wk08-forecast"], bare)
check("the pushed branch differs from main by exactly one added file: the forecast", base.split() == ["A", F.sim_rel(2026, 8)], base)
check("and that file is byte-identical to the forecast", git(["show", "wire/auto/2026-wk08-forecast:" + F.sim_rel(2026, 8)], bare)[1] == SIM)
check("the package work in progress is not on it", "package_in_progress" not in tree)
check("its parent is origin/main", git(["rev-parse", "wire/auto/2026-wk08-forecast^"], bare)[1] == git(["rev-parse", "main"], bare)[1])
check("the caller's branch, HEAD and work tree are exactly as they were",
      git(["status", "--porcelain"], clone)[1] == status_before and git(["rev-parse", "HEAD"], clone)[1] == head_before
      and git(["branch", "--show-current"], clone)[1].strip() == "wire/auto/2026-wk08-ups-center")
check("the trailer is on the commit", PR.TRAILER in git(["log", "-1", "--format=%B", "wire/auto/2026-wk08-forecast"], bare)[1])

print("\nALL PASS" if not fails else "\n%d FAILED" % fails)
sys.exit(1 if fails else 0)
