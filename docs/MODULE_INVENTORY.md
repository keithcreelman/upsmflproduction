# MODULE INVENTORY — UPS MFL Production

**Generated:** 2026-05-26
**Purpose:** Single source of truth for "what file belongs to what module." Cross-reference this before changing anything.
**Replaces:** the stub `docs/REPO_MAP.md`.

Buckets used:
1. **Front Office (Roster Workbench)**
2. **Trade Module**
3. **Auction Module**
4. **Rookie Draft Module**
5. **Other / Cross-cutting** (everything else, including the globally-injected header/footer)

Status legend: **Active** = recently committed or directly referenced by live UI · **Dormant** = present but no recent activity · **Archive candidate** = should be moved to `site/_archived/` · **Decision needed** = duplicate or unclear ownership.

---

## 1. Front Office (Roster Workbench)

The big roster-management workbench loaded inside MFL's HPM frame.

| Path | Purpose | Size | Status |
|---|---|---|---|
| `site/rosters/roster_workbench.js` | Main FO workbench — state machine, salary cap calcs, drop/cut/reserve, trade processing | 500 KB | Active |
| `site/rosters/roster_workbench.html` | HTML shell + mount point | 0.8 KB | Active |
| `site/rosters/roster_workbench.css` | FO styling | 55 KB | Active |
| `site/rosters/mflscripts_rosters_fork.js` | **Replaces** MFL's native rosters script; loaded by `footer_custom_v2.html` on every non-O=07 roster page | 54 KB | Active — high blast radius |
| `site/rosters/ups_trade_offer_patch.js` | Patches MFL's O=43 trade-offer page; **also** hosts the auction-nomination o43 picker filter + unified high-bid modal (PR #266) | 20 KB | Active — Front Office ↔ Auction coupling |
| `site/rosters/mfl_hpm_embed_loader.js` | Loads workbench inside HPM frame | 7 KB | Active |
| `site/rosters/contract_submissions/` | Submission log directory | — | Active (data) |
| `site/rosters/player_acquisition_lookup_2026.json` | Acquisition source lookup data | data | Active |
| `site/rosters/player_points_history.json` | Player points history data | data | Active |

**Worker routes:**
- `GET /roster-workbench` — HTML shell (fetched via `/api/repo-html`)
- `POST /roster-workbench/action` — drop / taxi / promote / cut actions
- `POST /admin/roster-workbench/admin-state` — admin state mutations

**Decision needed:**
- `origin/codex/front-office-wip` is a 130 KB-smaller refactor of `roster_workbench.js` (net −4768 LoC vs main). Open and decide: **replace / salvage / scrap**. If replace, merge it; if salvage, cherry-pick; if scrap, delete the branch.
- `Team Operations` (separate bucket, listed under Other) overlaps Front Office on cap/cuts/reserve/options — clarify which module owns which screens.

---

## 2. Trade Module

| Path | Purpose | Size | Status |
|---|---|---|---|
| `site/trades/trade_workbench.js` | Trade workbench — multi-party deal logic, bid marshaling, proposal/counter/veto | 247 KB | Active |
| `site/trades/trade_workbench.html` | HTML shell | 52 KB | Active |
| `site/trades/trade_workbench.css` | Styling | 40 KB | Active |
| `site/trades/mfl_hpm_embed_loader.js` | HPM embed loader | 13 KB | Active |
| `site/trades/trade_outbox_*.json` | Per-franchise outbox snapshots (years 2026, 2099) | data | Active |
| `site/trades/trade_offers_*.json` | Trade offer snapshots | data | Active |
| `site/trades/extension_previews_2026.json` | Extension preview cache | data | Active |
| `site/trades/trade_workbench_sample.json` | Test fixture | data | Dormant |

**Worker routes:**
- `GET /trade-workbench` — HTML shell
- `POST /api/trade` — propose / simulate
- `POST /api/trade/process` — two-step process (tradeProposal → tradeResponse, posts to Discord on success)
- `POST /api/submit-trade-bait` — owner submits WILL_GIVE_UP / WILL_TAKE_TEXT
- `GET /api/trade-bait-notes` — per-player notes
- `GET|POST /api/trades/proposals` — list / create
- `POST /api/trades/proposals/action` — accept / counter / veto / decline
- `GET /api/trades/outbox`, `POST /api/trades/outbox/replay` — outbox + replay
- `POST /api/trades/reconcile/extensions` — sync back to MFL
- `POST /api/trades/refresh-after-trade` — post-trade refresh
- `GET /trade-pending` — pending state poll

---

## 3. Auction Module

**Active dedicated hub** (released 2026-05-22, currently v0.6.0):

| Path | Purpose | Size | Status |
|---|---|---|---|
| `site/auction/auction_hub.js` | Auction Hub — state machine + renderers (Expired Rookie Pool, War Room, Bid History) | 1337 LoC | Active |
| `site/auction/auction_hub.html` | Hub HTML shell | 287 LoC | Active |
| `site/auction/auction_hub.css` | Styling | 663 LoC | Active |
| `site/auction/mfl_hpm_embed_loader.js` | HPM embed loader | — | Active |
| `site/auction/VERSION.json` | Version metadata (v0.6.0, 2026-05-22) | data | Active |
| `site/auction/CHANGELOG.md` | Changelog | docs | Active |
| `site/auction/curated_gifs.json` | Curated GIFs for auction announcements | data | Active |

**Cross-cutting auction surface** (lives in other modules' files — flag this):
- `site/rosters/ups_trade_offer_patch.js` hosts the o43 ERA-eligible picker filter + the auction-nomination high-bid modal (recent PRs #262–#266). This is **Front Office code that also implements Auction UX** — by design, because MFL renders the nomination flow inside its own O=43 page.

**Live worker routes** (`/api/auction/*` — what `auction_hub.js` actually calls, verified 2026-05-29):
- `GET /api/auction/era-eligible` — ERA-eligible player table
- `GET /api/auction/lots` — auction lots
- `GET /api/auction/bid-stats` — per-franchise aggregation
- `GET /api/auction/bid-history` — bid thread history
- `GET /api/auction/compliance` — roster compliance
- `GET /api/auction/cut-rebid-blocks` — cut/rebid eligibility
- `GET /api/auction/nomination-status` — nomination cadence/window
- `finalizeEraContracts()` — writes ERA win contracts back to MFL (#270)
- `GET /api/player-bundle` — player data + bid context

**DECISION (2026-05-29): KILL the Acquisition Hub.** The Auction Hub (`site/auction/`) is the live, canonical auction module. The old `/acquisition-hub/*` routes are dead — the live hub uses `/api/auction/*` exclusively.
- **Delete worker routes:** `/acquisition-hub/bootstrap`, `/acquisition-hub/rookie-draft/{live,history,action,reconcile-contracts}`, `/acquisition-hub/free-agent-auction/{live,history,action}`, `/acquisition-hub/expired-rookie-auction/{live,history,action}`, `/acquisition-hub/waivers`, `/acquisition-hub/admin/refresh`
- **Archived UI:** `site/_archived/2026-05-12/acquisition/` — already archived
- **FA Auction folds INTO the Auction Hub** as a second auction type alongside ERA (see `CONTRACT_AUTOMATION_PLAN.md` Gap 1). FA wins present owner-selected Contract Options (2Y/3Y, standard/loaded) gated by contract-count caps.

---

## 4. Rookie Draft Module

| Path | Purpose | Size | Status |
|---|---|---|---|
| `site/rookies/rookie_draft_hub.js` | Draft hub — board, prospect search, trade history, ADP/stickiness | 368 KB | Active |
| `site/rookies/rookie_draft_hub.html` | HTML shell | 35 KB | Active |
| `site/rookies/rookie_draft_hub.css` | Styling | 69 KB | Active |
| `site/rookies/mfl_hpm_embed_loader.js` | HPM embed loader | 9 KB | Active |
| `site/rookies/rookie_draft_hub_2026.json` | Current-year draft state | data | Active |
| `site/rookies/rookie_prospects_2026.json` | Prospect data | data | Active |
| `site/rookies/external_adp_2026.json` | External ADP feed | data | Active |
| `site/rookies/rookie_ap_vs_ep.json` | AP-vs-EP analysis | data | Active |
| `site/rookies/rookie_draft_day_trades.json` | Draft-day trade log | data | Active |
| `site/rookies/rookie_draft_history.json` | Historical draft data | data | Active |
| `site/rookies/rookie_draft_team_tendencies.json` | Team tendency analysis | data | Active |
| `site/rookies/rookie_draft_tiers.json` | Tiering data | data | Active |
| `site/rookies/rookie_future_picks.json` | Future pick inventory | data | Active |
| `site/rookies/franchise_assets_2026.json` | Franchise asset snapshot | data | Active |
| `site/rookies/VERSION.json` / `CHANGELOG.md` | Version metadata + changelog | docs | Active |

**Worker routes:**
- `GET /api/draft-state` — live draft state (no cache, overlays static snapshot)
- `GET|POST /api/draft-status` — go-live flag (D1 `ups_runtime_flags`)
- `POST /api/pick` — submit / simulate pick
- `POST /api/r6/apply-order` — commish: apply draft order (destructive)
- `POST /api/r6/announce-kickoff` — commish: Discord kickoff (idempotent marker)
- `POST /api/r6/publish-final-order` — commish: Discord final order (idempotent)

---

## 5. Other / Cross-cutting

### 5a. Globally-injected (HIGH blast radius — every MFL page)

| Path | Purpose | Size | Status |
|---|---|---|---|
| `header_custom_v2.html` | Header injected on every MFL page — 11+ IIFEs, dev-league redirect, theme vars, CSS overrides | 316 KB / 9300 lines | Active — **danger zone** |
| `footer_custom_v2.html` | Footer — 40+ global flags, loads `mflscripts_rosters_fork.js`, mutation observer rewriting "Blind Bidding Dollars" → "Salary", trade-page enhancements | 26 KB / 808 lines | Active — **danger zone** |
| `site/loader.js` | Bootstrap injector — global CSS contrast fix, `is_offseason` global, `MFLGlobalCache` shim | 23 KB | Active — **danger zone** |
| `apps/mfl_site/contract_command_center_bridge.js` | CCC bridge (CCC retired 2026-05-15) | 6 KB | **SCRAP** (decision 2026-05-26) — archive |
| `apps/mfl_site/contract_command_center_loader_patch.html` | CCC loader patch | 0.8 KB | **SCRAP** (decision 2026-05-26) — archive |

**External scripts pulled in but not owned by us** (no source in repo — track but cannot edit):
- `https://www.mflscripts.com/mfl-apps/global/header.js?v=1.60`
- `https://www.mflscripts.com/mfl-apps/global/footer.js?v=1.12`
- `https://mflscripts.com/mfl-apps/playoffs/standingsColumns.js`

### 5b. HPM page wrappers (mount points)

Lightweight HTML files that `header.js` substitutes into MESSAGE<N> URLs:

| Path | Loads |
|---|---|
| `site/hpm-default.html` | default landing |
| `site/hpm-draft-hub.html` | rookie_draft_hub |
| `site/hpm-myteam.html` | team_operations |
| `site/hpm-reports.html` | reports hub |
| `site/hpm-standings.html` | standings |
| `site/hpm-stats-workbench.html` | stats workbench |
| `site/hpm-mcm.html` | MCM via `mcm_embed_loader.js` |
| `site/hpm-issue-report.html` | bug-report widget |
| `site/ups_issue_report.html` | standalone bug widget |
| `site/index.html` | repo landing |

### 5c. Team Operations

| Path | Purpose | Size | Status |
|---|---|---|---|
| `site/team_operations/team_operations.js` | Salary cap, contracts, cuts, reserve, options | 139 KB | **Active — designated FO replacement** (decision 2026-05-26). See FOLLOWUP doc for transition audit. |
| `site/team_operations/team_operations.css` | Styling | 49 KB | Active |
| `site/team_operations/mfl_hpm_embed_loader.js` | Embed loader | 6 KB | Active |

**Decision needed:** Team Operations and Front Office both manage cap / cuts / contracts. Document which screen owns which workflow.

### 5d. Stats Workbench

| Path | Purpose | Size | Status |
|---|---|---|---|
| `site/stats_workbench/stats_workbench.html` | Advanced stats hub (leaderboards, weekly, correlations) | 138 KB | Active |
| `site/stats_workbench/mfl_hpm_embed_loader.js` | Embed loader | 2 KB | Active |

**Worker routes:** `/api/advanced-stats-leaderboard`, `/api/advanced-stats-player-weekly`, `/api/advanced-stats-stickiness`

### 5e. Standings

| Path | Purpose | Size | Status |
|---|---|---|---|
| `site/standings/mfl_hpm_standings.html` | Standings page (v1) | 99 KB | **SCRAP** (decision 2026-05-26) — archive |
| `site/standings/mfl_hpm_standings_v2.html` | Standings page (v2) | 141 KB | **Active — canonical** |
| `site/standings/mfl_hpm_embed_loader.js` | Embed loader | 4 KB | Active |

**Decision needed:** v1 and v2 both present. Pick canonical, archive the other.

**Worker routes:** `/api/standings`, `/api/playoff-bracket`, `/api/historical-finishes`, `/api/eras`, `/api/division-power-rankings`, `/api/hall-of-champions`, `/api/league-events`

### 5f. Reports

| Path | Purpose |
|---|---|
| `site/reports/index.html` + `reports.js` + `reports_router.js` + `reports.css` + embed loader | Reports hub |
| `site/reports/contracts/contracts_report.js` | QB contract history sub-report |
| `site/reports/franchise_assets/franchise_assets.js` | Roster composition sub-report |
| `site/reports/historical/historical_reports.js` | Era records sub-report |
| `site/reports/player_scoring/player_scoring.js` | Leaderboards (70 KB) |
| `site/reports/salary_adjustments/salary_adjustments.js` + CSS | Cap-penalty audit (30 KB) |
| `site/reports/transactions/transaction_reports.js` | Trade/drop/add history |

### 5g. Mobile (PWA)

Per memory `feedback_mobile_site_isolation_scope`: code is isolated from desktop, but actions WRITE to real MFL via shared worker routes.

| Path | Purpose |
|---|---|
| `site/m/index.html` + `app.js` + `app.css` | Shell + data layer + routing |
| `site/m/player_sheet.js` + `.css` | Bottom-sheet player UI |
| `site/m/views/contracts.js` | Contracts view |
| `site/m/views/draft.js` | Draft view |

### 5h. MCM (Man Crush Monday voting)

| Path | Purpose |
|---|---|
| `site/mcm/mcm_frame.html` | Voting ballot frame |
| `site/mcm_embed_loader.js` | Iframe loader |
| `services/mcm/` | MCM voting backend service |

**Worker routes:** `/mcm/config`, `/mcm/week`, `/mcm/botd`, `/mcm/ballot`, `/mcm/nominate`, `/mcm/vote`, `/mcm/results`

### 5i. Shared utilities (cross-bucket consumers)

| Path | Consumers | Size |
|---|---|---|
| `site/shared/player_profile_master.js` | rosters, trades, rookies, reports | 132 KB |
| `site/shared/cap_math.js` | rosters, trades, team_operations | 124 LoC |
| `site/shared/mfl_cache.js` | rosters, trades, rookies, auction | 601 LoC |
| `site/shared/player_popup_bridge.js` | multiple modules | 160 LoC |
| `site/shared/mini_boxscore.js` | reports, standings | 2045 LoC |
| `site/shared/mobile_menu.js` | mobile + desktop | 120 LoC |
| `site/shared/module_collapse.js` | header/footer + modules | 141 LoC |
| `site/shared/reveal.js` | multiple modules | 107 LoC |
| `site/shared/playoff_bracket_polish.js` | standings | 54 LoC |
| `site/shared/responsive_table.css` | multiple modules | 100 LoC |
| `site/shared/css/` | shared CSS | dir |

### 5j. Other site-level

| Path | Purpose |
|---|---|
| `site/ups_options_widget.js` + `.css` | UPS options/settings widget (58 KB) |
| `site/cameos/` | Cameo / avatar assets |
| `site/champions_panels.json` | Champion panel data |
| `site/ccc/tag_tracking.json` + `tag_submissions.json` | CCC data (747 KB + 11 KB) — retained for history |
| `site/_archived/2026-05-12/` | Archive bucket (acquisition v1, CCC, hpm-ccc.html) |

### 5k. Worker backend

| Path | Purpose | Size |
|---|---|---|
| `worker/src/index.js` | **Monolithic** route handler — every endpoint, every shared helper | 26K lines — **danger zone** |
| `worker/src/hall.js` | Hall MESSAGE_BOARD / POLL / TRADES routing | 40 KB |
| `worker/src/discord_round.js` | Hall rounds, cap penalty Discord, contract activity Discord | 92 KB |
| `worker/src/discord_bot.js` | `/discord/interactions` (slash commands, button clicks) | — |
| `worker/src/lib/cap_penalty.js` | Drop-penalty calculation (RULE-WORKFLOW-004) | 7.5 KB |

### 5l. Other / Misc admin

**Admin worker routes** (commish-only):
- `GET /admin/snapshot-mfl-now` — manual R2 backup
- `GET /admin/salary-change-log` — salary transaction history
- `POST /admin/import-salaries` — bulk import from CSV
- `POST /admin/import-drop-penalties` — drop penalties CSV import
- `POST /admin/test-sync/prod-rosters` — test-league sync (per memory `reference_test_league_sync_endpoint`)
- `POST /admin/discord/post` — generic admin one-off
- `POST /admin/deadline-reminders/{test-discord,run}` — deadline reminders
- `POST /admin/trade-notification/{test-discord,post}` — trade announcements
- `POST /admin/restructure-alert/{test-discord,post}` — restructure alerts
- `POST /admin/cap-penalty/{test-discord,post}` — cap penalty announcements
- `POST /admin/contract-activity/{test-discord,test-discord-batch,post,post-batch,edit}` — contract activity
- `POST /admin/bug-report/{status,triage-note,test-discord}` — bug report triage

**Bug reporting:**
- `POST /bug-report` — submit
- `GET /bug-reports` — list
- (see `/admin/bug-report/*` above)

**Other:**
- `GET /api/me`, `POST /api/settings` — user/franchise identity
- `POST /api/submit-lineup` — lineup submission
- `GET /api/mfl-export` — whitelisted MFL TYPE= proxy
- `GET /api/mfl-league-state` — franchises + pid_to_fid (currently unused in UI)
- `GET /api/franchise-assets` — players + future picks + current-year picks
- `GET /api/corrections` — manual league corrections
- `GET /api/players-search` — player search
- `GET /api/player-news` — news feed
- `GET /api/roast-context`, `POST /api/roast/log`, `POST /api/reply-signal/log` — roast bot training
- `POST /api/anthropic-proxy/v1/messages` — Anthropic API proxy
- `GET /api/repo-html` — allowlisted GitHub HTML fetch (site/ only)
- `GET /salary-alignment-check` — cap alignment check

---

## Decisions (resolved 2026-05-26 with Keith)

1. **`origin/codex/front-office-wip`:** **SCRAP.** Delete the branch.
2. **Front Office transition path:** Team Operations (5c) will REPLACE the current Roster Workbench, but only when ready. See [`docs/FOLLOWUP_TASKS_2026-05-26.md`](FOLLOWUP_TASKS_2026-05-26.md) for the functionality + data-alignment audit needed first (what does current FO have that Team Ops doesn't? extensions / tagging / route paths aligned?).
3. **Standings v1 vs v2:** **SCRAP v1** (`site/standings/mfl_hpm_standings.html`). v2 is canonical.
4. **CCC artifacts:** **SCRAP.** Move `apps/mfl_site/contract_command_center_bridge.js` + loader patch under `apps/mfl_site/_archived/`. `site/ccc/*.json` is historical data — retain.
5. **External MFL scripts (TOS / mflscripts.com):** **Snapshot as stepping stone to existing sunset plan.** Plan already exists at [`docs/mfl_native/tos_removal_plan.md`](mfl_native/tos_removal_plan.md) (12-20 day "drain don't yank" approach). Snapshot the three remaining vendor files into `vendor/mflscripts/` so we can diff when the vendor changes them mid-flight, then execute the existing plan to sunset them. (One snapshot already exists: `site/rosters/mflscripts_rosters_fork.js` is the forked rosters/script.js.)

## New follow-up work surfaced 2026-05-26

See [`docs/FOLLOWUP_TASKS_2026-05-26.md`](FOLLOWUP_TASKS_2026-05-26.md) for:
- FO → Team Ops transition: functionality audit + data alignment
- Auction mobile view
- Auction O=43 CSS bug list (button color, alert border overlap, textarea sizing)
- Trade mobile view + 3-team trade capability (backlog)
- Stats Workbench automated data ingestion verification
- MFL injected-CSS rendering audit across all customized pages
- Execute existing TOS removal plan

---

## How to use this doc

Before any non-trivial change:
1. Find the file you're editing here. Note its bucket.
2. If it's in **5a Globally-injected**, **5i Shared utilities**, or `worker/src/index.js` — STOP. Run the **Change Playbook** (`docs/CHANGE_PLAYBOOK.md`) checklist.
3. Check `git worktree list` and `gh pr list --search "is:open"` for parallel work on the same file.
4. If your change touches multiple buckets, write that in your commit message ("touches: front-office, auction").
