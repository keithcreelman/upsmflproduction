# Site Audit: Artifact Inventory Summary
**Generated: 2026-04-28**  
**Phase: 2A - Complete Site Directory Inventory**

---

## Overview

This inventory captures **174 artifacts** across the `site/` directory, organized by type and function. The site is a distributed fantasy football management platform built on MFL (MyFantasyLeague) with heavy use of CDN-hosted assets (jsDelivr), Cloudflare Workers for backend services, and state stored in JSON files + localStorage.

---

## Artifact Counts by Type

| Type | Count | Purpose |
|------|-------|---------|
| **json_data** | 92 | League data, standings, player scoring, salary adjustments, acquisition history, CCC state |
| **js_module** | 25 | Feature modules: CCC, trades, rosters, rookies, acquisitions, team ops, stats, reports |
| **loader** | 13 | Context-aware embed loaders that detect league/year/franchise and load iframes |
| **html_page** | 24 | Host pages and wrappers for HPM-injected modules and standalone applications |
| **css** | 11 | Styling for all major modules |
| **other** | 8 | Documentation (README, CHANGELOG, VERSION), SQL schemas |
| **image** | 1 | SVG asset (ccc_contracts.svg) |
| **TOTAL** | **174** | |

---

## Module Breakdown by Subdirectory

### Root-Level HPM Pages (11)
- **hpm-*.html** (11 files): Quick-load wrappers for HPM-injected modules
  - **Purpose**: Each provides a thin HTML shell that imports an embed loader via CDN (jsDelivr)
  - **Pattern**: All use `window.UPS_*_RELEASE_SHA` or hardcoded SHAs for release pinning
  - **Examples**: 
    - `hpm-ccc.html` → CCC
    - `hpm-draft-hub.html` → Rookie Draft Hub
    - `hpm-standings.html` → Standings (hardcoded league ID 74598)
    - `hpm-widget.html` → UOW (Options Widget)

### `site/ccc/` (16 artifacts)
- **Purpose**: Contract Command Center — tag management, MYM/restructure submissions, extension tracking
- **Key Files**:
  - `ccc.js` (417 KB) — Main app, hardcoded franchises (0001-0012), commish=0008
  - `mfl_hpm_embed_loader.js` — Context detector (league/year/franchise) + iframe bootstrapper
  - `mfl_hpm16_contractcommandcenter.html` — CCC iframe host
  - `extension_assistant.js/.css` — Modal for extension education
  - **Data**: `mym_dashboard.json`, `tag_tracking.json`, `tag_submissions.json`, `player_points_history.json`, `ccc_release_log.json`
  - **Submission Flow**: Forms → POST to `upsmflproduction.keith-creelman.workers.dev/offer-mym|offer-restructure` → Discord
  - **Last Modified**: 2026-04-10 (ccc.js); most data files: 2026-02-16

### `site/rosters/` (9 artifacts)
- **Purpose**: Roster management with contract tracking, salary calculations, extension/restructure options
- **Key Files**:
  - `roster_workbench.js` (472 KB) — Main app with live points, bye weeks, contract actions
  - `roster_workbench.css` (52 KB) — Interactive grid styling
  - `mflscripts_rosters_fork.js` (55 KB) — Extended MFL scripts fork
  - `ups_trade_offer_patch.js` (20 KB) — Trade offer interceptor
- **Data Inputs**: `player_points_history.json` (939 KB), `player_acquisition_lookup_2026.json` (116 KB), MFL API
- **Last Modified**: 2026-04-23 (roster_workbench.js)

### `site/trades/` (10 artifacts)
- **Purpose**: Trade builder with asset selection, salary limits, extension calcs, multi-team offers
- **Key Files**:
  - `trade_workbench.js` (245 KB) — Main trade builder
  - `trade_workbench.css` (40 KB) — Interactive UI
  - `trade_workbench.html` (11.7 KB) — HTML host
  - `mfl_hpm_embed_loader.js` — Context loader
- **Data**: `trade_workbench_sample.json` (13 KB), trade offers JSON (~100-300 KB each by league/year)
- **Storage**: localStorage with `ups-trade-workbench-state-v9` prefix
- **Last Modified**: 2026-04-22 (trade_workbench.js)

### `site/rookies/` (16 artifacts)
- **Purpose**: Rookie draft analytics — tier outcomes, historical picks, AP/EP analysis
- **Key Files**:
  - `rookie_draft_hub.js` (182 KB) — State machine + renderers; tier definitions hardcoded
  - `rookie_draft_hub.css` (16 KB) — UI styling
  - `rookie_draft_hub.html` (22 KB) — Host page
  - `mfl_hpm_embed_loader.js` — Context loader
- **Data**: 
  - `rookie_draft_history.json` (2.5 MB) — Full draft history
  - `rookie_draft_tiers.json` (39 KB) — Tier definitions + examples
  - `rookie_draft_hub_2026.json` (21 KB) — Current draft state
  - `rookie_prospects_2026.json` (64 KB) — Prospect list
  - `rookie_ap_vs_ep.json` (144 KB) — Actual vs Expected performance
  - `rookie_draft_team_tendencies.json` (49 KB) — Historical picking patterns
  - `rookie_draft_day_trades.json` (257 KB) — Draft day trade history
  - `rookie_future_picks.json` (34 KB) — Future draft capital
- **Version Tracking**: `VERSION.json`, `CHANGELOG.md`
- **Data Quality**: `_extension_audit_anomalies.csv`, `_unmatched_rookies.csv`, `rookie_cohort_outcomes.csv`, `rookie_extension_followthrough.csv`
- **Last Modified**: 2026-04-23 (rookie_draft_hub.js); 2026-04-21 (data files)

### `site/standings/` (20 artifacts)
- **Purpose**: Historical standings snapshots by league and season (2010-2026)
- **Key File**: `mfl_hpm_standings.html` (99 KB) — Large iframe host
- **Data**: `standings_<league>_<year>.json` — 20 files covering:
  - League 74598: 2017-2026 (10 years)
  - Other leagues (60671, 29015, 40832, 27191, 42721, 30590, 25625): scattered years
- **Observation**: Heavily weighted to league 74598; older leagues have single snapshots
- **Last Modified**: 2026-02-24 (html file); data unchanged

### `site/stats_workbench/` (3 artifacts)
- **Purpose**: Stats analytics interface
- **Key File**: `stats_workbench.html` (141 KB, 2026-04-25) — Very recently updated
- **Last Modified**: 2026-04-25 (newest in entire site directory)

### `site/acquisition/` (13 artifacts)
- **Purpose**: Waiver, free agency, rookie draft acquisition analytics
- **Key Files**:
  - `acquisition_hub.js` (20 KB)
  - `acquisition_hub.html`, `.css`
  - `mfl_hpm_embed_loader.js` — Context loader
  - Modular subdir: `modules/` with `rookie_draft.js`, `waiver_lab.js`, `free_agent_auction.js`, `expired_rookie_auction.js`
  - `lib/refresh_manager.js` — Data polling
- **Data**: 
  - `rookie_draft_history.json` (1.3 MB)
  - `waiver_history.json` (337 KB)
  - `free_agent_auction_history.json` (594 KB)
  - `expired_rookie_history.json` (68 KB)
  - `manifest.json` (324 B)
- **Last Modified**: 2026-03-11 (all files)

### `site/reports/` (27 artifacts)
- **Purpose**: Multi-page reporting hub with player scoring, salary adjustments, contracts, transactions, franchise assets
- **Structure**:
  - `index.html`, `reports.js`, `reports_router.js` — Hub navigation
  - `player_scoring/` (4 files) — Scoring analytics with 2024-2025 data (each 5+ MB)
  - `salary_adjustments/` (15 files) — Salary by year 2012-2026; mismatch audits (2025)
  - `contracts/`, `franchise_assets/`, `historical/`, `transactions/` — Report subpages
- **Massive Data Files**:
  - `player_scoring_2024.json` (5.4 MB)
  - `player_scoring_2025.json` (5.3 MB)
  - `salary_adjustments_2025.json` (266 KB)
  - `salary_adjustments_2023.json` (278 KB)
  - Multiple CSV audit files (165-357 KB)
- **SQL Schemas**: `player_scoring_sql.sql`, `salary_adjustments_sql.sql` (for pipeline reproducibility)
- **Documentation**: `player_scoring_data_dictionary.md`, `salary_adjustments_data_dictionary.md`
- **Last Modified**: 2026-03-09+ (most); some contract CSVs at 2026-02-16

### `site/team_operations/` (3 artifacts)
- **Purpose**: Team franchise management dashboard
- **Files**: `team_operations.js`, `.css`, `mfl_hpm_embed_loader.js`
- **Last Modified**: 2026-04-18

### `site/mcm/` (4 artifacts)
- **Purpose**: Most Coachable Manager voting interface
- **Files**: `mcm_frame.html` (21 KB iframe host), `mcm_votes.json` (105 B), `mcm_nominations.json` (111 B), `mcm_seed.json` (2 KB)
- **Data Size**: Minimal; voting state very compact

### `site/rulebook/` (2 artifacts)
- **Purpose**: League rulebook (two formats)
- **Files**: 
  - `index.html` (1 KB) — intro/landing
  - `ups_v2_rulebook_mobile_preview.html` (89 KB) — full rulebook optimized for mobile
- **Last Modified**: 2026-03-18

### Root-Level Utilities (14 artifacts)
- **loader.js** (23 KB, 2026-04-23) — Central loader: injects link contrast fix, provides `window.is_offseason` global
- **ups_options_widget.js** (58 KB, 2026-04-23) — UOW: countdown timer, bug reporting, Discord integration
- **ups_options_widget.css** (8.9 KB)
- **ups_options_widget.html** (4.1 KB)
- **ups_options_widget_embed_loader.js** (32 KB) — CDN loader for UOW
- **ups_options_widget_schedule_2026.json** (808 B) — Event dates
- **ups_options_widget_latest.js/.json** (41 B, 29 B) — Version aliases
- **ups_issue_report.html** (4.0 KB) — Standalone bug report form
- **mcm_embed_loader.js** (3.8 KB) — MCM context loader
- **champions_panels.json** (4.8 KB) — Recent winners data
- **README.md** (3.3 KB)

---

## Top 10 Most Recently Modified Artifacts

| Date | Type | Artifact |
|------|------|----------|
| 2026-04-25 | html_page | site/stats_workbench/stats_workbench.html |
| 2026-04-24 | html_page | site/hpm-stats-workbench.html |
| 2026-04-23 | loader | site/loader.js |
| 2026-04-23 | js_module | site/rookies/rookie_draft_hub.js |
| 2026-04-23 | js_module | site/rosters/roster_workbench.js |
| 2026-04-23 | loader | site/stats_workbench/mfl_hpm_embed_loader.js |
| 2026-04-22 | css | site/rosters/roster_workbench.css |
| 2026-04-22 | js_module | site/trades/trade_workbench.js |
| 2026-04-21 | loader | site/rookies/mfl_hpm_embed_loader.js |
| 2026-04-21 | json_data | site/rookies/rookie_draft_day_trades.json |

**Observation**: Heavy activity on **stats_workbench**, **rookies**, **rosters**, **trades** modules in last 4 days. This is the active, fast-moving portion of the codebase.

---

## Top 10 Oldest Artifacts (Staleness Risk)

| Date | Type | Artifact |
|------|------|----------|
| 2026-02-16 | image | site/ccc/ccc_contracts.svg |
| 2026-02-16 | js_module | site/ccc/ccc_latest.js |
| 2026-02-16 | json_data | site/ccc/ccc_latest.json |
| 2026-02-16 | json_data | site/ccc/ccc_release_log.json |
| 2026-02-16 | json_data | site/ccc/mym_submissions.json |
| 2026-02-16 | json_data | site/ccc/player_points_history.json |
| 2026-02-16 | json_data | site/ccc/restructure_submissions.json |
| 2026-02-16 | json_data | site/ccc/tag_submissions.json |
| 2026-02-16 | json_data | site/champions_panels.json |
| 2026-02-16 | html_page | site/hpm-default.html |

**Observation**: Almost all **CCC data files haven't changed since 2026-02-16** (initial deploy). This suggests either:
1. State is being written elsewhere (worker backend)
2. These are snapshots and not actively updated
3. Data refresh pipeline isn't committing back to git

---

## Critical Concerns & Anomalies

### 🚨 **1. Hardcoded Release SHA Versions (Release Pinning Risk)**

Multiple HPM pages pin to specific git commits via `window.UPS_*_RELEASE_SHA`:
- `hpm-widget.html`: SHA `59bdd6b` (hardcoded)
- `hpm-standings.html`: SHA `23b2249` (hardcoded)
- `hpm-mcm.html`: `@dev` branch reference (loose)
- `ups_issue_report.html`: SHA `bddc313` (hardcoded, with fallback)

**Risk**: Outdated SHAs point to stale code; no automatic updates to production. Manual SHA update required for bugfixes.

**Recommendation**: Implement a version management strategy (e.g., latest-release aliases, semantic versioning via CDN tags).

---

### 🚨 **2. Franchises & League IDs Hardcoded Throughout**

- **ccc.js**: Franchises 0001-0012 with nicknames hardcoded; commish always 0008
- **roster_workbench.js**: Extension rates, position groups hardcoded
- **trade_workbench.js**: Extension rates, group order hardcoded
- **hpm-standings.html**: League ID hardcoded to `74598`

**Risk**: Expanding league or franchise lineup requires code edits. Franchise 0008 (commish) has special submission privileges in CCC but error-prone if ownership changes.

**Recommendation**: Move to runtime config JSON or query parameters.

---

### 🚨 **3. Stale CCC Data Files (Git Sync Gap)**

CCC data files (`mym_dashboard.json`, `tag_tracking.json`, etc.) last modified **2026-02-16**. But:
- `ccc.js` was updated **2026-04-10** (2 months later)
- User submissions happen regularly (evidence: tag_submissions.json exists)

**Theory**: User submissions → Worker backend → Local tests (not committed). Production data lives in worker storage, not git.

**Risk**: Git inventory doesn't reflect live state. Data quality audits in `_extension_audit_anomalies.csv` (50 KB) suggest known issues.

**Recommendation**: Document data flow: git is source-of-truth for code only, not live state. Add a data snapshot strategy.

---

### 🚨 **4. API Endpoints Tied to Worker URL**

Multiple modules POST to `upsmflproduction.keith-creelman.workers.dev`:
- CCC: `offer-mym`, `offer-restructure`, `commish-contract-update`
- UOW (Bug Reports): Discord integration endpoint
- Roster: `/refresh-mym-json`

**Risk**: Single point of failure (Cloudflare worker). No fallback or graceful degradation.

**Recommendation**: Document worker API contracts; add error handling; consider multi-region or backup worker.

---

### 🚨 **5. LocalStorage State Without Sync**

- `roster_workbench.js`: Stores state in localStorage (`ccc_tag_submissions_v1`, etc.)
- `trade_workbench.js`: Stores in localStorage with prefix `ups-trade-workbench-state-v9`

**Risk**: Cross-device sync not visible. User loses state if browser data clears.

**Recommendation**: Clarify if state is synced to worker backend or purely ephemeral.

---

### 🟡 **6. Massive JSON Files Without Compression**

- `player_scoring_2024.json` (5.4 MB)
- `player_scoring_2025.json` (5.3 MB)
- `rookie_draft_history.json` (2.5 MB in acquisition/; 1.3 MB redundant copy)

**Risk**: Slow page load; CDN bandwidth cost.

**Recommendation**: Gzip on CDN; consider pagination or streaming API instead of full JSON.

---

### 🟡 **7. Duplicate Data (rookie_draft_history)**

`rookie_draft_history.json` exists in **two locations**:
- `site/acquisition/rookie_draft_history.json` (1.3 MB)
- `site/rookies/rookie_draft_history.json` (2.5 MB) — different size

**Risk**: Version skew; unclear which is canonical.

**Recommendation**: Single source-of-truth; use symlinks or import from one canonical path.

---

### 🟡 **8. Inconsistent Loader Pattern**

Some modules use:
- `mfl_hpm_embed_loader.js` (most common, in each subdir)
- `ups_options_widget_embed_loader.js` (separate namespace)
- `mcm_embed_loader.js` (separate file in root)
- `loader.js` (global utility, not an embed loader)

**Risk**: Inconsistent naming makes it hard to trace what's being loaded where.

**Recommendation**: Consolidate on single naming convention (e.g., all `<module>_embed_loader.js`).

---

### 🟡 **9. CSV Audit Files Suggest Data Quality Issues**

- `site/rookies/_extension_audit_anomalies.csv` (50 KB) — Known extension data mismatches
- `site/rookies/_unmatched_rookies.csv` (7.6 KB) — Rookies not matched between data sources
- `site/reports/salary_adjustments/salary_adjustments_2025_derived_vs_mfl_mismatches.csv` (27 KB) — Salary discrepancies
- `site/reports/salary_adjustments/salary_adjustments_2025_derived_vs_mfl_mismatches.json` (86 KB) — Same, in JSON

**Observation**: Deliberate audit trails, not errors. Suggests known data reconciliation challenges.

**Recommendation**: Document the reconciliation process and expected mismatch categories.

---

### 🟡 **10. Version Aliases Very Small (Potential Staleness)**

- `ups_options_widget_latest.js` (41 bytes) — Just a reference
- `ccc_latest.js` (41 bytes) — Just a reference

**Risk**: If these aliases aren't updated with actual releases, they'll become stale.

**Recommendation**: Document release process to ensure aliases are bumped on each deployment.

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Total Artifacts | 174 |
| Total Lines of Code (est.) | ~500K+ (ccc.js=417KB, rookie_draft_hub.js=182KB, trade_workbench.js=245KB, roster_workbench.js=472KB, etc.) |
| Largest JSON | player_scoring_2024.json (5.4 MB) |
| Largest JS Module | roster_workbench.js (472 KB) |
| Largest CSS | roster_workbench.css (52 KB) |
| Oldest File (staleness) | CCC files (2026-02-16, ~71 days old) |
| Newest File (activity) | stats_workbench.html (2026-04-25, today) |
| Subdirectories | 13 (ccc, rosters, trades, rookies, standings, stats_workbench, team_operations, acquisition, reports, mcm, rulebook, mfl/) |
| API Endpoints (External) | 5+ (MFL, worker.upsmflproduction, jsdelivr, rawcdn.githack) |
| Data Pipeline Touched | 27 files in `reports/` with SQL schemas and CSV audits |

---

## Recommendations for Keith's Audit

1. **Clarify data flow**: Is CCC submission data stored in git or in the Cloudflare worker only? How is it synced?
2. **Release management**: Document the process for updating hardcoded SHAs and version aliases.
3. **Deduplication**: Consolidate `rookie_draft_history.json` to a single canonical location.
4. **Compression**: Implement gzip or streaming for >5MB JSON files.
5. **Franchises**: Move hardcoded franchise/league config to a JSON file loadable at runtime.
6. **Embed loader naming**: Unify on single naming convention across all modules.
7. **Data freshness**: Add metadata to JSON files indicating generation time (already present in some: `champions_panels.json`, `rookie_draft_tiers.json`).
8. **Monitoring**: Set up alerts for stale data (e.g., "no CCC updates in 30 days").

---

**End of Summary**
