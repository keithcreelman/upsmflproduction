# ETL Pipeline Inventory Summary
**Phase 2C: Comprehensive Site Audit**  
**Generated:** 2026-04-28

---

## Executive Summary

This inventory catalogues **84 ETL and analytics scripts** across the upsmflproduction codebase. The ETL pipeline ingests data from multiple sources (MFL API, nflverse, Vegas lines, local D1 tables) and outputs JSON artifacts for consumption by ~50 HPM/page views, plus D1 tables for cross-script dependency.

**Key Findings:**
- **14 deprecated scripts** (wrappers, one-offs, repairs) — candidates for removal
- **4 outputs with multiple writers** — potential race conditions or ordering dependencies
- **2 active cron jobs** running hourly — likely high-importance
- **6 on-push GitHub Actions** — logging workflows (atomic event capture)
- **44 scripts untouched >30 days** — may be latent or auto-triggered elsewhere
- **6 large-scale scripts** consuming nflverse/Vegas/PFR APIs — critical for projections & valuations

---

## Scripts by Directory

| Directory | Count | Role |
|-----------|-------|------|
| `pipelines/etl/scripts/` | 79 | Core ETL: MFL→D1, data enrichment, JSON outputs |
| `pipelines/analytics/` | 4 | Post-hoc analysis: stickiness, rookie hit rates |
| `scripts/` | 1 | Legacy: D1 bulk loader |

---

## Schedule Breakdown

| Schedule Type | Count | Scripts |
|---------------|-------|---------|
| **Manual** (on-demand) | 76 | Most ETL scripts, analysis scripts |
| **On-push** (GitHub Actions) | 6 | Contract/MYM/extension logging, MCM voting |
| **Cron: 15 * * * *** | 1 | `build_acquisition_hub_artifacts.py` (hourly) |
| **Cron: 20 * * * *** | 1 | `refresh_mym_dashboard_from_mfl.py` (hourly) |

### Active Automated Runs

**Hourly (Both run every hour):**
- `pipelines/etl/scripts/build_acquisition_hub_artifacts.py` — Rookie draft + acquisition data refresh
- `pipelines/etl/scripts/refresh_mym_dashboard_from_mfl.py` — MYM submission dashboard sync

**On-Push (Triggered by GitHub webhooks):**
- `log_contract_activity.py` — Record contract submissions
- `log_extension_submission.py` — Record extension submissions
- `log_mcm_nomination.py` — Record MCM nominations
- `log_mcm_vote.py` — Record MCM votes
- `log_mym_submission.py` — Record MYM submissions
- `log_restructure_submission.py` — Record restructure submissions

**Manual (Developer-initiated, or orchestrated externally):**
- Remaining 76 scripts — typically run in dependency order locally or via CI/CD triggers

---

## Runtime Estimates

| Size | Count | Purpose | Examples |
|------|-------|---------|----------|
| **Small** | 7 | Wrappers, simple utilities | `build_adp_auction_value_model.py` (wrapper) |
| **Medium** | 61 | Majority; moderate D1 ops, some API calls | Most build/fetch scripts |
| **Large** | 16 | Heavy nflverse/Vegas/PFR parsing, multi-table outputs | `fetch_nflverse_weekly.py`, `build_early_projection.py` |

---

## Outputs with Multiple Writers

⚠️ **CRITICAL:** These outputs are written by multiple scripts. **Verify execution order** to ensure atomicity and prevent race conditions:

### 1. **D1:contract_forum_export_v3_all** (3 writers)
   - `ingest_contract_logs_2019_2021.py` — Historical contract logs (2019–2021)
   - `ingest_discord_contracts.py` — Discord-sourced contracts
   - `load_mym_submissions_2025.py` — MYM submissions

   **Status:** Three separate ingestion streams. Confirm these don't race during hourly refreshes.

### 2. **D1:player_id_crosswalk** (2 writers)
   - `build_player_id_crosswalk.py` — Initial MFL→nflverse gsis_id mapping
   - `patch_qb_crosswalk_gaps.py` — Backfill missing QB entries

   **Status:** `patch_qb_crosswalk_gaps` runs *after* `build_player_id_crosswalk` (dependency).

### 3. **site/rookies/rookie_draft_history.json** (2 writers)
   - `pipelines/analytics/rookie_extension_followthrough.py`
   - `pipelines/analytics/rookie_hit_rate_build.py`

   **Status:** Both analytics scripts; execution order unclear. Risk of overwrite.

### 4. **site/trade-value/trade_value_model_2026.json** (2 writers)
   - `pick_valuation.py` — Trade value model
   - `trade_grader.py` — Trade grader (reads model + generates output)

   **Status:** `trade_grader.py` *depends on* output of `pick_valuation.py`? Verify flow.

---

## Deprecated & One-Off Scripts

**Count: 14** — These are candidates for cleanup/archival:

### Backward-Compatible Wrappers (5)
These redirect calls to renamed scripts. Safe to remove if callers updated:
- `build_adp_auction_value_model.py` → `build_auction_value_model.py`
- `build_early_projection_2026.py` → `build_early_projection.py`
- `extract_discord_contracts.py` → `ingest_discord_contracts.py`
- `load_2025_mym_into_v3.py` → `load_mym_submissions_2025.py`
- `load_contract_logs_2019_2021.py` → `ingest_contract_logs_2019_2021.py`
- `migrate_contracts_xml_legacy.py` → `migrate_legacy_contract_xml.py`

### One-Off Maintenance Scripts (5)
One-time backfills or repairs — unlikely to rerun:
- `backfill_mym_submissions_from_dashboard.py` (last: 2026-02-16)
- `backfill_pass_sacks.py` (last: 2026-04-26)
- `backfill_playoff_weeks_allteams.py` (last: 2026-04-21)
- `repair_extension_previews_from_current_extensions.py` (last: 2026-03-07)
- `repair_mym_dashboard_extension_eligibility.py` (last: 2026-03-07)
- `repair_rosters_current_rollforward.py` (last: 2026-03-07)

### Legacy/Test Scripts (3)
- `migrate_legacy_contract_xml.py` — Migrates old XML contracts
- `regression_test_breakaway.py` — Test suite (no output)
- `patch_qb_crosswalk_gaps.py` — Manual patch utility (untouched since first commit)

**Recommendation:** Archive these to `archive/` subdirectory and update any CI references.

---

## Stale Scripts (>30 Days Untouched)

**Count: 44 scripts** last modified before 2026-03-29 (>30 days):

### Scripts with No Last-Commit Data (Likely Never Committed)
- `analyze_breakaway_signal.py`
- `build_2026_auction_sheet.py`
- `build_adp_consensus.py`
- `fetch_coaching_changes.py`
- `fetch_nflverse_breakaway.py`
- `fetch_nflverse_ff_opportunity.py`
- `fetch_nflverse_pbp_advanced.py`
- `fetch_vegas_team_totals.py`
- `patch_qb_crosswalk_gaps.py`
- `target_breakaway_picks.py`
- All 4 `pipelines/analytics/*.py` scripts

**Action:** Verify these are actively used. If outputs exist in `site/`, they're generating data. Consider:
1. Add to CI/CD so commits touch them regularly, OR
2. Document as "latent" (manually triggered) in this inventory

### Scripts Touched Only on 2026-02-16 (Team members on-board baseline)
These are stable, unlikely to need updates unless requirements change:
- `build_champion_panels_json.py`
- `build_player_points_history_json.py`
- `build_tag_submissions_json.py`
- Contract ingest scripts
- MYM/restructure submission loggers
- 11 others

---

## Top 5 Scripts by Output Complexity

These produce the most outputs or D1 tables and likely have the deepest dependencies:

| # | Script | Outputs | Purpose |
|---|--------|---------|---------|
| 1 | `build_early_projection.py` | 6 D1 tables | Early season projection pool: ADP, auction values, cap, team-level summaries |
| 2 | `rookie_hit_rate_build.py` (analytics) | 5 JSON + CSV | Rookie draft hit-rate analysis across multiple phases |
| 3 | `rookie_extension_followthrough.py` (analytics) | 3 JSON + CSV | Y4–Y5 follow-through metrics for drafted rookies |
| 4 | `build_player_id_crosswalk.py` | 2 (D1 + CSV) | MFL→nflverse→PFR mapping (downstream dependency for all player analyses) |
| 5 | `fetch_league_settings.py` | 2 D1 tables | Historical league config & starter settings (foundational) |

**Impact:** Failures in rows 1, 4, 5 cascade to downstream scripts. These should have alerting.

---

## Known Auction Model Status

### Keith's Flag: `build_auction_value_model_v2.py` Supersedes v1

**Status:** `build_auction_value_model_v2.py` (last: 2026-04-25) is the current production model.

**Reads:**
- `auction_player_value_model_v1` (from `build_auction_value_model.py`)
- Advanced datasets: `nfl_player_ff_opportunity_season`, `nfl_team_vegas_weekly`, `nfl_team_pbp_season`, `yoy_player_signals`

**Writes:**
- `auction_player_value_model_v2` (adds signal-layer modifiers)

**Key Details:**
- Era-aware (SF/TE-premium started 2022)
- Tier-aware compression curves
- Regime-based multipliers (4 QB tiers in 2026)
- Signal modifiers: FPOE per game, Vegas implied totals, team PROE, age curves
- Capped to [0.65, 1.20] to prevent compounding errors

**v1 Status:** `build_auction_value_model.py` still runs but is input to v2. Check if v1 is still needed for legacy views.

---

## Input Data Sources

All scripts ingest from:
1. **D1 (SQLite Database)** — MFL exports, nflverse data, computed tables
2. **MFL API** — Real-time league state (franchises, rosters, transactions, salaries)
3. **nflverse (GitHub releases)** — PBP, weekly stats, schedules, snapshots
4. **Pro Football Reference (PFR)** — Advanced receiving/rushing stats
5. **Vegas Lines API** — Weekly implied totals, spreads
6. **Local CSV/JSON** — Historical fixtures (e.g., legacy contracts, MYM submissions)

### Critical Dependency Chain
```
MFL API + nflverse weekly stats
  ↓
fetch_nflverse_weekly.py, fetch_nflverse_pbp.py, fetch_pfr_*.py
  ↓
D1 tables (nfl_player_weekly, nfl_team_pbp_season, nfl_player_advstats_season, etc.)
  ↓
build_early_projection.py, build_auction_value_model_v2.py
  ↓
site/*.json outputs consumed by HPMs
```

---

## Output Paths (Summary)

### JSON Artifacts (HPM-consumed)
- `site/acquisition/` — Rookie draft hub, acquisition lookups
- `site/ccc/` — Contract submissions, MYM submissions, restructure submissions, extension submissions
- `site/mcm/` — MCM nominations, votes
- `site/rosters/` — Contract activity logs, roster snapshots
- `site/trade-value/` — Trade value models
- `site/rookies/` — Rookie draft history, hit-rate matrices
- `site/reports/` — Player scoring reports, salary adjustment reports
- (And 20+ others)

### D1 Tables (Internal)
- `league_years`, `metadata_*` — League configuration
- `early_projection_*` — Season projections (6 tables)
- `auction_player_value_model_v1`, `auction_player_value_model_v2` — Valuation models
- `nfl_player_*`, `nfl_team_*` — Advanced NFL stats (14+ tables from nflverse)
- `contract_*`, `extension_*`, `restructure_*`, `mym_*` — User submissions
- `yoy_player_signals`, `tag_tracking`, `salary_adjustments_feed` — Derived player/team metrics

---

## Failure Modes & Alerting

**Current Status:** Most scripts have no explicit alerting. Failure manifests as:
1. **Stale JSON in site/** — HPMs display old data until next refresh
2. **Missing D1 tables** — Downstream scripts error or skip
3. **Partial outputs** — No transaction/atomicity guarantees (some write JSON, some write D1)

**Recommendations:**
1. Log ETL run timestamps and status to D1 (`_etl_run_log` table?)
2. Add post-run validation: Compare output row counts to previous run
3. Alert on missing outputs (e.g., if `site/acquisition/*.json` not refreshed in 2 hours)
4. Monitor cron job completion (GitHub Actions logs + external alerting)

---

## Full Inventory

Detailed metadata for all 84 scripts in:
```
_inventory_etl.csv
```

Columns:
- `script_path` — Relative path from repo root
- `purpose` — First docstring line
- `inputs` — Data sources (generic; see source for specifics)
- `outputs` — Generated JSON, CSV, D1 tables
- `schedule` — Cron, on-push, manual
- `last_modified` — Last Git commit date
- `runtime_estimate` — Small/medium/large based on complexity
- `notes` — Deprecation, wrapper status, etc.

---

## Next Steps

1. **Verify Multi-Writer Outputs** — Confirm atomicity and execution order
2. **Archive Deprecated Scripts** — Move 14 scripts to `archive/` if no active callers
3. **Reconcile Stale Scripts** — Confirm which are latent vs. broken
4. **Document Dependencies** — Build a DAG (directed acyclic graph) of script execution order
5. **Implement Alerting** — Monitor hourly cron jobs + key ETL runs
6. **Validate Auction Model Transition** — Confirm v2 fully supersedes v1 in all HPMs

---

**Audit Lead:** Phase 2C Site Audit  
**Branch:** `docs/site-audit-v1`  
**Status:** Ready for review
