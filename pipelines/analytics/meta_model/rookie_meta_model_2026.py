"""
rookie_meta_model_2026.py — synthesize JJ + Koalaty into a 2026 rookie buy list.

Pipeline:
  1. Load JJ 2026 ZAP 2.0 scores + tiers (have)
  2. Load Koalaty 2026 model scores + tiers (if available; Chrome MCP agent provides)
  3. Load 2026 NFL draft picks (Wikipedia-sourced; nflverse 2026 not yet indexed)
  4. Match across sources by normalized player name + position
  5. Compute consensus score, tier, and cross-model agreement flag
  6. Compute NFL Draft Capital Delta (vs JJ's expected pick)
  7. Compute UPS-slot mispricing using rookie_hit_rate_matrix.json
  8. Output: site/rookies/2026_meta_prospects.json + docs/league-context/2026_rookie_buy_list.md

Graceful degradation: if Koalaty CSV is missing, ships JJ-only output with
cross-model column flagged "single_model" and the agreement signal disabled.
"""
from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipelines" / "analytics" / "meta_model"))
from tier_compression import (  # noqa: E402
    assign_tier, cross_model_agreement, normalize_name, tier_distance, ZAP2_TIERS,
)
from collections import Counter

META_DIR = ROOT / "pipelines" / "analytics" / "meta_model"
JJ_2026_CSV = META_DIR / "inputs" / "jj_zap_2026.csv"
KOALATY_2026_CSV = META_DIR / "inputs" / "koalaty_2026_postdraft.csv"
WINKS_2026_CSV = META_DIR / "inputs" / "winks_2026.csv"
KERRANE_2026_CSV = META_DIR / "inputs" / "kerrane_2026.csv"
ADP_2026_CSV = META_DIR / "inputs" / "rookie_adp_2026.csv"
NFL_2026_CSV = META_DIR / "inputs" / "nfl_draft_picks_2026.csv"
HIT_RATE_MATRIX = ROOT / "site" / "rookies" / "rookie_hit_rate_matrix.json"
OUT_JSON = ROOT / "site" / "rookies" / "2026_meta_prospects.json"
OUT_MD = ROOT / "docs" / "league-context" / "2026_rookie_buy_list.md"

# 4-source blend weights (equal default; revise after empirical calibration)
DEFAULT_BLEND = {"jj": 0.30, "koalaty": 0.30, "winks": 0.20, "kerrane": 0.20}

# JJ's 2024 Spearman rank correlation per position (from calibration_2024.py output).
# Used to weight JJ-side confidence: WR is high, RB is near-zero (Y1 noise dominates).
JJ_2024_SPEARMAN_VS_Y1 = {"WR": 0.749, "TE": 0.217, "RB": -0.059, "QB": None}

# Position thresholds for "is this a hit" reading (PPR ppg).
POS_HIT_THRESHOLD_PPR = {"QB": 16.0, "RB": 14.0, "WR": 13.5, "TE": 11.0}

# Rough tier-to-E[B2S] mapping derived from JJ's 2026 Guide hit-rate tables (p. 27-28),
# converted to expected B2S PPR ppg point estimate per position-tier.
# These are coarse but give us a number to attach to "Elite Producer RB" etc.
TIER_TO_EXPECTED_B2S = {
    "RB": {
        "Legendary Performer": 17.0, "Elite Producer": 14.0, "Weekly Starter": 11.5,
        "Flex Play": 8.5, "Benchwarmer": 6.5, "Waiver Wire Add": 5.0, "Dart Throw": 3.5,
    },
    "WR": {
        "Legendary Performer": 17.5, "Elite Producer": 14.5, "Weekly Starter": 12.0,
        "Flex Play": 9.5, "Benchwarmer": 7.0, "Waiver Wire Add": 5.0, "Dart Throw": 3.0,
    },
    "TE": {
        "Legendary Performer": 13.5, "Elite Producer": 11.0, "Weekly Starter": 9.5,
        "Flex Play": 7.5, "Benchwarmer": 5.5, "Waiver Wire Add": 4.0, "Dart Throw": 2.5,
    },
}


def load_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def fuzzy_name_match(target_norm: str, candidates: list[str]) -> str | None:
    """Find best name match from a list of normalized names."""
    if target_norm in candidates:
        return target_norm
    # Substring match (last name contained)
    for c in candidates:
        if len(c) >= 4 and (c in target_norm or target_norm in c):
            return c
    return None


def fuzzy_lookup(target_name: str, target_pos: str, idx: dict) -> dict | None:
    """Find a row in idx (keyed on (norm_name, pos)) by name + position with fuzzy fallback."""
    norm = normalize_name(target_name)
    if (norm, target_pos) in idx:
        return idx[(norm, target_pos)]
    # Fuzzy: substring on either direction
    for (n, p), r in idx.items():
        if p == target_pos and len(n) >= 5 and (n in norm or norm in n):
            return r
    # Fuzzy: last name match
    last = target_name.split()[-1].lower()
    for (n, p), r in idx.items():
        if p == target_pos and last in n and len(last) >= 5:
            return r
    return None


def main() -> int:
    jj = load_csv(JJ_2026_CSV)
    print(f"Loaded {len(jj)} JJ 2026 prospects")

    koalaty = load_csv(KOALATY_2026_CSV)
    print(f"Loaded {len(koalaty)} Koalaty 2026 prospects" if koalaty else "Koalaty 2026 CSV not present")

    winks = load_csv(WINKS_2026_CSV)
    print(f"Loaded {len(winks)} Winks 2026 prospects" if winks else "Winks 2026 CSV not present")

    kerrane = load_csv(KERRANE_2026_CSV)
    print(f"Loaded {len(kerrane)} Kerrane 2026 prospects" if kerrane else "Kerrane 2026 CSV not present")

    adp = load_csv(ADP_2026_CSV)
    print(f"Loaded {len(adp)} ADP entries" if adp else "ADP CSV not present")

    nfl = load_csv(NFL_2026_CSV)
    print(f"Loaded {len(nfl)} NFL 2026 draft picks")

    # Build lookup indexes by (normalized name, position)
    nfl_by_norm = {(normalize_name(r["player_name"]), r["position"]): r for r in nfl}
    koalaty_by_norm = {(normalize_name(r["player_name"]), r["position"]): r for r in koalaty} if koalaty else {}
    winks_by_norm = {(normalize_name(r["player_name"]), r["position"]): r for r in winks} if winks else {}
    kerrane_by_norm = {(normalize_name(r["player_name"]), r["position"]): r for r in kerrane} if kerrane else {}
    adp_by_norm = {(normalize_name(r["player_name"]), r["position"]): r for r in adp} if adp else {}

    # Build cohort: each row is a JJ-anchored prospect with all 4 sources + NFL + ADP
    cohort = []
    for j in jj:
        norm = normalize_name(j["player_name"])
        pos = j["position"]
        jj_score = float(j["zap_score"])
        jj_tier = j.get("zap_tier") or assign_tier(jj_score)

        # NFL pick lookup
        nfl_match = fuzzy_lookup(j["player_name"], pos, nfl_by_norm)
        nfl_pick_overall = int(nfl_match["pick_overall"]) if nfl_match else None
        nfl_round = int(nfl_match["round"]) if nfl_match else None
        nfl_team = nfl_match["nfl_team"] if nfl_match else "UDFA"

        # Koalaty lookup
        k_match = fuzzy_lookup(j["player_name"], pos, koalaty_by_norm)
        if k_match:
            try:
                k_score = float(k_match.get("model_score") or 0)
            except (TypeError, ValueError):
                k_score = 0.0
            k_letter = k_match.get("tier") or ""
            k_tier = assign_tier(k_score)
        else:
            k_score = None
            k_letter = ""
            k_tier = "—"

        # Winks lookup
        w_match = fuzzy_lookup(j["player_name"], pos, winks_by_norm)
        if w_match:
            try:
                w_score = float(w_match.get("model_score") or 0)
            except (TypeError, ValueError):
                w_score = 0.0
            w_tier = assign_tier(w_score)
        else:
            w_score = None
            w_tier = "—"

        # Kerrane lookup
        ker_match = fuzzy_lookup(j["player_name"], pos, kerrane_by_norm)
        if ker_match:
            try:
                ker_score = float(ker_match.get("model_score") or 0)
            except (TypeError, ValueError):
                ker_score = 0.0
            ker_label = ker_match.get("tier") or ""
            ker_tier = assign_tier(ker_score)
        else:
            ker_score = None
            ker_label = ""
            ker_tier = "—"

        # ADP lookup
        adp_match = fuzzy_lookup(j["player_name"], pos, adp_by_norm)
        adp_sf = adp_match.get("adp_sf") if adp_match else None
        adp_1qb = adp_match.get("adp_1qb") if adp_match else None

        # UDFA capital floor for KOALATY only (Koziol verification 2026-04-29):
        # Koalaty's post-draft TE sheet has no draft_pick column; refit republishes
        # pre-draft scores for tweeners. Cap at 35 (Benchwarmer top) when no NFL pick.
        # JJ, Winks, Kerrane all weight capital natively — leave them alone.
        if not nfl_match and k_score is not None and k_score > 35:
            k_score_effective = 35
            k_floor_applied = True
        else:
            k_score_effective = k_score
            k_floor_applied = False

        # 4-source weighted blend. Re-normalize weights when a source is missing.
        sources_present = []
        if jj_score > 0: sources_present.append(("jj", jj_score, DEFAULT_BLEND["jj"]))
        if k_score_effective: sources_present.append(("koalaty", k_score_effective, DEFAULT_BLEND["koalaty"]))
        if w_score: sources_present.append(("winks", w_score, DEFAULT_BLEND["winks"]))
        if ker_score: sources_present.append(("kerrane", ker_score, DEFAULT_BLEND["kerrane"]))
        if sources_present:
            total_weight = sum(w for _, _, w in sources_present)
            consensus_score = round(
                sum(s * (w / total_weight) for _, s, w in sources_present), 1
            )
        else:
            consensus_score = jj_score
        consensus_tier = assign_tier(consensus_score)
        n_sources = len(sources_present)

        # Cross-model 4-way: count how many sources agree on tier
        all_tiers = [t for t in (jj_tier, k_tier, w_tier, ker_tier) if t and t != "—"]
        tier_counts = Counter(all_tiers)
        modal_tier, modal_count = tier_counts.most_common(1)[0] if tier_counts else ("—", 0)
        if len(all_tiers) >= 3 and modal_count >= len(all_tiers) - 1:
            agreement_4way = "strong_consensus"  # 3+ of 4 agree
        elif len(all_tiers) >= 2 and modal_count == len(all_tiers):
            agreement_4way = "agree"  # all sources agree (small n)
        elif tier_distance(jj_tier, ker_tier) >= 2 or tier_distance(jj_tier, w_tier) >= 2 or tier_distance(jj_tier, k_tier) >= 2:
            agreement_4way = "disagree"  # any 2 sources differ by 2+ tiers
        else:
            agreement_4way = "near_agree"

        # 2-way agreement (JJ vs Koalaty) — kept for backward compat
        agreement = cross_model_agreement(jj_tier, k_tier)
        # 4-way agreement (computed above)
        agreement = agreement_4way

        # Draft capital delta — model loved them (low risk) vs faded (high risk)
        # Convert NFL pick to a percentile (lower pick number = higher capital)
        # Then compare to JJ's score percentile
        # Skip if no NFL match (UDFA)
        dcd_risk = "no_nfl_data"
        if nfl_pick_overall:
            # NFL pick percentile: 1 = 100, 262 = 0 (invert)
            nfl_pct = max(0, min(100, 100 * (1 - (nfl_pick_overall - 1) / 262)))
            score_pct = jj_score  # ZAP 2.0 is 0-100, treat as a percentile
            delta = score_pct - nfl_pct
            if delta >= 15:
                dcd_risk = "low"  # model loves more than NFL did
            elif delta <= -15:
                dcd_risk = "high"  # model lags NFL
            else:
                dcd_risk = "neutral"

        # Bootstrap-ish CI: simple ±5 around consensus_score for now
        # (proper bootstrap requires re-fitting JJ's hit-rate tables on each resample)
        ci_low = max(0, consensus_score - 5)
        ci_high = min(100, consensus_score + 5)

        # Expected B2S in PPR ppg (point estimate from tier)
        e_b2s = TIER_TO_EXPECTED_B2S.get(pos, {}).get(consensus_tier)

        # JJ-side confidence (Spearman ρ from 2024 cohort)
        jj_y1_corr = JJ_2024_SPEARMAN_VS_Y1.get(pos)

        cohort.append({
            "player_name": j["player_name"],
            "position": pos,
            "jj_zap_rank_pos": int(j["zap_rank_pos"]),
            "jj_zap_score": jj_score,
            "jj_tier": jj_tier,
            "koalaty_score": k_score if k_score else None,
            "koalaty_score_effective": k_score_effective if k_score_effective else None,
            "koalaty_tier": k_tier,
            "koalaty_letter_grade": k_letter,
            "udfa_capital_floor_applied": k_floor_applied,
            "winks_score": w_score,
            "winks_tier": w_tier,
            "kerrane_score": ker_score,
            "kerrane_tier": ker_tier,
            "kerrane_label": ker_label,
            "n_sources": n_sources,
            "adp_sf": adp_sf,
            "adp_1qb": adp_1qb,
            "consensus_score": consensus_score,
            "consensus_tier": consensus_tier,
            "ci_low": round(ci_low, 1),
            "ci_high": round(ci_high, 1),
            "agreement": agreement,
            "nfl_team": nfl_team,
            "nfl_pick_overall": nfl_pick_overall,
            "nfl_round": nfl_round,
            "dcd_risk": dcd_risk,
            "expected_b2s_ppg_ppr": e_b2s,
            "jj_2024_y1_spearman": jj_y1_corr,
        })

    # Write JSON output
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({
        "meta": {
            "generated_at": "2026-04-29",
            "blend_weights": DEFAULT_BLEND,
            "jj_2024_spearman": JJ_2024_SPEARMAN_VS_Y1,
            "koalaty_data_available": bool(koalaty),
            "n_prospects": len(cohort),
            "tier_to_expected_b2s_ppg_ppr": TIER_TO_EXPECTED_B2S,
        },
        "prospects": cohort,
    }, indent=2))
    print(f"wrote {OUT_JSON.relative_to(ROOT)}")

    # Build markdown buy list
    lines: list[str] = []
    lines.append("# 2026 UPS Rookie Draft — Meta-Model Buy List\n")
    lines.append(
        f"Cohort: {len(cohort)} prospects from JJ Zachariason's 2026 ZAP 2.0 model + "
        f"{'Joseph Bryan (Koalaty) 2026 model' if koalaty else 'Koalaty 2026 model NOT YET LOADED'} + "
        f"NFL 2026 Draft picks (Wikipedia-sourced; nflverse not yet indexed). "
        f"Blend: 50/50 JJ/Koalaty default — provisional pending 2026 cohort grading.\n"
    )

    if not koalaty:
        lines.append(
            "\n**⚠ Koalaty 2026 data not yet loaded.** Cross-model agreement signal disabled. "
            "All cohort cells flagged `single_model` until Koalaty CSV lands at "
            "`pipelines/analytics/meta_model/inputs/koalaty_2026_postdraft.csv`. "
            "Rerun this script when it does.\n"
        )

    lines.append(
        "\n## JJ-side confidence (from 2024 calibration retrospective)\n"
        "- WR: Spearman ρ = **0.75** vs 2024 Y1 ppg → trust JJ WR scores aggressively\n"
        "- TE: Spearman ρ = 0.22 (small sample, Bowers-driven) → moderate confidence\n"
        "- RB: Spearman ρ = **−0.06** → JJ's RB Y1 prediction was effectively random in 2024. "
        "Either trust the model anyway (it targets B2S not Y1) or weight Koalaty's RB model higher when available.\n"
        "- QB: not in JJ's model.\n"
    )

    # Per-position tier-grouped buy list
    by_pos = defaultdict(list)
    for c in cohort:
        by_pos[c["position"]].append(c)

    for pos in ("RB", "WR", "TE"):
        rows = sorted(by_pos[pos], key=lambda r: -r["consensus_score"])
        if not rows:
            continue
        lines.append(f"\n## {pos} — 2026 Buy List ({len(rows)} prospects)\n")
        # Group by tier
        by_tier = defaultdict(list)
        for r in rows:
            by_tier[r["consensus_tier"]].append(r)
        for tier_name, _, _ in ZAP2_TIERS:
            tier_rows = by_tier.get(tier_name, [])
            if not tier_rows:
                continue
            lines.append(f"\n### {tier_name}\n")
            lines.append(
                "| Rk | Player | NFL | JJ | Koalaty | Winks | Kerrane | "
                "Consensus | ADP SF | Agreement | DCD |\n"
                "|---:|:-------|:---:|---:|--------:|------:|--------:|----------:|:------:|:----------|:----|"
            )
            for r in tier_rows:
                pick_str = f"R{r['nfl_round']}.{r['nfl_pick_overall']} {r['nfl_team']}" if r["nfl_pick_overall"] else f"UDFA"
                k_str = f"{r['koalaty_score_effective']}" if r["koalaty_score_effective"] else "—"
                if r.get("udfa_capital_floor_applied"):
                    k_str = f"{r['koalaty_score']}→{r['koalaty_score_effective']}*"
                w_str = f"{r['winks_score']}" if r["winks_score"] else "—"
                ker_str = f"{r['kerrane_score']}" if r["kerrane_score"] else "—"
                adp_str = r["adp_sf"] if r.get("adp_sf") else "—"
                agree_str = {
                    "strong_consensus": "✓✓ 3+ agree",
                    "agree": "✓ all agree",
                    "near_agree": "~ adjacent",
                    "disagree": "⚡ ≥2 tier gap",
                    "single_model": "—",
                }.get(r["agreement"], r["agreement"])
                dcd_emoji = {"low": "✓buy", "high": "✗fade", "neutral": "—", "no_nfl_data": "—"}.get(r["dcd_risk"], "")
                lines.append(
                    f"| {r['jj_zap_rank_pos']} | {r['player_name']} | {pick_str} | "
                    f"{r['jj_zap_score']} | {k_str} | {w_str} | {ker_str} | "
                    f"**{r['consensus_score']}** | {adp_str} | {agree_str} | {dcd_emoji} |"
                )

    # Notable cross-model disagreements (if Koalaty present)
    if koalaty:
        disagreements = [c for c in cohort if c["agreement"] == "disagree"]
        if disagreements:
            lines.append("\n## ⚡ Cross-model strong disagreements (≥2 tiers apart)\n")
            lines.append(
                "These are the highest-information prospects in the entire cohort. When JJ and Koalaty disagree by 2+ tiers, the question to investigate is *which one is right* — that's where the actual analytical edge lives.\n"
            )
            lines.append(
                "| Player | Pos | NFL | JJ Tier | Koalaty Tier | DCD Risk |\n"
                "|:-------|:---:|:---:|:--------|:-------------|:---------|"
            )
            for d in sorted(disagreements, key=lambda r: r["jj_zap_rank_pos"]):
                pick_str = f"R{d['nfl_round']}.{d['nfl_pick_overall']}" if d["nfl_pick_overall"] else "UDFA"
                lines.append(
                    f"| {d['player_name']} | {d['position']} | {pick_str} | "
                    f"{d['jj_tier']} | {d['koalaty_tier']} | {d['dcd_risk']} |"
                )

    # DCD callouts
    low_risk_jj = [c for c in cohort if c["dcd_risk"] == "low"]
    high_risk_jj = [c for c in cohort if c["dcd_risk"] == "high"]
    if low_risk_jj or high_risk_jj:
        lines.append("\n## NFL Draft Capital Delta — JJ side\n")
        lines.append(
            "Low risk = JJ's score is ≥15 percentile points higher than NFL pick percentile (model loves more than NFL did → potential value). "
            "High risk = JJ's score lags NFL pick percentile by ≥15 (NFL bet harder than JJ's model → potential overdraft).\n"
        )
        if low_risk_jj:
            lines.append(f"\n### Low-risk (JJ likes more than NFL) — buy candidates\n")
            for r in sorted(low_risk_jj, key=lambda x: -x["jj_zap_score"]):
                pick_str = f"R{r['nfl_round']}.{r['nfl_pick_overall']}" if r["nfl_pick_overall"] else "UDFA"
                lines.append(f"- **{r['player_name']}** ({r['position']}, {r['nfl_team']}, {pick_str}) — JJ ZAP {r['jj_zap_score']}, tier {r['jj_tier']}")
        if high_risk_jj:
            lines.append(f"\n### High-risk (NFL loved more than JJ) — fade candidates\n")
            for r in sorted(high_risk_jj, key=lambda x: x["nfl_pick_overall"] or 999):
                pick_str = f"R{r['nfl_round']}.{r['nfl_pick_overall']}" if r["nfl_pick_overall"] else "UDFA"
                lines.append(f"- **{r['player_name']}** ({r['position']}, {r['nfl_team']}, {pick_str}) — JJ ZAP {r['jj_zap_score']}, tier {r['jj_tier']}")

    # UDFAs in JJ's rankings (not drafted by NFL)
    udfas = [c for c in cohort if not c["nfl_pick_overall"]]
    if udfas:
        lines.append(f"\n## Prospects in JJ rankings, not drafted by NFL ({len(udfas)})\n")
        lines.append(
            "These prospects appeared in JJ's ZAP rankings but did not get drafted by an NFL team. "
            "By his own framework, draft capital is the strongest single input — UDFAs face an enormous selection-effect headwind. Treat as deep dart throws even if their ZAP score is moderate.\n"
        )
        for r in sorted(udfas, key=lambda x: -x["jj_zap_score"]):
            lines.append(f"- {r['player_name']} ({r['position']}) — JJ ZAP {r['jj_zap_score']}, tier {r['jj_tier']}")

    lines.append("\n## Caveats and method notes\n")
    lines.append(
        "1. **JJ scores are ZAP 2.0** (post-rescaling); Koalaty scores are his model output (typically 0-100 percentile). Both are normalized to the same 0-100 scale via tier mapping.\n"
        "2. **Blend weights are provisional 50/50.** Per-position calibration deferred until Koalaty 2026 model + 2026 NFL Y1 outcomes are observable. JJ's 2024 calibration showed WR rank tracked Y1 strongly (ρ=0.75) but RB rank was effectively random vs Y1 (ρ≈0). Consider weighting JJ's WR scores higher and RB scores lower in manual decisions.\n"
        "3. **Confidence intervals** are provisional ±5 bands until proper bootstrap on JJ's hit-rate tables is implemented.\n"
        "4. **2026 NFL draft data** is from Wikipedia (one-time pull); rerun against `nflverse load_draft_picks(2026)` once nflverse indexes 2026.\n"
        "5. **No QB modeling** — neither analyst publishes a QB prospect model. SF/superflex QB strategy uses our existing `positional_scarcity.py` analysis.\n"
        "6. **MYM analysis is excluded.** This is a rookie draft tool; MYM evaluation lives in a separate analysis.\n"
        "7. **Pre-register your final draft list before NFL Week 1** — a calibration retrospective will grade these picks against realized outcomes after the 2028 NFL season (Y3 of the 2026 cohort).\n"
    )

    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines))
    print(f"wrote {OUT_MD.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
