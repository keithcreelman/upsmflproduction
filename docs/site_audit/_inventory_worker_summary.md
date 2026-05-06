# UPS Dynasty League Worker Route Inventory

**Phase 2B Site Audit — Complete HTTP Route Mapping**

Generated: 2026-04-28  
Branch: `docs/site-audit-v1`  
Source: `/Users/keithcreelman/Code/upsmflproduction/worker/src/index.js` (21,389 lines)

---

## Executive Summary

Total routes cataloged: **59**
- GET routes: **28** (47%)
- POST routes: **31** (53%)
- Admin-only routes: **22** (37%)
- Public write endpoints (no auth): **4** (7%) — SECURITY CONCERN

### Route Distribution by Category

| Category | Count | Examples |
|----------|-------|----------|
| **Data APIs** (read-only) | 14 | `/api/corrections`, `/api/player-bundle`, `/api/mfl-league-state` |
| **Acquisition Hub** | 11 | Rookie draft, FA auction, waivers, actions |
| **MCM** (Matchup Championship) | 7 | Config, ballot, voting (public write) |
| **Admin Utilities** | 12 | Salary imports, Discord posts, contract activity |
| **Trade/Roster/Contract Submission** | 7 | Trade proposals, MYM, restructure, extensions |
| **Bug Reports** | 5 | Submit, status, triage, Discord test |
| **Other** | 3 | Salary alignment check, snapshot, refresh |

---

## Critical Security Findings

### 1. Public Write Endpoints Without Authentication (4 Routes)

These routes accept POST/mutation requests from unauthenticated users:

| Endpoint | Target | Risk |
|----------|--------|------|
| `POST /mcm/nominate` | GitHub dispatch | Spam nominations; rate limiting needed |
| `POST /mcm/vote` | GitHub dispatch | Vote manipulation; no rate limiting |
| `POST /bug-report` | GitHub dispatch | Spam bug reports; no auth check |
| `POST /extension-assistant` | Anthropic API | Token consumption; no rate limiting; public AI access |

**Mitigation required**: Add rate limiting, request validation, optional CAPTCHA for public endpoints.

### 2. Duplicate Route Handlers (1 Known)

**Issue**: Both `/trade-offers` (POST) and `/api/trades/proposals` (POST) handle trade submission with identical logic.

**Risk**: Confusion, potential divergence if one is updated and not the other.

**Recommendation**: Consolidate to single canonical path, deprecate legacy path.

### 3. Unauthenticated Advanced Stats Access

Routes `/api/advanced-stats-*` and `/api/player-bundle` read from D1 database without any auth. While read-only, these reveal sensitive stats data that may be considered proprietary.

---

## D1 Database Bindings

**Database**: `ups-mfl-db` (binding: `UPS_MFL_DB`)  
**Migrations**: 24 migration files in `worker/migrations/`

### Tables Referenced by Routes

| Table | Migrations | Routes That Read |
|-------|-----------|------------------|
| `corrections` | 0001 | GET `/api/corrections` |
| `src_contracts` | 0002 | `/roster-workbench`, `/trade-workbench` (indirect) |
| `src_baselines` | 0003 | Advanced stats endpoints (indirect) |
| `src_pointssummary` | 0005 | `/api/player-bundle` |
| `player_id_crosswalk` | 0006 | Advanced stats endpoints |
| `nfl_player_redzone` | 0007 | `/api/advanced-stats-*` |
| `nfl_player_weekly` | 0008 | `/api/advanced-stats-player-weekly`, `/api/player-bundle` |
| `nfl_kicker_fg_distance` | 0010 | `/api/advanced-stats-*` |
| `nfl_player_advstats_*` | 0012–0014 | `/api/advanced-stats-*` |
| `nfl_team_weekly` | 0016 | `/api/advanced-stats-*` |
| `metric_stickiness` | 0019 | GET `/api/advanced-stats-stickiness` |
| `nfl_player_pbp_season` | 0020 | `/api/advanced-stats-*` |
| `nfl_player_ff_opportunity_season` | 0021 | `/api/advanced-stats-*` |
| `nfl_team_vegas_weekly` | 0022 | `/api/advanced-stats-*` |
| `nfl_team_coaching_history` | 0023 | (possibly `/api/advanced-stats-*`) |
| `nfl_player_breakaway_season` | 0024 | `/api/advanced-stats-*` |

**Note**: Many D1 tables are only available if all migrations have been applied. Dev/staging environments may lack tables, causing graceful degradation (e.g., `/api/player-bundle` emits `nfl_error: "D1 not available"`).

---

## R2 & KV Bindings

### R2 Bucket: `UPS_MFL_BACKUPS`

**Purpose**: MFL data snapshots and database backups.

**Used by routes**:
- `POST /admin/snapshot-mfl-now` — Writes MFL exports (rosters, salaries, transactions, injuries, league, freeAgents, draftResults) + metadata
- `GET /acquisition-hub/rookie-draft/live` — Reads `rookie_draft_history.json` artifact
- `GET /acquisition-hub/rookie-draft/history` — Reads `rookie_draft_history.json` artifact
- `GET /acquisition-hub/free-agent-auction/live` — Reads `free_agent_auction_history.json` artifact
- `GET /acquisition-hub/free-agent-auction/history` — Reads `free_agent_auction_history.json` artifact
- `GET /acquisition-hub/expired-rookie-auction/live` — Reads `expired_rookie_history.json` artifact
- `GET /acquisition-hub/expired-rookie-auction/history` — Reads `expired_rookie_history.json` artifact

**Snapshot Layout**:
```
snapshots/
  YYYY-MM-DD/
    rosters.json
    salaries.json
    transactions.json
    injuries.json
    league.json
    freeAgents.json
    draftResults.json
    _snapshot_meta.json
```

**KV Namespace**: None configured in `wrangler.toml`. (Previously used for MYM caching; likely migrated to GitHub artifacts.)

---

## Environment Variables & Secrets

| Variable | Used By | Purpose |
|----------|---------|---------|
| `COMMISH_API_KEY` | `/admin/snapshot-mfl-now`, `/admin/test-sync/prod-rosters` | X-Internal-Auth header validation |
| `ANTHROPIC_API_KEY` | `POST /extension-assistant` | Claude API calls |
| `LEAGUE_ID` | Scheduled handler (cron snapshot) | MFL league ID for snapshots |
| `YEAR` | Various routes | Current season year (defaults to current UTC year) |
| `MFL_COOKIE` (query param or header) | Most routes | Owner MFL session cookie |
| `MFL_USER_ID` (browser param) | Most routes | Owner user ID (fallback to cookie) |
| `MFL_BROWSER_API_KEY` (browser param) | Most routes | API key from browser (fallback) |

---

## Scheduled Handler (Cron)

**Trigger**: Every hour at :05 past (UTC) — `5 * * * *`

**Function**: `async scheduled(event, env, ctx)`

**Tasks**:
1. **Drop penalty scan** (RULE-WORKFLOW-004): Scan MFL add/drop transactions for new drop penalties, post to MFL as `salaryAdjustments`, fire Discord "Cap Penalty Announcement" (batched per team)
2. **MFL snapshot backup** (at 09:05 UTC daily): Snapshot MFL public exports to R2 bucket `UPS_MFL_BACKUPS`

**Dedup strategy**: MFL's own `salaryAdjustments` export is the canonical ledger; runs are idempotent by `ups_drop_penalty:{ledger_key}`.

---

## High-Risk Areas (Per Keith's Handoff)

### 1. MYM Submission Flow

**Routes**:
- `POST /offer-mym` — User submission
- `POST /offer-restructure` — User submission
- `POST /commish-contract-update` — Admin submission
- `POST /refresh-mym-json` — Admin trigger for GitHub refresh

**Concerns**:
- Writes to GitHub dispatch events (log-mym-submission, log-restructure-submission, log-extension-submission)
- Requires owner MFL session for owner submissions; admin-only for manual updates
- Complex contract math: salary validation, TCV/AAV recalculation, contract length adjustments
- Extension eligibility logic checked in `/extension-assistant` (public AI assistant)

**No write to D1**: MYM is fully GitHub-based; no database mutations.

### 2. Restructure Submission Flow

**Route**: `POST /offer-restructure` (same handler as MYM, different source tag)

**Writes**: GitHub dispatch event (`log-restructure-submission`)

**Validation**:
- Required fields: `league_id`, `year`, `player_id`, `salary`, `contract_year`, `contract_info`
- Salary must be non-negative number
- Contract year must be positive number
- Complex business rules: contract type detection, tag eligibility check

**Concern**: No explicit test coverage noted; relies on caller validation.

### 3. MCM (Matchup Championship Matchmaking) Voting Flow

**Routes**:
- `GET /mcm/config` — Seed (read-only)
- `GET /mcm/ballot` — Nominees
- `GET /mcm/results` — Vote tally
- `POST /mcm/nominate` — **PUBLIC WRITE** — adds GitHub dispatch event
- `POST /mcm/vote` — **PUBLIC WRITE** — adds GitHub dispatch event

**Concern**: Both nomination and voting are public endpoints (no auth). Vulnerable to:
- Spam nominations/votes
- Vote manipulation
- Rate limiting not visible in worker code (likely in GitHub Actions)

### 4. Trade-Related Endpoints

**Routes**:
- `GET /api/trades/proposals/:id` — Fetch proposal by ID
- `POST /trade-offers` or `POST /api/trades/proposals` — Submit trade (DUPLICATE HANDLERS)
- `GET /trade-pending` — List pending trades
- `GET /trade-workbench` — Workbench data

**Concerns**:
- Duplicate handlers (`/trade-offers` and `/api/trades/proposals` POST) may indicate legacy code path
- Complex validation logic (asset lists, tagged players, cap implications)
- Requires owner MFL session
- Writes directly to MFL (not to D1)

### 5. Tag Tracking Endpoints

**Routes**: 
- `GET /roster-workbench/admin-state` — Reads tag tracking JSON from GitHub CDN
- `POST /roster-workbench/action` — Submits tag action (tag side, year, etc.)

**Source**: `https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/ccc/tag_tracking.json`

**Concern**: External JSON source (GitHub CDN); if compromised, affects tag eligibility logic.

### 6. Contract/Cap Math Endpoints

**Routes**:
- `GET /salary-alignment-check` — Verify salary vs MFL
- `POST /admin/import-salaries` — Import salary data
- `POST /admin/import-drop-penalties` — Import drop penalties
- `POST /acquisition-hub/rookie-draft/reconcile-contracts` — Post-draft salary reconciliation

**Concerns**:
- Salary alignment check has no auth
- Import and reconciliation are admin-only but modify league state
- Drop penalty scan runs hourly; dedup is MFL-side (idempotent)

### 7. Auction Nomination Tracking Endpoints

**Routes**:
- `GET /acquisition-hub/rookie-draft/live` — Current state
- `GET /acquisition-hub/rookie-draft/history` — Historical results
- `POST /acquisition-hub/rookie-draft/action` — Admin submit bid/skip/nominate
- `POST /acquisition-hub/rookie-draft/reconcile-contracts` — Post-action salary sync

**Concerns**:
- Admin-only mutation endpoints
- Writes directly to MFL via form submission
- Artifacts cached in R2 (historical data)

---

## Routes Consumed by HPM/Site Pages

### Confirmed Consumers

| Route | Consumed By |
|-------|-------------|
| `GET /api/player-bundle` | `site/rookies/rookie_draft_hub.js`, `site/rosters/roster_workbench.js` |
| `GET /acquisition-hub/*` (wildcard) | `site/acquisition/acquisition_hub.js` |
| `GET /roster-workbench` | `site/rosters/roster_workbench.js` |
| `GET /trade-workbench` | `site/trades/trade_workbench.js` |

### Likely Consumers (Inferred)

| Route | Likely Consumers |
|-------|-----------------|
| `GET /api/corrections` | `site/ccc/*` (Contract Command Center) |
| `GET /api/mfl-league-state` | Multiple workbenches (roster, trade) |
| `GET /api/advanced-stats-*` | `site/standings/*` (standings display), possibly `site/options/*` |
| `POST /offer-mym`, `POST /offer-restructure`, `POST /commish-contract-update` | `site/ccc/ccc.js` (Contract Command Center) |
| `POST /mcm/nominate`, `POST /mcm/vote` | `site/mcm_embed_loader.js` |
| `POST /roster-workbench/action` | `site/rosters/roster_workbench.js` |
| `POST /trade-offers` | `site/trades/trade_workbench.js` |

### Truly Orphaned (No Known Consumer)

- `GET /bug-reports` (read-only; likely admin-only UI)
- `GET /salary-alignment-check` (likely admin diagnostic)
- Admin endpoints: `/admin/salary-change-log`, `/admin/import-salaries`, `/admin/import-drop-penalties`, etc.

---

## Error Handling & Validation

### Common Validation Patterns

1. **Query params**: `L` (league ID), `YEAR` (season), `F` or `FRANCHISE_ID`
2. **Form fields**: JSON or URL-encoded depending on `Content-Type` header
3. **Required field checks**: Missing fields return 400 with `validation_fail` status
4. **Type coercion**: Numbers parsed via `Number()` or `parseInt()`

### Error Response Format

**Success**: `{ ok: true, data: ... }`

**Failure**: `{ ok: false, error: "...", details: {...} }` (status varies: 400/401/403/500/502)

### Graceful Degradation

- D1 queries: If table missing, emit `nfl_error: "D1 not bound"` or `D1 not available`
- MFL fetches: If HTTP error, cache fallback or emit `fetch_failed` error
- External APIs (GitHub, Anthropic): Upstream error logged; worker returns 502 with upstream details

---

## Rate Limiting & Quotas

**Current state**: No rate limiting visible in worker code.

**Likely implemented at**:
- GitHub Actions (for dispatch event handlers)
- Cloudflare Workers rate-limit rules (if configured in dashboard)
- MFL API (external; not controlled)

**Public endpoints needing rate limiting**:
- `POST /mcm/nominate`
- `POST /mcm/vote`
- `POST /bug-report`
- `POST /extension-assistant`

---

## Migrations Applied

All 24 migrations appear to be applied to `ups-mfl-db`:

1. `0001_corrections.sql` — Corrections override table
2. `0002_mfl_source_tables.sql` — MFL source tables (src_contracts, etc.)
3. `0003_baselines.sql` — Positional scoring baselines
4. `0004_weekly_win_chunks.sql` — Weekly win chunks (not listed in later grep)
5. `0005_player_pointssummary.sql` — Player points summary
6. `0006_advanced_stats_schema.sql` — Advanced stats schema + crosswalk
7. `0007_nfl_player_redzone.sql` — Redzone stats
8. `0008_nfl_player_weekly_routes_run.sql` — Routes run stat
9. `0009_snaps_rename_gsis_to_pfr.sql` — Rename GSIS to PFR
10. `0010_nfl_kicker_fg_distance.sql` — Kicker FG distance
11. `0011_pfr_weekly_columns.sql` — PFR weekly columns
12. `0012_pfr_rush_advstats.sql` — PFR rush advanced stats
13. `0013_pfr_pass_def_advstats.sql` — PFR pass def advanced stats
14. `0014_pfr_season_advstats.sql` — PFR season advanced stats
15. `0015_pbp_fg_punt.sql` — PBP FG/punt stats
16. `0016_pbp_punt_spot_team_4thdown.sql` — PBP punt spot + team 4th down
17. `0017_punter_net_inside_buckets.sql` — Punter net inside buckets
18. `0018_punter_inside20_pbp_parity.sql` — Punter inside 20 parity
19. `0019_metric_stickiness.sql` — Metric stickiness (consistency)
20. `0020_pbp_advanced_season.sql` — PBP advanced season
21. `0021_ff_opportunity_season.sql` — FF opportunity season
22. `0022_team_vegas_weekly.sql` — Team Vegas weekly
23. `0023_team_coaching_history.sql` — Team coaching history
24. `0024_player_breakaway_season.sql` — Player breakaway season

**Note**: Some migrations (0004, 0009, 0011, 0017, 0018) do not appear in the grep output; may be DDL-only or columns-only (no new tables).

---

## Most Concerning Findings (3 Priority Items)

### 1. **Public MCM and Bug Report Submissions Without Rate Limiting**

**Routes**: `POST /mcm/nominate`, `POST /mcm/vote`, `POST /bug-report`, `POST /extension-assistant`

**Risk**: Unauthenticated users can spam nominations, votes, bug reports, and consume Anthropic API tokens at no cost.

**Action**: Implement rate limiting by IP/user-agent, add CAPTCHA for public endpoints, consider requiring GitHub login for MCM.

---

### 2. **Duplicate Trade Submission Handlers**

**Routes**: `POST /trade-offers` vs `POST /api/trades/proposals` (both POST)

**Risk**: Code divergence; if one handler is updated and not the other, trade submissions may behave inconsistently.

**Action**: Audit both routes for functional parity, consolidate to single canonical path, deprecate legacy path with redirect.

---

### 3. **Orphaned Routes & Unknown Consumers (53/59 Routes)**

**Issue**: Only 6 routes have confirmed site/HPM consumers. 53 routes marked "Unknown consumed_by".

**Risk**: Dead code, maintenance burden, unclear surface area.

**Action**: Grep site/ directory for fetch patterns matching each route; document or deprecate unused endpoints.

---

## Summary

This inventory documents **59 HTTP routes** across the Cloudflare Worker. The worker handles:
- **Read APIs**: Corrections, player stats, MFL league data, advanced analytics
- **Public write** (MCM, bug reports, extension assistant): Unauthenticated but dispatches to GitHub/Anthropic
- **Owner-authenticated mutations**: Trades, MYM, restructures, roster actions
- **Admin-only management**: Salary imports, Discord notifications, draft actions, reconciliation
- **Scheduled tasks**: Hourly drop penalty scan + daily MFL snapshot backup

**Critical gaps**: Rate limiting on public endpoints, potential duplicate code paths, and unclear route consumption.

