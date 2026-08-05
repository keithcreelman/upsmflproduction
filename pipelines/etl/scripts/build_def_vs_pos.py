#!/usr/bin/env python3
"""OPPONENT-ADJUSTED DEFENSE-VS-POSITION — matchup difficulty, as-of.

Fills model_team_def_vs_pos_weekly (worker/migrations/0121). Spec §6, "team,
scheme and coaching context → opponent-adjusted position scoring".

WHY OPPONENT-ADJUSTED, NOT RAW POINTS ALLOWED
---------------------------------------------
Raw "UPS points allowed to WRs" rewards a defence for having faced weak
offences. A unit that drew three bad passing teams looks elite and is not. The
adjustment divides what each defence actually allowed by what those SPECIFIC
opponents averaged against everyone else:

    adj_ratio = (points this D allowed to pos) / (what those offences
                 usually produce at that pos)

    > 1.0  more generous than the schedule alone explains  → good matchup
    < 1.0  stingier than the schedule explains             → bad matchup

This mirrors the convention already used in the Worker's /api/lineup-matchups,
which Keith specified as strength-of-schedule adjusted. The difference here is
that this version is STORED and AS-OF: the Worker computes live from whatever
is in the table, which is fine for a lineup screen and unusable for backtesting.

⚠️ GRAIN IS `week`, NOT `week_pregame`
--------------------------------------
Injury reports and depth charts are published before the game and so may read
week = W. This table is built from REALIZED RESULTS, so week W's own outcome
must never be in the week-W row. That distinction is exactly the leakage
boundary, and getting it backwards would leak the very outcome being predicted.
Every row here is computed from weeks < W only.

SMALL-SAMPLE HANDLING
---------------------
Early weeks give a defence two or three games. Rather than publish a noisy
ratio, the ratio is shrunk toward 1.0 (neutral) by games played:

    shrunk = (raw * games + 1.0 * k) / (games + k)

so a Week 3 rating barely moves a projection while a Week 14 rating carries
weight. A defence with no games yet gets NULL — never 1.0, because "no
information" and "exactly average" are different claims.

Usage:
  python3 pipelines/etl/scripts/build_def_vs_pos.py --seasons 2021-2025
"""
from __future__ import annotations
import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.asof import AsOfContext  # noqa: E402
from lib.d1_io import D1Writer  # noqa: E402

COLS = ["season", "week", "team", "pos_group", "games", "pts_allowed_pg",
        "adj_ratio", "rank_of_32"]
POSITIONS = ("QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB")

# ⚠️ src_weekly.pos_group LABELS DRIFT BETWEEN SEASONS. 2023 and earlier write
# 'DT+DE' and 'CB+S' where 2024+ write 'DL' and 'DB'. A plain
# `pos_group IN ('DL','LB','DB')` therefore returns LB-ONLY rows for the older
# seasons — silently, with no error and a plausible-looking result set.
#
# This is Appendix C item C20 in the audit. It was documented and then walked
# into anyway on the first build of this table: 2016-2023 came out with only
# SEVEN position groups (LB/PK/PN/QB/RB/TE/WR) and no DL or DB matchup ratings
# at all, while 2024-2025 had all nine. Normalising here rather than trusting
# the caller to remember.
POS_NORM = {
    "DT+DE": "DL", "DT": "DL", "DE": "DL",
    "CB+S": "DB", "CB": "DB", "S": "DB",
}
SHRINK_K = 3.0          # games of neutral prior mixed into every rating
CHUNK = 800


def parse_seasons(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def build_week(season: int, week: int) -> list[tuple]:
    """Ratings for week W, from weeks < W only."""
    ctx = AsOfContext(season=season, week=week)

    # Realized UPS points by (week, scoring player's team, opponent, position).
    # nfl_player_weekly supplies team/opponent; src_weekly supplies UPS points
    # and the MFL position — the authoritative one for scoring.
    rows = ctx.run(ctx.select(
        "src_weekly",
        "w.week wk, n.team off_team, n.opponent def_team, w.pos_group pos,"
        " SUM(w.score) pts",
        alias="w",
        join="JOIN ff_player_ids f ON f.mfl_id = CAST(w.player_id AS TEXT)"
             " JOIN nfl_player_weekly n ON n.gsis_id = f.gsis_id"
             "  AND n.season = w.season AND n.week = w.week",
        join_tables=("ff_player_ids", "nfl_player_weekly"),
        where=f"w.season = {season} AND COALESCE(f.gsis_id,'') LIKE '00-%'"
              " AND n.opponent IS NOT NULL AND n.team IS NOT NULL"
              " AND w.pos_group IS NOT NULL",
        group_by="w.week, n.team, n.opponent, w.pos_group"))
    if not rows:
        return []

    # allowed[def][pos] -> list of (points, offence)
    allowed = defaultdict(lambda: defaultdict(list))
    # produced[off][pos] -> list of points, for the strength-of-schedule term
    produced = defaultdict(lambda: defaultdict(list))
    for r in rows:
        d, o, p, pts = r["def_team"], r["off_team"], r["pos"], float(r["pts"] or 0)
        p = POS_NORM.get(p, p)          # see C20 note above
        if p not in POSITIONS:
            continue
        allowed[d][p].append((pts, o))
        produced[o][p].append(pts)

    out = []
    for pos in POSITIONS:
        ratios = {}
        raw_pg = {}
        for d, byp in allowed.items():
            games = byp.get(pos) or []
            if not games:
                continue
            got = sum(g[0] for g in games)
            # What those specific offences produce against EVERYONE ELSE. The
            # defence's own games are excluded from the expectation, otherwise a
            # dominant defence would deflate its own benchmark and look average.
            exp = 0.0
            for pts, o in games:
                others = [x for x in produced[o][pos]]
                tot, n = sum(others), len(others)
                if n > 1:
                    exp += (tot - pts) / (n - 1)
                elif n == 1:
                    exp += pts
            raw_pg[d] = got / len(games)
            if exp > 0:
                raw = got / exp
                ratios[d] = (raw * len(games) + 1.0 * SHRINK_K) / (len(games) + SHRINK_K)
        if not ratios:
            continue
        # rank 1 = most generous = best matchup for the offensive player
        order = sorted(ratios, key=lambda d: -ratios[d])
        for i, d in enumerate(order):
            out.append((season, week, d, pos, len(allowed[d][pos]),
                        round(raw_pg.get(d, 0.0), 3), round(ratios[d], 4), i + 1))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2021-2025")
    ap.add_argument("--weeks", default="5-18")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    a, b = (args.weeks.split("-") + [args.weeks])[:2]
    weeks = range(int(a), int(b) + 1)

    total = 0
    for season in parse_seasons(args.seasons):
        rows = []
        for wk in weeks:
            r = build_week(season, wk)
            rows += r
            print(f"  [{season} W{wk}] {len(r)} ratings", file=sys.stderr, flush=True)
        if not rows:
            print(f"[{season}] no data", file=sys.stderr)
            continue
        print(f"[{season}] {len(rows)} rows", file=sys.stderr, flush=True)
        if args.dry_run:
            continue
        with D1Writer(table="model_team_def_vs_pos_weekly", cols=COLS,
                      pk_cols=["season", "week", "team", "pos_group"],
                      chunk_size=CHUNK) as w:
            for t in rows:
                w.add(t)
        total += len(rows)
        print(f"[{season}] written", file=sys.stderr, flush=True)
    print(f"DONE: {'would write' if args.dry_run else 'wrote'} {total} rows",
          file=sys.stderr)


if __name__ == "__main__":
    main()
