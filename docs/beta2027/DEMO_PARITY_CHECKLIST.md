# UPS 2027 Beta: demo parity checklist and staged plan

**Status: DRAFT for Keith's decision. Planning only.** Nothing here builds, deploys, enables a write or touches the original mobile app or the approved prototype. Companion record: issue #1475 (revision 11) and PR #1477 (Preview 0).

## 1. The ruling this answers

Keith (chat, 2026-11-20): the beta must match the approved demo **1:1 across the full experience**, with the demo as the product and interaction spec: every screen, section, badge, deadline, control and action it shows. Actions are not to be left out because Preview 0 was scoped read-only, and they must **work for real**, built and verified against the **test league first**, with **read-back confirmation from MFL for each transaction type**. Production and live-league writes stay **disabled** until the test-league flows pass **and** Keith separately approves enabling them in the invited beta. Do not deploy the expanded build or enable production writes without separate approval.

**Decision 1 (Keith, chat 2026-11-20): A, recorded.** The **Preview build shows the complete Actions UI and every review sheet, with Submit disabled and no write code in that build** (a test must pin that the Preview artifact contains no submit or write module and makes no non-GET request). **Real transactions live only in the Test build, against league 25625.** Each flow is tested and verified there first, then brought back to Keith for **separate approval before it is enabled in the invited beta.** This ruling does not start implementation and changes neither the approved demo nor the original mobile app.

## 2. What "the demo" is (pinned versions)

| Source | What it is | Version and hash | Role here |
|---|---|---|---|
| **S1** Player Profile Look | The full phone prototype: Home lineup card, Team (Roster, Contracts, Cap & picks), lineup editing, week selector, player profile with four tabs, actions and their reviews, Controls | artifact `7Vd91JB79xS2KiozmEFaYx`, version `1795048681-ef20`, 172,746 bytes, SHA-256 `018131724bec1c0569406c4b2d8aca0c415b5011e4f51093a34f66b76d51e157` | **The spec.** |
| S2 Team Roster Prototype | The earlier approved roster prototype; it has the same 61 actions as S1, without the team-colored header | artifact `9azAfVTtAEziLmQnJyhf3H`, version `1795027966-fbfa`, SHA-256 `d47af1872d0621aad9770dfe41a6922c07762561a3023f6d46b6ecf39b1bfdf0` | Superseded by S1 for this checklist. |
| S3 Market Prototype | Find players, bids, claims | artifact `GAXhn4TaNqx8jxyHB7h1wi`, version `1795052304-7291`, SHA-256 `de1225be104b0554c0b243fcb8e65c363f1aafd108f028f2e9d3583adf9ddc72` | **Not in this checklist.** Market is still in review per the Page Review; Keith decides whether it joins (D2 below). |
| S4 Page Review | The approval log: Team roster and Team › Contracts approved for the design concept 2026-11-17, Player profile 2026-11-18, Market in review, Home and Lineup/Trades/Auction/Draft/Commissioner/Desktop later | artifact `VJRJeTbwjfua4gb6wmfD9u`, version `1795092235-9a48` | Approval history. |

The approved prototypes are never edited. Comparisons use a local copy where only sample data is swapped for a real player.

## 3. How this was built, and how to read it

Every screen, sheet, state and control was listed from the demo's own code (S1: **61 distinct actions, 24 sheet types, 12 information topics, 5 navigation tabs in option A**), then compared with the beta as built (branch `claude/preview0-roster-profile` at `b9abb61`; the deployed preview is the earlier `dc1961a`). "Beta today" is what a reviewer can see in that build, measured in a real browser at 320 and 375 px where it concerns layout. Worker routes were found by reading `worker/src/index.js` and were **not exercised**.

**Status:** Built = matches the demo · Partial = exists but differs or is incomplete · Not built.

**Needs:** `W` a real write (test league first) · `D` a read source or worker route that does not exist yet, or whose contents are not confirmed · `A` the sign-in and identity work (Stage 2) · `X` a decision from Keith · `C` wording to verify against canon.

**Stage:** S1 read-only parity (public data, no write code) · S2 test-league foundation · S3a lineup · S3b roster moves · S3c drop · S3d contract actions · S3e report a bug.

## 4. Summary

| | Rows |
|---|---|
| Total checklist rows | **94** |
| Built | 9 |
| Partial | 22 |
| Not built | 63 |
| Need a real write (`W`) | 22 |
| Need new or unconfirmed read data (`D`) | 40 |
| Need a decision (`X`) | 21 |
| Need wording checked against canon (`C`) | 5 |

**In plain words:** the beta today is the read-only roster, the contract details and the team-colored profile header. Everything that edits (lineup, moves, drop, extension, restructure, MYAC, MYM) is not built, and several things the demo *shows* have no live data source yet (section 6).

## A. Shell, navigation, states

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| A1 | Bottom navigation | Five tabs (Home, Lineup, Team, Market, League) or four without Lineup; the choice is shown as open. Team tab shows a dot while a lineup change is unsaved. | Four provisional tabs (Home, Team, Market, League). No unsaved dot. | Partial | Unsaved-changes dot; the Lineup tab if Keith picks five. | X | S1 |
| A2 | "Compare navigation A and B" sheet | A sheet that compares the two bars and their tap counts. | None. | Not built | Prototype aid. Keep only in the Test/Sample controls, or drop (Keith decides). | X | S1 |
| A3 | Header and as-of line | Screen title, "✓ Fri 2:14 PM ET". | Title, ⓘ, "✓ Data as of … · Week 11". | Built | None. |  | - |
| A4 | Skins | Dark, Light, High contrast; Standard or Vibrant position colors. | Match my phone, Light, Dark, High contrast; Vibrant or Plain. All pass the contrast tests. | Built | None (the beta adds "Match my phone"). |  | - |
| A5 | Loading state | Skeleton rows and "Loading your roster…" / "Loading contracts…". | Skeleton rows on the roster; none for tabs that do not exist yet. | Partial | Skeletons for the Contracts tab and the profile tabs when they exist. |  | S1 |
| A6 | Failed read | "Couldn't read your roster. Try again." with Try again and Notify commissioner. | Failure card with Try again. No Notify commissioner. | Partial | Notify commissioner (see G9). | A | S3e |
| A7 | Offline state | "You're offline. Reconnect to load your roster." No Notify button while offline (nothing is saved to send later). | Same failure card as any failed read. | Partial | Detect offline; the offline wording. |  | S1 |
| A8 | Information (ⓘ) sheets | Twelve topics: demo, lineup card, contract numbers, performance, schedule, projections, restructure, extension pricing, Mid-Year Multi, extension window, drop review, actions. | ⓘ opens "About Preview 0" (display settings, request log). No topic sheets. | Not built | Twelve sheets. Reuse the demo wording after checking each against canon (`docs/league_context_v1.md`). | C | S1 |
| A9 | Toast with Undo | "<Player> moved" with Undo (moves) or OK. | None. | Not built | Toast; the Undo reverses only until confirmed on MFL. | W | S3b |
| A10 | Week banner on sheets | "Week 11 · current week" or "future week · proposal" at the top of lineup sheets. | None. | Not built | With the week selector (C2). |  | S3a |
| A11 | Sheet chrome | Grab bar, title, dimmed scrim, Close. | Same. | Built | None. |  | - |
| A12 | Environment marker | "Demo · Sample data" bar with a Controls button. | None on the preview address. | Partial | Per the planning record: "Preview: view only"; a permanent red "TEST LEAGUE: nothing here is real" on every screen and confirm in Test mode. | A | S2 |
| A13 | Choose any team (beta only) | Not in the demo (it is always "you"). | Team picker sheet; any team's public roster. | Built | Keep as view-only ("View as another team"); every write control stays disabled while the viewed team differs from the proven franchise. | A | S2 |

## B. Home

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| B1 | Home lineup card: needs fixing | "n lineup problem(s) to fix", the first three named, "On MFL 17 of 18 · locks Sun 1:00 PM · n unsaved", **Fix lineup**. | Placeholder: "Home is reviewed last". | Not built | The card and the issue count (needs injury timing, D3). | D | S1 |
| B2 | Home lineup card: ready | "✓ Lineup looks ready", "On MFL 18 of 18 · locks …". | Placeholder. | Not built | Same card. | D | S1 |
| B3 | Home lineup card: could not check | "Couldn't check your lineup. This is not an all-clear." Try again / Open Team. | Placeholder. | Not built | Same card; unknown is never an all-clear. |  | S1 |
| B4 | Rest of Home | "Rest of Home. Not in this prototype." | Placeholder. | Partial | Match the demo's placeholder wording (Home is reviewed last). |  | S1 |
| B5 | Fix lineup action | Opens Team on the Lineup view. | None. | Not built | Navigation. |  | S1 |

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
| C11 | Performance-view summary | "Projected lineup 126.4 · last week 118.2". | None. | Not built | Needs projections (rights unresolved) and weekly points. | D X | S1 |
| C12 | Starters block with slot tags | "Week 11 starters · 18 of 18"; each row tagged with its slot (QB1 … SF, K, P, DL1, DF). | Starters in MFL's order with a position badge; no slot tags; "The lineup as MFL has it" note. | Partial | Slot tags from the league's lineup settings; keep "unknown is never empty". | D | S1 |
| C13 | Starter row controls | Swap (starter), Locked (game started), Start (bench), "Bye week" (disabled), Fill (empty slot). | None (read-only rows). | Not built | Controls; lock rules from kickoff times. | D W | S3a |
| C14 | Empty slot row | "Empty" with a Fill button, highlighted. | None. | Not built | Row. | W | S3a |
| C15 | Row status chips | ▲ Bye week, ■ OUT, ▲ Doubtful, ■ IR tag. | ▲ Bye week only. | Partial | Injury chips (needs the injury read; MFL's injuries export keeps lapsed designations, so timing must be derived). | D | S1 |
| C16 | Row: opponent and kickoff | "DAL · vs NYG" on lineup rows; kickoff for locks. | NFL team only. | Partial | Opponent and kickoff from a schedule read. | D | S1 |
| C17 | Row: IR return date | "SFO · back Dec 3". | None. | Not built | A source for expected return is not known; show only what a source supports. | D X | S1 |
| C18 | Row: taxi call-ups | "DAL · 1/3 call-ups". | Shown on the profile More tab, not on the row. | Partial | Move to the row. |  | S1 |
| C19 | Row (Contracts view) | Type · through 2028 · cap note ("cap hit 50%" on IR, "taxi, $0 on cap"); salary; years left or "▲ Final year". | Type · through year; salary; years left or Final year. No IR or taxi cap notes. A missing salary reads "Not recorded". | Partial | IR and taxi cap notes. |  | S1 |
| C20 | Row (Performance view) | "Wk 10 18.2 · Avg 14.1 · vs NYG"; projection on the right. | None. | Not built | Weekly points and opponent; projection per rights. | D X | S1 |
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
| F2 | Helmet badge | A labeled dashed "Helmet TBD" circle on the photo (no helmet art exists). | Left out (earlier ruling: no helmet badge). | Not built | Keith's new ruling says every badge: add the same labeled placeholder, never a drawn helmet. Real helmet art stays unapproved. | X | S1 |
| F3 | Actions button | Full-width "Actions · n available" (or "can't confirm") under the header. | None. | Not built | Button; opens the Actions sheet (F13). | D | S1 |
| F4 | Tabs | Performance · Schedule · Contract · More. | Same four; Contract is built, the others are partial or placeholders. | Partial | Build the other three. |  | S1 |
| F5 | Performance: season chips | Season chips (2026, 2025 …, ⚠ for incomplete history). | None. | Not built | Needs the history source. | D | S1 |
| F6 | Performance: season tiles | Season Pts, PPG, PPG rank at the position. | "Season points so far" and "Last week —". | Partial | PPG and rank. | D | S1 |
| F7 | Performance: Start / Boom / Bust | Percent and "n of m weeks" per rate; counts only for kickers and punters; "Not enough weeks yet (needs 3)". | None. | Not built | Rates over the league's own weekly lineups (definitions in the ⓘ sheet). | D C | S1 |
| F8 | Performance: projection | "Projection · Concept": this week, rest of season, projected PPG, source "Pending review"; Out of date and Unavailable states. | "Not in Preview 0". | Not built | Show only with a licensed, current source; otherwise "Unavailable". | D X | S1 |
| F9 | Performance: game log | Per week: vs/@ opponent, points, grade chip (Boom, Starter-level, Below, Bust), role (Started, Benched, On Team n, Free agent), BYE rows. | None. | Not built | Weekly scoring and roles. | D | S1 |
| F10 | Schedule tab | "Allowed to <position>"; next 4 or all remaining games with opponent, kickoff, allowed vs usual, % vs usual, rank of 32, games n. | "Not in Preview 0". | Not built | Opponent-allowed-to-position source. | D | S1 |
| F11 | Contract tab: tiles and years | Salary, Years left, Earned to date, Remaining guarantee; Salary by year (3 years); option year; beyond 2028. | Built, with "Not recorded" and worker-flagged states. | Built | Copy touch-ups ("Through Week 10"). |  | - |
| F12 | Contract tab: Deadlines | Closed actions with their reasons or dates (Extend, Restructure, MYAC, MYM, Tag: "Deadline 5/21 · Passed", "Auction contracts only"), plus the note that MYAC/MYM come before Extension. | "Closed actions and their deadlines are not in Preview 0." | Not built | Deadlines from the season calendar and the player's acquisition record. | D | S1 |
| F13 | Contract tab: Rules and totals, If cut now | Type, Total value, Guaranteed; cut penalty and its basis. | Built (read-only, from the worker's answer). | Built | None. |  | - |
| F14 | More tab | Injury, Owner, taxi call-ups, News (source and date), Bio. | Roster spot, team, acquired, taxi details. | Partial | Injury; News and Bio need sources and rights that are unresolved. | D X | S1 |
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
| G9 | Notify commissioner / report a bug | Sheet saying what is and is not sent; Send report; Report sent. | None in the beta. The classic app has the integration (#1474, draft). | Not built | Worker `/bug-report` with a beta-tagged session; the same "not included" disclosure. | A | S3e |
| G10 | Submit result | Demo: "Submitted. Simulated. Nothing was sent." | n/a | Not built | Replace with the four real states (confirmed, unconfirmed, mismatch, refused) and the evidence pack per flow. | W | S3 |

## H. Demo scaffolding (prototype controls)

The demo's Controls sheet exists so Keith can try states. These are not owner features. Proposed treatment: product settings stay; state toggles become the **Sample** mode (client only, no network) and the Test-mode controls; the Feedback tab is replaced by Report a bug.

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| H1 | Profile header look, Headshot states, Helmet badge states, Team colors preview | Selectors to compare looks and states. | None. | Not built | Sample mode. | X | S1 |
| H2 | Navigation (A or B) and compare sheet | Selector. | Four tabs fixed. | Not built | Product setting only if Keith keeps both; otherwise decide A or B. | X | S1 |
| H3 | Bench position-group rule | All open / Only what needs you. | None. | Not built | A real owner setting (C22). | X | S1 |
| H4 | Scenario toggles | Sample week (problem or clean), Future-week save outcome, Season phase, Restructures used, Loaded contracts, Contract windows, Extension demo date, Acquisition and history records, Taxi eligibility records, Worker penalty answer, Profile eligibility, Screen state, Next demo save result, Reset. | None. | Not built | Sample mode on the phone. In Test mode the equivalents are real: a settable clock (decision), real records. | X | S1 |
| H5 | Skin, Standard/Vibrant | Selectors. | In About. | Built | None. |  | - |
| H6 | Try this checklist and Feedback notes (Copy all notes) | Tick list and a notes box that copies text for the chat. | None. | Not built | Replace with Report a bug (G9) plus a short Try-this list in Test mode. | X | S3e |
| H7 | Demo and Sample-data labels | On the bar and every sheet. | None. | Not built | Environment markers (A12). |  | S2 |

## I. Other placeholders the demo shows

| ID | Element | Demo does | Beta today | Status | What remains | Needs | Stage |
|---|---|---|---|---|---|---|---|
| I1 | Market tab | "Market. Later release." | Placeholder with its own wording. | Partial | Match wording. The Market prototype is a separate, still-in-review spec (not part of this checklist unless Keith adds it). | X | S1 |
| I2 | League tab | "League. Later page." | Placeholder. | Partial | Match wording. |  | S1 |

## 5. What the beta has that the demo does not

- A team picker (view any team's public roster, view-only). The demo is always "you".
- The "Match my phone" skin option, a request log and the display notes in About.
- The franchise name on the profile More tab (the demo's header has none).

## 6. What the demo shows that no live source provides today

These are the reason parity is more than screen work. Each needs a worker route, measured against the D1 free-plan budget (`docs/D1_QUERY_RULES.md`), before its screen can be real.

| Gap | Used by | Note |
|---|---|---|
| D1 Per-player action eligibility and reasons (one route) | F3, F12, F15, G1-G8 | The demo's own note: "a live eligibility source does not exist yet." Windows need the season calendar and each player's acquisition and prior-extension record. |
| D2 Injury status with the time it reached the report, and notice deadlines | B1, C7, C15, C32, F14 | MFL's injuries export keeps lapsed designations, so timing must be derived, and unknown must stay unknown. |
| D3 Opponent, home/away and kickoff per player per week | C12, C16, C27, F9, F10 | Needed for locks and for "vs NYG". |
| D4 Weekly scoring history and roles (Started, Benched, On Team n, Free agent), PPG rank | C20, F5-F9 | Candidates exist (`/api/player-weekly-box`, `/api/player-bundle`); contents unconfirmed. |
| D5 Opponent-allowed-to-position figures | F10 | No route identified. |
| D6 Projections | C11, F8 | The demo marks them Concept; rights, source and cost are unresolved. Without a source the demo's "Unavailable" state is the honest result. |
| D7 News and bio | F14 | Sources and rights unresolved. |
| D8 IR expected return date | C17 | No source identified. |
| D9 Cap space reconciled to the Front Office number | C1 | Left out on purpose today. |
| D10 Team's confirmed-violation count (the §G3 ladder) | C32 | Unknown must read "we couldn't read it", never zero. |
| D11 Season calendar for contract windows, restructures used, loaded-contract count, MYM count, call-ups used | G2-G7 | Several are in D1 or the worker today; each to be confirmed. |

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

Suggested write order (lowest blast radius first, Keith decides): lineup → roster moves → drop → contract actions → report. The demo's Controls scenarios are not a test plan; the evidence pack below is.

### Evidence pack for every flow (test league)

Before snapshot (MFL exports) · request (secrets redacted) · MFL response · after snapshot read **independently from MFL with caches bypassed** · diff against intent · D1 rows written (count, ids) · side effects checked (Discord, email, repo files) · cap before and after · **negative cases that each write nothing** (wrong team, expired session, window closed, over the cap, double submit, MFL outage, partial failure) · restore step · the Test-vs-Live comparison. Result states: `confirmed`, `unconfirmed` ("check MFL", never "done"), `mismatch` (stop and alert), `refused`. A dry run is never accepted as proof that a route has no side effects.

### The safety constraint that makes the test league safe

The worker holds one commissioner MFL session that works for **both** the live league (74598) and the test league (25625). A client cannot be trusted to name the league. The **environment guard** is therefore a worker-side check: a request tagged as a Test session is refused unless its league is 25625, and a Live session cannot name the test league; the Test build does not contain the production league id. The worker already silences Discord for any non-production league on contract writes (it states so in `worker/src/index.js`). This guard is proven by negative tests in S2, before any write flow is built.

## 8. Decisions needed from Keith, one at a time

1. ~~**Build targets.**~~ **Decided (A, 2026-11-20):** Preview draws the full Actions UI and review sheets with Submit disabled and no write code; real transactions only in the Test build (league 25625); each flow comes back to Keith for separate approval before it is enabled in the invited beta.
2. **Spec scope.** S1 only (Team, Home lineup card, profile, actions, Contracts), with Market, Trades, Auction, Draft, League, Cap & picks, Commissioner and Desktop as later specs; or add the Market prototype now. Recommended: S1 only.
3. **Helmet placeholder.** Add the labeled "Helmet TBD" circle as the demo shows (your 1:1 ruling), or keep it out (your Preview 0 ruling). Recommended: add the placeholder; no helmet art.
4. **Scaffolding.** Sample mode for the scenario toggles, Report a bug instead of Feedback, drop the navigation-compare sheet. Recommended.
5. **Navigation.** Four tabs or five (the demo leaves it open).
6. **Test clock** for windows that are closed until March (settable clock on the test environment only, recorded cases, or wait). Needed before S3d.
7. **Write order** for S3 (suggested above).
8. **Data sources** the demo shows that do not exist (section 6): projections, news, bio, IR return date. Show "Unavailable" (recommended) or source them.

## 9. What this does not do

It builds nothing, deploys nothing, writes to no league, enables no flag and changes neither the approved prototypes nor `site/m/`. #1465, #1474, #1476 and #1478 are untouched.
