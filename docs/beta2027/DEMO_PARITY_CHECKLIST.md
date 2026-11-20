# UPS 2027 Beta: demo parity checklist and staged plan

**Status: DRAFT for Keith's decision. Planning only.** Nothing here builds, deploys, enables a write or touches the original mobile app or the approved prototype. Companion record: issue #1475 (revision 11) and PR #1477 (Preview 0).

## 1. The ruling this answers

Keith (chat, 2026-11-20): the beta must match the approved demo **1:1 across the full experience**, with the demo as the product and interaction spec: every screen, section, badge, deadline, control and action it shows. Actions are not to be left out because Preview 0 was scoped read-only, and they must **work for real**, built and verified against the **test league first**, with **read-back confirmation from MFL for each transaction type**. Production and live-league writes stay **disabled** until the test-league flows pass **and** Keith separately approves enabling them in the invited beta. Do not deploy the expanded build or enable production writes without separate approval.

**Decision 1 (Keith, chat 2026-11-20): A, recorded.** The **Preview build shows the complete Actions UI and every review sheet, with Submit disabled and no write code in that build** (a test must pin that the Preview artifact contains no submit or write module and makes no non-GET request). **Real transactions live only in the Test build, against league 25625.** Each flow is tested and verified there first, then brought back to Keith for **separate approval before it is enabled in the invited beta.** This ruling does not start implementation and changes neither the approved demo nor the original mobile app.

**Decision 2 (Keith, chat 2026-11-20): demo-only scope, recorded.** The pinned Player Profile Look demo (S1) is the source of truth for this parity work: the Home lineup card, Team (Roster, Contracts, Cap & picks), the player profile, Actions and Contracts. **Market and the other areas listed below stay later, separately scoped specs and are not added to this implementation by implication.** No implementation or deployment is authorized by this decision.

**Decision 3 (Keith, chat 2026-11-20): the labeled "Helmet TBD" placeholder is approved, recorded.** The demo's dashed "Helmet TBD" circle on the profile photo is added as shown; **no helmet art is drawn or invented.** His earlier choice to leave the badge out is superseded by the direction to match the pinned demo 1:1. No implementation or deployment is authorized by this decision.

**Decision 4 (Keith, chat 2026-11-20): scaffolding treatment approved, recorded.** Scenario toggles go in client-only **Sample** mode and the appropriate Test controls. **Report a bug** replaces the Feedback tab and stays reachable throughout the app and inside sheets, carrying the current screen and the captured error. The "Compare navigation A and B" sheet is dropped. Skin, vibrant colors and the position-group rule stay as owner settings. These are **explicit exceptions to visual and interaction parity** (section 5a). Sample scenarios stay clearly labeled and never send transactions. **During integration testing, bug reports go only to #keiths-test.** No implementation or deployment is authorized by this decision.

**Decision 5 (Keith, chat 2026-11-20): navigation B, four tabs, recorded.** The bottom bar is Home, Team, Market and League. **Fix lineup** on Home stays a one-tap shortcut into Team's lineup workspace. An unsaved-changes indicator shows inside that workspace, and the app prompts before navigating away with unsaved edits. **Market and League remain navigation destinations; their presence does not expand the scope approved in Decision 2.** No implementation or deployment is authorized by this decision.

**Decisions 6, 7 and 8 (Keith, chat 2026-11-20), recorded together.** **6 Test clock:** A, paired with B's closed-window refusal cases; the override is honored only for authorized Test sessions on league 25625, production never honors it, and it must not change the shared worker's global clock; the docs state which restrictions belong to our worker and which to MFL and never claim the override bypasses MFL's own rules. **7 Write order:** Report a bug first (routed only to #keiths-test during integration testing), then lineup, roster moves, drop, and contract actions; each flow needs verified results before the next. **8 Missing data:** use existing league and NFL sources first and audit the repository and the current app before building any new route or declaring data unavailable; establish a source for action eligibility, injury timing, opponents and kickoffs, weekly scoring history and the contract calendar; projections, news, bio and IR return dates use the demo's Unavailable state until a suitable source is approved; never infer an exact return date. **These rulings complete the planning decisions. Implementation and deployment approval remain separate.** The audit and the consolidated implementation proposal are in `docs/beta2027/IMPLEMENTATION_PROPOSAL.md`.

## 2. What "the demo" is (pinned versions)

| Source | What it is | Version and hash | Role here |
|---|---|---|---|
| **S1** Player Profile Look | The full phone prototype: Home lineup card, Team (Roster, Contracts, Cap & picks), lineup editing, week selector, player profile with four tabs, actions and their reviews, Controls | artifact `7Vd91JB79xS2KiozmEFaYx`, version `1795048681-ef20`, 172,746 bytes, SHA-256 `018131724bec1c0569406c4b2d8aca0c415b5011e4f51093a34f66b76d51e157` | **The spec.** |
| S2 Team Roster Prototype | The earlier approved roster prototype; it has the same 61 actions as S1, without the team-colored header | artifact `9azAfVTtAEziLmQnJyhf3H`, version `1795027966-fbfa`, SHA-256 `d47af1872d0621aad9770dfe41a6922c07762561a3023f6d46b6ecf39b1bfdf0` | Superseded by S1 for this checklist. |
| S3 Market Prototype | Find players, bids, claims | artifact `GAXhn4TaNqx8jxyHB7h1wi`, version `1795052304-7291`, SHA-256 `de1225be104b0554c0b243fcb8e65c363f1aafd108f028f2e9d3583adf9ddc72` | **Not in this checklist, and not added by implication.** Market is still in review per the Page Review; per Decision 2 it is a later, separately scoped spec. |
| S4 Page Review | The approval log: Team roster and Team › Contracts approved for the design concept 2026-11-17, Player profile 2026-11-18, Market in review, Home and Lineup/Trades/Auction/Draft/Commissioner/Desktop later | artifact `VJRJeTbwjfua4gb6wmfD9u`, version `1795092235-9a48` | Approval history. |

The approved prototypes are never edited. Comparisons use a local copy where only sample data is swapped for a real player.

## 3. How this was built, and how to read it

Every screen, sheet, state and control was listed from the demo's own code (S1: **61 distinct actions, 24 sheet types, 12 information topics, 5 navigation tabs in option A**), then compared with the beta as built (branch `claude/preview0-roster-profile` at `b9abb61`; the deployed preview is the earlier `dc1961a`). "Beta today" is what a reviewer can see in that build, measured in a real browser at 320 and 375 px where it concerns layout. Worker routes were found by reading `worker/src/index.js` and were **not exercised**.

**Status:** Built = matches the demo · Partial = exists but differs or is incomplete · Not built · Exception = a difference from the demo that Keith has ruled on (section 5a).

**Needs:** `W` a real write (test league first) · `D` a read source must be wired into the beta; an existing route or module often already provides it (see the audit in `IMPLEMENTATION_PROPOSAL.md`) · `A` the sign-in and identity work (Stage 2) · `X` a decision from Keith · `C` wording to verify against canon.

**Stage:** S1 read-only parity (public data, no write code) · S2 test-league foundation · S3a lineup · S3b roster moves · S3c drop · S3d contract actions · S3e report a bug.

## 4. Summary

| | Rows |
|---|---|
| Total checklist rows | **96** |
| Built | 10 |
| Partial | 21 |
| Not built | 60 |
| Exception (a ruled difference from the demo) | 5 |
| Need a real write (`W`) | 23 |
| Need new or unconfirmed read data (`D`) | 39 |
| Need a decision (`X`) | 7 |
| Need wording checked against canon (`C`) | 5 |

**In plain words:** the beta today is the read-only roster, the contract details and the team-colored profile header. Everything that edits (lineup, moves, drop, extension, restructure, MYAC, MYM) is not built, and several things the demo *shows* have no live data source yet (section 6).

## A. Shell, navigation, states

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| A1 | Bottom navigation | Five tabs (Home, Lineup, Team, Market, League) or four without Lineup; the choice is shown as open. Team tab shows a dot while a lineup change is unsaved. | Four tabs (Home, Team, Market, League). | Built | **Decided (Decision 5): B, four tabs.** Market and League stay navigation destinations only; their presence does not widen the scope (Decision 2). The unsaved-changes indicator lives inside Team's lineup workspace (C2, C26), not on the tab. |  | - |
| A2 | "Compare navigation A and B" sheet | A sheet that compares the two bars and their tap counts. | None. | Exception | **Dropped by ruling (Decision 4).** The navigation choice is Decision 5 (B). |  | - |
| A3 | Header and as-of line | Screen title, "✓ Fri 2:14 PM ET". | Title, ⓘ, "✓ Data as of … · Week 11". | Built | None. |  | - |
| A4 | Skins | Dark, Light, High contrast; Standard or Vibrant position colors. | Match my phone, Light, Dark, High contrast; Vibrant or Plain. All pass the contrast tests. | Built | None (the beta adds "Match my phone"). |  | - |
| A5 | Loading state | Skeleton rows and "Loading your roster…" / "Loading contracts…". | Skeleton rows on the roster; none for tabs that do not exist yet. | Partial | Skeletons for the Contracts tab and the profile tabs when they exist. |  | S1 |
| A6 | Failed read | "Couldn't read your roster. Try again." with Try again and Notify commissioner. | Failure card with Try again. No Notify commissioner. | Partial | Report a bug from the failure card, carrying the captured error (see G9). | A | S3e |
| A7 | Offline state | "You're offline. Reconnect to load your roster." No Notify button while offline (nothing is saved to send later). | Same failure card as any failed read. | Partial | Detect offline; the offline wording. |  | S1 |
| A8 | Information (ⓘ) sheets | Twelve topics: demo, lineup card, contract numbers, performance, schedule, projections, restructure, extension pricing, Mid-Year Multi, extension window, drop review, actions. | ⓘ opens "About Preview 0" (display settings, request log). No topic sheets. | Not built | Twelve sheets. Reuse the demo wording after checking each against canon (`docs/league_context_v1.md`). | C | S1 |
| A9 | Toast with Undo | "<Player> moved" with Undo (moves) or OK. | None. | Not built | Toast; the Undo reverses only until confirmed on MFL. | W | S3b |
| A10 | Week banner on sheets | "Week 11 · current week" or "future week · proposal" at the top of lineup sheets. | None. | Not built | With the week selector (C2). |  | S3a |
| A11 | Sheet chrome | Grab bar, title, dimmed scrim, Close. | Same. | Built | None. |  | - |
| A12 | Environment marker | "Demo · Sample data" bar with a Controls button. | None on the preview address. | Partial | Per the planning record: "Preview: view only"; a permanent red "TEST LEAGUE: nothing here is real" on every screen and confirm in Test mode. | A | S2 |
| A13 | Choose any team (beta only) | Not in the demo (it is always "you"). | Team picker sheet; any team's public roster. | Built | Keep as view-only ("View as another team"); every write control stays disabled while the viewed team differs from the proven franchise. | A | S2 |
| A14 | Sample mode label and safety | The demo labels itself "Demo · Sample data" and simulates every submit ("Simulated. Nothing was sent."). | None. | Not built | **Decision 4:** every Sample scenario is clearly labeled and **never sends a transaction**: a test must pin that Sample mode has no submit path and makes no request that is not a read of public data. |  | S1 |
| A15 | Unsaved changes: indicator and leave prompt | A dot on the Team tab while a lineup change is unsaved (five-tab option) and the pending bar "n unsaved · Undo · Review & save". | None. | Not built | **Decision 5:** an unsaved-changes indicator inside Team's lineup workspace (week chips and the pending bar, C2, C26) and a **prompt before navigating away with unsaved edits** (leave, or keep editing). The tab dot is not used in the four-tab layout. | W | S3a |

## B. Home

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| B1 | Home lineup card: needs fixing | "n lineup problem(s) to fix", the first three named, "On MFL 17 of 18 · locks Sun 1:00 PM · n unsaved", **Fix lineup**. | Placeholder: "Home is reviewed last". | Not built | The card and the issue count (needs injury timing, D3). | D | S1 |
| B2 | Home lineup card: ready | "✓ Lineup looks ready", "On MFL 18 of 18 · locks …". | Placeholder. | Not built | Same card. | D | S1 |
| B3 | Home lineup card: could not check | "Couldn't check your lineup. This is not an all-clear." Try again / Open Team. | Placeholder. | Not built | Same card; unknown is never an all-clear. |  | S1 |
| B4 | Rest of Home | "Rest of Home. Not in this prototype." | Placeholder. | Partial | Match the demo's placeholder wording (Home is reviewed last). |  | S1 |
| B5 | Fix lineup action | Opens Team on the Lineup view. | None. | Not built | **Kept as a one-tap shortcut (Decision 5)** into Team's lineup workspace. |  | S1 |

## C. Team › Roster (lineup, views, moves)

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| C1 | Cap strip | "$41,200 cap · Active 29/30 · Taxi 3 · IR 1". | Counts only ("Active 30 of 30 · Taxi 5 of 10 · IR 3 of 15"). Cap space is left out on purpose until it matches the Front Office number. | Partial | Cap space from the worker's cap math, reconciled to the Front Office number. | D | S1 |
| C2 | Week selector button | "Week 11 · current ▾" with "Saved on MFL · 18 of 18" or "Draft in app · not on MFL" and "n unsaved" chips. | Fixed to the current week. | Not built | Selector and chips. | D | S1 |
| C3 | Choose a week sheet | Weeks 11 to 17, each with its own saved, draft or not-set state. | None. | Not built | Sheet; per-week lineup reads. Whether MFL holds a future week is unproven (G1). | D W | S3a |
| C4 | "How future weeks work" proposal sheet | A design note: what main does today, server changes needed, test-league checks, two outcomes. | None. | Not built | Becomes the test plan for G1; shown only in Sample/Test. | X | S3a |
| C5 | Copy Week 11 lineup | Fills an empty future week from the current one. | None. | Not built | Action on an empty future week. | W | S3a |
| C6 | Roster view switch | Lineup · Performance · Contracts · Byes. | Lineup · Contracts. | Partial | Performance and Byes views. | D | S1 |
| C7 | Lineup status card | "18 of 18 starters", "n to fix", each problem with Fill or Replace and Details ›, "n not saved". | None (a note says nothing here can change the lineup). | Not built | Card, issue list and Details sheets. | D W | S3a |
| C8 | Status line on other views | "18 of 18 starters · nothing to fix · Open Lineup". | None. | Not built | Line. | D | S1 |
| C9 | Contracts-view summary | "n end after 2026 · Open full Contracts ›". | None. | Not built | Line (data is in the roster read). |  | S1 |
| C10 | Byes-view summary | "Week 11 · n on a bye · Week 12 · n". | None. | Not built | Line (bye weeks are in the roster read). |  | S1 |
| C11 | Performance-view summary | "Projected lineup 126.4 · last week 118.2". | None. | Not built | Last-week points from the weekly read; the projected figure shows the demo's **Unavailable** state until a projection source is approved (Decision 8). | D | S1 |
| C12 | Starters block with slot tags | "Week 11 starters · 18 of 18"; each row tagged with its slot (QB1 … SF, K, P, DL1, DF). | Starters in MFL's order with a position badge; no slot tags; "The lineup as MFL has it" note. | Partial | Slot tags from the league's lineup settings; keep "unknown is never empty". | D | S1 |
| C13 | Starter row controls | Swap (starter), Locked (game started), Start (bench), "Bye week" (disabled), Fill (empty slot). | None (read-only rows). | Not built | Controls; lock rules from kickoff times. | D W | S3a |
| C14 | Empty slot row | "Empty" with a Fill button, highlighted. | None. | Not built | Row. | W | S3a |
| C15 | Row status chips | ▲ Bye week, ■ OUT, ▲ Doubtful, ■ IR tag. | ▲ Bye week only. | Partial | Injury chips (needs the injury read; MFL's injuries export keeps lapsed designations, so timing must be derived). | D | S1 |
| C16 | Row: opponent and kickoff | "DAL · vs NYG" on lineup rows; kickoff for locks. | NFL team only. | Partial | Opponent and kickoff from a schedule read. | D | S1 |
| C17 | Row: IR return date | "SFO · back Dec 3". | None. | Not built | **Decision 8: never infer an exact return date.** Nothing is shown (the repo's injury resolver already forbids expected-return dates); the demo's Unavailable state applies if a place for it is kept. |  | S1 |
| C18 | Row: taxi call-ups | "DAL · 1/3 call-ups". | Shown on the profile More tab, not on the row. | Partial | Move to the row. |  | S1 |
| C19 | Row (Contracts view) | Type · through 2028 · cap note ("cap hit 50%" on IR, "taxi, $0 on cap"); salary; years left or "▲ Final year". | Type · through year; salary; years left or Final year. No IR or taxi cap notes. A missing salary reads "Not recorded". | Partial | IR and taxi cap notes. |  | S1 |
| C20 | Row (Performance view) | "Wk 10 18.2 · Avg 14.1 · vs NYG"; projection on the right. | None. | Not built | Weekly points and opponent from existing reads; projection shows **Unavailable** until a source is approved (Decision 8). | D | S1 |
| C21 | Row (Byes view) | "MIA · bye week 11 · week 11" and "Wk 11" with a Week chip. | None. | Not built | Row (data in hand). |  | S1 |
| C22 | Bench groups | By position; count; "Needs you" chip; Expand all / Collapse all; rule setting "All groups open" or "Only what needs you". | By position with counts; Expand all / Collapse all. | Partial | "Needs you" chip and the group rule (needs C7, C15). | D X | S1 |
| C23 | Injured reserve and Taxi sections | "Injured reserve · 1 of 15", "Taxi squad · 3 of 10", collapsible. | Same, with limits from the league settings. | Built | None. |  | - |
| C24 | Move buttons on rows | Move to IR · Activate from IR · Call up · Return to Taxi (only the first available). | None. | Not built | Buttons from the same eligibility the server uses (G2). | D W | S3b |
| C25 | Move review sheet | Effects table (active roster, taxi, IR, his cap hit, your cap space), checks, Confirm move, Cancel. | None. | Not built | Sheet from a server preview, not a client guess. | D W | S3b |
| C26 | Pending-changes bar | "Week 11 · 2 unsaved changes · Undo · Review & save", with "Also unsaved: Week 12". | None. | Not built | Bar. | W | S3a |
| C27 | Start picker | "Start <player> in…": slots that accept the position, with +/− projection delta, "fixes", "fills", "Locked". | None. | Not built | Picker. | D W | S3a |
| C28 | Sit / Swap picker | "Swap WR2": current player, eligible bench players (bye disabled, OUT flagged), "Leave WR2 empty". | None. | Not built | Picker. | D W | S3a |
| C29 | Locked sheet | "<Player> is locked: his game has started." | None. | Not built | Sheet. How MFL treats a locked player must be verified (the demo says so). | W | S3a |
| C30 | Review lineup sheet | Changes list (A → B, "goes to the bench"), checks (starters, injuries), "Save lineup to MFL" or "Save Week 12 draft in the app (not on MFL)". | None. | Not built | Sheet. | W | S3a |
| C31 | Lineup result sheets | Saved · "Sent, not confirmed" (Read it again) · "MFL rejected it" · "Draft saved" · "Not saved on MFL" (Keep as a draft). | None. | Not built | Real results from the read-back standard (confirmed, unconfirmed, mismatch, refused). | W | S3a |
| C32 | Lineup issue detail sheet | Per problem: facts (listed since, notice deadline, kickoff), Replace, "If this became a violation" (the §G3 ladder), "Timing, Injury Report and stages". | None. | Not built | Sheet; the ladder needs the team's confirmed-violation count (unknown must read "we couldn't read it"). | D C | S3a |
| C33 | "From possible issue to penalty" sheet | Four stages (possible, late news, pending review, confirmed) with the ladder, facts, what it means, what you can do, penalty, where you hear about it. | None. | Not built | Sheet; wording checked against §G3. | C | S1 |

## D. Team › Contracts tab

The demo's own title for it is "Team › Contracts" (approved for the design concept 2026-11-17).

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| D1 | Tab | Roster · Contracts · Cap & picks. | Same three tabs; Contracts shows "not in Preview 0". | Partial | Build the tab. | D | S1 |
| D2 | Total card | "Remaining guarantee through Week 10" (or Earned to date) with the league-wide total. | None. | Not built | Totals from the worker's cap-penalty answer (already read for one player at a time; the same route answers all players). | D | S1 |
| D3 | View, show and sort panel | View (All years / One year + year), Show (All, Active, IR, Taxi), Sort by (Name, Earned, 2026, 2027, 2028; direction). | None. | Not built | Panel and a one-line summary. |  | S1 |
| D4 | Sticky header and totals | Column headers with per-column totals; "Totals leave out n not recorded". | None. | Not built | Header. |  | S1 |
| D5 | Contract rows | Name, status tags (IR, Taxi), position · team · type, three years and Earned, "+ 2029 … beyond 2028", option year line. | None. | Not built | Rows (tokens are in the roster read). |  | S1 |
| D6 | Row detail | Salary by year with played / this season / future, Type, Total value, Guaranteed, Earned explanation, If cut now, "Open player profile ›", "What is this?". | None (the profile has most of it). | Not built | Expandable detail. |  | S1 |
| D7 | No terms recorded | "No terms recorded yet. That is not $0." | A missing salary reads "Not recorded" on the roster row and profile. | Partial | Same wording in the table. |  | S1 |
| D8 | Contract numbers sheet | "Contract numbers" glossary (Remaining guarantee, Earned, Waiver pickups, Full-year rule, Not available). | None. | Not built | Sheet (copy checked against canon). | C | S1 |

## E. Cap & picks tab

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| E1 | Cap & picks | "Not in this prototype. It comes in a later review." | "Not in Preview 0 …" | Partial | Match the demo's placeholder wording. Cap space and picks are separate later pages. |  | S1 |

## F. Player profile

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| F1 | Team-colored header | Hero in the player's NFL team colors: photo with ring, first/last name, team · position · type, status pills, stripe, label, small Close tag. | Built to within half a pixel of the demo at 320 and 375 px (commit `b9abb61`, awaiting Keith's review). | Built | Franchise name stays on the More tab. |  | - |
| F2 | Helmet badge | A labeled dashed "Helmet TBD" circle on the photo (no helmet art exists). | Left out (earlier Preview 0 ruling). | Not built | **Approved (Decision 3):** add the same labeled placeholder exactly as the demo draws it; never draw or invent helmet art. Real helmet art stays unapproved. |  | S1 |
| F3 | Actions button | Full-width "Actions · n available" (or "can't confirm") under the header. | None. | Not built | Button; opens the Actions sheet (F13). | D | S1 |
| F4 | Tabs | Performance · Schedule · Contract · More. | Same four; Contract is built, the others are partial or placeholders. | Partial | Build the other three. |  | S1 |
| F5 | Performance: season chips | Season chips (2026, 2025 …, ⚠ for incomplete history). | None. | Not built | Needs the history source. | D | S1 |
| F6 | Performance: season tiles | Season Pts, PPG, PPG rank at the position. | "Season points so far" and "Last week —". | Partial | PPG and rank. | D | S1 |
| F7 | Performance: Start / Boom / Bust | Percent and "n of m weeks" per rate; counts only for kickers and punters; "Not enough weeks yet (needs 3)". | None. | Not built | Rates over the league's own weekly lineups (definitions in the ⓘ sheet). | D C | S1 |
| F8 | Performance: projection | "Projection · Concept": this week, rest of season, projected PPG, source "Pending review"; Out of date and Unavailable states. | "Not in Preview 0". | Not built | **Decision 8:** the demo's **Unavailable** state until a suitable projection source is approved. |  | S1 |
| F9 | Performance: game log | Per week: vs/@ opponent, points, grade chip (Boom, Starter-level, Below, Bust), role (Started, Benched, On Team n, Free agent), BYE rows. | None. | Not built | Weekly scoring and roles. | D | S1 |
| F10 | Schedule tab | "Allowed to <position>"; next 4 or all remaining games with opponent, kickoff, allowed vs usual, % vs usual, rank of 32, games n. | "Not in Preview 0". | Not built | Opponent-allowed-to-position source. | D | S1 |
| F11 | Contract tab: tiles and years | Salary, Years left, Earned to date, Remaining guarantee; Salary by year (3 years); option year; beyond 2028. | Built, with "Not recorded" and worker-flagged states. | Built | Copy touch-ups ("Through Week 10"). |  | - |
| F12 | Contract tab: Deadlines | Closed actions with their reasons or dates (Extend, Restructure, MYAC, MYM, Tag: "Deadline 5/21 · Passed", "Auction contracts only"), plus the note that MYAC/MYM come before Extension. | "Closed actions and their deadlines are not in Preview 0." | Not built | Deadlines from the season calendar and the player's acquisition record. | D | S1 |
| F13 | Contract tab: Rules and totals, If cut now | Type, Total value, Guaranteed; cut penalty and its basis. | Built (read-only, from the worker's answer). | Built | None. |  | - |
| F14 | More tab | Injury, Owner, taxi call-ups, News (source and date), Bio. | Roster spot, team, acquired, taxi details. | Partial | Injury from the one shared resolver. **News and Bio show the demo's Unavailable state until a suitable source is approved (Decision 8)**; routes exist (`/api/player-news`, `/api/player-bundle`) but rights are unresolved. | D | S1 |
| F15 | Actions sheet | Lists what he can do now (each opens a review); closed ones show "Not available" with the reason; "Can't confirm" with Try again. | None. | Not built | Sheet from one server preview route that returns every action's state and reason (does not exist today). | D | S1 |

## G. Actions (each ends in a review, then a real submit with MFL read-back)

Per flow, the existing worker route found by reading the code (not exercised), the proof the demo's review needs, and the beta status. The beta calls existing routes and the worker's preview routes; it does not copy rules.

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| G1 | Lineup: start, swap, leave empty, save | Pickers, pending bar, review, save to MFL, result states, undo, future weeks as drafts. | None. | Not built | `POST /api/submit-lineup` (session required; the detected franchise must equal the requested one). Read-back via the lineup read for the same week. First test-league experiment: does MFL accept and keep a future week, or silently write the current week. | W D A | S3a |
| G2 | Roster moves: Move to IR, Activate, Call up, Return to taxi | Review sheet with effects and checks, Confirm, Undo toast. | None. | Not built | `POST /roster-workbench/action` (actions promote_taxi, demote_taxi, activate_ir, deactivate_ir, drop_player; owner-scoped imports). Call-up count and taxi rules from canon; read-back by a fresh roster read. | W D A | S3b |
| G3 | Drop player | Review: active roster, lineup effect, cap space, cut penalty from the worker, taxi eligibility, charge year, active minimum; Held when the worker is unsure; Submit. | None. The worker's penalty answer is already read. | Not built | Same route as G2 plus `GET /api/cap-penalty/preview`. The demo marks two things as proposed: the lineup effect of dropping a starter and the charge year; each needs a test-league check. | W D A | S3c |
| G4 | Extend contract | 1- or 2-year, escalator pricing, loading between two years (20% minimum), added cost, window path (held, auction win, trade, pickup), deadline, type (Vet-Ext1/Ext2, -FL/-BL). | None. | Not built | `/commish-contract-update` (proven caller since #1186; the write uses the commissioner credential); pricing and eligibility modules exist in the worker. A new client that computes contract fields must pass the contract change gate (`docs/CHANGE_PLAYBOOK.md` §0). Windows are closed until the March roll-forward, so a clock decision is needed. | W D A X | S3d |
| G5 | Restructure | Offseason only; 2+ years; set each year in $1K steps keeping the total; 20% first-year rule for back-loaded; loaded limit 5; 3 per season; taxi player promoted. | None. | Not built | `/offer-restructure`. Same gate and clock decision. Restructure preserves AAV and the FL/BL suffix (recorded rulings). | W D A X | S3d |
| G6 | Multi-year contract (MYAC) | 2 or 3 years at his salary; open until the contract deadline; auction 1-year contracts only. | None. | Not built | Same contract route family. Same gate. | W D A X | S3d |
| G7 | Mid-Year Multi (MYM) | 2 or 3 years; opens after MYAC; closes at the Week 3 kickoff; 4 per team. | None. | Not built | `/offer-mym`. Same gate. | W D A X | S3d |
| G8 | Tag, rookie option | Listed as "Not available" (deadline passed; "Desktop only"). | None. | Not built | Shown as the demo shows them; no flow. (Tag is a write flow in the classic app; it joins the matrix only if Keith adds it.) | X | S1 |
| G9 | Notify commissioner / report a bug | Sheet saying what is and is not sent; Send report; Report sent. Offered on failed-read states; the Controls sheet has a separate Feedback notes box. | None in the beta. The classic app has the integration (#1474, draft). | Not built | **Decision 4:** Report a bug replaces the Feedback tab and is reachable from every screen and from inside every sheet; it carries the current screen and the captured error. Worker `/bug-report` with a beta-tagged session and the same "not included" disclosure. **During integration testing reports go only to #keiths-test** (channel routing is a worker setting; unverified, to be confirmed and pinned by a test in S2). | A | S3e |
| G10 | Submit result | Demo: "Submitted. Simulated. Nothing was sent." | n/a | Not built | Replace with the four real states (confirmed, unconfirmed, mismatch, refused) and the evidence pack per flow. | W | S3 |

## H. Demo scaffolding (prototype controls)

The demo's Controls sheet exists so Keith can try states. These are not owner features. Treatment ruled in Decision 4 (section 5a): product settings stay; state toggles become the **Sample** mode (client only, no network) and the Test-mode controls; the Feedback tab is replaced by Report a bug.

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| H1 | Profile header look, Headshot states, Helmet badge states, Team colors preview | Selectors to compare looks and states. | None. | Exception | **Exception (Decision 4):** replaced by Sample mode (client only). |  | S1 |
| H2 | Navigation (A or B) | Selector. | Four tabs fixed. | Exception | **Exception (Decision 5):** no A/B setting ships; navigation is fixed at B (four tabs). |  | - |
| H3 | Bench position-group rule | All open / Only what needs you. | None. | Not built | **Kept as an owner setting (Decision 4)**; needs the "Needs you" logic (C22). | D | S1 |
| H4 | Scenario toggles | Sample week (problem or clean), Future-week save outcome, Season phase, Restructures used, Loaded contracts, Contract windows, Extension demo date, Acquisition and history records, Taxi eligibility records, Worker penalty answer, Profile eligibility, Screen state, Next demo save result, Reset. | None. | Exception | **Exception (Decision 4):** client-only **Sample** mode, plus the appropriate Test-mode controls (in Test the equivalents are real: a settable clock is decision 6, real records). Sample scenarios are clearly labeled and never send a transaction. |  | S1 |
| H5 | Skin, Standard/Vibrant | Selectors. | In About. | Built | None. |  | - |
| H6 | Try this checklist and Feedback notes (Copy all notes) | Tick list and a notes box that copies text for the chat. | None. | Exception | **Exception (Decision 4):** Feedback is replaced by Report a bug (G9). A short Try-this list may stay in Test mode. |  | S3e |
| H7 | Demo and Sample-data labels | On the bar and every sheet. | None. | Not built | Environment markers (A12). |  | S2 |

## I. Other placeholders the demo shows

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| I1 | Market tab | "Market. Later release." | Placeholder with its own wording. | Partial | Match wording only. The Market prototype is a later, separately scoped spec (Decision 2); it is not part of this work. |  | S1 |
| I2 | League tab | "League. Later page." | Placeholder. | Partial | Match wording. |  | S1 |

## 5. What the beta has that the demo does not

- A team picker (view any team's public roster, view-only). The demo is always "you".
- The "Match my phone" skin option, a request log and the display notes in About.
- The franchise name on the profile More tab (the demo's header has none).

## 5a. Explicit exceptions to parity with the demo (Keith's rulings)

| Exception | Demo | Beta | Rule that goes with it |
|---|---|---|---|
| Scenario toggles (Controls › Settings) | Sample week, future-week outcome, season phase, restructures used, loaded contracts, windows, demo date, record states, worker answer, screen state, next save result, Reset | Client-only **Sample** mode; real equivalents in Test mode | Clearly labeled; **never sends a transaction**; pinned by a test (A14) |
| Feedback and Try-this tabs | Notes box that copies text for the chat | **Report a bug**, reachable from every screen and inside every sheet; carries the current screen and the captured error | Integration testing: reports go **only to #keiths-test** |
| Compare navigation A and B sheet; A/B setting | Sheet comparing the two bars; a selector | Dropped; navigation fixed at four tabs | Decision 5 (B) |
| Kept as owner settings (not exceptions) | Skin, vibrant colors, position-group rule | Same, in settings | - |

## 6. Data the demo shows: what the repository and the current app already provide (audit, Decision 8)

A first-pass audit of the worker (`worker/src/index.js` and its modules), the shared browser modules (`site/shared/`) and the current phone app (`site/m/`), read from the code and **not exercised**. The beta reuses what exists and adds a route only where a gap is proven. Details and sources are in `IMPLEMENTATION_PROPOSAL.md`.

| Need | Found | Remaining gap |
|---|---|---|
| Action eligibility (Extend, Restructure, MYAC, MYM, Tag, taxi, IR, drop) | Client predicates `site/m/front_office_actions.js` (verbatim Front Office mirror), `site/shared/contract_windows.js`, `site/shared/taxi_rule.js` (twin of `worker/src/taxi_rule.js`); the pre-season ladder is resolved on the worker (`league_events_ladder.js`); the worker enforces windows at submit | No single server preview of "what can he do now". Reuse the shared pure modules first; add a read route only if a parity test shows divergence |
| Injury status and timing | `/api/player-status` (official report, roster designation, MFL designation) and the one resolver `site/shared/injury_status.js`; lineup-violation booking in `lineup_compliance.js` and `lineup_rulings.js` | Confirm the notice-deadline facts the demo's issue sheet shows are readable; the resolver forbids expected-return dates |
| Opponents, home/away, kickoff, spread | `/api/lineup-matchups` (this week's game per NFL team plus the next three weeks) and `/api/fantasy-sos` (the league's full schedule by week with byes and game state) | None identified |
| Allowed-to-position, usual, rank of 32 | `defRatings` in `/api/lineup-matchups` and `/api/fantasy-sos` (the Pts Agst engine, `worker/src/fpa_engine.js`) | None identified |
| Weekly scoring history, PPG, rank | `/api/player-weekly-box` (box score and snaps), MFL player scores through `site/m/season_scoring.js`, `site/shared/player_facts.js` | Per-week role (Started, Benched, On Team n, Free agent) is not identified as a stored fact; derive from MFL lineups or show no role (the demo shows none for partial history) |
| Start / Boom / Bust | `/api/player-starter-rates` (worker `starter_rates.js`, defined by Keith 2026-10-10 against the UPS starter pool) | The demo's thresholds are placeholders; the beta uses the worker's definitions and says so |
| Contract calendar and deadlines | `getAuctionCalendar` and `resolveContractDeadlineUtc` on the worker, `/api/league-events`, `league_events_ladder.js`, `site/shared/contract_windows.js` | Confirm the read carries every date the Deadlines list shows |
| Cut penalty, earned, guarantee | `/api/cap-penalty/preview` (already in the beta); `site/m/front_office_penalty.js` is an older client estimate and is not used | None |
| Cap space | `site/m/front_office_cap.js` and the Front Office number | Reconcile before showing (left out today on purpose) |
| Projections | Lineup projection fetch exists in the current app | **Unavailable state** until a suitable source is approved (Decision 8) |
| News and Bio | `/api/player-news` (Sleeper via MFL ids) and `/api/player-bundle` (MFL playerProfile) exist; the current sheet has News and Bio tabs | **Unavailable state** until a suitable source and its rights are approved (Decision 8) |
| IR expected return | MFL's injuries export carries an expected-return field; the repo's resolver deliberately shows none | **Never infer an exact return date** (Decision 8): nothing is shown |
| Team's confirmed-violation count (the §G3 ladder) | Lineup rulings tables on the worker | Confirm a readable count; unknown must read "we couldn't read it" |

## 7. Staged plan (proposal; nothing is approved)

Each stage is its own set of PRs. Each PR has one outcome, runs the safe suite, goes through Codex, and stops for Keith. No stage deploys, merges or enables anything without his explicit approval. This keeps the existing gates in the planning record (issue #1475): G3 per flow, G4 rollout, GL per live flow.

| Stage | Outcome | Writes | Exit evidence |
|---|---|---|---|
| **0** | Preview 0 (#1477): read-only roster, contract details, team-colored profile header. Deployed to the preview address. | none | Keith's phone review (in progress). |
| **S1** | Read-only parity: every section above marked S1, built in the Preview build (no write code). The Actions button, Actions sheet and every review sheet are drawn with **real** eligibility and effects; the Submit control is present but disabled with "Sign in to the Test beta to submit" in this build. New worker read routes (section 6) land first, each as its own PR. | none | Side-by-side screenshots at 320 and 375 px for each screen against S1; D1 `rows_read` measured; Keith's review per page. |
| **S2** | Test-league foundation per the planning record: sign-in handoff with an opaque server-side session, identity ("Signed in as"), the **environment guard**, the write ledger and read-back standard, beta flags, red TEST LEAGUE banner. | none yet | Authorization audit table with negative tests; guard proven; Keith approves the test environment (G2). |
| **S3a** | Lineup: start, swap, leave empty, save, week selector, future-week experiments. | test league only | Evidence pack (below); Keith's G3. |
| **S3b** | Roster moves: IR, Activate, Call up, Return to taxi. | test league only | Evidence pack; G3. |
| **S3c** | Drop (with the worker's penalty and the lineup effect). | test league only | Evidence pack; G3. |
| **S3d** | Contract actions: Extend, Restructure, MYAC, MYM. Needs the clock decision (windows are closed until March) and the contract change gate. | test league only | Evidence pack; G3. |
| **S3e** | Notify commissioner / report a bug. | test league only | Evidence pack; G3. |
| **S4+** | Review all results; the Beta button; invited beta; **live writes enabled one flow at a time, each on Keith's separate approval after the Test-vs-Live comparison.** | live, staged | GL per flow. |

**Write order (Decision 7, decided):** report a bug (S3e) first, routed only to #keiths-test during integration testing; then lineup (S3a), roster moves (S3b), drop (S3c) and contract actions (S3d). Each flow needs verified results before the next begins. The stage names keep their letters; the order of work is S3e, S3a, S3b, S3c, S3d. The demo's Controls scenarios are not a test plan; the evidence pack below is.

### Evidence pack for every flow (test league)

Before snapshot (MFL exports) · request (secrets redacted) · MFL response · after snapshot read **independently from MFL with caches bypassed** · diff against intent · D1 rows written (count, ids) · side effects checked (Discord, email, repo files) · cap before and after · **negative cases that each write nothing** (wrong team, expired session, window closed, over the cap, double submit, MFL outage, partial failure) · restore step · the Test-vs-Live comparison. Result states: `confirmed`, `unconfirmed` ("check MFL", never "done"), `mismatch` (stop and alert), `refused`. A dry run is never accepted as proof that a route has no side effects.

### The safety constraint that makes the test league safe

The worker holds one commissioner MFL session that works for **both** the live league (74598) and the test league (25625). A client cannot be trusted to name the league. The **environment guard** is therefore a worker-side check: a request tagged as a Test session is refused unless its league is 25625, and a Live session cannot name the test league; the Test build does not contain the production league id. The worker already silences Discord for any non-production league on contract writes (it states so in `worker/src/index.js`). This guard is proven by negative tests in S2, before any write flow is built.

## 8. Decisions needed from Keith, one at a time

1. ~~**Build targets.**~~ **Decided (A, 2026-11-20):** Preview draws the full Actions UI and review sheets with Submit disabled and no write code; real transactions only in the Test build (league 25625); each flow comes back to Keith for separate approval before it is enabled in the invited beta.
2. ~~**Spec scope.**~~ **Decided (demo-only, 2026-11-20):** S1 is the source of truth (Home lineup card, Team, profile, Actions, Contracts). Market, Trades, Auction, Draft, League, Cap & picks pages, Commissioner and Desktop are later, separately scoped specs; none is added to this implementation by implication.
3. ~~**Helmet placeholder.**~~ **Decided (2026-11-20):** add the demo's labeled dashed "Helmet TBD" circle as shown; no helmet art is drawn or invented. Supersedes the Preview 0 choice to leave it out.
4. ~~**Scaffolding.**~~ **Decided (2026-11-20):** Sample mode for scenario toggles (labeled, never sends transactions), Report a bug replaces Feedback (reachable everywhere, carries screen and error, #keiths-test only during integration testing), compare sheet dropped, skin / vibrant / position-group rule stay as owner settings. Recorded as explicit exceptions in section 5a.
5. ~~**Navigation.**~~ **Decided (B, 2026-11-20):** four tabs (Home, Team, Market, League); Fix lineup stays a one-tap shortcut into Team's lineup workspace; unsaved indicator inside the workspace and a prompt before navigating away with unsaved edits; Market and League are destinations only and do not widen the Decision 2 scope.
6. ~~**Test clock**~~ **Decided (A paired with B, 2026-11-20):** a request-scoped test clock honored only for authorized Test sessions on league 25625; production never honors it; it does not change the shared worker's global clock; plus B's closed-window refusal cases (a closed window writes nothing). The documentation states which restrictions our worker enforces and which MFL enforces, and does not claim the override bypasses MFL's own rules.
7. ~~**Write order**~~ **Decided (2026-11-20):** Report a bug first (routed only to #keiths-test during integration testing), then lineup, roster moves, drop, and contract actions. Each flow needs verified results before progressing.
8. ~~**Data sources**~~ **Decided (2026-11-20):** use existing league and NFL data sources first; audit the repository and the current app before building new routes or declaring data unavailable; establish a source for action eligibility, injury timing, opponents and kickoffs, weekly scoring history and the contract calendar; projections, news, bio and IR return dates use the demo's Unavailable state until a suitable source is approved; never infer an exact return date.

## 9. What this does not do

It builds nothing, deploys nothing, writes to no league, enables no flag and changes neither the approved prototypes nor `site/m/`. #1465, #1474, #1476 and #1478 are untouched.
