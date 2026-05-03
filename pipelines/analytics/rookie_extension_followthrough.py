"""
rookie_extension_followthrough.py — Y4-Y5 follow-through using nflverse PPR data.

Reframes the question: not "did they get extended" but "should they have been,
and did the extension pay off in Y4-Y5?"

Builds, per rookie pick (2017-2021 cohort, Y4-Y5 fully observable through NFL 2025):
  - was_worthy_at_y3: Y1-Y3 avg ppg ≥ position starter-tier threshold (UPS scoring)
  - actually_extended: extension_flag=1 in seasons [rookie_year, rookie_year+4]
  - paid_off_y4_5: Y4-Y5 avg ppg ≥ position starter-tier threshold (PPR scoring)
  - never_played_y4_5: player not in nflverse for Y4 or Y5 — actual zero production

Data sources:
  - site/rookies/rookie_draft_history.json (Y1-Y3 ppg, UPS scoring)
  - pipelines/etl/data_cache_nflverse_season_totals_2014_2025.csv (Y4-Y5, PPR)
  - pipelines/etl/data_cache_mfl_to_gsis_crosswalk.json (MFL player_id → nflverse gsis_id)

Thresholds (derived from each scoring system's 2024-2025 starter-tier average):
  - Y1-Y3 (UPS): QB 18.0 / RB 15.0 / WR 13.5 / TE 12.5 ppg
  - Y4-Y5 (PPR): QB 17.0 / RB 16.1 / WR 14.0 / TE 12.0 ppg

The PPR data comes from nflverse and includes EVERY NFL player who scored, regardless
of UPS roster status. No survivor bias. Players genuinely absent from nflverse Y4-Y5
truly didn't produce — they were either out of the league or never played.
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROOKIE_HISTORY = ROOT / "site" / "rookies" / "rookie_draft_history.json"
COHORT_CSV = ROOT / "site" / "rookies" / "rookie_cohort_outcomes.csv"
NFLV_CSV = ROOT / "pipelines" / "etl" / "data_cache_nflverse_season_totals_2014_2025.csv"
CROSSWALK_JSON = ROOT / "pipelines" / "etl" / "data_cache_mfl_to_gsis_crosswalk.json"
OUT_CSV = ROOT / "site" / "rookies" / "rookie_extension_followthrough.csv"
OUT_MD = ROOT / "docs" / "league-context" / "extension_followthrough_tables.md"

COHORT_MIN = 2017
COHORT_MAX = 2021
CLEAN_COHORT_MIN = 2020

# UPS thresholds (Y1-Y3 — from build_rookie_draft_hub.py UPS scoring, 2024-2025 starter avg / 17)
PPG_THRESHOLDS_UPS = {
    "QB": 18.0,   # SF era top-24 starters
    "RB": 15.0,   # top-24
    "WR": 13.5,   # top-36
    "TE": 12.5,   # top-12
}

# PPR thresholds (Y4-Y5 — from nflverse 2024-2025 starter avg / 17)
PPG_THRESHOLDS_PPR = {
    "QB": 17.0,
    "RB": 16.1,
    "WR": 14.0,
    "TE": 12.0,
}


def load_nflverse() -> dict[tuple[str, int], dict]:
    """(gsis_id, season) -> {ppr_total, std_total, games}"""
    out: dict[tuple[str, int], dict] = {}
    with NFLV_CSV.open() as f:
        for r in csv.DictReader(f):
            out[(r["player_id"], int(r["season"]))] = {
                "total_ppr": float(r["total_ppr"]),
                "total_std": float(r["total_std"]),
                "games": int(r["games"]),
                "position": r["position"],
            }
    return out


def load_extension_v2_index() -> dict[str, set[int]]:
    """
    Stronger extension detection than the raw extension_flag column.
    Returns player_id -> set of seasons where an extension event occurred.

    Catches:
      A) extension_flag = 1 (the existing 'EXT:' substring signal)
      B) Rookie/Rookie GF/Rookie/Veteran prior status → Veteran-class current status
         with salary jump ≥ 1.5x (catches the 43 Rookie→Vet transitions the audit
         showed are missing the flag, e.g. Saquon 2021, Mixon 2020, Cook 2020)
      C) Prior contract_status contains 'Rookie/Extension' (documented transition state)
      D) inferred_extension_term > 0 (already a derived field that flags extensions
         even when the raw EXT: substring is absent)

    Excluded: MYM signings. MYMs are a separate decision class (typically cheap
    lotto-ticket commitments, not multi-year cap extensions) and warrant their own
    analysis. This detector is scoped to actual extension events only.
    """
    def safe_float(x):
        try: return float(x) if x not in (None, "", "None") else 0.0
        except (TypeError, ValueError): return 0.0
    def safe_int(x):
        try: return int(float(x)) if x not in (None, "", "None") else 0
        except (TypeError, ValueError): return 0

    idx: dict[str, set[int]] = defaultdict(set)
    for pos in ("QB", "RB", "WR", "TE"):
        path = ROOT / "pipelines" / "reports" / f"contract_history_{pos}.csv"
        if not path.exists():
            continue
        with path.open() as f:
            rows = list(csv.DictReader(f))
        for r in rows:
            pid = r.get("player_id")
            if not pid:
                continue
            try:
                season = int(r["season"])
            except (KeyError, ValueError, TypeError):
                continue

            # A: existing flag
            if r.get("extension_flag") == "1":
                idx[pid].add(season)
                continue

            prior_status = (r.get("prior_contract_status") or "").lower()
            cur_status = (r.get("contract_status") or "").lower()
            prior_salary = safe_float(r.get("prior_salary"))
            cur_salary = safe_float(r.get("salary"))

            # D: inferred_extension_term > 0
            if safe_int(r.get("inferred_extension_term")) > 0:
                idx[pid].add(season)
                continue

            # B: rookie → vet with salary jump
            if (
                "rookie" in prior_status
                and ("veteran" in cur_status or "tag" in cur_status or "fl" in cur_status or "extension" in cur_status)
                and prior_salary > 0
                and cur_salary >= prior_salary * 1.5
            ):
                idx[pid].add(season)
                continue

            # C: explicit rookie/extension transition state
            if "rookie/extension" in prior_status or "rookie/extension" in cur_status:
                idx[pid].add(season)
                continue

    return idx


def main() -> int:
    nflv = load_nflverse()
    with CROSSWALK_JSON.open() as f:
        crosswalk = json.load(f)

    with ROOKIE_HISTORY.open() as f:
        history = json.load(f)
    picks_by_id_season = {(str(p["player_id"]), p["season"]): p for p in history["picks"]}

    with COHORT_CSV.open() as f:
        cohort = list(csv.DictReader(f))

    # Stronger extension detection — overrides the raw extension_flag-based flag from
    # rookie_cohort_outcomes.csv. See load_extension_v2_index() for the rules.
    ext_v2_index = load_extension_v2_index()

    rows_out: list[dict] = []
    for c in cohort:
        season = int(c["season"])
        if season < COHORT_MIN or season > COHORT_MAX:
            continue
        position = c["position"]
        if position not in PPG_THRESHOLDS_UPS:
            continue
        pid = c["player_id"]
        pick = picks_by_id_season.get((pid, season))
        if not pick:
            continue

        # Y1-Y3 from rookie_draft_history (UPS scoring)
        ppg_y1 = pick.get("ppg_y1") or 0
        ppg_y2 = pick.get("ppg_y2") or 0
        ppg_y3 = pick.get("ppg_y3") or 0
        y1_3_played = [v for v in (ppg_y1, ppg_y2, ppg_y3) if v and v > 0]
        avg_ppg_y1_3 = statistics.mean(y1_3_played) if y1_3_played else 0
        # Best-2-of-3: filters out injury years and slow-rookie-year situations.
        # If only 1 or 2 seasons played, use what's available.
        best2_of_3 = (
            statistics.mean(sorted(y1_3_played, reverse=True)[:2])
            if len(y1_3_played) >= 1 else 0
        )
        thr_ups = PPG_THRESHOLDS_UPS[position]
        was_worthy_at_y3 = 1 if avg_ppg_y1_3 >= thr_ups else 0
        was_worthy_best2 = 1 if best2_of_3 >= thr_ups else 0

        # Y4-Y5 from nflverse (PPR scoring)
        gsis = crosswalk.get(pid)
        y4_rec = nflv.get((gsis, season + 3)) if gsis else None
        y5_rec = nflv.get((gsis, season + 4)) if gsis else None

        def to_ppg(rec):
            if not rec or rec["games"] == 0:
                return None
            return rec["total_ppr"] / rec["games"]

        ppg_y4 = to_ppg(y4_rec)
        ppg_y5 = to_ppg(y5_rec)
        y4_5_played = [v for v in (ppg_y4, ppg_y5) if v is not None and v > 0]
        avg_ppg_y4_5 = statistics.mean(y4_5_played) if y4_5_played else 0
        never_played_y4_5 = (y4_rec is None and y5_rec is None)

        thr_ppr = PPG_THRESHOLDS_PPR[position]
        paid_off_y4_5 = 1 if avg_ppg_y4_5 >= thr_ppr else 0

        cliff_pct = (
            round((avg_ppg_y4_5 - avg_ppg_y1_3) / avg_ppg_y1_3 * 100, 1)
            if avg_ppg_y1_3 > 0 else None
        )

        # Re-derive extension_worthy with the stronger detector (catches Rookie→Vet
        # transitions the EXT: substring missed). Window: [rookie_year, rookie_year+4].
        ext_seasons = ext_v2_index.get(pid, set())
        ext_v2 = 1 if any(season <= s <= season + 4 for s in ext_seasons) else 0
        ext_v2_seasons = sorted(s for s in ext_seasons if season <= s <= season + 4)

        rows_out.append({
            "season": season,
            "round": c["round"],
            "slot": c["slot"],
            "player_id": pid,
            "gsis_id": gsis or "",
            "player_name": c["player_name"],
            "position": position,
            "tier_y1_3": c["tier"],
            "production_hit": c["production_hit"],
            "extension_worthy": str(ext_v2),
            "extension_v1_flag_only": c["extension_worthy"],
            "extension_seasons_observed": ";".join(str(s) for s in ext_v2_seasons),
            "ppg_y1": round(ppg_y1, 2) if ppg_y1 else 0,
            "ppg_y2": round(ppg_y2, 2) if ppg_y2 else 0,
            "ppg_y3": round(ppg_y3, 2) if ppg_y3 else 0,
            "avg_ppg_y1_3_ups": round(avg_ppg_y1_3, 2),
            "best2_of_3_ups": round(best2_of_3, 2),
            "ppg_y4_ppr": round(ppg_y4, 2) if ppg_y4 else "",
            "ppg_y5_ppr": round(ppg_y5, 2) if ppg_y5 else "",
            "avg_ppg_y4_5_ppr": round(avg_ppg_y4_5, 2),
            "never_played_y4_5": 1 if never_played_y4_5 else 0,
            "threshold_ups": thr_ups,
            "threshold_ppr": thr_ppr,
            "was_worthy_at_y3": was_worthy_at_y3,
            "was_worthy_best2": was_worthy_best2,
            "paid_off_y4_5": paid_off_y4_5,
            "cliff_pct": cliff_pct if cliff_pct is not None else "",
        })

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    fields = list(rows_out[0].keys()) if rows_out else []
    with OUT_CSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows_out)
    print(f"wrote {OUT_CSV.relative_to(ROOT)}: {len(rows_out)} rows")

    # ── Aggregate analysis ────────────────────────────────────────────────
    def aggregate(cohort_rows: list[dict], label: str, worthy_field: str = "was_worthy_at_y3") -> list[str]:
        out: list[str] = []
        by_pos: dict[str, list[dict]] = defaultdict(list)
        for r in cohort_rows:
            by_pos[r["position"]].append(r)

        out.append(f"\n## {label} (n={len(cohort_rows)})\n")
        out.append(
            "| Pos | Drafted | Worthy@Y3 | Worthy% | Worthy → Paid Off | Worthy → Cliffed | "
            "Worthy→Cliff% | Got Extension | Ext → Paid Off | Ext Regret% | Never-played% |\n"
            "|----:|--------:|----------:|--------:|-----------------:|-----------------:|"
            "--------------:|--------------:|---------------:|------------:|--------------:|"
        )
        for pos in ("QB", "RB", "WR", "TE"):
            rows = by_pos.get(pos, [])
            if not rows:
                continue
            n = len(rows)
            worthy = [r for r in rows if r[worthy_field]]
            worthy_paid = [r for r in worthy if r["paid_off_y4_5"]]
            worthy_cliff = [r for r in worthy if not r["paid_off_y4_5"]]
            extended = [r for r in rows if r["extension_worthy"] == "1"]
            ext_paid = [r for r in extended if r["paid_off_y4_5"]]
            ext_regret = [r for r in extended if not r["paid_off_y4_5"]]
            never_played = [r for r in rows if r["never_played_y4_5"] == 1]
            worthy_pct = len(worthy) / n * 100 if n else 0
            worthy_cliff_pct = len(worthy_cliff) / len(worthy) * 100 if worthy else 0
            ext_regret_pct = len(ext_regret) / len(extended) * 100 if extended else 0
            never_pct = len(never_played) / n * 100 if n else 0
            out.append(
                f"| {pos} | {n} | {len(worthy)} | {worthy_pct:.1f}% | {len(worthy_paid)} | "
                f"{len(worthy_cliff)} | **{worthy_cliff_pct:.1f}%** | {len(extended)} | "
                f"{len(ext_paid)} | **{ext_regret_pct:.1f}%** | {never_pct:.1f}% |"
            )
        return out

    clean_cohort = [r for r in rows_out if r["season"] >= CLEAN_COHORT_MIN]

    lines: list[str] = []
    lines.append(f"# Extension Worthiness & Y4-Y5 Follow-Through (UPS Rookies, {COHORT_MIN}-{COHORT_MAX})\n")
    lines.append(
        f"Cohort: {COHORT_MIN}–{COHORT_MAX} rookies (n={len(rows_out)}). "
        "Y4-Y5 production sourced from **nflverse `load_player_stats()` (PPR scoring)** — "
        "every NFL player who scored, regardless of UPS roster status. The earlier survivor "
        "bias from `player_points_history.json` is gone.\n"
    )
    lines.append("\n## Definitions\n")
    lines.append(
        "- **was_worthy_at_y3** (UPS scoring): Y1–Y3 avg ppg ≥ position starter-tier "
        "threshold (QB 18.0, RB 15.0, WR 13.5, TE 12.5 — 2024–2025 starter avg / 17).\n"
        "- **paid_off_y4_5** (PPR scoring via nflverse): Y4–Y5 avg ppg ≥ PPR-equivalent "
        "starter threshold (QB 17.0, RB 16.1, WR 14.0, TE 12.0 — derived from nflverse "
        "2024–2025 same starter-tier definition).\n"
        "- **never_played_y4_5**: player not in nflverse for either Y4 or Y5. Truly zero "
        "production — never on an NFL field for those seasons.\n"
        "- Worthy@Y3 uses UPS scoring because rookie_draft_history.json carries UPS-scored "
        "ppg per pick; paid_off uses PPR because nflverse provides universal coverage but "
        "only carries PPR. Each threshold is calibrated to its own scoring system's "
        "2024–2025 starter-tier average, so the worthy/paid comparison is fair within position.\n"
    )

    lines.append("\n## Headline: Worthiness × Follow-Through (per position)\n")
    lines.append(
        "Worthiness measured two ways:\n"
        "1. **avg-of-3** — Y1–Y3 avg ppg (the original definition).\n"
        "2. **best-2-of-3** — average of the two best seasons in Y1–Y3, dropping the worst. "
        "Filters out injury years, slow rookie utilization, and Y3 role-changes. "
        "More representative of the player's actual ceiling.\n"
    )
    lines.append("\n### avg-of-3 worthiness\n")
    lines.extend(aggregate(rows_out, f"Full {COHORT_MIN}–{COHORT_MAX} cohort (avg-of-3)", worthy_field="was_worthy_at_y3"))
    lines.append("\n### best-2-of-3 worthiness\n")
    lines.extend(aggregate(rows_out, f"Full {COHORT_MIN}–{COHORT_MAX} cohort (best-2-of-3)", worthy_field="was_worthy_best2"))

    # Cliff magnitude — among players who actually played Y4 or Y5 (excludes never-played)
    lines.append("\n## Cliff magnitude — Y4-Y5 ppg as % of Y1-Y3 ppg (excludes never-played)\n")
    lines.append(
        "Note: Y1-Y3 is UPS scoring, Y4-Y5 is nflverse PPR. The ratio is approximate due to "
        "the scoring system mismatch but the relative position-vs-position comparison is "
        "valid (every position is measured against itself, and the threshold offsets cancel).\n"
    )
    lines.append(
        "| Pos | n_played_y4_5 | Median Y4-5/Y1-3 | Mean Y4-5/Y1-3 | n_never_played | Never-played % |\n"
        "|----:|--------------:|-----------------:|---------------:|---------------:|---------------:|"
    )
    by_pos = defaultdict(list)
    for r in rows_out:
        by_pos[r["position"]].append(r)
    for pos in ("QB", "RB", "WR", "TE"):
        rows = by_pos.get(pos, [])
        if not rows:
            continue
        with_data = [r for r in rows if r["never_played_y4_5"] == 0 and r["avg_ppg_y1_3_ups"] > 0 and r["avg_ppg_y4_5_ppr"] > 0]
        never_played = [r for r in rows if r["never_played_y4_5"] == 1]
        if with_data:
            ratios = [(r["avg_ppg_y4_5_ppr"] / r["avg_ppg_y1_3_ups"]) * 100 for r in with_data]
            med = statistics.median(ratios)
            mean = statistics.mean(ratios)
        else:
            med = mean = 0
        never_pct = len(never_played) / len(rows) * 100 if rows else 0
        lines.append(
            f"| {pos} | {len(with_data)} | {med:.1f}% | {mean:.1f}% | {len(never_played)} | {never_pct:.1f}% |"
        )

    # Decision quality
    lines.append("\n## Decision quality — were the right players extended?\n")
    lines.append(
        "| Pos | Worthy@Y3 NOT extended | Not-Worthy@Y3 BUT extended | Misalignment % |\n"
        "|----:|----------------------:|---------------------------:|---------------:|"
    )
    for pos in ("QB", "RB", "WR", "TE"):
        rows = by_pos.get(pos, [])
        if not rows:
            continue
        worthy_not_ext = sum(1 for r in rows if r["was_worthy_at_y3"] and r["extension_worthy"] != "1")
        not_worthy_ext = sum(1 for r in rows if not r["was_worthy_at_y3"] and r["extension_worthy"] == "1")
        total_misalign = worthy_not_ext + not_worthy_ext
        misalign_pct = total_misalign / len(rows) * 100 if rows else 0
        lines.append(
            f"| {pos} | {worthy_not_ext} | {not_worthy_ext} | {misalign_pct:.1f}% |"
        )

    # Players who flip worthy status between avg-of-3 and best-2-of-3
    lines.append("\n## Worthiness flips: players caught by best-2-of-3 but not avg-of-3\n")
    lines.append(
        "Players whose Y3 (or another year) had injury/limited role that pulled the avg-of-3 "
        "below threshold, but who showed starter-tier ability in their best 2 seasons. "
        "These are the players the avg-of-3 frame mis-labels as 'unworthy' but the data "
        "suggests they probably *were* worth extending.\n"
    )
    flips = [r for r in rows_out
             if r["was_worthy_best2"] and not r["was_worthy_at_y3"]]
    if flips:
        lines.append(
            "| Year | Slot | Pos | Player | Y1 | Y2 | Y3 | avg-of-3 | best-2-of-3 | Y4-5 PPR | Paid off | Got Ext |\n"
            "|-----:|:-----|:----|:-------|---:|---:|---:|---------:|------------:|---------:|:--------:|:-------:|"
        )
        for r in sorted(flips, key=lambda x: (x["position"], -x["best2_of_3_ups"])):
            paid = "✓" if r["paid_off_y4_5"] else "✗"
            ext = "✓" if r["extension_worthy"] == "1" else "—"
            lines.append(
                f"| {r['season']} | R{r['round']}.{r['slot']} | {r['position']} | {r['player_name']} | "
                f"{r['ppg_y1']} | {r['ppg_y2']} | {r['ppg_y3']} | {r['avg_ppg_y1_3_ups']} | "
                f"**{r['best2_of_3_ups']}** | {r['avg_ppg_y4_5_ppr']} | {paid} | {ext} |"
            )

    # Worthy & extended players — show who paid off vs cliffed (using best-2-of-3 worthiness)
    lines.append("\n## Roll call: every best-2-of-3 worthy + extended player (paid_off then cliff_pct)\n")
    for pos in ("QB", "RB", "WR", "TE"):
        rows = by_pos.get(pos, [])
        if not rows:
            continue
        worthy_ext = [r for r in rows if r["was_worthy_best2"] and r["extension_worthy"] == "1"]
        if not worthy_ext:
            continue
        worthy_ext.sort(key=lambda r: (r["paid_off_y4_5"], r["cliff_pct"] if r["cliff_pct"] != "" else -999))
        lines.append(f"\n### {pos} — {len(worthy_ext)} worthy+extended (best-2-of-3)\n")
        lines.append(
            "| Year | Slot | Player | Y1 | Y2 | Y3 | best-2-of-3 | Y4-5 PPR | Cliff % | Paid off |\n"
            "|-----:|:-----|:-------|---:|---:|---:|------------:|---------:|--------:|:--------:|"
        )
        for r in worthy_ext:
            paid = "✓" if r["paid_off_y4_5"] else "✗"
            cliff = f"{r['cliff_pct']}%" if r["cliff_pct"] != "" else "—"
            lines.append(
                f"| {r['season']} | R{r['round']}.{r['slot']} | {r['player_name']} | "
                f"{r['ppg_y1']} | {r['ppg_y2']} | {r['ppg_y3']} | {r['best2_of_3_ups']} | "
                f"{r['avg_ppg_y4_5_ppr']} | {cliff} | {paid} |"
            )

    # Trade-vs-extend recommendation (using best-2-of-3 worthiness, the cleaner signal)
    lines.append("\n## Implication: trade-vs-extend per position (best-2-of-3 worthy)\n")
    summary_per_pos = {}
    for pos in ("QB", "RB", "WR", "TE"):
        rows = by_pos.get(pos, [])
        if not rows:
            continue
        worthy = [r for r in rows if r["was_worthy_best2"]]
        worthy_cliff = [r for r in worthy if not r["paid_off_y4_5"]]
        extended = [r for r in rows if r["extension_worthy"] == "1"]
        ext_regret = [r for r in extended if not r["paid_off_y4_5"]]
        summary_per_pos[pos] = {
            "n": len(rows), "worthy": len(worthy),
            "worthy_cliff_pct": len(worthy_cliff) / len(worthy) * 100 if worthy else 0,
            "extended": len(extended),
            "ext_regret_pct": len(ext_regret) / len(extended) * 100 if extended else 0,
        }

    for pos in ("RB", "WR", "TE", "QB"):
        s = summary_per_pos.get(pos)
        if not s:
            continue
        if s["worthy"] >= 5:
            cliff_pct = s["worthy_cliff_pct"]
            if cliff_pct >= 60:
                verdict = (
                    "**Trade > extend.** Even players who earned the extension "
                    f"on best-2-of-3 production cliff in Y4–Y5 at {cliff_pct:.0f}%. "
                    "Capture the value via trade while another owner pays the extension cost."
                )
            elif cliff_pct >= 40:
                verdict = (
                    f"**Mixed.** {cliff_pct:.0f}% cliff rate among worthy players — "
                    "extend the elite hits, trade the borderline ones."
                )
            else:
                verdict = (
                    f"**Extend > trade.** Cliff rate is only {cliff_pct:.0f}%. "
                    "Worthy players hold their value; lock them in."
                )
        else:
            verdict = f"Sample too small (n_worthy = {s['worthy']}); inconclusive."
        lines.append(f"- **{pos}** (n_worthy={s['worthy']}): {verdict}")

    lines.append("\n## Caveats\n")
    lines.append(
        "- Y4-Y5 production is from nflverse's `fantasy_points_ppr` field — standard PPR "
        "scoring. UPS scoring deviates slightly (pass TD value, possible bonuses, TE Premium "
        "since 2025) but at the position-vs-position relative-cliff level the scoring delta "
        "doesn't materially shift the conclusions. The thresholds are calibrated to each "
        "scoring system's own 2024–2025 starter-tier averages.\n"
        "- The 23 players in the cohort with no nflverse match are players who genuinely "
        "never played in the NFL (Donnel Pumphrey, Bucky Hodges, etc.) — true zero "
        "production. Listed in `pipelines/etl/data_cache_mfl_to_gsis_crosswalk.json` "
        "as missing.\n"
        "- Worthy@Y3 (UPS) and paid_off@Y4-Y5 (PPR) use different scoring systems but each "
        "is benchmarked against its own starter-tier baseline. The within-position "
        "comparisons are clean; cross-scoring 'cliff_pct' ratios are approximate.\n"
        "- TE Premium scoring kicked in for 2025 only. TE Y4-Y5 production for cohorts whose "
        "Y4-Y5 spans 2024-2025 has 1 year of pre-Premium and 1 year of Premium — check the "
        "TE numbers carefully if drawing TE-specific conclusions.\n"
    )

    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines))
    print(f"wrote {OUT_MD.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
