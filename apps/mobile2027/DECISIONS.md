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
- **Salary structure for a plain one-year extension with uneven salaries** (e.g. $1K then $11K) reads "Flat", per the §C2 ruling of 2026-09-29. Flagged for Keith in case owners read it as wrong; not changed.

## Team › Performance and Breakdown
- **Shared settled-week cutoff W\*** applies to every season figure and rank (R7, in force).
- **The scored-game PPG denominator** is the approved one (in force, settled).
- **Weekly Fantasy ranks** are exact only (R7, in force).
- **Search players (R8, in force).** It filters the selected team by name, works with the position filters, and has no league-wide scope.
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
  - **INT rate** = INT ÷ attempts × 100 is ranked, lower is better, with a pass-attempt minimum (**Proposed**). Below the minimum the rate shows and the rank is "—". With 0 attempts the rate is "—".
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
