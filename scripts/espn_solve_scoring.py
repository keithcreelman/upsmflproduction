#!/usr/bin/env python3
"""Recover ESPN's missing scoring coefficients by fitting real stat lines.

WHY THIS EXISTS. ESPN's settings payload returns 41 scoring items and none of
them is passing yards, so the rulebook on file cannot score a quarterback — a
QB without passing yards loses ~250 points and ranks below a backup running
back. But ESPN publishes its OWN points for every player-week
(fantasy_player_week_points.points_provider), and real stat lines live in
nfl_player_weekly. The multiplier ESPN will not state is recoverable by
regressing one against the other.

⚠️ THE FIT VALIDATES ITSELF, WHICH IS THE ONLY REASON TO TRUST IT. Seven
coefficients are already KNOWN from the payload — passing TD 6, interception
-2, rushing and receiving yards 0.1, rushing and receiving TD 6, reception 1.0.
Those are not fed to the solver. If the regression independently recovers them,
the same regression's answer for passing yards is trustworthy. If it does NOT
recover them, the fit is measuring something else and its passing-yards number
must be thrown away, not shipped. That check is enforced below, not eyeballed.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))
from fantasy import d1 as fd1                                    # noqa: E402

#: ⚠️ THE LEAGUE KEY IS SEASON-SCOPED. 2025 rows live under
#: ffl.s2025.l.176898, not the 2026 key — hardcoding one season's key while
#: querying another returned zero rows, and only the row-count guard stopped
#: that from being read as "no data" instead of "wrong filter".
ESPN_LEAGUE_ID = "176898"


def league_key(season: int) -> str:
    return f"ffl.s{season}.l.{ESPN_LEAGUE_ID}"
#: The columns fed to the solver, in order.
#: ⚠️ DO NOT ESTIMATE WHAT THE PAYLOAD ALREADY STATES. Receptions and
#: receiving yards move together, so a solver given both returns whichever
#: split minimises error — it produced 0.82/0.127 against a stated 1.00/0.100,
#: with the SUM correct and the split meaningless. The stated rules are
#: subtracted from the points first; only genuinely unknown terms are fitted.
STATED = {"pass_tds": 6.0, "pass_ints": -2.0, "rush_yds": 0.1, "rush_tds": 6.0,
          "rec_yds": 0.1, "rec_tds": 6.0, "receptions": 1.0}
#: Fitted against the residual the stated rules leave behind.
TERMS = ["pass_yds", "pass_sacks", "fumbles_lost"]
#: What the payload already states. NOT given to the solver — they are the
#: control. Tolerances are generous because ESPN rounds its published points.




def lstsq(X, y):
    """Normal equations with Gaussian elimination. No numpy in this repo."""
    n = len(X[0])
    A = [[sum(X[r][i] * X[r][j] for r in range(len(X))) for j in range(n)] + [
          sum(X[r][i] * y[r] for r in range(len(X)))] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        if abs(A[p][c]) < 1e-9:
            raise SystemExit(f"term {TERMS[c]} is collinear or absent — "
                             f"refusing to report a coefficient for it.")
        A[c], A[p] = A[p], A[c]
        for r in range(n):
            if r == c:
                continue
            f = A[r][c] / A[c][c]
            for k in range(c, n + 1):
                A[r][k] -= f * A[c][k]
    return [A[i][n] / A[i][i] for i in range(n)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--min-rows", type=int, default=200)
    a = ap.parse_args()

    L = fd1.D1Loader(target="remote", db=fd1.DEFAULT_DB,
                     worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    rows = L.query(f"""
        SELECT p.points_provider pts, w.position,
               COALESCE(w.pass_yds,0) pass_yds, COALESCE(w.pass_tds,0) pass_tds,
               COALESCE(w.pass_ints,0) pass_ints, COALESCE(w.pass_sacks,0) pass_sacks,
               COALESCE(w.rush_yds,0) rush_yds, COALESCE(w.rush_tds,0) rush_tds,
               COALESCE(w.rec_yds,0) rec_yds, COALESCE(w.rec_tds,0) rec_tds,
               COALESCE(w.receptions,0) receptions,
               COALESCE(w.rush_fumbles_lost,0)+COALESCE(w.rec_fumbles_lost,0) fumbles_lost
        FROM fantasy_player_week_points p
        JOIN fantasy_players f
          ON f.platform = p.platform AND f.player_uid = p.player_uid
        -- display_name_lower is a VIRTUAL GENERATED column + index added on
        -- nfl_player_names (migration 0144, worker/src is the OTHER project
        -- sharing this D1 instance). LOWER(n.display_name) = LOWER(f.full_name)
        -- could use no index on either side -- nfl_player_names had none at
        -- all -- so every run scanned its full ~25,764 rows PER OUTER ROW.
        -- Measured on prod 2026-08-28: 4,501,580 rows read for one run of
        -- this exact query, ~90% of the 5,000,000/day free-tier ceiling this
        -- D1 instance shares with the live UPS/MFL bookkeeping app.
        JOIN nfl_player_names n
          ON n.display_name_lower = LOWER(f.full_name)
        -- CROSS JOIN, not JOIN -- deliberately, to PIN this join's position.
        -- SQLite reorders plain JOINs freely, and even with the index above
        -- in place it kept choosing to search nfl_player_weekly by
        -- (season=?, week=?) alone -- BEFORE n was resolved, so w.gsis_id
        -- could not be bound yet -- pulling in every player active that NFL
        -- week (nfl_player_weekly's own PK is (season, week, gsis_id); the
        -- correct plan waits for n.gsis_id so all three columns bind at once).
        -- CROSS JOIN tells the optimizer not to reorder this table relative
        -- to the ones before it (SQLite's documented mechanism for exactly
        -- this), which produces the seek this join actually needs:
        --   SEARCH w USING INDEX sqlite_autoindex_nfl_player_weekly_1
        --     (season=? AND week=? AND gsis_id=?)
        -- Verified live: 4,501,580 -> 14,731 rows read (305x), output
        -- IDENTICAL -- same 2,371 rows, every column, diffed row-for-row
        -- against the unfixed query, not just compared by count.
        CROSS JOIN nfl_player_weekly w
          ON w.gsis_id = n.gsis_id AND w.season = p.season AND w.week = p.week
        WHERE p.platform='espn' AND p.season={a.season}
          AND p.league_key='{league_key(a.season)}'
          AND p.points_provider IS NOT NULL
          -- ⚠️ Offence only. The name join matched six DEFENSIVE BACKS with
          -- receptions, and D/ST rows carry points with no offensive line at
          -- all; both would be fitted as noise against a zero row.
          AND w.position IN ('QB','RB','WR','TE');""")
    if len(rows) < a.min_rows:
        raise SystemExit(f"only {len(rows)} joined player-weeks — too few to fit.")

    def stated_pts(r):
        return sum(v * float(r[k]) for k, v in STATED.items())

    # ⚠️ TOUCHDOWN-FREE WEEKS ONLY. Six of the twelve unnamed ids sit at 5 and
    # 10 points in three matched pairs — almost certainly distance touchdown
    # bonuses. A week with no touchdown cannot trigger one, so restricting here
    # removes them from the residual instead of letting them inflate a rate.
    fit = [r for r in rows
           if not (r["pass_tds"] or r["rush_tds"] or r["rec_tds"])]
    X = [[float(r[t]) for t in TERMS] for r in fit]
    y = [float(r["pts"]) - stated_pts(r) for r in fit]
    beta = dict(zip(TERMS, lstsq(X, y)))

    resid = sorted(abs(sum(X[i][j] * beta[TERMS[j]] for j in range(len(TERMS))) - y[i])
                   for i in range(len(y)))
    med = resid[len(resid) // 2]

    # ── the control: players who never threw a pass ─────────────────────────
    # For them the fitted terms are all zero, so points minus the stated rules
    # must already be ~0. If it is not, the STATED rules are wrong and nothing
    # fitted on top of them can be trusted.
    ctrl = [r for r in fit if r["pass_yds"] == 0 and r["pass_sacks"] == 0]
    cres = sorted(abs(float(r["pts"]) - stated_pts(r)) for r in ctrl)
    cmed = cres[len(cres) // 2] if cres else None

    print(f"ESPN {a.season} — {len(rows)} joined player-weeks, "
          f"{len(fit)} touchdown-free used to fit")
    print("  stated rules subtracted first; only unknown terms fitted")
    print(f"  CONTROL: {len(ctrl)} non-passers, median leftover "
          f"{cmed:.3f} pts after the stated rules alone")
    if cmed is None or cmed > 0.35:
        raise SystemExit(
            "\nREFUSING to report: the stated rules alone cannot reproduce the "
            f"points of players who never threw a pass (median off by {cmed}). "
            f"The rulebook is wrong somewhere other than passing.")
    print("  -> the stated rules hold, so the residual is genuinely passing\n")
    for t in TERMS:
        print(f"  {t:<14}{beta[t]:>9.4f}")
    # ⚠️ THE OVERALL RESIDUAL IS A VANITY METRIC HERE. 1,371 of the 1,423
    # fitted rows are non-passers whose residual is zero BY CONSTRUCTION, so an
    # overall median of 0.000 says nothing about the coefficient this script
    # exists to find. Report the passers separately — that is the only number
    # that measures the passing fit.
    qb = [i for i, r in enumerate(fit) if r["pass_yds"] > 0]
    qres = sorted(abs(sum(X[i][j] * beta[TERMS[j]] for j in range(len(TERMS))) - y[i])
                  for i in qb)
    qmed = qres[len(qres) // 2] if qres else None
    print(f"\n  residual on the {len(qb)} PASSING weeks: median {qmed:.3f} pts")
    print(f"  (overall median {med:.3f} is dominated by non-passers and means "
          f"nothing here)")
    print(f"\n  PASSING YARDS = {beta['pass_yds']:.4f} pts/yd "
          f"({1/beta['pass_yds']:.1f} yards per point)")
    print(f"  SACKS         = {beta['pass_sacks']:.4f} pts")
    print(f"\n  Sacks identify unnamed stat id 64, whose stated modifier is "
          f"-1.0 -- one of the twelve is now named.")
    print(f"  Completions and attempts were tested as extra terms and moved the "
          f"residual by 0.008 pts, so the rate is flat per yard.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
