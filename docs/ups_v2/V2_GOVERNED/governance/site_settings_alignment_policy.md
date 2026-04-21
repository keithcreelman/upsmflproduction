# Site Settings Alignment Policy

## Purpose
Every governed rule, workflow, and timing window in UPS_V2 must be cross-checked against the live source system settings when a corresponding MFL site setting or export field exists.
`rules_watch` owns the live cross-check loop; `data_governance` owns the alignment standard and review discipline.

## Core rule
Presence in UPS_V2 is not enough. A governed rule is not considered fully validated until it has been reviewed against the source system and its alignment status is recorded.

## Validation expectation
For each governed rule or workflow, UPS_V2 should record:
- whether a live MFL setting or export field exists for the concept
- what the source-system value currently is
- whether the governed UPS_V2 rule matches the live source system
- whether any difference is intentional override, suspected site misconfiguration, or rulebook drift
- what action is required to resolve the gap

## Alignment statuses
- `matched`
- `intentional_override`
- `site_settings_review_needed`
- `rule_review_needed`
- `no_direct_source_setting`
- `pending_live_validation`

## Resolution rule
If a governed rule and the live source system disagree, UPS_V2 must not silently pick one and move on.

The discrepancy must be classified as one of:
- the UPS rule is wrong and should be revised
- the MFL site settings are wrong and should be corrected
- the difference is intentional and must be documented as an explicit override
- the available source system does not have enough fidelity, so the rule remains governed by commissioner direction plus evidence

## Required artifacts
- `site_settings_alignment_register.csv`
- rule or workspace note showing validation result
- revision-log entry when a discrepancy changes governance or implementation

## Operational guidance
- Prefer live MFL exports or settings pages over stale local snapshots for current-year validation.
- Use local metadata and transaction history as supporting evidence, not as a substitute for current source-system validation when a live source exists.
- If the site settings do not look right, record that explicitly and route it either to rule cleanup or source-system setup correction.
- If an event is intentionally operationally fluid, record the actual timing and classify the difference instead of treating fluidity as a violation by itself.
