"""
calibration_2024.py — Grade JJ's 2024 ZAP Model against actual 2024 NFL Y1 production.

Builds the empirical calibration anchor for the meta-model. For every 2024 prospect with
a JJ ZAP score, we compute their actual 2024 NFL fantasy points per game (PPR) and assess:
  - Does the ZAP score order predict realized Y1 production?
  - At each ZAP tier band, what's the realized hit rate?
  - Where did the model whiff (low ZAP / high production, or high ZAP / low production)?

Output: docs/league-context/2024_calibration_retrospective.md + a calibration JSON for
Day 2's meta-model build to consume.

Note on the Koalaty 2024 gap: his Substack archive only goes back to Dec 2025 (he
launched the paid Substack Oct 2025). We cannot grade his 2024 model on this cohort
through public sources. For 2026, both JJ + Koalaty are available.

Caveat: Y1 ppg is one season of data. JJ's ZAP target is B2S (best 2 of Y1-Y3). The
2024 cohort has only Y1 observable as of NFL season end 2024; a more rigorous calibration
re-runs after the 2025 and 2026 NFL seasons. This script's output is therefore a
*provisional* calibration that we revise as data matures.
"""
from __future__ import annotations

import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
META_DIR = ROOT / "pipelines" / "analytics" / "meta_model"
JJ_2024_CSV = META_DIR / "inputs" / "jj_zap_2024.csv"
NFL_DRAFT_CSV = META_DIR / "inputs" / "nfl_draft_picks_2024_2026.csv"
NFLV_TOTALS_CSV = ROOT / "pipelines" / "etl" / "data_cache_nflverse_season_totals_2014_2025.csv"
OUT_MD = ROOT / "docs" / "league-context" / "2024_calibration_retrospective.md"
OUT_JSON = META_DIR / "inputs" / "blend_weights_provisional.json"

# JJ's ZAP 2.0 tier bands (from 2026 PreDraft Guide, p. 25-26)
ZAP2_TIERS = [
    ("Legendary Performer", 90, 100),
    ("Elite Producer", 75, 90),
    ("Weekly Starter", 60, 75),
    ("Flex Play", 40, 60),
    ("Benchwarmer", 30, 40),
    ("Waiver Wire Add", 20, 30),
    ("Dart Throw", 0, 20),
]
# JJ's 2024 ZAP scores are on the OLD scale (ZAP 1.0). Conversion chart from
# 2026 PostDraft Guide p. 177 maps ZAP 1.0 -> ZAP 2.0 per position. We linearly
# interpolate within the published anchors.
ZAP_1_TO_2 = {
    "WR": [(50, 26), (55, 28), (60, 31), (65, 35), (70, 41), (75, 49), (80, 56),
           (85, 64), (90, 72), (95, 82), (100, 100)],
    "RB": [(50, 24), (55, 27), (60, 30), (65, 34), (70, 37), (75, 40), (80, 47),
           (85, 59), (90, 66), (95, 77), (100, 100)],
    "TE": [(50, 20), (55, 25), (60, 29), (65, 33), (70, 38), (75, 45), (80, 49),
           (85, 57), (90, 68), (95, 80), (100, 100)],
}


def convert_zap_1_to_2(score: float, position: str) -> float:
    """Linear interpolation from ZAP 1.0 to ZAP 2.0 using the published anchors."""
    anchors = ZAP_1_TO_2.get(position)
    if anchors is None:
        return score
    if score <= anchors[0][0]:
        return anchors[0][1]
    if score >= anchors[-1][0]:
        return anchors[-1][1]
    for (s1, t1), (s2, t2) in zip(anchors, anchors[1:]):
        if s1 <= score <= s2:
            frac = (score - s1) / (s2 - s1) if s2 > s1 else 0
            return round(t1 + frac * (t2 - t1), 1)
    return score


def assign_tier(zap2_score: float) -> str:
    for name, lo, hi in ZAP2_TIERS:
        if lo <= zap2_score < hi or (hi == 100 and zap2_score >= lo):
            return name
    return "Dart Throw"


def normalize_name(name: str) -> str:
    """Normalize for cross-source matching."""
    return (name.replace(",", "").replace(".", "").replace("'", "")
            .replace(" ", "").replace("-", "").replace("Jr", "")
            .replace("Sr", "").replace("II", "").replace("III", "")
            .lower().strip())


def main() -> int:
    # Load JJ 2024 ZAP scores
    with JJ_2024_CSV.open() as f:
        jj_rows = list(csv.DictReader(f))
    print(f"Loaded {len(jj_rows)} JJ 2024 prospects")

    # Load NFL draft picks 2024 — gsis_id, position, name, round, pick
    with NFL_DRAFT_CSV.open() as f:
        nfl_rows = [r for r in csv.DictReader(f) if r["season"] == "2024"]
    nfl_by_norm = {(normalize_name(r["pfr_player_name"]), r["position"]): r
                   for r in nfl_rows}
    print(f"Loaded {len(nfl_rows)} NFL 2024 draft picks (skill positions)")

    # Load 2024 NFL season totals (PPR ppg)
    with NFLV_TOTALS_CSV.open() as f:
        nflv_rows = [r for r in csv.DictReader(f) if r["season"] == "2024"]
    nflv_by_gsis = {r["player_id"]: r for r in nflv_rows}
    print(f"Loaded {len(nflv_rows)} 2024 NFL season totals")

    # Match JJ prospects -> NFL pick -> Y1 production
    cohort = []
    unmatched_to_nfl = []
    for jj in jj_rows:
        norm = normalize_name(jj["player_name"])
        pos = jj["position"]
        nfl_match = nfl_by_norm.get((norm, pos))
        # Try fuzzy: same position, last name match
        if not nfl_match:
            mfl_last = jj["player_name"].split(",")[0].strip().lower() if "," in jj["player_name"] else jj["player_name"].split()[-1].lower()
            for (nrm, p), r in nfl_by_norm.items():
                if p == pos and mfl_last.replace(" ","") in nrm:
                    nfl_match = r
                    break
        if not nfl_match:
            unmatched_to_nfl.append(jj["player_name"])
            continue

        gsis = nfl_match["gsis_id"]
        prod = nflv_by_gsis.get(gsis)
        # Y1 production
        if prod and float(prod.get("total_ppr") or 0) > 0:
            ppg = float(prod["total_ppr"]) / int(prod["games"]) if int(prod["games"]) > 0 else 0
            games = int(prod["games"])
            total = float(prod["total_ppr"])
        else:
            ppg = 0
            games = 0
            total = 0

        zap1 = float(jj["zap_score"])
        zap2 = convert_zap_1_to_2(zap1, pos)
        tier2 = assign_tier(zap2)

        cohort.append({
            "player_name": jj["player_name"],
            "position": pos,
            "zap_rank_pos": int(jj["zap_rank_pos"]),
            "zap_1_score": zap1,
            "zap_2_score": zap2,
            "zap_2_tier": tier2,
            "gsis_id": gsis,
            "nfl_pick_overall": int(nfl_match["pick"]),
            "nfl_pick_round": int(nfl_match["round"]),
            "nfl_team": nfl_match["team"],
            "y1_2024_ppg_ppr": round(ppg, 2),
            "y1_2024_games": games,
            "y1_2024_total_ppr": round(total, 1),
        })

    print(f"\nMatched: {len(cohort)} / {len(jj_rows)}")
    print(f"Unmatched to NFL draft: {len(unmatched_to_nfl)}")
    if unmatched_to_nfl:
        print(f"  e.g.: {unmatched_to_nfl[:5]}")

    # ── Tier-realized Y1 ppg analysis ────────────────────────────────────
    by_tier: dict[str, list[dict]] = defaultdict(list)
    for c in cohort:
        by_tier[c["zap_2_tier"]].append(c)

    by_tier_pos: dict[tuple, list[dict]] = defaultdict(list)
    for c in cohort:
        by_tier_pos[(c["position"], c["zap_2_tier"])].append(c)

    # Position-specific Y1 ppg "starter" thresholds (from positional_scarcity work)
    Y1_STARTER_THRESHOLDS_PPR = {"QB": 16.0, "RB": 14.0, "WR": 13.5, "TE": 11.0}

    # ── Named misses (high ZAP / low Y1 production and vice versa) ───────
    misses_high_zap_low_y1 = []  # ZAP loved them, Y1 didn't show up
    surprises_low_zap_high_y1 = []  # ZAP faded them, Y1 popped
    for c in cohort:
        thr = Y1_STARTER_THRESHOLDS_PPR.get(c["position"], 13.0)
        # High-ZAP miss: top tier (Elite Producer or Legendary Performer in ZAP 2.0)
        # but Y1 ppg < 70% of starter threshold
        if c["zap_2_tier"] in ("Legendary Performer", "Elite Producer") and c["y1_2024_ppg_ppr"] < thr * 0.7:
            misses_high_zap_low_y1.append(c)
        # Low-ZAP surprise: Benchwarmer / Waiver / Dart Throw with Y1 ppg >= starter threshold
        if c["zap_2_tier"] in ("Benchwarmer", "Waiver Wire Add", "Dart Throw") and c["y1_2024_ppg_ppr"] >= thr:
            surprises_low_zap_high_y1.append(c)

    # ── Spearman-style rank correlation per position ─────────────────────
    def spearman(xs: list[float], ys: list[float]) -> float:
        if len(xs) < 3:
            return 0.0
        n = len(xs)
        rx = sorted(range(n), key=lambda i: xs[i])
        ry = sorted(range(n), key=lambda i: ys[i])
        rank_x = [0] * n
        rank_y = [0] * n
        for r, i in enumerate(rx):
            rank_x[i] = r
        for r, i in enumerate(ry):
            rank_y[i] = r
        d2 = sum((rank_x[i] - rank_y[i]) ** 2 for i in range(n))
        return round(1 - 6 * d2 / (n * (n * n - 1)), 3)

    spearman_per_pos = {}
    for pos in ("RB", "WR", "TE"):
        rows = [c for c in cohort if c["position"] == pos]
        zaps = [c["zap_2_score"] for c in rows]
        y1s = [c["y1_2024_ppg_ppr"] for c in rows]
        spearman_per_pos[pos] = {
            "n": len(rows),
            "spearman_rank_corr": spearman(zaps, y1s),
            "median_y1_ppg": round(statistics.median(y1s) if y1s else 0, 2),
        }

    # ── Build the retrospective markdown ─────────────────────────────────
    lines: list[str] = []
    lines.append("# 2024 Calibration Retrospective — JJ Zachariason ZAP Model\n")
    lines.append(
        f"Cohort: {len(cohort)} prospects matched from JJ's 2024 PostDraft ZAP rankings "
        f"to NFL 2024 draft + Y1 NFL fantasy production. {len(unmatched_to_nfl)} prospects "
        f"in JJ's rankings did not match an NFL 2024 draft record (most are UDFAs or "
        f"Combine invites who didn't get drafted).\n"
    )
    lines.append(
        "**Note on Koalaty 2024:** his Substack went paid Oct 2025 and the archive doesn't "
        "preserve 2024 model output. JJ-only calibration on this cohort. For 2026, both "
        "JJ and Koalaty inputs will be available.\n"
    )
    lines.append(
        "**Note on Y1 vs B2S:** JJ's ZAP target is B2S (best 2 of Y1-Y3 PPR ppg). The "
        "2024 cohort has only Y1 observable as of NFL season end 2024. This calibration is "
        "*provisional* — re-run after 2025 and 2026 NFL seasons end for full B2S grading.\n"
    )

    # Spearman rank corr per position
    lines.append("\n## Rank correlation (Spearman): ZAP score vs realized Y1 PPR ppg\n")
    lines.append(
        "| Position | n | Spearman ρ | Median Y1 ppg | Read |\n"
        "|---------:|--:|-----------:|--------------:|:-----|"
    )
    for pos, stats in spearman_per_pos.items():
        rho = stats["spearman_rank_corr"]
        if rho >= 0.5: read = "Strong: ZAP rank tracked Y1 production well"
        elif rho >= 0.3: read = "Moderate: rank order partially predictive"
        elif rho >= 0.1: read = "Weak: rank order weakly predictive"
        elif rho >= -0.1: read = "Effectively random"
        else: read = "Inverse — model whiffed on rank order"
        lines.append(f"| {pos} | {stats['n']} | {rho} | {stats['median_y1_ppg']} | {read} |")

    # Tier-realized Y1 hit rate, per position
    lines.append("\n## Realized Y1 hit rate by ZAP 2.0 tier (per position)\n")
    lines.append(
        "Hit = Y1 PPR ppg ≥ position starter threshold (RB 14.0, WR 13.5, TE 11.0). "
        "These thresholds are 2024-specific Y1 cuts; B2S thresholds will differ.\n"
    )
    for pos in ("RB", "WR", "TE"):
        lines.append(f"\n### {pos}\n")
        lines.append(
            "| Tier | n | n_hits | Hit % | Mean Y1 ppg | Median Y1 ppg |\n"
            "|:-----|--:|-------:|------:|------------:|--------------:|"
        )
        thr = Y1_STARTER_THRESHOLDS_PPR[pos]
        for tier_name, _, _ in ZAP2_TIERS:
            rows = by_tier_pos.get((pos, tier_name), [])
            if not rows:
                continue
            hits = [r for r in rows if r["y1_2024_ppg_ppr"] >= thr]
            mean_ppg = statistics.mean(r["y1_2024_ppg_ppr"] for r in rows)
            med_ppg = statistics.median(r["y1_2024_ppg_ppr"] for r in rows)
            hit_pct = len(hits) / len(rows) * 100
            lines.append(
                f"| {tier_name} | {len(rows)} | {len(hits)} | {hit_pct:.1f}% | "
                f"{mean_ppg:.2f} | {med_ppg:.2f} |"
            )

    # Named misses
    lines.append("\n## High-ZAP / Low-Y1 (model loved, Y1 didn't show)\n")
    if misses_high_zap_low_y1:
        lines.append(
            "| Position | Player | NFL Pick | ZAP 1.0 | ZAP 2.0 | Tier | Y1 ppg | Y1 games | Note |\n"
            "|:---------|:-------|:--------:|--------:|--------:|:-----|-------:|---------:|:-----|"
        )
        for c in sorted(misses_high_zap_low_y1, key=lambda x: -x["zap_2_score"]):
            note = ("zero Y1 prod (injury/redshirt)" if c["y1_2024_games"] == 0
                    else f"role/usage limited" if c["y1_2024_ppg_ppr"] > 0
                    else "")
            lines.append(
                f"| {c['position']} | {c['player_name']} | "
                f"R{c['nfl_pick_round']}.{c['nfl_pick_overall']} | "
                f"{c['zap_1_score']} | {c['zap_2_score']} | {c['zap_2_tier']} | "
                f"{c['y1_2024_ppg_ppr']} | {c['y1_2024_games']} | {note} |"
            )
    else:
        lines.append("(none — no top-tier ZAP prospects whiffed on Y1)\n")

    lines.append("\n## Low-ZAP / High-Y1 (model faded, Y1 popped)\n")
    if surprises_low_zap_high_y1:
        lines.append(
            "| Position | Player | NFL Pick | ZAP 1.0 | ZAP 2.0 | Tier | Y1 ppg | Y1 games |\n"
            "|:---------|:-------|:--------:|--------:|--------:|:-----|-------:|---------:|"
        )
        for c in sorted(surprises_low_zap_high_y1, key=lambda x: -x["y1_2024_ppg_ppr"]):
            lines.append(
                f"| {c['position']} | {c['player_name']} | "
                f"R{c['nfl_pick_round']}.{c['nfl_pick_overall']} | "
                f"{c['zap_1_score']} | {c['zap_2_score']} | {c['zap_2_tier']} | "
                f"{c['y1_2024_ppg_ppr']} | {c['y1_2024_games']} |"
            )
    else:
        lines.append("(none — no fade-tier ZAP prospects produced Y1 starter-level)\n")

    # Full cohort table for reference
    lines.append("\n## Full 2024 cohort table (for reference)\n")
    lines.append(
        "| Pos | Player | NFL Pick | ZAP 1.0 | ZAP 2.0 | Tier | Y1 ppg | Y1 games |\n"
        "|:----|:-------|:---------|--------:|--------:|:-----|-------:|---------:|"
    )
    for c in sorted(cohort, key=lambda x: (x["position"], -x["zap_2_score"])):
        lines.append(
            f"| {c['position']} | {c['player_name']} | "
            f"R{c['nfl_pick_round']}.{c['nfl_pick_overall']} ({c['nfl_team']}) | "
            f"{c['zap_1_score']} | {c['zap_2_score']} | {c['zap_2_tier']} | "
            f"{c['y1_2024_ppg_ppr']} | {c['y1_2024_games']} |"
        )

    # Provisional blend weights for Day 2
    lines.append("\n## Provisional blend weights for Day 2 meta-model\n")
    lines.append(
        "Given Koalaty 2024 isn't accessible, we cannot fit the JJ vs Koalaty blend "
        "empirically on this cohort. Default for Day 2: **50/50 weighting** with these "
        "caveats:\n"
        "- Position-specific calibration deferred until both analysts have a graded cohort.\n"
        "- Re-fit after Koalaty's 2026 post-draft model and 2026 NFL Y1 outcomes are observable.\n"
        "- Use Spearman ρ from this table as the JJ-side validation: ZAP 2.0 rank should "
        "track Y1 outcomes at meaningful ρ. If ρ < 0.3, weight JJ down for that position.\n"
    )

    # Write outputs
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines))
    print(f"\nwrote {OUT_MD.relative_to(ROOT)}")

    # Provisional weights JSON
    weights = {
        "version": 1,
        "as_of": "2026-04-29",
        "method": "JJ-only 2024 calibration; Koalaty 2024 unavailable",
        "default_blend": {"jj": 0.5, "koalaty": 0.5},
        "spearman_2024_jj": spearman_per_pos,
        "notes": "Re-fit when 2026 cohort data and Koalaty 2026 model are both observable.",
    }
    OUT_JSON.write_text(json.dumps(weights, indent=2))
    print(f"wrote {OUT_JSON.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
