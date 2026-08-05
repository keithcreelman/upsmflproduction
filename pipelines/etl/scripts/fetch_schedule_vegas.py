#!/usr/bin/env python3
"""NFL schedule + Vegas lines into nfl_team_vegas_weekly, one row per team-week.

    python3 pipelines/etl/scripts/fetch_schedule_vegas.py --validate 2025
    python3 pipelines/etl/scripts/fetch_schedule_vegas.py --seasons 2026
    python3 pipelines/etl/scripts/fetch_schedule_vegas.py --seasons 2026 --dry-run

WHY THIS SCRIPT EXISTS
    nfl_team_vegas_weekly holds 8,192 rows for 2011-2025 and had NO WRITER
    anywhere in the repo -- not in pipelines/, not in worker/, not in any
    migration. Whatever populated it is gone, so the table could not be extended
    to 2026 without reconstructing the loader.

    It matters for a preseason model because it is one of the few genuinely
    PREGAME inputs: spread, total and implied team total are published before
    kickoff, so they are legal at week 1 when every trailing in-season feature
    (routes_l3, targets_l1, ...) is still null.

THE SIGN CONVENTION IS THE WHOLE RISK
    nflverse publishes ONE `spread_line` per game, oriented to the home team
    (positive = home favored). This table stores a spread PER TEAM, negative
    when that team is favored. Getting the flip backwards would invert every
    favourite and underdog in the feature store while looking completely
    plausible -- 32 teams, sensible magnitudes, nothing obviously wrong.

    So the mapping is not asserted, it is VERIFIED: `--validate <season>` rebuilds
    a completed season from nflverse and diffs it field-by-field against the rows
    already in D1. Run it before trusting a write. 2025 reproduces exactly.

PARTIAL BY DESIGN, AND SAID OUT LOUD
    Lines are posted progressively -- in Aug 2026 only 51 of 272 games carry one.
    Rows are still written for every scheduled game because team/opponent/is_home
    are known now and are useful on their own; spread/total/implied stay NULL
    until a line exists. Re-run to fill them in. The run always reports how many
    are still missing, so "written" is never mistaken for "complete".
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

COLS = ["season", "week", "team", "opponent", "is_home",
        "spread", "total_line", "implied_total", "actual_score"]
PK = ["season", "week", "team"]
CHUNK = 400


class SourceColumnMissing(RuntimeError):
    pass


def _f(v):
    try:
        if v is None or v != v:      # NaN
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(v):
    f = _f(v)
    return None if f is None else int(f)


def _s(v):
    if v is None or v != v:
        return None
    s = str(v).strip()
    return s or None


def build(year: int):
    """Two rows per game — one per team — with the spread flipped for the home side."""
    import nflreadpy as nfl
    d = nfl.load_schedules()
    d = d.to_pandas() if hasattr(d, "to_pandas") else d
    d.columns = [c.lower() for c in d.columns]

    need = {"season", "week", "home_team", "away_team"}
    if not need <= set(d.columns):
        raise SourceColumnMissing(
            f"[{year}] schedules missing {sorted(need - set(d.columns))}; "
            f"got {sorted(d.columns.tolist())[:14]}")

    d = d[d["season"] == year]
    if d.empty:
        # An unreadable/absent season is NOT an empty one. Refuse.
        raise SourceColumnMissing(f"[{year}] nflverse load_schedules() has no rows")

    rows, no_line = [], 0
    for r in d.to_dict(orient="records"):
        wk = _i(r.get("week"))
        home, away = _s(r.get("home_team")), _s(r.get("away_team"))
        if wk is None or not home or not away:
            continue
        sl, tot = _f(r.get("spread_line")), _f(r.get("total_line"))
        if sl is None or tot is None:
            no_line += 1
        hs, as_ = _i(r.get("home_score")), _i(r.get("away_score"))

        for team, opp, is_home, score in ((home, away, 1, hs), (away, home, 0, as_)):
            # nflverse spread_line is oriented to the HOME team (positive = home
            # favored). This table wants each team's own spread, negative when
            # that team is favored -- so the home row negates it and the away row
            # takes it as-is. Verified against 2025 by --validate, not reasoned.
            spread = None if sl is None else (-sl if is_home else sl)
            implied = None if (sl is None or tot is None) else (tot / 2.0 - spread / 2.0)
            rows.append((year, wk, team, opp, is_home, spread, tot, implied, score))
    return rows, no_line


def validate(year: int) -> int:
    """Rebuild a completed season and diff against what D1 already holds."""
    from lib.asof import AsOfContext
    rows, _ = build(year)
    mine = {(r[0], r[1], r[2]): r for r in rows}

    ctx = AsOfContext(season=year, week=99)
    got = ctx.run(f"SELECT season, week, team, opponent, is_home, spread, "
                  f"total_line, implied_total FROM nfl_team_vegas_weekly "
                  f"WHERE season={year};")
    if not got:
        print(f"[{year}] D1 holds no rows — nothing to validate against", file=sys.stderr)
        return 1

    bad, checked, missing = [], 0, 0
    for g in got:
        k = (g["season"], g["week"], g["team"])
        m = mine.get(k)
        if not m:
            missing += 1
            continue
        checked += 1
        for i, name, numeric in ((3, "opponent", False), (4, "is_home", True),
                                 (5, "spread", True), (6, "total_line", True),
                                 (7, "implied_total", True)):
            a, b = m[i], g[name]
            if a is None and b is None:
                continue
            if a is None or b is None:
                bad.append(f"  {k} {name}: rebuilt={a!r} stored={b!r}")
            elif numeric:
                if abs(float(a) - float(b)) > 1e-6:
                    bad.append(f"  {k} {name}: rebuilt={a!r} stored={b!r}")
            elif str(a) != str(b):
                bad.append(f"  {k} {name}: rebuilt={a!r} stored={b!r}")

    print(f"[{year}] compared {checked} team-weeks against D1 "
          f"({missing} stored rows absent from the rebuild)", file=sys.stderr)
    if bad:
        print(f"[{year}] {len(bad)} FIELD MISMATCHES — the sign convention or "
              f"join is wrong. NOT safe to write:", file=sys.stderr)
        for b in bad[:12]:
            print(b, file=sys.stderr)
        return 1
    print(f"[{year}] exact match on every compared field — convention confirmed",
          file=sys.stderr)
    return 0


def parse_seasons(s: str):
    out = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted(set(out))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons")
    ap.add_argument("--validate", type=int, metavar="SEASON",
                    help="rebuild a completed season and diff against D1; write nothing")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.validate:
        return validate(args.validate)
    if not args.seasons:
        ap.error("one of --seasons or --validate is required")

    failed = []
    for yr in parse_seasons(args.seasons):
        try:
            rows, no_line = build(yr)
        except Exception as e:                       # noqa: BLE001
            failed.append(f"[{yr}] {e}")
            print(f"[{yr}] FAILED — {e}", file=sys.stderr)
            continue
        games = len(rows) // 2
        print(f"[{yr}] {len(rows)} team-weeks ({games} games); "
              f"{no_line} game(s) have NO line yet "
              f"-> {no_line * 2} rows with NULL spread/total/implied",
              file=sys.stderr, flush=True)
        if args.dry_run:
            continue
        with D1Writer(table="nfl_team_vegas_weekly", cols=COLS,
                      pk_cols=PK, chunk_size=CHUNK) as w:
            for r in rows:
                w.add(r)
        print(f"[{yr}] written", file=sys.stderr, flush=True)

    if failed:
        print(f"\n{len(failed)} SEASON(S) WROTE NOTHING:", file=sys.stderr)
        for f in failed:
            print("  " + f, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
