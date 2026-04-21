# Publish Object Model

## Fields
- `publish_unit_type`: `contract_action | roster_sync | tag_action | extension | restructure | trade_adjustment | rule_notice | site_release | config_change`
- `publish_scope`: `prod_state | test_state | site_only | warehouse_only`
- `approval_class`: `auto_blocked | single_approve | dual_approve | commissioner_only`
- `verification_type`: `MFL_readback | ledger_parity | UI_parity | audit_only`
- `source_environment`: required for every publishable unit
- `target_environment`: required for every publishable unit
- `approval_ref`: required for any unit that is not `auto_blocked`
- `verification_evidence_ref`: required for every completed unit
- `v1_v2_lineage_assertion`: required for any `prod_state` publish to prove the action originates from UPS_V2 governed logic only

## Completion rule
A publishable unit requiring `MFL_readback` is not complete until verification succeeds or the unit is explicitly marked `failed` or `reverted`.

## Boundary rule
No `prod_state` publish may proceed without explicit source and target environment identity, approval reference, and verification evidence reference.
