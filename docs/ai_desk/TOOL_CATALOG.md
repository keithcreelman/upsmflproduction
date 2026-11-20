# UPS AI Tool Catalog (planning deliverable 3)

**Date:** 2026-11-19. Planning only: nothing here is built.

**Evidence base:**
- `origin/main` at `7d24bc5b`; route line numbers refer to `worker/src/index.js`.
- The June 2026 archive.
- 2026 snapshots.
- The audits from this workstream.

**Labels:** [V] verified · [I] inference · [U] unverified · [R] recommendation.

**What this catalog is.** It is the assistant's metadata layer. For every question type, it says which tool answers it, what data stands behind that tool, who may see the result, how fresh it is, and what history it cannot cover. A tool is the only way the assistant gets a number or a fact.

## 1. Contract every tool follows [R]
- **Read-only.** No tool writes, posts, or calls a route with side effects (§6).
- **Inputs always include `as_of`** (a date or `"current"`). A tool that supports only current data returns `unsupported_as_of`. It never silently answers for today. This keeps phase 1 forward-compatible with the history slices.
- **Output envelope:**

  ```
  {data, facts:[{id, value, unit, as_of, source, grade}], coverage:{supported, gaps[]},
   provenance:{route|module, inputs, code_sha, data_version}, data_class, freshness}
  ```

  Every number the answer shows is one of these `facts`.
- **Evidence grade** on every fact: A (MFL record) · B (league document: forum, log, rulebook, Keith ruling) · C (derived by code) · D (inferred) · `NO_RECORD`.
- **Data class ceiling:** P0 public · P1 owner-private (caller's own franchise only) · P2 commissioner. P3 secrets never appear. Filtering happens in the tool, not in the prompt.
- **Implementation preference** [R]:
  - **Calculators:** call the shared module directly.
  - **Composite reads:** call the existing route through the `SELF` service binding. A Worker self-fetch on the workers.dev URL fails, per memory [V].
  - **Never** call browser copies of any calculation.
- **D1 cost:** every new query is measured (`rows_read`, `EXPLAIN QUERY PLAN`) under `docs/D1_QUERY_RULES.md` before it ships.

## 2. Phase-1 tool set (14 tools, all over existing data)

| # | Tool | Answers | Backing [V] | Authority | Class | Coverage / freshness | Status |
|---|---|---|---|---|---|---|---|
| 1 | `rules.search(query, as_of, audience)` | Which rule applies | `site/m/data/rules.json` (CI-built from canon; 178 rules, anchors, `internal` flags, `canon_sha`) | Canon | P0 (internal blocks P2) | Current canon only; `as_of` other than current → returns the canon §4 text plus `unsupported_as_of` | **Build:** small keyword index at CI time |
| 2 | `rules.get(anchor)` | Exact rule text for citation; facts `rule_title` always and `rule_year` for a single-year "Rule changes by year" heading (the year in the heading, not a proved effective date: the S4 gap stays) | Same payload | Canon | P0/P2 | Rebuilt on each canon push | Ready (file) |
| 3 | `glossary.lookup(term or raw token)` | "What is Ext1 / MYM / Vet-ERA-BL?" | Canon + the league's contract-status vocabulary (about 75 tokens) | Canon; crosswalk is grade C | P0 | Needs a CI drift check (it already caught `Vet-Ext1-FL`) | **Build:** port |
| 4 | `coverage.check(domain, season)` | "Does data exist to answer this?" | Coverage matrix and gap list (#1386) as a static generated file | Gap plan | P0 | Regenerated when a gap closes | **Build:** small; the main defense against confident wrong answers |
| 5 | `roster.current(franchise)` | Current roster and contracts | `/roster-workbench` (48228) | MFL live | P0 | Live, 60 s cache. Call without an owner cookie (the route personalizes) | Ready |
| 6 | `cap.position(franchise, season)` | Cap used and room, this season and next | `/roster-workbench` + `cap_math.js` | MFL + UPS cap math | P0 | Current and next season only | Ready |
| 7 | `cap.penalty_quote(player, drop_date)` | Cost to cut | `/api/cap-penalty/preview` (55487) → inline `_computeDropPenalty` (3801) | **The worker's charged calculator** | P0 | Current season | Ready |
| 8 | `cap.adjustments(franchise, season)` | Penalties and adjustments booked | `/api/salary-adjustments/ledger` (53003) | D1 ledgers | P0 | 2026 complete; earlier seasons partial (traded cap 2020+ only) | Ready |
| 9 | `extension.price(player, years)` | Extension cost under current rules | `extension_pricing.js` (`PRICING_VERSION 2026-09-26.1`) | Code = canon §C4 | P0 | Current rules only | **Wrap:** module, no route |
| 10 | `calendar.events(season)` | Deadlines, windows, trade lock | `/api/league-events` (20577), `trade_deadline.js` | `league_events` | P0 | 2011–26 | Ready |
| 11 | `standings.get(season)` and `bracket(season)` | Standings, seeds, playoff results | `/api/standings` (20846), `/api/playoff-bracket` (21168) | `src_*` tables | P0 | 2011–25 solid; 2010 disputed (GAP-03/17) | Ready |
| 12 | `history.finishes()` / `champions()` | Titles, finishes, eras; each franchise's title seasons listed in full by code (`title_years_<franchise>`) | `/api/historical-finishes` (21522), `/api/hall-of-champions` (21813), `/api/eras` (21566) | `src_final_standings` | P0 | 2010–25 at franchise level, not owner level | Ready |
| 13 | `player.transactions(player)` / `player.profile(player)` | A player's trades, adds, drops, draft, extensions, tags | `/api/player-transactions` (14510), `/api/player-bundle` (15189, needs `&L=`) | `src_*`, extension and tag masters | P0 | All years. Gaps: WAIVER-type moves 2010–17 (GAP-09); multi-player drops (GAP-15). Picks appear as tokens, not traced | Ready |
| 14 | `data.freshness()` | How fresh each source is | `/api/data-freshness` (20514) + valuation snapshot freshness | `etl_runs` | P0 | **Partial:** most jobs don't write `etl_runs` [I] | Ready (partial) |

Optional for phase 1, if cheap to add:
- `valuation.snapshot` (file `data/valuation/trade_valuation_snapshot.json`; 8/14-day freshness; [V])
- `forecast.season` (season sim JSON; stale between weekly packages until draft #1442)
- `taxi.eligibility` (`taxi_rule.js`)
- `waivers.availability` (44978)
- `player.stats` (`/api/player-weekly-box`, leaderboards)

## 3. Tools that need the League Record (missing today)

| Tool | Answers | Slice | Data it needs [V coverage] | Historical limitation |
|---|---|---|---|---|
| `pick.lineage(origin, year, round)` | Every holder of a pick, its slot, and the player taken | **S1 trades & picks** | Raw MFL trade tokens (1,036 trades; the parsed table drops the slot on 1,348 rows); draft results 2012–25; **stored per-season draft order** | **Finding:** deriving the slot as "13 − prior final finish" matched only about 10% of never-traded picks in testing. The real order (bracket rules, Toilet Bowl, era changes) must be **stored from MFL per season**, not derived. MFL draft notes ("Pick traded from …") corroborate but are partial (7–56 of 72 picks per season). 2012 dispersal draft missing |
| `trade.tree(trade, depth)` | What each asset became, through later trades | S1 | Same, plus player transactions | Trade timestamps before 2024 are mostly commissioner processing times; cap money in trades is only visible from 2020; 3-way trades exist only in 2026 data |
| `contract.timeline(player)` | Every contract version and why it changed | **S2 contract timeline** | `rosters_weekly` 2017–25 + daily snapshots 2026 + extension master (evidenced vs derived) + auctions, adds, drops | Contract strings filled on only 17–27% of rows in 2017–19. Restructures before 2026 almost never recorded. Extensions 2023–25 derived. GF tags exist in `contract_status` (224 / 113 / 34 contracts in week 1 of 2019 / 2020 / 2021) [V] |
| `state.roster_at(franchise, date)` / `contract_at(player, date)` | State on a past date | S2 | 2026: daily snapshots. 2017–25 and 2010–11: weekly rosters. 2012–16: lineups only (no IR or taxi) | No route takes a date today [V]. 2012–16 rebuilt only partially (grade C) |
| `cap.position_at(franchise, date)` | Cap on a past date | S2 / S4 | Contract at date + adjustment ledger | No historical adjustment ledger before 2020. Penalties pre-2020 are derived, not recorded |
| `owner.history(person or franchise)` | Owner careers across franchises | **S3 owner registry** | Owner registry (owner id, aliases, dated intervals), **needs Keith's rulings** | Today only 27 owner-name strings, the 2010→2011 franchise-id reshuffle, and undated handoffs (2017, 2022, 2024). The existing route re-scrapes MFL live with the worker's cookie (16293): fragile, not stored |
| `rules.at_date(rule, date)` / `penalty.by_era(contract, cut_date)` | "Was this legal or right then?" | **S4 rules by date** | Rule-version table (effective from/to, source, ruled_by); `cap_penalty_rule_eras` (3 eras) [V]; canon §4 dated history; rulebooks 2013, 2014, 2018, 2019 | 2010 rules and the 2011 manifesto are missing. Some changes are dated only "2018 or 2019" in canon. The era-aware library `lib/cap_penalty.js` is imported by nothing [V]. Consolidate it with the charged calculator before using it |
| `rulings.search(topic)` | Precedents | Ruling log (alongside S2) | Canon inline "Keith ruling" lines; changelog (12 entries, incomplete) | No single decision log exists [V]. Votes before 2022 sit in the forum or the lost Slack |
| `narrative.search(topic)` | What the league said | Later; **private store only** | Approved quotes, Wire claims | The public-repo copies (trade comments, Discord export, forum bodies) are never indexed. The scrub is Keith's pending decision |

## 4. Authoritative source by domain

| Domain | Authority [V unless noted] | Assistant rule |
|---|---|---|
| Current rules | `docs/league_context_v1.md` → `rules.json` | Cite the anchor and `canon_sha`. Legacy rule files (`claude_canonical_rules.md`, `services/rulebook/data/rules.json`) are never used |
| Rule history | Canon §4 + rulebook sources + `cap_penalty_rule_eras` | State the era; flag "year uncertain" where canon does |
| Current rosters and contracts | MFL live via the worker | Contract authority between MFL and the repaired FO view is **open in v8** [U]; show both when they differ |
| Calculations (cap, penalty, extension, taxi, compliance) | Worker modules / inline charged code | Only these; browser copies are known to drift |
| Transactions and trades | MFL raw records (`raw_json`) | Parsed tables are convenience only (they drop pick slots) |
| Standings and history | `src_*` and final standings | 2010 is flagged as disputed |
| Ownership | **None yet** | Franchise-level only until the registry exists |
| Trade value | Valuation snapshot (dated) | Always show its as-of date; refuse if stale |

## 5. Duplicates that would make answers inconsistent [V]
- **Drop penalty: four copies.**
  - The inline charged calculator (`index.js:3801`) is the only authority.
  - `lib/cap_penalty.js` is orphaned (imported by nothing).
  - `pipelines/etl/lib/cap_penalty.py` is used by backfills.
  - The client previews are documented to drift $1–3K.
- **Tag tier price: three copies** (`build_tag_tracking.py` authority; `roster_workbench.js:10812`; `front_office.js:9851`).
- **Cap hit:** `cap_math.js` is re-implemented in the browser.
- **Rule text: four sources.** Only `rules.json` and canon are used.

## 6. Never exposed as tools [V]
- `/refresh/after-trade`
- `/reconcile/extensions`
- `GET /trade-offers` (writes)
- `GET /api/draft-state` (writes a cache table)
- `/admin/backfill-playoff-weekly?commit=1`, `/admin/sync-src-draft-picks`
- Any-method admin routes (`/admin/snapshot-mfl-now`, `/admin/trade/*`, test-Discord routes)
- `/api/mfl-export` (generic MFL passthrough)
- Free-form SQL for owner-facing surfaces. The commish drafting agent's `run_sql` is out of scope here (Project A, parked).

## 7. Machine-readable form
The same catalog as YAML, for the eventual harness: `ups_ai_tool_catalog.yaml` (next to this file).
