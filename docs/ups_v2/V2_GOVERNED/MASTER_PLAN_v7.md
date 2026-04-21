# UPS_V2 Master Plan v7

## Summary
- Planning order stays fixed: audit current live behavior, define target behavior, document the delta, then rebuild. No rewrite starts before those three artifacts are approved.
- Build `UPS_V2` in `/Users/keithcreelman/Documents/mfl/Codex/version2` with fresh Git history, new empty DBs, and no shared runtime with the current project. Originals remain untouched.
- SQLite remains the v1 operational store; BigQuery is the warehouse/reporting sink; MFL HPS edits stay minimal; `74598` is prod source, `25625` is primary test, and a later third environment supports 2027 future-lab work.
- Initial active standing lanes: `rules_watch`, `ux_review`, `data_governance`, `ops_runtime`, `mfl_matrix`. Deferred lane: `future_lab`, enabled in Phase 11+ only.
- Standing lane and agent instance are separate concepts. Live worker status belongs in `agent_assignment_view`, not in the architecture definition.

## Governance
- Anti-scope-creep rule: no new feature enters core implementation unless tied to an approved requirement, delta, ambiguity resolution, dependency unblock, or ADR. Everything else goes to `parking_lot` or `future_lab`.
- Phase re-entry rule: if a later phase uncovers a broken assumption, blocked dependency, unresolved ambiguity, or governance gap, an earlier phase may be formally re-opened through ADR and revision-log update before forward work continues.
- Current-to-V2 decision vocabulary: `keep | replace | merge | split | deprecate | defer`
- Publish object model:
  - `publish_unit_type = contract_action | roster_sync | tag_action | extension | restructure | trade_adjustment | rule_notice | site_release | config_change`
  - `publish_scope = prod_state | test_state | site_only | warehouse_only`
  - `approval_class = auto_blocked | single_approve | dual_approve | commissioner_only`
  - `verification_type = MFL_readback | ledger_parity | UI_parity | audit_only`
- Authoritative readback rule: no publishable unit requiring `MFL_readback` is complete until verification succeeds or the unit is explicitly marked `failed` or `reverted`.
- Canonical entity catalog:
  - `player`, `franchise`, `contract`, `contract_term`, `salary_adjustment`, `roster_assignment`, `tag`, `extension`, `restructure`, `mym_action`, `trade`, `trade_asset`, `pick`, `event_window`, `publish_batch`, `rule_directive`, `warning_state`, `eligibility_state`, `audit_event`
- Workflow state model:
  - `drafted`, `validated`, `blocked`, `approved`, `published`, `verified`, `reverted`, `expired`
- Warning/block policy:
  - `warn_only`, `soft_block`, `hard_block`, `commish_override_allowed`, `commish_override_forbidden`
- Evidence confidence:
  - `authoritative`, `verified_copy`, `secondary_evidence`, `inferred`, `disputed`
- Modeled-history versioning:
  - `model_version`, `input_snapshot_version`, `scoring_rule_basis_version`, `generated_at`, `regeneration_reason`
- Scheduler governance:
  - every job carries `timezone_owner`, `DST_holiday_handling`, `retry_policy`, `backfill_policy`, `overlap_policy`, `manual_rerun_rule`
- Dependency tracking:
  - every `dependency_register` item carries `severity = blocker | high | medium | low`
- Definition of parity:
  - `data_parity`, `workflow_parity`, `required_visual_parity`, `approved_non_parity`, `modeled_history_tolerance`
- Documentation gate rule: no cutover approval is valid unless all required documentation artifacts are present and approved.

## Lanes and agent model
- Standing lane = permanent function in the program.
- Agent instance = current Codex worker assigned to a standing lane.
- Every lane has a charter, responsibility list, named outputs, authority limits, handoffs, phase enablement, instruction version, and revision log.
- Every live worker assignment is tracked in `agent_assignment_view` with:
  - `agent_id`, `agent_name`, `lane`, `status`, `phase_enabled`, `primary_deliverables`, `handoff_required_to`, `instruction_version`, `notes`

## Phase plan with exit criteria
1. **Phase 0: Program Setup**  
   Create ADRs, revision logs, dependency register, phase gate template, `agent_registry`, and `agent_assignment_view`.  
   Exit: governance artifacts exist and every standing lane has a charter.
2. **Phase 1: Current-State Audit**  
   Inventory real surfaces, workflows, jobs, hardcoded values, rules evidence feeds, actors, and entry paths.  
   Exit: current surface inventory complete; hardcoded register complete; job inventory complete; rules-signal sources cataloged.
3. **Phase 2: Target Requirements And Gap Analysis**  
   Define V2 behavior for every audited surface, compare current vs target, and classify each item with `keep | replace | merge | split | deprecate | defer`. Lock permissions, non-functional requirements, warnings vs blocks, and click-depth goals.  
   Exit: every surface has a target decision and delta status; actor-permission matrix approved; non-functional requirements approved.
4. **Phase 3: Signal Intelligence And Observability**  
   Formalize `rules_watch` and `ux_review`, including intake model, event taxonomy, privacy boundaries, cadence, and outputs.  
   Exit: rules-watch intake approved; UX telemetry approved; neither lane has uncontrolled prod mutation.
5. **Phase 4: Full MFL And Event Matrix**  
   Review the full MFL Developers Page and related request/import references, then map UPS/NFL event windows using official NFL dates and current league dates.  
   Exit: every relevant endpoint is triaged; every event window is mapped to triggers, UI states, and rule windows.
6. **Phase 5: Business Truth And Rule Governance**  
   Lock the source-of-truth matrix, canonical entities, rule ambiguity register, commissioner-directive register, and evidence confidence rules.  
   Exit: no major business concept lacks an authoritative source; unresolved ambiguities are tracked and linked to workflows.
7. **Phase 6: Canonical Data Platform**  
   Define structural platform design only: schemas, entity/state contracts, retention rules, and new empty SQLite plus BigQuery dataset contracts.  
   Exit: schema dictionary drafted; interface contracts approved; cross-environment identity columns required.
8. **Phase 7: Raw Evidence, History, And Normalization**  
   Ingest immutable evidence, define modeled-history versioning, and build raw plus current-rules-normalized history side by side.  
   Exit: evidence pipeline defined; normalization lineage defined; tolerance rules documented.
9. **Phase 8: Runtime Isolation And Config**  
   Remove hardcoded runtime assumptions from design; define pinned constants and dependency ownership.  
   Exit: every retained hardcoded value is labeled; every runtime dependency has an owner and replacement path.
10. **Phase 9: Jobs, Environments, And Safety Rails**  
    Define operational execution only: jobs, schedules, environment boundaries, publish controls, and verification behavior.  
    Exit: every job has full scheduler metadata; every publishable unit has scope, approval class, and verification type.
11. **Phase 10: Site And Workflow Rebuild**  
    Rebuild `/site` around user tasks instead of historical `MESSAGE*` pages, with `ux_review` driving simplification and `rules_watch` supplying rule-context helpers.  
    Exit: every approved workflow has a V2 surface, state model, warning/block behavior, and coherent navigation.
12. **Phase 11: 2027 Future Lab**  
    Enable the `future_lab` lane and create the third environment and second test site for approved experiments only.  
    Exit: future_lab isolation is proven; promotion and retirement rules are documented.
13. **Phase 12: Warehouse, Models, And Reporting**  
    Load prod/test/future data to BigQuery and build commissioner vs league-facing reporting marts.  
    Exit: warehouse contracts approved; lineage and freshness validated.
14. **Phase 13: Parallel Run, Cutover, And Documentation**  
    Shadow-run V1 and UPS_V2, compare parity by category, prove rollback, and finalize documentation.  
    Exit: parity passes by approved definition, rollback is proven, all required documentation is present and approved, and cutover gate is approved.
