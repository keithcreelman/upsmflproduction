#!/usr/bin/env python3
"""Build the trade grader's canonical valuation snapshot (Keith 2026-10-20, #1343 decision 3).

One repo-owned file, data/valuation/trade_valuation_snapshot.json, holds every
grade-affecting valuation the grader reads. Each value is compiled here, from
committed inputs only, so the runtime has no model to fit and nothing to fall
back to:

  players          projected PPG for every rostered player
                   (projection.py's designed rule: last three seasons
                   weighted 50/30/20 x share of a 17-game season, 4+ games,
                   times a position age curve), with its basis
  pick_curve       expected 3-season rookie points by draft slot, fitted
                   A * exp(-B * overall pick) over drafts 2012-2023
  dollars_per_point  median 2026 salary / 2025 points (salary >= $3K,
                   points >= 100, games >= 8); the grader's existing rule
  career           each franchise's current owner's playoff record over the
                   seasons canon §D.2 credits to that owner, checked against
                   the known ownership transitions
  season_state     weeks completed in the snapshot's standings (freshness)
  coverage         who has a PPG basis, who has none, who is zero

Inputs: data/mfl-snapshots/<as-of>/rosters.json and leagueStandings.json, the
committed extracts in pipelines/etl/inputs/valuation/ (extract_valuation_inputs.py),
and the in-season coefficients. Their sha256s go into the snapshot. Identical
inputs and arguments give a byte-identical file.

  python3 pipelines/etl/scripts/build_valuation_snapshot.py --as-of 2026-10-20 \
      --generated-at 2026-10-20T16:00:00Z
"""
import argparse
import hashlib
import json
import math
import statistics
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))

from valuation_snapshot import (  # noqa: E402  one definition for writer and reader
    SCHEMA_VERSION, MODEL_VERSION, SNAPSHOT_PATH as OUT, canonical_body,
    IN_SEASON_MAX_AGE_DAYS, OFFSEASON_MAX_AGE_DAYS,
)
INPUT_DIR = REPO / "pipelines" / "etl" / "inputs" / "valuation"
COEFFICIENTS = REPO / "pipelines" / "etl" / "config" / "future_pick_inseason_coefficients.json"
GENERATOR = Path(__file__).resolve()

# ── projected PPG: projection.py's designed rule, compiled here ────────────
RECENCY_WEIGHTS = (0.50, 0.30, 0.20)
GAMES_FULL_SEASON = 17
MIN_GAMES_RELIABLE = 4
AGE_CURVES = {          # position: (peak_lo, peak_hi, decline per year past peak, cliff age, floor)
    "QB": (26, 35, 0.020, 40, 0.65),
    "RB": (24, 27, 0.070, 32, 0.50),
    "WR": (25, 29, 0.050, 34, 0.60),
    "TE": (26, 30, 0.050, 35, 0.60),
}
IDP_POSITIONS = {"DT", "DE", "DL", "EDGE", "NT", "LB", "ILB", "OLB", "MLB",
                 "CB", "S", "SS", "FS", "DB", "IDP"}
ROOKIE_RANK_MIN_GAMES = 6
# dollars per point (trade_grader's rule, unchanged)
DPP_MIN_SALARY, DPP_MIN_POINTS, DPP_MIN_GAMES = 3000, 100, 8
# Freshness the runtime enforces (valuation_snapshot.py is authoritative).
FRESHNESS = {
    "in_season_max_age_days": IN_SEASON_MAX_AGE_DAYS,
    "offseason_max_age_days": OFFSEASON_MAX_AGE_DAYS,
    "in_season_must_cover_latest_completed_week": True,
}


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    return str(path.resolve().relative_to(REPO))


def age_multiplier(position: str, age: int | None) -> float:
    curve = AGE_CURVES.get(position)
    if not curve or age is None:
        return 1.0
    peak_lo, peak_hi, decline, cliff, floor = curve
    if age < peak_lo:
        return min(1.10, 1.0 + 0.03 * (peak_lo - age))
    if age <= peak_hi:
        return 1.0
    if age >= cliff:
        return floor
    return max(floor, 1.0 - decline * (age - peak_hi))


def project_player(pid, reg, seasons, ages, season, rookie_rank_table):
    """{ppg, basis, basis_text, age, age_mult} for one rostered player."""
    pos = reg["pos"]
    priors = []
    for i in range(1, 4):
        row = seasons.get(str(season - i), {}).get(pid)
        if row and row[1] > 0:
            priors.append((season - i, row[0], row[1]))
    age_row = ages.get(pid)
    age = age_row[1] + (season - age_row[0]) if age_row else None
    out = {"name": reg["name"], "pos": pos}
    qualifying = [r for r in priors if r[2] >= MIN_GAMES_RELIABLE]
    # Weights follow recency slots: the most recent season always gets 0.50.
    slots = {s: i for i, s in enumerate(range(season - 1, season - 4, -1))}

    def blend(rows):
        num = den = 0.0
        parts = []
        for s, pts, g in rows:
            w = RECENCY_WEIGHTS[slots[s]] * min(g / GAMES_FULL_SEASON, 1.0)
            num += w * (pts / g)
            den += w
            parts.append(f"{s} {pts / g:.1f} ({g}g)")
        return num / den, parts

    if qualifying or priors:
        base, parts = blend(qualifying or priors)
        basis = "weighted_prior" if qualifying else "thin_prior"
        if pos in AGE_CURVES and age is None:
            out.update({"ppg": None, "basis": "no_age",
                        "basis_text": f"{basis}; age unknown, so the age curve cannot be applied"})
            return out
        mult = age_multiplier(pos, age)
        out.update({"ppg": round(base * mult, 3), "basis": basis,
                    "basis_text": (("weighted " if qualifying else "thin data (under 4 games): ")
                                   + ", ".join(parts)
                                   + (f"; age {age} x{mult:.2f}" if pos in AGE_CURVES else "")),
                    "age": age, "age_mult": round(mult, 4)})
        return out
    rank = reg.get("rookie_pos_rank")
    table = rookie_rank_table.get(pos) or []
    if rank and 0 < rank <= len(table):
        ppg = table[rank - 1]
        out.update({"ppg": round(ppg, 3), "basis": "adp_implied",
                    "basis_text": (f"no NFL games: FantasyCalc ranks him {pos}{rank}; "
                                   f"{season - 1}'s {pos}{rank} scored {ppg:.1f} PPG"),
                    "age": age})
        return out
    out.update({"ppg": None, "basis": "none",
                "basis_text": "no 2023-2025 UPS games and no rookie ADP rank"})
    return out


def rookie_rank_table(seasons, season):
    """Prior season's PPG by position, best first, 6+ games (adp_implied_ppg's rule)."""
    by_pos = {}
    for pid, (pts, g, pos) in seasons.get(str(season - 1), {}).items():
        if g >= ROOKIE_RANK_MIN_GAMES and pos:
            by_pos.setdefault(pos, []).append(pts / g)
    return {pos: sorted(v, reverse=True) for pos, v in by_pos.items()}


def fit_pick_curve(outcomes):
    """Mean 3-season points by slot (rounds 1-3), fitted pts = A * exp(-B * overall)."""
    by_slot = {}
    for _season, rnd, slot, _pid, y in outcomes["picks"]:
        by_slot.setdefault((rnd, slot), []).append(sum(y))
    means = {f"{r}.{s:02d}": round(statistics.mean(v), 3) for (r, s), v in sorted(by_slot.items())}
    pairs = [((r - 1) * 12 + s, statistics.mean(v)) for (r, s), v in by_slot.items() if statistics.mean(v) > 0]
    xs = [x for x, _ in pairs]
    ly = [math.log(y) for _, y in pairs]
    mx, ml = statistics.mean(xs), statistics.mean(ly)
    slope = sum((x - mx) * (l - ml) for x, l in zip(xs, ly)) / sum((x - mx) ** 2 for x in xs)
    a, b = math.exp(ml - slope * mx), -slope
    return {"A": round(a, 6), "B": round(b, 6), "slot_means": means,
            "n_per_slot": min(len(v) for v in by_slot.values()),
            "drafts": outcomes["meta"]["drafts"],
            "rule": "mean of each pick's next three UPS regular seasons, by slot; log-linear fit"}


def dollars_per_point(rosters, seasons, season):
    prior = seasons.get(str(season - 1), {})
    ratios = []
    for fr in rosters["rosters"]["franchise"]:
        ps = fr.get("player") or []
        for p in (ps if isinstance(ps, list) else [ps]):
            try:
                salary = float(p.get("salary") or 0)
            except ValueError:
                continue
            row = prior.get(str(p["id"]))
            if row and salary >= DPP_MIN_SALARY and row[0] >= DPP_MIN_POINTS and row[1] >= DPP_MIN_GAMES:
                ratios.append(salary / row[0])
    return {"value": round(statistics.median(ratios), 4), "n": len(ratios),
            "rule": (f"median current salary / {season - 1} points, rostered players with salary >= "
                     f"${DPP_MIN_SALARY:,}, {DPP_MIN_POINTS}+ points, {DPP_MIN_GAMES}+ games")}


def career_blocks(history, season):
    """Owner block per franchise, from auction-of-record owners (canon §D.2)."""
    import pick_valuation as pv
    owners = {int(s): by for s, by in history["owners"].items()}
    finishes = {int(s): {f: int(v) for f, v in by.items()} for s, by in history["finishes"].items()}
    last = season - 1
    out = {}
    for fid in sorted(owners[last]):
        name = owners[last][fid]
        tenure = sorted((f, s) for s, by in owners.items() if s <= last for f, n in by.items() if n == name)
        by_franchise = {}
        for f, s in tenure:
            by_franchise.setdefault(f, []).append(s)
        unknown = [(f, s) for f, s in tenure if f not in finishes.get(s, {})]
        if unknown:
            raise SystemExit(f"franchise history has no final finish for {unknown}")
        made = sum(1 for f, s in tenure if finishes[s][f] <= 6)
        block = {
            "current_year": season,
            "trend": [{"season": s, "finish": finishes[s][fid]} for s in range(last - 3, last + 1)
                      if fid in finishes.get(s, {})],
            "owner": {"display": name, "seasons_count": len(tenure), "playoff_appearances": made,
                      "seasons_by_franchise": by_franchise},
        }
        saved = pv._CAREER_CACHE
        try:
            pv._CAREER_CACHE = {fid: block}
            issues = pv.ownership_history_issues(fid)
        finally:
            pv._CAREER_CACHE = saved
        block["d2_check"] = "pass" if not issues else "fail: " + "; ".join(issues)
        out[fid] = block
    return out


def weeks_completed(standings) -> int:
    rows = standings["leagueStandings"]["franchise"]
    games = [sum(int(x) for x in str(r["all_play_wlt"]).split("-")) for r in rows]
    return round(statistics.mean(games) / (len(rows) - 1)) if len(rows) > 1 else 0


def generator_identity(allow_dirty: bool) -> dict:
    path = rel(GENERATOR)
    commit = subprocess.check_output(["git", "-C", str(REPO), "log", "-1", "--format=%H", "--", path]).decode().strip()
    dirty = (not commit) or subprocess.call(["git", "-C", str(REPO), "diff", "--quiet", "HEAD", "--", path]) != 0
    if dirty and not allow_dirty:
        raise SystemExit(f"{path} has uncommitted changes: commit it first so the snapshot names its generator")
    return {"path": path, "sha256": sha256_file(GENERATOR), "commit": commit or "uncommitted", "dirty": dirty}


def render(snap: dict) -> bytes:
    """Deterministic, reviewable layout: top-level keys sorted; players and
    career one entry per line."""
    lines = ["{"]
    keys = sorted(snap)
    for i, k in enumerate(keys):
        end = "," if i < len(keys) - 1 else ""
        v = snap[k]
        if k in ("players", "career") and isinstance(v, dict):
            lines.append(f' "{k}": {{')
            items = sorted(v.items(), key=lambda kv: (len(kv[0]), kv[0]))
            for j, (pid, row) in enumerate(items):
                lines.append(f'  {json.dumps(pid)}: {json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))}'
                             + ("," if j < len(items) - 1 else ""))
            lines.append(" }" + end)
        else:
            lines.append(f' {json.dumps(k)}: {json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":"))}{end}')
    lines.append("}")
    return ("\n".join(lines) + "\n").encode()


def build(as_of: str, generated_at: str, allow_dirty: bool = False, snapshot_dir: Path | None = None) -> dict:
    snap_dir = snapshot_dir or (REPO / "data" / "mfl-snapshots" / as_of)
    files = {
        "rosters": snap_dir / "rosters.json",
        "standings": snap_dir / "leagueStandings.json",
        "snapshot_meta": snap_dir / "_snapshot_meta.json",
        "player_seasons": INPUT_DIR / "player_seasons_2023_2025.json",
        "player_ages": INPUT_DIR / "player_ages.json",
        "player_registry": INPUT_DIR / "player_registry.json",
        "rookie_outcomes": INPUT_DIR / "rookie_outcomes_2012_2023.json",
        "franchise_history": INPUT_DIR / "franchise_history_2010_2025.json",
        "inseason_coefficients": COEFFICIENTS,
    }
    data = {k: json.loads(p.read_text()) for k, p in files.items()}
    season = int(data["snapshot_meta"]["season_year"])
    seasons = data["player_seasons"]["seasons"]
    ages = data["player_ages"]["ages"]
    registry = data["player_registry"]["players"]
    table = rookie_rank_table(seasons, season)

    players, missing_registry = {}, []
    for fr in data["rosters"]["rosters"]["franchise"]:
        ps = fr.get("player") or []
        for p in (ps if isinstance(ps, list) else [ps]):
            pid = str(p["id"])
            reg = registry.get(pid)
            if not reg:
                missing_registry.append(pid)
                continue
            players[pid] = project_player(pid, reg, seasons, ages, season, table)

    by_basis = {}
    for row in players.values():
        by_basis[row["basis"]] = by_basis.get(row["basis"], 0) + 1
    no_value = sorted((pid for pid, r in players.items()
                       if r["ppg"] is None and r["pos"] not in IDP_POSITIONS), key=int)
    zero = sorted((pid for pid, r in players.items() if r["ppg"] == 0), key=int)
    negative = sorted((pid for pid, r in players.items() if r["ppg"] is not None and r["ppg"] < 0), key=int)
    curve = fit_pick_curve(data["rookie_outcomes"])
    source_dates = {
        "rosters": as_of, "standings": as_of, "snapshot_meta": as_of,
        "player_seasons": data["player_seasons"]["meta"]["source_file_date"],
        "player_ages": data["player_ages"]["meta"]["source_file_date"],
        "player_registry": data["player_registry"]["meta"]["assets_commit_time"][:10],
        "rookie_outcomes": data["rookie_outcomes"]["meta"]["source_file_date"],
        "franchise_history": data["franchise_history"]["meta"]["source_file_date"],
        "inseason_coefficients": data["inseason_coefficients"]["fitted_on"],
    }
    snap = {
        "schema_version": SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "season": season,
        "as_of": as_of,
        "generated_at": generated_at,
        "generator": generator_identity(allow_dirty),
        "inputs": [{"name": k, "path": rel(p), "sha256": sha256_file(p), "source_date": source_dates[k]}
                   for k, p in sorted(files.items())],
        "freshness": FRESHNESS,
        "season_state": {"weeks_completed": weeks_completed(data["standings"]), "source": rel(files["standings"])},
        "dollars_per_point": dollars_per_point(data["rosters"], seasons, season),
        "pick_curve": curve,
        "players": players,
        "career": career_blocks(data["franchise_history"], season),
        "counts": {"players": len(players), "picks": len(curve["slot_means"]),
                   "franchises": len(data["rosters"]["rosters"]["franchise"])},
        "coverage": {
            "rostered": len(players) + len(missing_registry),
            "by_basis": dict(sorted(by_basis.items())),
            "missing_from_registry": sorted(missing_registry, key=int),
            "no_ppg_basis": [{"id": pid, "name": players[pid]["name"], "pos": players[pid]["pos"],
                              "basis": players[pid]["basis"]} for pid in no_value],
            "zero_ppg": [{"id": pid, "name": players[pid]["name"], "pos": players[pid]["pos"]} for pid in zero],
            "negative_ppg": [{"id": pid, "name": players[pid]["name"], "pos": players[pid]["pos"],
                              "ppg": players[pid]["ppg"]} for pid in negative],
            "idp_players": sum(1 for r in players.values() if r["pos"] in IDP_POSITIONS),
            "note": "IDP players are scored zero by rule (trade_grader IDP neutral); they need only a position.",
        },
    }
    snap["content_sha256"] = sha256_bytes(canonical_body(snap))
    return snap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", required=True, help="date of the data/mfl-snapshots/<date> rosters and standings")
    ap.add_argument("--generated-at", required=True, help="UTC ISO time recorded as the generation time")
    ap.add_argument("--allow-dirty", action="store_true", help="development only: generator has local edits")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    snap = build(a.as_of, a.generated_at, a.allow_dirty)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_bytes(render(snap))
    cov = snap["coverage"]
    print(f"wrote {a.out} ({a.out.stat().st_size:,} bytes): {snap['counts']}, by basis {cov['by_basis']}, "
          f"no PPG basis {len(cov['no_ppg_basis'])}, zero {len(cov['zero_ppg'])}, "
          f"dpp {snap['dollars_per_point']['value']}, curve A={snap['pick_curve']['A']} B={snap['pick_curve']['B']}")


if __name__ == "__main__":
    main()
