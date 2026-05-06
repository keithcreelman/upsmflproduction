"""
rookie_hit_rate_build.py — Phases A + B + C of the Rookie Draft Hit Rate Analysis.

Reads:
  - site/rookies/rookie_draft_history.json  (cohort + production tier)
  - pipelines/reports/contract_history_{RB,WR,TE,QB}.csv  (extension events)

Writes:
  - site/rookies/rookie_cohort_outcomes.csv     (one row per UPS rookie pick)
  - site/rookies/rookie_hit_rate_matrix.json    (position × round matrix, both signals)
  - site/rookies/_unmatched_rookies.csv         (debug: players not in contract_history)
  - docs/league-context/extension_rate_tables.md  (RB vs WR extension comparison)

Cohort coverage:
  - production_hit signal: 2012–2022 rookies (uses tier from rookie_draft_history.json).
  - extension_worthy signal: 2014–2022 rookies (contract_history covers 2017+, so we
    need rookie_year >= 2014 to see at least the Y4 snapshot where an extension would
    take effect). Earlier cohorts are reported in the matrix only for the production signal.

Hit definitions:
  - production_hit = tier in {Smash, Hit}  (existing field on rookie_draft_history)
  - extension_worthy = ANY(extension_flag = 1) for snapshots in
    seasons [rookie_year, rookie_year + 4] for that player_id.
    NOTE: mym_flag and drop_in_season_flag in the source CSVs are unpopulated as of
    2026-04-28 (all zeros). Only extension_flag is usable today. MYM data exists at
    site/ccc/mym_submissions.json but only covers 2025 — not enough to backfill.
"""

from __future__ import annotations

import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROOKIE_HISTORY = ROOT / "site" / "rookies" / "rookie_draft_history.json"
CONTRACT_DIR = ROOT / "pipelines" / "reports"
OUT_COHORT_CSV = ROOT / "site" / "rookies" / "rookie_cohort_outcomes.csv"
OUT_MATRIX_JSON = ROOT / "site" / "rookies" / "rookie_hit_rate_matrix.json"
OUT_UNMATCHED_CSV = ROOT / "site" / "rookies" / "_unmatched_rookies.csv"
OUT_EXT_TABLES = ROOT / "docs" / "league-context" / "extension_rate_tables.md"

COHORT_MIN_YEAR = 2012
COHORT_MAX_YEAR = 2022  # last cohort with full Y3 data (Y3 = 2024 visible)
EXT_OBSERVABLE_MIN_YEAR = 2014  # first cohort with extension snapshot in contract_history
EXT_WINDOW = 4  # search seasons [rookie_year, rookie_year + EXT_WINDOW]

# Era boundaries (per scoring_history_eras.md memory)
def era_for(season: int) -> str:
    if season >= 2025:
        return "sf_te_prem"
    if season >= 2022:
        return "sf"
    return "pre_sf"


def wilson_ci(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson 95% CI for a binomial proportion. Returns (low, high)."""
    if n == 0:
        return (0.0, 0.0)
    p = hits / n
    denom = 1 + z**2 / n
    center = (p + z**2 / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z**2 / (4 * n**2))) / denom
    return (round(max(0.0, center - half), 4), round(min(1.0, center + half), 4))


def two_proportion_z(h1: int, n1: int, h2: int, n2: int) -> tuple[float, float]:
    """Two-proportion z-test. Returns (z, two-sided p)."""
    if n1 == 0 or n2 == 0:
        return (0.0, 1.0)
    p1, p2 = h1 / n1, h2 / n2
    p_pool = (h1 + h2) / (n1 + n2)
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n1 + 1 / n2))
    if se == 0:
        return (0.0, 1.0)
    z = (p1 - p2) / se
    # two-sided p via erfc
    p = math.erfc(abs(z) / math.sqrt(2))
    return (round(z, 3), round(p, 4))


def load_extension_index() -> dict[str, list[tuple[int, int]]]:
    """player_id -> list of (season, extension_flag) snapshots, all positions pooled."""
    idx: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for pos in ("QB", "RB", "WR", "TE"):
        path = CONTRACT_DIR / f"contract_history_{pos}.csv"
        if not path.exists():
            print(f"WARN: {path} not found, skipping", file=sys.stderr)
            continue
        with path.open() as f:
            for row in csv.DictReader(f):
                pid = row["player_id"]
                if not pid:
                    continue
                try:
                    season = int(row["season"])
                except (ValueError, TypeError):
                    continue
                ext = 1 if row.get("extension_flag") == "1" else 0
                idx[pid].append((season, ext))
    return idx


def main() -> int:
    with ROOKIE_HISTORY.open() as f:
        history = json.load(f)
    picks = history["picks"]

    ext_index = load_extension_index()

    cohort_rows: list[dict] = []
    unmatched: list[dict] = []

    for pick in picks:
        season = pick["season"]
        if season < COHORT_MIN_YEAR or season > COHORT_MAX_YEAR:
            continue
        pid = str(pick["player_id"])
        position = pick["position"]
        tier = pick.get("tier") or ""
        production_hit = 1 if tier in ("Smash", "Hit") else 0

        snapshots = ext_index.get(pid, [])
        in_window = [
            (s, ef) for (s, ef) in snapshots if season <= s <= season + EXT_WINDOW
        ]
        ext_observable = season >= EXT_OBSERVABLE_MIN_YEAR
        in_contract_history = bool(snapshots)

        if ext_observable and in_window:
            extension_worthy = 1 if any(ef == 1 for (_, ef) in in_window) else 0
            extension_status = "observed"
        elif ext_observable and not in_window:
            # rookie_year >= 2014 but no snapshot in window — never made roster
            extension_worthy = 0
            extension_status = "no_snapshot_in_window"
        else:
            extension_worthy = None
            extension_status = "out_of_observation_window"

        if not in_contract_history and ext_observable:
            unmatched.append({
                "season": season,
                "player_id": pid,
                "player_name": pick["player_name"],
                "position": position,
                "round": pick["round"],
                "slot": pick["slot"],
                "franchise_id": pick["franchise_id"],
            })

        cohort_rows.append({
            "season": season,
            "era": era_for(season),
            "round": pick["round"],
            "slot": pick["slot"],
            "pick_label": pick["pick_label"],
            "franchise_id": pick["franchise_id"],
            "owner_name": pick["owner_name"],
            "player_id": pid,
            "player_name": pick["player_name"],
            "position": position,
            "pos_subgroup": pick["pos_subgroup"],
            "pos_group": pick["pos_group"],
            "salary": pick["salary"],
            "tier": tier,
            "production_hit": production_hit,
            "extension_worthy": "" if extension_worthy is None else extension_worthy,
            "extension_status": extension_status,
            "ext_seasons_observed": ";".join(
                f"{s}:{ef}" for (s, ef) in sorted(in_window)
            ),
            "points_3yr_total": pick.get("points_3yr_total"),
            "ep_rate_3yr_avg": pick.get("ep_rate_3yr_avg"),
            "dud_rate_3yr_avg": pick.get("dud_rate_3yr_avg"),
            "value_above_expected": pick.get("value_above_expected"),
            "pos_rank_total_3yr": pick.get("pos_rank_total_3yr"),
        })

    # Write cohort CSV
    OUT_COHORT_CSV.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(cohort_rows[0].keys()) if cohort_rows else []
    with OUT_COHORT_CSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(cohort_rows)
    print(f"wrote {OUT_COHORT_CSV.relative_to(ROOT)}: {len(cohort_rows)} rows")

    # Write unmatched
    if unmatched:
        with OUT_UNMATCHED_CSV.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(unmatched[0].keys()))
            w.writeheader()
            w.writerows(unmatched)
        print(f"wrote {OUT_UNMATCHED_CSV.relative_to(ROOT)}: {len(unmatched)} unmatched rookies")

    # ── Phase B: Hit-rate matrix ─────────────────────────────────────────
    # Group by (position, round) and (position, round, era) for the secondary cut.
    # Skip cells with n < 5.
    matrix: dict = {"meta": {
        "cohort": f"{COHORT_MIN_YEAR}-{COHORT_MAX_YEAR}",
        "ext_observable_from": EXT_OBSERVABLE_MIN_YEAR,
        "ext_window_seasons": EXT_WINDOW,
        "total_picks": len(cohort_rows),
        "min_cell_n": 5,
        "definitions": {
            "production_hit": "tier in {Smash, Hit} per build_rookie_draft_hub.py classify_tier",
            "extension_worthy": "any extension_flag=1 in seasons [rookie_year, rookie_year+4] for that player_id",
        },
    }, "by_position_round": {}, "by_position_round_era": {}}

    OFFENSE_POSITIONS = ("QB", "RB", "WR", "TE")

    def cell_summary(rows: list[dict]) -> dict:
        n_total = len(rows)
        prod_hits = sum(r["production_hit"] for r in rows)
        prod_lo, prod_hi = wilson_ci(prod_hits, n_total)
        ext_rows = [r for r in rows if r["extension_worthy"] != ""]
        ext_n = len(ext_rows)
        ext_hits = sum(int(r["extension_worthy"]) for r in ext_rows)
        ext_lo, ext_hi = wilson_ci(ext_hits, ext_n)
        return {
            "n": n_total,
            "production": {
                "hits": prod_hits,
                "rate": round(prod_hits / n_total, 4) if n_total else None,
                "wilson_lo": prod_lo,
                "wilson_hi": prod_hi,
            },
            "extension_worthy": {
                "n_observable": ext_n,
                "hits": ext_hits,
                "rate": round(ext_hits / ext_n, 4) if ext_n else None,
                "wilson_lo": ext_lo,
                "wilson_hi": ext_hi,
            },
        }

    by_pr: dict[tuple, list] = defaultdict(list)
    by_pre: dict[tuple, list] = defaultdict(list)
    for row in cohort_rows:
        pos = row["position"] if row["position"] in OFFENSE_POSITIONS else "DEF"
        by_pr[(pos, row["round"])].append(row)
        by_pre[(pos, row["round"], row["era"])].append(row)

    for (pos, rd), rows in sorted(by_pr.items()):
        if len(rows) < 5:
            continue
        matrix["by_position_round"].setdefault(pos, {})[str(rd)] = cell_summary(rows)
    for (pos, rd, era), rows in sorted(by_pre.items()):
        if len(rows) < 5:
            continue
        matrix["by_position_round_era"].setdefault(pos, {}).setdefault(str(rd), {})[era] = cell_summary(rows)

    with OUT_MATRIX_JSON.open("w") as f:
        json.dump(matrix, f, indent=2)
    print(f"wrote {OUT_MATRIX_JSON.relative_to(ROOT)}")

    # ── Phase C: Extension-rate analysis (RB vs WR by round) ────────────
    lines: list[str] = []
    lines.append("# Extension Rate by Position × Round (UPS Rookie Draft, 2014-2022 cohort)\n")
    lines.append(
        f"Cohort: rookies drafted {EXT_OBSERVABLE_MIN_YEAR}–{COHORT_MAX_YEAR} "
        f"({COHORT_MAX_YEAR - EXT_OBSERVABLE_MIN_YEAR + 1} seasons). "
        f"`extension_worthy` = any `extension_flag=1` in contract_history snapshots "
        f"in the season window [rookie_year, rookie_year+{EXT_WINDOW}].\n"
    )
    lines.append("\n## RB vs WR (production hit + extension_worthy)\n")
    lines.append(
        "| Round | RB n | RB prod_hit% | RB ext% | WR n | WR prod_hit% | WR ext% | "
        "Δ ext (RB−WR) | p (two-prop) |\n"
        "|------:|-----:|-------------:|--------:|-----:|-------------:|--------:|"
        "--------------:|-------------:|"
    )

    def collect(pos: str, rd: int):
        rows = [r for r in cohort_rows
                if r["position"] == pos and r["round"] == rd
                and r["season"] >= EXT_OBSERVABLE_MIN_YEAR]
        n = len(rows)
        prod = sum(r["production_hit"] for r in rows)
        ext_rows = [r for r in rows if r["extension_worthy"] != ""]
        ext_n = len(ext_rows)
        ext_hits = sum(int(r["extension_worthy"]) for r in ext_rows)
        return n, prod, ext_n, ext_hits

    for rd in range(1, 7):
        rb_n, rb_prod, rb_ext_n, rb_ext = collect("RB", rd)
        wr_n, wr_prod, wr_ext_n, wr_ext = collect("WR", rd)
        if rb_ext_n < 5 and wr_ext_n < 5:
            continue
        rb_prod_pct = f"{rb_prod / rb_n * 100:.1f}%" if rb_n else "—"
        rb_ext_pct = f"{rb_ext / rb_ext_n * 100:.1f}%" if rb_ext_n else "—"
        wr_prod_pct = f"{wr_prod / wr_n * 100:.1f}%" if wr_n else "—"
        wr_ext_pct = f"{wr_ext / wr_ext_n * 100:.1f}%" if wr_ext_n else "—"
        if rb_ext_n and wr_ext_n:
            delta = rb_ext / rb_ext_n - wr_ext / wr_ext_n
            _, p = two_proportion_z(rb_ext, rb_ext_n, wr_ext, wr_ext_n)
            delta_str = f"{delta * 100:+.1f}pp"
            p_str = f"{p:.3f}"
        else:
            delta_str, p_str = "—", "—"
        lines.append(
            f"| R{rd} | {rb_n} | {rb_prod_pct} | {rb_ext_pct} | "
            f"{wr_n} | {wr_prod_pct} | {wr_ext_pct} | {delta_str} | {p_str} |"
        )

    lines.append("\n## TE and QB (smaller samples; reference only)\n")
    lines.append(
        "| Position | Round | n | prod_hit% | ext_n | ext% |\n"
        "|---------:|------:|--:|----------:|------:|-----:|"
    )
    for pos in ("TE", "QB"):
        for rd in range(1, 7):
            n, prod, ext_n, ext_hits = collect(pos, rd)
            if n < 5:
                continue
            prod_pct = f"{prod / n * 100:.1f}%"
            ext_pct = f"{ext_hits / ext_n * 100:.1f}%" if ext_n else "—"
            lines.append(f"| {pos} | R{rd} | {n} | {prod_pct} | {ext_n} | {ext_pct} |")

    lines.append("\n## Pooled by position (all rounds R1-R3)\n")
    lines.append(
        "| Position | n | prod_hit% | ext_n | ext% |\n"
        "|---------:|--:|----------:|------:|-----:|"
    )
    for pos in ("QB", "RB", "WR", "TE"):
        rows = [r for r in cohort_rows
                if r["position"] == pos and r["round"] <= 3
                and r["season"] >= EXT_OBSERVABLE_MIN_YEAR]
        n = len(rows)
        if n < 5:
            continue
        prod = sum(r["production_hit"] for r in rows)
        ext_rows = [r for r in rows if r["extension_worthy"] != ""]
        ext_n = len(ext_rows)
        ext_hits = sum(int(r["extension_worthy"]) for r in ext_rows)
        prod_pct = f"{prod / n * 100:.1f}%"
        ext_pct = f"{ext_hits / ext_n * 100:.1f}%" if ext_n else "—"
        lines.append(f"| {pos} | {n} | {prod_pct} | {ext_n} | {ext_pct} |")

    lines.append("\n## Caveats\n")
    lines.append(
        "- `mym_flag`, `cap_penalty_flag`, and `drop_in_season_flag` in "
        "`pipelines/reports/contract_history_*.csv` are all unpopulated as of 2026-04-28. "
        "Once populated, the `extension_worthy` definition should expand to include "
        "significant MYM raises.\n"
        "- The 2022 cohort's extension window extends through 2026, but only 2017–2025 "
        "snapshots exist; a 2022 rookie extended in 2026 wouldn't appear yet. Effect on "
        "the headline rates is small (most extensions land at Y3 = 2024 or earlier).\n"
        "- Production_hit and extension_worthy are partially correlated by definition "
        "(productive players are more likely to be extended) but not redundant — see the "
        "matrix JSON for the joint distribution.\n"
    )

    OUT_EXT_TABLES.parent.mkdir(parents=True, exist_ok=True)
    OUT_EXT_TABLES.write_text("\n".join(lines))
    print(f"wrote {OUT_EXT_TABLES.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
