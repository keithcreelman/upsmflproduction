#!/usr/bin/env python3
"""Targeted backfill of the corrected tackle columns + first downs.

WHY THIS SCRIPT EXISTS
----------------------
fetch_nflverse_weekly.py is the owner of these columns and now produces them
correctly, but a full re-run writes ~55 columns x 19k rows x 15 seasons, which
takes hours and chews through D1's daily write quota. This pulls ONLY the
columns that actually changed — the same tradeoff backfill_pass_sacks.py makes.

WHAT CHANGED (Claude 2026-08-04) — see docs/MODEL_RESEARCH_AND_DATA_AUDIT.md
---------------------------------------------------------------------------
The NFL gamebook records three DISJOINT tackle credits and nflverse parses each
into its own column:

  "(A)"               -> A    = def_tackles_solo         unassisted tackle
  "(A, B)"  comma     -> A    = def_tackles_with_assist  A MADE it, with help
                         B    = def_tackle_assists
  "(A; B)"  semicolon -> both = def_tackle_assists

For UPS scoring:
    MFL TK = def_tackles_solo + def_tackles_with_assist
    MFL AS = def_tackles_ast   (nflverse def_tackle_assists)
    official combined (== PFR `comb`) = all three summed

fetch_nflverse_weekly.py had def_tackles_ast bound to `def_tackles_with_assist`
(a TACKLE count) while the real assist column `def_tackle_assists` was absent
from the alias list entirely. 2025 stored 702 assists instead of 17,056. The two
errors CANCELLED in the derived total (solo+ast == solo+twa == correct TK),
which is why the table looked plausible for two years -- and why fixing the
alias ALONE is strictly WORSE than the bug (2025 IDP MAE 0.81 -> 1.63, league
IDP points +36.2%). All three columns must move together.

First downs (UPS `FD 1-999 = *0.2`, ALL positions, continuous since 2011) were
never mapped at all, so UPS scoring could not be reproduced for any offensive
player.

COVERAGE SEMANTICS -- read before querying nfl_player_weekly_ext
---------------------------------------------------------------
To keep the write volume sane, a row is written to nfl_player_weekly_ext only
when at least one payload value is NONZERO. For a season this script has
processed, an ABSENT ext row therefore means "this player recorded none of these
events", not "unknown" -- so LEFT JOIN ... COALESCE(x, 0) is correct.

That inference is ONLY valid for seasons actually backfilled. This script prints
a per-season coverage line and the seasons processed are recorded in
docs/MODEL_RESEARCH_AND_DATA_AUDIT.md. Do NOT COALESCE a season that was never
run -- that is exactly the fail-open pattern the repo bans. Check coverage
first:
    SELECT season, COUNT(*) FROM nfl_player_weekly_ext GROUP BY season;

Usage:
  python3 pipelines/etl/scripts/backfill_tackle_semantics.py --seasons 2011-2025
  python3 pipelines/etl/scripts/backfill_tackle_semantics.py --seasons 2025 --dry-run
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

CHUNK = 1000  # rows per wrangler invocation; see note at the D1Writer calls

MAIN_COLS = ["season", "week", "gsis_id", "def_tackles_ast", "def_tackles_total"]
EXT_COLS = ["season", "week", "gsis_id", "def_tackles_with_assist",
            "pass_first_downs", "rush_first_downs", "rec_first_downs",
            "kickoff_returns", "kickoff_return_yards",
            "punt_returns", "punt_return_yards", "punt_return_tds",
            "special_teams_tds"]

# nflverse source columns. Single-name lookups on purpose: the whole bug this
# script repairs was caused by a multi-alias fallback silently binding to a
# semantically different column. If a name disappears upstream we want a loud
# KeyError, not a quiet mis-bind. (Repo rule: no fail-open guards.)
SRC = {
    "solo": "def_tackles_solo",
    "twa":  "def_tackles_with_assist",
    "ast":  "def_tackle_assists",
    "pfd":  "passing_first_downs",
    "rfd":  "rushing_first_downs",
    "cfd":  "receiving_first_downs",
    # Return game — UPS KY *.025 / UY *.05 / KO / PR. See migration 0117.
    "kr":   "kickoff_returns",
    "kry":  "kickoff_return_yards",
    "pr":   "punt_returns",
    "pry":  "punt_return_yards",
    "prtd": "pt_return_tds",
    "sttd": "special_teams_tds",
}


class SourceColumnMissing(RuntimeError):
    """An expected nflverse column is absent — refuse to write that season."""


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


def _i(v):
    """nflverse gives NaN for 'not applicable'; normalise to None."""
    if v is None:
        return None
    try:
        f = float(v)
    except (ValueError, TypeError):
        return None
    if f != f:  # NaN
        return None
    return int(f)


def fetch_season(year: int):
    import nflreadpy as nfl
    df = nfl.load_player_stats(seasons=[year])
    df = df.to_pandas() if hasattr(df, "to_pandas") else df
    df.columns = [c.lower() for c in df.columns]

    missing = [c for c in SRC.values() if c not in df.columns]
    if missing:
        # Refuse rather than write partial/zero data for the missing stat.
        # Raised per-season and caught in main() so one bad year does not abort
        # the rest of the backfill — but that season writes NOTHING and the run
        # exits non-zero, so a silent partial backfill is impossible.
        raise SourceColumnMissing(
            f"[{year}] nflverse payload is missing {missing}. Refusing to write "
            f"— an absent source column must never be treated as zero."
        )

    main_rows, ext_rows = [], []
    for r in df.to_dict(orient="records"):
        gsis = r.get("player_id") or r.get("gsis_id")
        if not isinstance(gsis, str) or not gsis.strip():
            continue
        season, week = _i(r.get("season")), _i(r.get("week"))
        if season is None or week is None:
            continue

        solo = _i(r.get(SRC["solo"]))
        twa  = _i(r.get(SRC["twa"]))
        ast  = _i(r.get(SRC["ast"]))
        if solo is not None or twa is not None or ast is not None:
            total = (solo or 0) + (twa or 0) + (ast or 0)
            main_rows.append((season, week, gsis, ast, total))

        pfd, rfd, cfd = _i(r.get(SRC["pfd"])), _i(r.get(SRC["rfd"])), _i(r.get(SRC["cfd"]))
        kr, kry = _i(r.get(SRC["kr"])), _i(r.get(SRC["kry"]))
        pr, pry = _i(r.get(SRC["pr"])), _i(r.get(SRC["pry"]))
        prtd, sttd = _i(r.get(SRC["prtd"])), _i(r.get(SRC["sttd"]))
        # Write only rows that carry a nonzero payload — see COVERAGE SEMANTICS.
        if any(v for v in (twa, pfd, rfd, cfd, kr, kry, pr, pry, prtd, sttd)):
            ext_rows.append((season, week, gsis, twa, pfd, rfd, cfd,
                             kr, kry, pr, pry, prtd, sttd))

    return main_rows, ext_rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2011-2025")
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute and report totals, write nothing.")
    ap.add_argument("--ext-only", action="store_true",
                    help="Skip the nfl_player_weekly write and refresh only "
                         "nfl_player_weekly_ext. Use when adding new ext columns "
                         "to an already-corrected main table — saves ~270 D1 "
                         "round trips across a 15-season run.")
    args = ap.parse_args()

    grand_main = grand_ext = 0
    failed: list[str] = []
    for yr in parse_seasons(args.seasons):
        try:
            main_rows, ext_rows = fetch_season(yr)
        except SourceColumnMissing as e:
            failed.append(str(e))
            print(f"[{yr}] SKIPPED — {e}", file=sys.stderr, flush=True)
            continue
        s_ast = sum(r[3] or 0 for r in main_rows)
        s_twa = sum(r[3] or 0 for r in ext_rows)
        s_fd = sum((r[4] or 0) + (r[5] or 0) + (r[6] or 0) for r in ext_rows)
        s_ry = sum((r[8] or 0) + (r[10] or 0) for r in ext_rows)  # kick + punt return yds
        print(f"[{yr}] main={len(main_rows):>6} (assists {s_ast:>6}) | "
              f"ext={len(ext_rows):>6} (twa {s_twa:>5}, first downs {s_fd:>6}, "
              f"return yds {s_ry:>6})", file=sys.stderr, flush=True)
        if args.dry_run:
            continue

        # D1Writer shells out to `npx wrangler` once per chunk (~3.5s of process
        # startup each), so chunk size dominates wall clock. Its default of 80 is
        # tuned for the 55-column wide upsert in fetch_nflverse_weekly.py; these
        # writes are 5-7 narrow integer columns (~50 bytes/row), so 1,000 rows is
        # ~50KB — comfortably under D1's 100KB per-statement cap and ~12x fewer
        # round trips.
        if not args.ext_only:
            with D1Writer(table="nfl_player_weekly", cols=MAIN_COLS,
                          pk_cols=["season", "week", "gsis_id"],
                          chunk_size=CHUNK) as w:
                for r in main_rows:
                    w.add(r)
        with D1Writer(table="nfl_player_weekly_ext", cols=EXT_COLS,
                      pk_cols=["season", "week", "gsis_id"],
                      chunk_size=CHUNK) as w:
            for r in ext_rows:
                w.add(r)
        grand_main += len(main_rows)
        grand_ext += len(ext_rows)
        print(f"[{yr}] written", file=sys.stderr, flush=True)

    verb = "would write" if args.dry_run else "wrote"
    print(f"DONE: {verb} {grand_main} main rows, {grand_ext} ext rows",
          file=sys.stderr)
    if failed:
        print(f"\n{len(failed)} SEASON(S) WROTE NOTHING:", file=sys.stderr)
        for f in failed:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
