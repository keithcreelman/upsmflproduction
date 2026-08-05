#!/usr/bin/env python3
"""Per-player-week TD DISTANCE TIERS + return TDs + 2-pt conversions.

Fills the columns added by worker/migrations/0119. See
docs/MODEL_RESEARCH_AND_DATA_AUDIT.md Appendix C items C10 and C12.

WHY
---
UPS pays 7 points instead of 6 for a touchdown of 50+ yards, on every TD code
(PS/RS/RC/PR/KO/IR/FR/DR/MF). The weekly box-score feed carries only TD COUNTS,
so the bonus was invisible. Jordan Addison 2025 wk17: UPS awarded 13.7 on one
65-yard rush — 6.5 (yards) + 7.0 (50+ tier) + 0.2 (first down). Crediting that
TD at 6 loses a point every time.

nflverse also has NO kickoff_return_tds column at all — only `special_teams_tds`,
a mixed bucket that includes blocked-kick and muffed-punt recoveries UPS scores
under entirely different codes. PBP is the only source. Charlie Jones scored
12.1 UPS points in 2025 wk9 with zero offensive stats: a 98-yard kickoff return
TD, invisible to every non-PBP feed.

THE DISTANCE FIELD IS NOT UNIFORM — the one thing to get right here
------------------------------------------------------------------
  offensive TDs (pass/rush/rec) -> pbp.yards_gained
  RETURN TDs                    -> pbp.return_yards

`yards_gained` is 0 on kickoff-return plays, so an initial `yards_gained >= 50`
check reported ZERO 50+ return TDs — which is obviously wrong, since a kickoff
return TD is by construction ~100 yards. Verified against 2025 REG: all 6
kickoff return TDs are 50+ (90/95/97/98/99/100), as are 14 of 15 punt return TDs
and 13 of 45 interception return TDs.

CREDITING
---------
A 50+ yard passing TD pays BOTH sides — the passer under PS and the receiver
under RC — so those are credited separately, not once to `td_player_id`.

  pass_touchdown   -> passer_player_id   (PS) + receiver_player_id (RC)
  rush_touchdown   -> rusher_player_id   (RS)
  return_touchdown -> td_player_id, classified by play_type:
       'punt'    -> PR   punt return TD
       'kickoff' -> KO   kickoff return TD
       else      -> IR/FR/DR  defensive return TD (play_type 'pass' is an
                    interception return, 'run' a fumble return)

⚠️ `punt_return_tds` is OWNED BY THIS SCRIPT and is RETURNER-credited. Migration
0117 originally sourced it from nflverse `pt_return_tds`, which was wrong: the
`pt_*` block is the PUNTER's stat line, so that column is TDs the punter
ALLOWED (position 'P' rows only). Crediting it as a return TD would have paid
punters 6-7 points for giving up a return touchdown. Migration 0119 clears those
values and the alias was removed from PLAYERSTATS_MAP.

COVERAGE SEMANTICS
------------------
A row is written only when at least one payload value is NONZERO, so for a
processed season an ABSENT row means "none of these events occurred" and
LEFT JOIN ... COALESCE(x, 0) is correct. That inference is valid ONLY for
seasons this script has actually run. Check before relying on it:
    SELECT season, COUNT(*) FROM nfl_player_weekly_ext
     WHERE pass_tds_50plus IS NOT NULL GROUP BY season;

Usage:
  python3 pipelines/etl/scripts/backfill_td_distance.py --seasons 2011-2025
  python3 pipelines/etl/scripts/backfill_td_distance.py --seasons 2025 --dry-run
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

CHUNK = 1000

COLS = ["season", "week", "gsis_id",
        "pass_tds_50plus", "rush_tds_50plus", "rec_tds_50plus",
        "punt_return_tds", "punt_ret_tds_50plus",
        "kick_ret_tds", "kick_ret_tds_50plus",
        "def_ret_tds_50plus", "rush_2pt", "rec_2pt"]

LONG_TD = 50  # UPS 50-110 tier pays 7 instead of 6


class SourceColumnMissing(RuntimeError):
    """An expected upstream column is absent — refuse to write that season."""


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


def _f(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if f != f else f


def _sid(v):
    return v if isinstance(v, str) and v.strip() else None


def compute_season(year: int) -> list[tuple]:
    import nflreadpy as nfl

    # ── PBP: TD distance tiers + return TDs ────────────────────────────────
    pbp = nfl.load_pbp(seasons=[year])
    d = pbp.to_pandas() if hasattr(pbp, "to_pandas") else pbp
    d.columns = [c.lower() for c in d.columns]

    need = ["touchdown", "season_type", "week", "play_type", "yards_gained",
            "return_yards", "pass_touchdown", "rush_touchdown", "return_touchdown",
            "passer_player_id", "receiver_player_id", "rusher_player_id",
            "td_player_id"]
    missing = [c for c in need if c not in d.columns]
    if missing:
        raise SourceColumnMissing(f"[{year}] PBP is missing {missing}")

    td = d[(d["touchdown"].fillna(0) == 1) & (d["season_type"] == "REG")]

    # (week, gsis) -> {col: count}
    acc: dict[tuple, dict] = {}

    def bump(wk, gsis, col, n=1):
        if gsis is None or wk is None:
            return
        acc.setdefault((wk, gsis), {})
        acc[(wk, gsis)][col] = acc[(wk, gsis)].get(col, 0) + n

    for r in td.to_dict(orient="records"):
        try:
            wk = int(r.get("week"))
        except (TypeError, ValueError):
            continue
        gained = _f(r.get("yards_gained"))
        ret = _f(r.get("return_yards"))

        if _f(r.get("pass_touchdown")) == 1:
            # Offensive passing TD — pays the passer (PS) AND the receiver (RC).
            if gained >= LONG_TD:
                bump(wk, _sid(r.get("passer_player_id")), "pass_tds_50plus")
                bump(wk, _sid(r.get("receiver_player_id")), "rec_tds_50plus")
        elif _f(r.get("rush_touchdown")) == 1:
            if gained >= LONG_TD:
                bump(wk, _sid(r.get("rusher_player_id")), "rush_tds_50plus")
        elif _f(r.get("return_touchdown")) == 1:
            # Return TDs use return_yards — yards_gained is 0 on kickoffs.
            scorer = _sid(r.get("td_player_id"))
            pt = str(r.get("play_type") or "")
            if pt == "punt":
                bump(wk, scorer, "punt_return_tds")
                if ret >= LONG_TD:
                    bump(wk, scorer, "punt_ret_tds_50plus")
            elif pt == "kickoff":
                bump(wk, scorer, "kick_ret_tds")
                if ret >= LONG_TD:
                    bump(wk, scorer, "kick_ret_tds_50plus")
            else:
                # 'pass' = interception return, 'run' = fumble return.
                if ret >= LONG_TD:
                    bump(wk, scorer, "def_ret_tds_50plus")

    # ── weekly stats: rushing / receiving 2-pt conversions (C12) ───────────
    ws = nfl.load_player_stats(seasons=[year])
    w = ws.to_pandas() if hasattr(ws, "to_pandas") else ws
    w.columns = [c.lower() for c in w.columns]
    for col, out_col in (("rushing_2pt_conversions", "rush_2pt"),
                         ("receiving_2pt_conversions", "rec_2pt")):
        if col not in w.columns:
            raise SourceColumnMissing(f"[{year}] player_stats is missing {col}")
        sub = w[w[col].fillna(0) > 0]
        for r in sub.to_dict(orient="records"):
            gsis = _sid(r.get("player_id") or r.get("gsis_id"))
            try:
                wk = int(r.get("week"))
            except (TypeError, ValueError):
                continue
            bump(wk, gsis, out_col, int(_f(r.get(col))))

    payload = [c for c in COLS if c not in ("season", "week", "gsis_id")]
    return [
        tuple([year, wk, gsis] + [v.get(c) for c in payload])
        for (wk, gsis), v in acc.items()
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2011-2025")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    grand = 0
    failed: list[str] = []
    for yr in parse_seasons(args.seasons):
        try:
            rows = compute_season(yr)
        except SourceColumnMissing as e:
            failed.append(str(e))
            print(f"[{yr}] SKIPPED — {e}", file=sys.stderr, flush=True)
            continue
        idx = {c: i for i, c in enumerate(COLS)}
        tot = {c: sum((r[idx[c]] or 0) for r in rows)
               for c in ("pass_tds_50plus", "rush_tds_50plus", "rec_tds_50plus",
                         "punt_return_tds", "kick_ret_tds", "def_ret_tds_50plus",
                         "rush_2pt", "rec_2pt")}
        print(f"[{yr}] rows={len(rows):>5} | 50+ pass/rush/rec "
              f"{tot['pass_tds_50plus']}/{tot['rush_tds_50plus']}/{tot['rec_tds_50plus']}"
              f" | ret TD punt/kick {tot['punt_return_tds']}/{tot['kick_ret_tds']}"
              f" | def50+ {tot['def_ret_tds_50plus']}"
              f" | 2pt rush/rec {tot['rush_2pt']}/{tot['rec_2pt']}",
              file=sys.stderr, flush=True)
        if args.dry_run:
            continue
        with D1Writer(table="nfl_player_weekly_ext", cols=COLS,
                      pk_cols=["season", "week", "gsis_id"], chunk_size=CHUNK) as wtr:
            for r in rows:
                wtr.add(r)
        grand += len(rows)
        print(f"[{yr}] written", file=sys.stderr, flush=True)

    print(f"DONE: {'would write' if args.dry_run else 'wrote'} {grand} rows",
          file=sys.stderr)
    if failed:
        print(f"\n{len(failed)} SEASON(S) WROTE NOTHING:", file=sys.stderr)
        for f in failed:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
