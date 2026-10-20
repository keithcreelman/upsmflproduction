"""The trade grader's one valuation input: load, validate, or refuse (decision 3).

Keith 2026-10-20 (#1343 decision 3): the grader reads only the repo's
canonical snapshot, data/valuation/trade_valuation_snapshot.json, built by
build_valuation_snapshot.py. Before any grade it must pass every check below.
If one fails, the trade gets

    VALUATION INPUTS UNAVAILABLE — NO GRADE

with each failed input and reason named: no letter, no score, no roast-model
call, no Discord post. Nothing is substituted.

Freshness (proposed, #1343):
  in season   the snapshot's standings must include the most recently completed
              week, and its data must be at most 8 days old: a weekly rebuild
              after Monday night's game, plus one day of slack.
  offseason   at most 14 days old. Prior-season stats do not move; what does is
              rosters (auction, rookie draft, waivers) and rookie ADP, and a
              traded player who is not in the snapshot is a NO GRADE anyway.
"""
import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pick_valuation as pv

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
SNAPSHOT_PATH = REPO / "data" / "valuation" / "trade_valuation_snapshot.json"
SCHEMA_VERSION = 1
MODEL_VERSION = "trade-valuation-1"
IN_SEASON_MAX_AGE_DAYS = 8
OFFSEASON_MAX_AGE_DAYS = 14
NO_GRADE_HEADER = "VALUATION INPUTS UNAVAILABLE — NO GRADE"
IDP_POSITIONS = {"DT", "DE", "DL", "EDGE", "NT", "LB", "ILB", "OLB", "MLB",
                 "CB", "S", "SS", "FS", "DB", "IDP"}
REBUILD_HINT = ("Rebuild it: python3 pipelines/etl/scripts/build_valuation_snapshot.py "
                "--as-of <YYYY-MM-DD> --generated-at <UTC time>, then commit it.")


@dataclass(frozen=True)
class Failure:
    input: str
    reason: str

    def __str__(self):
        return f"{self.input}: {self.reason}"


def canonical_body(snap: dict) -> bytes:
    """The bytes content_sha256 covers: every key but itself, sorted, compact."""
    body = {k: v for k, v in snap.items() if k != "content_sha256"}
    return json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def _no_duplicates(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValueError(f"duplicate key {k!r}")
        out[k] = v
    return out


def _rel(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(REPO))
    except ValueError:
        return str(path)


def load_snapshot(path: Path = SNAPSHOT_PATH):
    """(snapshot | None, [Failure]). Duplicate keys (e.g. a player id twice) are corruption."""
    label = f"valuation snapshot ({_rel(path)})"
    if not Path(path).exists():
        return None, [Failure(label, "file is missing")]
    try:
        return json.loads(Path(path).read_text(), object_pairs_hook=_no_duplicates), []
    except ValueError as exc:
        return None, [Failure(label, f"file is corrupt ({exc})")]


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def validate_snapshot(snap: dict, *, now: float, league_season: int,
                      live_weeks_completed: int | None = None, repo: Path = REPO) -> list:
    """Every reason this snapshot cannot be graded on (empty = valid)."""
    f = []
    label = "valuation snapshot"
    if snap.get("schema_version") != SCHEMA_VERSION:
        f.append(Failure(label, f"schema version {snap.get('schema_version')!r}, the grader reads {SCHEMA_VERSION}"))
        return f
    if snap.get("model_version") != MODEL_VERSION:
        f.append(Failure(label, f"model version {snap.get('model_version')!r}, the grader reads {MODEL_VERSION!r}"))
    if hashlib.sha256(canonical_body(snap)).hexdigest() != snap.get("content_sha256"):
        f.append(Failure(label, "content checksum does not match (the file was edited or damaged)"))
    if snap.get("season") != league_season:
        f.append(Failure(label, f"built for season {snap.get('season')}, but the league season is {league_season}"))

    # Freshness
    try:
        as_of = datetime.strptime(str(snap["as_of"]), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (KeyError, ValueError):
        f.append(Failure(label, f"as_of {snap.get('as_of')!r} is not a date"))
        as_of = None
    snap_weeks = (snap.get("season_state") or {}).get("weeks_completed")
    in_season = bool((live_weeks_completed or 0) >= 1 or (snap_weeks or 0) >= 1)
    if as_of is not None:
        age_days = (now - (as_of.timestamp() + 86400)) / 86400   # data through the end of as_of
        limit = IN_SEASON_MAX_AGE_DAYS if in_season else OFFSEASON_MAX_AGE_DAYS
        if age_days > limit:
            f.append(Failure(label, f"stale: built from data as of {snap['as_of']}, {age_days:.1f} days old "
                                    f"(limit {limit} days {'in season' if in_season else 'in the offseason'})"))
    if live_weeks_completed is not None and isinstance(snap_weeks, int) and snap_weeks < live_weeks_completed:
        f.append(Failure(label, f"stale: covers {league_season} standings through week {snap_weeks}, "
                                f"but week {live_weeks_completed} is complete"))

    # Inputs: each committed input must still be the file the snapshot was built from.
    for inp in snap.get("inputs") or []:
        path = repo / inp.get("path", "")
        name = f"input {inp.get('name')} ({inp.get('path')})"
        if not path.exists():
            f.append(Failure(name, "file is missing"))
        elif hashlib.sha256(path.read_bytes()).hexdigest() != inp.get("sha256"):
            f.append(Failure(name, "changed since the snapshot was built (checksum mismatch)"))
    if not snap.get("inputs"):
        f.append(Failure(label, "lists no inputs"))

    # Values
    dpp = (snap.get("dollars_per_point") or {}).get("value")
    if not _finite(dpp) or dpp <= 0:
        f.append(Failure("dollars per point", f"{dpp!r} is not a positive number"))
    curve = snap.get("pick_curve") or {}
    a, b = curve.get("A"), curve.get("B")
    if not (_finite(a) and _finite(b) and a > 0 and b > 0):
        f.append(Failure("pick curve", f"A={a!r}, B={b!r} is not a decreasing positive curve"))
    else:
        values = [a * math.exp(-b * n) for n in range(1, 37)]
        if any(x <= y for x, y in zip(values, values[1:])) or values[-1] <= pv.DEEP_ROUND_POINTS[4]:
            f.append(Failure("pick curve", "pick values are not strictly decreasing through 3.12 and above round 4"))
    players = snap.get("players")
    if not isinstance(players, dict) or not players:
        f.append(Failure("players", "no player valuations"))
        players = {}
    for pid, row in players.items():
        if not str(pid).isdigit():
            f.append(Failure("players", f"player id {pid!r} is not an MFL id"))
        if not isinstance(row, dict) or not row.get("pos"):
            f.append(Failure("players", f"player {pid} has no position"))
            continue
        ppg = row.get("ppg")
        if ppg is not None and not _finite(ppg):
            f.append(Failure("players", f"player {pid} has a non-finite PPG ({ppg!r})"))
    if (snap.get("counts") or {}).get("players") != len(players):
        f.append(Failure("players", "player count does not match the snapshot's own count"))
    career = snap.get("career")
    if not isinstance(career, dict) or len(career) != 12:
        f.append(Failure("career", f"expected 12 franchises, found {len(career) if isinstance(career, dict) else 0}"))
    return f


def trade_coverage(snap: dict, player_ids) -> list:
    """Failures for traded players the snapshot cannot value."""
    f = []
    players = snap.get("players") or {}
    for pid in player_ids:
        row = players.get(str(pid))
        if row is None:
            f.append(Failure(f"player {pid}", "not in the valuation snapshot (not rostered when it was built)"))
        elif row.get("ppg") is None and row.get("pos") not in IDP_POSITIONS:
            f.append(Failure(f"player {pid} ({row.get('name')}, {row.get('pos')})",
                             f"no projected PPG in the snapshot: {row.get('basis_text') or row.get('basis')}"))
    return f


def load_for_grading(*, now: float, league_season: int, live_weeks_completed: int | None = None,
                     path: Path = SNAPSHOT_PATH, repo: Path = REPO):
    """(snapshot | None, [Failure]); on success the valuations are loaded into pick_valuation."""
    snap, failures = load_snapshot(path)
    if snap is not None:
        failures = validate_snapshot(snap, now=now, league_season=league_season,
                                     live_weeks_completed=live_weeks_completed, repo=repo)
    if failures:
        pv.clear_valuation()
        return None, failures
    pv.use_snapshot(snap)
    return snap, []


def no_grade_message(failures, trade_label: str = "") -> str:
    lines = [NO_GRADE_HEADER]
    if trade_label:
        lines.append(trade_label)
    lines += [f"- {fail}" for fail in failures]
    lines.append("No letter, no score, no roast and no Discord post were produced. " + REBUILD_HINT)
    return "\n".join(lines)


def regrade_label(snap: dict, trade_ts: int) -> str:
    """Non-empty when the snapshot's data postdates the trade (a present-day regrade)."""
    try:
        as_of = datetime.strptime(snap["as_of"], "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    except (KeyError, ValueError, TypeError):
        return ""
    if trade_ts and as_of > trade_ts:
        return (f"PRESENT-DAY REGRADE: valuations as of {snap['as_of']} postdate this trade, "
                f"so this is not what was known when it was made.")
    return ""
