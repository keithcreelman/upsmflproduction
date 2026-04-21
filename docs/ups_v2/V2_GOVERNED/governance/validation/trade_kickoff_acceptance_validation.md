# Trade Kickoff Acceptance Validation

## Purpose
Empirically validate how MFL behaves when an owner tries to accept a pending trade that includes a player whose NFL game has already started. This validation must be run on the test league `25625`, not on the production league.

## Scheduled execution window
- environment: `test_state`
- league_id: `25625`
- target season: `2026`
- target start: Week 1 of the 2026 NFL season
- kickoff anchor: first live Week 1 game after `2026-09-10`

## Why this test exists
UPS_V2 wants a deferred-next-week handling model for trades involving already-started players, but official MFL documentation does not explicitly confirm whether `tradeResponse=accept` is allowed in that case. This test exists to capture the real source-system behavior and close the open governance items before production logic depends on an assumption.

## Preconditions
- run only on test league `25625`
- use a real pending trade in MFL between controlled test franchises
- include at least one player whose NFL game has already started for the relevant scoring week
- preserve raw request and response evidence
- capture current pending trade state before attempting acceptance

## Test steps
1. Create or stage a pending trade in `25625` involving at least one player whose Week 1 game has already started.
2. Confirm the trade appears in `pendingTrades`.
3. Attempt `tradeResponse` acceptance through the governed test flow.
4. Capture raw MFL response text, status, and any downstream pending-trade, transaction, and roster effects.
5. Classify the result as one of:
   - `accept_blocked_by_mfl`
   - `accept_allowed_but_not_processed_same_week`
   - `accept_allowed_and_processed_same_week`
   - `inconclusive`
6. Update `SSA-007` and `AMB-009` with the observed source-system behavior.
7. Store a markdown report with evidence, outcome, and recommendation.

## Required evidence
- request timestamp in ET and UTC
- target franchises
- involved player ids
- kickoff status of involved players
- raw MFL response preview
- pendingTrades before and after
- transactions export after attempt
- roster export after attempt if needed

## Exit criteria
- MFL behavior is classified with evidence
- `SSA-007` is updated from `pending_live_validation`
- `AMB-009` is either resolved or tightened with explicit observed limits
- a validation report is stored in governed documentation
