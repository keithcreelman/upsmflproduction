#!/usr/bin/env python3
"""
Cap-penalty calculator simulator.

Runs hand-crafted test scenarios through the era-aware calculator and
reports legacy + side-by-side era values. Test scenarios are pulled
from:
  - The worked examples in docs/league_context_v1.md (Section 6.C)
  - The Forumotion archive of the original commish loaded-rule writeup
    (services/rulebook/sources/rules/archive/UPS Contract Rules.txt
     + chronological/2011.md + Keith's 2026-05-08 quoted post)

Each scenario:
  - Documents the source (which section of league_context_v1.md or which
    forum/rulebook entry it came from)
  - Sets up the cycle inputs
  - Specifies expected values (the worked-example math)
  - Reports PASS/FAIL + actual vs expected

Run: python3 pipelines/etl/scripts/simulate_cap_penalty.py
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "pipelines" / "etl" / "lib"))

import cap_penalty as cp  # noqa: E402


def usd(n: int | None) -> str:
    if n is None:
        return "—"
    if n < 0:
        return f"-${abs(n):,} (credit)"
    return f"${n:,}"


def cycle(
    *,
    name_id: str,
    season: int,
    acquisition_path: str = "auction",
    acquisition_week: int = 0,
    contract_type: str = "auction",
    drop_date: date,
    drop_week: int | None,
    drop_reason: str = "cut",
    salary_at_drop_usd: int,
    tcv_at_drop_usd: int,
    contract_years_remaining: int,
    original_tcv_usd: int | None = None,
    actual_paid_total_usd: int = 0,
    weeks_active: int = 0,
    total_eligible_weeks: int = 17,
    contract_was_grandfathered: bool = False,
    contract_original_length_years: int = 1,
) -> cp.CycleInputs:
    """Convenience builder. original_tcv_usd defaults to tcv_at_drop_usd
    (treats the contract as original / not extended)."""
    return cp.CycleInputs(
        player_id=name_id, franchise_id="0001", season=season,
        acquisition_path=acquisition_path, acquisition_week=acquisition_week,
        contract_type=contract_type,
        drop_date=drop_date, drop_week=drop_week, drop_reason=drop_reason,
        salary_at_drop_usd=salary_at_drop_usd, tcv_at_drop_usd=tcv_at_drop_usd,
        contract_years_remaining=contract_years_remaining,
        original_tcv_usd=original_tcv_usd if original_tcv_usd is not None else tcv_at_drop_usd,
        actual_paid_total_usd=actual_paid_total_usd,
        weeks_active=weeks_active, total_eligible_weeks=total_eligible_weeks,
        contract_was_grandfathered=contract_was_grandfathered,
        contract_original_length_years=contract_original_length_years,
    )


def run_scenario(name: str, source: str, inputs: cp.CycleInputs, expected: dict) -> bool:
    out = cp.compute_cycle(inputs)
    failures = []
    for key, expected_val in expected.items():
        actual = getattr(out, key)
        if isinstance(expected_val, (int, float)) and isinstance(actual, (int, float)):
            if abs(actual - expected_val) > 1:
                failures.append((key, expected_val, actual))
        else:
            if actual != expected_val:
                failures.append((key, expected_val, actual))

    status = "✓ PASS" if not failures else "✗ FAIL"
    print(f"\n{'='*78}")
    print(f"{status}  {name}")
    print(f"  Source: {source}")
    print(f"  Drop:   {inputs.drop_date} (week {inputs.drop_week}) · {inputs.drop_reason} · {inputs.acquisition_path} contract")
    print(f"  Money:  TCV ${inputs.tcv_at_drop_usd:,} · year salary ${inputs.salary_at_drop_usd:,} · weeks_active {inputs.weeks_active}/{inputs.total_eligible_weeks}")
    print(f"          orig TCV ${inputs.original_tcv_usd:,} ({inputs.contract_original_length_years}yr) · already paid ${inputs.actual_paid_total_usd:,} · yrs_remaining {inputs.contract_years_remaining}")
    print(f"  GF:     {inputs.contract_was_grandfathered}")
    print(f"  Era:    {out.rule_era_at_drop}")
    print(f"  Legacy: earned={usd(out.earned_legacy_usd)} penalty={usd(out.penalty_legacy_usd)}"
          + (f" (cap-free: {out.cap_free_reason})" if out.cap_free else ""))
    print(f"  Comparison columns:")
    print(f"    pre-2019 (loaded-aware): earned={usd(out.earned_pre2019_usd):>20}  penalty={usd(out.penalty_pre2019_usd):>20}")
    print(f"    2019 calendar-month    : earned={usd(out.earned_calendar_monthly_usd):>20}  penalty={usd(out.penalty_calendar_monthly_usd):>20}")
    print(f"    2026 per-week          : earned={usd(out.earned_per_week_usd):>20}  penalty={usd(out.penalty_per_week_usd):>20}")

    if failures:
        print(f"  FAILURES:")
        for key, exp, act in failures:
            print(f"    {key}: expected {usd(exp) if isinstance(exp,(int,float)) else exp}, got {usd(act) if isinstance(act,(int,float)) else act}")
    return not failures


def main():
    scenarios = []

    # ===== ERA 1 — pre-2019 flat / loaded correction =========================

    # --- Forum: 2-yr $50K/yr STRAIGHT, cut after Y1 ---
    scenarios.append(dict(
        name="[Forum] 2-yr $50K straight, cut after Y1 → $10K",
        source="Forumotion commish post (loaded-rule writeup) — straight reference",
        inputs=cycle(
            name_id="forum_straight_2yr", season=2017,
            drop_date=date(2017, 11, 15), drop_week=10, drop_reason="cut",
            salary_at_drop_usd=50_000, tcv_at_drop_usd=100_000,
            contract_years_remaining=1,                # Y1 fully played, now in Y2
            original_tcv_usd=100_000,
            actual_paid_total_usd=50_000,              # Y1 played out
            contract_original_length_years=2,
        ),
        expected=dict(
            rule_era_at_drop="era_pre_2019_flat",
            penalty_legacy_usd=10_000,
        ),
    ))

    # --- Forum: 2-yr backload $35/$65, cut after Y1 → $25K (loaded correction kicks in) ---
    scenarios.append(dict(
        name="[Forum] 2-yr backload $35/$65, cut after Y1 → $25K",
        source="Forumotion commish post — backloaded penalty correction example",
        inputs=cycle(
            name_id="forum_backload_2yr_y1cut", season=2017,
            drop_date=date(2017, 11, 15), drop_week=10, drop_reason="cut",
            salary_at_drop_usd=65_000,                 # Y2 salary (current year at drop)
            tcv_at_drop_usd=100_000,
            contract_years_remaining=1,                # Y1 done, now in Y2
            original_tcv_usd=100_000,
            actual_paid_total_usd=35_000,              # Y1 paid $35K
            contract_original_length_years=2,
        ),
        expected=dict(
            rule_era_at_drop="era_pre_2019_flat",
            penalty_legacy_usd=25_000,                 # target $60 - actual $35 = $25
        ),
    ))

    # --- Forum: 2-yr frontload $65/$35, cut after Y1 → $5K CREDIT ---
    scenarios.append(dict(
        name="[Forum] 2-yr frontload $65/$35, cut after Y1 → $5K credit",
        source="Forumotion commish post — frontloaded credit example",
        inputs=cycle(
            name_id="forum_frontload_2yr_y1cut", season=2017,
            drop_date=date(2017, 11, 15), drop_week=10, drop_reason="cut",
            salary_at_drop_usd=35_000,                 # Y2 salary
            tcv_at_drop_usd=100_000,
            contract_years_remaining=1,
            original_tcv_usd=100_000,
            actual_paid_total_usd=65_000,              # Y1 paid $65K
            contract_original_length_years=2,
        ),
        expected=dict(
            rule_era_at_drop="era_pre_2019_flat",
            penalty_legacy_usd=-5_000,                 # target $60 - actual $65 = -$5K credit
        ),
    ))

    # --- Forum: 3-yr $50K straight, cut after Y2 → $10K ---
    scenarios.append(dict(
        name="[Forum] 3-yr $50K straight, cut after Y2 → $10K",
        source="Forumotion commish post — 3-yr straight reference",
        inputs=cycle(
            name_id="forum_straight_3yr_y2cut", season=2017,
            drop_date=date(2017, 11, 15), drop_week=10, drop_reason="cut",
            salary_at_drop_usd=50_000,                 # Y3 salary (current at drop)
            tcv_at_drop_usd=150_000,
            contract_years_remaining=1,                # Y1+Y2 done, now in Y3
            original_tcv_usd=150_000,
            actual_paid_total_usd=100_000,             # Y1+Y2 = $100K
            contract_original_length_years=3,
        ),
        expected=dict(
            rule_era_at_drop="era_pre_2019_flat",
            penalty_legacy_usd=10_000,                 # target $110 - $100 = $10
        ),
    ))

    # --- Forum: 3-yr backload $23/$53/$74, cut after Y2 → $34K ---
    scenarios.append(dict(
        name="[Forum] 3-yr backload $23/$53/$74, cut after Y2 → $34K",
        source="Forumotion commish post — 3-yr backload correction example",
        inputs=cycle(
            name_id="forum_backload_3yr_y2cut", season=2017,
            drop_date=date(2017, 11, 15), drop_week=10, drop_reason="cut",
            salary_at_drop_usd=74_000,
            tcv_at_drop_usd=150_000,
            contract_years_remaining=1,
            original_tcv_usd=150_000,
            actual_paid_total_usd=76_000,              # $23 + $53
            contract_original_length_years=3,
        ),
        expected=dict(
            rule_era_at_drop="era_pre_2019_flat",
            penalty_legacy_usd=34_000,                 # target $110 - $76 = $34
        ),
    ))

    # --- Forum: 3-yr frontload $75/$51/$24, cut after Y2 → $16K credit ---
    scenarios.append(dict(
        name="[Forum] 3-yr frontload $75/$51/$24, cut after Y2 → $16K credit",
        source="Forumotion commish post — 3-yr frontload credit example",
        inputs=cycle(
            name_id="forum_frontload_3yr_y2cut", season=2017,
            drop_date=date(2017, 11, 15), drop_week=10, drop_reason="cut",
            salary_at_drop_usd=24_000,
            tcv_at_drop_usd=150_000,
            contract_years_remaining=1,
            original_tcv_usd=150_000,
            actual_paid_total_usd=126_000,             # $75 + $51
            contract_original_length_years=3,
        ),
        expected=dict(
            rule_era_at_drop="era_pre_2019_flat",
            penalty_legacy_usd=-16_000,                # target $110 - $126 = -$16K credit
        ),
    ))

    # --- Pre-2019 buffer-zone exemption: <$5K TCV ---
    scenarios.append(dict(
        name="[Pre-2019] sub-$5K TCV is exempt (1-yr $4K WW)",
        source="UPS Dynasty Cap Rulebook 2013.1.txt:145 — '<$5K = no penalty'",
        inputs=cycle(
            name_id="cheap_player", season=2014,
            acquisition_path="ww", acquisition_week=8, contract_type="ww",
            drop_date=date(2014, 11, 5), drop_week=10, drop_reason="cut",
            salary_at_drop_usd=4_000, tcv_at_drop_usd=4_000,
            contract_years_remaining=1, contract_original_length_years=1,
            actual_paid_total_usd=0,
            weeks_active=2, total_eligible_weeks=9,
        ),
        expected=dict(
            rule_era_at_drop="era_pre_2019_flat",
            penalty_legacy_usd=0,
            cap_free=True,
        ),
    ))

    # ===== ERA 2 — 2019 calendar-monthly =====================================

    scenarios.append(dict(
        name="[Era 2019] front-loaded $40K Y1 cut Oct 15 (Y1 cut, snapshot earning only)",
        source="docs/league_context_v1.md Section 6 worked examples",
        inputs=cycle(
            name_id="frontload_y1", season=2024,
            drop_date=date(2024, 10, 15), drop_week=6, drop_reason="cut",
            salary_at_drop_usd=40_000, tcv_at_drop_usd=90_000,
            contract_years_remaining=3, contract_original_length_years=3,
            original_tcv_usd=90_000, actual_paid_total_usd=0,  # Y1 cut, nothing paid yet
            weeks_active=6, total_eligible_weeks=17,
        ),
        expected=dict(
            rule_era_at_drop="era_2019_calendar_monthly",
            earned_legacy_usd=10_000,
            penalty_legacy_usd=57_500,
        ),
    ))

    scenarios.append(dict(
        name="[Era 2019] 3-yr $30K straight cut March of Y2 (snapshot only — caller adds Y1-paid carry-forward)",
        source="docs/league_context_v1.md D1 'Confirmed example'",
        inputs=cycle(
            name_id="conf_example", season=2025,
            drop_date=date(2025, 3, 15), drop_week=None, drop_reason="cut",
            salary_at_drop_usd=30_000, tcv_at_drop_usd=90_000,
            contract_years_remaining=2, contract_original_length_years=3,
            original_tcv_usd=90_000, actual_paid_total_usd=30_000,  # Y1 played out
            weeks_active=17, total_eligible_weeks=17,
        ),
        # March cut: 0% earned for current year per calendar-month curve.
        # Caller upstream is responsible for adding prior-year carry-forward
        # to total earned. The calculator returns the snapshot value.
        expected=dict(
            rule_era_at_drop="era_2019_calendar_monthly",
            penalty_legacy_usd=67_500,                 # ($90 × 75%) − $0 = $67.5
        ),
    ))

    scenarios.append(dict(
        name="[Era 2019] WW $25K pickup Oct 5, dropped Nov 5 — flat 35% override",
        source="docs/league_context_v1.md Section 6.C4.7 (legacy)",
        inputs=cycle(
            name_id="ww_25k", season=2024,
            acquisition_path="ww", acquisition_week=5, contract_type="ww",
            drop_date=date(2024, 11, 5), drop_week=9, drop_reason="cut",
            salary_at_drop_usd=25_000, tcv_at_drop_usd=25_000,
            contract_years_remaining=1, contract_original_length_years=1,
            original_tcv_usd=25_000, actual_paid_total_usd=0,
            weeks_active=4, total_eligible_weeks=13,
        ),
        expected=dict(
            rule_era_at_drop="era_2019_calendar_monthly",
            penalty_legacy_usd=8_750,                  # 35% × $25K
        ),
    ))

    scenarios.append(dict(
        name="[Era 2019] WW under $4K cut anytime → cap-free",
        source="Bot Grounding clarification — 'Cap-penalty-free pickups'",
        inputs=cycle(
            name_id="ww_3k", season=2024,
            acquisition_path="ww", acquisition_week=5, contract_type="ww",
            drop_date=date(2024, 11, 5), drop_week=9, drop_reason="cut",
            salary_at_drop_usd=3_000, tcv_at_drop_usd=3_000,
            contract_years_remaining=1, contract_original_length_years=1,
            original_tcv_usd=3_000, actual_paid_total_usd=0,
            weeks_active=4, total_eligible_weeks=13,
        ),
        expected=dict(
            penalty_legacy_usd=0,
            cap_free=True,
        ),
    ))

    # ===== ERA 3 — 2026-05-08 per-week =======================================

    scenarios.append(dict(
        name="[Era 2026+] auction $40K Y1 cut after Week 5 (5/17 × $40K = $11,765 earned)",
        source="docs/league_context_v1.md Section 6.C2 (UPDATED 2026-05-08)",
        inputs=cycle(
            name_id="newrule_auction", season=2026,
            drop_date=date(2026, 10, 15), drop_week=6, drop_reason="cut",
            salary_at_drop_usd=40_000, tcv_at_drop_usd=90_000,
            contract_years_remaining=3, contract_original_length_years=3,
            original_tcv_usd=90_000, actual_paid_total_usd=0,
            weeks_active=5, total_eligible_weeks=17,
        ),
        expected=dict(
            rule_era_at_drop="era_2026_05_08_per_week",
            earned_legacy_usd=11_765,
            penalty_legacy_usd=55_735,
        ),
    ))

    scenarios.append(dict(
        name="[Era 2026+] WW $25K pickup Week 5, dropped after Week 9 (4/13 × $25K = $7,692)",
        source="docs/league_context_v1.md Section 6.C3 example",
        inputs=cycle(
            name_id="newrule_ww", season=2026,
            acquisition_path="ww", acquisition_week=5, contract_type="ww",
            drop_date=date(2026, 11, 5), drop_week=9, drop_reason="cut",
            salary_at_drop_usd=25_000, tcv_at_drop_usd=25_000,
            contract_years_remaining=1, contract_original_length_years=1,
            original_tcv_usd=25_000, actual_paid_total_usd=0,
            weeks_active=4, total_eligible_weeks=13,
        ),
        expected=dict(
            rule_era_at_drop="era_2026_05_08_per_week",
            earned_legacy_usd=7_692,
            penalty_legacy_usd=11_058,
        ),
    ))

    scenarios.append(dict(
        name="[Era 2026+] offseason cut (no games played yet) → no earning",
        source="Keith — 'cuts made this off-season aren't impacted because no games yet'",
        inputs=cycle(
            name_id="offseason_cut", season=2026,
            drop_date=date(2026, 7, 15), drop_week=None, drop_reason="cut",
            salary_at_drop_usd=30_000, tcv_at_drop_usd=60_000,
            contract_years_remaining=2, contract_original_length_years=2,
            original_tcv_usd=60_000, actual_paid_total_usd=0,
            weeks_active=0, total_eligible_weeks=17,
        ),
        expected=dict(
            rule_era_at_drop="era_2026_05_08_per_week",
            penalty_legacy_usd=45_000,                 # ($60K × 75%) − $0
        ),
    ))

    # ===== Grandfather + edge cases ==========================================

    scenarios.append(dict(
        name="[GF] Grandfathered contract cut Y2 in 2020 → pre-2019 flat with loaded correction",
        source="UPS Contract Rules.txt:37-39 — GF persists until contract is touched",
        inputs=cycle(
            name_id="gf_contract", season=2020,
            drop_date=date(2020, 10, 15), drop_week=6, drop_reason="cut",
            salary_at_drop_usd=20_000, tcv_at_drop_usd=60_000,
            contract_years_remaining=2, contract_original_length_years=3,
            original_tcv_usd=60_000, actual_paid_total_usd=20_000,  # Y1 ($20K) played out
            weeks_active=6, total_eligible_weeks=16,
            contract_was_grandfathered=True,
        ),
        expected=dict(
            rule_era_at_drop="era_pre_2019_flat",
            # AAV=$20, years_played=1, target=$20+0.20×$20×2=$28, paid=$20
            # cap_hit = $28-$20 = $8K
            penalty_legacy_usd=8_000,
        ),
    ))

    scenarios.append(dict(
        name="[Edge] Multi-year low TCV (TCV < $5K, > 1 yr remaining) → fixed $1K",
        source="docs/league_context_v1.md Bot Grounding 'Multi-year low-TCV penalty'",
        inputs=cycle(
            name_id="multi_low_tcv", season=2026,
            drop_date=date(2026, 8, 15), drop_week=None, drop_reason="cut",
            salary_at_drop_usd=2_000, tcv_at_drop_usd=4_000,
            contract_years_remaining=2, contract_original_length_years=2,
            original_tcv_usd=4_000, actual_paid_total_usd=0,
            weeks_active=0, total_eligible_weeks=17,
        ),
        expected=dict(
            penalty_legacy_usd=1_000,
        ),
    ))

    scenarios.append(dict(
        name="[Edge] Taxi never permanently promoted → cap-free",
        source="docs/league_context_v1.md B2 + D2",
        inputs=cycle(
            name_id="taxi_drop", season=2024,
            acquisition_path="rookie_draft", contract_type="rookie",
            drop_date=date(2024, 10, 15), drop_week=6, drop_reason="taxi_drop",
            salary_at_drop_usd=2_000, tcv_at_drop_usd=6_000,
            contract_years_remaining=2, contract_original_length_years=3,
            original_tcv_usd=6_000, actual_paid_total_usd=0,
            weeks_active=0, total_eligible_weeks=17,
        ),
        expected=dict(
            penalty_legacy_usd=0,
            cap_free=True,
        ),
    ))

    # ===== Run all =========================================================
    passed = 0; failed = 0
    for s in scenarios:
        ok = run_scenario(s["name"], s["source"], s["inputs"], s["expected"])
        if ok: passed += 1
        else:  failed += 1

    print(f"\n{'='*78}")
    print(f"SUMMARY: {passed}/{passed+failed} scenarios passed")
    if failed:
        print(f"⚠️  {failed} scenarios failed — investigate before proceeding to backfill.")
        sys.exit(1)
    print("✓ All scenarios passed. Calculator math matches league_context worked examples")
    print("  AND the Forumotion loaded-rule worked examples from the original commish post.")


if __name__ == "__main__":
    main()
