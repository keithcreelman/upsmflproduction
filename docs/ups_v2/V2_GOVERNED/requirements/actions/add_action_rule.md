# Add Action Rule

## Purpose
This document defines when the `Add` action is allowed to appear and how UPS_V2 should route acquisition behavior for an unrostered player.

## Governing source review
The current local source set was reviewed before defining this rule:
- MFL league settings archive: `/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/archive/league_settings.csv`
- current governed rulebook output: `/Users/keithcreelman/Documents/New project/services/rulebook/data/rules.json`
- current settings-drift notes: `/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/settings_changes.md`

The league settings archive confirms the current league structure context such as league identity, salary-cap usage, roster sizing, taxi, IR, and season shape. It does not expose a full current MFL add/drop configuration export with every waiver toggle. For current add timing, the most specific local authority is therefore the current rulebook text, supported by the settings-change notes.

## Governing rule
In UPS_V2, `Add` is one acquisition concept. Whether the live acquisition mode is BBID waivers or FCFS, the roster page should resolve the same governed add concept and then present the correct live path for that moment.

A player may only surface an immediate `Add` action when all of the following are true:
- the player is not currently on any roster
- the acting user has authority to add for the selected franchise
- the selected franchise has enough roster capacity and cap room for a valid acquisition
- the player is in a currently open direct-add window rather than a waiver-bid-only window
- the player's NFL game has not already kicked off if the active acquisition mode closes at kickoff
- no league calendar block, workflow lock, or publish lock currently prevents the acquisition

If those conditions are not met, UPS_V2 must not show a dead `Add` button.

## Current league acquisition timing
Based on the current rulebook and live 2026 league export review:
- the live waiver mode is `BBID_FCFS`
- Blind Bid Waivers run on Thursday, Friday, Saturday, and Sunday at 9 AM during the NFL season
- after the Sunday morning waiver run, FCFS free agency opens
- FCFS remains open until the kickoff of the player's respective game
- owners must still maintain roster and cap compliance when adding a player
- the live 2026 league export currently reports `endWeek=17` and `nflPoolEndWeek=17`


## Start and end boundaries
### Add window start
The add window start is not a fixed calendar constant. It must be derived as:
- `first_configured_waiver_run_after_free_agent_auction_completion`

Operationally, UPS_V2 should compute this from:
- the actual free-agent auction completion timestamp for the season
- the configured waiver run cadence for that season

For governance purposes, use these source anchors:
- auction timing anchor: `transactions_auction`
- waiver cadence anchor: current rulebook plus live MFL waiver mode

Confirmed historical example:
- 2025 free-agent auction transactions started on `2025-08-03 12:01:35` ET and last auction activity was `2025-08-13 06:28:41` ET
- under the current Thu/Fri/Sat/Sun 9 AM waiver cadence, the first post-auction waiver run is therefore `2025-08-14 09:00 ET`

2026 planning target:
- the normal target period is the last weekend of July
- in 2026, that weekend is `July 25-26, 2026`
- auction timing may remain operationally fluid when league availability, vacations, or commissioner logistics require adjustment
- because the 2026 auction has not happened yet, the exact add-window start cannot be confirmed today
- planning target: if the 2026 auction follows the recent pattern and closes in the midweek window after that start, expect the first post-auction waiver run to fall around `Thursday, August 6, 2026 at 9:00 ET`
- this is a forecast only and must not be treated as confirmed until the 2026 auction actually closes

### Cut-down lead before auction
The final cut-down day should normally fall no more than `48` hours before the free-agent auction starts.

Governed operating rule:
- this lead exists so cap hits and other roster-accounting effects can be finalized before the auction begins
- the rule may be tightened later if automation makes same-day accounting safe, but UPS_V2 should preserve the current operating standard for now
- this should be treated as a normal operating target, not an immutable historical constant

### Forecast method for pre-season planning
When the auction has not yet occurred, UPS_V2 should estimate auction completion from league operating history rather than use a blind placeholder.

The planning estimate should consider:
- auction start date from the normal last-weekend-of-July target period or later confirmed event date
- the current nomination norm of `2` nominations per owner per day
- historical auction duration in the modern era
- estimated roster-fill pressure across the league
- the forced final day, where nomination volume can exceed the normal pace because rosters must be completed

Current historical signal from local auction data:
- recent free-agent auctions have lasted about `10` to `12` active calendar days in the modern two-nomination era
- 2024 auction activity spanned `12` distinct dates
- 2025 auction activity spanned `11` distinct dates
- older auctions ran longer in the earlier one-nomination era, so those seasons should not drive the current default estimate

Governed planning rule:
- default the forecast to the modern two-nomination pattern, not the older one-nomination pattern
- include a forced-close compression assumption for the last day rather than assuming every day behaves like a normal nomination day
- once the live auction begins, replace the forecast with actual auction activity and recompute the first post-auction waiver run from the real completion timestamp

### Add window end
The add window end must be derived from league metadata, not hardcoded by prose.

Operationally, UPS_V2 should compute this from:
- `metadata_leaguedetails.end_week`
- fallback: `metadata_leaguedetails.last_regular_season_week` if `end_week` is absent
- live confirmation source: MFL `league` export

Current confirmation:
- the live 2026 MFL `league` export for league `74598` reports `endWeek=17`
- therefore the current add window should remain open through the final eligible acquisition window in week 17, then close once the league moves past that configured end week

## Visibility outcomes
For a selected player, UPS_V2 should resolve one of these outcomes:

### `show_add`
Use `Add` only when the player is unrostered and direct acquisition is currently legal.

### `show_acquisition_path`
If the player is acquirable only through waivers, the roster page should show the correct acquisition path such as `Waiver Bid` or `Acquisition` instead of pretending this is an immediate add.

### `hide_add`
Hide `Add` when any of the following is true:
- player is already on a roster
- the franchise lacks authority, roster space, or cap room
- the player is only available through a different acquisition flow
- the player's kickoff has passed for the active direct-add window
- a deadline, event window, or active workflow lock prevents the move

## UX rule
UPS_V2 should describe why a player is not directly addable through player status, warning text, or eligibility context. It should not render a disabled `Add` button just to show that the action exists in theory.

## V2 implementation rule
Roster Operations owns discovery and launch of the add path.
- If the player is directly addable now, show `Add`.
- If the player is only waiver-eligible now, show the waiver-oriented acquisition action instead.
- If the player is not acquirable now, show context only.

## Source notes
Current rulebook sections used:
- `R-7.1 Overview`
- `R-7.2 Blind Bid Waivers`
- `R-7.3 First-Come, First-Serve (FCFS) Free Agency`
- `R-7.4 Waiver Compliance and Responsibilities`

Current change-notes used:
- blind-bid run days changed to Thu/Fri/Sat/Sun in the current rule set
- FCFS expanded to post-Sunday-waiver-run until kickoff in the current rule set
- free-agent auction timing has varied by season even though the normal target period remains the last weekend of July

Operational confirmation used:
- local ETL logic already uses `transactions_auction` as the auction timing anchor
- recent local auction history shows the modern two-nomination era typically produces an 11-to-12-day auction window before post-auction waivers begin
- local ETL logic already uses `metadata_leaguedetails.end_week` with fallback to `last_regular_season_week` as the season-completion anchor
- live MFL 2026 `league` export confirms `currentWaiverType=BBID_FCFS`, `endWeek=17`, and `nflPoolEndWeek=17`

## Site settings cross-check
This rule must be validated against the live MFL source system when a matching site setting or export field exists.
- if the live site settings match, record `matched` in the governed alignment register
- if the live site settings differ, record whether the rule should change, the site settings should change, or the mismatch is an intentional override
- if no direct MFL setting exists for part of the rule, record `no_direct_source_setting` and keep the governed basis explicit

## Follow-up
If you later provide a direct current MFL add/drop settings export for league `74598`, this rule should be revalidated against that export and promoted through the normal governance review path if any switch-level discrepancy appears.
