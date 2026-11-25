#!/usr/bin/env python3
"""Grade a trade on the inputs that existed BEFORE it was made (the held-trade catch-up path).

Why: the bot grades a trade on MFL's live standings and refuses (NO GRADE) when it reads them more
than 6 hours after the trade, because by then they may include later weeks
(trade_grader.STANDINGS_MAX_LAG_SECONDS). A trade held because the valuation snapshot was stale, or
seen late because the bot was down, can never be graded on live data again. This module does not
relax that guard. It replaces "live" with "as committed before the trade":

  pre-trade commit  the newest commit on main's first-parent chain whose committer time is before
                    the trade. Every input below is read from THAT commit (`git show`), so it is
                    demonstrably what existed when the trade was made.
  MFL daily folder  the newest data/mfl-snapshots/<date>/ in that commit: rosters, standings,
                    league (franchise names), the snapshot meta. Its availability time is the
                    committer time of the first-parent commit that added its leagueStandings.json.
  valuation inputs  pipelines/etl/inputs/valuation/* and the in-season coefficients in that commit.
  valuation snapshot built by build_valuation_snapshot.py (today's generator, so today's rules)
                    from exactly those inputs, as of the folder's date, and validated by the
                    grader's own validate_snapshot against them, with the trade time as "now".
  standings check   the standings must still be the trade's: the first MFL folder committed AFTER
                    the trade (else a live read supplied by the caller) must show the same weeks
                    completed. Identical rows = exact; same weeks but changed numbers = graded with
                    a note; a different week count = cannot be graded reliably (never guessed).
  salary adjustments MFL's export, rows timestamped at or before the trade (display only).
  transactions      moves by either franchise between the folder and the trade are listed; a move
                    of a traded asset in that window makes the trade ungradable.

Nothing here posts, writes the held file, reads secrets or touches the cursor. Network: none (the
caller passes any live MFL reads).
"""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))

import build_valuation_snapshot as bvs  # noqa: E402
import pick_valuation as pv  # noqa: E402
import valuation_snapshot as vs  # noqa: E402

FOLDERS = "data/mfl-snapshots"
INPUT_PATHS = ("pipelines/etl/inputs/valuation", "pipelines/etl/config/future_pick_inseason_coefficients.json")
FOLDER_FILES = ("rosters.json", "leagueStandings.json", "_snapshot_meta.json", "league.json")


def iso(ts: float) -> str:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _git(repo, *args) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL).decode()


def _git_bytes(repo, *args) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL)


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


@dataclass
class AsOf:
    """Everything the grader needs for one trade, as of before it, with provenance."""
    trade_ts: int
    ref: str
    commit: str = ""
    commit_time: int = 0
    folder: str = ""
    folder_available_at: int = 0
    folder_commit: str = ""
    root: Path | None = None          # temp tree of the pre-trade inputs (validate_snapshot repo=)
    snapshot: dict | None = None
    season_state: object = None       # pick_valuation.SeasonState
    rosters: dict = field(default_factory=dict)
    franchises: dict = field(default_factory=dict)
    salary_adjustments: dict | None = None
    provenance: list = field(default_factory=list)   # [{input, source, available_at, sha256, note}]
    blocking: list = field(default_factory=list)     # reasons it cannot be graded reliably
    notes: list = field(default_factory=list)        # graded, but worth saying

    @property
    def ok(self) -> bool:
        return not self.blocking and self.snapshot is not None

    def cleanup(self):
        if self.root and Path(self.root).exists():
            shutil.rmtree(self.root, ignore_errors=True)


def first_parent_commits(repo, ref: str) -> list:
    """[(sha, committer_ts)] newest first."""
    out = _git(repo, "log", "--first-parent", "--format=%H %ct", ref)
    return [(a, int(b)) for a, b in (line.split() for line in out.splitlines() if line.strip())]


def pre_trade_commit(repo, ref: str, trade_ts: int):
    for sha, ct in first_parent_commits(repo, ref):
        if ct < trade_ts:
            return sha, ct
    return None, None


def folders_in(repo, commit: str) -> list:
    try:
        out = _git(repo, "ls-tree", "--name-only", f"{commit}:{FOLDERS}")
    except subprocess.CalledProcessError:          # no daily folders at that commit
        return []
    return sorted(d for d in out.split() if len(d) == 10 and d[4] == "-")


def folder_added(repo, ref: str, folder: str):
    """(commit, committer_ts) of the first first-parent commit on ref that has the folder's standings."""
    out = _git(repo, "log", "--first-parent", "--diff-filter=A", "--format=%H %ct", ref, "--",
               f"{FOLDERS}/{folder}/leagueStandings.json")
    rows = [line.split() for line in out.splitlines() if line.strip()]
    if not rows:
        return None, None
    sha, ct = rows[-1]
    return sha, int(ct)


def standings_rows(standings: dict) -> dict:
    rows = standings["leagueStandings"]["franchise"]
    rows = rows if isinstance(rows, list) else [rows]
    return {r["id"]: (str(r.get("all_play_wlt")), str(r.get("all_play_pct")), str(r.get("pf"))) for r in rows}


def season_state_from(standings: dict, season: int, available_at: int):
    rows = standings["leagueStandings"]["franchise"]
    rows = rows if isinstance(rows, list) else [rows]
    weeks = bvs.weeks_completed(standings)
    if weeks == 0:
        return pv.SeasonState(season, "offseason", as_of=str(available_at))
    return pv.SeasonState(season, "in_season", weeks_completed=weeks,
                          allplay_pct={r["id"]: float(r["all_play_pct"]) for r in rows},
                          points_for={r["id"]: float(r["pf"]) for r in rows}, as_of=str(available_at))


def _materialize(repo, commit: str, folder: str) -> Path:
    """A temp tree holding exactly the pre-trade commit's inputs and MFL folder."""
    root = Path(tempfile.mkdtemp(prefix="trade-asof-"))
    paths = list(INPUT_PATHS) + [f"{FOLDERS}/{folder}"]
    archive = _git_bytes(repo, "archive", "--format=tar", commit, *paths)
    subprocess.run(["tar", "-x", "-C", str(root)], input=archive, check=True)
    return root


def build_snapshot(root: Path, folder: str, generated_at: str) -> dict:
    """build_valuation_snapshot.build on the inputs in `root` (the pre-trade tree), unchanged generator.

    The generator reads its inputs from module paths, so they are pointed at `root` for this call
    only (as replay_2026_trade_grades.py does for its as-of folders); input paths are recorded
    relative to `root`, so validate_snapshot(repo=root) checks them there. The generator itself is
    named from the repo, as always."""
    saved = (bvs.INPUT_DIR, bvs.COEFFICIENTS, bvs.rel)
    root = Path(root).resolve()

    def rel(path):
        p = Path(path).resolve()
        return str(p.relative_to(root)) if p.is_relative_to(root) else saved[2](p)
    bvs.INPUT_DIR = root / saved[0].relative_to(bvs.REPO)
    bvs.COEFFICIENTS = root / saved[1].relative_to(bvs.REPO)
    bvs.rel = rel
    try:
        return bvs.build(folder, generated_at, allow_dirty=True, snapshot_dir=root / FOLDERS / folder)
    finally:
        bvs.INPUT_DIR, bvs.COEFFICIENTS, bvs.rel = saved


def _assets(trade_txn: dict) -> set:
    return {t.strip() for k in ("franchise1_gave_up", "franchise2_gave_up")
            for t in str(trade_txn.get(k, "")).split(",") if t.strip() and not t.strip().startswith("BB_")}


def _moved(txn: dict, assets: set) -> set:
    """Traded assets a transaction names (any field, any MFL separator)."""
    text = json.dumps(txn)
    for sep in "|,'\"{}[]: ":
        text = text.replace(sep, " ")
    return assets & set(text.split())


def resolve(trade_txn: dict, *, repo=REPO, ref: str = "origin/main", live_standings=None,
            live_read_at: float | None = None, salary_adjustment_rows=None, later_transactions=None) -> AsOf:
    """The as-of inputs for one trade.

    live_standings / live_read_at: MFL leagueStandings read now, used for the standings check only
    when no folder was committed after the trade. salary_adjustment_rows: MFL salaryAdjustments
    rows (filtered here to the trade's time; None = cap space without adjustments, said so).
    later_transactions: MFL transactions to look for moves between the folder and the trade (None
    = the first later folder's transactions.json, else unchecked, said so)."""
    trade_ts = int(trade_txn.get("timestamp", 0) or 0)
    a = AsOf(trade_ts=trade_ts, ref=ref)
    a.commit, a.commit_time = pre_trade_commit(repo, ref, trade_ts)
    if not a.commit:
        a.blocking.append(f"no commit on {ref} predates the trade ({iso(trade_ts)})")
        return a
    for f in reversed([f for f in folders_in(repo, a.commit) if f <= iso(trade_ts)[:10]]):
        names = set(_git(repo, "ls-tree", "--name-only", f"{a.commit}:{FOLDERS}/{f}/").split())
        if all(n in names for n in FOLDER_FILES):
            a.folder = f
            break
    if not a.folder:
        a.blocking.append(f"no complete MFL daily folder in {a.commit[:8]} predates the trade")
        return a
    a.folder_commit, a.folder_available_at = folder_added(repo, ref, a.folder)
    if not a.folder_available_at or a.folder_available_at >= trade_ts:
        a.blocking.append(f"MFL folder {a.folder} was not committed before the trade")
        return a

    def show(path):
        return _git_bytes(repo, "show", f"{a.commit}:{path}")

    base = f"{FOLDERS}/{a.folder}"
    raw = {n: show(f"{base}/{n}") for n in FOLDER_FILES}
    for n, b in raw.items():
        a.provenance.append({"input": f"MFL {n}", "source": f"git {a.commit[:12]}:{base}/{n}",
                             "available_at": iso(a.folder_available_at), "sha256": sha256(b),
                             "note": f"daily pull committed in {a.folder_commit[:12]}"})
    standings = json.loads(raw["leagueStandings.json"])
    season = int(json.loads(raw["_snapshot_meta.json"])["season_year"])
    a.season_state = season_state_from(standings, season, a.folder_available_at)
    league = json.loads(raw["league.json"])["league"]["franchises"]["franchise"]
    a.franchises = {f["id"]: f.get("name", f"Franchise {f['id']}") for f in league}
    for fr in json.loads(raw["rosters.json"])["rosters"]["franchise"]:
        ps = fr.get("player") or []
        a.rosters[fr["id"]] = ps if isinstance(ps, list) else [ps]

    # Valuation inputs as committed before the trade, with when each last changed.
    missing = [p for p in INPUT_PATHS
               if not _git(repo, "ls-tree", "-r", "--name-only", a.commit, "--", p).strip()]
    if missing:
        a.blocking.append(f"valuation inputs {missing} were not committed before the trade, so there is no "
                          f"as-of valuation to grade it on")
        return a
    for p in INPUT_PATHS:
        for path in _git(repo, "ls-tree", "-r", "--name-only", a.commit, "--", p).split():
            changed = _git(repo, "log", "-1", "--first-parent", "--format=%H %ct", a.commit, "--", path).split()
            a.provenance.append({"input": Path(path).name, "source": f"git {a.commit[:12]}:{path}",
                                 "available_at": iso(int(changed[1])) if changed else "",
                                 "sha256": sha256(show(path)),
                                 "note": f"last changed in {changed[0][:12]}" if changed else ""})

    # The standings must still be the trade's.
    post = None
    for f in [f for f in folders_in(repo, ref) if f > a.folder]:
        sha, ct = folder_added(repo, ref, f)
        if ct and ct > trade_ts:
            post = (f, sha, ct)
            break
    post_standings = None
    if post:
        post_standings = json.loads(_git_bytes(repo, "show", f"{post[1]}:{FOLDERS}/{post[0]}/leagueStandings.json"))
        post_label, post_at = f"MFL folder {post[0]} (committed {iso(post[2])})", post[2]
        if later_transactions is None:
            try:
                later_transactions = json.loads(_git_bytes(
                    repo, "show", f"{post[1]}:{FOLDERS}/{post[0]}/transactions.json"))["transactions"]["transaction"]
            except Exception:
                later_transactions = None
    elif live_standings is not None:
        post_standings, post_label, post_at = live_standings, f"MFL live standings read {iso(live_read_at)}", live_read_at
    if post_standings is None:
        a.blocking.append("no standings after the trade to confirm the folder's standings were still current at the trade")
    else:
        w_pre, w_post = bvs.weeks_completed(standings), bvs.weeks_completed(post_standings)
        a.provenance.append({"input": "standings check", "source": post_label, "available_at": iso(post_at),
                             "sha256": sha256(json.dumps(post_standings, sort_keys=True).encode()),
                             "note": f"weeks completed {w_pre} before the trade, {w_post} after"})
        if w_pre != w_post:
            a.blocking.append(f"standings moved from week {w_pre} to week {w_post} between the folder "
                              f"({iso(a.folder_available_at)}) and {post_label}: the trade's own standings are not "
                              f"pinned, so it cannot be graded reliably")
        elif standings_rows(standings) != standings_rows(post_standings):
            a.notes.append(f"standings numbers changed between the folder and {post_label} without a new week "
                           f"(a stat correction); graded on the folder's standings")
        else:
            a.notes.append(f"standings identical in the folder ({iso(a.folder_available_at)}) and {post_label}, "
                           f"so they are exactly the standings at the trade")

    # Moves between the folder and the trade.
    if later_transactions is None:
        a.notes.append("moves between the folder and the trade were not checked (no later transaction list)")
    else:
        rows = later_transactions if isinstance(later_transactions, list) else [later_transactions]
        sides = {trade_txn.get("franchise"), trade_txn.get("franchise2")}
        assets = _assets(trade_txn)
        me = (str(trade_txn.get("timestamp")), trade_txn.get("franchise"), trade_txn.get("franchise2"))
        found = 0
        for t in rows:
            ts = int(t.get("timestamp", 0) or 0)
            if not (a.folder_available_at < ts < trade_ts) or (str(t.get("timestamp")), t.get("franchise"),
                                                               t.get("franchise2")) == me:
                continue
            if not ({t.get("franchise"), t.get("franchise2")} & sides):
                continue
            found += 1
            moved = _moved(t, assets)
            label = f"{t.get('type')} by {t.get('franchise')} at {iso(ts)}"
            if moved:
                a.blocking.append(f"{label} moved traded asset(s) {sorted(moved)} after the folder, so the "
                                  f"folder's rosters are not the trade's")
            else:
                a.notes.append(f"{label} happened after the folder (no traded asset); cap space may differ slightly")
        if not found:
            a.notes.append(f"no moves by either franchise between the folder ({iso(a.folder_available_at)}) and "
                           f"the trade ({len(rows)} MFL transactions checked)")

    if salary_adjustment_rows is None:
        a.notes.append("cap space excludes salary adjustments (MFL salaryAdjustments not supplied)")
    else:
        adj = {}
        for r in salary_adjustment_rows:
            if int(r.get("timestamp", 0) or 0) <= trade_ts:
                fid = str(r.get("franchise_id", "")).zfill(4)
                adj[fid] = adj.get(fid, 0) + int(float(r.get("amount", 0) or 0))
        a.salary_adjustments = adj
        a.provenance.append({"input": "MFL salaryAdjustments", "source": "MFL export, rows at or before the trade",
                             "available_at": iso(trade_ts), "sha256": sha256(json.dumps(adj, sort_keys=True).encode()),
                             "note": "display only (cap space)"})

    if a.blocking:
        return a
    a.root = _materialize(repo, a.commit, a.folder)
    snap = build_snapshot(a.root, a.folder, iso(a.folder_available_at))
    failures = vs.validate_snapshot(snap, now=trade_ts, league_season=season,
                                    live_weeks_completed=a.season_state.weeks_completed or None, repo=a.root)
    if failures:
        a.blocking += [f"as-of valuation snapshot: {f}" for f in failures]
        return a
    a.snapshot = snap
    gen = snap["generator"]
    a.provenance.append({"input": "valuation snapshot (built for this trade)",
                         "source": f"build_valuation_snapshot.py @ {gen['commit'][:12]}"
                                   f"{' + uncommitted edits' if gen['dirty'] else ''}, from the inputs above",
                         "available_at": iso(a.folder_available_at), "sha256": snap["content_sha256"],
                         "note": f"as of {snap['as_of']}, through week {snap['season_state']['weeks_completed']}"})
    return a


def delayed_label(a: AsOf) -> str:
    """The fixed line every catch-up post carries (not model-written)."""
    from zoneinfo import ZoneInfo
    pulled = datetime.fromtimestamp(a.folder_available_at, tz=ZoneInfo("America/New_York")).strftime(
        "%b %-d, %-I:%M %p %Z")
    return (f"⏱️ Delayed post. Graded with the standings, rosters and valuations available before this trade "
            f"(MFL data pulled {pulled}, through week {a.snapshot['season_state']['weeks_completed']}).")


def grade(trade_txn: dict, a: AsOf, players_map: dict):
    """trade_grader.analyze_trade on the as-of inputs, with the trade time as "now"."""
    import trade_grader as tg
    if not a.ok:
        raise ValueError("as-of inputs are not usable: " + "; ".join(a.blocking))
    return tg.analyze_trade(trade_txn, players_map, a.franchises, a.rosters, season_state=a.season_state,
                            snapshot=a.snapshot, now=a.trade_ts, snapshot_repo=a.root,
                            salary_adjustments=a.salary_adjustments if a.salary_adjustments is not None else {})
