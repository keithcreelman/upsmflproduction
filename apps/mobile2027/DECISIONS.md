# UPS 2027 beta: current design decisions (read before changing a screen)

This is the working ledger of Keith's rulings for the 2027 mobile beta (`apps/mobile2027`). Each entry states the rule now in force and what it **supersedes**, so older wording, mockups or review notes are not reintroduced. The full message history is on issue #1493 and PR #1514. When a new ruling conflicts with an entry, add the new rule and move the old one under "Superseded". Never delete history.

Status words: **In force** (built or to be built as stated), **Proposed** (a number or threshold awaiting Keith's approval), **Not authorized** (do not build or release).

## Release boundaries (in force)
- Preview only: an isolated, recorded-data test preview on its own Cloudflare Pages alias. It makes no live data requests and has no fallback.
- One Known issues list.
- No merge, production deployment, Worker release, migration, data cleanup or xFP activation without Keith's explicit go for that action.
- xFP PPG and Over Expectations read **Not Available** on real-data previews until activation is approved.

## Navigation and shell
- **Compact scrolling header (R8, in force).** Navigation tabs stay accessible. The team heading and freshness line scroll away. The preview marker reads **Test · Recorded data** with Known issues reachable from it. Recording timestamps live in the preview information, not in the banner. *Supersedes:* the full-width "TEST BUILD · RECORDED DATA · recorded … · VIEW ONLY" banner (R7b).
- Position colors and OFX/SFX/DFX labels (in force, settled).

## Team › Roster
- **Byes (R8, in force).** The Byes section starts collapsed. A verified individual BYE row has no expandable game-detail panel. Use a concise "Week N lineup" heading where context is needed. *Supersedes:* the paragraph "Slots are today's lineup (Week 11). The lineup for a later week is not set, so these players may not fill the same slots then."
- **Bye coverage (R9, in force).**
  - Bye players are grouped by their own position, not their lineup or flex slot.
  - Each week shows whether the full legal starting lineup can be filled: an exact assignment, mandatory slots then OFX/SFX/DFX by eligibility, never one player in two slots. Slots come from roster.js SLOTS (canon §B4).
  - A shortage is shown only when no assignment fills every slot.
  - Questionable, Doubtful and Holdout never reduce coverage. Confirmed absences (bye; this week only, Out or an MFL designation) are listed apart.
  - *Supersedes:* the R8 bye groups labeled by today's slots ("RB2, TE1").
- **Taxi options and Possible IR returns (R9, in force).**
  - Both are kept separate from confirmed coverage and start collapsed.
  - Taxi: every position-eligible taxi player, whatever his points, with call-up eligibility from the Worker's taxi rule, call-ups left (or "Not recorded"), and his last three weeks of points.
  - Team-wide obstacles (e.g. a full active roster) sit above the list; player-specific obstacles sit beside the player.
  - An IR player is a "possible return" only with supporting evidence (this week's NFL report lists him as practicing and not Out); IR eligibility alone is not enough.
  - No activation, call-up or lineup controls. Cap room is not checked.
- **IR badge (R9, in force).** The same red badge with a small medical icon everywhere, keeping the "IR" text.

## Team › Contracts and player Contract tab
- **One primary amount: If cut now (R8, in force).** It is calculated under the applicable rule: guarantee-based charge, no-guarantee rule, or the $1K-drop rule. The rule comes from the existing Worker cut-charge answer, never a new formula. *Supersedes:* the separate Remaining guarantee column and paragraph, and the arithmetic shown under If cut now.
- **Details (R8, in force).** Show the original guarantee and earned-through-week amount only where applicable. Contract dates and years remaining appear on one line. The full salary schedule and the extending-team attribution are kept.
- **Contract labels (R8, in force).**
  - **Contract Type:** Veteran / Rookie.
  - **Contract Source:** a readable acquisition source, e.g. Rookie Draft, FA Auction, Expired Rookie Auction, Waiver Wire (including FCFS).
  - Extensions and tags are identified separately; the original acquisition is preserved.
  - **Salary structure:** Flat / Front-loaded / Back-loaded.
  - Missing metadata reads "Not recorded".
  - *Supersedes:* internal codes such as "Vet-FAA-FL", and any "Contract Loaded: Yes/No".
- **Extension schedule and attribution (R7, in force).** The schedule follows the current contract from the extension's first season. "Extended by [team] · [year]" comes from the contract's own Ext record, never the current owner. Nine contracts have no supported year: they show the team without a year, and the dates are backlogged on #1503.
- **Traded salary (R8, in force).** Each entry shows the verified opposing UPS team, the full trade date and the signed amount, linked from transaction evidence. Multi-team trades show only supported counterparties. An adjustment that can't be linked shows its amount with "Trade details not recorded", and is reported on #1503. In the 2026-11-22 recording all 17 are unlinked, because no trade transactions were recorded; the settlement text is not used.
- **Salary structure for a plain one-year extension with uneven salaries** (e.g. $1K then $11K) reads "Flat", per the §C2 ruling of 2026-09-29. R9 adds the line "Rule classification; the yearly salaries differ." to the 16 affected contracts (option A, proposed). Options B and C await Keith's choice.
- **Contracts sorting and layout (R9, in force).**
  - The sorts are Contract exp. | Salary | Position | Name, with Contract exp. as the default.
  - Position draws grouped sections in league order.
  - Name sorts by surname, then given name, using MFL's "Last, First" field; suffixes are ignored for ordering and multi-word surnames stay whole.
  - "If cut now" and the salary-year headings sit inside the list container, aligned with the amounts.
  - Expanded details get a light inset band, not a nested box.
  - A Salary structure filter (All / Flat / Front-loaded / Back-loaded) is keyed on the league's rule classification, separate from Contract Type.
- **AAV (R9, in force).** Recorded AAV is shown by year. AAV amounts roll forward (Keith 2026-07-22, canon §C4): the current year keeps the old AAV and the added years get the new one. AAV is never total value ÷ years. A mapping the rules don't settle reads "Recorded: … · years not mapped".
- **Contract source and history (R9, in force).**
  - An extension that begins the current contract reads "Contract source: Extension". The prior acquisition shows separately as "Acquired".
  - **Contract history** is collapsed and sits below the schedule and facts. It lists acquisition, the teams in the extension record, restructures and tags, by season only. Derived seasons say so, and incomplete history is marked once.
  - Trades and restructures never add an extending team. Extension eligibility is not shown (no shared eligibility logic in the app).
  - *Supersedes:* the R8 "Later changes: Extended 1 year" line.
- **Restructure-derived extension years (R9, in force).** For the 10 contracts whose extension year is worked out from restructured terms, the app shows "Extended · year · extending team not verified". It never asserts the last name in the extension record as the extender of the contract in force: original records show that name is wrong for London, Cook, Love and Hurts (#1503 D6). *Supersedes, for these 10:* the R7 "Extended by [last Ext team] · [year]".

## Team › Performance and Breakdown
- **Shared settled-week cutoff W\*** applies to every season figure and rank (R7, in force).
- **The scored-game PPG denominator** is the approved one (in force, settled).
- **Weekly Fantasy ranks** are exact only (R7, in force).
- **Search players (R8 + R9 + R10, in force).**
  - It filters the selected team by name and works with the position filters and sort.
  - When nothing on the team matches, a "Search other teams" action searches the other league teams' rostered players only, from the roster read already in memory: no free agents and no new read. Each result shows its UPS team.
  - R10 (Keith: "Cross-team search must allow all relevant positions"): the other-teams list has its own position chips, All plus every position among the matching players, not limited to the selected team's positions. It starts at the selected team's filter. If none of the matches has that position, every position is shown and one line says so, so the list is never silently empty.
  - Opening a result uses the existing player profile. Returning restores the team, query, position filter, other-teams position, sort and scroll offset.
  - *Supersedes (R10):* the selected team's position filter also narrowing the other-teams list (R9).
- **Position filters (R9 + R10, in force).**
  - R10 (Keith: "Show All plus positions represented on the selected team"): All plus only the positions on the selected team's roster (IR and Taxi included), in league order, with K and P labels. They work with search and sort. "By position" stays a sort.
  - Team switch: the filter stays if the new team has that position. Otherwise it resets to All and one line says so ("No K on …, so Position is back to All."); the next filter, sort or search action clears the line. Search, sort and other-teams state are kept.
  - In the recorded data every team has all nine positions, so the reset path is covered by unit tests, not by the recorded preview.
  - *Supersedes (R10):* all ten chips always (R9) and the open question on which chips to show.
- **Breakdown behavior (R9, in force).**
  - Opened content scrolls into view without hiding the player's card under the sticky tabs.
  - A game detail collapses when the log view changes.
  - Game details carry no duplicate fields (attempts appear only in completions/attempts), and sacks taken and sack yards lost are separate.
  - K and P are used in every badge, heading and rank.
- **Breakdown tabs (R8, in force).** **Season stats | Game log**, defaulting to Season stats; switching replaces the content. The Game log keeps Fantasy / Stats / Usage / Red zone and the position-specific alternatives. The Breakdown does not repeat the card's total points, total-points rank or projection, and drops instructional copy ("Tap a game for details", "Not recorded, never zero"). *Supersedes:* the stacked season-stats-plus-log expansion (R6/R7).
- **Season stat ranks (R7b final + R7c, in force).**
  - Exact, ties shared, or "—" when any incomplete figure could change the place. No range is displayed for any stat.
  - Rank details give the bounds and the cause: missing figure, partial figure, or unknown eligibility.
  - Kicking distance bands show made/attempted and rank on **attempts**.
  - WR/TE carries, yards and TD rank on totals; only yards per carry has an opportunity minimum.
  - There is no minimum-qualifier count.
  - Metric-specific minimums only where justified, all **Proposed**.
  - *Supersedes:* "WR 1 of 240" wording; four-place range display for totals (R7b) and for rates (retired R7c); band accuracy ranks and their minimums; the five-qualifier rule.
- **QB stats (R8, in force).**
  - Completions and Attempts are separate rows with their own ranks.
  - Completion % is a rate with an attempt minimum.
  - INT shows the count only, with no rank.
  - **INT rate** = INT ÷ attempts × 100 is ranked, lower is better, with a pass-attempt minimum. Below the minimum the rate shows and the rank is "—". With 0 attempts the rate is "—".
  - R9 (in force): it shows two decimals; ranks use the unrounded rate, and identical rates share a rank.
  - R10 (Keith: "Retain the 15-attempts-per-team-game INT-rate minimum. Replace the league-minimum-games denominator with each player's supported historical NFL team games through the shared cutoff only after verification and an impact comparison. Below-minimum players retain their count and rate, without a rank."):
    - The 15-per-team-game minimum is retained.
    - The app uses each QB's own club games (15 × the games his NFL club(s) played through W\* while he was on them) only when the position answer carries a supported `team_games` for **every** QB in the pool. Otherwise every QB keeps the fewest-games bar (15 × 9 = 135 at Week 10). Rank details name the bar used.
    - Today the answer has no per-player club games: the recorded answer has none, and nothing in the app can derive them. **The fewest-games bar is what shows.**
    - Week 10 impact comparison on public nflverse data: the same 31 qualifiers and identical ranks under both bars. The QBs near the bar all play for 9-game clubs (S/r7notes/r10c.md).
    - The Worker field is a proposal on #1515's branch and is **not built**: `team_games`, from box-row clubs plus a club source for weeks without a row.
    - Below the minimum, the count and rate still show and the rank is "—" (tested under both bars).
  - *Supersedes (R10):* the open question on "per team game" meaning.
  - *Supersedes:* the combined Completions/attempts row and the ranked INT count.
- **Fumbles lost (R8, in force).** Not displayed in season stats or game displays. This is a display decision; official MFL points still include fumbles. *Supersedes:* the "excluding sack fumbles" rows and caveats.
- **Individual game (R8, in force).** The identity line is **Date · Matchup · Status**. A completed game omits kickoff time; an upcoming or live game keeps it. Season and week are not repeated where already visible.
- **Opponent matchup column (R8, in force).** In the Fantasy log, replaces the NFL result. It shows the opponent's UPS fantasy points allowed per game to this position, from completed games before the matchup only; rank 1 = fewest allowed; compact label "Opp vs QB: 24th". Points, sample size, cutoff and definition go in Details. IDP has its own validated definition (the opponent's offense allowing IDP production, not a defensive rank). The column appears only when a supported source is loaded. Until then the Fantasy log keeps its Result column and the dependency is reported on #1503: each scorer's game-day club per week, from the Worker's points-against engine. Never fabricated. Open for Keith: whether the opposite rank direction from Lineup's points-against rank (1 = most allowed) is acceptable, and whether to show the rank as context only, with no coloring.
- **Projection (R7 + R8, in force).** The card shows only "Week N Proj. X.X". Pre-kickoff validation, freeze at kickoff and timestamps are kept internally; the provider is in Help. *Supersedes:* the visible "captured before kickoff / frozen at kickoff" copy and the Breakdown's duplicate projection.
- **Recent/Earlier** stays out (R7, follow-up).

## Data defects (tracked on #1503, owner: Infrastructure session)
- Blank PFR box rows (D1): 812 rows across 2024–2026, plus 153 ext rows. Writer fix is draft #1518; cleanup is prepared, not requested.
- Red-zone load record (D2): verified for 2026 W1–10; the durable load record is a design on #1500.
- Snap identity gap for two DL (D3).
- The Worker interpretation is draft #1515. Re-recording only helps from corrected responses.
