# Salary Adjustments Report Data Dictionary

## Source Architecture

The initial Salary Adjustments report is built from two normalized source paths:

- `transactions_trades`
  Used for recorded traded-salary settlement rows where `salaryadjustment_ind = 1`.
- `transactions_adddrop` + `contract_history_transaction_snapshots`
  Used for projected drop-penalty candidate rows by matching the add/drop transaction to the pre-drop contract snapshot captured at that same transaction boundary.

The SQL file defines two build-time base views:

- `report_salary_adjustments_trade_base_v1`
- `report_salary_adjustments_drop_base_v1`

The report exporter then writes static JSON artifacts for the frontend:

- `salary_adjustments_manifest.json`
- `salary_adjustments_<season>.json`

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
  Source transaction season. Currently the same as `adjustment_season`, but left separate for future roll-forward support.
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
  Best available contract-info text from the snapshot.
- `candidate_rule`
  Rule bucket used by the exporter:
  - `waiver_35pct`
  - `guarantee_minus_earned`

## Drop Candidate Calculation

The exporter reuses the current roster-workbench style rules in static form:

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

## Source Gaps

- The initial report does not ingest a final posted `salaryAdjustments` ledger export from MFL into SQLite.
  Because of that:
  - trade rows are treated as recorded from normalized accepted trade history
  - drop rows are explicitly labeled `candidate`, not posted adjustments
- Explicit `GTD` overrides are parsed from contract-info text when available, but many historical drop snapshots only expose inferred contract values.
- Trade salary rows are often side-level adjustments and may not map cleanly to a single player.

## Export Notes

- The frontend reads only static JSON written under `site/reports/salary_adjustments/`.
- CSV export stays summary-focused at the filtered row level.
- No UI selection state is persisted in the export.
