# Auction Nomination Rule

## Purpose
This rule defines when a franchise must nominate, when it may stop nominating, when supplemental nominations reopen, and how UPS_V2 should classify missed-nomination violations during the free agent auction. It governs nomination duty separately from bidding mechanics so the system can enforce the league's daily participation expectations without confusing them with MFL's base email-auction settings.

## Governed action concept
`Auction Nomination` is a governed daily participation obligation inside the free agent auction. It is not an optional convenience action. UPS_V2 must track nomination-cycle eligibility, completion-state exemptions, missed-cycle violations, and any supplemental reopen events in governed state rather than leaving those decisions to manual commissioner memory.

## Auction nomination window
### Start
- the free agent auction opens at `12:00 PM ET`
- the first nomination cycle runs only from auction open until `11:59:59 PM ET` that same calendar day
- during that first partial-day cycle, each non-exempt franchise is required to submit `2` nominations

### Daily reset
- the nomination clock resets at `12:00 AM ET`
- each subsequent auction day is a midnight-to-midnight cycle
- during each full cycle, each non-exempt franchise is required to submit `2` nominations

### End
- nomination duty ends when the free agent auction closes
- daily nomination duty may also stop earlier for a specific franchise if that franchise enters a governed nomination-complete state

## When `Nominate` may be shown
Show `Nominate` only when all of the following are true:
- the acting user has authority for the franchise
- the free agent auction is open
- the franchise is still allowed to nominate in the current nomination cycle
- the franchise has not already exhausted its allowed nominations for the current cycle
- the franchise is not locked out by a governed penalty or commissioner hold

## Nomination-complete state
A franchise may stop daily nominations only when UPS_V2 determines that one of the following is true:
- the franchise already has a full legal auction roster
- the franchise already has enough owned players to satisfy the minimum auction-completion roster requirement and a valid starting lineup
- the franchise does not yet have those players rostered, but its currently leading auction bids are sufficient to satisfy the remaining minimum-roster and lineup requirements if those bids hold

### Practical example
- if a franchise only needs a punter and is already the high bidder on a punter, UPS_V2 may treat that franchise as nomination-complete for that cycle
- if that punter bid is later lost and the franchise is no longer nomination-complete, UPS_V2 must reopen supplemental nomination access

## Stop-and-forfeit rule
- once a franchise is nomination-complete and stops nominating for a cycle, it is treated as having voluntarily ended discretionary nominations for the rest of the auction
- that franchise may not continue throwing extra nominations onto the board just because it later wants more optional bidding flexibility
- the only reopening path after that stop point is a governed supplemental nomination caused by loss of a required leading bid or other state change that breaks nomination-complete status

## Supplemental nominations
- UPS_V2 must allow a supplemental nomination when a franchise previously qualified to stop nominating, then loses a leading bid or otherwise falls back out of nomination-complete status
- supplemental nomination access exists only to restore the franchise's path to minimum roster and valid lineup completion
- supplemental nomination access must not be treated as a loophole to resume optional nominations after a franchise already stopped

## Missed nomination handling
- if a non-exempt franchise fails to satisfy the cycle's 2-nomination requirement, UPS_V2 must record a nomination violation
- current rulebook text confirms that missed nominations incur escalating penalties starting at `3K`
- the exact escalation ladder is not fully codified in the current rulebook and must therefore remain configurable and governed rather than hardcoded in feature logic
- UPS_V2 should track:
  - cycle missed
  - franchise
  - nominations required
  - nominations submitted
  - penalty ladder version
  - computed penalty amount
  - waiver or override reference when applicable

## Warning and block policy
- `warn_only`: franchise is close to nomination-complete state or has 1 of 2 required nominations submitted in the active cycle
- `soft_block`: franchise is in review because its complete-state calculation changed and a supplemental nomination may need commissioner confirmation
- `hard_block`: franchise already stopped nominating while nomination-complete and is trying to submit extra discretionary nominations; franchise is locked by penalty or commissioner hold
- `commish_override_allowed`: reopen nomination access when a governed supplemental nomination is justified by loss of a required leading bid or state-calculation error
- `commish_override_forbidden`: bypass the stop-and-forfeit rule just to give a nomination-complete franchise extra optional nominations

## Source-system cross-check
UPS_V2 must record site-settings alignment for:
- live MFL auction mode (`auction_kind`)
- live minimum bid and increment (`minBid`, `bidIncrement`)
- live salary-cap baseline (`salaryCapAmount`, `auctionStartAmount`)
- whether any MFL source setting exists for daily nomination cadence, nomination reset timing, or nomination-stop exemptions

If the source system does not expose those daily nomination controls directly, UPS_V2 must classify the rule as governed policy with `no_direct_source_setting`, not fake a source-backed setting.

## Source anchors
- current rulebook calendar anchor: free agent auction begins on the last weekend of July and requires a minimum 7-day nomination window
- current rulebook auction overview: missed nominations incur escalating penalties starting at `3K`
- current rulebook penalty section: exact penalty definitions are under review and not yet consistently codified
- settings-change notes: modern practice has used `2/day` with a `12 PM` start and `midnight` reset
- historical message-board evidence: owners with full rosters may not need to continue nominating, and late-auction nomination volume can collapse to remaining roster needs
- live MFL league export confirms the source auction is an `email` auction with `minBid=1000`, `bidIncrement=1000`, `auctionStartAmount=300000`, and `salaryCapAmount=300000.49`

## Open follow-ups
- codify the exact escalating missed-nomination penalty ladder once the rulebook overhaul or owner decision settles it
- define whether supplemental nominations reopen automatically from computed state or require commissioner acknowledgement in edge cases
- define whether nomination-complete state should key only off minimum roster plus valid lineup or also off full-roster completion when the franchise chooses to keep bidding
