# Rules Watch Lane Policy

## Purpose
`rules_watch` is the standing lane for continuous rules intake, precedent capture, live MFL site-settings/export cross-checking, and drift detection for every governed rule or workflow that has a source-system equivalent.

## Scope
This lane monitors and records:
- commissioner directives
- rulebook language
- forum, Slack, and Discord precedent
- live MFL site settings
- live MFL exports
- operational timing drift for league events

`rules_watch` does not mutate prod state. It captures evidence, classifies mismatches, and routes issues to the correct governed owner lane.

## Standing duty
For every governed rule or workflow with a source-system equivalent, `rules_watch` must:
1. identify the live MFL setting, export field, or source page that represents the concept
2. compare the live source value against the governed UPS_V2 rule
3. record the result in `site_settings_alignment_register.csv`
4. flag rulebook drift, source-system drift, or intentional override explicitly
5. route unresolved gaps to `data_governance` and `ops_runtime` for follow-up

## Alignment status meanings
- `matched`: the governed rule and live source agree
- `intentional_override`: the governed rule intentionally differs from the live source and the difference is documented
- `site_settings_review_needed`: the live source appears wrong or misconfigured
- `rule_review_needed`: the governed rule should be reconsidered
- `no_direct_source_setting`: there is no direct MFL setting or export field for the concept
- `pending_live_validation`: the live check has not been completed yet

## Timing guidance
- free-agent auction timing normally targets the last weekend of July
- the actual auction date may move for league availability and commissioner logistics
- operationally fluid timing is not a violation by itself
- the final cut-down day normally lands within 48 hours before auction start so cap hits and roster accounting can be finalized before bidding

## Outputs
`rules_watch` should keep the following outputs current:
- `rules_watch_digest`
- `rule_question_queue`
- `directive_capture_log`
- `suggestion_tracking_log`
- `site_settings_mismatch_log`

## Escalation rule
If live source behavior diverges from the governed rule, the mismatch must be classified and logged. Do not silently choose one side.

If the live MFL source is missing the necessary fidelity, classify the item as `no_direct_source_setting` and keep the governed basis explicit until more evidence arrives.
