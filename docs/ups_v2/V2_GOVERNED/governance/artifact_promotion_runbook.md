# Artifact Promotion Runbook

## Rule
A V1-derived artifact is not UPS_V2 truth just because it exists anywhere in the Codex workspace.

External source location:
- `/Users/keithcreelman/Documents/mfl/Codex/V1/reference_inputs/`

## Promotion steps
1. Identify the external V1 reference artifact and record its source path.
2. Review the artifact against current UPS_V2 requirements, phase gates, and open ambiguities.
3. Resolve or explicitly defer blocking issues.
4. Record approval in the relevant phase gate and ADR or revision log when needed.
5. Create or update the governed artifact in `V2_GOVERNED`.
6. Update the governed artifact registry with source path, promotion date, and approver.

## Guardrail
Presence is not approval.
Import is not endorsement.
