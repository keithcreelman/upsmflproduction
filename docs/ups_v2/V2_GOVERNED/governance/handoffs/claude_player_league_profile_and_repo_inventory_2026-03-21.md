# Claude Passdown: Player League Profile and Repo Inventory

Last updated: `2026-03-21`

## Purpose
This document is a detailed passdown for Claude focused on:
- what is currently known about the UPS league from a player / owner perspective
- what is observed directly from live MFL metadata
- what is stated in the current local rulebook
- what has already been governed inside UPS_V2
- what local and cloud repos currently exist

This is not a replacement for the broader takeover brief. Read this alongside:
- [claude_takeover_handoff_2026-03-21.md](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/handoffs/claude_takeover_handoff_2026-03-21.md)

## Source basis and confidence

### High-confidence live source
- Live MFL league export for `74598`
- Live MFL rules export for `74598`

### High-confidence local source
- Current local rulebook JSON in V1: [`rules.json`](/Users/keithcreelman/Documents/New project/services/rulebook/data/rules.json)

### Governed UPS_V2 interpretation
- UPS_V2 workspaces, action rules, ambiguity register, and alignment register under [`V2_GOVERNED`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED)

### Historical / lower-confidence / pending-review support
- historical rulebook docs, forum material, Discord-backed evidence, and V1 reference inputs

Important reading rule:
- if live MFL metadata and local rulebook conflict, do not silently choose one. Treat it as a tracked discrepancy.

---

## 1. League identity
- League name from live MFL metadata: `UPS Salary Cap Dynasty`
- Live prod league ID: `74598`
- Primary test league ID: `25625`
- Format: dynasty, salary-cap, IDP, punter-inclusive, contract-based
- Player limit unit: `LEAGUE`
- One-copy player ownership: `rostersPerPlayer=1`
- Head-to-head enabled: `h2h=YES`
- Best-lineup / all-play auto optimization: `bestLineup=No`
- Decimal precision: `1`

## 2. League size and structure
- Franchises: `12`
- Divisions: `4`
- Division size: `3` teams each
- Division IDs seen in live metadata: `00`, `01`, `02`, `03`

## 3. Season window and standings metadata
- Start week: `1`
- End week: `17`
- Last regular season week: `14`
- Fantasy playoffs in rulebook: start Week `15`, run `3` weeks
- Standings sort from live MFL metadata: `PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR`
- Victory points metadata:
  - win = `2`
  - tie = `1`
  - loss = `0`

## 4. Roster and lineup structure

### MFL platform-level roster metadata
- `rosterSize=50`
- `injuredReserve=15`
- `taxiSquad=10`

Important interpretation:
- the MFL `rosterSize=50` is not the true governed active-roster operating rule
- the league uses custom active-roster min/max rules from the rulebook and workflow logic

### Governed active-roster rules from local rulebook
- Minimum active roster during fantasy season: `27`
- Maximum roster during free-agent auction: `35`
- Maximum roster after contract deadline date: `30`

### Starting lineup
Current local rulebook says the weekly valid lineup is:
- `1 QB`
- `2 RB`
- `2 WR`
- `1 TE`
- `2 Flex (RB/WR/TE)`
- `1 SuperFlex (QB/RB/WR/TE)`
- `1 K`
- `1 P`
- `2 DL`
- `2 LB`
- `2 DB`
- `1 Defensive Flex`

Live MFL starter metadata is consistent with that grouped structure:
- `QB 1-2`
- `RB 2-5`
- `WR 2-5`
- `TE 1-4`
- `PK 1`
- `PN 1`
- `DT+DE 2-3`
- `LB 2-3`
- `CB+S 2-3`

### Lineup locking
- Rulebook: lineups must be valid before kickoff of the first game each week
- Players lock at the kickoff of their own NFL game
- A player may not be subbed in or out once his game starts

### Noted discrepancy to review
- Live MFL metadata currently reports `partialLineupAllowed=YES`
- Local rulebook clearly expects a valid full lineup and penalizes failure
- Claude should treat this as a live-settings review item, not assume the platform flag reflects the intended UPS rule

## 5. Special roster buckets

### Injured Reserve
- MFL IR slots available: `15`
- Local rulebook: IR states receive `50%` automatic cap relief
- IR-eligible categories listed locally:
  - NFL IR / related MFL IR designations
  - COVID-era IR
  - holdouts
  - certain suspension cases
- IR players do not count toward active roster limit

### Taxi squad
- Taxi max: `10`
- Local rulebook minimum composition: at least `1 IDP`
- Taxi eligibility:
  - only UPS rookie-draft picks from Round `2` or later
  - first `3` NFL seasons
- Taxi demotion deadline:
  - by contract deadline date for eligible rookies
  - in-season trade demotion before player kickoff when feasible
  - same-day kickoff trade leniency may push demotion to the following week

### Three-starting-QB rule
- Local rulebook says beginning at contract deadline date, teams may carry only `3` starting QBs
- Taxi exception:
  - if a taxi QB becomes a starter after Week 1, he does not count against the cap under the specified exception
- Enforcement:
  - if a team creates a 4th starting QB problem, compliance is due by the following Thursday kickoff
  - commissioner may drop the player that created the 4th-QB violation

## 6. Draft structure
- Rookie draft is live and rookie-only per MFL metadata:
  - `draft_kind=live`
  - `draftPlayerPool=Rookie`
- Live draft pick timer metadata: `draftLimitHours=0:25`
- Local rulebook says rookie draft is held on the Sunday of Memorial Day weekend and is a major live Discord event
- Draft rounds inferred from current local rulebook:
  - at least `6` rounds
  - Round `6` picks cannot be traded
  - Round `6` picks must be used on an IDP, kicker, or punter
- Rookie contracts:
  - rookies drafted are initially signed to `3-year` contracts

## 7. First-round rookie option
- Applies starting with the `2025` rookie class
- Applies only to first-round rookie picks
- Must be exercised before the contract deadline date of the final rookie-contract season
- Commissioner-governed current working rule in UPS_V2:
  - offensive option adds `5K`
  - defensive first-round option handling remains provisional and still needs final consolidation

## 8. Free agent auction

### Live MFL auction metadata
- Auction mode: `auction_kind=email`
- Auction start amount: `300000`
- Min bid: `1000`
- Bid increment: `1000`
- Salary cap amount in metadata: `300000.49`

### Local rulebook
- Normal target start: last weekend of July
- Auction lasts about one week
- Minimum of `7` days of nominations
- Auction is a mandatory league event
- Valid lineup must be achievable by auction completion
- Minimum roster by auction completion: `27`
- Maximum roster during auction: `35`
- Salary floor: `260K` by auction completion or contract deadline
- Proxy style bidding
- Winning high bid must stand for `36` hours

### UPS_V2 governed nomination rule
- Auction opens at `12:00 PM ET`
- Day 1 requires `2` nominations before midnight
- Each midnight-reset day thereafter requires `2` nominations
- Owners may stop only when nomination-complete
- If a required leading bid is lost after stopping, a supplemental nomination should reopen
- If an owner skips after becoming nomination-complete, discretionary nominations are over for the rest of the auction

### Auction roster lock / cut-down timing
- Current written rulebook says `3 days prior`
- Current commissioner-governed UPS_V2 direction says normally within `48 hours` before auction start, exact value configurable
- This is one of the places where operational practice has diverged from older written wording

### Missed nomination penalties
- Current rulebook explicitly says they escalate starting at `3K`
- Exact offense ladder is not consistently codified
- UPS_V2 currently treats the exact escalation ladder as unresolved configurable policy

## 9. Expired rookie auction
- Runs in the first week of May
- Nomination window: `2-3` days
- Starting bid: `1K` above prior-year salary
- Winning high bid must stand `36` hours
- Winner contracts follow free-agent auction contract rules
- If contract is more than `1` year, it must be submitted by the September contract deadline
- Winners may not be cut prior to the following free-agent auction

## 10. Waivers and FCFS

### Live MFL metadata
- Current waiver type: `BBID_FCFS`
- BBID conditional bidding enabled: `Yes`
- Max waiver rounds: `8`
- Minimum BBID bid: `1000`
- BBID increment: `1000`
- Default season BBID limit set extremely high: `9999999999`

### Local rulebook
- Blind bid waiver runs:
  - Thursday `9 AM`
  - Friday `9 AM`
  - Saturday `9 AM`
  - Sunday `9 AM`
- FCFS opens after Sunday morning waiver run
- FCFS remains open until player kickoff
- FCFS acquisitions default to:
  - salary `1K`
  - contract length `1 year`

## 11. Trades

### Live MFL metadata
- Default trade expiration days: `7`
- Lockout: `Yes`

### Local and governed trade rules
- Trade window opens at new league year
- Trade deadline is Thanksgiving kickoff
- Trades remain open during offseason and auction
- At least one non-salary asset must be included
- Trade salary may be included, but not through fake blind-bid semantics

### Governed traded-salary rule
- Current-season outgoing salary only
- Eligible outgoing salary sources:
  - active roster
  - IR
- Taxi excluded
- Max tradable salary = `50%` of eligible outgoing current-season salary
- Mirrored cap adjustments between sides

### Kicked-off-player trade handling
- Same-week processing after a player has already kicked off is not fully validated yet
- UPS_V2 target behavior is deferred next-week handling when source-safe
- Actual MFL behavior is scheduled for empirical validation in Week 1 2026 on test league `25625`

### Discord trade notifications
- UPS_V2 test-only behavior
- For franchise `0008`, both `upscommish` and `ups_commish` are valid test targets
- Current production owner mapping is not yet clean enough for broad rollout

## 12. Contracts

### Contract types
- Veteran
- Waiver Wire (`WW`)
- Rookie
- Front-loaded
- Back-loaded

### Baseline contract behavior
- Auction / expired rookie auction / pre-deadline waivers can become multi-year auction contracts
- Default auction/pre-deadline contract is `1 year` if no multi-year contract is filed
- Multi-year auction contracts can be `2` or `3` years
- Loaded contracts are available in allowed paths

### Contract caps
- Max salary: `300,000`
- No offseason max until roster cut date, per local rulebook wording
- Max non-rookie 3-year contracts: `6`
- Max loaded contracts: `5`

### Guarantees and cap penalties
- Most contracts carry `75%` TCV guarantee
- Salary earns `25%` per month from October to December
- Once season is rolled over, prior-year salary is treated as fully earned
- WW contracts under `5K` have `0%` guarantee
- WW contracts `5K+` have `65%` earned / `35%` cap-penalty exposure if dropped before rollover
- Cap penalty formula in local rulebook:
  - `(TCV * 75%) - Salary Earned`

## 13. MYM, extensions, restructures, tags

### MYM
- Max `3` MYMs per season
- MYM converts `1-year` deal into a multi-year contract at the same salary
- MYM cannot be loaded
- Preseason auction / preseason waiver players not contracted by deadline can usually MYM by end of Week 2
- In-season waiver acquisitions can usually MYM within `2 weeks`

### Extensions
- Final-year players are generally extension-eligible through contract deadline date
- Rookies or preseason waivers that were not contracted by deadline and not MYM'd by Week 2 may be extended by end of Week 4
- Trade-acquired final-year players may be extended within `4 weeks` of acquisition
- Extension schedule from current local rulebook:
  - Schedule 1 (`QB/RB/WR/TE`):
    - `+10K` for 1 year
    - `+20K` for 2 years
  - Schedule 2 (`DB/LB/DL/Kickers - IDP & Special Teams`):
    - `+3K` for 1 year
    - `+5K` for 2 years

### Restructures
- Restructures exist in V1 functionality and in historical rule material
- Current exact annual cap and interaction cleanup are not fully settled in the player-facing rulebook
- UPS_V2 still treats part of restructure governance as pending cleanup

### Tags
- Tag behavior exists historically and in V1/UI assumptions
- Current player-facing local rulebook is not yet cleanly codified for:
  - tag types
  - pricing formula
  - timing windows
  - repeat-tag limits
  - extension/trade interaction
- Treat tags as a known current governance gap, not as absent functionality

## 14. Compliance and penalties
- Local penalties section is explicitly under review and not fully consistent
- High-confidence penalty items currently visible:
  - late payments = `3K` per week
  - missed auction nominations escalate starting at `3K`
  - lineup non-compliance triggers penalties
  - cap-floor failure can result in immediate cap hit
- Low-confidence / still under review:
  - exact auction over-cap penalty ladder
  - exact missed-nomination escalation ladder
  - exact post-trade 24-hour compliance penalty behavior

## 15. Scoring summary

### High-confidence player-facing summary from live MFL rules export
- RB receptions: `0.8` each
- WR receptions: `1.0` each
- TE receptions: `1.5` each
- Passing TD: `6`, or `7` if `50+` yards
- Passing yards: `1 point per 25 yards`, plus bonuses:
  - `300-374` = `+1`
  - `375-424` = `+2`
  - `425+` = `+3`
- Interceptions thrown: `-2`
- Passing two-point conversion: `+2`
- Rushing TD: `6`, or `7` if `50+` yards
- Rushing yards: `0.1` per yard, plus bonuses:
  - `100-149` = `+1`
  - `150-199` = `+2`
  - `200-249` = `+3`
  - `250+` = `+5`
- Rushing two-point conversion: `+2`
- Receiving TD: `6`, or `7` if `50+` yards
- Receiving yards: `0.1` per yard, plus bonuses:
  - `100-149` = `+2`
  - `150-199` = `+3`
  - `200+` = `+5`
- Receiving two-point conversion: `+2`
- Field goals: distance-based, `0.1` per yard
- Missed FGs: short misses penalized, long misses not penalized
- Extra points made: `+1`
- Extra points missed: `-1`
- Punter average bonus:
  - `45.00-49.99` = `+1`
  - `50.00-59.99` = `+3`
  - `60.00+` = `+5`
- Local historical rule notes support:
  - punts inside the 20 = `4`
  - punt return yards = `0.05` per yard
  - kickoff return yards = `0.025` per yard
- IDP scoring clearly includes:
  - tackle buckets by position group
  - assists
  - tackles for loss
  - sacks
  - QB hits
  - passes defended
  - forced fumbles
  - interceptions
  - safeties
  - defensive / return TD categories
  - first downs at `0.2`

### Position-group tackle values observed from live MFL export
- `LB`: tackle `1`, assist `0.5`, tackle for loss `1`
- `CB/S`: tackle `1.3`, assist `0.8`, tackle for loss `1.5`
- `DT/DE`: tackle `1.5`, assist `0.5`, tackle for loss `1.5`

### Raw MFL scoring code appendix
The following codes were present in the live `rules` export. Some are high-confidence plain-English mappings, some should remain code-level until further cleanup:

| Code | Observed formula | Interpretation |
|---|---:|---|
| `CC` | RB `0.8`, WR `1.0`, TE `1.5` | receptions / catches |
| `PS` | `6`, `7` if `50+` | passing TD |
| `PY` | `.1/2.5` plus 300+ bonuses | passing yards |
| `IN` | `-2` | interceptions thrown |
| `#IT` | `-4` | likely pick-six thrown / interception TD against passer |
| `TSY` | `-.1` | likely sack yards lost |
| `P2` | `2` | passing 2-point conversion |
| `RS` | `6`, `7` if `50+` | rushing TD |
| `RY` | `.1` plus 100+ bonuses | rushing yards |
| `R2` | `2` | rushing 2-point conversion |
| `RC` | `6`, `7` if `50+` | receiving TD |
| `CY` | `.1` plus 100+ bonuses | receiving yards |
| `C2` | `2` | receiving 2-point conversion |
| `FG` | `.1` per yard | field goals made |
| `MG` | short-miss penalty | missed FG handling |
| `EP` | `1` | extra point made |
| `EM` | `-1` | extra point missed |
| `ANY` | `45+=1`, `50+=3`, `60+=5` | punter average bonus |
| `PI` | `4` | locally supported as punts inside 20 |
| `UY` | `.05` | punt return yards |
| `KO` | `6` / `7` | kickoff return TD |
| `KY` | `.025` | kickoff return yards |
| `FL` | `-2` | fumbles lost |
| `PD` | `1.5` | passes defended |
| `SK` | `3` | sacks |
| `QH` | `0.5` | QB hits |
| `FF` | `2` | forced fumbles |
| `SF` | `2` | safeties |
| `D2` | `2` | defensive two-point return |
| `FD` | `.2` | first downs |

Additional turnover / block / return codes present in live export and still worth a cleanup pass:
- `PR`, `DR`, `FR`, `IR`, `MF`, `FC`, `IC`, `#FT`, `#BF`, `BLF`, `#BP`, `BLP`, `BLE`, `HBP`

## 16. Known gaps or current contradictions from a player perspective
- MFL says `partialLineupAllowed=YES`, while the local rulebook expects a valid full lineup
- Written auction lock says `3 days`, current commissioner-governed operational norm is within `48 hours`
- Trade 24-hour compliance wording exists in legacy/current rulebook text, but governed UPS_V2 direction is that trades should not auto-reverse
- Tags are historically real but not yet cleanly codified in the current player-facing local rulebook
- Restructure limits and interactions still need final cleanup
- Exact missed-auction-nomination penalty ladder is not codified
- Exact auction over-cap penalty / bidding block model is not fully settled

---

## 17. Repo inventory for Claude

### Relevant UPS / MFL repos observed locally

| Local path | Current branch | Cloud remote(s) observed | Relevance |
|---|---|---|---|
| [`/Users/keithcreelman/Documents/New project`](/Users/keithcreelman/Documents/New project) | `main` | `https://github.com/keithcreelman/upsmflproduction.git` | Primary live V1 repo |
| [`/Users/keithcreelman/Documents/mfl/Codex/version2`](/Users/keithcreelman/Documents/mfl/Codex/version2) | `main` | none configured | UPS_V2 clean rebuild repo |
| [`/Users/keithcreelman/Documents/mfl_app_codex`](/Users/keithcreelman/Documents/mfl_app_codex) | `main` | `https://github.com/keithcreelman/ups-league-data` | Additional UPS/MFL-related repo observed locally |

### Additional local Git repos found under `/Users/keithcreelman/Documents`

| Local path | Current branch | Cloud remote(s) observed | Relevance note |
|---|---|---|---|
| [`/Users/keithcreelman/Documents/FITFO/fitfo_condorcoolers`](/Users/keithcreelman/Documents/FITFO/fitfo_condorcoolers) | `main` | none configured | Appears unrelated to UPS/MFL |
| [`/Users/keithcreelman/Documents/FITFO/project2_CONDOR`](/Users/keithcreelman/Documents/FITFO/project2_CONDOR) | `main` | none configured | Appears unrelated to UPS/MFL |

### Cloud remotes explicitly observed
- [upsmflproduction](https://github.com/keithcreelman/upsmflproduction)
- [ups-league-data](https://github.com/keithcreelman/ups-league-data)

### Important repo note
- `UPS_V2` currently has **no remote configured** in the local checkout I inspected.
- If Claude is expected to push UPS_V2, remote setup still needs to be completed.

---

## 18. Recommended reading order for Claude from this passdown
1. [claude_takeover_handoff_2026-03-21.md](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/handoffs/claude_takeover_handoff_2026-03-21.md)
2. [MASTER_PLAN_v7.md](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/MASTER_PLAN_v7.md)
3. [rule_ambiguity_register.csv](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/rule_ambiguity_register.csv)
4. [site_settings_alignment_register.csv](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/site_settings_alignment_register.csv)
5. [contract_actions_workspace.md](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/contract_actions_workspace.md)
6. [trade_offer_action_rule.md](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/trade_offer_action_rule.md)
7. [auction_nomination_rule.md](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/actions/auction_nomination_rule.md)

## 19. Bottom line
- UPS is a 12-team dynasty salary-cap IDP league with contracts, auctions, waivers, punters, taxi, IR, and heavy custom governance.
- Live MFL metadata covers the structural platform layer.
- The local rulebook covers most player-facing custom rules.
- UPS_V2 has already locked several major behaviors, but tags, restructures, some penalty ladders, and some source-setting discrepancies still need cleanup.
- Claude should treat this document as a detailed player/owner profile and repo map, not as a claim that every historical rule drift has already been reconciled.
