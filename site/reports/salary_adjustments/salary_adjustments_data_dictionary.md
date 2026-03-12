# Salary Adjustments Report Data Dictionary

## Source Architecture

The initial Salary Adjustments report is built from two normalized source paths:

- `transactions_trades`
  Used for recorded traded-salary settlement rows where `salaryadjustment_ind = 1`.
- `transactions_adddrop` + `contract_history_transaction_snapshots`
  Used for projected drop-penalty candidate rows by matching the add/drop transaction to the pre-drop contract snapshot captured at that same transaction boundary.
- live MFL `salaryAdjustments` marker rows
  Used, when configured, as the authoritative drop-time contract state for `Dropped ...` rows. These tiny-amount marker rows preserve the player salary/contract context at the exact time of the cut.

The SQL file defines two build-time base views:

- `report_salary_adjustments_trade_base_v1`
- `report_salary_adjustments_drop_base_v1`

The report exporter then writes static JSON artifacts for the frontend:

- `salary_adjustments_manifest.json`
- `salary_adjustments_<season>.json`
- `pipelines/etl/artifacts/mfl_salary_adjustments_<season>.xml`

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
  Source transaction season. Trade rows stay in the current season. Drop rows can differ from `adjustment_season` when the drop occurs on or after the first FreeAgent auction start and therefore rolls into the following adjustment season.
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

## Machine Fields For Import And Merging

- `bucket`
  Canonical ledger bucket used by Front Office aggregation and report import actions.
  Current values:
  - `traded_salary`
  - `cut_players`
- `ledger_key`
  Stable de-dupe key embedded into `import_explanation` as `ref=...`.
  This is the canonical identifier used to skip already-posted MFL salary adjustments.
- `trade_id`
  Parsed trade identifier when derivable from trade group or transaction identifiers.
  Blank for cut rows.
- `import_eligible`
  Boolean flag used by the report UI and XML exporter.
  Rules:
  - `TRADED_SALARY` with non-zero `amount` and not `review_required` -> `true`
  - `DROP_PENALTY_CANDIDATE` rows with sufficient contract evidence -> `true`
  - post-auction carryover drop rows that only have local fallback context -> `false`
  - `review_required` rows -> `false`
- `import_target_season`
  Season passed to MFL import and used for XML partitioning.
  Matches `adjustment_season`.
- `import_explanation`
  Canonical explanation text posted to MFL `salaryAdj`.
  Format:
  - trade: `UPS cap adjustment | type=trade | season=<season> | trade_id=<trade_id> | ref=<ledger_key> | amount=<amount>`
  - cut: `UPS cap adjustment | type=cut | season=<season> | player=<player_name> | ref=<ledger_key> | amount=<amount>`

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

Contract-source fields:

- `drop_contract_source`
  Current values:
  - `live_marker`
  - `snapshot_inferred`
- `drop_marker_description`
  Raw live marker description when a matching `Dropped ...` row was found.
- `drop_marker_created_at_et`
  Marker timestamp from the live feed, converted to ET.
- `drop_marker_match_delta_seconds`
  Absolute timestamp delta between the add/drop transaction row and the matched marker.
- `drop_snapshot_salary`
- `drop_snapshot_contract_info`
- `drop_snapshot_contract_status`
- `drop_snapshot_contract_length`
- `drop_snapshot_contract_year`
- `drop_snapshot_tcv`
- `drop_snapshot_year_values_json`
  Diagnostic fields that preserve the best local fallback context that would have been used without a live marker.
- `drop_contract_mismatch_flag`
- `drop_contract_mismatch_reason`
  Raised when the live marker disagrees with the local fallback context.
- `drop_feed_available`
  `true` when a live feed was configured and usable for the build.

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
  Final contract-info text used for the row after applying live marker overrides when present.
- `candidate_rule`
  Rule bucket used by the exporter:
  - `waiver_35pct`
  - `guarantee_minus_earned`
- `adjustment_season`
  Effective adjustment season after applying the FreeAgent auction cutoff:
  - drop before the first FreeAgent auction start for that source season -> current/source season
  - drop on or after the first FreeAgent auction start for that source season -> following season

## Drop Candidate Calculation

The exporter reuses the current roster-workbench style rules in static form:

- One-year `VETERAN` / `WW` contracts under `$5,000` project to `$0`.
- One-year likely waiver pickups at `$5,000+` project to `35%` of current-year salary.
- Other eligible contracts project to:
  `guaranteed_value - earned_to_date`

Season assignment rule:

- trade adjustments always stay in the transaction season
- drop adjustments use the first `transactions_auction.auction_type = 'FreeAgent'` timestamp for that source season as the cutoff

Supporting definitions:

- `earned_to_date`
  Prior earned value from earlier contract years plus season-to-date prorated earnings for the current year.
- `guaranteed_value`
  Uses explicit `GTD` value from contract info when present.
  Otherwise:
  - `TCV - current_year_salary` when `TCV <= 4000`
  - `75% of TCV` otherwise

## Source Gaps

- The report still relies on static normalized trade/add-drop history plus an optional live `salaryAdjustments` feed.
  Because of that:
  - trade rows are treated as recorded from normalized accepted trade history
  - drop rows remain projected ledger rows, even when marker-backed
- Post-auction carryover drop rows are review-only when no matching live marker is available.
- Explicit `GTD` overrides are parsed from contract-info text when available, but many historical drop snapshots only expose inferred contract values.
- Trade salary rows are often side-level adjustments and may not map cleanly to a single player.

## Export Notes

- The frontend reads only static JSON written under `site/reports/salary_adjustments/`.
- The report UI defaults row selection to all `import_eligible` rows for the active season.
- The report UI can download filtered/selected `salaryAdj` XML or post selected rows through the worker import endpoint.
- CSV export includes ledger/import fields at the filtered row level.
- No UI selection state is persisted in the export.
- Front Office uses this report ledger as the authoritative source for trade and cut adjustments, then layers live MFL `salaryAdjustments` rows only for manual or unmatched `other` adjustments.
