# Salary Adjustments Report Data Dictionary

## Source Architecture

The Salary Adjustments report is built from two normalized source paths plus an optional live reconciliation feed:

- `transactions_trades`
  Used for recorded traded-salary settlement rows where `salaryadjustment_ind = 1`.
- `transactions_adddrop` + `contract_history_transaction_snapshots`
  Used for projected drop-penalty candidate rows by matching the add/drop transaction to the pre-drop contract snapshot captured at that same transaction boundary.
- live MFL `salaryAdjustments` export
  Used at build time only, without storing raw feed rows in SQLite, to override drop-time contract state from `Dropped ...` marker rows and reconcile posted `YYYY_Cap_Penalties` totals. When the configured MFL URL is season-scoped, the exporter checks that season plus the source seasons present in the drop-base rows so carryover penalties can still reconcile against older marker seasons.
- manual `salary_adjustments_special_cases.json`
  Optional manual input for cap-free retirement / jail-bird exceptions that should stay visible in the report but should not produce importable charges.

The SQL file defines two build-time base views:

- `report_salary_adjustments_trade_base_v1`
- `report_salary_adjustments_drop_base_v1`

The report exporter then writes static JSON artifacts for the frontend:

- `salary_adjustments_manifest.json`
- `salary_adjustments_<season>.json`

A separate audit script can also write read-only comparison artifacts:

- `salary_adjustments_<season>_derived_vs_mfl_mismatches.json`
- `salary_adjustments_<season>_derived_vs_mfl_mismatches.csv`

## Core Fields

- `adjustment_season`
  The season in which the adjustment row applies.
- `franchise_id`
  Franchise identifier for the adjustment row.
- `franchise_name`
  Franchise display name.
- `adjustment_type`
  Current values:
  - `TRADED_SALARY`
  - `DROP_PENALTY_CANDIDATE`
- `source_table`
  Primary event spine for the row.
  - trade rows: `transactions_trades`
  - drop candidate rows: `transactions_adddrop`
- `source_id`
  Stable row-level source identifier.
  - trade rows: normalized trade transaction id
  - drop candidate rows: add/drop transaction id, with a season/txn fallback if needed
- `source_season`
  Source transaction season. Post-auction carryover drop penalties can roll into `adjustment_season = source_season + 1`.
- `player_id`
  Player identifier when the adjustment is player-linked.
- `player_name`
  Player display name. Trade rows may be blank when the salary adjustment is side-level rather than player-specific.
- `transaction_datetime_et`
  Eastern Time transaction timestamp.
- `amount`
  Signed integer dollar amount.
- `direction`
  UI-friendly direction derived from `amount`.
  - `charge`
  - `relief`
  - `review`
- `description`
  Human-readable adjustment explanation.
- `status`
  Current values:
  - `recorded`
  - `review_required`
  - `candidate`

## Trade Rows

Trade rows come directly from `transactions_trades`.

Field notes:

- `amount`
  Pulled from `asset_capadjustment`.
- `status = recorded`
  Used when `asset_capadjustment` is non-zero.
- `status = review_required`
  Used when `salaryadjustment_ind = 1` but the normalized amount is blank or zero.
- `description`
  Uses trade comments when present, otherwise a generic recorded-trade fallback.

## Drop Candidate Rows

Drop candidate rows are client-consumable ledger rows derived at export time.

Primary source fields:

- `event_source`
  Snapshot event source, usually `ADDDROP:FREE_AGENT` or `ADDDROP:BBID_WAIVER`.
- `drop_method`
  Add/drop method from `transactions_adddrop`.
- `pre_drop_salary`
  Pre-drop current-year salary, using `prior_salary` first and falling back to the snapshot salary.
- `pre_drop_contract_length`
  Pre-drop contract length.
- `pre_drop_tcv`
  Pre-drop total contract value.
- `pre_drop_contract_year`
  Pre-drop contract year index.
- `pre_drop_contract_status`
  Pre-drop contract status.
- `pre_drop_contract_info`
  Best available contract-info text from the chosen contract basis.
- `contract_basis_source`
  Source chosen for the drop-time contract state:
  - `live_marker`
  - `prior_season_rollforward`
  - `preceding_add_salary`
  - `snapshot_fallback`
- `marker_id`
  The exact `salaryAdjustment.id` value from the matched live MFL marker row.
- `marker_feed_export_season`
  Season of the live MFL `salaryAdjustments` export that supplied `marker_id`.
- `marker_match_status`
  Marker reconciliation result:
  - `matched_exact`
  - `matched_window`
  - `missing`
  - `ambiguous`
  - `feed_unavailable`
  - `not_applicable`
- `marker_description`
  Raw live `Dropped ...` marker description when matched.
- `marker_created_at_et`
  Eastern Time marker timestamp derived from the live feed timestamp when available.
- `reconciliation_status`
  High-level reconciliation result, for example:
  - `matched`
  - `marker_matched`
  - `team_total_matched`
  - `team_total_mismatch`
  - `unmatched_marker`
  - `feed_unavailable`
  - `not_applicable`
- `reconciliation_note`
  Human-readable explanation of the reconciliation result.
- `posted_team_season_cap_penalty`
  Posted live `YYYY_Cap_Penalties` amount for the row’s team and `adjustment_season`, when available.
- `computed_team_season_cap_penalty`
  Computed total of all drop-penalty rows for the row’s team and `adjustment_season`.
- `team_season_cap_penalty_delta`
  `computed_team_season_cap_penalty - posted_team_season_cap_penalty` when the live posted total exists.
- `original_guarantee`
  Guaranteed amount used by the penalty calculation. For `waiver_35pct` rows this is the current-year salary basis; for `guarantee_minus_earned` rows this is the guaranteed amount before earned salary is subtracted.
- `total_salary_earned`
  Total earned amount used by the calculation. This is currently `0` for `waiver_35pct` rows and earned-to-date for `guarantee_minus_earned` rows.
- `penalty_amount`
  Final projected penalty amount. This duplicates `amount` so downstream consumers can read the calculation fields together without reusing direction-aware report columns.
- `penalty_rule`
  Human-readable version of the applied rule, including the numeric basis used by the exporter.
- `import_eligible`
  Boolean gate used for the generated MFL XML import artifact. Review-required rows are not importable.
- `candidate_rule`
  Rule bucket used by the exporter:
  - `waiver_35pct`
  - `guarantee_minus_earned`
- `pre_exemption_penalty_amount`
  Raw projected penalty before any manual cap-free special-case override is applied.
- `cap_free_exemption_flag`
  Boolean flag indicating that a manual special-cases input marked the row as a cap-free exception candidate.
- `cap_free_exemption_type`
  Manual special-case category, for example:
  - `retired`
  - `jail_bird`
  - `suspended`
- `cap_free_exemption_note`
  Freeform operator note from the manual special-cases input.
- `cap_free_exemption_source`
  Source file used to apply the manual special-case flag.

## Drop Candidate Calculation

The exporter applies the rule after choosing the drop-time contract basis in this precedence order:

1. Matching live `Dropped ...` marker row
2. Prior-season same-owner contract rollforward
3. Same-owner preceding add salary for one-year `WW` / `ADD_DEFAULT_1YR`
4. Current transaction snapshot fallback

Then it reuses the current roster-workbench style rules in static form:

- One-year `VETERAN` / `WW` contracts under `$5,000` project to `$0`.
- One-year likely waiver pickups at `$5,000+` project to `35%` of current-year salary.
- Other eligible contracts project to:
  `guaranteed_value - earned_to_date`

Supporting definitions:

- `earned_to_date`
  Prior earned value from earlier contract years plus season-to-date prorated earnings for the current year.
- `guaranteed_value`
  Uses explicit `GTD` value from contract info when present.
  Otherwise:
  - `TCV - current_year_salary` when `TCV <= 4000`
  - `75% of TCV` otherwise

## Reconciliation Notes

- The live `salaryAdjustments` feed is used only at build time and is not persisted to SQLite.
- If a live feed is available for the source season, unmatched inferred drop rows are downgraded to `review_required`.
- When the configured MFL URL includes the current league year, the exporter also checks the source seasons present in the selected drop rows so older carryover penalties can still reconcile against their original `Dropped ...` marker season.
- Rolled-next-season drops require event-level marker reconciliation to remain importable.
- Team/season reconciliation compares computed drop totals to posted `YYYY_Cap_Penalties` rows when the live feed exposes those rows for the same season.
- Manual cap-free special cases stay visible as `review_required` rows with `amount = 0`, preserving the computed pre-exemption amount for audit while suppressing XML import output.

## Export Notes

- The frontend reads only static JSON written under `site/reports/salary_adjustments/`.
- CSV export stays summary-focused at the filtered row level.
- No UI selection state is persisted in the export.
- The derived-vs-MFL comparison artifact reads an existing `salary_adjustments_<season>.json` file plus the live/offline MFL `salaryAdjustments` feed and does not rebuild the main report.
- Comparison rows are mismatch-only and preserve the raw live marker `amount` text so MFL sentinel values like `2.2e-123` stay visible in the audit output.
