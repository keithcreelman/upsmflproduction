# UPS Dynasty League Website User System Overview

## Document Scope

- Audience: UPS Dynasty League owners
- Purpose: structured source material for a future user guide, searchable knowledge base, and chatbot assistant
- Included modules:
  - Contract Command Center
  - Rosters / Front Office
  - Trades / Trade War Room
- Not covered in this document:
  - Reports module
  - full league rules documentation
  - dedicated Rules Engine documentation
  - dedicated Compliance Monitoring documentation
  - Game Day module

## 1. System Overview

### What the UPS Dynasty League Website Is

The UPS Dynasty League website is a custom league-management layer built on top of MyFantasyLeague (MFL). It keeps MFL as the base platform for league data and transactions, then adds tools that are specific to a salary-cap dynasty format with multi-year contracts.

### What Problems It Solves Compared to Default MFL

Default MFL pages handle standard roster and trade actions, but they do not provide a complete owner workflow for a contract league with salary-cap planning. The UPS site adds the missing layer that owners need to manage contracts, project cap impact, and evaluate roster moves without relying on spreadsheets or manual calculations.

Key gaps it addresses:

- Contract lifecycle management for extensions, restructures, tags, and other contract actions
- Salary-cap visibility across current roster decisions and future planning
- Trade building that includes players, picks, traded salary, and contract-aware review
- Roster views that show contract status, cap burden, bye-week impact, and scoring context in one place
- Inline compliance signals such as cap-space status and over-cap warnings

### Major Capabilities

#### League Management

- Centralized owner workflows for contracts, rosters, and trades
- Direct navigation from the league site into custom management tools
- Action-specific pages instead of generic MFL tables

#### Salary Cap Management

- Current cap totals and cap-space visibility
- Salary adjustment tracking
- Post-move cap review for roster and trade decisions
- Future-looking cap plan support through contract projections

#### Contract Automation

- Guided workflows for extensions, restructures, tags, and MYM actions
- Contract previews before submission
- Submitted-action tracking so owners can verify what has already been filed

#### Trade Management

- Trade builder for players, picks, and traded salary
- Trade review with salary reconciliation before sending an offer
- Support for responding to offered and received trades from the same workspace

#### Roster Visualization

- Contract-oriented roster view by team and position
- Cap plan summary view
- Bye-week heatmap
- Scoring history views for player evaluation

#### Compliance Monitoring

- Current modules surface compliance-related information such as cap status and over-cap warnings
- Compliance is currently embedded inside owner workflows rather than documented as a standalone module
- A dedicated compliance documentation phase will come later

## 2. Core Modules

### Module: Contract Command Center

#### Purpose

The Contract Command Center is the main workspace for contract actions. It helps owners find eligible players, review contract outcomes, and submit contract-related changes through a guided process instead of handling those decisions manually.

#### Key Features

- Action-first workflow for contract changes
- Contract extension submission
- Contract restructure submission
- MYM submission
- Tag tracking and tag submission
- Team, position, and search filters for faster player lookup
- Contract preview and cost-calculation views
- Finalized submission review
- Summary indicators for eligibility, deadlines, and usage

#### User Workflows

##### User Flow: Submit Contract Extension

1. Open Contract Command Center from the league navigation.
2. Select the `Extend Player` action.
3. Filter by team, position, or player name if needed.
4. Choose an eligible player from the action list.
5. Select the available extension term.
6. Review the proposed contract values and updated contract summary.
7. Submit the extension.
8. Confirm the player appears in the submitted or finalized view.

##### User Flow: Restructure a Contract

1. Open Contract Command Center.
2. Select the `Restructure` action.
3. Choose an eligible player.
4. Enter the new contract structure values.
5. Review the recalculated contract distribution.
6. Submit the restructure.
7. Re-open the submissions area to confirm the request is recorded.

##### User Flow: Submit an MYM Contract

1. Open Contract Command Center.
2. Select the `MYM` action.
3. Choose an eligible player.
4. Select the available MYM term.
5. Review the contract length, TCV, AAV, and guarantee summary.
6. Submit the MYM action.
7. Verify the submission in the finalized area.

##### User Flow: Tag a Player

1. Open Contract Command Center.
2. Select the `Tag Player` action.
3. Review eligible players and tag cost details.
4. Select the player to tag.
5. Confirm the projected tag salary.
6. Submit the tag.
7. Return to the summary or submissions view to confirm status.

#### Data Used

- `mym_dashboard.json`
- `mym_submissions.json`
- `restructure_submissions.json`
- `tag_tracking.json`
- `tag_submissions.json`
- `player_points_history.json`
- league roster and franchise context from MFL
- contract and salary-cap calculation logic used for previews and eligibility

#### UI Components

- Action selector
- Team filter
- Position filter
- Player search field
- Eligible-player table
- Contract preview panel
- Cost-calculation view
- Summary cards
- Submission table
- Action modals for extensions, restructures, MYM, and tags

### Module: Rosters / Front Office

#### Purpose

The Rosters module, labeled `Front Office` in the interface, is the owner dashboard for roster review and cap planning. It combines contract data, player status, scoring context, and salary-cap impact into one place so owners can understand the current state of their team before making moves.

#### Key Features

- Contract View for current roster contracts
- Cap Plan view for current and projected cap structure
- Cap adjustments merged from a canonical salary-adjustments ledger plus manual MFL adjustments
- Bye Chart for bye-week concentration
- Scoring view for weekly and season performance context
- Team-level cap and roster summary
- Player action modal with shortcuts into contract and trade workflows
- Search, position, contract, and roster-status filters
- Compliance labels that show whether a team is currently over the cap

#### User Workflows

##### User Flow: Review Team Contracts

1. Open `Front Office` from the league navigation.
2. Select your franchise.
3. Stay on `Contract View`.
4. Filter by position, contract type, or roster status if needed.
5. Review each player's salary, AAV, years left, TCV, and cap penalty information.
6. Open a player card or modal for deeper actions if needed.

##### User Flow: Review Salary Cap Position

1. Open `Front Office`.
2. Switch to `Cap Plan`.
3. Review team totals, cap adjustments, cap space, and roster mix.
4. Compare current salary load against available cap room.
5. Use extension preview options when available to see how a future contract decision could change the cap plan.

##### User Flow: Start an Action from a Player Card

1. Open `Front Office`.
2. Search for a player or locate the player in the roster list.
3. Open the player modal.
4. Choose the next action:
   - trade the player
   - open a contract extension path
   - open a restructure path
   - promote from taxi
   - activate from IR
   - drop the player
5. Complete the action in the linked module or confirm the roster action.

##### User Flow: Review Bye-Week and Scoring Context

1. Open `Front Office`.
2. Switch to `Bye Chart` to review bye-week concentration by roster group.
3. Switch to `Scoring` to review weekly or yearly performance history.
4. Expand player details if you need more context before making a contract or trade decision.

#### Data Used

- MFL `league` export
- MFL `rosters` export
- MFL `salaries` export
- `salary_adjustments_<season>.json` report artifact for trade and cut cap adjustments
- MFL `salaryAdjustments` export for posted/manual `other` adjustments
- MFL `playerScores` export
- MFL `nflByeWeeks` export
- `player_points_history.json`
- prior-season salary history
- `extension_previews_<season>.json`
- roster workbench summary payload used for team cap and compliance status

#### UI Components

- Team selector
- View switcher: Contract View, Cap Plan, Bye Chart, Scoring
- Search field
- Position filter
- Contract filter
- Roster-status filter
- Player tables grouped by position
- Team cap summary panels
- Player modal with action buttons
- Bye-week heatmap
- Scoring detail panels

### Module: Trades / Trade War Room

#### Purpose

The Trades module, labeled `Trade War Room`, is a contract-aware trade builder. It lets owners build, review, send, and respond to trades while accounting for players, picks, traded salary, and pre-trade extension options.

#### Key Features

- Two-team trade builder
- Player and draft-pick selection
- Traded-salary input and validation
- Pre-trade extension options for eligible players
- Offer review before submission
- Salary reconciliation panel showing post-trade impact
- Separate views for offered trades and received trades
- Actions for accept, decline, counter, and revoke
- Optional owner message
- Integration payload preview for league processing

#### User Workflows

##### User Flow: Build and Send a Trade Offer

1. Open `Trades` from the league navigation.
2. Select your team and a trade partner.
3. Add players and picks to each side of the trade.
4. Enter traded salary if needed.
5. Add pre-trade extensions for eligible players if needed.
6. Review the salary reconciliation and trade summary panels.
7. Add an optional message to the other owner.
8. Submit the offer.

##### User Flow: Review an Incoming Trade

1. Open `Trades`.
2. Open the `Trades Received` list.
3. Load the trade into the workbench.
4. Review outgoing assets, incoming assets, traded salary, and contract effects.
5. Choose one response:
   - accept
   - decline
   - counter
6. If countering, adjust the assets and submit the revised offer.

##### User Flow: Revoke an Outgoing Trade

1. Open `Trades`.
2. Open the `Trades Offered` list.
3. Select the pending trade.
4. Review the current offer.
5. Revoke the trade if it is no longer valid.

#### Data Used

- MFL `league` export
- MFL `rosters` export
- MFL `assets` export for draft picks
- MFL `myfranchise` context
- `extension_previews_<season>.json`
- trade offer and outbox records for the current season
- salary reconciliation calculations used for post-trade cap review

#### UI Components

- Your Team selector
- Partner Team selector
- Asset boards for each side of the trade
- Players and Picks toggles
- Search field
- Trades Offered dropdown
- Trades Received dropdown
- Traded-salary input fields
- Pre-trade extension controls
- Offer Review panel
- Salary Reconciliation panel
- Trade Summary panel
- Message field
- Submission and response controls

## 3. Major Enhancements to the MFL Website

### Custom Contract Management

What was added:

- A dedicated contract workspace for extensions, restructures, tags, and MYM actions

Why it exists:

- Default MFL does not provide a strong owner workflow for multi-year contract management in a salary-cap dynasty league

### Salary Cap Visualization

What was added:

- Team cap summaries, cap-plan views, contract totals, salary adjustments, and post-move cap review

Why it exists:

- Owners need to see both the current cap picture and the effect of future decisions without calculating totals by hand

### Trade Automation Tools

What was added:

- A trade builder that supports players, picks, traded salary, extension-aware review, and response actions in one page

Why it exists:

- Contract leagues require more trade context than a basic asset swap, especially when cap space and contract status matter

### Enhanced Roster Interface

What was added:

- Front Office views for contracts, cap planning, bye weeks, scoring history, and player-level action shortcuts

Why it exists:

- Owners need a roster page that supports decision-making, not just a static list of players

### Automated Submission and Validation Support

What was added:

- Eligibility filtering, contract previews, submission tracking, trade readiness checks, and salary-limit validation

Why it exists:

- Owners need fewer manual checks and clearer confirmation before they submit a league action

### Embedded Compliance Signals

What was added:

- Current cap-status labels and over-cap warnings inside roster and trade workflows

Why it exists:

- Owners should see compliance risk while making decisions instead of discovering problems later

## 4. Navigation Map

```text
Home
├── Contract Command Center
│   ├── Select Action
│   │   ├── Tag Player
│   │   ├── Extend Player
│   │   ├── Restructure
│   │   └── MYM
│   ├── Eligible Players
│   ├── Cost Preview
│   ├── Summary
│   └── Finalized Submissions
├── Front Office
│   ├── Contract View
│   ├── Cap Plan
│   ├── Bye Chart
│   └── Scoring
└── Trade War Room
    ├── New Offer Builder
    ├── Trades Offered
    ├── Trades Received
    ├── Salary Reconciliation
    └── Offer Review
```

## 5. Common User Tasks

### Task: Submit a Contract Extension

1. Open `Contract Command Center`.
2. Choose `Extend Player`.
3. Locate an eligible player by search or filters.
4. Select the available extension term.
5. Review the proposed contract summary.
6. Submit the extension.
7. Confirm it appears in the submission list.

### Task: Restructure a Player Contract

1. Open `Contract Command Center`.
2. Choose `Restructure`.
3. Select the player.
4. Enter the new contract distribution.
5. Review the contract preview.
6. Submit the restructure.
7. Confirm the change is listed as submitted.

### Task: Review Roster Salary Cap

1. Open `Front Office`.
2. Select your team.
3. Open `Cap Plan`.
4. Review current salary totals, cap adjustments, and cap space.
5. Treat trade and cut adjustments as report-backed ledger rows and any remaining `other` adjustments as live MFL manual entries.
6. Check whether the team is shown as compliant or over the cap.
7. Use the contract and roster filters if you need to isolate problem areas.

### Task: Evaluate a Player Before a Move

1. Open `Front Office`.
2. Search for the player.
3. Review contract details in `Contract View`.
4. Check scoring trends in `Scoring`.
5. Check bye-week concentration in `Bye Chart` if roster balance matters.
6. Open the player modal to launch a trade, extension, or restructure workflow.

### Task: Build a Trade Proposal

1. Open `Trade War Room`.
2. Select your team and the partner team.
3. Add players and picks to both sides.
4. Add traded salary if needed.
5. Add any available pre-trade extensions.
6. Review the salary reconciliation panel.
7. Add an optional message.
8. Submit the trade offer.

### Task: Respond to an Incoming Trade

1. Open `Trade War Room`.
2. Open `Trades Received`.
3. Load the offer into the workbench.
4. Review assets, salary movement, and contract effects.
5. Choose to accept, decline, or counter.
6. If countering, edit the package and send the revised offer.

### Task: Verify Post-Move Cap Impact

1. Review the cap impact in `Trade War Room` before submitting a deal.
2. After the move, open `Front Office`.
3. Return to `Cap Plan`.
4. Confirm the updated salary totals and cap-space result.
5. Check whether the team still shows as compliant.

## 6. System Terminology

- **AAV (Average Annual Value):** The average yearly salary value of a contract.
- **Back-Loaded Contract:** A contract structure with more salary pushed into later years.
- **Cap Adjustment:** A non-player cap credit or charge applied to a team's cap ledger.
- **Canonical Salary-Adjustment Ledger:** The Salary Adjustments report output that owns trade and cut cap adjustments for Front Office totals and MFL import review.
- **Compliance Status:** The current cap result shown in the interface, such as compliant or over the cap.
- **Contract Year / Years Remaining:** The current point in a contract and how many seasons are left on it.
- **Extension:** A contract action that adds term and recalculates the player's contract values.
- **Front-Loaded Contract:** A contract structure with more salary placed in the early years.
- **IR (Injured Reserve):** A roster status shown separately from the active roster and reflected differently in cap views.
- **Loaded Contract:** A contract that is intentionally weighted toward earlier or later years instead of being flat.
- **MYM (Mid-Year Multi):** A mid-season multi-year contract action handled in the Contract Command Center.
- **Pre-Trade Extension:** An extension selected during trade building that is applied as part of the trade package review.
- **Restructure:** A contract action that redistributes salary within a contract to create a different cap shape.
- **Tag:** A one-season contract designation submitted through the Contract Command Center.
- **Taxi Squad:** A roster status used for developmental players; taxi players are tracked separately from the active roster in cap planning.
- **TCV (Total Contract Value):** The full dollar amount of a contract across all years.
- **Trade Salary:** Salary moved as part of a trade to help balance cap impact between teams.

## 7. AI Knowledge Base Structure

### Recommended Use Cases

- Chatbot assistant for owner questions
- Searchable help documentation
- Contextual help panels inside the UI

### Recommended Documentation Chunks

- One chunk for the overall system overview
- One chunk per module
- One chunk per common task
- One chunk for system terminology
- One chunk for navigation and page mapping
- One chunk for validation and warning behavior

### Recommended Metadata for Each Chunk

- `module`
- `page_name`
- `task`
- `action_type`
- `user_goal`
- `required_inputs`
- `result`
- `warnings`
- `related_terms`
- `related_pages`

### Suggested Chatbot Response Pattern

1. Identify the module the owner needs.
2. Name the page or view the owner should open.
3. Give the step-by-step workflow.
4. Mention any important cap or contract warning.
5. Link to related terminology when the answer uses league-specific language.

### Example Owner Queries

- How do I extend a player?
- How do I restructure a contract?
- What is a Mid-Year Multi?
- Where do I check my cap space?
- How do I see whether I am over the cap?
- How do I include traded salary in an offer?
- How do pre-trade extensions work?
- How do I review an incoming trade?
- Where do I see bye-week concentration on my roster?
- What does TCV mean?

### Implementation Notes for a Future AI Assistant

- Use owner language, not developer language.
- Start answers with the module and page name when possible.
- Prefer workflow answers over abstract explanations.
- Distinguish current live workflows from future features not yet documented.
- Treat glossary terms as reusable support content for contract and cap questions.

## 8. Future Work

The following areas should be documented in later phases but are intentionally not detailed here:

- Rules Engine
- Reports & Analytics
- dedicated Compliance Monitoring
- Game Day module
