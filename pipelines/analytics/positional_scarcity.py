"""
positional_scarcity.py — Phase D of the Rookie Draft Hit Rate Analysis.

Computes positional value-over-replacement (VOR) for RB / WR / TE / QB using
season-total fantasy points, and writes a markdown memo summarizing the spread.

Source: site/reports/player_scoring/player_scoring_<season>.json
  (one row per player-season with {position, total_points, points_per_game, ...}).

Replacement tiers reflect UPS lineup demand:
  - 1QB starter × 12 teams + SF (effectively 2 starting QBs / team) → top-24
  - 2RB starters × 12 teams                                         → top-24
  - 2WR starters + 1 flex × 12 teams                                → top-36
  - 1TE starter × 12 teams (TE Premium 2025+)                       → top-12

VOR per position = avg(top-N) − avg(replacement_tier).
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCORING_DIR = ROOT / "site" / "reports" / "player_scoring"
OUT_MEMO = ROOT / "docs" / "league-context" / "positional_scarcity_2026.md"

# Lineup-derived starter counts (per UPS rules + 12-team league)
TIERS = {
    "QB": (24, 25, 36),   # SF: 2 starting QB × 12 teams
    "RB": (24, 25, 48),   # 2 RB × 12 teams = 24 starters
    "WR": (36, 37, 60),   # 2 WR + 1 flex × 12 teams
    "TE": (12, 13, 24),   # 1 TE × 12 teams; TE Premium scoring
}

SEASONS = [2024, 2025]


def load_season(year: int) -> list[dict]:
    path = SCORING_DIR / f"player_scoring_{year}.json"
    if not path.exists():
        return []
    with path.open() as f:
        d = json.load(f)
    return d["players"]


def vor_for_position(rows: list[dict], position: str, season: int) -> dict | None:
    starter_n, repl_lo, repl_hi = TIERS[position]
    pos_rows = [r for r in rows if r.get("position") == position and (r.get("total_points") or 0) > 0]
    pos_rows.sort(key=lambda r: -float(r.get("total_points") or 0))
    if len(pos_rows) < repl_hi:
        return None
    starters = pos_rows[:starter_n]
    replacements = pos_rows[repl_lo - 1:repl_hi]
    starter_avg = statistics.mean(float(r["total_points"]) for r in starters)
    repl_avg = statistics.mean(float(r["total_points"]) for r in replacements)
    return {
        "season": season,
        "position": position,
        "n_pool": len(pos_rows),
        "starter_tier": f"top-{starter_n}",
        "starter_avg": round(starter_avg, 1),
        "starter_top_player": f"{pos_rows[0]['player_name']} ({pos_rows[0]['total_points']})",
        "starter_bottom_player": f"{pos_rows[starter_n - 1]['player_name']} ({pos_rows[starter_n - 1]['total_points']})",
        "replacement_tier": f"{repl_lo}-{repl_hi}",
        "replacement_avg": round(repl_avg, 1),
        "spread": round(starter_avg - repl_avg, 1),
        "spread_pct": round((starter_avg - repl_avg) / repl_avg * 100, 1) if repl_avg else None,
    }


def main() -> int:
    by_pos: dict[str, list[dict]] = {p: [] for p in TIERS}
    for season in SEASONS:
        rows = load_season(season)
        for pos in TIERS:
            v = vor_for_position(rows, pos, season)
            if v:
                by_pos[pos].append(v)

    lines: list[str] = []
    lines.append("# Positional Scarcity & VOR — UPS 2026 Bid Sheet Input\n")
    lines.append(
        "Cohort: 2024 + 2025 NFL seasons (the SF / SF + TE Premium era; the only era "
        "that matches the 2026 lineup demand). Source: "
        "`site/reports/player_scoring/player_scoring_<season>.json`.\n"
    )
    lines.append(
        "VOR per position = avg(top-N starter tier) − avg(replacement tier). "
        "Larger spread = more scarcity = higher per-pick valuation premium for that position.\n"
    )

    lines.append("\n## Per-position VOR\n")
    for pos in ("RB", "WR", "TE", "QB"):
        rows = by_pos[pos]
        if not rows:
            continue
        starter_label = rows[0]["starter_tier"]
        repl_label = rows[0]["replacement_tier"]
        lines.append(f"### {pos} — starter `{starter_label}` vs replacement `{repl_label}`\n")
        lines.append(
            "| Season | Pool | Starter avg | Replacement avg | Spread | Spread % |\n"
            "|-------:|-----:|------------:|----------------:|-------:|---------:|"
        )
        for r in rows:
            lines.append(
                f"| {r['season']} | {r['n_pool']} | {r['starter_avg']} | {r['replacement_avg']} | "
                f"{r['spread']} | {r['spread_pct']}% |"
            )
        avg_spread = round(statistics.mean(r["spread"] for r in rows), 1)
        avg_spread_pct = round(statistics.mean(r["spread_pct"] for r in rows), 1)
        lines.append(f"| **avg** | — | — | — | **{avg_spread}** | **{avg_spread_pct}%** |\n")

    # Cross-position spread comparison: which position has the steepest dropoff?
    lines.append("\n## Cross-position spread (sorted desc)\n")
    lines.append(
        "| Position | Avg spread | Avg spread % | Implication |\n"
        "|---------:|-----------:|-------------:|:------------|"
    )
    flat = []
    for pos in TIERS:
        rows = by_pos[pos]
        if not rows:
            continue
        flat.append({
            "pos": pos,
            "spread": round(statistics.mean(r["spread"] for r in rows), 1),
            "spread_pct": round(statistics.mean(r["spread_pct"] for r in rows), 1),
        })
    flat.sort(key=lambda r: -r["spread_pct"])
    for r in flat:
        impl = {
            "RB": "Big drop-off after the starter tier — RB scarcity is real, premium justified",
            "WR": "Deeper pool — WR replacement is closer to starter tier, smaller premium",
            "TE": "TE Premium era only; check if the spread persists past 2025",
            "QB": "SF era — 2 starters/team makes QB depth thinner than in 1QB days",
        }.get(r["pos"], "")
        lines.append(f"| {r['pos']} | {r['spread']} | {r['spread_pct']}% | {impl} |")

    lines.append("\n## What this means for the 2026 bid sheet & rookie draft\n")
    lines.append(
        "1. **Compare the spread % column across positions.** The position with the "
        "highest spread % is the one where missing on a starter is most punishing — that "
        "position deserves a VOR premium in the bid sheet's value formula.\n"
        "2. **At equal hit rates, prefer the higher-spread position.** "
        "`E[value] = P(hit) × starter_avg + (1 − P(hit)) × replacement_avg`. The "
        "starter-vs-replacement gap directly multiplies the value of a hit.\n"
        "3. **Two-season sample is small.** Re-run after the 2026 season to add a third "
        "data point; 2018–2023 data lives behind the legacy `mfl_database.db` which "
        "wasn't queried here. If we want longer trend lines, the next step is to "
        "regenerate `site/reports/player_scoring/player_scoring_<year>.json` for 2018–2023.\n"
    )

    lines.append("\n## Caveats\n")
    lines.append(
        "- 2024 and 2025 only — TE Premium scoring kicked in for 2025, so the TE numbers "
        "shown blend 1 year of pre-Premium with 1 year of Premium. The 2025-only TE "
        "spread is the cleaner forward-looking input.\n"
        "- Replacement tiers assume the listed starter counts. If lineup rules change for "
        "2026 (extra flex, etc.), `TIERS` in this script needs an update.\n"
        "- Ranks are computed within position from total_points alone — not VAM-weighted. "
        "If we want VAM-weighted rankings (which already exist in `player_scoring_<year>.json` "
        "as the `vam` and `dominance_total_vam` fields), it's a one-line swap.\n"
    )

    OUT_MEMO.parent.mkdir(parents=True, exist_ok=True)
    OUT_MEMO.write_text("\n".join(lines))
    print(f"wrote {OUT_MEMO.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
