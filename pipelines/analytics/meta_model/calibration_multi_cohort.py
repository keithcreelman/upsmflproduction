"""
calibration_multi_cohort.py — Grade JJ's ZAP across 2022 and 2024 cohorts on B2S.

Better than the Y1-only calibration: this script computes JJ's ACTUAL target
(B2S = best 2 of first 3 NFL seasons in PPR ppg) for each cohort where data
is available.

Coverage:
  - **2022 cohort**: Y1-Y3 = 2022-2024, all observable. Full B2S grading.
  - **2024 cohort**: Y1-Y2 = 2024-2025, partial. Best-of-Y1-Y2 as proxy for B2S.

JJ's 2022 model was the "Z-Prospect Model" (V1), 2024 was "ZAP 1.0", 2026 is
"ZAP 2.0". The model evolved meaningfully across these versions but the target
metric (B2S) and the validation hurdle (beat draft capital) are constant.

Output: docs/league-context/calibration_multi_cohort.md + blend_weights JSON.
"""
from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
META_DIR = ROOT / "pipelines" / "analytics" / "meta_model"
NFL_DRAFT_CSV = META_DIR / "inputs" / "nfl_draft_picks_2024_2026.csv"
NFLV_TOTALS_CSV = ROOT / "pipelines" / "etl" / "data_cache_nflverse_season_totals_2014_2025.csv"
OUT_MD = ROOT / "docs" / "league-context" / "calibration_multi_cohort.md"
OUT_JSON = META_DIR / "inputs" / "blend_weights_v2.json"

# Position B2S threshold (PPR ppg) — same as 2024 calibration
B2S_HIT_THRESHOLDS = {"RB": 14.0, "WR": 13.5, "TE": 11.0, "QB": 16.0}
MIN_GAMES_PER_SEASON = 8  # JJ's 2024 spec


def normalize_name(name: str) -> str:
    return (name.replace(",", "").replace(".", "").replace("'", "")
            .replace(" ", "").replace("-", "").replace("Jr", "")
            .replace("Sr", "").replace("II", "").replace("III", "")
            .lower().strip())


def spearman(xs: list[float], ys: list[float]) -> float:
    if len(xs) < 3:
        return 0.0
    n = len(xs)
    rx = sorted(range(n), key=lambda i: xs[i])
    ry = sorted(range(n), key=lambda i: ys[i])
    rank_x = [0] * n; rank_y = [0] * n
    for r, i in enumerate(rx): rank_x[i] = r
    for r, i in enumerate(ry): rank_y[i] = r
    d2 = sum((rank_x[i] - rank_y[i]) ** 2 for i in range(n))
    return round(1 - 6 * d2 / (n * (n * n - 1)), 3)


def load_jj_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def load_nfl_picks() -> list[dict]:
    """All NFL draft picks, all seasons we have."""
    rows = []
    if NFL_DRAFT_CSV.exists():
        with NFL_DRAFT_CSV.open() as f:
            rows.extend(csv.DictReader(f))
    # Also need 2022 picks — pull via nflreadpy
    try:
        import nflreadpy as nfl
        import polars as pl
        df = nfl.load_draft_picks(seasons=[2022])
        sp = df.filter(pl.col("position").is_in(["QB", "RB", "WR", "TE"]))
        for r in sp.to_pandas().to_dict(orient="records"):
            rows.append({
                "season": "2022",
                "round": str(r["round"]),
                "pick": str(r["pick"]),
                "team": r["team"] or "",
                "gsis_id": r["gsis_id"] or "",
                "pfr_player_name": r["pfr_player_name"] or "",
                "position": r["position"] or "",
            })
    except Exception as e:
        print(f"WARN: couldn't fetch 2022 NFL picks: {e}", file=sys.stderr)
    return rows


def load_nflv_season_totals() -> dict:
    """(gsis_id, season) -> {ppr, games}"""
    out = {}
    with NFLV_TOTALS_CSV.open() as f:
        for r in csv.DictReader(f):
            try:
                out[(r["player_id"], int(r["season"]))] = {
                    "total_ppr": float(r["total_ppr"]),
                    "games": int(r["games"]),
                }
            except (ValueError, KeyError):
                continue
    return out


def grade_cohort(jj_csv: Path, cohort_year: int, max_year: int, nfl_picks_by_norm: dict, nflv: dict) -> dict:
    """Grade a JJ cohort against realized B2S production through max_year."""
    jj_rows = load_jj_csv(jj_csv)
    if not jj_rows:
        return {"error": f"JJ CSV not found: {jj_csv}"}

    cohort = []
    unmatched = []
    for j in jj_rows:
        norm = normalize_name(j["player_name"])
        pos = j["position"]
        # NFL match
        nfl_match = nfl_picks_by_norm.get((norm, pos))
        if not nfl_match:
            jj_last = j["player_name"].split()[-1].lower()
            for (n, p), r in nfl_picks_by_norm.items():
                if p == pos and len(n) >= 5 and (n in norm or norm in n):
                    nfl_match = r
                    break
        if not nfl_match:
            unmatched.append(j["player_name"])
            continue
        gsis = nfl_match["gsis_id"]

        # Pull Y1-Y3 production (or what's available)
        seasons_data = []
        for y_offset in (0, 1, 2):
            yr = cohort_year + y_offset
            if yr > max_year:
                break
            rec = nflv.get((gsis, yr))
            if rec and rec["games"] >= MIN_GAMES_PER_SEASON:
                seasons_data.append({
                    "season": yr,
                    "total_ppr": rec["total_ppr"],
                    "games": rec["games"],
                    "ppg": rec["total_ppr"] / rec["games"],
                })
            elif rec:
                # Played fewer than min games — count as 0 per JJ's B2S spec
                seasons_data.append({
                    "season": yr,
                    "total_ppr": rec["total_ppr"],
                    "games": rec["games"],
                    "ppg": 0,
                })
            else:
                seasons_data.append({
                    "season": yr,
                    "total_ppr": 0,
                    "games": 0,
                    "ppg": 0,
                })

        # Compute B2S (or partial)
        ppgs = [s["ppg"] for s in seasons_data]
        if len(ppgs) >= 2:
            top2 = sorted(ppgs, reverse=True)[:2]
            b2s = round(statistics.mean(top2), 2)
        else:
            b2s = round(ppgs[0], 2) if ppgs else 0

        try:
            zap = float(j["zap_score"])
        except (KeyError, ValueError):
            zap = 0.0

        cohort.append({
            "player_name": j["player_name"],
            "position": pos,
            "zap_rank": int(j.get("zap_rank_pos", 0)),
            "zap_score": zap,
            "gsis_id": gsis,
            "nfl_pick": int(nfl_match["pick"]),
            "nfl_team": nfl_match.get("team", ""),
            "n_seasons_observed": len([s for s in seasons_data if s["games"] >= MIN_GAMES_PER_SEASON]),
            "y1_ppg": round(ppgs[0], 2) if len(ppgs) >= 1 else None,
            "y2_ppg": round(ppgs[1], 2) if len(ppgs) >= 2 else None,
            "y3_ppg": round(ppgs[2], 2) if len(ppgs) >= 3 else None,
            "b2s_ppg": b2s,
        })

    # Position-level Spearman
    spearman_per_pos = {}
    for pos in ("RB", "WR", "TE"):
        rows = [c for c in cohort if c["position"] == pos]
        if len(rows) < 5:
            continue
        zaps = [c["zap_score"] for c in rows]
        b2ss = [c["b2s_ppg"] for c in rows]
        rho = spearman(zaps, b2ss)
        # Hit rate by ZAP percentile
        rows_sorted = sorted(rows, key=lambda r: -r["zap_score"])
        thr = B2S_HIT_THRESHOLDS[pos]
        # Top 1/3 vs bottom 2/3
        top_third = rows_sorted[:max(1, len(rows_sorted)//3)]
        bot_third = rows_sorted[-max(1, len(rows_sorted)//3):]
        top_hit_rate = round(sum(1 for r in top_third if r["b2s_ppg"] >= thr) / len(top_third) * 100, 1)
        bot_hit_rate = round(sum(1 for r in bot_third if r["b2s_ppg"] >= thr) / len(bot_third) * 100, 1)
        spearman_per_pos[pos] = {
            "n": len(rows),
            "spearman_b2s": rho,
            "median_b2s": round(statistics.median(b2ss), 2),
            "top_third_hit_pct": top_hit_rate,
            "bot_third_hit_pct": bot_hit_rate,
            "lift_top_vs_bot": round(top_hit_rate - bot_hit_rate, 1),
        }

    return {
        "cohort_year": cohort_year,
        "max_year": max_year,
        "model_version": "Z-Prospect V1" if cohort_year == 2022 else f"ZAP {1 if cohort_year < 2026 else 2}",
        "matched": len(cohort),
        "unmatched": len(unmatched),
        "unmatched_names": unmatched[:8],
        "spearman_per_pos": spearman_per_pos,
        "cohort": cohort,
    }


def main() -> int:
    print("Loading NFL draft picks (2022, 2024, 2026)...")
    nfl_picks = load_nfl_picks()
    nfl_by_norm = {(normalize_name(r["pfr_player_name"]), r["position"]): r
                   for r in nfl_picks}
    print(f"  {len(nfl_picks)} NFL skill picks loaded")

    print("Loading nflverse season totals (2014-2025 cache)...")
    nflv = load_nflv_season_totals()
    print(f"  {len(nflv)} player-season records")

    # Grade 2022 cohort against full B2S (Y1-Y3 = 2022-2024 all observable; Y4=2025 also avail)
    print("\nGrading 2022 cohort (Z-Prospect V1) against B2S Y1-Y3 (2022-2024)...")
    cohort_2022 = grade_cohort(
        META_DIR / "inputs" / "jj_zap_2022.csv",
        cohort_year=2022,
        max_year=2024,
        nfl_picks_by_norm=nfl_by_norm,
        nflv=nflv,
    )

    # Grade 2024 cohort against partial B2S (Y1-Y2 = 2024-2025)
    print("Grading 2024 cohort (ZAP 1.0) against best-of-Y1-Y2 (2024-2025)...")
    cohort_2024 = grade_cohort(
        META_DIR / "inputs" / "jj_zap_2024.csv",
        cohort_year=2024,
        max_year=2025,
        nfl_picks_by_norm=nfl_by_norm,
        nflv=nflv,
    )

    # Build markdown
    lines: list[str] = []
    lines.append("# JJ Multi-Cohort Calibration — B2S Grading\n")
    lines.append(
        "Two cohorts graded against JJ's ACTUAL model target (B2S = best 2 of "
        "Y1-Y3 PPR ppg with 8-game season minimum). 2024 cohort is partial "
        "(Y1-Y2 only as of NFL season end 2025).\n"
    )
    lines.append(
        "**Why B2S, not Y1:** the prior calibration used Y1 ppg which is the wrong "
        "yardstick — JJ's model targets 3-year B2S. RB Y1 in particular is dominated "
        "by NFL coaching decisions and depth-chart noise. The 2022 cohort lets us "
        "grade JJ's *actual target* with full 3-year data.\n"
    )

    for label, cohort in [("2022 (Z-Prospect V1, full B2S)", cohort_2022),
                          ("2024 (ZAP 1.0, partial best-of-Y1-Y2)", cohort_2024)]:
        if "error" in cohort:
            lines.append(f"\n## {label}\n\nError: {cohort['error']}")
            continue
        lines.append(f"\n## {label}\n")
        lines.append(
            f"Matched: {cohort['matched']}; unmatched: {cohort['unmatched']}\n"
        )
        if cohort["unmatched_names"]:
            lines.append(f"Unmatched examples (likely UDFAs / no NFL play): "
                        f"{', '.join(cohort['unmatched_names'])}\n")

        lines.append(
            "\n| Pos | n | Spearman ρ (ZAP vs B2S) | Median B2S | Top-1/3 hit % | Bot-1/3 hit % | Lift |\n"
            "|----:|--:|------------------------:|-----------:|--------------:|--------------:|-----:|"
        )
        for pos, stats in cohort["spearman_per_pos"].items():
            lines.append(
                f"| {pos} | {stats['n']} | **{stats['spearman_b2s']}** | "
                f"{stats['median_b2s']} | {stats['top_third_hit_pct']}% | "
                f"{stats['bot_third_hit_pct']}% | +{stats['lift_top_vs_bot']}pp |"
            )

        # Show top-third hits and misses
        lines.append("\n### Top-1/3 ZAP cohort (model loved them)\n")
        for pos in ("RB", "WR", "TE"):
            rows = [c for c in cohort["cohort"] if c["position"] == pos]
            if len(rows) < 5:
                continue
            rows_sorted = sorted(rows, key=lambda r: -r["zap_score"])
            top = rows_sorted[:max(1, len(rows_sorted) // 3)]
            thr = B2S_HIT_THRESHOLDS[pos]
            lines.append(f"\n**{pos}** (top {len(top)} of {len(rows)}):")
            for r in top:
                hit = "✓" if r["b2s_ppg"] >= thr else "✗"
                lines.append(
                    f"- {hit} {r['player_name']} ({r['nfl_team']}, R?.{r['nfl_pick']}) "
                    f"— ZAP {r['zap_score']}, B2S {r['b2s_ppg']} ppg "
                    f"(Y1={r['y1_ppg']}, Y2={r['y2_ppg']}, Y3={r['y3_ppg']})"
                )

    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines))
    print(f"\nwrote {OUT_MD.relative_to(ROOT)}")

    # Save weights
    spearman_combined = {}
    for pos in ("RB", "WR", "TE"):
        s2022 = cohort_2022.get("spearman_per_pos", {}).get(pos, {})
        s2024 = cohort_2024.get("spearman_per_pos", {}).get(pos, {})
        spearman_combined[pos] = {
            "2022_b2s_full": s2022.get("spearman_b2s"),
            "2024_b2s_partial": s2024.get("spearman_b2s"),
            "2022_lift_top_vs_bot": s2022.get("lift_top_vs_bot"),
            "2024_lift_top_vs_bot": s2024.get("lift_top_vs_bot"),
        }

    OUT_JSON.write_text(json.dumps({
        "version": 2,
        "as_of": "2026-04-29",
        "method": "JJ multi-cohort B2S grading; 2022 full, 2024 partial",
        "default_blend": {"jj": 0.5, "koalaty": 0.5},
        "spearman_jj": spearman_combined,
        "notes": (
            "2022 cohort is the cleanest grade — Z-Prospect V1 against full B2S. "
            "2024 cohort is best-of-Y1-Y2 (ZAP 1.0). Use 2022 ρ as the primary signal."
        ),
    }, indent=2))
    print(f"wrote {OUT_JSON.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
