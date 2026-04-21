# Agent Operations Runbook

## Concepts
- Standing lane: permanent function in the program.
- Agent instance: current Codex worker assigned to a standing lane.

## Rules
- Lane charters live in `agent_registry.csv`.
- Live worker-to-lane assignments live in `agent_assignment_view.csv`.
- Any instruction change must update the worker row and append to `revision_log.md`.
- `future_lab` remains phase-disabled until Phase 11.
- No agent may publish to prod outside the approval and verification model.
- `data_governance` owns governance quality for naming discipline, source-of-truth control, promotion hygiene, and documentation completeness.
- No phase may be marked complete until a phase completion report is stored under `phase_reports/`.
- `handoff_required_to` must reference a lane that exists in `agent_registry.csv`.
- Every live assignment must record assignment provenance and deliverable evidence.
- When the user asks for Claude Code collaboration, takeover, or passdown support, create a dedicated Markdown handoff under `governance/handoffs/` with concrete directives, exact source paths, and explicit open-item notes instead of relying on chat text alone.

## Current implementation note
Session-local worker names are tracked operationally, not architecturally. If a worker changes, update the assignment view without changing the standing lane definition.
