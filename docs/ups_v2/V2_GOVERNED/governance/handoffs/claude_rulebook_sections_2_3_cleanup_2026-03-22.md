# Claude Code Directions: Rulebook Sections 2 and 3 Cleanup

Last updated: `2026-03-22`

## Purpose
Use this as the working correction sheet for the current rulebook rewrite. These instructions come from Keith's direct review plus V1 source inspection. Do not rely on the current prose alone where it conflicts with the live site/module behavior.

## First principles
- Use the V1 site/module behavior as the baseline where Keith explicitly identified it as source of truth.
- Cross-check every calendar item against the live site/widget before treating it as settled.
- If the site does not expose a date cleanly, flag it instead of inventing it.
- If the rulebook text and the site/widget disagree, call out the mismatch explicitly.

## Source-of-truth files for this pass
- Tag module: [`/Users/keithcreelman/Documents/New project/site/ccc/ccc.js`](/Users/keithcreelman/Documents/New project/site/ccc/ccc.js)
- Countdown / calendar widget: [`/Users/keithcreelman/Documents/New project/site/ups_options_widget.js`](/Users/keithcreelman/Documents/New project/site/ups_options_widget.js)
- 2026 widget schedule: [`/Users/keithcreelman/Documents/New project/site/ups_options_widget_schedule_2026.json`](/Users/keithcreelman/Documents/New project/site/ups_options_widget_schedule_2026.json)
- Current rulebook JSON: [`/Users/keithcreelman/Documents/New project/services/rulebook/data/rules.json`](/Users/keithcreelman/Documents/New project/services/rulebook/data/rules.json)
- Historical/current rulebook structure: [`/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/archive/current_rulebook_struct.json`](/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/archive/current_rulebook_struct.json)
- Operational league DB: [`/Users/keithcreelman/Documents/New project/mfl_database.db`](/Users/keithcreelman/Documents/New project/mfl_database.db)

## Section 2: League Overview and Format

### Keep
- `Identity` -> `Overview`
- No conferences
- Four divisions shown cleanly
- Realignment every 3 years, with 2026 formula still under review
- Governance written honestly:
  - Commissioner handles day-to-day administration
  - Competition Committee handles rule proposals
  - Formal voting process remains open under `AMB-001`
- Dues clearly split:
  - `$100` before auction
  - `$100` by Thanksgiving
- Prize pool math shown explicitly:
  - `$2,400 in`
  - `$2,400 out`

### Do not overstate
- Do not present the formal voting process as if it is already fully settled.
- Do not reintroduce old structural baggage just because it existed historically.

## Section 3: Season Calendar

### Calendar structure correction
The current phase split is fighting the real dates.

Replace the current three-part framing with something that does not misplace cut-down and auction timing:
- Off-season: new league year through rookie draft weekend
- Auction / Pre-season: cut-down through Week 1
- In-season: Week 1 through season complete

Reason:
- cut-down and FA auction both occur in late July
- calling August the start of "pre-season" makes the current ordering look wrong

## Tagging

### Remove old tag wording
We no longer use `Franchise Tag` / `Transition Tag` wording.

Replace it with the current tag concept from the V1 tag module.

### Current baseline to document
- only expired non-rookie contracts are tag-eligible
- max `1` offensive tag and `1` defense/ST tag per team
- players are tiered by prior season Week 1-17 UPS total-points rank
- use the module's tier math and opening-bid logic
- old compensation language should be removed

### V1 source anchors
- One-per-side limit: [`/Users/keithcreelman/Documents/New project/site/ccc/ccc.js#L17`](/Users/keithcreelman/Documents/New project/site/ccc/ccc.js#L17)
- Tag deadline derived from Memorial Day minus 4 days: [`/Users/keithcreelman/Documents/New project/site/ccc/ccc.js#L280`](/Users/keithcreelman/Documents/New project/site/ccc/ccc.js#L280)
- Tier rules: [`/Users/keithcreelman/Documents/New project/site/ccc/ccc.js#L2960`](/Users/keithcreelman/Documents/New project/site/ccc/ccc.js#L2960)

### 2026 date
- Tag / expiring-rookie deadline is currently overridden on the live widget as:
  - `2026-05-21 12:00 ET`
- Source: [`/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L55`](/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L55)

## Expiring Rookie Auction

### Wording correction
Do not say:
- rookie contracts in their final year that are not extended

Say:
- expired rookie contracts that were not extended are placed into the Expired Rookie Auction

### Rules to include
- they cannot be cut prior to the contract deadline
- they can receive a regular auction-style contract similar to a FA auction player

### Timing guidance
- tie this to rookie-draft weekend timing, not a generic "first week of May"
- current site/widget overrides for 2026 are:
  - expiring deadline: `2026-05-21 12:00 ET`
  - rookie draft: `2026-05-24 6:30 PM ET`
- Sources:
  - [`/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L55`](/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L55)
  - [`/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L56`](/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L56)

### Operational note
If the site does not explicitly expose the 2026 expired-rookie-auction start date:
- flag it for Keith
- cross-check Discord
- do not fabricate a date

## Rookie Draft

### Keep
- Sunday of Memorial Day weekend
- live Discord event
- major annual league event

### Change wording
- remove "proxy" language
- say owners must be:
  - present in person, or
  - reachable by cell phone, or
  - connected through the Discord livestream

### Draft order correction
Do not say draft order is based on prior season final standings.

Use:
- Rounds 1-5 are based on prior season playoff results
- Round 6 is randomized

Sources:
- [`/Users/keithcreelman/Documents/New project/services/rulebook/data/rules.json#L178`](/Users/keithcreelman/Documents/New project/services/rulebook/data/rules.json#L178)
- [`/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/archive/current_rulebook_struct.json#L231`](/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/archive/current_rulebook_struct.json#L231)

## Free Agent Auction

### Wording correction
Do not say the auction "is held" on the last weekend of July.

Say:
- it starts on the last weekend of July
- it can slide into early August if needed
- it typically runs about 10-12 active days in recent seasons

### Recent operational evidence from `transactions_auction`
- 2023:
  - first FA-auction bid: `2023-07-29 14:01:12 ET`
  - last FA-auction bid: `2023-08-08 15:33:59 ET`
  - active dates: `11`
- 2024:
  - first FA-auction bid: `2024-07-27 12:11:03 ET`
  - last FA-auction bid: `2024-08-07 04:55:50 ET`
  - active dates: `12`
- 2025:
  - first FA-auction bid: `2025-08-03 12:01:35 ET`
  - last FA-auction bid: `2025-08-13 06:28:41 ET`
  - active dates: `11`

### 2026 site override currently in widget
- FA auction start: `2026-07-31 12:00 ET`
- Source: [`/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L58`](/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L58)

## Roster Cut-Down Day

### Ordering correction
Cut-down must appear before the FA auction, not after it.

### 2026 site override currently in widget
- cut-down: `2026-07-29 12:00 ET`
- FA auction start: `2026-07-31 12:00 ET`

Sources:
- [`/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L57`](/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L57)
- [`/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L58`](/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L58)

## Contract Deadline and Extension Windows

### Clarify the categories
At the contract deadline, include:
- auction contracts
- restructures
- preseason waiver players receiving multi-year contracts
- extensions for players already under contract and entering their final year

Do not blur that with the later in-season extension window.

### In-season extension clarification
Separate these two groups clearly:
- players already under contract before the auction and entering the final year of that contract
- players acquired in auction / preseason waivers who were not already under contract

### 2026 timing
- Week 1 kickoff from schedule file: `2026-09-10`
- Week 4 kickoff from schedule file: `2026-10-01`
- Keith wants the preseason-acquisition extension window to effectively run until just before Week 4
- the currently discussed date is `2026-10-07`, but the prose should make the logic clearer than the shorthand

Sources:
- [`/Users/keithcreelman/Documents/New project/site/ups_options_widget_schedule_2026.json`](/Users/keithcreelman/Documents/New project/site/ups_options_widget_schedule_2026.json)
- [`/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/archive/current_rulebook_struct.json#L525`](/Users/keithcreelman/Documents/New project/services/rulebook/sources/rules/archive/current_rulebook_struct.json#L525)

## Hyperlinks
Every `See Section X` reference should be a real hyperlink.

At minimum, hyperlink:
- MYM
- trades
- playoffs
- roster rules
- tags
- contracts

## Trade Deadline

### Keep the rule text
Use the exact anchor:
- kickoff of the first NFL Thanksgiving game

### Important caution
Do not trust the current widget fallback as the exact 2026 time without validating that it points to the first Thanksgiving game, not a later Thursday kickoff slot.

Relevant source:
- [`/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L727`](/Users/keithcreelman/Documents/New project/site/ups_options_widget.js#L727)

Safe rulebook behavior:
- use the date
- keep the anchor formula
- avoid overstating an exact time unless it has been confirmed from the right Thanksgiving game

## Playoffs and Bowls

### Keep
- regular season ends Week 14
- playoffs run Weeks 15-17

### Add
- `UPS Bowl`
- `HawkTuah Bowl`

## Site-settings alignment rule for this rewrite
For every item in Section 3:
- if the site/widget has a date, use it
- if the rulebook prose differs from the site/widget, flag the discrepancy explicitly
- if the site/widget is missing the date, say so and flag it for follow-up

## Short implementation checklist
- rewrite tag section using current tag model, not franchise/transition language
- rewrite expired rookie auction wording and tie it to rookie-draft weekend flow
- fix rookie draft order explanation
- change FA auction phrasing to "starts" and reference recent duration
- move cut-down before FA auction
- tighten contract-deadline vs in-season-extension language
- hyperlink every section reference
- add UPS Bowl and HawkTuah Bowl
- do not silently invent dates missing from site/widget
