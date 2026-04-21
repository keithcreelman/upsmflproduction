# Drop Action Rule

## Purpose
This document defines when the `Drop` action is allowed to appear and how UPS_V2 should gate player release behavior from a rostered-player context.

## Governing source review
The current governed rule is based primarily on commissioner direction in this session, with local rulebook context used only as supporting evidence for auction-lock behavior.

Reviewed local sources:
- current governed rulebook output: `/Users/keithcreelman/Documents/New project/services/rulebook/data/rules.json`
- current settings-drift notes: `/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/settings_changes.md`
- live MFL 2026 league export for league `74598`

## Governing rule
A player may only surface `Drop` when all of the following are true:
- the player is currently on the selected franchise roster
- the acting user has authority to drop for the selected franchise
- the current date is on or after the new league website start for that season
- the current date is not past the league end date for that season
- the player's NFL team game has not already started
- the league is not inside the pre-auction roster-lock window
- the free-agent auction is not currently active
- no workflow lock, publish lock, or commissioner hold currently prevents the release

If those conditions are not met, UPS_V2 must not show a dead `Drop` button.

## Start and end boundaries
### Drop window start
The drop window starts when the new league website for that season is live and the league has rolled into the new operating season.

Operationally, UPS_V2 should derive this from the season-launch context rather than a hardcoded date string.

### Drop window end
The drop window ends at the league end date for the configured season.

Operationally, UPS_V2 should derive this from league metadata:
- primary: `metadata_leaguedetails.end_week`
- fallback: live MFL `league` export `endWeek`
- secondary fallback: `metadata_leaguedetails.last_regular_season_week` only if the end-week field is absent

Current confirmation:
- the live 2026 MFL `league` export for league `74598` reports `endWeek=17`
- therefore the governed drop window currently runs through the week-17 league end boundary unless a more specific season-close event is configured

## Exception windows
### Player game-start lock
Once a player's NFL team's game has already started, that player must not be droppable.

### Pre-auction roster-lock window
There is a short pre-auction lock window where drops are not allowed before the free-agent auction begins.

Governed implementation rule:
- this lock window must be driven by season event configuration, not hardcoded prose
- current commissioner direction is that the lock lead is a short `1` to `2` day operational window before auction start
- because the exact lead can vary operationally, UPS_V2 should store and resolve a season-specific `pre_auction_drop_lock_days` value

### Auction-active lock
Once the free-agent auction is active, players may not be dropped until the auction is complete.

Supporting local rulebook context:
- the rulebook already states that rosters lock before the auction and remain locked until auction completion

## Visibility outcomes
For a selected player, UPS_V2 should resolve one of these outcomes:

### `show_drop`
Use `Drop` only when the player is rostered and no timing or workflow lock prevents the move.

### `show_context_only`
Do not show a `Drop` action when the release is blocked by game-start, auction-lock, season-end, or workflow state. Explain the reason through player status, deadline context, or roster warnings.

### `hide_drop`
Hide `Drop` completely when the selected player is not on the acting franchise roster.

## UX rule
UPS_V2 should treat `Drop` as an always-important roster action, but it should only appear when release is currently legal. If a player cannot be dropped because of kickoff, auction lock, or season-close state, explain that context in the player detail area instead of showing a dead release button.

## V2 implementation rule
Roster Operations owns discovery and launch of the drop path.
- if the player is currently droppable, show `Drop`
- if the player is rostered but temporarily locked, show context only
- if the player is not on the acting roster, do not show `Drop`

## Site settings cross-check
This rule must be validated against the live MFL source system when a matching site setting or export field exists.
- if the live site settings match, record `matched` in the governed alignment register
- if the live site settings differ, record whether the rule should change, the site settings should change, or the mismatch is an intentional override
- if no direct MFL setting exists for part of the rule, record `no_direct_source_setting` and keep the governed basis explicit

## Follow-up
The pre-auction lock lead must be stored as governed season configuration. Until that season-specific field is formalized, the rule should treat the lock as a configurable short window rather than pretending the exact number of days is universally fixed.
