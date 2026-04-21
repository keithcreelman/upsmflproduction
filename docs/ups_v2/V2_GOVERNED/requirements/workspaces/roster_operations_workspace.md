# Roster Operations Workspace

## Purpose
The Roster Operations Workspace is the owned surface for roster-driven tasks and the universal player-action launcher in UPS_V2. It replaces the current thin roster landing by letting a user click a player and see every action available in context, while preserving clean ownership of the underlying governed workflows.

## Core product rule
A user should be able to click a player from the roster view and immediately see only the actions that are truly available for that player in the current context.

Examples:
- a player already on a roster may show `Drop`, but not `Add`
- a free agent may show `Add` or the relevant acquisition path, but not `Drop`
- a trade launch action must not appear after the trade deadline has passed
- a contract action should appear only if its eligibility and timing rules are currently satisfied
- commissioner-only actions must not appear for a non-commissioner actor

That action set may include:
- add when direct acquisition is currently legal
- drop when roster release is currently legal
- waiver or acquisition action when waiver-based acquisition is the correct current path
- taxi promotion or demotion when applicable
- IR move when applicable
- trade launch
- extension
- restructure
- tag
- MYM
- first-round rookie option exercise
- auction-context drill-through when the player is in an auction-eligible state

The roster page is therefore the universal action launcher, but not the universal action owner.

## Action availability resolution model
The player action launcher must be assembled dynamically for the selected player. UPS_V2 should not render a static action list and then disable half of it.

Action visibility is resolved from:
- acting user authority
- selected franchise context
- current player roster state
- current contract and eligibility state
- current league calendar and deadline window
- current environment and publish status when an action is already in flight

Each candidate action must resolve to one of these outcomes before rendering:
- `show_action`: action is currently legal and may be launched
- `show_context_only`: action itself is not launchable, but the player detail may explain why through status or warning context
- `hide_action`: action is irrelevant or impossible in the current state and should not appear

The launcher should prefer omission over disabled clutter. If a user cannot legally trade, add, drop, extend, restructure, tag, MYM, move, or option a player right now, the workspace should explain the governing reason in context without presenting a dead button.

## Included functions
- franchise roster view with strong player-level context
- grouped roster state by active, taxi, IR, and other relevant statuses
- player action menu or drawer opened from a player click
- roster-state changes owned directly by the roster workspace
- contextual launch into governed contract, trade, or acquisition workflows
- roster compliance and lineup-readiness indicators
- player-specific status pills, warnings, and eligibility hints

## Explicit exclusions
- direct ownership of contract publish lifecycle
- direct ownership of trade negotiation workflow
- league-wide reporting and cross-franchise analytics
- team-wide cap planning beyond roster-context summaries

## Primary actors
- authenticated owner: primary actor for player-level roster tasks
- commissioner: may review or launch actions across any franchise context as allowed
- automation actor: may refresh derived roster state but may not originate user actions here

## Entry model
- top-level task-first navigation label: `Rosters`
- this is a primary day-to-day owner surface, not a secondary shell
- deep links may open directly to a franchise roster or player action state

## Persistent state context
The workspace header must always show:
- league
- season
- selected franchise
- roster counts
- freshness state
- current roster compliance summary

## Workspace zones
- roster summary bar: counts, cap-adjacent roster pressure, lineup readiness, and freshness
- grouped roster list: active, taxi, IR, and other roster states
- player detail drawer or modal: the clicked player's contract, status, warnings, and available actions
- player action launcher: all available actions shown together in one streamlined action area
- roster warnings panel: compliance and status issues that affect roster tasks
- linked action handoff panel: clear transitions into Contract Actions, Trade Negotiation, or Acquisition flows when needed

## Action ownership model
### Owned directly by Roster Operations
- add when direct acquisition is currently legal for an unrostered player
- drop when roster release is currently legal for a rostered player
- taxi and IR moves when they are roster-state changes
- direct roster-status changes that do not require contract or publish workflow ownership

### Launched from Roster Operations but owned elsewhere
- extension, restructure, tag, MYM, team option, and auction contract finalization are owned by Contract Actions
- trade launch and negotiation are owned by Trade Negotiation
- publish, verify, and revert mechanics are owned by Workflow and Publish Service

The roster surface must make this feel seamless to the user even though ownership is separated underneath.

## UX requirements
- clicking a player should reveal all relevant actions without forcing the user to hunt across multiple modules
- the player action menu should be streamlined and context-aware rather than dumping every possible action indiscriminately
- the launcher must be generated from governed availability checks, not from a fixed action menu
- only actions that are actually available in the current player and league context should appear in the launcher
- explanatory warnings may still appear in the player detail area, but dead or impossible actions should not clutter the action launcher
- core owner player tasks should reach an action-ready state within 2 clicks from the roster page
- mobile should use a bottom sheet, drawer, or stepped modal instead of forcing a cramped multi-column layout

## Warning and block behavior
- the roster action launcher should show only actions that pass current availability checks
- availability checks must include actor permissions, roster state, contract state, deadline windows, and any active workflow lock or in-flight publish state
- warning and block semantics must align with the governed warning policy
- when an action is not available, the explanation belongs in player status, warning, or eligibility context rather than as a dead launcher button
- commissioner-only actions may appear only when the acting user actually has commissioner authority

## Action-specific governed rules
- `Add` must follow `/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/add_action_rule.md`, which treats BBID and FCFS as one governed add concept and derives start and end boundaries from auction completion plus season metadata.
- `Drop` must follow `/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/drop_action_rule.md`, which keeps release available broadly across the season but blocks it after player kickoff, during the pre-auction lock window, during the auction, and after the league end date.
- `Trade` must follow `/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/trade_offer_action_rule.md`, which opens trading at the new league year, keeps it live through the Thanksgiving kickoff deadline, and hides or blocks trade launch when timing, eligibility, or same-week kickoff rules do not permit action.

## Data requirements
The workspace depends on governed reads from:
- roster_assignment
- contract
- contract_term
- salary_adjustment
- tag
- extension candidate state
- restructure candidate state
- rookie option candidate state
- taxi and IR eligibility state
- warning_state and eligibility_state
- acquisition eligibility state where add or waiver actions are relevant

## Boundary with Contract Actions
- Roster Operations is where the user should discover and launch player actions.
- Contract Actions is where contract and auction action ownership lives.
- If the user clicks `Extend`, `Restructure`, `Tag`, `MYM`, `Exercise Option`, or auction-related contract finalization from the roster page, the system should hand off into the governed Contract Actions flow with player context preserved.

## Boundary with Team Operations
- Team Operations owns franchise-level planning context.
- Roster Operations owns player-level roster interaction.
- Both may show roster information, but only Roster Operations is the daily player-action launch surface.

## Freshness and degraded mode
- roster state should reflect near-real-time validated state whenever possible
- if live reads are unavailable, show the last verified roster snapshot with staleness labeling
- degraded mode should still support read-only player review but must not fake successful roster or contract submissions

## Telemetry hooks
- `nav_target_selected`
- `route_resolved`
- `module_loaded`
- `player_action_menu_opened`
- `player_action_selected`
- `action_eligible`
- `action_ineligible`
- `warning_seen`
- `planning_handoff_requested`

## Open design follow-ups
- define the exact action ordering inside the player action menu
- define whether add and drop are handled inline or in a lightweight confirmation flow
- define the shared availability-check contract so roster, contract, trade, and acquisition launchers resolve action visibility consistently
