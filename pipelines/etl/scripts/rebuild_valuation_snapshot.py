#!/usr/bin/env python3
"""Keep the trade grader's valuation snapshot current, or say loudly that it isn't (#1343 decision 3 follow-up).

Keith 2026-10-21: rebuild the snapshot after each completed week, validate freshness and source coverage, keep the
previous valid snapshot when a rebuild fails, and alert instead of ever grading on stale data. Run by
.github/workflows/valuation-snapshot-rebuild.yml; usable by hand.

  rebuild  Is a rebuild due? A new week is complete in the latest data/mfl-snapshots/<date> standings, the season
           changed, or the committed snapshot is old enough that it will go stale before the next daily run. If due,
           build to a temporary file, run every check the grader runs plus the source-coverage checks below, and
           only then replace data/valuation/trade_valuation_snapshot.json. A failed build leaves the committed
           snapshot byte for byte as it was.
             exit 0  rebuilt, or not due        exit 2  due but the new build failed (previous snapshot kept)
  check    Would the bot grade right now? Validates the committed snapshot exactly as trade_grader.analyze_trade
           does: its valuation_snapshot.validate_snapshot, with weeks completed from MFL's live leagueStandings
           read by trade_grader.load_season_state. `--ref origin/main` checks what is actually on that ref (in a
           temporary worktree), so a rebuilt snapshot that was committed but never pushed is not "delivered".
             exit 0  the bot would grade        exit 3  the bot would return NO GRADE (reasons printed)
             exit 4  MFL's standings could not be read, so the check could not run

Source coverage a new build must have before it replaces the old one:
  - every rostered player is in the valuation registry (else the registry needs extract_valuation_inputs.py, which
    reads the local league DB, and cannot run here);
  - 12 franchises in the rosters, 12 rows in the standings, 12 career blocks;
  - at least 90% as many valued players as the snapshot it replaces (a truncated roster export is refused);
  - an as-of date later than the snapshot it replaces (never goes backwards).

Every result is also written as JSON (--status-out) for the workflow's alert. Nothing here grades a trade, posts to
Discord, or reads D1.
"""
import argparse
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))

import build_valuation_snapshot as bvs  # noqa: E402
import valuation_snapshot as vs  # noqa: E402

SNAPSHOTS_DIR = REPO / "data" / "mfl-snapshots"
# Refresh before the limit, so one missed daily run never makes the grader refuse: in season a snapshot is rebuilt
# when it reaches 6 days (limit 8), in the offseason at 7 days (limit 14).
REFRESH_AGE_DAYS = {True: vs.IN_SEASON_MAX_AGE_DAYS - 2, False: 7}
MIN_PLAYER_RATIO = 0.90
FRANCHISES = 12


def age_days(as_of: str, now: datetime) -> float:
    """Days since the end of as_of, the way valuation_snapshot measures it."""
    end = datetime.strptime(as_of, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
    return (now - end).total_seconds() / 86400


def latest_daily_folder(snapshots_dir: Path, as_of: str | None = None) -> Path | None:
    """data/mfl-snapshots/<as_of>, or the newest dated folder with rosters, standings and meta."""
    need = ("rosters.json", "leagueStandings.json", "_snapshot_meta.json")
    if as_of:
        d = snapshots_dir / as_of
        return d if all((d / n).exists() for n in need) else None
    dated = sorted((p for p in snapshots_dir.iterdir() if p.is_dir() and len(p.name) == 10 and p.name[4] == "-"),
                   key=lambda p: p.name, reverse=True) if snapshots_dir.exists() else []
    for d in dated:
        if all((d / n).exists() for n in need):
            return d
    return None


def folder_state(folder: Path) -> dict:
    standings = json.loads((folder / "leagueStandings.json").read_text())
    meta = json.loads((folder / "_snapshot_meta.json").read_text())
    rows = standings["leagueStandings"]["franchise"]
    return {"as_of": folder.name, "season": int(meta["season_year"]),
            "weeks_completed": bvs.weeks_completed(standings), "standings_rows": len(rows if isinstance(rows, list) else [rows])}


def rebuild_due(current: dict | None, current_failures: list, folder: dict, now: datetime) -> tuple[bool, str]:
    """(due, why). Never due for data older than or as old as the current snapshot."""
    if current is None:
        return True, "no committed snapshot"
    if folder["as_of"] <= str(current.get("as_of")):
        return False, f"the newest MFL snapshot ({folder['as_of']}) is not newer than the valuation snapshot ({current.get('as_of')})"
    if folder["season"] != current.get("season"):
        return True, f"season changed ({current.get('season')} -> {folder['season']})"
    cur_weeks = (current.get("season_state") or {}).get("weeks_completed") or 0
    if folder["weeks_completed"] > cur_weeks:
        return True, f"week {folder['weeks_completed']} is complete; the snapshot covers week {cur_weeks}"
    if current_failures:
        return True, "the committed snapshot fails validation: " + "; ".join(str(f) for f in current_failures)
    in_season = folder["weeks_completed"] >= 1 or cur_weeks >= 1
    age = age_days(str(current["as_of"]), now)
    if age >= REFRESH_AGE_DAYS[in_season]:
        return True, f"the snapshot is {age:.1f} days old (refresh at {REFRESH_AGE_DAYS[in_season]} {'in season' if in_season else 'in the offseason'})"
    return False, f"up to date: covers week {cur_weeks}, {age:.1f} days old"


def coverage_failures(new: dict, current: dict | None, folder: dict) -> list:
    f = []
    cov = new.get("coverage") or {}
    missing = cov.get("missing_from_registry") or []
    if missing:
        f.append(vs.Failure("source coverage", f"{len(missing)} rostered player(s) not in the valuation registry "
                            f"({', '.join(missing[:8])}{'…' if len(missing) > 8 else ''}): run extract_valuation_inputs.py, commit, then rebuild"))
    if (new.get("counts") or {}).get("franchises") != FRANCHISES:
        f.append(vs.Failure("source coverage", f"rosters list {(new.get('counts') or {}).get('franchises')} franchises, expected {FRANCHISES}"))
    if folder["standings_rows"] != FRANCHISES:
        f.append(vs.Failure("source coverage", f"standings list {folder['standings_rows']} franchises, expected {FRANCHISES}"))
    if current is not None:
        before, after = (current.get("counts") or {}).get("players") or 0, (new.get("counts") or {}).get("players") or 0
        if before and after < MIN_PLAYER_RATIO * before:
            f.append(vs.Failure("source coverage", f"only {after} valued players, down from {before} (a truncated roster export?)"))
        if str(new.get("as_of")) <= str(current.get("as_of")):
            f.append(vs.Failure("source coverage", f"as of {new.get('as_of')} is not after the current snapshot's {current.get('as_of')}"))
    return f


def do_rebuild(*, now: datetime, generated_at: str, as_of: str | None = None, out: Path | None = None,
               snapshots_dir: Path | None = None, force: bool = False, allow_dirty: bool = False,
               build=bvs.build, repo: Path | None = None) -> dict:
    out = vs.SNAPSHOT_PATH if out is None else Path(out)
    snapshots_dir = SNAPSHOTS_DIR if snapshots_dir is None else Path(snapshots_dir)
    folder_path = latest_daily_folder(snapshots_dir, as_of)
    if folder_path is None:
        return {"result": "failed", "exit": 2, "why": f"no complete MFL daily snapshot folder{' for ' + as_of if as_of else ''} under {snapshots_dir}",
                "failures": [], "kept": str(out)}
    folder = folder_state(folder_path)
    current, load_fail = vs.load_snapshot(out)
    current_failures = load_fail or (vs.validate_snapshot(current, now=now.timestamp(), league_season=folder["season"],
                                                          live_weeks_completed=folder["weeks_completed"] or None, repo=repo)
                                     if current is not None else [])
    due, why = rebuild_due(current, current_failures, folder, now)
    if force and not due and folder["as_of"] > str((current or {}).get("as_of")):
        due, why = True, "forced"
    status = {"as_of": folder["as_of"], "season": folder["season"], "weeks_completed": folder["weeks_completed"],
              "previous_as_of": (current or {}).get("as_of"),
              "previous_weeks": ((current or {}).get("season_state") or {}).get("weeks_completed"), "why": why}
    if not due and current_failures:
        # Nothing newer to build from, and what is committed no longer validates: say so, keep the file.
        return {**status, "result": "failed", "exit": 2, "why": "no newer MFL data to rebuild from, and the committed snapshot fails validation",
                "failures": [str(f) for f in current_failures], "kept": str(out)}
    if not due:
        return {**status, "result": "up_to_date", "exit": 0, "failures": []}
    new = build(folder["as_of"], generated_at, allow_dirty, snapshot_dir=folder_path)
    rendered = bvs.render(new)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / out.name
        tmp.write_bytes(rendered)
        reread, parse_fail = vs.load_snapshot(tmp)          # check the bytes that would be committed, not the dict
    failures = parse_fail or vs.validate_snapshot(reread, now=now.timestamp(), league_season=folder["season"],
                                                  live_weeks_completed=folder["weeks_completed"] or None, repo=repo)
    failures = list(failures) + coverage_failures(reread or new, current, folder)
    if failures:
        return {**status, "result": "failed", "exit": 2, "failures": [str(f) for f in failures], "kept": str(out)}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(rendered)
    return {**status, "result": "rebuilt", "exit": 0, "failures": [], "players": new["counts"]["players"],
            "content_sha256": new["content_sha256"]}


def do_check(*, now: datetime, season_state=None, path: Path | None = None, repo: Path | None = None) -> dict:
    """What the bot would do for a trade right now (trade_grader.analyze_trade's own steps)."""
    import trade_grader as tg
    if season_state is None:
        season_state = tg.load_season_state(0, now=now.timestamp())
    if season_state.status == "unavailable" and not season_state.weeks_completed:
        return {"result": "unknown", "exit": 4, "why": season_state.reason or "MFL leagueStandings unavailable", "failures": []}
    live = season_state.weeks_completed if season_state.status == "in_season" else None
    if season_state.status == "unavailable" and season_state.weeks_completed:
        live = season_state.weeks_completed
    snap, failures = vs.load_snapshot(path)
    if snap is not None:
        failures = vs.validate_snapshot(snap, now=now.timestamp(), league_season=tg.LEAGUE_SEASON,
                                        live_weeks_completed=live, repo=repo)
    base = {"live_weeks_completed": live, "snapshot_as_of": (snap or {}).get("as_of"),
            "snapshot_weeks": ((snap or {}).get("season_state") or {}).get("weeks_completed")}
    if failures:
        return {**base, "result": "no_grade", "exit": 3, "failures": [str(f) for f in failures]}
    return {**base, "result": "ok", "exit": 0, "failures": []}


def check_ref(ref: str, *, now: datetime, season_state=None, repo: Path | None = None) -> dict:
    """do_check on the snapshot exactly as it is on `ref`, with that ref's inputs (temporary worktree)."""
    import subprocess
    repo = REPO if repo is None else Path(repo)
    with tempfile.TemporaryDirectory(prefix="valuation-check-") as td:
        wt = Path(td) / "tree"
        add = subprocess.run(["git", "-C", str(repo), "worktree", "add", "--quiet", "--detach", str(wt), ref],
                             capture_output=True, text=True)
        if add.returncode != 0:
            return {"result": "no_grade", "exit": 3, "ref": ref,
                    "failures": [f"could not read {ref}: {add.stderr.strip()[:200]}"]}
        try:
            sha = subprocess.run(["git", "-C", str(wt), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            st = do_check(now=now, season_state=season_state, path=wt / "data" / "valuation" / "trade_valuation_snapshot.json",
                          repo=wt)
            return {**st, "ref": ref, "ref_sha": sha}
        finally:
            subprocess.run(["git", "-C", str(repo), "worktree", "remove", "--force", str(wt)], capture_output=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("rebuild")
    r.add_argument("--as-of", help="use data/mfl-snapshots/<date> (default: the newest complete folder)")
    r.add_argument("--now", help="UTC ISO time to decide freshness against (default: now)")
    r.add_argument("--generated-at", help="UTC ISO generation time recorded in the snapshot (default: --now)")
    r.add_argument("--force", action="store_true", help="rebuild even when not due (still never backwards)")
    r.add_argument("--status-out", type=Path)
    c = sub.add_parser("check")
    c.add_argument("--now", help="UTC ISO time (default: now)")
    c.add_argument("--ref", help="check the snapshot on this git ref (e.g. origin/main), not the working tree")
    c.add_argument("--status-out", type=Path)
    a = ap.parse_args(argv)
    now = datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now else datetime.now(timezone.utc)
    if a.cmd == "rebuild":
        gen = a.generated_at or now.strftime("%Y-%m-%dT%H:%M:%SZ")
        st = do_rebuild(now=now, generated_at=gen, as_of=a.as_of, force=a.force)
    elif a.ref:
        st = check_ref(a.ref, now=now)
    else:
        st = do_check(now=now)
    st = {"command": a.cmd, "checked_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), **st}
    if a.status_out:
        a.status_out.write_text(json.dumps(st, indent=1) + "\n")
    print(json.dumps(st, indent=1))
    return st["exit"]


if __name__ == "__main__":
    sys.exit(main())
