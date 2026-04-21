# Trade Negotiation Workspace

## Purpose
The Trade Negotiation Workspace is the owned surface for proposing, reviewing, countering, responding to, and finalizing trades in UPS_V2. It should preserve the power of the current Trade War Room while removing unnecessary cognitive load, moving owner notifications to Discord DM, and keeping acceptance and final approval on the website instead of inside chat. The website workspace is the canonical source of truth for trade state; Discord is transport and lightweight response UI, not the authoritative workflow ledger.

## Included functions
- trade offer draft and review
- trade offer submission
- incoming offer review
- reject, consider, revoke, counter, and accept-intent handling
- player, pick, and traded-salary composition
- trade-linked extension intent capture when allowed by rule
- post-accept recalculation and verification status
- recipient and sender notification state
- commissioner review and exception visibility
- first-release two-team trade execution
- future-ready multi-party trade design considerations

## Explicit exclusions
- direct ownership of contract extension pricing logic
- direct ownership of publish verification mechanics
- roster-only adds, drops, taxi, and IR actions outside a trade context
- league-wide reporting and audit-only review

## Primary actors
- authenticated owner: may draft, submit, review, reject, counter, and accept offers for owned franchise context
- commissioner: may review cross-franchise trade state, enforce policy, and use governed override paths where policy allows
- automation actor: may send nudges, refresh verification state, and post reminder updates but may not originate trades

## Entry model
- top-level task-first navigation label: `Trades`
- contextual launch from a rostered player is allowed and should carry player and franchise context into the trade builder
- Discord DM notifications may deep-link into the exact incoming offer or review state, but acceptance still happens on the website

## Persistent state context
The workspace header must always show:
- league
- season
- initiating franchise
- counterparty or counterparties in scope
- trade lifecycle state
- trade window status
- freshness state

## Workspace zones
- trade inbox: incoming offers, response state, nudge status, and deadlines
- trade outbox: sent offers, current status, follow-up state, and response history
- trade builder: assets, salary movement, extension intent, and validation context
- offer review panel: side-by-side asset summary, contract context, and warnings
- response panel: not interested, will consider, revoke where allowed, counter, accept on site, dismiss
- commissioner panel: policy exceptions, publish evidence, deferred-processing state, and audit context

## Core governed rules
- Trade availability begins at the start of the new league year.
- Trade availability stays open during the offseason, during the free-agent auction, and through the regular season until the trade deadline.
- The trade deadline is the kickoff of the NFL Thanksgiving Day game for that season.
- A trade involving a player whose NFL game has already started may not be processed for the current scoring week.
- UPS_V2 should prefer a deferred-processing model for those trades: record owner intent, keep the website acceptance flow, and process at the next eligible week boundary when the source system allows it.
- Trade responses should be Discord-DM first, but acceptance and final trade approval should remain website actions.
- Email notifications are not part of the target UX for trade offers.
- Incoming traded taxi players should land back on taxi automatically when that state is valid for the acquiring franchise.
- The first supported execution model is a standard two-team trade.
- The trade workspace must not hardcode a permanent two-team ceiling into its architecture, even though first-release execution support is intentionally limited to the current two-team core flow.
- Three-way or larger trades remain commissioner-mediated exceptions until their dedicated UX, state model, and publish path are explicitly approved.

## Discord DM interaction model
### Rollout boundary
- Discord trade DMs are test-only for now
- during the test phase, DM delivery for franchise `0008` should route to both commissioner-controlled Discord identities stored in your data and secrets
- production owner-by-owner DM rollout stays disabled until franchise mapping review and explicit activation are approved
- the legacy co-commish fallback for franchise `0010` is not needed for this workflow and should not be treated as a separate owner target

### Sender notifications
- send the originating owner a confirmation DM when the offer is sent
- send the originating owner state updates when the recipient chooses `not_interested`, `will_consider`, or later acts on the offer on-site

### Recipient notifications
The recipient Discord DM should offer these governed responses:
- `dismiss`: do nothing and leave the offer pending
- `not_interested`: reject immediately and notify the sender
- `will_consider`: keep the offer open and notify the sender that review is underway
- `open_communication`: open or direct the owners into Discord communication without accepting the trade

### Mapping and delivery rules
- franchise-to-Discord resolution should come from stored database mapping logic, not hardcoded usernames
- the existing V1 database includes `discord_accountdetails(discord_userid, discord_username, franchise_id, team_name, owner_name, active_owner)` and should be treated as the initial mapping source
- multiple Discord targets are allowed only when explicitly approved for the same owner and franchise context
- franchise `0008` is explicitly approved to deliver to both `upscommish` and `ups_commish` during test
- if a franchise lacks a governed valid target set for the intended environment, DM delivery must not silently guess; it should fall back to governed review or the test-identity rule

### Explicit non-goal
- do not allow trade acceptance inside the Discord DM
- do not allow final approval or publish inside the Discord DM
- do not treat `dismiss` as a response
- do not let Discord become the canonical trade state store

## Reminder and nudge policy
- offseason pending offers get a gentle nudge every 5 days
- in-season pending offers get a nudge every 24 hours
- `will_consider` still leaves the offer eligible for nudges until the offer resolves or expires
- reminder jobs must respect the live trade window and stop once the trade deadline closes or the offer reaches a terminal state

## Multi-party scope
- release 1 supports two-team trade execution only
- release 1 may still record or reference commissioner-mediated multi-party trade intent, but it should not pretend to offer a finished self-serve three-way builder
- architecture, data model, and UI composition should still preserve a path to later multi-party support
- any non-two-team trade before that later approval should be handled as a commissioner-managed exception with explicit audit notes

## Trade lifecycle
All trade flows resolve into the governed workflow model, but the trade workspace may expose additional sub-status detail.

### Core lifecycle
- `drafted`
- `validated`
- `blocked` or `approved`
- `published`
- `verified`
- terminal exceptions: `reverted`, `expired`

### Trade-specific sub-status detail
- `pending_recipient_response`
- `dismissed_no_response`
- `rejected_not_interested`
- `under_consideration`
- `counter_pending`
- `clarification_requested`
- `revoked`
- `accepted_pending_publish`
- `accepted_deferred_next_week`
- `accepted_verified`
- `archived`

## Warning and block behavior
- trade launch is hidden when the global trade window is closed
- trade submission is blocked if no valid assets are included
- trade submission is blocked if the proposal would leave a side immediately out of roster compliance without an allowed correction path
- trade submission is blocked if a player or pick is not eligible to move under current rules
- same-week processing is hard blocked once an included player has already kicked off
- commissioner override may never silently force same-week processing for a player who has already started
- trade salary rules must use the governed UPS salary-trade policy rather than a misleading MFL blind-bid ceiling

## Data requirements
The workspace depends on governed reads from:
- trade
- trade_asset
- roster_assignment
- contract
- contract_term
- salary_adjustment
- pick
- eligibility_state
- warning_state
- publish_batch and publish_unit
- audit_event
- rule_directive when commissioner intervention exists
- player kickoff and event-window state
- Discord delivery and reminder state
- franchise-to-Discord account mapping derived from stored owner mapping data

## Boundaries with adjacent workspaces
- Roster Operations may launch a trade from player context, but the trade workflow is owned here.
- Contract Actions owns extension, restructure, tag, MYM, and option rule logic, even when trade-linked extension intent is collected here.
- Workflow and Publish Service owns submit, approve, publish, verify, revert, and deferred-processing execution beneath this workspace.
- Reporting Suite may expose trade history and analytics, but it is not the owner of active negotiation.

## UX requirements
- core two-team trade tasks should reach an action-ready state within 3 clicks from top-level navigation
- incoming trade review from a Discord deep link should land directly on the offer review state
- do not overload the default trade screen with every optional rule explanation at once; use progressive disclosure
- keep website acceptance on-site and obvious
- preserve sender and recipient context clearly so it is obvious who is waiting on whom
- keep the release-1 interface optimized for two-team clarity rather than forcing premature three-way complexity into every trade screen
- start designing the information architecture so a later three-way trade flow can be added without a total rewrite

## Freshness and degraded mode
- trade inbox and outbox state should reflect near-real-time validated state after submission or response
- if live MFL reads are unavailable, show the last verified offer and publish state with explicit staleness labeling
- degraded mode may allow review, but it may not claim that a trade is accepted, processed, or verified without the underlying source-system confirmation required by policy

## Telemetry hooks
- `trade_workspace_opened`
- `trade_offer_drafted`
- `trade_offer_submitted`
- `trade_dm_opened`
- `trade_dm_response_selected`
- `trade_offer_under_consideration`
- `trade_offer_rejected_not_interested`
- `trade_accept_requested_on_site`
- `trade_accept_deferred_next_week`
- `trade_counter_started`
- `trade_verification_viewed`

## Open design follow-ups
- confirm whether a source-system-safe deferred acceptance model can be implemented when a traded player has already kicked off
- codify the authoritative salary-trade formula from the cap-adjustment rule rather than relying on the current UI implementation alone
- define the exact user-facing wording for Discord DM actions so it stays clear without sounding passive-aggressive
- define the promotion criteria and first approved self-serve multi-party interaction pattern before moving three-way trades out of commissioner-managed exception status
