#!/usr/bin/env python3
"""Persist DERIVED scoring coefficients into fantasy_scoring_rules.

⚠️ THESE ARE ESTIMATES, NOT THE LEAGUE'S STATED RULES. They are recovered by
least-squares from per-player stats and the fantasy points those stats produced.
They must never be confusable with the rulebook scraped from /rules/scoring, so:

  * stat_id is namespaced  "fit:<POS>:<Group>.<Stat>"  — the scraped rules use
    "<POS>:<Abbr>", so the two can coexist for the SAME season without ever
    colliding on the primary key or being mistaken for each other.
  * is_display_only = 1        -> not an authoritative scoring input
  * raw_stat_json carries method, r2, n, top-of-list coverage and source URL,
    so any consumer can judge the fit instead of trusting the number.

⚠️ WHY A DERIVED VALUE DIFFERS FROM THE RULEBOOK BASE, LEGITIMATELY. This
league stacks distance bonuses on touchdowns ("12 points, plus 2 more for a
40-69 yard TD"), and the stats table has no per-TD yardage column. The fit
therefore absorbs the bonuses and returns the EFFECTIVE average points a
touchdown actually paid that season — which is why QB passing TD solves near
4.2-5.3 against a stated base of 4. That drift is the play-distance mix
changing, NOT evidence the league edited its rules.

Only fits actually obtained are written. Position-seasons whose extraction did
not complete are simply absent — an absent row is honest; a guessed one is not.
"""
from __future__ import annotations

import argparse, sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))
from fantasy import d1 as fd1                              # noqa: E402
from fantasy.providers.cbs.constants import PLATFORM, league_key  # noqa: E402

SOURCE = "https://grffl.football.cbssports.com/stats/stats-main/all:{pos}/{season}"

#: (season, position) -> {feature: coefficient}, plus fit diagnostics.
#: Captured 2026-08-23. Every entry passed BOTH guards: top-of-list coverage
#: 100% and all coefficients inside the plausibility bounds.
FITS = {
 (2022,"QB"): (0.9990, 100, {"Passing.Yds":0.049,"Passing.TD":5.270,"Passing.Int":-2.241,
                             "Rushing.Yds":0.132,"Rushing.TD":13.127,"Fumbles.Lost":-2.945}),
 (2022,"RB"): (0.9982, 100, {"Rushing.Yds":0.133,"Rushing.TD":6.735,"Receiving.Rec":0.953,
                             "Receiving.Yds":0.149,"Receiving.TD":12.932,"Fumbles.Lost":-2.752}),
 (2022,"WR"): (0.9971, 100, {"Rushing.Yds":0.083,"Rushing.TD":15.780,"Receiving.Rec":1.029,
                             "Receiving.Yds":0.134,"Receiving.TD":7.093,"Fumbles.Lost":-2.998}),
 (2022,"TE"): (0.9994, 100, {"Rushing.Yds":0.076,"Rushing.TD":10.766,"Receiving.Rec":1.428,
                             "Receiving.Yds":0.119,"Receiving.TD":6.667,"Fumbles.Lost":-1.715}),
 (2023,"QB"): (0.9991, 100, {"Passing.Yds":0.061,"Passing.TD":4.421,"Passing.Int":-2.113,
                             "Rushing.Yds":0.095,"Rushing.TD":12.852,"Fumbles.Lost":-1.659}),
 (2023,"RB"): (0.9983, 100, {"Rushing.Yds":0.129,"Rushing.TD":6.339,"Receiving.Rec":0.574,
                             "Receiving.Yds":0.128,"Receiving.TD":13.267,"Fumbles.Lost":-3.749}),
 (2024,"QB"): (0.9989, 100, {"Passing.Yds":0.050,"Passing.TD":5.238,"Passing.Int":-1.659,
                             "Rushing.Yds":0.112,"Rushing.TD":12.878,"Fumbles.Lost":-2.010}),
 (2024,"RB"): (0.9985, 100, {"Rushing.Yds":0.141,"Rushing.TD":6.582,"Receiving.Rec":0.150,
                             "Receiving.Yds":0.107,"Receiving.TD":13.616,"Fumbles.Lost":-3.298}),
 (2024,"WR"): (0.9968, 100, {"Rushing.Yds":0.105,"Rushing.TD":10.900,"Receiving.Rec":0.940,
                             "Receiving.Yds":0.135,"Receiving.TD":6.720,"Fumbles.Lost":-1.916}),
 (2024,"TE"): (0.9996, 100, {"Rushing.Yds":0.078,"Rushing.TD":14.786,"Receiving.Rec":1.506,
                             "Receiving.Yds":0.115,"Receiving.TD":6.083,"Fumbles.Lost":-2.292}),
 (2025,"QB"): (0.9988, 100, {"Passing.Yds":0.051,"Passing.TD":4.242,"Passing.Int":-2.386,
                             "Rushing.Yds":0.121,"Rushing.TD":12.150,"Fumbles.Lost":-2.675}),
 (2025,"RB"): (0.9983, 100, {"Rushing.Yds":0.140,"Rushing.TD":5.884,"Receiving.Rec":1.045,
                             "Receiving.Yds":0.147,"Receiving.TD":13.728,"Fumbles.Lost":-1.287}),
}

#: Coefficients whose single-season fit is UNSTABLE and must not be quoted as a
#: rule. Targets and receptions are near-collinear, so RB reception swings
#: 0.95 -> 0.57 -> 0.15 -> 1.05 across seasons while the league's PPR setting
#: never changed. Flagged in-row rather than dropped, so the data stays complete
#: and the caveat travels with it.
LOW_CONFIDENCE = {(2023,"RB","Receiving.Rec"), (2024,"RB","Receiving.Rec"),
                  (2022,"WR","Rushing.TD"), (2024,"TE","Rushing.TD")}


def rows(league_id: str, run_id: str) -> list[dict]:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = []
    for (season, pos), (r2, n, coefs) in sorted(FITS.items()):
        for i, (feat, val) in enumerate(sorted(coefs.items())):
            group, stat = feat.split(".", 1)
            low = (season, pos, feat) in LOW_CONFIDENCE
            out.append({
                "platform": PLATFORM,
                "league_key": league_key(season, league_id),
                "season": season,
                "stat_id": f"fit:{pos}:{feat}",
                "stat_name": f"{stat} ({group}) — derived",
                "stat_display_name": f"{stat} ({group})",
                "stat_abbr": stat,
                "stat_group": group,
                "position_type": pos,
                "applies_to_positions": pos,
                "modifier": val,
                "is_enabled": 1,
                # ⚠️ NOT an authoritative scoring input — an estimate of one.
                "is_display_only": 1,
                "sort_order": i,
                "raw_stat_json": {
                    "method": "least_squares_on_season_stats",
                    "r2": r2, "n_players": n, "top_coverage": 1.0,
                    "effective_not_base": True,
                    "note": ("EFFECTIVE points actually paid, which for touchdowns "
                             "INCLUDES this league's stacked distance bonuses; the "
                             "stated rulebook base will be lower."),
                    "low_confidence": low,
                    "low_confidence_reason": (
                        "near-collinear predictors in a single-season fit; do not "
                        "quote as a rule") if low else None,
                    "source_url": SOURCE.format(pos=pos, season=season),
                },
                "source_run_id": run_id,
                "updated_at_utc": now,
            })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-id", default="grffl")
    ap.add_argument("--target", choices=["local", "remote"], default="local")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    run_id = f"cbs-fit-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}"
    r = rows(a.league_id, run_id)
    seasons = sorted({x["season"] for x in r})
    print(f"{len(r)} derived coefficients over {len(FITS)} position-seasons "
          f"(seasons {seasons[0]}-{seasons[-1]})")
    missing = [(s, p) for s in seasons for p in ("QB", "RB", "WR", "TE")
               if (s, p) not in FITS]
    if missing:
        print(f"⚠️ NOT captured, therefore NOT written: "
              f"{', '.join(f'{p} {s}' for s, p in missing)}")
    if a.dry_run:
        print("dry-run: nothing written")
        return 0
    loader = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    n = loader.write_rows("fantasy_scoring_rules", r)
    print(f"wrote {n} rows to fantasy_scoring_rules -> {a.target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
