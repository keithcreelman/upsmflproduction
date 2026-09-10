#!/usr/bin/env python3
"""Rank players by their value UNDER CBS grffl's OWN scoring, not a generic board.

WHAT THIS IS, STATED PLAINLY
============================
This is a PRODUCTION BASELINE, not a projection. It answers "what would each
player have been worth in THIS league, weighting recent seasons most heavily" —
it does not model 2026 team changes, depth-chart moves, holdouts or injuries.
That is deliberate: the edge being hunted here is the gap between this league's
unusual scoring and the market's generic board, and that gap is visible in
production terms without forecasting anything.

⚠️ NEVER USES CURRENT-SEASON STATS. Keith's standing rule, after a bot cited a
player's "zero PPG this season" in July: pre-season, use the prior three
seasons weighted toward the most recent, never the season that has not started.
Enforced in the QUERY (`season < {target}`), not in a comment.

WHY THE POINTS ARE SUMMED PER GAME AND NEVER FROM SEASON TOTALS
--------------------------------------------------------------
This league pays stacking milestones — +3 at 100 rushing yards, again at 200,
again at 300 — which are per-GAME facts. Scoring a season total instead awards
a 1,202-yard rusher those bonuses once each for the year. Done that way against
CBS's own 2025 page, 63 of 100 running backs came out HIGHER than CBS says they
scored. Every bonus in this league is additive, so exceeding the provider's own
total is proof of a bug, and it is the check this script's engine is validated
against (57 player-seasons, 4 positions, 0 violations).

THE ONE THING THE ENGINE CANNOT SEE, AND HOW IT IS PRICED
---------------------------------------------------------
Touchdown bonuses are banded by the LENGTH of each touchdown (10-39 / 40-69 /
70-100), which weekly stat lines do not carry. Rather than ignore them — they
are worth 5-10% of a scorer's season — the average bonus per touchdown is
MEASURED per position against CBS's own published points, and added back. Those
values are derived, are printed in the header of every run, and are never
presented as rulebook numbers.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import d1 as fd1                                    # noqa: E402
from fantasy.scoring import ScoringError, load_table             # noqa: E402

LEAGUE_KEY = "ffl.s2026.l.grffl"
PLATFORM = "cbs"

#: Keith's rule: prior 3 seasons, most emphasis on the prior season.
#: RENORMALISED over seasons actually played, so a second-year player is not
#: punished for not existing in 2023.
SEASON_WEIGHTS = {0: 0.60, 1: 0.25, 2: 0.15}

#: A season shorter than this is an injury cameo, not a sample. Excluded from
#: the weighted average rather than dragging a player's rate down.
MIN_GAMES = 4

#: Average bonus points per touchdown, MEASURED against CBS's own published
#: points (see module docstring) and SOLVED SEPARATELY PER TD TYPE.
#:
#: ⚠️ A SINGLE FLAT RATE PER POSITION IS NOT GOOD ENOUGH, and the difference
#: runs against the headline finding rather than for it. A flat QB rate of
#: +1.13 prices a quarterback's rushing touchdowns the same as his passing
#: ones; solved separately, QB rushing TDs are worth only +0.70 because they
#: are overwhelmingly goal-line carries UNDER the 10-yard bonus threshold,
#: while a receiver's rushing TD (+6.63) is an end-around that usually goes
#: long. Using the flat rate overstated exactly the rushing-quarterback effect
#: this board exists to measure.
#:
#: Derived by regressing (CBS actual - engine base) on each TD count across
#: 2025's top ~50 per position. Regenerate with scripts/cbs_measure_td_bonus.py.
#: ⚠️ SUPERSEDED VALUES, KEPT AS A WARNING. The first pass fitted these by
#: regression and got roughly DOUBLE the truth (QB PaTD 1.16 vs 0.72, RB ReTD
#: 2.90 vs 1.27, WR ReTD 2.14 vs 0.87). The residual it regressed on was
#: absorbing a whole missing GAME per player — the query truncated at week 17
#: when the NFL regular season runs 18 — plus the unrecorded fumbles. A fit is
#: only ever as good as the base it is a residual of.
TD_BONUS = {
    "QB": {"PaTD": 0.72, "RuTD": 0.48},
    "RB": {"RuTD": 0.77, "ReTD": 1.27},
    "WR": {"ReTD": 0.87},
    "TE": {"ReTD": 0.48},
}

#: Fumbles lost per GAME, from MFL's `detailed?` report, which states the TRUE
#: total including strip-sacks. nfl_player_weekly has only rush+rec fumbles, so
#: this is the correction for what it cannot see. Quarterbacks lose the most
#: precisely because their fumbles are mostly sacks — the ones D1 misses.
#: Applied as a per-game penalty rather than per-player, because the weekly
#: table cannot attribute it to anyone in particular.
FUMBLE_POINTS = -2.0
UNRECORDED_FUMBLES_PER_GAME = {"QB": 0.173, "RB": 0.090, "WR": 0.026, "TE": 0.011}

#: ⚠️ THE NFL REGULAR SEASON IS 18 WEEKS, NOT 17. CBS's own stats page totals
#: all 18, and truncating at 17 silently drops one game per player — about 6%
#: of a season, and enough to make every fitted coefficient wrong. Weeks 19+
#: are playoffs and are correctly excluded. Verified by reproducing CBS's
#: published stat line exactly: Zay Flowers 86 rec / 1,211 yds / 5 TD.
LAST_REGULAR_WEEK = 18

#: nfl_player_weekly column -> this league's stat abbreviation.
STAT_MAP = {
    "rush_yds": "RuYd", "rush_tds": "RuTD", "receptions": "Recpt",
    "rec_yds": "ReYd", "rec_tds": "ReTD", "pass_yds": "PaYd",
    "pass_tds": "PaTD", "pass_ints": "PaInt",
}
TD_KEYS = ("RuTD", "ReTD", "PaTD")

#: The league's starting lineup: QB1 RB2 WR2 TE1 FLEX1 K1 DST1 over 12 teams.
BASE_STARTERS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1}
FLEX_ELIGIBLE = ("RB", "WR", "TE")


def fetch_games(loader, *, target_season: int, lookback: int) -> dict:
    """Every weekly line for the lookback window, grouped by player-season.

    ⚠️ THE CURRENT-SEASON EXCLUSION IS IN THE SQL. `season < target_season` is
    the enforcement point; a rule that lives only in a docstring has already
    been violated once in this repo.
    """
    lo = target_season - lookback
    cols = ", ".join(f"w.{c}" for c in STAT_MAP)
    rows = loader.query(
        f"SELECT n.display_name nm, n.gsis_id gid, w.season, w.week, w.position pos, "
        f"w.team, {cols}, w.rush_fumbles_lost rfl, w.rec_fumbles_lost cfl "
        f"FROM nfl_player_weekly w JOIN nfl_player_names n ON n.gsis_id = w.gsis_id "
        f"WHERE w.season >= {lo} AND w.season < {target_season} "
        f"AND w.week <= {LAST_REGULAR_WEEK} "
        f"AND w.position IN ('QB','RB','WR','TE');")
    if not rows:
        raise SystemExit(
            f"no weekly rows for {lo}..{target_season - 1}. An empty history is "
            f"not a board — refusing to rank nobody.")
    out: dict = {}
    for r in rows:
        out.setdefault((r["gid"], r["nm"]), {}).setdefault(int(r["season"]), []).append(r)
    return out


def to_stats(r: dict) -> dict:
    s = {abbr: float(r.get(col) or 0) for col, abbr in STAT_MAP.items()}
    s["FL"] = float(r.get("rfl") or 0) + float(r.get("cfl") or 0)
    return s


def build(loader, table, *, target_season: int, lookback: int, verbose: bool) -> list[dict]:
    games = fetch_games(loader, target_season=target_season, lookback=lookback)
    seasons_desc = [target_season - 1 - i for i in range(lookback)]
    out = []
    skipped_pos: dict[str, int] = {}

    for (gid, nm), by_season in games.items():
        # A player's position can change across seasons; the most recent one
        # that has games is the one that matters for 2026 eligibility.
        pos = None
        for s in seasons_desc:
            if by_season.get(s):
                pos = by_season[s][0]["pos"]
                break
        if pos not in TD_BONUS:
            skipped_pos[str(pos)] = skipped_pos.get(str(pos), 0) + 1
            continue

        parts, seen = [], []
        for i, season in enumerate(seasons_desc):
            gs = by_season.get(season) or []
            if len(gs) < MIN_GAMES:
                continue
            lines = [to_stats(g) for g in gs]
            try:
                pts = table.score_weeks(pos, lines)
            except ScoringError as exc:
                raise SystemExit(f"{nm} {season}: {exc}")
            # Measured from real TD lengths, per TD TYPE, never the rulebook.
            for td_stat, bonus in TD_BONUS[pos].items():
                pts += bonus * sum(l[td_stat] for l in lines)
            # The fumbles nfl_player_weekly cannot see (strip-sacks).
            pts += (FUMBLE_POINTS * UNRECORDED_FUMBLES_PER_GAME[pos] * len(lines))
            parts.append((SEASON_WEIGHTS[i], pts / len(gs), len(gs), season))
            seen.append(season)
        if not parts:
            continue

        # ⚠️ RENORMALISE over seasons actually played. Dividing by the full
        # weight instead would silently halve every second-year player.
        wsum = sum(w for w, *_ in parts)
        ppg = sum(w * p for w, p, *_ in parts) / wsum
        out.append({
            "player": nm, "gsis_id": gid, "position": pos,
            "team": by_season[seen[0]][-1].get("team"),
            "ppg": round(ppg, 2),
            "proj_points": round(ppg * 17, 1),
            "seasons_used": seen,
            "games": sum(g for *_, g, _ in parts),
            "weight_coverage": round(wsum, 2),
        })
    if verbose and skipped_pos:
        print(f"  skipped positions (not scored by this board): {skipped_pos}")
    return sorted(out, key=lambda r: -r["proj_points"])


def add_vor(board: list[dict], *, teams: int) -> list[dict]:
    """Value over replacement, with the FLEX allocated from the data itself.

    ⚠️ THE FLEX SPLIT IS NOT ASSUMED. A fixed "RB 30 / WR 36 / TE 14" guess is
    the usual shortcut and it bakes in exactly the generic positional model this
    league breaks. Instead the base starters are filled first, then the best
    remaining RB/WR/TE by THIS league's points compete for the flex slots, and
    replacement level is whoever ends up last at each position.
    """
    by_pos: dict[str, list[dict]] = {}
    for r in board:
        by_pos.setdefault(r["position"], []).append(r)

    starters = {p: n * teams for p, n in BASE_STARTERS.items()}
    pool = []
    for p in FLEX_ELIGIBLE:
        pool += by_pos.get(p, [])[starters.get(p, 0):]
    pool.sort(key=lambda r: -r["proj_points"])
    flex_used: dict[str, int] = {}
    for r in pool[:teams]:
        flex_used[r["position"]] = flex_used.get(r["position"], 0) + 1
        starters[r["position"]] += 1

    repl = {}
    for p, n in starters.items():
        lst = by_pos.get(p, [])
        if len(lst) < n:
            raise SystemExit(
                f"only {len(lst)} scored players at {p} but {n} would start "
                f"league-wide; replacement level is undefined.")
        repl[p] = lst[n - 1]["proj_points"]
    for r in board:
        r["vor"] = round(r["proj_points"] - repl[r["position"]], 1)
    board.sort(key=lambda r: -r["vor"])
    return board, starters, repl, flex_used


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--lookback", type=int, default=3)
    ap.add_argument("--teams", type=int, default=12)
    ap.add_argument("--top", type=int, default=60)
    ap.add_argument("--target", choices=["local", "remote"], default="remote")
    ap.add_argument("--json-out", default="")
    a = ap.parse_args()

    loader = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    table = load_table(loader, platform=PLATFORM, league_key=LEAGUE_KEY, season=a.season)

    print(f"CBS grffl board for {a.season} — {a.teams} teams")
    print(f"  scoring: {len(table.rates)} stats, "
          f"{sum(len(v) for v in table.bands.values())} bands, "
          f"read from D1 ({PLATFORM}/{LEAGUE_KEY}/{a.season})")
    print(f"  basis:   seasons {a.season - a.lookback}..{a.season - 1}, weights "
          f"{list(SEASON_WEIGHTS.values())} renormalised over seasons played, "
          f"min {MIN_GAMES} games")
    print(f"  window:  NFL weeks 1-{LAST_REGULAR_WEEK} (the regular season; "
          f"playoffs excluded)")
    print("  TD bonus (EXACT, from MFL's per-touchdown lengths):")
    for k, v in TD_BONUS.items():
        print(f"      {k}: " + ", ".join(f"{t} +{b}" for t, b in v.items())
              + f"   unrecorded fumbles {UNRECORDED_FUMBLES_PER_GAME[k]}/g")

    board = build(loader, table, target_season=a.season, lookback=a.lookback, verbose=True)
    board, starters, repl, flex = add_vor(board, teams=a.teams)

    print(f"\n  league-wide starters (flex allocated from the data, not assumed): "
          + ", ".join(f"{p}{n}" for p, n in sorted(starters.items()))
          + f"   flex went {flex}")
    print("  replacement level: " + ", ".join(f"{p} {v}" for p, v in sorted(repl.items())))
    print(f"  {len(board)} players scored\n")

    print(f"{'#':>3}  {'player':<24}{'pos':<5}{'tm':<5}{'pts':>7}{'ppg':>7}{'VOR':>7}  basis")
    for i, r in enumerate(board[:a.top], 1):
        yrs = ",".join(str(s)[-2:] for s in r["seasons_used"])
        print(f"{i:>3}  {r['player']:<24}{r['position']:<5}{str(r['team'] or '?'):<5}"
              f"{r['proj_points']:>7.1f}{r['ppg']:>7.1f}{r['vor']:>7.1f}  '{yrs} ({r['games']}g)")

    if a.json_out:
        Path(a.json_out).write_text(json.dumps(board, indent=1))
        print(f"\nwrote {len(board)} rows -> {a.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
