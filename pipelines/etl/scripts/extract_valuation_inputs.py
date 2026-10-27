#!/usr/bin/env python3
"""Extract the trade grader's valuation inputs into small, committed, checksummed files.

Decision 3 (Keith 2026-10-20, #1343): the grader reads one repo-owned snapshot
(build_valuation_snapshot.py), and every input to that snapshot is a committed
file whose sha256 the snapshot records. This step turns the local league
databases into those committed inputs. Database paths are ARGUMENTS: nothing
here knows where a Mac or iCloud keeps them.

Writes to pipelines/etl/inputs/valuation/:
  player_seasons_2023_2025.json   UPS-scored regular-season points / games / position
  player_ages.json                age at the latest season a player has one
  rookie_outcomes_2012_2023.json  rounds 1-3 draft slots and the player's next 3 seasons
  franchise_history_2010_2025.json  auction-of-record owner and final finish by season
  player_registry.json            name / position of every player on a 2026 roster
                                  snapshot, plus rookies' FantasyCalc superflex positional rank

  python3 pipelines/etl/scripts/extract_valuation_inputs.py \
      --league-db PATH/mfl_database.db --yoy-db PATH/yoy_signals.db \
      --assets-commit <git sha of site/rookies/franchise_assets_2026.json> \
      --adp-commit <git sha of site/rookies/external_adp_2026.json>

Read-only: databases are opened with mode=ro; git is used only for `git show`.
"""
import argparse
import hashlib
import json
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
OUT = REPO / "pipelines" / "etl" / "inputs" / "valuation"
FINISH_FIXTURE = REPO / "tests" / "fixtures" / "final_finish_history_2010_2025.json"
ASSETS_PATH = "site/rookies/franchise_assets_2026.json"
ADP_PATH = "site/rookies/external_adp_2026.json"
REPORTS = {2024: REPO / "site/reports/player_scoring/player_scoring_2024.json",
           2025: REPO / "site/reports/player_scoring/player_scoring_2025.json"}
STAT_SEASONS = (2023, 2024, 2025)
DRAFT_SEASONS = range(2012, 2024)          # every draft with three complete seasons after it


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_date(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).date().isoformat()


def dump(obj) -> bytes:
    """Deterministic JSON: sorted keys, fixed separators, one trailing newline."""
    return (json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), indent=None) + "\n").encode()


def write(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_bytes(dump(obj))
    print(f"wrote {OUT / name} ({(OUT / name).stat().st_size:,} bytes)")


def ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def git_show_json(commit: str, path: str) -> dict:
    return json.loads(subprocess.check_output(["git", "-C", str(REPO), "show", f"{commit}:{path}"]))


def git_commit_time(commit: str) -> str:
    return subprocess.check_output(["git", "-C", str(REPO), "show", "-s", "--format=%cI", commit]).decode().strip()


def source_meta(path: Path, what: str) -> dict:
    return {"source": what, "source_sha256": sha256_file(path), "source_file_date": file_date(path)}


ROOKIE_RANK_MIN_GAMES = 6                  # trade_grader.adp_implied_ppg's ranking rule


def roster_ids() -> set:
    """Every player on any committed 2026 MFL roster snapshot."""
    ids = set()
    for d in sorted((REPO / "data" / "mfl-snapshots").iterdir()):
        f = d / "rosters.json"
        if d.name.startswith("2026") and f.exists():
            for fr in json.loads(f.read_text())["rosters"]["franchise"]:
                ps = fr.get("player") or []
                for p in (ps if isinstance(ps, list) else [ps]):
                    ids.add(str(p["id"]))
    return ids


def extract_seasons(league_db: Path, rostered: set) -> dict:
    """Rows a 2026 valuation can read: every 2026-rostered player's 2023-2025
    seasons, and every 2025 season with 6+ games (the rookie positional ranks)."""
    db = ro(league_db)
    seasons = {}
    for season in STAT_SEASONS:
        rows = db.execute("SELECT player_id, reg_points, reg_games, position FROM player_pointssummary "
                          "WHERE season=? AND reg_games>0", (season,)).fetchall()
        seasons[str(season)] = {str(pid): [round(float(pts or 0), 2), int(g), pos or ""]
                                for pid, pts, g, pos in rows
                                if str(pid) in rostered
                                or (season == STAT_SEASONS[-1] and int(g) >= ROOKIE_RANK_MIN_GAMES)}
    checks = {}
    for season, path in REPORTS.items():
        rep = [p for p in json.loads(path.read_text())["players"] if p["player_id"] in seasons[str(season)]]
        ours = seasons[str(season)]
        same = sum(1 for p in rep if p["player_id"] in ours
                   and abs(ours[p["player_id"]][0] - float(p["total_points"] or 0)) < 0.11
                   and ours[p["player_id"]][1] == int(p["games_played"] or 0))
        checks[str(season)] = {"committed_report": str(path.relative_to(REPO)),
                               "rows_checked": len(rep), "identical_points_and_games": same}
    meta = source_meta(league_db, "legacy league database, player_pointssummary (UPS scoring, regular season)")
    meta.update({"seasons": list(STAT_SEASONS), "row_format": "[points, games, position]",
                 "rows_kept": "2026-rostered players' 2023-2025 seasons + every 2025 season with 6+ games",
                 "validated_against_committed_reports": checks})
    return {"meta": meta, "seasons": seasons}


def extract_ages(yoy_db: Path, rostered: set) -> dict:
    db = ro(yoy_db)
    latest = {}
    for pid, year, age in db.execute("SELECT player_id, year, age_at_season FROM yoy_player_signals "
                                     "WHERE age_at_season IS NOT NULL"):
        if str(pid) not in rostered:
            continue
        if pid not in latest or year > latest[pid][0]:
            latest[pid] = (int(year), int(age))
    meta = source_meta(yoy_db, "yoy_signals.db yoy_player_signals.age_at_season (MFL birthdates)")
    meta.update({"row_format": "[season, age_at_that_season]", "rows_kept": "players on a 2026 roster snapshot",
                 "rule": "age in season S = age_at_season + (S - season) (projection.py's rule)"})
    return {"meta": meta, "ages": {pid: list(v) for pid, v in sorted(latest.items())}}


def extract_rookie_outcomes(league_db: Path) -> dict:
    db = ro(league_db)
    pts = {(str(pid), int(s)): float(p or 0) for pid, s, p in
           db.execute("SELECT player_id, season, reg_points FROM player_pointssummary")}
    picks = []
    for season, rnd, slot, pid in db.execute(
            "SELECT season, CAST(draftpick_round AS INT), CAST(draftpick_roundorder AS INT), player_id "
            "FROM draftresults_combined WHERE CAST(draftpick_round AS INT) BETWEEN 1 AND 3 "
            "AND season BETWEEN ? AND ? ORDER BY season, 2, 3", (DRAFT_SEASONS.start, DRAFT_SEASONS.stop - 1)):
        y = [round(pts.get((str(pid), season + i), 0.0), 2) for i in range(3)]
        picks.append([int(season), rnd, slot, str(pid), y])
    meta = source_meta(league_db, "legacy league database, draftresults_combined + player_pointssummary")
    meta.update({"drafts": [DRAFT_SEASONS.start, DRAFT_SEASONS.stop - 1],
                 "row_format": "[draft_season, round, slot, player_id, [points_y1, points_y2, points_y3]]",
                 "rule": "a season with no UPS points row counts 0"})
    return {"meta": meta, "picks": picks}


def extract_franchise_history(league_db: Path) -> dict:
    db = ro(league_db)
    owners = {}
    for season, fid, owner in db.execute("SELECT season, franchise_id, owner_name FROM franchises ORDER BY 1, 2"):
        owners.setdefault(str(season), {})[str(fid)] = owner
    fx = json.loads(FINISH_FIXTURE.read_text())
    meta = source_meta(league_db, "legacy league database franchises.owner_name (auction-of-record, canon §D.2)")
    meta.update({
        "finishes_source": str(FINISH_FIXTURE.relative_to(REPO)),
        "finishes_source_sha256": sha256_file(FINISH_FIXTURE),
        "finishes_rule": "final finish from the playoff and Hawk Tuah bracket games",
        "seasons": [min(int(s) for s in owners), max(int(s) for s in owners)],
    })
    return {"meta": meta, "owners": owners, "finishes": fx["finishes"]}


def extract_registry(league_db: Path, assets_commit: str, adp_commit: str) -> dict:
    db = ro(league_db)
    reg = {}
    # Latest season's own name/position first (player_pointssummary is complete for
    # every scored player), dim_player second.
    for pid, name, pos in db.execute("SELECT player_id, player_name, position FROM player_pointssummary "
                                     "WHERE position IS NOT NULL AND position<>'' ORDER BY season"):
        reg[str(pid)] = {"name": name or "", "pos": pos}
    for pid, name, pos in db.execute("SELECT player_id, player_name, position FROM dim_player"):
        if str(pid) not in reg and pos:
            reg[str(pid)] = {"name": name or "", "pos": pos}
    needed = roster_ids()
    # franchise_assets_2026.json at --assets-commit, then back through its history
    # for 2026 players who were dropped before that commit.
    history = subprocess.check_output(["git", "-C", str(REPO), "log", "--format=%H", assets_commit,
                                       "--", ASSETS_PATH]).decode().split()
    from_assets, used = {}, []
    for commit in history:
        if not (needed - set(reg) - set(from_assets)) and used:
            break
        used.append(commit[:8])
        for fr in git_show_json(commit, ASSETS_PATH)["by_fid"].values():
            for a in (fr.get("players") or []):
                pid = str(a.get("player_id") or "")
                if pid and pid not in from_assets and a.get("position"):
                    from_assets[pid] = {"name": a.get("display", ""), "pos": a["position"]}
    adp = git_show_json(adp_commit, ADP_PATH)["by_mfl_id"]
    out, missing = {}, []
    for pid in sorted(needed, key=int):
        rec = reg.get(pid) or from_assets.get(pid)
        if not rec or not rec["pos"]:
            missing.append(pid)
            continue
        row = {"name": rec["name"], "pos": rec["pos"]}
        rank = (adp.get(pid) or {}).get("fantasycalc_sf_pos_rank")
        if rank:
            row["rookie_pos_rank"] = int(rank)
        out[pid] = row
    meta = source_meta(league_db, "legacy league database player_pointssummary / dim_player (name, MFL position)")
    meta.update({
        "assets_source": ASSETS_PATH, "assets_commit": assets_commit, "assets_commits_read": len(used),
        "assets_commit_time": git_commit_time(assets_commit),
        "adp_source": ADP_PATH, "adp_commit": adp_commit, "adp_commit_time": git_commit_time(adp_commit),
        "adp_rule": "rookie_pos_rank = FantasyCalc superflex positional rank (the only rookie ADP keyed by MFL id)",
        "covers": "every player on any 2026 MFL roster snapshot (data/mfl-snapshots)",
        "unresolved": missing,
    })
    return {"meta": meta, "players": out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-db", required=True, type=Path)
    ap.add_argument("--yoy-db", required=True, type=Path)
    ap.add_argument("--assets-commit", required=True)
    ap.add_argument("--adp-commit", required=True)
    a = ap.parse_args()
    seasons = extract_seasons(a.league_db, roster_ids())
    write("player_seasons_2023_2025.json", seasons)
    write("player_ages.json", extract_ages(a.yoy_db, roster_ids()))
    write("rookie_outcomes_2012_2023.json", extract_rookie_outcomes(a.league_db))
    write("franchise_history_2010_2025.json", extract_franchise_history(a.league_db))
    write("player_registry.json", extract_registry(a.league_db, a.assets_commit, a.adp_commit))


if __name__ == "__main__":
    main()
