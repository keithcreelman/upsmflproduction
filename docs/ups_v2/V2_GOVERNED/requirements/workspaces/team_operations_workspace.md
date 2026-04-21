# Team Operations Workspace

## Purpose
The Team Operations Workspace is the owned surface for team-state review, roster context, cap planning, contract planning context, and operational preparation that does not itself execute governed contract or auction actions. It replaces the current Front Office fragmentation while staying explicitly separate from Contract Actions.

## Included functions
- roster and franchise overview
- team cap snapshot and cap planning context
- contract ledger context for the selected franchise
- roster status review: active, taxi, IR, and count-sensitive states
- future picks and team asset context needed for planning
- contract planning context and what-if review that does not submit a governed action
- deadline and event awareness for the current franchise
- issue spotting for roster compliance, cap exposure, and pending deadlines
- drill-through into Contract Actions, Trade Negotiation, Roster Operations, and Reporting

## Explicit exclusions
- extension execution
- restructure execution
- tag execution
- MYM execution
- free agent auction execution
- expired rookie auction execution
- team option exercise
- trade submission or publish approval
- direct prod mutation controls outside read-only planning and drill-through

## Primary actors
- authenticated owner: primary actor for team review and planning
- commissioner: may review any franchise state and operational readiness
- automation actor: may refresh derived state and indicators but may not originate team actions here

## Entry model
- top-level task-first navigation label: `Team Operations`
- this is the primary planning and context workspace that replaces the vague Front Office framing
- deep links may open directly to a franchise view, cap plan view, or contract context subview

## Persistent state context
The workspace header must always show:
- league
- season
- selected franchise
- roster count state
- cap state
- freshness state
- next key deadline or event window

## Workspace zones
- franchise summary: overall roster health, cap room, contract exposure, and key status indicators
- roster composition panel: active, taxi, IR, and positional distribution
- cap planning panel: current cap, projected cap, floor and ceiling pressure, and planning deltas
- contract context panel: major contract facts, upcoming expirations, option candidates, and extension windows
- asset context panel: picks, notable trade flexibility, and linked acquisition context
- deadline panel: current event-window and deadline reminders tied to the selected franchise
- guided actions panel: links into Contract Actions, Trade Negotiation, Roster Operations, and Reporting

## Relationship to Contract Actions
- Team Operations may explain why a player or franchise is a candidate for an action.
- Team Operations may preview planning scenarios and action readiness.
- Team Operations should defer daily player-level action launching to Roster Operations when the roster page is the more natural entry surface.
- Team Operations may not own the actual action form, submit flow, approval flow, or publish lifecycle.
- Any button or link that mutates contract state must hand off into Contract Actions or Workflow and Publish Service.

## Relationship to Roster Operations
- Team Operations is franchise planning and status context.
- Roster Operations is the owned workspace for concrete roster tasks and roster-state changes.
- Team Operations may link into Roster Operations but should not become a second roster task surface.

## Relationship to Reporting
- Team Operations is current-state operational context for one franchise.
- Reporting is multi-view analytical browsing, historical summaries, and cross-franchise league storytelling.
- Ledger-style history may be previewed here only insofar as it supports immediate team planning.

## Planning behavior
- planning widgets may show projected cap effects, roster implications, and deadline readiness
- planning state must be clearly labeled as draft or simulation and never imply that a governed action has been submitted
- what-if planning should be resettable and auditable only if explicitly saved as a planning artifact later

## Warning and block behavior
- Team Operations may surface warnings and readiness flags
- Team Operations should not hard-block read-only planning views
- if a user attempts to launch an unavailable action, the handoff should explain the block reason and route into the correct governed workspace where applicable

## Data requirements
The workspace depends on governed reads from:
- franchise
- roster_assignment
- contract
- contract_term
- salary_adjustment
- tag
- extension candidate state
- restructure candidate state
- rookie option candidate state
- cap and salary summary state
- pick ownership and selected asset context
- deadline and event-window state
- warning_state and eligibility_state for summary use only

## UX requirements
- core owner planning tasks should reach a useful franchise overview within 2 clicks from top-level navigation
- no user should need to understand MFL message slots or loader partial names to reach Team Operations
- major planning panels should explain status with plain language instead of dense internal labels
- mobile should prioritize summary first, then expandable planning panels

## Freshness and degraded mode
- franchise summary and cap state should show their freshness explicitly
- if live refresh is unavailable, show the last verified planning snapshot with a staleness label
- degraded mode should still allow read-only planning review but must not pretend that downstream actions are ready for publish

## Telemetry hooks
- `nav_target_selected`
- `route_resolved`
- `module_loaded`
- `help_opened`
- `warning_seen`
- `suggestion_selected`
- `planning_context_opened`
- `planning_handoff_requested`

## Open design follow-ups
- define the exact planning widgets that belong here versus Reporting
- define whether saved planning scenarios exist in V1 or are introduced later in UPS_V2
- define the minimum franchise summary cards that appear above the fold on mobile and desktop
