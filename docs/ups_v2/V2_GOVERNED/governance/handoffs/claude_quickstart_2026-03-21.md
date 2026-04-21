# Claude Quickstart

Last updated: `2026-03-21`

## Read this first
- `V1` is the live legacy system: [`/Users/keithcreelman/Documents/New project`](/Users/keithcreelman/Documents/New project)
- `UPS_V2` is the clean rebuild: [`/Users/keithcreelman/Documents/mfl/Codex/version2`](/Users/keithcreelman/Documents/mfl/Codex/version2)
- Do not treat V1-derived material as approved V2 design unless it is in [`V2_GOVERNED`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED)
- Start with the full takeover brief: [`claude_takeover_handoff_2026-03-21.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/handoffs/claude_takeover_handoff_2026-03-21.md)
- Use the league/player dossier for owner-facing rules and repo inventory: [`claude_player_league_profile_and_repo_inventory_2026-03-21.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/handoffs/claude_player_league_profile_and_repo_inventory_2026-03-21.md)

## Absolute roots
- V1 live repo: [`/Users/keithcreelman/Documents/New project`](/Users/keithcreelman/Documents/New project)
- V1 quarantined reference root: [`/Users/keithcreelman/Documents/mfl/Codex/V1`](/Users/keithcreelman/Documents/mfl/Codex/V1)
- UPS_V2 repo root: [`/Users/keithcreelman/Documents/mfl/Codex/version2`](/Users/keithcreelman/Documents/mfl/Codex/version2)
- UPS_V2 governed docs: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED)
- UPS_V2 runtime DBs:
  - [`/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_prod_mirror.sqlite`](/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_prod_mirror.sqlite)
  - [`/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_test_working.sqlite`](/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_test_working.sqlite)
  - [`/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_future_lab_2027.sqlite`](/Users/keithcreelman/Documents/mfl/Codex/version2/runtime/db/ups_v2_future_lab_2027.sqlite)

## What the league is
- League name: `UPS Salary Cap Dynasty`
- Prod league: `74598`
- Test league: `25625`
- Format: `12-team`, dynasty, salary-cap, IDP, punter-inclusive, contract-based
- Divisions: `4`, with `3` teams each
- MFL season metadata:
  - `startWeek=1`
  - `endWeek=17`
  - `lastRegularSeasonWeek=14`
  - `currentWaiverType=BBID_FCFS`
  - `auction_kind=email`
  - `usesSalaries=1`
  - `salaryCapAmount=300000.49`

## Most important player-facing rules already locked
- Active roster:
  - minimum `27`
  - maximum `35` during auction
  - maximum `30` after contract deadline
- Taxi:
  - max `10`
  - round `2+` rookie picks only
  - first `3` NFL seasons
  - at least `1` IDP
- Rookie contracts start at `3 years`
- First-round rookie option:
  - applies to `2025` class forward
  - first live exercise window inferred for `2027`
  - offensive option adds `5K`
  - defensive formula still provisional
- Add:
  - BBID and FCFS are one acquisition concept
  - add window starts at the first waiver run after auction completion
  - end boundary uses league metadata `endWeek`
- Drop:
  - allowed broadly from league-site start through league end
  - blocked once player game starts
  - blocked in the short pre-auction lock window
  - blocked while auction is active
- Trades:
  - open at new league year
  - deadline is Thanksgiving kickoff
  - open during offseason and auction
  - self-serve release 1 is two-team only
  - three-way trades remain commissioner-managed exceptions for now
- Trade salary:
  - only from outgoing active-roster or IR current-season salary
  - taxi excluded
  - max tradable amount is `50%`
- Auction nominations:
  - auction opens `12 PM ET`
  - day 1 requires `2` nominations before midnight
  - every day after midnight reset requires `2`
  - owners may stop only when nomination-complete

## Important mismatches and open items
- Live MFL reports `partialLineupAllowed=YES`, but the league expects valid lineups
- Defensive first-round rookie option formula is still open
- Exact kicked-off-player trade acceptance behavior is not yet source-validated
- Auction over-cap penalty and enforcement details are still open
- Exact missed-nomination escalation ladder is still open

Primary governed gap trackers:
- Rule ambiguity register: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/rule_ambiguity_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/rule_ambiguity_register.csv)
- Site-settings alignment register: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/site_settings_alignment_register.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/site_settings_alignment_register.csv)

## What to read next
1. Master plan: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/MASTER_PLAN_v7.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/MASTER_PLAN_v7.md)
2. Contract Actions workspace: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/contract_actions_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/contract_actions_workspace.md)
3. Roster Operations workspace: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/roster_operations_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/roster_operations_workspace.md)
4. Trade Negotiation workspace: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/trade_negotiation_workspace.md`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/workspaces/trade_negotiation_workspace.md)
5. Target requirements matrix: [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/target_requirements_matrix.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/requirements/target_requirements_matrix.csv)

## Agents
- `Archimedes` = `rules_watch`
- `Bacon` = `ux_review`
- `Darwin` = `data_governance`
- `Curie` = `ops_runtime`
- `Cicero` = `mfl_matrix`

Live assignment record:
- [`/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/agent_assignment_view.csv`](/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/governance/agent_assignment_view.csv)

## Repo inventory
### UPS-related local repos
- [`/Users/keithcreelman/Documents/New project`](/Users/keithcreelman/Documents/New project) -> branch `main` -> [upsmflproduction](https://github.com/keithcreelman/upsmflproduction)
- [`/Users/keithcreelman/Documents/mfl/Codex/version2`](/Users/keithcreelman/Documents/mfl/Codex/version2) -> branch `main` -> no remote configured in inspected checkout
- [`/Users/keithcreelman/Documents/mfl_app_codex`](/Users/keithcreelman/Documents/mfl_app_codex) -> branch `main` -> [ups-league-data](https://github.com/keithcreelman/ups-league-data)

### Non-UPS repos also found locally
- [`/Users/keithcreelman/Documents/FITFO/fitfo_condorcoolers`](/Users/keithcreelman/Documents/FITFO/fitfo_condorcoolers)
- [`/Users/keithcreelman/Documents/FITFO/project2_CONDOR`](/Users/keithcreelman/Documents/FITFO/project2_CONDOR)

## Immediate next actions
- Continue Phase 2 rule and workspace hardening
- Finish historical rules audit through `rules_watch`
- Keep every governed rule cross-checked against live MFL site settings when a source-system field exists
- Do not treat any V1-derived reference material as approved V2 design unless it has been promoted into `V2_GOVERNED`
