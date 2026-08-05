#!/usr/bin/env python3
"""Weekly INJURY REPORTS + DEPTH CHARTS from nflverse.

Fills the tables created by worker/migrations/0121. Closes audit blocker B6 and
supplies the "role competition and availability" family the spec asks for in §6.

WHY THESE ARE week_pregame, NOT week
------------------------------------
Both are PUBLISHED BEFORE the game they describe. An injury report for week W
carries Wednesday/Thursday/Friday practice participation plus the official
Friday game-status designation; a depth chart for week W is posted during that
week's prep. So `week = W` is legal for these, exactly as it is for a Vegas
line, and that is the whole reason they are useful.

VERIFIED, NOT ASSUMED (2024 injuries, n=6,215): median date_modified is 42.6
HOURS BEFORE THE PLAYER'S OWN KICKOFF, and only 8 rows (0.13%) postdate their
own kickoff.

⚠️ The obvious version of that check is wrong. Comparing date_modified against
the WEEK'S FIRST game makes 82% of rows look post-game — because most teams play
Sunday while the Thursday nighter anchors the week. Only the player's own team
kickoff is a valid comparison. date_modified is persisted so the claim stays
auditable rather than resting on this docstring.

WHAT REPORT STATUS MEANS
------------------------
report_status is NULL for the majority of rows: a player on the practice report
who is NOT given a game designation is expected to play. That NULL is
information, not missingness, and downstream code must not impute it away.

Usage:
  python3 pipelines/etl/scripts/fetch_injuries_depth.py --seasons 2016-2025
  python3 pipelines/etl/scripts/fetch_injuries_depth.py --seasons 2025 --dry-run
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

CHUNK = 600

INJ_COLS = ["season", "week", "gsis_id", "team", "position", "report_status",
            "practice_status", "report_injury", "practice_injury", "date_modified"]
DEPTH_COLS = ["season", "week", "gsis_id", "team", "depth_position",
              "depth_rank", "formation"]


class SourceColumnMissing(RuntimeError):
    """Expected upstream column absent — refuse to write that season."""


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


def _s(v):
    """Normalise to a clean string or None.

    nflverse ships literal '\\n' whitespace blobs in some status fields; those
    are missing values wearing a costume, and letting one through would create a
    bogus category the model would happily learn.
    """
    if v is None:
        return None
    t = str(v).strip()
    return None if t in ("", "nan", "NA", "None", "\\n") else t


def _i(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else int(f)


def fetch_injuries(year: int):
    import nflreadpy as nfl
    d = nfl.load_injuries(seasons=[year])
    d = d.to_pandas() if hasattr(d, "to_pandas") else d
    d.columns = [c.lower() for c in d.columns]
    need = ["gsis_id", "season", "week", "report_status", "practice_status"]
    missing = [c for c in need if c not in d.columns]
    if missing:
        raise SourceColumnMissing(f"[{year}] injuries missing {missing}")
    rows, seen = [], set()
    for r in d.to_dict(orient="records"):
        g, wk = _s(r.get("gsis_id")), _i(r.get("week"))
        if not g or wk is None:
            continue
        k = (year, wk, g)
        if k in seen:            # one row per player-week; report supersedes practice
            continue
        seen.add(k)
        rows.append((year, wk, g, _s(r.get("team")), _s(r.get("position")),
                     _s(r.get("report_status")), _s(r.get("practice_status")),
                     _s(r.get("report_primary_injury")),
                     _s(r.get("practice_primary_injury")),
                     _s(r.get("date_modified"))))
    return rows


def _week_kickoffs(year: int):
    """First kickoff of each NFL week, used to place a dated snapshot in time."""
    import nflreadpy as nfl
    import pandas as pd
    s = nfl.load_schedules(seasons=[year])
    s = s.to_pandas() if hasattr(s, "to_pandas") else s
    s.columns = [c.lower() for c in s.columns]
    s["kt"] = pd.to_datetime(
        s["gameday"].astype(str) + " " + s["gametime"].fillna("13:00").astype(str),
        errors="coerce", utc=True)
    return s.groupby("week")["kt"].min().dropna().to_dict()


def fetch_depth(year: int):
    """Depth charts, normalising TWO INCOMPATIBLE nflverse schemas.

    nflverse REPLACED this feed in 2025:

      <=2024  weekly table, 37k rows/season
              season | week | depth_team (1/2/3) | depth_position | formation
      >=2025  TIMESTAMPED SNAPSHOT feed, 554k rows/season, no season or week
              dt | pos_rank | pos_abb (LWR/RWR/SWR/…) | pos_grp (3WR 1TE) | team

    Detected explicitly rather than via a fallback alias chain. An alias chain is
    what produced the def_tackles_ast disaster — it silently bound a tackle count
    to the assist column because both names were present. Two genuinely different
    schemas deserve two code paths and a loud failure if neither matches.

    The 2025 shape is BETTER for as-of purposes: a real publish timestamp means
    each snapshot can be placed before a specific kickoff, instead of trusting
    that a row labelled "week 6" was actually known in week 6. For each week we
    take the LATEST snapshot published strictly BEFORE that week's first kickoff.
    """
    import nflreadpy as nfl
    import pandas as pd
    d = nfl.load_depth_charts(seasons=[year])
    d = d.to_pandas() if hasattr(d, "to_pandas") else d
    d.columns = [c.lower() for c in d.columns]

    legacy = {"season", "week", "depth_team"} <= set(d.columns)
    modern = {"dt", "pos_rank", "pos_abb"} <= set(d.columns)
    if not (legacy or modern):
        raise SourceColumnMissing(
            f"[{year}] depth charts match NEITHER known schema. "
            f"cols={sorted(d.columns.tolist())[:14]}")

    rows, seen = [], set()
    if legacy:
        for r in d.to_dict(orient="records"):
            g, wk = _s(r.get("gsis_id")), _i(r.get("week"))
            dp = _s(r.get("depth_position"))
            if not g or wk is None or not dp:
                continue
            k = (year, wk, g, dp)
            if k in seen:
                continue
            seen.add(k)
            rows.append((year, wk, g, _s(r.get("club_code")) or _s(r.get("team")),
                         dp, _i(r.get("depth_team")), _s(r.get("formation"))))
        return rows

    # ── modern snapshot feed ───────────────────────────────────────────────
    d["dt"] = pd.to_datetime(d["dt"], errors="coerce", utc=True)
    d = d[d["dt"].notna()]
    kicks = _week_kickoffs(year)
    if not kicks:
        raise SourceColumnMissing(f"[{year}] no schedule — cannot date snapshots")

    for wk in sorted(kicks):
        cutoff = kicks[wk]
        # Strictly before kickoff: a snapshot taken after the game has started
        # is not information we had when predicting it.
        before = d[d["dt"] < cutoff]
        if before.empty:
            continue
        latest = before["dt"].max()
        snap = before[before["dt"] == latest]
        for r in snap.to_dict(orient="records"):
            g, dp = _s(r.get("gsis_id")), _s(r.get("pos_abb"))
            if not g or not dp:
                continue
            k = (year, wk, g, dp)
            if k in seen:
                continue
            seen.add(k)
            rows.append((year, wk, g, _s(r.get("team")), dp,
                         _i(r.get("pos_rank")), _s(r.get("pos_grp"))))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2016-2025")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-injuries", action="store_true")
    ap.add_argument("--skip-depth", action="store_true")
    args = ap.parse_args()

    failed: list[str] = []
    for yr in parse_seasons(args.seasons):
        inj = dep = []
        try:
            if not args.skip_injuries:
                inj = fetch_injuries(yr)
            if not args.skip_depth:
                dep = fetch_depth(yr)
        except SourceColumnMissing as e:
            failed.append(str(e))
            print(f"[{yr}] SKIPPED — {e}", file=sys.stderr, flush=True)
            continue
        except Exception as e:                      # noqa: BLE001
            failed.append(f"[{yr}] {e}")
            print(f"[{yr}] FAILED — {e}", file=sys.stderr, flush=True)
            continue

        n_out = sum(1 for r in inj if r[5] == "Out")
        n_q = sum(1 for r in inj if r[5] == "Questionable")
        n_dc1 = sum(1 for r in dep if r[5] == 1)
        print(f"[{yr}] injuries={len(inj):>5} (Out {n_out}, Q {n_q}) | "
              f"depth={len(dep):>6} (DC1 {n_dc1})", file=sys.stderr, flush=True)
        if args.dry_run:
            continue
        if inj:
            with D1Writer(table="nfl_player_injuries_weekly", cols=INJ_COLS,
                          pk_cols=["season", "week", "gsis_id"],
                          chunk_size=CHUNK) as w:
                for r in inj:
                    w.add(r)
        if dep:
            with D1Writer(table="nfl_player_depth_weekly", cols=DEPTH_COLS,
                          pk_cols=["season", "week", "gsis_id", "depth_position"],
                          chunk_size=CHUNK) as w:
                for r in dep:
                    w.add(r)
        print(f"[{yr}] written", file=sys.stderr, flush=True)

    if failed:
        print(f"\n{len(failed)} SEASON(S) WROTE NOTHING:", file=sys.stderr)
        for f in failed:
            print("  " + f, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
