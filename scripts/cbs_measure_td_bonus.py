#!/usr/bin/env python3
"""Measure what a touchdown's DISTANCE bonus is actually worth, per TD type.

WHY THIS HAS TO BE MEASURED RATHER THAN READ
============================================
CBS pays a touchdown bonus banded by the LENGTH of the touchdown — 10-39 /
40-69 / 70-100 yards — and at most one band fires per touchdown. Weekly stat
lines carry TD COUNTS, not TD lengths, so the bands cannot be evaluated from
them at any level of aggregation. Ignoring them is not an option either: they
are worth 5-10% of a real scorer's season.

So the bonus is recovered as a RESIDUAL. Score a player's season game by game
with the rulebook engine (which gets everything except the distance bands
right), subtract from CBS's own published season total, and regress what is
left on that player's touchdown counts. The coefficients that come out are the
average bonus per touchdown of each type.

⚠️ SOLVE PER TD TYPE, NOT PER POSITION. A single flat per-position rate hides
the largest effect in the data and biases it in the wrong direction: a
quarterback's rushing touchdowns are worth only +0.70 because they are
overwhelmingly goal-line carries BELOW the 10-yard threshold, while his passing
touchdowns are +1.16. A receiver's rushing touchdown is +6.63 — an end-around
that usually goes long, on the larger 2/6/10 out-of-position scale. Averaging
those together overstated the rushing-quarterback premium that the whole
league-specific board exists to measure.

⚠️ THE RESIDUAL MUST BE NON-NEGATIVE. Every bonus in this league adds. If the
engine ever scores a player ABOVE CBS's own total, the rulebook is being
applied wrongly and this script refuses rather than fitting a negative bonus.

⚠️ ONE KNOWN, NAMED EXCEPTION — QUARTERBACK SACK FUMBLES. This database has no
sack-fumble column ANYWHERE (`nfl_player_weekly` carries rush_fumbles_lost and
rec_fumbles_lost only; nflverse's sack_fumbles_lost was never ingested, and the
table is at D1's hard 100-column cap so it cannot simply be added — it would go
in nfl_player_weekly_ext). A quarterback's fumbles are mostly strip-sacks, so
the engine misses a -2 for each one and scores him slightly HIGH.

That was found BY this guard: four backup quarterbacks came out above CBS's
own total by roughly one fumble each. Elite quarterbacks hid it, because their
touchdown bonus is far larger than a stray -2. The gap is therefore bounded,
understood, and QB-only, so it is excused within an explicit per-player limit
and every excused player is PRINTED. It is not silently tolerated, and the
guard still fails hard for any other position or any larger discrepancy.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import d1 as fd1                                        # noqa: E402
from fantasy.providers.cbs.auth import load_cookies                  # noqa: E402
from fantasy.providers.cbs.client import CbsClient                   # noqa: E402
from fantasy.providers.cbs.stats import _Tables, parse_stats_table   # noqa: E402
from fantasy.scoring import load_table                               # noqa: E402

LEAGUE_KEY = "ffl.s2026.l.grffl"
#: TD types that plausibly occur for each position, most common first.
TERMS = {"QB": ["PaTD", "RuTD"], "RB": ["RuTD", "ReTD"],
         "WR": ["ReTD", "RuTD"], "TE": ["ReTD", "RuTD"]}
MIN_TDS = 3          # below this the residual is mostly noise
MIN_PLAYERS = 12     # refuse to fit a coefficient from a handful of seasons

#: Points per lost fumble in this league. Used only to size the QB exception.
FUMBLE_POINTS = -2.0
#: The most sack-fumbles a quarterback could plausibly lose in one game.
#: Generous on purpose: the bound exists to catch a REAL rate error, which
#: would scale with yardage and be far larger than a per-game fumble or two.
MAX_SACK_FUMBLES_PER_GAME = 1.0


def stats_page(client, pos: str, season: int, league_id: str) -> list[tuple[str, dict]]:
    html = client.get_html(
        f"https://{league_id}.football.cbssports.com/stats/stats-main/all:{pos}/{season}")
    _, rows = parse_stats_table(html)
    p = _Tables()
    p.feed(html)
    hi = next(i for i, r in enumerate(p.rows)
              if len(r) > 10 and r and r[0].strip().lower() == "action")
    names = []
    for row in p.rows:
        if len(row) != len(p.rows[hi]):
            continue
        low = [c.strip().lower() for c in row[:3]]
        if "action" in low or "totals" in low:
            continue
        if len(row) < 3 or not row[2] or not re.search(r"[A-Za-z]", row[2]):
            continue
        # "Bijan Robinson RB • ATL" -> "Bijan Robinson"
        names.append(re.split(r"\s+[A-Z/]{1,4}\s*•", row[2])[0].strip())
    if len(names) != len(rows):
        raise SystemExit(f"{pos} {season}: {len(names)} names vs {len(rows)} stat rows — "
                         f"refusing to pair them up by position.")
    return list(zip(names, rows))


def lstsq(X: list[list[float]], y: list[float]) -> list[float] | None:
    """Normal equations + Gauss-Jordan. No numpy in this repo."""
    n = len(X[0])
    A = [[sum(X[r][i] * X[r][j] for r in range(len(X))) for j in range(n)]
         + [sum(X[r][i] * y[r] for r in range(len(X)))] for i in range(n)]
    for c in range(n):
        pv = max(range(c, n), key=lambda r: abs(A[r][c]))
        A[c], A[pv] = A[pv], A[c]
        if abs(A[c][c]) < 1e-9:
            return None
        d = A[c][c]
        A[c] = [v / d for v in A[c]]
        for r in range(n):
            if r != c and A[r][c]:
                f = A[r][c]
                A[r] = [a - f * b for a, b in zip(A[r], A[c])]
    return [A[i][n] for i in range(n)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--rules-season", type=int, default=2026)
    ap.add_argument("--league-id", default="grffl")
    ap.add_argument("--top", type=int, default=60)
    ap.add_argument("--json-out", default="")
    a = ap.parse_args()

    loader = fd1.D1Loader(target="remote", db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    table = load_table(loader, platform="cbs", league_key=LEAGUE_KEY, season=a.rules_season)
    client = CbsClient(load_cookies(), min_interval_sec=0.6)

    esc = lambda t: "'" + t.replace("'", "''") + "'"                  # noqa: E731
    out: dict[str, dict[str, float]] = {}
    print(f"TD distance bonus, solved from the residual vs CBS's own {a.season} points\n")

    for pos, terms in TERMS.items():
        pairs = stats_page(client, pos, a.season, a.league_id)[:a.top]
        names = [n for n, _ in pairs]
        rows = loader.query(
            "SELECT n.display_name nm, w.rush_yds, w.rush_tds, w.receptions, w.rec_yds, "
            "w.rec_tds, w.pass_yds, w.pass_tds, w.pass_ints, w.rush_fumbles_lost, "
            "w.rec_fumbles_lost FROM nfl_player_weekly w "
            "JOIN nfl_player_names n ON n.gsis_id = w.gsis_id "
            f"WHERE w.season = {a.season} AND w.week <= 17 "
            f"AND n.display_name IN ({','.join(map(esc, names))});")
        by: dict[str, list[dict]] = {}
        for r in rows:
            by.setdefault(r["nm"], []).append(r)

        X, Y, over, excused = [], [], [], []
        for nm, cbs in pairs:
            gs = by.get(nm)
            if not gs or not cbs["y"]:
                continue
            games = [{"RuYd": g.get("rush_yds") or 0, "RuTD": g.get("rush_tds") or 0,
                      "Recpt": g.get("receptions") or 0, "ReYd": g.get("rec_yds") or 0,
                      "ReTD": g.get("rec_tds") or 0, "PaYd": g.get("pass_yds") or 0,
                      "PaTD": g.get("pass_tds") or 0, "PaInt": g.get("pass_ints") or 0,
                      "FL": (g.get("rush_fumbles_lost") or 0) + (g.get("rec_fumbles_lost") or 0)}
                     for g in gs]
            residual = cbs["y"] - table.score_weeks(pos, games)
            if residual < -0.05:
                # The ONE named exception; see the module docstring. Sized per
                # player from games played, never a blanket allowance, and
                # never available to a non-QB.
                allowance = (abs(FUMBLE_POINTS) * MAX_SACK_FUMBLES_PER_GAME * len(games)
                             if pos == "QB" else 0.0)
                if residual >= -allowance:
                    excused.append((nm, round(residual, 2), len(games)))
                    continue
                over.append((nm, round(residual, 2)))
                continue
            counts = [sum(g[t] for g in games) for t in terms]
            if sum(counts) < MIN_TDS:
                continue
            X.append(counts)
            Y.append(residual)

        # ⚠️ FAIL, DO NOT FIT. A negative residual means the rulebook is being
        # applied wrongly somewhere; fitting through it would bury the bug in a
        # coefficient that still looks reasonable.
        if over:
            raise SystemExit(
                f"{pos}: the engine scored {len(over)} player(s) ABOVE CBS's own "
                f"published total, e.g. {over[:3]}. Every bonus in this league "
                f"adds, so that is impossible unless a rate is wrong. Refusing "
                f"to fit a bonus on top of a broken base.")
        if excused:
            print(f"  {pos}: {len(excused)} player(s) excused for MISSING SACK-FUMBLE "
                  f"DATA (engine has no sack_fumbles_lost to subtract):")
            for nm, r, g in excused[:5]:
                print(f"        {nm:<24} residual {r:>6} over {g} games "
                      f"(~{abs(r) / 2:.1f} unrecorded fumbles)")
        if len(X) < MIN_PLAYERS:
            raise SystemExit(f"{pos}: only {len(X)} usable players; refusing to fit.")

        beta = lstsq(X, Y)
        if beta is None:
            raise SystemExit(f"{pos}: singular system — TD types are collinear here.")
        out[pos] = {t: round(v, 2) for t, v in zip(terms, beta) if v > 0.01}
        print(f"  {pos} (n={len(X):>3}): "
              + "   ".join(f"{t} +{v:.2f}/TD" for t, v in zip(terms, beta)))

    print("\nPaste into scripts/cbs_build_board.py TD_BONUS:")
    print(json.dumps(out, indent=4))
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
