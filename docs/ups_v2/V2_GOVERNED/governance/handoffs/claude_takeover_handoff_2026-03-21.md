# Claude Takeover Handoff

Last updated: `2026-03-21`

## 1. Core objective
- Rebuild the current UPS / MFL system as `UPS_V2` without touching the live legacy system.
- Keep `V1` quarantined as reference input only.
- Use current-state audit plus governed promotion, not blind carry-forward.
- Keep MFL HPS changes minimal.
- Keep `74598` as prod source, `25625` as primary test league, and defer the third future-lab environment until Phase 11.

## 2. Absolute locations

### Legacy live project (`V1`)
- Main live legacy repo: [`/Users/keithcreelman/Documents/New project`](/Users/keithcreelman/Documents/New project)

### V1 quarantined reference inputs
- V1 reference root: [`/Users/keithcreelman/Documents/mfl/Codex/V1`](/Users/keithcreelman/Documents/mfl/Codex/V1)
- V1 reference inputs used for UPS_V2 promotion workflow: [`/Users/keithcreelman/Documents/mfl/Codex/V1/reference_inputs/ups_v2/V1_REFERENCE`](/Users/keithcreelman/Documents/mfl/Codex/V1/reference_inputs/ups_v2/V1_REFERENCE)
- Legacy snapshot used for code/rule/history reference: [`/Users/keithcreelman/Documents/mfl/Codex/V1/legacy_snapshot`](/Users/keithcreelman/Documents/mfl/Codex/V1/legacy_snapshot)

### Clean rebuild (`UPS_V2`)
- UPS_V2 repo root: [`/Users/keithcreelman/Documents/mfl/Codex/version2`](/Users/keithcreelman/Documents/mfl/Codex/version2)
- Governed docs root: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED)
- Runtime config: [`/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/config/ups_v2.env.example`](/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/config/ups_v2.env.example)
- Runtime SQL scaffold: [`/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/sql/0001_governance_foundation.sql`](/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/sql/0001_governance_foundation.sql)

### Runtime DB files
- Prod mirror SQLite: [`/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_prod_mirror.sqlite`](/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_prod_mirror.sqlite)
- Test working SQLite: [`/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_test_working.sqlite`](/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_test_working.sqlite)
- Future lab SQLite: [`/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_future_lab_2027.sqlite`](/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_future_lab_2027.sqlite)

## 3. Separation rules
- `V1` means the live legacy system at [`/Users/keithcreelman/Documents/New project`](/Users/keithcreelman/Documents/New project).
- `UPS_V2` means the clean rebuild at [`/Users/keithcreelman/Documents/mfl/Codex/version2`](/Users/keithcreelman/Documents/mfl/Codex/version2).
- `V1 reference artifacts` are historical, imported, or audited materials and must not be treated as V2 truth until promoted.
- `V2 governed artifacts` are the only approved basis for implementation decisions inside UPS_V2.
- Presence in UPS_V2 is not approval.
- Import is not endorsement.

## 4. Git and repo model
- `UPS_V2` is a separate local Git repo with fresh history.
- No shared Git history with V1.
- New remote is intended for UPS_V2 only.
- Branch naming convention uses `codex/` prefixes.
- V1 remains untouched as the operational legacy source.

## 5. Governance baseline
- Master plan: [`MASTER_PLAN_v7.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/MASTER_PLAN_v7.md)
- Artifact registry: [`GOVERNED_ARTIFACT_REGISTRY.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/GOVERNED_ARTIFACT_REGISTRY.csv)
- Revision log: [`revision_log.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/revision_log.md)
- Agent registry: [`agent_registry.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/agent_registry.csv)
- Agent live assignment view: [`agent_assignment_view.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/agent_assignment_view.csv)
- Site-settings alignment policy: [`site_settings_alignment_policy.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/site_settings_alignment_policy.md)
- Site-settings alignment register: [`site_settings_alignment_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/site_settings_alignment_register.csv)

Key governance rules already locked:
- Audit current live behavior first, then define target behavior, then document the delta, then rebuild.
- Any later discovery can reopen an earlier phase through ADR/revision-log update.
- No unlabeled hardcoded values in active runtime logic.
- No prod write without environment identity, approval reference, and verification evidence.
- Documentation is a gate, not cleanup.

## 6. Phase status

### Phase 0
- Foundation scaffold exists.
- Governance files, registries, DB scaffold, and phase-close structure exist.
- Phase 0 completion report exists: [`phase_0_completion_report.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/phase_reports/phase_0_completion_report.md)

### Phase 1
- Current-state audit artifacts are in place and Phase 1 was formally closed.
- Phase 1 completion report exists: [`phase_1_completion_report.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/phase_reports/phase_1_completion_report.md)

### Phase 2
- In progress.
- Major workspace and action rules have been defined and are the current center of gravity.

### Later phases
- Not implemented as runtime yet, but many governance artifacts were seeded early.

## 7. Active agents
- `Archimedes` = `rules_watch`
  - current tracked deliverables: `rules_watch_digest`, `directive_capture_log`, `site_settings_mismatch_log`, `historical_rule_source_audit`
  - current governed assignment file: [`agent_assignment_view.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/agent_assignment_view.csv)
- `Bacon` = `ux_review`
- `Darwin` = `data_governance`
- `Curie` = `ops_runtime`
- `Cicero` = `mfl_matrix`
- `future_lab` remains phase-disabled

Important current agent note:
- `Archimedes` was explicitly assigned a deep historical rules audit across Google Docs, forum archives, Discord-backed evidence, local V1 materials, and UPS_V2 governed artifacts.

## 8. Current governed workspace and action surface status

### Workspaces
- Contract Actions: [`contract_actions_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/contract_actions_workspace.md)
- Team Operations: [`team_operations_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/team_operations_workspace.md)
- Roster Operations: [`roster_operations_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/roster_operations_workspace.md)
- Trade Negotiation: [`trade_negotiation_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/trade_negotiation_workspace.md)

### Action rules
- Add: [`add_action_rule.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/add_action_rule.md)
- Drop: [`drop_action_rule.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/drop_action_rule.md)
- Trade: [`trade_offer_action_rule.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/trade_offer_action_rule.md)
- Auction nomination: [`auction_nomination_rule.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/auction_nomination_rule.md)

### Matrices and deltas
- Target requirements matrix: [`target_requirements_matrix.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/target_requirements_matrix.csv)
- Current-to-V2 delta register: [`current_to_v2_delta_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/current_to_v2_delta_register.csv)
- Non-functional requirements: [`non_functional_requirements.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/non_functional_requirements.md)

## 9. Most important business-rule decisions already made

### League and environment
- Prod source league: `74598`
- Primary test league: `25625`
- UPS_V2 prod writes are not allowed without governed publish controls.
- Nightly source mirroring from `74598` to `25625` is part of the target operating model.

### Historical normalization
- Raw historical values must remain immutable.
- UPS_V2 also needs a current-rules-normalized layer for historical comparisons.
- Exact raw-stat re-scoring is deferred; modeled normalization is the current plan.

### Add rule
- BBID and FCFS are one acquisition concept.
- Add window starts at the first waiver run after the free-agent auction completes.
- End boundary is season-end metadata, currently `endWeek=17`.

### Drop rule
- Drops are broadly allowed from new league website start through league end.
- Exceptions:
  - player game already started
  - short pre-auction lock window
  - auction-active period

### Team option
- First-round rookie option applies starting with the `2025` rookie class.
- First live exercise window inferred to begin in `2027`.
- Offensive option adds `5K`.
- Defensive first-round handling is still provisional and tied to Discord-backed evidence.

### Trade rule
- Trade window opens at new league year.
- Deadline is kickoff of the Thanksgiving Day game.
- Trades remain open during offseason and auction.
- Release 1 trade execution is self-serve two-team only.
- Three-way or larger trades remain commissioner-managed exceptions.
- Kicked-off-player acceptance remains provisional until live Week 1 2026 test validation.

### Trade salary rule
- Traded salary comes only from outgoing active-roster or IR current-season salary.
- Taxi players do not count.
- Max tradable salary is `50%` of outgoing eligible salary.
- Mirrored cap adjustments apply between both sides.

### Trade cap compliance
- Offseason cap overage does not reverse a trade.
- Regular-season over-cap state does not reverse a trade.
- Lineup legality is the natural in-season enforcement point.
- Auction-stage over-cap enforcement is still open.

### Discord trade notifications
- Test-only rollout for now.
- For franchise `0008`, both `upscommish` and `ups_commish` are valid test targets.
- `0010` is legacy co-commish mapping data, not the active test owner target.
- Production owner-by-owner rollout is blocked until mapping is normalized.

### Auction nomination rule
- Auction opens at `12 PM ET`.
- Day 1 requires `2` nominations before midnight.
- Each midnight-reset day thereafter requires `2` nominations.
- Owners may stop only when nomination-complete.
- If an owner loses a required leading bid after stopping, UPS_V2 should reopen a supplemental nomination.
- If an owner skips after becoming nomination-complete, discretionary nominations end for the rest of the auction.
- Current rulebook only confirms missed nominations escalate starting at `3K`; the exact escalation ladder is still unresolved.

## 10. Current ambiguity / unresolved list
- Primary ambiguity register: [`rule_ambiguity_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/rule_ambiguity_register.csv)

Important open items:
- `AMB-006`: defensive first-round rookie option formula details
- `AMB-009`: actual MFL behavior for accepting a trade involving a player whose game already started
- `AMB-011`: normalize Discord mapping row that still points `ups_commish` to `0010`
- `AMB-012`: over-cap penalties / auction-stage enforcement policy
- `AMB-013`: exact missed-nomination penalty ladder

## 11. Site-settings and source-system alignment
- Alignment register: [`site_settings_alignment_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/site_settings_alignment_register.csv)

Important alignment facts:
- Trade expiration and lockout were verified against live MFL export.
- Auction timing remains intentionally flexible despite written “last weekend of July” norm.
- Trade DM notifications are an intentional UPS_V2 override.
- Trade salary formula is an intentional UPS_V2 governed override.
- Auction nomination cadence is explicitly `no_direct_source_setting`; MFL exposes email-auction mechanics, not the daily nomination discipline.

## 12. Existing validation and scheduled tests
- Trade kickoff acceptance validation runbook: [`trade_kickoff_acceptance_validation.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/validation/trade_kickoff_acceptance_validation.md)
- Validation catalog: [`workflow_acceptance_catalog.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/validation/workflow_acceptance_catalog.csv)

Important scheduled validation:
- Week 1 `2026`
- league `25625`
- purpose: determine real MFL behavior when a trade includes a player whose game already started

Note:
- A suggested Codex automation was emitted in chat for this, but no confirmed persisted automation file was inspected in this handoff pass.

## 13. Rules-source audit and rulebook browser work

### Historical audit
- Pending-review governed audit note: [`rules_source_audit_pending_review.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/rules_source_audit_pending_review.md)
- V1 reference audit: [`rules_source_audit_2026-03-18.md`](/Users/keithcreelman/Documents/mfl/Codex/V1/reference_inputs/ups_v2/V1_REFERENCE/rules/rules_source_audit_2026-03-18.md)

### Rulebook browser drafts
- First-pass browser: [`ups_v2_rulebook_browser_first_pass.html`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/ups_v2_rulebook_browser_first_pass.html)
- Fantasy-first draft: [`ups_v2_fantasy_rulebook_browser_first_pass.html`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/ups_v2_fantasy_rulebook_browser_first_pass.html)
- Comprehensive draft: [`ups_v2_fantasy_rulebook_browser_comprehensive_draft.html`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/ups_v2_fantasy_rulebook_browser_comprehensive_draft.html)
- UX review brief: [`rulebook_html_ux_review_brief.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/ux/rulebook_html_ux_review_brief.md)

These are not final rulebook truth. They are review targets and pending governed cleanup.

## 14. External sources specifically discussed

Historical docs / sites explicitly called out:
- 2012 rulebook Google Doc
- 2013 rulebook Google Doc
- 2014 Google Drive rulebook file
- 2018 rulebook Google Doc
- 2021-era contract guide Google Doc
- Google Doc table of contents rulebook
- forum archive: [https://upsdynastycap.forumotion.com/forum](https://upsdynastycap.forumotion.com/forum)

Practical note:
- Some of these sources were partially gated or inconsistent to fetch directly.
- Do not assume complete automated access.
- Treat inaccessible pieces as tracked evidence gaps, not silent omissions.

## 15. Current files most likely to matter first for takeover
- [`MASTER_PLAN_v7.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/MASTER_PLAN_v7.md)
- [`revision_log.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/revision_log.md)
- [`agent_assignment_view.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/agent_assignment_view.csv)
- [`target_requirements_matrix.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/target_requirements_matrix.csv)
- [`current_to_v2_delta_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/current_to_v2_delta_register.csv)
- [`contract_actions_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/contract_actions_workspace.md)
- [`trade_negotiation_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/trade_negotiation_workspace.md)
- [`trade_offer_action_rule.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/trade_offer_action_rule.md)
- [`auction_nomination_rule.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/auction_nomination_rule.md)
- [`rule_ambiguity_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/rule_ambiguity_register.csv)
- [`site_settings_alignment_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/site_settings_alignment_register.csv)

## 16. Recommended next moves for Claude
1. Read the master plan, revision log, assignment view, ambiguity register, and alignment register first.
2. Respect V1 vs V2 separation. Do not promote historical material into governed truth casually.
3. Use `Archimedes` output and existing rules audits to continue the historical rule reconciliation.
4. Continue Phase 2 by finishing auction bidding / over-cap governance and any remaining workspace gaps.
5. Keep all rule changes tied to source evidence, commissioner directive, or explicit ambiguity logging.
6. Do not touch the live V1 runtime as part of UPS_V2 planning or implementation.

## 17. Bottom line
- The project is no longer at “blank plan” stage.
- UPS_V2 has a real governance spine, active agent lanes, governed requirements, and several critical rules already locked.
- The biggest remaining work is not inventing structure from scratch; it is continuing the governed rule reconciliation, source validation, and Phase 2 to Phase 6 design hardening without letting V1 chaos leak back in.
