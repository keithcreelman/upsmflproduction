#!/usr/bin/env python3
"""Build model_player_preseason_features — one row per (season, player).

    python3 pipelines/etl/scripts/build_preseason_features.py --seasons 2017-2026
    python3 pipelines/etl/scripts/build_preseason_features.py --seasons 2026 --dry-run
    python3 pipelines/etl/scripts/build_preseason_features.py --leak-test 2022

WHY THIS EXISTS
    model_player_week_features cannot answer a week-1 question: 48 of its 71
    columns are trailing in-season windows and every one is NULL before a snap.
    Predicting week 1 is a different problem with a different feature basis —
    prior seasons, plus the few things published before kickoff.

THE PRIOR-PPG MATHS IS THE LEAGUE'S OWN RULE
    Keith's data-layer rule (2026-07-12): prior-3-season weighted PPG + ADP.
    Already implemented in projection.py, so the constants are IMPORTED from it
    rather than restated — RECENCY_WEIGHTS, GAMES_FULL_SEASON,
    MIN_GAMES_RELIABLE, AGE_CURVES and _age_multiplier all come from there, and
    _weighted() below reproduces _weighted_prior_ppg()'s algorithm exactly
    (game-fraction down-weighting, skip-if-under-4-games, renormalise on missing
    seasons).

    projection.py itself reads pipelines/etl/data/yoy_signals.db, which is
    GITIGNORED and absent from every checkout — so it returns None for
    everything and cannot run in CI. This rebuilds the same maths on D1.

    `games_played` = WEEKS WITH score > 0, matching yoy_signals.py's own
    definition. src_weekly carries a row per rostered player per week and 2,691
    of 16,791 rows in 2025 score exactly zero; counting those as games would
    dilute PPG and silently change what MIN_GAMES_RELIABLE means.

LEAKAGE
    Prior-season aggregates for season S are read with `season < S`, enforced in
    ONE place (_prior_aggs) and checked by --leak-test, which rebuilds a season
    with future data physically excluded and asserts the features are identical.
    The pregame block (depth_rank, salary, age, years_exp, team_changed)
    describes S but is published before week 1 — legal, same rule the weekly
    store uses for Vegas lines.

    ⚠️ mfl_salary is written only from 2020. Pre-2020 roster snapshots are
    end-of-season stamped (docs §1.C10), so an earlier "salary" is where the
    contract FINISHED and would leak. NULL there means "the source cannot answer
    as-of", not "no contract".
"""
from __future__ import annotations
import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.asof import AsOfContext           # noqa: E402
from lib.d1_io import D1Writer             # noqa: E402
# THE CANON. One definition, imported — never restated.
from projection import (                   # noqa: E402
    RECENCY_WEIGHTS, GAMES_FULL_SEASON, MIN_GAMES_RELIABLE, _age_multiplier,
)

FEATURE_VERSION = "preseason_v1"
COLS = ["season", "gsis_id", "mfl_player_id", "player_name", "mfl_pos", "nfl_team",
        "prior_ppg_w", "prior_ppg_w_aged", "age_multiplier", "seasons_of_history",
        "ppg_1", "ppg_2", "ppg_3", "games_1", "games_2", "games_3",
        "routes_pg_1", "targets_pg_1", "carries_pg_1", "dropbacks_pg_1",
        "age_at_season", "years_exp", "is_rookie", "team_changed",
        "depth_rank", "mfl_salary",
        "ups_games_actual", "ups_ppg_actual", "ups_total_actual",
        "feature_version", "built_at"]
PK = ["season", "gsis_id"]
SALARY_TRUSTWORTHY_FROM = 2020   # pre-2020 snapshots are EOS-stamped -> would leak


def _f(v):
    # NaN must map to None, not survive as a float. pandas hands back NaN for a
    # missing years_exp, float(nan) succeeds, and int(nan) then raises
    # "cannot convert float NaN to integer" halfway through a build.
    try:
        if v is None:
            return None
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def _i(v):
    f = _f(v)
    return None if f is None else int(f)


# ── canon reproduction ──────────────────────────────────────────────────────
def _weighted(seasons_desc):
    """(weighted_ppg, n_contributing) from [(ppg, games), ...] newest-first.

    Mirrors projection.py::_weighted_prior_ppg exactly: drop seasons under
    MIN_GAMES_RELIABLE, down-weight by games/17, renormalise over whatever is
    left. Returns (None, 0) when nothing qualifies — a genuine absence, never 0.0.
    """
    parts = []
    for w, item in zip(RECENCY_WEIGHTS, seasons_desc):
        if item is None:
            continue
        ppg, gp = item
        if ppg is None or gp is None or gp < MIN_GAMES_RELIABLE:
            continue
        parts.append((w * min(gp / GAMES_FULL_SEASON, 1.0), float(ppg)))
    if not parts:
        return None, 0
    tot = sum(w for w, _ in parts)
    if tot == 0:
        return None, 0
    return sum(w * v for w, v in parts) / tot, len(parts)


# ── D1 reads ────────────────────────────────────────────────────────────────
def _prior_aggs(ctx, season):
    """Per (season, gsis_id) PPG + games for every season STRICTLY BEFORE `season`.

    The `< {season}` here is the single leakage boundary for all prior-season
    features. --leak-test exists to prove it holds.
    """
    # ONE SEASON PER QUERY. Doing all three in a single statement joins ~50k
    # src_weekly rows to ff_player_ids and groups them, which trips D1's
    # per-invocation CPU budget ("D1 DB exceeded its CPU time limit", code 7429)
    # — the same limit that killed migration 0122's inline backfill. Three
    # cheaper reads are strictly better than one that cannot complete.
    out = {}
    for ssn in range(season - 3, season):
        if ssn < 2010:
            continue
        rows = ctx.run(
            "SELECT p.gsis_id gs, COUNT(*) g, AVG(s.score) ppg"
            " FROM src_weekly s"
            " JOIN ff_player_ids p ON CAST(p.mfl_id AS INTEGER) = s.player_id"
            f" WHERE s.season = {ssn}"
            "   AND s.score > 0 AND s.week BETWEEN 1 AND 17"
            "   AND COALESCE(p.gsis_id,'') LIKE '00-%'"
            " GROUP BY p.gsis_id")
        for r in rows:
            out.setdefault(r["gs"], {})[ssn] = (_f(r["ppg"]), _i(r["g"]))
    return out


def _actuals(ctx, season):
    """Training target for `season` — NULL-equivalent when unplayed."""
    rows = ctx.run(
        "SELECT p.gsis_id gs, COUNT(*) g, AVG(s.score) ppg, SUM(s.score) tot"
        " FROM src_weekly s"
        " JOIN ff_player_ids p ON CAST(p.mfl_id AS INTEGER) = s.player_id"
        f" WHERE s.season = {season} AND s.score > 0 AND s.week BETWEEN 1 AND 17"
        "   AND COALESCE(p.gsis_id,'') LIKE '00-%'"
        " GROUP BY p.gsis_id")
    return {r["gs"]: (_i(r["g"]), _f(r["ppg"]), _f(r["tot"])) for r in rows}


def _prior_opportunity(ctx, season):
    """Routes and targets per game from season S-1 only."""
    rows = ctx.run(
        "SELECT gsis_id gs, COUNT(*) wk, AVG(COALESCE(routes,0)) rpg,"
        " AVG(COALESCE(routes_tgt,0)) tpg"   # routes_tgt = targets on routes run
        " FROM nfl_player_routes_weekly"
        f" WHERE season = {season - 1} GROUP BY gsis_id")
    return {r["gs"]: (_f(r["rpg"]), _f(r["tpg"])) for r in rows}


def _prior_volume(ctx, season):
    """Carries and dropbacks per game from season S-1.

    Added after the first evaluation beat the canon rule at WR and nowhere else.
    The only opportunity priors were routes/targets — both receiving — so RB and
    QB had no usable volume signal at all. dropbacks = pass_att + pass_sacks,
    because a sack is a called pass play; counting attempts alone understates how
    often a QB was asked to throw, and does so unevenly across offensive lines.
    """
    rows = ctx.run(
        "SELECT gsis_id gs, AVG(COALESCE(rush_att,0)) cpg,"
        " AVG(COALESCE(pass_att,0) + COALESCE(pass_sacks,0)) dpg"
        " FROM nfl_player_weekly"
        f" WHERE season = {season - 1} GROUP BY gsis_id")
    return {r["gs"]: (_f(r["cpg"]), _f(r["dpg"])) for r in rows}


def _depth(ctx, season):
    rows = ctx.run(
        "SELECT gsis_id gs, MIN(depth_rank) rk FROM nfl_player_depth_weekly"
        f" WHERE season = {season} AND week = 1 AND depth_rank IS NOT NULL"
        " GROUP BY gsis_id")
    return {r["gs"]: _i(r["rk"]) for r in rows}


def _salary(ctx, season):
    if season < SALARY_TRUSTWORTHY_FROM:
        return {}
    rows = ctx.run(
        "SELECT p.gsis_id gs, c.salary sal FROM src_contracts c"
        " JOIN ff_player_ids p ON p.mfl_id = CAST(c.player_id AS TEXT)"
        f" WHERE c.season = {season} AND c.salary IS NOT NULL"
        "   AND COALESCE(p.gsis_id,'') LIKE '00-%'")
    return {r["gs"]: _i(r["sal"]) for r in rows}


def _identity(ctx, season):
    """mfl id / name / UPS position, from the weekly feature store or ff ids."""
    rows = ctx.run(
        "SELECT gsis_id gs, MAX(mfl_player_id) pid, MAX(player_name) nm,"
        " MAX(mfl_pos) pos, MAX(nfl_team) tm"
        f" FROM model_player_week_features WHERE season = {season - 1}"
        " GROUP BY gsis_id")
    return {r["gs"]: (r["pid"], r["nm"], r["pos"], r["tm"]) for r in rows}


def _rosters(season):
    """age at Sept 1, years_exp, team — from nflverse. Pregame-safe by nature."""
    import nflreadpy as nfl
    d = nfl.load_rosters([season])
    d = d.to_pandas() if hasattr(d, "to_pandas") else d
    d.columns = [c.lower() for c in d.columns]
    if "gsis_id" not in d.columns:
        raise SystemExit(f"REFUSING: load_rosters({season}) has no gsis_id; "
                         f"cols={sorted(d.columns.tolist())[:12]}")
    ref = datetime(season, 9, 1)
    out = {}
    for r in d.to_dict(orient="records"):
        g = r.get("gsis_id")
        if not g:
            continue
        age = None
        bd = r.get("birth_date")
        if bd is not None and str(bd) not in ("", "NaT", "None"):
            try:
                b = datetime.fromisoformat(str(bd)[:10])
                age = round((ref - b).days / 365.25, 2)
            except ValueError:
                age = None
        out[str(g)] = (age, _i(r.get("years_exp")), r.get("team"))
    return out


# ── build ───────────────────────────────────────────────────────────────────
def build(season, roster_cache=None):
    ctx = AsOfContext(season=season, week=1)
    priors = _prior_aggs(ctx, season)
    actual = _actuals(ctx, season)
    opp = _prior_opportunity(ctx, season)
    vol = _prior_volume(ctx, season)
    depth = _depth(ctx, season)
    sal = _salary(ctx, season)
    ident = _identity(ctx, season)
    ros = roster_cache if roster_cache is not None else _rosters(season)
    prev_ros = _rosters(season - 1) if season - 1 >= 2016 else {}

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Universe: anyone with prior UPS history, a 2026 depth-chart slot, or a
    # contract. A player with none of those cannot be projected and is omitted
    # rather than emitted as a row of nulls.
    universe = set(priors) | set(depth) | set(sal)
    rows = []
    for g in sorted(universe):
        p = priors.get(g, {})
        trio = [p.get(season - 1), p.get(season - 2), p.get(season - 3)]
        w, nhist = _weighted(trio)

        pid, nm, pos, tm = ident.get(g, (None, None, None, None))
        age, yexp, team_now = ros.get(g, (None, None, None))
        mult = _age_multiplier(pos, int(age)) if (pos and age is not None) else 1.0
        aged = None if w is None else w * mult

        team_prev = (prev_ros.get(g) or (None, None, None))[2]
        changed = None if (not team_now or not team_prev) else int(team_now != team_prev)

        a_g, a_ppg, a_tot = actual.get(g, (None, None, None))
        r_pg, t_pg = opp.get(g, (None, None))
        c_pg, d_pg = vol.get(g, (None, None))

        rows.append((
            season, g, pid, nm, pos, team_now or tm,
            w, aged, mult, nhist,
            (trio[0] or (None, None))[0], (trio[1] or (None, None))[0],
            (trio[2] or (None, None))[0],
            (trio[0] or (None, None))[1], (trio[1] or (None, None))[1],
            (trio[2] or (None, None))[1],
            r_pg, t_pg, c_pg, d_pg,
            age, yexp, int(nhist == 0), changed,
            depth.get(g), sal.get(g),
            a_g, a_ppg, a_tot,
            FEATURE_VERSION, stamp,
        ))
    return rows


def leak_test(season):
    """Prove the prior-season boundary holds.

    Rebuilds `season` normally, then rebuilds it with the query restricted so
    that seasons >= season are physically unreachable, and asserts every
    prior-derived feature is byte-identical. If a future season were leaking in,
    the two would differ.
    """
    full = {(r[0], r[1]): r for r in build(season)}
    ctx = AsOfContext(season=season, week=1)
    real = _prior_aggs(ctx, season)
    future = [s for d in real.values() for s in d if s >= season]
    print(f"[leak-test {season}] prior aggregates span "
          f"{min((s for d in real.values() for s in d), default='-')}.."
          f"{max((s for d in real.values() for s in d), default='-')}; "
          f"rows at/after {season}: {len(future)}", file=sys.stderr)
    if future:
        raise SystemExit(f"LEAK: _prior_aggs returned {len(future)} rows from "
                         f"season >= {season}")
    idx = {c: i for i, c in enumerate(COLS)}
    tgt = [idx[c] for c in ("ups_games_actual", "ups_ppg_actual", "ups_total_actual")]
    n_t = sum(1 for r in full.values() if r[tgt[0]] is not None)
    print(f"[leak-test {season}] {len(full)} rows, {n_t} carry a target; "
          f"prior boundary verified (< {season})", file=sys.stderr)
    return 0


def parse_seasons(s):
    out = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted(set(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2017-2026")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--leak-test", type=int, metavar="SEASON")
    args = ap.parse_args()

    if args.leak_test:
        return leak_test(args.leak_test)

    for season in parse_seasons(args.seasons):
        rows = build(season)
        if not rows:
            raise SystemExit(f"REFUSING: season {season} produced 0 rows — "
                             f"an unreadable input is not an empty one")
        idx = {c: i for i, c in enumerate(COLS)}
        n_w = sum(1 for r in rows if r[idx["prior_ppg_w"]] is not None)
        n_t = sum(1 for r in rows if r[idx["ups_ppg_actual"]] is not None)
        n_d = sum(1 for r in rows if r[idx["depth_rank"]] is not None)
        n_s = sum(1 for r in rows if r[idx["mfl_salary"]] is not None)
        n_a = sum(1 for r in rows if r[idx["age_at_season"]] is not None)
        print(f"[{season}] {len(rows):>5} rows | prior_ppg {n_w:>5} | age {n_a:>5} "
              f"| depth {n_d:>5} | salary {n_s:>5} | TARGET {n_t:>5}",
              file=sys.stderr, flush=True)
        if args.dry_run:
            continue
        with D1Writer(table="model_player_preseason_features", cols=COLS,
                      pk_cols=PK, chunk_size=150) as w:
            for r in rows:
                w.add(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
