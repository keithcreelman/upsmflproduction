# Contract Actions Workspace

## Purpose
The Contract Actions Workspace is the single owned surface for contract lifecycle and contract-adjacent acquisition actions in UPS_V2. It replaces the split ownership currently spread across CCC, Front Office, helper warnings, route-specific submission flows, and scattered auction handling.

## Included actions
- extension
- restructure
- tag assignment and tag review
- MYM action
- free agent auction participation and contract finalization
- free agent auction nomination duty and missed-nomination enforcement
- expired rookie auction participation and contract finalization
- first-round rookie team option exercise
- contract-action eligibility review
- contract-action warning review
- draft review before governed submission
- commissioner approval and publish status review

## Explicit exclusions
- team-wide cap planning that does not initiate a contract or acquisition action
- roster browsing without contract or acquisition intent
- trade construction and trade negotiation
- reporting-only ledger browsing
- direct prod mutation controls outside the governed publish flow

## Primary actors
- authenticated owner: may initiate eligible actions for owned context
- commissioner: may review approve override where policy allows and publish through governed controls
- automation actor: may update read-only derived state but may not originate contract actions

## Entry model
- top-level task-first navigation label: `Contract Actions`
- direct deep links may open a specific player and action, but the workspace still resolves inside the same owned surface
- contextual launches from the roster page are allowed and should preserve player and franchise context on handoff
- compatibility shell routes may point here from legacy MFL slots, but slot identity is never the governing IA

## Persistent state context
The workspace header must always show:
- league
- season
- target franchise
- selected player or auction target
- action type
- action lifecycle state
- freshness state

## Workspace zones
- eligibility summary: current contract or auction eligibility and why an action is or is not available
- action selector: extension, restructure, tag, MYM, free agent auction, expired rookie auction, team option
- action form: action-specific inputs and rule-driven calculations
- warnings and blocks panel: governed severity output from the warning system
- review panel: drafted values before submission
- lifecycle panel: drafted, validated, blocked, approved, published, verified, reverted, expired
- commissioner panel: override path, directive reference, approval state, publish evidence

## Action families
### Core contract lifecycle
- extension
- restructure
- tag
- MYM

### Auction-driven acquisition flows
- free agent auction nomination, bid context, roster and cap validation, and winner contract finalization
- expired rookie auction nomination, bid context, minimum valid bid enforcement, and winner contract finalization

### Team option flow
- first-round rookie option exercise for eligible first-round rookie contracts only
- local governing rulebook evidence says this applies starting with the 2025 draft class and must be exercised before the contract deadline of the player's final rookie season
- inference from the 2025-start rule and 3-year rookie contracts: the first live exercise window begins in the 2027 season
- commissioner-directed offensive rule: the option year adds 5K to the rookie contract salary band; example structure provided by the commissioner is `15K, 15K, 15K, option 20K`, then a later 2-year extension example of `40K, 40K`
- commissioner-directed defensive placeholder: if a defensive first-round case ever exists, the option cost should be defined as half the cost of an extension; detailed supporting evidence is referenced to Discord discussion and still needs consolidation
- current V1 implementation already exposes an `Exercise Option` flow and computes an option-year salary from precomputed rookie-option state; UPS_V2 should preserve that operational behavior and align it to the commissioner-directed rule set

## Auction-specific rule anchors
### Free Agent Auction
- typically begins on the last weekend of July and lasts about one week
- pre-auction cut-down and roster-lock timing should normally fall within 48 hours before auction start, with the exact season value remaining configurable
- auction opens at 12 PM ET and the first nomination cycle runs only through midnight that day
- each non-exempt franchise owes 2 nominations in that first partial-day window
- each non-exempt franchise owes 2 nominations on each midnight-reset auction day thereafter
- a franchise may stop nominating only once it is nomination-complete, meaning it already has or is currently leading enough players to satisfy minimum roster and valid-lineup completion
- if a franchise stops nominating while nomination-complete, it may not resume discretionary nominations later in the auction
- if a franchise loses a required leading bid after becoming nomination-complete, UPS_V2 should allow a supplemental nomination to restore the path to minimum roster and lineup completion
- maximum roster size during auction is 35 players
- minimum roster size by auction completion is 27 players
- valid lineup must be achievable by auction completion
- bidding follows an Ebay proxy style and the high bid must stand for 36 hours
- missed nominations incur escalating penalties starting at 3K, but the exact penalty ladder remains under governed review and should stay configurable
- salary floor must be met by auction completion or the contract deadline date

### Expired Rookie Auction
- applies to players with expired rookie contracts not extended before the deadline
- occurs during the first week in May
- nomination window is 2 to 3 days
- starting bid must be 1K above the player's prior-year salary
- high bidder must remain highest for 36 hours
- auction winner contracts follow the free-agent auction contract rules with 1 to 3 year contracts
- if the winner contract exceeds 1 year, it must be submitted by the September contract deadline
- winners may not be cut prior to the following free-agent auction

## Action lifecycle
All contract actions share the governed state model:
- `drafted`
- `validated`
- `blocked` or `approved`
- `published`
- `verified`
- terminal exceptions: `reverted`, `expired`

Auction flows may also expose sub-status detail inside the workspace, such as nomination open, bidding active, won pending contract, or closed, but they still resolve into the governed publish lifecycle once an actionable contract or result is submitted.

## Warning and block behavior
- advisory issues use `warn_only`
- owner-stoppable issues that may still allow commissioner exception use `soft_block`
- prohibited actions use `hard_block`
- any override path must generate audit evidence and a directive or approval reference
- auction-specific validations must include roster-size floor, roster-lock timing, cap-floor impact, and contract-deadline requirements
- free-agent auction validations must include nomination-cycle timing, nomination-complete state, stop-and-forfeit behavior, supplemental nomination re-open logic, and missed-cycle violation capture
- team-option validations must include first-round eligibility, class-season eligibility, exercised-state checks, deadline-window validation, and the commissioner-directed option-salary logic

## Data requirements
The workspace depends on governed reads from:
- contract
- contract_term
- salary_adjustment
- roster_assignment
- tag
- extension
- restructure
- mym_action
- eligibility_state
- warning_state
- publish_batch and publish-unit state
- rule_directive when commissioner intervention exists
- auction history and auction candidate state
- rookie option eligibility and option-year salary state

## Boundaries with adjacent workspaces
- Team Operations may show cap and roster context, but it may not own contract or auction execution.
- Trade Negotiation may reference contract context, but it may not mutate contract-action state here.
- Reporting Suite may show ledger and auction history, but it may not become the action entry surface.
- Workflow and Publish Service owns submit, approve, publish, verify, and revert mechanics beneath this workspace.

## UX requirements
- core owner tasks should reach an action-ready screen within 2 clicks from top-level navigation
- complex commissioner tasks may take 3 clicks if the approval context is preserved
- no blank-shell landing state is allowed
- mobile should use stepped sections instead of overloading one screen with every action detail at once
- auction flows should use progress-oriented steps rather than forcing owners to infer nomination, bidding, and contract-finalization state from raw data

## Freshness and degraded mode
- eligibility and action state should reflect near-real-time validated state after submission
- auction state should clearly distinguish live bidding state from cached or historical state
- if live reads are unavailable, show the last verified snapshot with explicit staleness labeling
- degraded mode may not permit silent publish completion claims

## Telemetry hooks
- `nav_target_selected`
- `route_resolved`
- `action_eligible`
- `action_ineligible`
- `warning_seen`
- `action_submitted`
- `action_submit_failed`
- `help_opened`
- `auction_state_viewed`
- `auction_nomination_state_viewed`
- `auction_nomination_submitted`
- `auction_nomination_missed`
- `auction_supplemental_nomination_granted`
- `auction_bid_context_opened`
- `team_option_review_opened`

## Open design follow-ups
- define the exact default landing view when no player or auction target is selected
- define whether contract and auction history live as side panels or linked subviews
- define auction-stage over-cap enforcement, including whether over-cap teams are blocked from nominations and bidding and whether auction-specific cap penalties or automatic adjustments are applied
- codify the exact missed-nomination penalty ladder so the current escalating-from-3K rule becomes machine-settled instead of configurable pending policy
- define the commissioner override affordance so it is explicit but not visually dominant for normal owners
- consolidate the Discord-backed detail for defensive first-round rookie option handling and convert it from provisional guidance into a codified rule
