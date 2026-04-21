# Trade Offer Action Rule

## Purpose
This rule defines when a trade can be launched, submitted, responded to, accepted, deferred, or blocked in UPS_V2. It governs trade availability from the roster launcher and the trade workspace, and it cross-checks every applicable rule against live MFL settings or exports where a source-system equivalent exists.

## Governed action concept
`Trade` is one governed negotiation concept. The user may launch it from a player context or from the trade workspace, but eligibility, timing, response, and processing must resolve through one shared rule contract. The canonical state of the offer must live in UPS_V2 and its governed trade records, not in Discord message history.

## When `Trade` may be shown
Show `Trade` only when all of the following are true:
- the acting user has authority for the initiating franchise
- the global trade window is open
- the player or asset in view is eligible to be traded
- no active workflow or publish lock forbids a new trade involving that asset
- the acting context is not already blocked by commissioner hold or environment restrictions

## Trade window
### Start
- the trade window opens at the start of the new league year
- this means the governed UPS_V2 trade market is open once the new season has been rolled forward operationally

### End
- the trade window closes at the kickoff of the NFL Thanksgiving Day game for that season
- after that kickoff, no new trades may be launched or submitted for the current governed season window

### Scope notes
- trading remains open during the offseason
- trading remains open during the free-agent auction
- release 1 supports standard two-team execution only
- three-way or larger trades remain commissioner-mediated exceptions until a dedicated multi-party workflow is approved
- post-season re-open behavior after the fantasy season but before the next league year is intentionally deferred for later rule review

## Player kickoff handling
- if any player included in a trade has already had that week’s NFL game start, the trade may not be processed for the current scoring week
- same-week publish is therefore a `hard_block`
- official MFL endpoint documentation confirms `tradeResponse` request semantics, but it does not explicitly document what happens when an accepted trade includes a player whose game has already started
- an older official MFL support page indicates owners cannot trade or waive a player who is in a submitted starting lineup for the upcoming week, which suggests the source system may be stricter than the desired UPS_V2 deferred-processing model
- UPS_V2 target behavior remains to capture owner intent and classify the trade as `accepted_deferred_next_week` only if source-system behavior can support that safely
- if the source system blocks acceptance entirely, UPS_V2 must store the deferred intent locally and wait for the next eligible processing window rather than falsely claiming completion

## Response model
### Website-owned actions
- accept
- reject
- revoke when allowed for the originator
- counter
- final review
- publish status review

### Discord-DM-owned lightweight responses
- dismiss
- not interested
- will consider
- open communication

### Required rule
- Discord DM may not perform the final acceptance or publish step
- website acceptance remains the only governed path to finalize a trade

## Notification model
- send the proposal recipient a Discord DM
- send the proposing owner a confirmation Discord DM
- do not rely on email as the primary trade-notification path in UPS_V2
- Discord trade DMs are test-only for now and should route through the commissioner-controlled identities approved for franchise `0008` until broader rollout is approved
- owner-by-owner production DM targeting should resolve from stored franchise-to-Discord mapping data, not hardcoded usernames
- V2 should use MFL proposal expiration as the source-system ceiling for an offer unless a governed explicit expiration is posted through MFL
- nudges run every 5 days in the offseason and every 24 hours in-season while the offer remains unresolved and unexpired

## Taxi-on-trade handling
- if a traded player is on taxi when the trade is processed, UPS_V2 should return that player to taxi on the acquiring franchise whenever that taxi status remains valid
- this should happen automatically as part of post-accept processing and verification
- day-of-kickoff timing caveats may require a next-week resolution path, consistent with the existing taxi leniency rule

## Salary-in-trade handling
- salary may be included in a trade
- UPS_V2 must not treat the MFL blind-bid ceiling as the governing business rule for traded salary
- the governing traded-salary base is the current-season salary of the selected outgoing players on the active roster or IR
- taxi players are excluded from the traded-salary formula
- the maximum salary a side may trade is 50 percent of the summed current-season salary of its selected outgoing eligible players
- traded-salary settlement should post mirrored cap adjustments between the two sides
- example: if a side trades away a player whose current-season salary is `80K`, that side may also trade up to `40K`; the sending side receives a `+40K` cap adjustment and the receiving side receives a `-40K` cap adjustment
- current-season salary, not future AAV, is the governing value for the salary-trade calculation

## Picks and contract eligibility
- current draft-year picks and one-year-future picks are trade-eligible
- round 6 picks are not trade-eligible
- players with 1 or more years remaining on contract are trade-eligible
- expired rookies remain trade-eligible only until the extension deadline
- other expired contracts are not trade-eligible

## Extensions inside trades
- if a player in a trade is eligible for an extension and the trade agreement includes that extension, the trade workflow may capture extension intent
- final extension rule validation remains governed by Contract Actions
- any trade-linked extension must still satisfy the timing and evidence requirements of the extension rules

## Compliance and asset rules
- at least one non-salary asset must be included in every trade
- offseason salary-cap overage does not, by itself, invalidate or reverse a trade
- regular-season over-cap state should not reverse a completed trade, but a team that remains over the cap cannot submit a valid lineup until it returns to compliance
- the current legacy `24 hours to comply` wording should be treated as a cleanup target, not as an automatic trade-reversal rule
- if a trade leaves contract state out of compliance, required contract corrections must still be completed within the governed correction window
- future penalties or automatic cap adjustments for unresolved over-cap state remain a separate policy question and should not be silently assumed in trade execution logic

## Warning and block policy
- `warn_only`: recipient has not responded yet, trade has been idle, or sender may want to follow up
- `soft_block`: rule or communication issue exists but commissioner review could permit a managed exception
- `hard_block`: trade window closed, player not trade-eligible, same-week processing after kickoff, invalid asset mix, or required compliance cannot be achieved
- `commish_override_forbidden`: same-week processing of a player after kickoff

## Delivery mapping rule
- the initial mapping source for franchise-to-Discord delivery should be the existing V1 `discord_accountdetails` table
- mapping logic should link the active franchise context to `discord_userid` through governed resolution rules
- franchise `0008` is explicitly approved to target both stored commissioner Discord identities for test delivery
- the `ups_commish -> 0010` row should be treated as legacy admin/co-commish data and normalized before any production rollout that depends on strict franchise ownership mapping
- if mapping is missing or environment-inappropriate, DM delivery must be blocked or forced into test routing rather than silently misdirected

## Site settings cross-check
UPS_V2 must record a site-settings alignment result for the following trade items:
- live league export `defaultTradeExpirationDays`
- any live or derived source used for Thanksgiving kickoff deadline resolution
- any live MFL behavior that blocks or permits accepting trades involving already-started players
- any notification or offer-expiration setting that materially affects trade workflow timing
- any governed test-only Discord rollout override or franchise-to-Discord mapping assumption

If UPS_V2 behavior and the source system differ, the discrepancy must be classified in the site settings alignment register as one of:
- `matched`
- `intentional_override`
- `site_settings_review_needed`
- `rule_review_needed`
- `no_direct_source_setting`
- `pending_live_validation`

## Source anchors
- current local rulebook trade period and Thanksgiving deadline text
- current local rulebook trade eligibility, compliance, and taxi-on-trade text
- current worker trade proposal, trade response, salary adjustment, extension, and taxi-sync behavior
- live MFL league export showing `defaultTradeExpirationDays=7`
- official MFL Developers Page confirming `pendingTrades`, `tradeProposal`, and `tradeResponse` behavior including `EXPIRES` and `accept|reject|revoke`
- official MFL support guidance indicating owners cannot trade or waive a player who is in a submitted starting lineup for the upcoming week

## Open follow-ups
- validate actual MFL behavior when an included player has already kicked off and the recipient tries to accept; current official MFL docs are not explicit enough to close this without empirical test evidence
- decide whether deferred next-week acceptance is implemented as an immediate accept-intent state or as a separate scheduled publish state
- define the promotion criteria, state model, and first approved self-serve multi-party UI pattern for moving three-way trades from commissioner-managed exception to self-serve support
- normalize the stored `ups_commish` mapping from legacy franchise `0010` handling into the approved `0008` owner-target model before production owner DM rollout
- clean up the legacy 24-hour trade-compliance wording and decide, at owner-meeting level, whether unresolved over-cap state should create penalties or automatic cap adjustments without reversing the trade
