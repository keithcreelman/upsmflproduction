#!/usr/bin/env python3
"""Deliver a rebuilt valuation snapshot to the running trade bot, or leave the bot untouched and alert.

Companion to #1357 (Keith 2026-10-21). #1357's GitHub workflow waits for the weekly MFL inputs,
builds and validates data/valuation/trade_valuation_snapshot.json, and commits and pushes it to
main (steps 1-3). This job, run by launchd on the bot's Mac, does steps 4-9 for the bot's own
checkout (~/Code/MFL/upsmflproduction):

  4. ci        a newer snapshot is on origin/main: run the full safe suite on that exact commit
               in a temporary worktree (main pushes get no GitHub CI), and require it to pass
  6a. validate the bot's own Python, in that worktree, imports the bot's modules and validates
               the snapshot exactly as analyze_trade does (live MFL standings week)
  5. pull      fast-forward the checkout: `git merge --ff-only`. Never reset, rebase or pull into
               a dirty checkout. Gitignored/untracked runtime state (cursor, roast tracker,
               held-trades file, ...) is hashed before and after and must be byte for byte equal
  6b. validate again, in the checkout itself
  7. restart   `launchctl kickstart -k` the bot exactly once
  8. verify    a new pid, "Trade polling started" after the restart, a heartbeat from the new pid,
               and the snapshot's date and week as loaded by the bot's Python
  9. held      the bot retries each held NO GRADE trade exactly once on its first poll with a
               valid snapshot (held_trades.py). The exact held entries (full keys) are captured
               before the restart; the cutover succeeds only if every one finishes "posted".
               held_again, error, started-but-unfinished, missing or an unreadable file leave
               it in MANUAL REVIEW with the alert open. Nothing is attempted a second time.

Fail closed (Keith 2026-10-22): a missing, unreadable or corrupt held-trades file stops the job
before the pull. Every GitHub alert call is checked; if delivery fails the job writes
alert_failures.json in its state folder, raises a Mac notification, and never reports success
or closes the incident. The bot's own operational alerts (ops_alerts.json) are forwarded here.

Stops without touching the running bot (and alerts, naming the stage) when the checkout is not
on main, is dirty, is not a fast-forward, the bot's code changed on main (code needs a reviewed
manual cutover), CI fails, or validation fails. A failed post-pull validation or restart rolls
the checkout back (detached at the previous commit, runtime state untouched) and restarts the
previous code. Nothing to do (no newer snapshot) means no pull and no restart.

Before that, `inputs`: when MFL's live standings count a week the newest snapshot does not cover
and origin/main has no MFL daily folder for today, it dispatches the existing "MFL daily
snapshot" workflow once that UTC day, so #1357's rebuild does not wait for the late cron.

  python3 bot_snapshot_cutover.py run        # what launchd runs
  python3 bot_snapshot_cutover.py status
  python3 bot_snapshot_cutover.py rollback --to <commit>
  python3 bot_snapshot_cutover.py recover    # after a rollback: back onto main, then `run`

No D1, no Discord, no MFL writes. Alerts: one open GitHub issue labeled bot-cutover-alert, plus
the local log; alert text never includes runtime file names.
"""
import argparse
import ast
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import held_trades  # noqa: E402

HOME = Path.home()
SNAPSHOT = "data/valuation/trade_valuation_snapshot.json"
SCRIPTS = "pipelines/etl/scripts"
ALERT_LABEL = "bot-cutover-alert"
SKIP_DIRS = (".git/", ".claude/worktrees/", "node_modules/")

VALIDATE_SNIPPET = r'''
import json, sys, time
import trade_grader as tg, valuation_snapshot as vs, pick_valuation, held_trades, trade_roast_context, trade_announcement
st = tg.load_season_state(0)
live = st.weeks_completed if (st.status == "in_season" or st.weeks_completed) else None
snap, fails = vs.load_for_grading(now=time.time(), league_season=tg.LEAGUE_SEASON, live_weeks_completed=live)
fails = [str(f) for f in fails]
if st.status == "unavailable" and not st.weeks_completed:
    fails.append("current-season standings: " + (st.reason or "unavailable"))
print(json.dumps({"failures": fails, "as_of": snap and snap["as_of"], "live_weeks": live,
                  "weeks": snap and snap["season_state"]["weeks_completed"], "sha": snap and snap["content_sha256"]}))
'''


@dataclass
class Config:
    checkout: Path = HOME / "Code/MFL/upsmflproduction"
    bot_python: Path = HOME / ".venvs/ups-roast-bot/bin/python3"
    label: str = "com.keith.mfl.roast-bot"
    state_dir: Path = HOME / "Library/Application Support/ups-roast-bot/cutover"
    bot_log: Path = Path("/tmp/roast_bot.log")
    heartbeat: Path = HOME / "Library/Application Support/ups-roast-bot/heartbeat.json"
    remote: str = "origin"
    branch: str = "main"
    suite_cmd: list = field(default_factory=lambda: ["node", "scripts/safe_tests/run.mjs"])
    suite_timeout: int = 1500
    restart_timeout: int = 150
    held_wait: int = 600
    repo_slug: str = "keithcreelman/upsmflproduction"
    dispatch_inputs: bool = True
    dispatch_attempts_per_day: int = 4
    ops_alert_file: Path = HOME / "Library/Application Support/ups-roast-bot/ops_alerts.json"

    @property
    def held_file(self) -> Path:
        return self.checkout / "pipelines/etl/data/held_trades_no_grade.json"


class Stop(Exception):
    """A stage failed: the running bot was left as it was (or restored)."""
    def __init__(self, stage: str, reason: str):
        super().__init__(f"{stage}: {reason}")
        self.stage, self.reason = stage, reason


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Ops:
    """Everything outside git: the bot process, its Python, the suite, GitHub. Tests replace it."""

    def __init__(self, cfg: Config):
        self.cfg = cfg

    def fetch(self, checkout: Path) -> None:
        git(checkout, "fetch", "--quiet", self.cfg.remote, self.cfg.branch)

    def bot_pid(self) -> int:
        out = subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 3 and parts[2] == self.cfg.label:
                return int(parts[0]) if parts[0].isdigit() else 0
        return 0

    def restart(self) -> None:
        subprocess.run(["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{self.cfg.label}"], check=True,
                       capture_output=True, text=True)

    def validate(self, tree: Path) -> dict:
        r = subprocess.run([str(self.cfg.bot_python), "-c", VALIDATE_SNIPPET], cwd=str(Path(tree) / SCRIPTS),
                           capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            return {"failures": [f"the bot's Python could not load the snapshot (exit {r.returncode}): "
                                 f"{(r.stderr.strip().splitlines() or ['?'])[-1][:200]}"]}
        return json.loads(r.stdout.strip().splitlines()[-1])

    def run_suite(self, tree: Path) -> tuple:
        try:
            r = subprocess.run(self.cfg.suite_cmd, cwd=str(tree), capture_output=True, text=True,
                               timeout=self.cfg.suite_timeout)
        except subprocess.TimeoutExpired:
            return 124, "timed out"
        summary = [l for l in r.stdout.splitlines() if l.startswith("Safe offline tests")]
        return r.returncode, (summary[-1] if summary else r.stdout[-300:])

    def gh(self, *args) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(["gh", *args, "--repo", self.cfg.repo_slug], capture_output=True, text=True,
                                  timeout=60)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return subprocess.CompletedProcess(["gh", *args], 127, "", str(exc))

    def dispatch_daily_pull(self) -> bool:
        return self.gh("workflow", "run", "MFL daily snapshot", "--ref", self.cfg.branch).returncode == 0

    def _open_issue(self) -> str | None:
        """The open alert issue number, "" if none, None if GitHub could not be asked."""
        r = self.gh("issue", "list", "--label", ALERT_LABEL, "--state", "open", "--json", "number",
                    "--jq", ".[0].number // empty")
        return r.stdout.strip() if r.returncode == 0 else None

    def alert(self, stage: str, text: str) -> tuple:
        """(delivered, why). Every gh call's result is checked."""
        title = f"Trade bot snapshot cutover stopped at stage: {stage}"
        lab = self.gh("label", "create", ALERT_LABEL, "--color", "B60205", "--force",
                      "--description", "Trade bot did not receive the valuation snapshot")
        if lab.returncode != 0:
            return False, f"label: {lab.stderr.strip()[:200]}"
        found = self._open_issue()
        if found is None:
            return False, "issue list failed"
        if found:
            r = self.gh("issue", "comment", found, "--body", f"**{title}**\n\n{text}")
            return (r.returncode == 0, f"comment: {r.stderr.strip()[:200]}")
        r = self.gh("issue", "create", "--label", ALERT_LABEL, "--title", title, "--body", text)
        return (r.returncode == 0 and "/issues/" in r.stdout, f"create: {r.stderr.strip()[:200]}")

    def resolve(self, text: str) -> tuple:
        """(resolved, why): an open incident is commented on and closed, both checked."""
        found = self._open_issue()
        if found is None:
            return False, "issue list failed"
        if not found:
            return True, "no open incident"
        c = self.gh("issue", "comment", found, "--body", text)
        if c.returncode != 0:
            return False, f"comment: {c.stderr.strip()[:200]}"
        x = self.gh("issue", "close", found)
        return (x.returncode == 0, f"close: {x.stderr.strip()[:200]}")

    def notify(self, title: str, text: str) -> bool:
        """A Mac notification (the fallback when GitHub alerting fails)."""
        try:
            return subprocess.run(["osascript", "-e", f"display notification {json.dumps(text[:200])} "
                                                      f"with title {json.dumps(title)}"], timeout=10).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False


# ── git helpers (the checkout and temporary worktrees) ─────────────────────
def git(tree, *args, check=True) -> str:
    r = subprocess.run(["git", "-C", str(tree), *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()[:300]}")
    return r.stdout.strip()


def snapshot_at(tree, rev) -> dict | None:
    r = subprocess.run(["git", "-C", str(tree), "show", f"{rev}:{SNAPSHOT}"], capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 else None


def bot_code_files(tree: Path) -> set:
    """trade_roast_bot.py and every local module it imports, transitively (repo-relative)."""
    scripts = Path(tree) / SCRIPTS
    seen, todo = set(), ["trade_roast_bot"]
    while todo:
        mod = todo.pop()
        path = scripts / f"{mod}.py"
        if mod in seen or not path.exists():
            continue
        seen.add(mod)
        for node in ast.walk(ast.parse(path.read_text())):
            names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                     else [node.module] if isinstance(node, ast.ImportFrom) and node.module and not node.level
                     else [])
            todo += [n.split(".")[0] for n in names]
    return {f"{SCRIPTS}/{m}.py" for m in seen} | {f"{SCRIPTS}/bot_snapshot_cutover.py"}


def runtime_state(tree: Path) -> dict:
    """sha256 of every gitignored or untracked file in the checkout (the bot's runtime state)."""
    out = {}
    for flags in (["--others", "--ignored", "--exclude-standard"], ["--others", "--exclude-standard"]):
        for rel in git(tree, "ls-files", *flags).splitlines():
            if rel.endswith("/") or rel.startswith(SKIP_DIRS):
                continue
            p = Path(tree) / rel
            if p.is_file() and not p.is_symlink():
                out[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


# ── the job ────────────────────────────────────────────────────────────────
class Cutover:
    def __init__(self, cfg: Config, ops: Ops | None = None, log=None):
        self.cfg, self.ops = cfg, ops or Ops(cfg)
        self.cfg.state_dir.mkdir(parents=True, exist_ok=True)
        self.state_file = self.cfg.state_dir / "state.json"
        self.log_file = self.cfg.state_dir / "cutover.log"
        self._log = log
        self.lines = []
        self.alert_failed = False
        self.unresolved = False

    def log(self, msg: str) -> None:
        line = f"[{now_utc().strftime('%Y-%m-%dT%H:%M:%SZ')}] {msg}"
        self.lines.append(line)
        with open(self.log_file, "a") as fh:
            fh.write(line + "\n")
        if self._log:
            self._log(line)

    def state(self) -> dict:
        try:
            return json.loads(self.state_file.read_text())
        except (OSError, ValueError):
            return {}

    def save_state(self, **kw) -> None:
        st = {**self.state(), **kw}
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=1))
        os.replace(tmp, self.state_file)

    def _append_json(self, path: Path, record: dict) -> None:
        items = []
        try:
            items = json.loads(path.read_text()) if path.exists() else []
        except (OSError, ValueError):
            items = [{"note": "previous file unreadable; replaced"}]
        items.append(record)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w") as fh:
            fh.write(json.dumps(items[-500:], indent=1))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    def _delivery_failed(self, what: str, stage: str, text: str, why: str) -> None:
        """GitHub alerting failed: a durable local record and a Mac notification."""
        rec = {"at": now_utc().isoformat(), "what": what, "stage": stage, "why": why, "text": text[:2000]}
        try:
            self._append_json(self.cfg.state_dir / "alert_failures.json", rec)
        except OSError as exc:
            self.log(f"could not even write alert_failures.json: {exc}")
        self.ops.notify(f"Trade bot cutover: {what} FAILED", f"stage {stage}: {text[:150]}")
        self.log(f"ALERT DELIVERY FAILED ({what}, {why}); recorded in alert_failures.json and notified on this Mac")

    def alert(self, stage: str, text: str) -> bool:
        ok, why = self.ops.alert(stage, text)
        if not ok:
            self.alert_failed = True
            self._delivery_failed("GitHub alert", stage, text, why)
        return ok

    def resolve(self, text: str) -> bool:
        ok, why = self.ops.resolve(text)
        if not ok:
            self.unresolved = True
            self._delivery_failed("closing the GitHub incident", "resolve", text, why)
        return ok

    def forward_bot_alerts(self) -> None:
        """The bot's operational alerts (ops_alerts.json) become GitHub alerts; marked forwarded only
        once delivery succeeded."""
        f = self.cfg.ops_alert_file
        if not f.exists():
            return
        try:
            alerts = json.loads(f.read_text())
        except (OSError, ValueError) as exc:
            self._delivery_failed("reading the bot's ops alerts", "bot-ops", str(exc), "unreadable")
            self.alert_failed = True
            return
        changed = False
        for a in alerts:
            if not a.get("forwarded"):
                if self.alert(f"bot-{a.get('stage')}", f"The trade bot raised an operational alert at {a.get('at')}: "
                                                       f"{a.get('text')}"):
                    a["forwarded"], changed = True, True
        if changed:
            tmp = f.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(alerts, indent=1))
            os.replace(tmp, f)

    def held_snapshot(self) -> list:
        """The held file, or Stop (never 'zero held trades')."""
        try:
            return held_trades.load(self.cfg.held_file)
        except held_trades.HeldStateError as exc:
            raise Stop("held-state", f"the held-trades file cannot be trusted ({exc}); nothing is pulled or "
                                     f"restarted until it is fixed")

    def lock(self):
        fh = open(self.cfg.state_dir / "cutover.lock", "w")
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fh.close()
            return None
        return fh

    # stages ---------------------------------------------------------------
    def preflight(self) -> str:
        co = self.cfg.checkout
        branch = git(co, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
        if branch != self.cfg.branch:
            raise Stop("checkout", f"the bot checkout is not on {self.cfg.branch} "
                                   f"({branch or 'detached at ' + git(co, 'rev-parse', '--short', 'HEAD')}); "
                                   f"after a rollback run `bot_snapshot_cutover.py recover`")
        if git(co, "status", "--porcelain", "--untracked-files=no"):
            raise Stop("dirty", "the bot checkout has tracked changes; it is never pulled over them")
        self.held_snapshot()
        try:
            self.ops.fetch(co)
        except RuntimeError as exc:
            raise Stop("fetch", str(exc))
        return git(co, "rev-parse", f"{self.cfg.remote}/{self.cfg.branch}")

    def inputs(self, target: str, live_weeks) -> None:
        """Dispatch the MFL daily pull early when a new week is counted and today's folder is absent."""
        if not self.cfg.dispatch_inputs or live_weeks is None:
            return
        snap = snapshot_at(self.cfg.checkout, target) or {}
        covered = (snap.get("season_state") or {}).get("weeks_completed") or 0
        today = now_utc().strftime("%Y-%m-%d")
        has_today = bool(git(self.cfg.checkout, "ls-tree", "--name-only", target, f"data/mfl-snapshots/{today}/",
                             check=False))
        st = self.state()
        tries = (st.get("dispatch_failures") or {}).get(today, 0)
        if (live_weeks > covered and not has_today and st.get("dispatched_day") != today
                and tries < self.cfg.dispatch_attempts_per_day):
            ok = self.ops.dispatch_daily_pull()
            self.log(f"inputs: MFL counts week {live_weeks}, the snapshot covers {covered}, and there is no "
                     f"{today} MFL folder yet: dispatching the MFL daily snapshot workflow: {'ok' if ok else 'FAILED'}")
            if ok:
                self.save_state(dispatched_day=today)       # recorded only once it succeeded
            else:
                self.save_state(dispatch_failures={today: tries + 1})
                if st.get("dispatch_alerted_day") != today:
                    self.save_state(dispatch_alerted_day=today)
                    self.alert("inputs", f"Dispatching the MFL daily snapshot workflow failed (attempt {tries + 1} of "
                                         f"{self.cfg.dispatch_attempts_per_day} today); later runs retry. Until the "
                                         f"daily pull lands, the rebuild waits.")

    STALE_ALERT_HOURS = 6

    def waiting(self, target: str, result: dict) -> dict:
        """No new snapshot to deliver. If the bot would refuse grades now (snapshot stale or behind
        MFL's week), ask for the MFL inputs early and, after STALE_ALERT_HOURS, alert once."""
        v = self.ops.validate(self.cfg.checkout)
        if not v.get("failures"):
            if self.state().get("stale_since"):
                self.save_state(stale_since=None, stale_alerted=False)
            return result
        self.inputs(target, v.get("live_weeks"))
        st = self.state()
        since = st.get("stale_since") or now_utc().isoformat()
        if not st.get("stale_since"):
            self.save_state(stale_since=since, stale_alerted=False)
            self.log(f"the bot would return NO GRADE now ({'; '.join(v['failures'])[:300]}); waiting for the rebuilt snapshot")
        hours = (now_utc() - datetime.fromisoformat(since)).total_seconds() / 3600
        if hours >= self.STALE_ALERT_HOURS and not st.get("stale_alerted"):
            self.save_state(stale_alerted=True)
            self.alert("stale", f"The bot has been unable to grade for {hours:.1f} h (trades are held as NO GRADE) "
                                    f"and no newer snapshot has reached main: {'; '.join(v['failures'])[:400]}. "
                                    f"Check the Valuation snapshot rebuild workflow and the MFL daily snapshot.")
        return {**result, "bot_would_grade": False, "stale_hours": round(hours, 1)}

    def wait_for_restart(self, old_pid: int, since: float, log_offset: int, commit: str = "") -> int:
        deadline = time.time() + self.cfg.restart_timeout
        while time.time() < deadline:
            pid = self.ops.bot_pid()
            started = False
            try:
                with open(self.cfg.bot_log, "rb") as fh:
                    fh.seek(log_offset)
                    started = b"Trade polling started" in fh.read()
            except OSError:
                pass
            beat = {}
            try:
                if self.cfg.heartbeat.stat().st_mtime >= since:
                    beat = json.loads(self.cfg.heartbeat.read_text())
            except (OSError, ValueError):
                pass
            beat_commit = str(beat.get("commit") or "")
            if (pid and pid != old_pid and started and int(beat.get("pid") or 0) == pid
                    and (not commit or beat_commit in ("", "unknown", commit))):
                return pid
            time.sleep(2)
        raise Stop("restart", f"no healthy new bot process within {self.cfg.restart_timeout}s "
                              f"(pid {self.ops.bot_pid()}, previous {old_pid})")

    def restart_once(self, commit: str = "") -> int:
        old = self.ops.bot_pid()
        try:
            offset = self.cfg.bot_log.stat().st_size
        except OSError:
            offset = 0
        since = time.time()
        try:
            self.ops.restart()
        except Exception as exc:
            raise Stop("restart", f"launchctl kickstart failed: {exc}")
        return self.wait_for_restart(old, since, offset, commit)

    def rollback_checkout(self, to: str, reason: str) -> None:
        """Detach the checkout at `to` (no reset: main is not moved) and restart that code."""
        before = runtime_state(self.cfg.checkout)
        git(self.cfg.checkout, "switch", "--quiet", "--detach", to)
        if runtime_state(self.cfg.checkout) != before:
            self.log("rollback: runtime state changed during the switch (should be impossible)")
        self.log(f"rollback: checkout detached at {to[:8]} ({reason}); restarting the previous code")
        try:
            pid = self.restart_once(to)
            self.log(f"rollback: previous code running, pid {pid}")
        except Stop as exc:
            self.log(f"rollback: restart failed too: {exc}")

    def run(self) -> dict:
        lock = self.lock()
        if lock is None:
            self.log("another cutover run holds the lock: nothing done")
            return {"result": "locked"}
        try:
            self.forward_bot_alerts()
            res = self._run()
        except Stop as exc:
            self.log(f"STOPPED at {exc.stage}: {exc.reason}")
            self.alert(exc.stage, self.alert_text(exc))
            res = {"result": "stopped", "stage": exc.stage, "reason": exc.reason}
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()
        if self.alert_failed:
            res["alert_delivery"] = "failed: see alert_failures.json"
        if self.unresolved:
            res["incident"] = "NOT closed: see alert_failures.json"
            if res.get("result") == "cutover":
                res["result"] = "cutover_unconfirmed"
        return res

    def alert_text(self, exc: Stop) -> str:
        return (f"The trade bot did **not** receive a new valuation snapshot. Stage **{exc.stage}**: {exc.reason}\n\n"
                f"The running bot was left as it was (or restored to the previous commit), and its runtime "
                f"state was not touched. Until this is fixed, trades after the snapshot goes stale are held as "
                f"NO GRADE and retried once after a successful cutover.\n\nLocal log: "
                f"`~/Library/Application Support/ups-roast-bot/cutover/cutover.log`")

    def _run(self) -> dict:
        co = self.cfg.checkout
        target = self.preflight()
        head = git(co, "rev-parse", "HEAD")
        st = self.state()
        if head == target:
            if st.get("pulled_to") == head and st.get("restarted_for") != head:
                if self._bot_commit() == head:
                    self.save_state(restarted_for=head)
                    self.log(f"the bot already runs {head[:8]}: no restart")
                    return {"result": "up_to_date", "head": head}
                self.log(f"checkout at {head[:8]} was pulled but the bot was not restarted on it: restarting")
                return self.finish(head, head, None)
            self.log(f"up to date at {head[:8]}: no pull, no restart")
            return self.waiting(target, {"result": "up_to_date", "head": head})
        cur, new = snapshot_at(co, head), snapshot_at(co, target)
        if new is None or (cur and new == cur):
            self.log(f"origin/{self.cfg.branch} {target[:8]} has no newer valuation snapshot: no pull, no restart")
            return self.waiting(target, {"result": "no_new_snapshot", "head": head, "target": target})
        if cur and str(new.get("as_of")) <= str(cur.get("as_of")):
            self.log(f"snapshot on origin is not newer ({new.get('as_of')} vs {cur.get('as_of')}): nothing done")
            return self.waiting(target, {"result": "no_new_snapshot", "head": head, "target": target})
        if subprocess.run(["git", "-C", str(co), "merge-base", "--is-ancestor", head, target]).returncode != 0:
            raise Stop("pull", f"origin/{self.cfg.branch} is not a fast-forward of the checkout ({head[:8]})")
        changed = set(git(co, "diff", "--name-only", head, target).splitlines())
        code = sorted(changed & bot_code_files(co))
        if code:
            raise Stop("code-gate", f"bot code changed on {self.cfg.branch} ({', '.join(code)}): a code change "
                                    f"needs a reviewed manual cutover, not this snapshot job")
        self.log(f"new snapshot on origin: as of {new.get('as_of')} week "
                 f"{(new.get('season_state') or {}).get('weeks_completed')} at {target[:8]} (checkout {head[:8]})")

        # 4 + 6a: CI and validation on the exact commit, before the checkout moves
        with tempfile.TemporaryDirectory(prefix="cutover-", dir=self.cfg.state_dir) as td:
            wt = Path(td) / "tree"
            git(co, "worktree", "add", "--quiet", "--detach", str(wt), target)
            try:
                rc, summary = self.ops.run_suite(wt)
                if rc != 0:
                    raise Stop("ci", f"the safe suite failed on {target[:8]} (exit {rc}): {summary}")
                self.log(f"ci: {summary or 'passed'} on {target[:8]}")
                pre = self.ops.validate(wt)
                if pre.get("failures"):
                    raise Stop("validate", f"the bot's Python refuses the new snapshot: {'; '.join(pre['failures'])[:400]}")
                if pre.get("as_of") != new.get("as_of"):
                    raise Stop("validate", f"loaded snapshot as of {pre.get('as_of')}, expected {new.get('as_of')}")
            finally:
                git(co, "worktree", "remove", "--force", str(wt), check=False)

        # 5: fast-forward, runtime state byte for byte
        before = runtime_state(co)
        try:
            git(co, "merge", "--ff-only", "--quiet", target)
        except RuntimeError as exc:
            raise Stop("pull", f"fast-forward refused: {exc}")
        after = runtime_state(co)
        if after != before:
            moved = sum(1 for k in set(before) | set(after) if before.get(k) != after.get(k))
            self.log("runtime files changed during the pull: " + ", ".join(
                sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))))
            self.rollback_checkout(head, "runtime state changed during the pull")
            raise Stop("runtime-state", f"{moved} gitignored/untracked runtime file(s) changed during the pull; "
                                        f"checkout restored to {head[:8]}")
        self.save_state(pulled_to=target, pulled_from=head, pulled_at=now_utc().isoformat())
        self.log(f"pull: {head[:8]} -> {target[:8]}, {len(before)} runtime files byte for byte unchanged")
        return self.finish(target, head, new)

    def finish(self, target: str, previous: str, new: dict | None) -> dict:
        co = self.cfg.checkout
        post = self.ops.validate(co)                                      # 6b
        if post.get("failures"):
            self.rollback_checkout(previous, "post-pull validation failed")
            raise Stop("validate", f"in the checkout: {'; '.join(post['failures'])[:400]}")
        try:
            entries = self.held_snapshot()                                # exact held set, before restart
        except Stop:
            if previous != target:
                self.rollback_checkout(previous, "held-trades file failed just before the restart")
            raise
        held_keys = [list(held_trades.key(e)) for e in held_trades.pending(entries)]
        stuck = [list(held_trades.key(e)) for e in held_trades.unfinished(entries)]
        self.save_state(held_keys_at_restart=held_keys)
        self.log(f"held trades before the restart: {len(held_keys)} pending {held_keys}; "
                 f"{len(stuck)} started-but-unfinished {stuck}")
        try:
            pid = self.restart_once(target)                               # 7 + 8
        except Stop:
            if previous != target:
                self.rollback_checkout(previous, "restart failed")
            raise
        check = self.ops.validate(co)
        if check.get("failures") or (new and check.get("as_of") != new.get("as_of")):
            raise Stop("verify", f"after the restart the bot's Python sees {check}")
        self.save_state(restarted_for=target, restarted_pid=pid, restarted_at=now_utc().isoformat(),
                        snapshot_as_of=check.get("as_of"), snapshot_weeks=check.get("weeks"))
        self.log(f"restart: new pid {pid}; snapshot as of {check.get('as_of')} week {check.get('weeks')} "
                 f"(MFL counts week {check.get('live_weeks')})")
        held = self.reconcile_held(held_keys, stuck)                      # 9
        result = {"target": target, "previous": previous, "pid": pid, "as_of": check.get("as_of"),
                  "weeks": check.get("weeks"), "held": held}
        if held["review"]:
            self.alert("held-review", "The snapshot reached the bot, but these held trades did not all finish "
                                      "as posted, so this cutover needs manual review (nothing is retried again "
                                      "automatically):\n" + "\n".join(f"- {k}: {o}" for k, o in held["outcomes"]))
            return {**result, "result": "manual_review"}
        self.resolve(f"Cutover succeeded: bot pid {pid} on {target[:8]}, snapshot as of {check.get('as_of')} "
                     f"(week {check.get('weeks')}); held trades: {held['outcomes'] or 'none'}.")
        return {**result, "result": "cutover"}

    def _bot_commit(self) -> str:
        try:
            return str(json.loads(self.cfg.heartbeat.read_text()).get("commit") or "")
        except (OSError, ValueError):
            return ""

    def reconcile_held(self, keys: list, stuck: list) -> dict:
        """Wait for the bot's one retry of each exact held entry; success only if every one is
        'posted'. Anything else (held_again, error, started-but-unfinished, missing, unreadable)
        is manual review."""
        deadline = time.time() + (self.cfg.held_wait if keys else 0)
        entries = None
        while True:
            try:
                entries = held_trades.load(self.cfg.held_file)
                by = {held_trades.key(e): e for e in entries}
                if all("outcome" in (by.get(tuple(k), {}).get("retry") or {}) for k in keys):
                    break
            except held_trades.HeldStateError:
                entries = None
            if time.time() >= deadline:
                break
            time.sleep(5)
        outcomes = []
        if entries is None:
            outcomes = [(tuple(k), "UNKNOWN: held-trades file unreadable") for k in keys] or [("file", "unreadable")]
        else:
            by = {held_trades.key(e): e for e in entries}
            for k in keys:
                e = by.get(tuple(k))
                r = (e or {}).get("retry") or {}
                outcomes.append((tuple(k), "MISSING from the file" if e is None else
                                 r.get("outcome") or ("started, never finished" if r else "not attempted")))
        outcomes += [(tuple(k), "started, never finished (before this cutover)") for k in stuck]
        review = any(o != "posted" for _, o in outcomes)
        self.log(f"held trades after the restart: {outcomes or 'none'}{' -> MANUAL REVIEW' if review else ''}")
        return {"keys": keys, "outcomes": outcomes, "review": review}

    def rollback(self, to: str) -> dict:
        lock = self.lock()
        if lock is None:
            return {"result": "locked"}
        try:
            self.rollback_checkout(git(self.cfg.checkout, "rev-parse", to), "manual rollback")
            return {"result": "rolled_back", "head": git(self.cfg.checkout, "rev-parse", "HEAD")}
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()

    def recover(self) -> dict:
        """After a rollback: back onto the branch (no pull), then a normal run."""
        if git(self.cfg.checkout, "status", "--porcelain", "--untracked-files=no"):
            raise SystemExit("the checkout has tracked changes: resolve them first")
        git(self.cfg.checkout, "switch", "--quiet", self.cfg.branch)
        # The branch may be ahead of the code the bot runs (it was rolled back): the next run
        # validates and restarts it, unless the bot's heartbeat shows it already runs it.
        self.save_state(pulled_to=git(self.cfg.checkout, "rev-parse", "HEAD"), restarted_for=None)
        return self.run()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sub.add_parser("status")
    rb = sub.add_parser("rollback")
    rb.add_argument("--to", required=True)
    sub.add_parser("recover")
    a = ap.parse_args(argv)
    job = Cutover(Config(), log=print)
    if a.cmd == "status":
        print(json.dumps({"state": job.state(), "bot_pid": job.ops.bot_pid(),
                          "head": git(job.cfg.checkout, "rev-parse", "--short", "HEAD")}, indent=1))
        return 0
    res = job.run() if a.cmd == "run" else job.rollback(a.to) if a.cmd == "rollback" else job.recover()
    print(json.dumps(res, indent=1, default=str))
    ok = res.get("result") in ("cutover", "up_to_date", "no_new_snapshot", "locked", "rolled_back")
    return 0 if ok and "alert_delivery" not in res else 1


if __name__ == "__main__":
    sys.exit(main())
