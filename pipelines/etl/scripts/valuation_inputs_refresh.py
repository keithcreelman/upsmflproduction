#!/usr/bin/env python3
"""Keep the valuation registry current so the weekly snapshot rebuild never stalls (Keith 2026-11-25).

Why grading stopped: #1357's workflow (valuation-snapshot-rebuild.yml) rebuilds the snapshot after each
completed week, but refuses a build while any rostered player is missing from the valuation registry,
and the registry can only be refreshed by extract_valuation_inputs.py, which reads the league databases
on this Mac. Every waiver pickup of a new player therefore froze the rebuild until someone ran the
extract by hand (Week 11: every run failed from 2026-11-24 05:23 UTC on "10 rostered player(s) not in the
valuation registry"), the snapshot went stale and the bot held every trade.

This job, run by launchd on the Mac, closes that gap and does nothing else:
  1. fetch origin/main; in a temporary worktree at that exact commit, find rostered players (newest
     complete MFL daily folder) missing from the registry. None missing = done, nothing written.
  2. run extract_valuation_inputs.py there, with the database paths from the local config file.
  3. refuse (alert, write nothing) unless: only pipelines/etl/inputs/valuation/ changed; no value a
     player already had changed (additions only, plus each file's meta); the registry now covers every
     rostered player; and the snapshot would now build and validate (rebuild_valuation_snapshot.py
     rebuild, in the temporary worktree; its output is discarded).
  4. deliver the inputs commit: "pr" (default) pushes a branch and opens a PR for a person to merge;
     "push" pushes it to main (never forced; a moved main means try again next run) and dispatches the
     rebuild workflow. #1357's workflow still builds and commits the snapshot itself, and the bot's
     cutover job delivers it.

The bot's checkout is never touched. No Discord, no MFL, no D1, no secrets (gh uses its own login).
Config (not in the repo): ~/Library/Application Support/ups-valuation-refresh/config.json
  {"league_db": "...", "yoy_db": "...", "deliver": "pr", "repo": "~/Code/MFL/upsmflproduction"}
Copy the databases somewhere local first: a launchd job must never read through iCloud (2026-07-11).

  python3 valuation_inputs_refresh.py run [--dry-run]
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

STATE = Path.home() / "Library" / "Application Support" / "ups-valuation-refresh"
CONFIG = STATE / "config.json"
INPUTS = "pipelines/etl/inputs/valuation/"
SCRIPTS = "pipelines/etl/scripts"
FOLDERS = "data/mfl-snapshots"
ASSETS = "site/rookies/franchise_assets_2026.json"
ADP = "site/rookies/external_adp_2026.json"
TAG = "[valuation-inputs-refresh]"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git(tree, *args, check=True) -> str:
    r = subprocess.run(["git", "-C", str(tree), *args], capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {r.stderr.strip()[:300]}")
    return r.stdout.strip()


class Refused(RuntimeError):
    """A check failed: nothing is delivered and a person is told."""


class Ops:
    """Everything with a side effect outside the temporary worktree. Tests replace it."""

    def __init__(self, cfg: dict):
        self.cfg = cfg

    def fetch(self, repo: Path):
        git(repo, "fetch", "--quiet", "origin", "main")

    def extract(self, tree: Path, assets: str, adp: str):
        subprocess.run([sys.executable, str(tree / SCRIPTS / "extract_valuation_inputs.py"),
                        "--league-db", self.cfg["league_db"], "--yoy-db", self.cfg["yoy_db"],
                        "--assets-commit", assets, "--adp-commit", adp],
                       cwd=str(tree), check=True, capture_output=True, text=True, timeout=900)

    def rebuild_check(self, tree: Path) -> tuple:
        out = Path(tempfile.mkdtemp()) / "status.json"
        r = subprocess.run([sys.executable, str(tree / SCRIPTS / "rebuild_valuation_snapshot.py"), "rebuild",
                            "--force", "--status-out", str(out)], cwd=str(tree), capture_output=True, text=True,
                           timeout=600)
        status = json.loads(out.read_text()) if out.exists() else {}
        return r.returncode, status

    def push_main(self, tree: Path, base: str):
        git(tree, "push", "origin", f"HEAD:refs/heads/main")       # no force: a moved main is refused
        subprocess.run(["gh", "workflow", "run", "valuation-snapshot-rebuild.yml", "--ref", "main"],
                       cwd=str(tree), check=True, capture_output=True, text=True, timeout=60)

    def open_pr(self, tree: Path, branch: str, title: str, body: str):
        git(tree, "push", "origin", f"HEAD:refs/heads/{branch}")
        subprocess.run(["gh", "pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body],
                       cwd=str(tree), check=True, capture_output=True, text=True, timeout=60)

    def alert(self, text: str):
        log(f"ALERT {text}")
        try:
            subprocess.run(["osascript", "-e", f"display notification {json.dumps(text[:200])} "
                                               f"with title \"Valuation inputs refresh\""], timeout=10)
        except Exception:
            pass


def log(msg: str):
    line = f"[{now_iso()}] {msg}"
    print(line)
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        with open(STATE / "refresh.log", "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def newest_folder(tree: Path) -> Path | None:
    base = tree / FOLDERS
    for d in sorted((p for p in base.iterdir() if p.is_dir()), reverse=True) if base.exists() else []:
        if all((d / n).exists() for n in ("rosters.json", "leagueStandings.json", "_snapshot_meta.json")):
            return d
    return None


def registry_gaps(tree: Path) -> list:
    """Rostered players (newest complete daily folder) missing from the valuation registry."""
    folder = newest_folder(tree)
    if folder is None:
        raise Refused("no complete MFL daily folder on origin/main")
    reg = json.loads((tree / INPUTS / "player_registry.json").read_text())["players"]
    ids = []
    for fr in json.loads((folder / "rosters.json").read_text())["rosters"]["franchise"]:
        ps = fr.get("player") or []
        ids += [str(p["id"]) for p in (ps if isinstance(ps, list) else [ps])]
    return sorted({i for i in ids if i not in reg}, key=int)


def _maps(doc):
    """The per-player / per-season maps inside an input file (everything but its meta)."""
    return {k: v for k, v in doc.items() if k != "meta"} if isinstance(doc, dict) else {"_": doc}


def additions_only(old: dict, new: dict, path: str) -> list:
    """Problems if any value that existed before changed or disappeared (meta excepted)."""
    out = []

    def walk(a, b, where):
        if isinstance(a, dict) and isinstance(b, dict):
            for k, v in a.items():
                if k not in b:
                    out.append(f"{path}: {where}{k} was removed")
                else:
                    walk(v, b[k], f"{where}{k}.")
        elif a != b:
            out.append(f"{path}: {where.rstrip('.')} changed")
    walk(_maps(old), _maps(new), "")
    return out[:20]


def run(cfg: dict, ops: Ops, *, dry_run: bool = False, base_rev: str | None = None) -> str:
    """base_rev (dry runs only): start from that commit instead of origin/main, to rehearse a past gap."""
    if base_rev and not dry_run:
        raise ValueError("--base is for dry runs only")
    repo = Path(os.path.expanduser(cfg["repo"]))
    ops.fetch(repo)
    base = git(repo, "rev-parse", base_rev or "origin/main")
    tree = Path(tempfile.mkdtemp(prefix="valuation-refresh-")) / "wt"
    git(repo, "worktree", "add", "--quiet", "--detach", str(tree), base)
    try:
        gaps = registry_gaps(tree)
        if not gaps:
            log(f"origin/main {base[:8]}: every rostered player is in the registry; nothing to do")
            return "nothing_to_do"
        log(f"origin/main {base[:8]}: {len(gaps)} rostered player(s) missing from the registry: {gaps[:12]}")
        old = {p: json.loads((tree / INPUTS / p).read_text()) for p in os.listdir(tree / INPUTS)}
        assets = git(tree, "log", "-1", "--format=%H", base, "--", ASSETS)
        adp = git(tree, "log", "-1", "--format=%H", base, "--", ADP)
        ops.extract(tree, assets, adp)
        changed = [l for l in (git(tree, "diff", "--name-only").splitlines()
                               + git(tree, "ls-files", "--others", "--exclude-standard").splitlines()) if l.strip()]
        outside = [p for p in changed if not p.startswith(INPUTS)]
        if outside:
            raise Refused(f"the extract changed files outside {INPUTS}: {outside[:5]}")
        problems = []
        for p in os.listdir(tree / INPUTS):
            new = json.loads((tree / INPUTS / p).read_text())
            if p in old:
                problems += additions_only(old[p], new, p)
        if problems:
            raise Refused("the extract changed values players already had (a database regression?): "
                          + "; ".join(problems[:5]))
        left = registry_gaps(tree)
        if left:
            raise Refused(f"after the extract {len(left)} rostered player(s) are still not in the registry: {left[:12]}")
        code, status = ops.rebuild_check(tree)
        if code != 0:
            raise Refused(f"the snapshot would still not rebuild (exit {code}): "
                          + "; ".join(map(str, status.get("failures") or []))[:300])
        git(tree, "add", "--", INPUTS)            # only the inputs: #1357 builds and commits the snapshot itself
        staged = git(tree, "diff", "--cached", "--name-only").splitlines()
        if not staged:
            raise Refused("the extract found players missing but wrote no change")
        if any(not p.startswith(INPUTS) for p in staged):
            raise Refused(f"refusing to commit files outside {INPUTS}: {staged[:5]}")
        msg = (f"data(valuation): refresh valuation inputs, registry +{len(gaps)} {TAG}\n\n"
               f"Rostered players missing from the registry on {base[:12]}: {', '.join(gaps[:30])}.\n"
               f"Generated by extract_valuation_inputs.py (assets {assets[:12]}, ADP {adp[:12]}); additions only,\n"
               f"every rostered player covered, and the snapshot rebuilds and validates with them.\nNo code change.")
        # Author AND committer are set explicitly: a launchd job or CI has no git identity of its own
        # (CI 2026-11-25: exit 128 "Committer identity unknown" with only the author set).
        ident = {f"GIT_{role}_{k}": v for role in ("AUTHOR", "COMMITTER")
                 for k, v in (("NAME", "valuation-inputs-refresh"), ("EMAIL", "valuation-inputs-refresh@localhost"))}
        r = subprocess.run(["git", "-C", str(tree), "commit", "--quiet", "-m", msg], env={**os.environ, **ident},
                           capture_output=True, text=True)
        if r.returncode:
            raise Refused(f"git commit failed (exit {r.returncode}): {(r.stderr or r.stdout).strip()[:300]}")
        if dry_run:
            log(f"dry run: would deliver {git(tree, 'rev-parse', 'HEAD')[:12]} by {cfg.get('deliver', 'pr')}")
            return "dry_run"
        if cfg.get("deliver", "pr") == "push":
            ops.push_main(tree, base)
            log(f"pushed inputs {git(tree, 'rev-parse', 'HEAD')[:12]} to main and dispatched the rebuild")
            return "pushed"
        branch = f"data/valuation-inputs-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}"
        ops.open_pr(tree, branch, f"data(valuation): refresh valuation inputs (registry +{len(gaps)})",
                    msg.split("\n", 2)[2] + "\n\nMerging lets the valuation snapshot rebuild run; it builds and "
                    "commits the snapshot itself.")
        log(f"opened a PR from {branch}")
        return "pr_opened"
    except Refused as exc:
        ops.alert(str(exc))
        return "refused"
    finally:
        git(repo, "worktree", "remove", "--force", str(tree), check=False)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--base", help="dry run only: rehearse from this commit instead of origin/main")
    ap.add_argument("--config", type=Path, default=CONFIG)
    a = ap.parse_args(argv)
    try:
        cfg = json.loads(a.config.read_text())
    except (OSError, ValueError) as exc:
        log(f"config unreadable ({exc.__class__.__name__}): {a.config}")
        return 2
    STATE.mkdir(parents=True, exist_ok=True)
    with open(STATE / "run.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("another run is in progress")
            return 0
        try:
            result = run(cfg, Ops(cfg), dry_run=a.dry_run, base_rev=a.base)
        except Exception as exc:
            Ops(cfg).alert(f"refresh failed: {exc.__class__.__name__}: {str(exc)[:200]}")
            return 1
    return 0 if result != "refused" else 3


if __name__ == "__main__":
    sys.exit(main())
