#!/usr/bin/env python3
"""Build model_player_week_features — the AS-OF feature store (Phase 1).

Every row keyed (season, week, gsis_id) contains ONLY facts knowable before
kickoff of that game. See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §4.3/§4.4 and
worker/migrations/0120.

LEAKAGE IS PREVENTED STRUCTURALLY, NOT BY REVIEW
------------------------------------------------
Every read goes through lib/asof.AsOfContext, which applies the as-of predicate
for you and REFUSES an undeclared table. This module never writes a bare WHERE
season/week clause against a source, on purpose: the failure mode being guarded
against is silent and plausible-looking, and five tables in this database carry
season grain while looking weekly at the API layer.

Verified empirically by test_asof_leakage.py, which rebuilds a week with and
without later weeks present and asserts byte-identical output.

IDENTITY
--------
Resolved through ff_player_ids, NOT player_id_crosswalk. The crosswalk covers
only 6.3% of 2014 and 80.6% of 2022 src_weekly rows and its missingness is
survivorship-biased (a player is in it because MFL still lists him), which would
bias exactly the breakout labels this system predicts. The
`COALESCE(gsis_id,'') LIKE '00-%'` guard is load-bearing: ff_player_ids stores
missing as the literal string "NA", which passes IS NOT NULL and != ''.

Usage:
  python3 pipelines/etl/scripts/build_player_week_features.py --season 2024 --weeks 5
  python3 pipelines/etl/scripts/build_player_week_features.py --season 2024 --weeks 2-18
  python3 pipelines/etl/scripts/build_player_week_features.py --season 2024 --weeks 5 --dry-run
"""
from __future__ import annotations
import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.asof import AsOfContext  # noqa: E402
from lib.d1_io import D1Writer  # noqa: E402

FEATURE_VERSION = "fs-0.1.0"
CHUNK = 500

COLS = [
    "season", "week", "gsis_id", "as_of_ts", "mfl_player_id", "player_name",
    "nfl_team", "opponent", "mfl_pos", "ups_lineup_group", "feature_version",
    "weeks_played_std", "weeks_since_last",
    "routes_l1", "routes_l3", "routes_l4", "routes_std",
    "route_pct_l3", "route_pct_l4", "route_pct_std",
    "targets_l1", "targets_l3", "targets_l4", "targets_std",
    "tgt_share_l3", "tgt_share_l4", "tgt_share_std",
    "off_snaps_l3", "off_snap_pct_l3", "off_snap_pct_l4",
    "carries_l3", "carries_l4", "touches_l4",
    "rz_tgt_l4", "rz_tgt_std", "ez_tgt_l4", "gl_rush_l4", "gl_rush_std",
    "tprr_l4", "tprr_std", "yprr_l4", "yprr_std", "fdprr_l4", "fdprr_std",
    "catch_rate_std", "ypt_std", "ypc_std",
    "ups_ppg_l3", "ups_ppg_l4", "ups_ppg_std", "ups_last",
    "d_route_pct_l3", "d_tgt_share_l3", "d_routes_l3", "d_snap_pct_l3",
    "team_dropbacks_l4", "team_targets_l4", "team_plays_l4",
    "vegas_spread", "vegas_total", "vegas_implied",
]


def rate(num, den):
    """Rate or None. NEVER 0 for a zero denominator — 'no routes run' is not
    'a TPRR of zero', and collapsing the two would feed the model a fabricated
    efficiency for every player who did not play."""
    if not den:
        return None
    return round(float(num or 0) / float(den), 5)


def parse_weeks(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def _win(lo: int, hi: int) -> str:
    """SQL fragment for a same-season week window [lo, hi]."""
    return f"week >= {lo} AND week <= {hi}"


def build_week(season: int, week: int) -> list[tuple]:
    ctx = AsOfContext(season=season, week=week)
    as_of = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    hi = week - 1                       # last completed week
    if hi < 1:
        print(f"  [{season} W{week}] no completed weeks yet — nothing to build",
              file=sys.stderr)
        return []
    l1, l3, l4 = max(1, hi), max(1, hi - 2), max(1, hi - 3)
    # The window BEFORE the L3 window, for the role-change deltas.
    p3_hi, p3_lo = max(1, hi - 3), max(1, hi - 5)

    S = f"season = {season}"

    # ── routes (as-of weekly table — never nfl_player_routes) ──────────────
    routes = {r["gsis_id"]: r for r in ctx.run(ctx.select(
        "nfl_player_routes_weekly",
        "gsis_id,"
        f" SUM(CASE WHEN {_win(l1, hi)} THEN routes ELSE 0 END) rt_l1,"
        f" SUM(CASE WHEN {_win(l3, hi)} THEN routes ELSE 0 END) rt_l3,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN routes ELSE 0 END) rt_l4,"
        " SUM(routes) rt_std,"
        f" SUM(CASE WHEN {_win(l3, hi)} THEN team_dropbacks ELSE 0 END) tdb_l3,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN team_dropbacks ELSE 0 END) tdb_l4,"
        " SUM(team_dropbacks) tdb_std,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN routes_tgt ELSE 0 END) rtgt_l4,"
        " SUM(routes_tgt) rtgt_std,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN routes_rec_yds ELSE 0 END) ryd_l4,"
        " SUM(routes_rec_yds) ryd_std,"
        f" SUM(CASE WHEN {_win(p3_lo, p3_hi)} THEN routes ELSE 0 END) rt_p3,"
        f" SUM(CASE WHEN {_win(p3_lo, p3_hi)} THEN team_dropbacks ELSE 0 END) tdb_p3",
        where=S, group_by="gsis_id"))}

    # ── box score ──────────────────────────────────────────────────────────
    box = {r["gsis_id"]: r for r in ctx.run(ctx.select(
        "nfl_player_weekly",
        "gsis_id, MAX(team) team, MAX(position) pos, COUNT(*) wks,"
        " MAX(week) last_wk,"
        f" SUM(CASE WHEN {_win(l1, hi)} THEN targets ELSE 0 END) tg_l1,"
        f" SUM(CASE WHEN {_win(l3, hi)} THEN targets ELSE 0 END) tg_l3,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN targets ELSE 0 END) tg_l4,"
        " SUM(targets) tg_std, SUM(receptions) rec_std, SUM(rec_yds) recyd_std,"
        f" SUM(CASE WHEN {_win(l3, hi)} THEN rush_att ELSE 0 END) car_l3,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN rush_att ELSE 0 END) car_l4,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN COALESCE(rush_att,0)+COALESCE(receptions,0) ELSE 0 END) tch_l4,"
        " SUM(rush_att) car_std, SUM(rush_yds) rushyd_std,"
        f" SUM(CASE WHEN {_win(p3_lo, p3_hi)} THEN targets ELSE 0 END) tg_p3",
        where=S, group_by="gsis_id"))}

    # ── receiving first downs (for FDPRR) ──────────────────────────────────
    ext = {r["gsis_id"]: r for r in ctx.run(ctx.select(
        "nfl_player_weekly_ext",
        "gsis_id,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN rec_first_downs ELSE 0 END) fd_l4,"
        " SUM(rec_first_downs) fd_std",
        where=S, group_by="gsis_id"))}

    # ── snaps ──────────────────────────────────────────────────────────────
    # ⚠️ nfl_player_snaps is keyed by pfr_id, NOT gsis_id — despite migration
    # 0006's comment claiming otherwise. Join through ff_player_ids to reach
    # gsis. Both id guards matter: pfr_id and gsis_id are each stored as the
    # literal string "NA" when missing.
    snaps = {r["gsis"]: r for r in ctx.run(ctx.select(
        "nfl_player_snaps",
        "f.gsis_id gsis,"
        f" SUM(CASE WHEN {_win(l3, hi)} THEN s.off_snaps ELSE 0 END) sn_l3,"
        f" AVG(CASE WHEN {_win(l3, hi)} THEN s.off_snap_pct END) snp_l3,"
        f" AVG(CASE WHEN {_win(l4, hi)} THEN s.off_snap_pct END) snp_l4,"
        f" AVG(CASE WHEN {_win(p3_lo, p3_hi)} THEN s.off_snap_pct END) snp_p3",
        alias="s",
        join="JOIN ff_player_ids f ON f.pfr_id = s.pfr_id",
        join_tables=("ff_player_ids",),
        where=f"s.{S} AND COALESCE(f.gsis_id,'') LIKE '00-%'"
              " AND COALESCE(f.pfr_id,'') NOT IN ('','NA')",
        group_by="f.gsis_id"))}

    # ── red zone / goal line ───────────────────────────────────────────────
    rz = {r["gsis_id"]: r for r in ctx.run(ctx.select(
        "nfl_player_redzone",
        "gsis_id,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN targets_i20 ELSE 0 END) rz_l4,"
        " SUM(targets_i20) rz_std,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN targets_ez ELSE 0 END) ez_l4,"
        f" SUM(CASE WHEN {_win(l4, hi)} THEN rush_att_i5 ELSE 0 END) gl_l4,"
        " SUM(rush_att_i5) gl_std",
        where=S, group_by="gsis_id"))}

    # ── team aggregates for share denominators ─────────────────────────────
    team_l4 = {r["team"]: r for r in ctx.run(ctx.select(
        "nfl_player_weekly",
        "team, SUM(targets) tgt_l4, SUM(COALESCE(rush_att,0)+COALESCE(pass_att,0)) plays_l4",
        where=f"{S} AND {_win(l4, hi)} AND team IS NOT NULL", group_by="team"))}
    team_l3 = {r["team"]: r for r in ctx.run(ctx.select(
        "nfl_player_weekly", "team, SUM(targets) tgt_l3",
        where=f"{S} AND {_win(l3, hi)} AND team IS NOT NULL", group_by="team"))}
    team_std = {r["team"]: r for r in ctx.run(ctx.select(
        "nfl_player_weekly", "team, SUM(targets) tgt_std",
        where=f"{S} AND team IS NOT NULL", group_by="team"))}
    team_p3 = {r["team"]: r for r in ctx.run(ctx.select(
        "nfl_player_weekly", "team, SUM(targets) tgt_p3",
        where=f"{S} AND {_win(p3_lo, p3_hi)} AND team IS NOT NULL", group_by="team"))}

    # ── realized UPS points (lagged) + MFL identity/position ───────────────
    ups = {r["gsis"]: r for r in ctx.run(ctx.select(
        "src_weekly",
        "f.gsis_id gsis, MAX(w.player_id) mfl_id, MAX(f.name) nm,"
        " MAX(w.pos_group) mfl_pos, COUNT(*) n,"
        f" AVG(CASE WHEN {_win(l3, hi)} THEN w.score END) ppg_l3,"
        f" AVG(CASE WHEN {_win(l4, hi)} THEN w.score END) ppg_l4,"
        " AVG(w.score) ppg_std,"
        f" MAX(CASE WHEN week = {hi} THEN w.score END) last_score",
        alias="w",
        join="JOIN ff_player_ids f ON f.mfl_id = CAST(w.player_id AS TEXT)",
        join_tables=("ff_player_ids",),
        where=f"w.{S} AND COALESCE(f.gsis_id,'') LIKE '00-%'",
        group_by="f.gsis_id"))}

    # ── pregame Vegas for the TARGET week ──────────────────────────────────
    # Declared WEEK_PREGAME, so the guard permits week = W here (a Week 6 line
    # is published before Week 6 kickoff) while still banning actual_score.
    # This was originally hand-written raw SQL that bypassed the guard entirely;
    # test_asof_leakage.py check A caught it, which is precisely its job.
    vegas = {r["team"]: r for r in ctx.run(ctx.select(
        "nfl_team_vegas_weekly",
        "team, spread, total_line, implied_total, opponent",
        where=f"{S} AND week = {week}"))}

    universe = set(routes) | set(box)
    rows = []
    for g in sorted(universe):
        r = routes.get(g, {})
        b = box.get(g, {})
        e = ext.get(g, {})
        s = snaps.get(g, {})
        z = rz.get(g, {})
        u = ups.get(g, {})
        team = b.get("team")
        v = vegas.get(team, {})

        rt_l3, rt_l4, rt_std = r.get("rt_l3"), r.get("rt_l4"), r.get("rt_std")
        rpct_l3 = rate(rt_l3, r.get("tdb_l3"))
        rpct_p3 = rate(r.get("rt_p3"), r.get("tdb_p3"))
        ts_l3 = rate(b.get("tg_l3"), (team_l3.get(team) or {}).get("tgt_l3"))
        ts_p3 = rate(b.get("tg_p3"), (team_p3.get(team) or {}).get("tgt_p3"))

        rows.append((
            season, week, g, as_of,
            u.get("mfl_id"), u.get("nm"), team, v.get("opponent"),
            u.get("mfl_pos"), u.get("mfl_pos"), FEATURE_VERSION,
            b.get("wks"),
            (hi - b["last_wk"]) if b.get("last_wk") else None,
            r.get("rt_l1"), rt_l3, rt_l4, rt_std,
            rpct_l3, rate(rt_l4, r.get("tdb_l4")), rate(rt_std, r.get("tdb_std")),
            b.get("tg_l1"), b.get("tg_l3"), b.get("tg_l4"), b.get("tg_std"),
            ts_l3, rate(b.get("tg_l4"), (team_l4.get(team) or {}).get("tgt_l4")),
            rate(b.get("tg_std"), (team_std.get(team) or {}).get("tgt_std")),
            s.get("sn_l3"),
            round(s["snp_l3"], 5) if s.get("snp_l3") is not None else None,
            round(s["snp_l4"], 5) if s.get("snp_l4") is not None else None,
            b.get("car_l3"), b.get("car_l4"), b.get("tch_l4"),
            z.get("rz_l4"), z.get("rz_std"), z.get("ez_l4"),
            z.get("gl_l4"), z.get("gl_std"),
            rate(r.get("rtgt_l4"), rt_l4), rate(r.get("rtgt_std"), rt_std),
            rate(r.get("ryd_l4"), rt_l4), rate(r.get("ryd_std"), rt_std),
            rate(e.get("fd_l4"), rt_l4), rate(e.get("fd_std"), rt_std),
            rate(b.get("rec_std"), b.get("tg_std")),
            rate(b.get("recyd_std"), b.get("tg_std")),
            rate(b.get("rushyd_std"), b.get("car_std")),
            round(u["ppg_l3"], 4) if u.get("ppg_l3") is not None else None,
            round(u["ppg_l4"], 4) if u.get("ppg_l4") is not None else None,
            round(u["ppg_std"], 4) if u.get("ppg_std") is not None else None,
            u.get("last_score"),
            # Deltas are None unless BOTH windows exist — a missing prior window
            # is not a zero-change signal.
            None if rpct_l3 is None or rpct_p3 is None else round(rpct_l3 - rpct_p3, 5),
            None if ts_l3 is None or ts_p3 is None else round(ts_l3 - ts_p3, 5),
            None if rt_l3 is None or r.get("rt_p3") is None else float(rt_l3 - r["rt_p3"]),
            None if s.get("snp_l3") is None or s.get("snp_p3") is None
                 else round(s["snp_l3"] - s["snp_p3"], 5),
            r.get("tdb_l4"), (team_l4.get(team) or {}).get("tgt_l4"),
            (team_l4.get(team) or {}).get("plays_l4"),
            v.get("spread"), v.get("total_line"), v.get("implied_total"),
        ))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--weeks", default="2-18")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    total = 0
    for wk in parse_weeks(args.weeks):
        rows = build_week(args.season, wk)
        if not rows:
            continue
        nz = sum(1 for r in rows if r[COLS.index("routes_std")])
        print(f"[{args.season} W{wk}] {len(rows)} rows ({nz} with routes)",
              file=sys.stderr, flush=True)
        if args.dry_run:
            continue
        with D1Writer(table="model_player_week_features", cols=COLS,
                      pk_cols=["season", "week", "gsis_id"], chunk_size=CHUNK) as w:
            for r in rows:
                w.add(r)
        total += len(rows)
    print(f"DONE: {'would write' if args.dry_run else 'wrote'} {total} rows",
          file=sys.stderr)


if __name__ == "__main__":
    main()
