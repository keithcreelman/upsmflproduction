# Phase 4: Site Data Freshness Register — Findings

**Audit Date:** 2026-04-28  
**Reference Date:** 2026-04-28  
**Branch:** docs/site-audit-v1

---

## Executive Summary

Five critical freshness findings require immediate remediation:

- **MYM Dashboard (52 days stale):** `site/ccc/mym_dashboard.json` last refreshed 2026-03-07, despite hourly GitHub Action configured. Hourly cron may be failing silently — no monitoring alerts. This is active-season data critical to league operations.

- **Acquisition Hub Data (48 days stale):** Four JSON files supporting rookie draft analytics haven't updated since 2026-03-11, despite being scheduled for hourly refresh. All consuming HPMs display outdated acquisition history.

- **Standings (64 days stale):** Manual-refresh only; no automated cadence. Current season standings (2026) are critically stale and could mislead owners about playoff position.

- **Contract Data Fragmentation:** Player points history and acquisition lookup are >49 days stale. Together with MYM dashboard staleness, this creates a 7-week window where contract submissions may be invisible in CCC views.

- **Hardcoded Current Year (2026):** Multiple JS files hardcode the current season as 2026. If the league advances to 2027 without code changes, roster extensions, trade valuations, and rookie draft tiers will silently reference wrong year.

---

## Red Flags

### 1. Stale Cron Jobs (Silent Failure Pattern)

**Finding:**
- `refresh-acquisition-hub.yml` configured: `cron: "15 * * * *"` (every hour at :15)
- `refresh-mym-dashboard.yml` configured: `cron: "20 * * * *"` (every hour at :20)
- **Actual state:** No updates in 48–52 days despite hourly schedule
- **Root cause:** Unknown; no failure monitoring or post-run validation

**Impact:**
- `site/acquisition/rookie_draft_history.json`, `site/ccc/mym_dashboard.json` are >7 weeks stale
- Users viewing CCC submission history see no recent MYM offers
- Rookie draft analytics show pre-March acquisition patterns
- **Silent failure:** Page loads without error; data simply old

**Recommendation:**
1. Check GitHub Actions runner status (secrets, runner availability)
2. Check if `MFL_DB_PATH` / `MFL_COOKIE` secrets are configured and valid
3. Add post-run validation: commit only if new JSON differs from prior commit
4. Add alerting: GitHub Action that checks if `site/ccc/mym_dashboard.json` is >2 hours stale and posts to Discord on failure

---

### 2. Manual-Refresh Data With >30 Days Staleness

**Standings Data:**
- Last modified: 2026-02-24 (64 days ago)
- Writer: `build_standings_snapshot.py` (manual only)
- Severity: Critical — current season standings are incomplete
- Expected cadence: Weekly during regular season, daily during playoffs
- **Gap:** 60+ day gap violates expected weekly cadence

**Player Points History (CCC):**
- Last modified: 2026-02-16 (71 days ago)
- Writer: `build_player_points_history_json.py` (manual only)
- Severity: Critical — CCC extension logic depends on YOY player stats
- Expected cadence: Weekly
- **Gap:** 71 day gap vs. expected weekly

**Roster Acquisition Lookup:**
- Last modified: 2026-03-10 (49 days ago)
- Writer: `build_roster_acquisition_lookup.py` (manual only)
- Severity: Critical — roster workbench shows acquisition history for current squad
- Expected cadence: Weekly
- **Gap:** 49 day gap vs. expected weekly

**Recommendation:**
1. Schedule these scripts into hourly/daily GitHub Actions (not manual only)
2. Add guards: Check if `MFL_COOKIE` is set; skip if not
3. Commit data only if changed (avoid noise)
4. Flag for Keith: Why are these manual? Are they waiting for external events (draft, season start)?

---

### 3. Data Sources That Should Be Daily But Haven't Updated in >30 Days

| Data | Last Modified | Staleness | Expected Cadence | Writer | Status |
|------|---|---|---|---|---|
| Contract Command Center - Tag Tracking | 2026-03-09 | 50 days | weekly | build_tag_tracking.py | manual |
| Reports - Player Scoring 2024/2025 | 2026-03-09 | 50 days | season-static | build_player_scoring_report.py | manual |
| Reports - Salary Adjustments | 2026-03-17 | 42 days | monthly | build_salary_adjustments_report.py | manual |
| MCM - Nominations / Votes / Seed | 2026-02-16 | 71 days | season-static | log_mcm_*.py | on-push (no activity) |
| Champions Panels | 2026-02-16 | 71 days | annual | build_champion_panels_json.py | manual |
| UPS Options Widget Schedule | 2026-02-16 | 71 days | change-driven | manual | manual |

**Root Cause:** Most depend on manual triggers or one-off events. No active push to refresh unless explicitly requested.

**Recommendation:**
- Separate "season-static" (OK to be old) from "should be recent" (needs monitoring)
- Add GitHub Actions for all manual scripts that support automated triggers
- Monitoring: Weekly task that scans `site/` for any JSON modified >30 days ago and alerts

---

### 4. Hardcoded Current Season (2026) — Will Break in 2027

**Locations Found:**

1. **`site/rosters/roster_workbench.js`** (line ~430–450)
   ```javascript
   "2026": {
     contract_deadline: "2026-09-06",
     season_complete: "2026-12-29"
   }
   ```
   Used for: Contract deadline validation, season-end logic
   Risk: When 2027 arrives, will show 2026 deadline indefinitely unless updated

2. **`site/rookies/rookie_draft_hub.js`** (line ~310–320)
   ```javascript
   const target = Date.UTC(2026, 4, 2, 22, 0, 0);  // May 2, 2026 draft
   ```
   Used for: Draft countdown timer
   Risk: Will show "draft passed" after May 2, 2026, or wrong year next May

3. **`site/standings/mfl_hpm_standings.html`** (line ~82–90)
   ```javascript
   const YEAR = Number(safe(u.searchParams.get("YEAR") || "2026")) || 2026;
   ```
   Also in `rookie_draft_hub.html`: `<span class="subtitle">UPS League 74598 · 2026</span>`
   Risk: HTML subtitle will display wrong year after season ends

4. **`site/ccc/mfl_hpm16_contractcommandcenter.html`** (line ~55)
   ```html
   <div id="devNoticeSub">...for the 2026 season...</div>
   ```
   Risk: Will confuse users if left until 2027

5. **`site/ups_options_widget.js`** (line ~45)
   ```javascript
   "2026": { ... schedules for 2026 events ... }
   ```

**Classification:**
- **Legitimate references (seasonal):** Draft countdown (2026-05-02), "May 2, 2026 @ 6:00 PM ET" in rookie_draft_hub.html
- **Bugs (must be fixed):** Hardcoded season year in `roster_workbench.js`, HTML dev notice, default YEAR in standings

**Recommendation:**
1. Remove hardcoded season year from `roster_workbench.js`; use `window.currentSeason` global
2. Update `loader.js` to export a `window.currentSeason` global
3. Remove "2026" dev notice from CCC HTML once go-live is confirmed
4. Audit `/site/**/*.js` for other hardcoded year references

---

### 5. Multiple Writers to Same Output — Undefined Merge Behavior

| Output | Writers | Status | Risk |
|--------|---------|--------|------|
| **D1:contract_forum_export_v3_all** | ingest_contract_logs_2019_2021.py + ingest_discord_contracts.py + load_mym_submissions_2025.py | manual only | Three separate ETL streams; unclear if they append or clobber |
| **site/rookies/rookie_draft_history.json** | rookie_hit_rate_build.py + rookie_extension_followthrough.py | manual only; analytics | Both are analytics scripts; execution order unknown; risk of overwrite |
| **site/trade-value/trade_value_model_2026.json** | pick_valuation.py → trade_grader.py | manual only; sequential dependency | `trade_grader.py` reads output of `pick_valuation.py`; no atomic guarantee |

**Recommendation:**
1. Document execution order explicitly in Phase 5
2. Add version keys to JSON payloads (e.g., `"generated_at": "2026-04-28T14:22:31Z"`)
3. Implement atomicity: Write to temp file, verify, then move to final path
4. Add D1 run log table (`_etl_run_log`) that records start/end time + success/failure for each script

---

### 6. Worker Cron Job (5 * * * *) — Not In GitHub Workflows

**Finding:**
- `worker/wrangler.toml`: `crons = ["5 * * * *"]` (Cloudflare Worker cron, every hour at :05)
- **What does it do?** Unknown — not documented in Phase 2 inventory
- **Where's the trigger logic?** Not in `.github/workflows/` (which are GitHub Actions)

**Impact:** If worker cron is critical and fails, no alert. If it's dormant, unclear.

**Recommendation:**
1. Document what the worker cron (5 * * * *) does in `docs/site_audit/mfl_platform_constraints.md`
2. Add monitoring: Cloudflare dashboard alert if cron doesn't fire or logs errors
3. Verify: Is it overlapping with GitHub Actions crons (:15, :20)? Consider consolidation

---

### 7. Data Quality Audit Artifacts — Existence Suggests Known Issues

**Files Present:**
- `site/rookies/_extension_audit_anomalies.csv` (50 KB) — Known extension data mismatches
- `site/rookies/_unmatched_rookies.csv` (7.6 KB) — Rookies not matched between data sources
- `site/reports/salary_adjustments/salary_adjustments_2025_derived_vs_mfl_mismatches.csv` (27 KB) — Salary discrepancies

**Finding:** Deliberate audit trails, not errors. But their presence indicates ongoing data reconciliation gaps.

**Recommendation:**
1. Document the expected mismatch categories in each file (header comment)
2. Add to monitoring: If a mismatch file grows (>1.5x prior size), alert Keith
3. Clarify ownership: Is this Keith maintaining them, or an automated audit?

---

## Severity-Tagged Findings

### CRITICAL

#### 1. MYM Dashboard Cron Failure (Silent Stale)

**What's affected:**
- CCC submission history view: owners can't see recent MYM offers
- Extension eligibility calculations: rely on fresh contract data
- League operations: restructure/extension decisions made on stale data

**Rule violation:**
- **RULE-EXT-003** (from league_context_v1.md): "Extension eligibility window is determined by contract year and salary…" — stale player points history breaks eligibility logic
- **League integrity:** Owners may submit duplicates thinking prior offer failed

**Current state:**
- `site/ccc/mym_dashboard.json` last modified 2026-03-07 (52 days)
- GitHub Action `refresh-mym-dashboard.yml` configured hourly but not executing
- **No monitoring:** Silent failure; no Discord alert

**Recommended fix:**
1. **Immediate:** Run `pipelines/etl/scripts/refresh_mym_dashboard_from_mfl.py` manually to sync current data
2. **Short-term:** Debug GitHub Actions runner; verify `MFL_COOKIE` secret is set
3. **Long-term:**
   - Add post-run validation: `git diff --quiet` check before commit
   - Add failure monitoring: GitHub Action that checks file mtime every 4 hours; if >2 hours stale, post to Discord
   - Upgrade to every 15 minutes during MYM windows (manually trigger during deadlines)

**Severity:** Critical — Active-season contract data, impacts league decisions

---

#### 2. Standings Data Not Refreshed (Manual Only, 64 Days Stale)

**What's affected:**
- HPM displays outdated league standings
- Playoff seeding calculations (if automated) may read stale data
- Owners misled about actual position

**Current state:**
- `site/standings/standings_74598_2026.json` last modified 2026-02-24 (64 days)
- Writer is `build_standings_snapshot.py` (manual only, no automation)
- No GitHub Action configured

**Expected cadence:** Weekly during regular season, daily during playoffs

**Recommended fix:**
1. Add GitHub Action `refresh-standings.yml`:
   ```yaml
   on:
     schedule:
       - cron: "30 8 * * 1"  # Every Monday at 8:30 AM
   ```
2. During playoffs (Oct–Jan): Increase to daily via workflow_dispatch + manual trigger
3. Add post-run validation: Verify JSON row count hasn't dropped >20%
4. Monitoring: Discord alert if standings JSON not refreshed in 7+ days

**Severity:** Critical — Data integrity + league credibility

---

#### 3. Acquisition Hub Data (Hourly Cron, 48 Days Stale)

**What's affected:**
- Rookie draft analytics HPM shows pre-March data
- Acquisition history is 7 weeks out of date
- Free agent / waiver patterns are stale

**Current state:**
- Four JSON files (rookie_draft_history, waiver_history, free_agent_auction_history, expired_rookie_history)
- GitHub Action `refresh-acquisition-hub.yml` configured: `cron: "15 * * * *"` (hourly)
- **Last successful run:** 2026-03-11 (48 days ago)

**Recommended fix:**
1. **Immediate:** Check GitHub Actions logs to find failure reason
2. **Verify:** `MFL_DB_PATH` secret exists and points to valid DB on runner
3. Add failure monitoring:
   ```bash
   # Post-run validation in workflow
   python -c "import json; json.load(open('site/acquisition/manifest.json'))" || exit 1
   ```
4. Alert on failure: If no commit in 4 hours, post to Discord

**Severity:** Critical — Acquisition analytics are active-season data

---

#### 4. Contract Logging Incomplete (On-Push, 71 Days of No Activity)

**What's affected:**
- CCC submission history (MCM, contract activity) shows only pre-Feb-16 entries
- No record of contract submissions after 2026-02-16
- Audit trail is incomplete

**Current state:**
- Writers: `log_contract_activity.py`, `log_mcm_nomination.py`, `log_mcm_vote.py`, `log_extension_submission.py`, `log_restructure_submission.py` (all on-push)
- Last modified: 2026-02-16 (71 days)
- **Reason:** No push events since then, OR push events don't trigger workflows

**Recommended fix:**
1. Verify webhook configuration: Are `on-push` workflows actually firing?
2. Check worker logs: Does `upsmflproduction.workers.dev/offer-mym` endpoint exist and log submissions?
3. If submissions are being logged elsewhere (e.g., worker backend), add a sync script:
   ```
   pipelines/etl/scripts/sync_mym_submissions_from_worker.py
   ```
4. Add monitoring: If no contract activity recorded in 7 days during season, alert Keith

**Severity:** Critical — League audit trail incomplete

---

#### 5. Early Projection & Auction Model Stale (42–3 Days)

**What's affected:**
- Seasonal projections used by roster workbench, trade grader
- Auction value model (v2) used by trade recommendations
- Salary cap calculations depend on early_projection_* tables

**Current state:**
- `build_early_projection.py`: Last run 2026-03-17 (42 days)
- `build_auction_value_model_v2.py`: Last run 2026-04-25 (3 days)
- Expected cadence: Weekly

**Recommended fix:**
1. Add GitHub Action `refresh-projections.yml`:
   ```yaml
   on:
     schedule:
       - cron: "30 7 * * 1"  # Every Monday 7:30 AM
   ```
2. During draft season: Increase to daily
3. Model inputs (nflverse, Vegas data) should auto-refresh weekly
4. Monitoring: Alert if projection JSON not refreshed in 10 days

**Severity:** Critical — Foundation for trade valuations + salary cap math

---

### LOW

#### 1. Historical Standings (Season-Static OK to Be Old)

**Severity:** Low — These are archived, not current-season data

---

#### 2. Champions Panels (Last Updated 2026-02-16)

**Severity:** Low — Annual data; only needs refresh if a new champion is crowned

---

#### 3. MCM Data (No Activity in 71 Days)

**Severity:** Low — Off-season event; not critical until voting period opens

---

### GRAY (Escalate to Keith)

#### 1. Extension Audit Anomalies CSV

**Finding:** `site/rookies/_extension_audit_anomalies.csv` exists with known mismatches

**Question:** Are these expected (data reconciliation artifacts) or bugs (data quality issues)?

**Recommendation:** Keith to clarify ownership + expected mismatch categories

---

#### 2. Salary Adjustments Mismatch Report

**Finding:** `site/reports/salary_adjustments/salary_adjustments_2025_derived_vs_mfl_mismatches.csv` (27 KB) exists

**Question:** Are these reconciliation notes or actual data bugs?

**Recommendation:** Document expected vs. unexpected mismatches; add alerting if mismatch count grows

---

#### 3. Data In Worker Backend vs. Git

**Finding:** CCC submission data (mym_submissions, restructure_submissions, tag_submissions) last modified 2026-02-16, but user submissions happen regularly

**Question:** Is live submission data stored in the Cloudflare worker only, not committed to git?

**Impact:** Phase 4 freshness register sees stale git dates but live data may exist in worker

**Recommendation:** Document data flow for submissions; clarify if git is source-of-truth for code only

---

#### 4. Worker Cron (5 * * * *) — Undocumented

**Finding:** `worker/wrangler.toml` references `crons = ["5 * * * *"]` but no documentation

**Question:** What does this cron trigger? Is it critical?

**Recommendation:** Add to Phase 5 worker audit; document what it does + how to monitor

---

## Refresh-Cadence Proposal Table

| Data Category | Current Cadence | Proposed Cadence | Rationale |
|---|---|---|---|
| **Standings (current season)** | manual | daily during reg season, 4x daily during playoffs | Live league position affects draft order, playoff seeding |
| **MYM Dashboard** | manual (broken) | hourly | Active-season contract submissions; owners need to see status |
| **Roster Acquisition Lookup** | manual | daily | Roster context changes with free agency + trades |
| **Player Points History** | manual | daily | Extension eligibility depends on YOY stats |
| **Rookie Draft Hub (current year)** | manual | daily during draft window, weekly otherwise | Pre-draft: owners evaluating; post-draft: historical reference |
| **Contract Command Center - Tag Tracking** | manual | weekly during MYM window, monthly otherwise | Active during restructure/extension deadlines |
| **Acquisition Hub (waiver/FA/rookie) ** | hourly (broken) | fixed: hourly + validation | Historical analytics; less urgent than current standings |
| **Trade Value Model** | manual | weekly during trade period, on-demand during busy weeks | Foundation for trade validation; should track market conditions |
| **Salary Adjustments** | manual | monthly or change-driven | Reflects commissioner adjustments; not urgent unless recent change |
| **Rookie Cohort Outcomes** | manual | monthly during draft prep, annually otherwise | Analytics-driven; less urgent |
| **Historical Data (champions, prior seasons)** | manual | annual or change-driven | Reference data; only updates on special events |
| **MCM (voting)** | on-push (dormant) | on-push (resume once voting period opens) | Off-season; activate during voting window |
| **Player ID Crosswalk** | manual | on-demand + caching | Foundational; rarely changes but critical dependency |
| **League Settings** | manual | on-demand at season start | Rarely changes; refresh once at draft prep |
| **NFL Weekly Stats (nflverse)** | manual | weekly during season | Foundation for projections; should auto-pull weekly |
| **Early Projections** | manual | weekly during draft/MYM windows | Used for salary cap + trade valuations |
| **Auction Value Model v2** | manual | weekly during draft period | Critical for trade grading |

---

## Monitoring Proposals

### Tier 1: Critical (Blocks League Operations)

**Implement Now:**

1. **MYM Dashboard Health Check**
   ```
   # GitHub Action: runs every 4 hours during season
   if [mtime of site/ccc/mym_dashboard.json > 2 hours]:
     POST to Discord: ⚠️ MYM Dashboard is stale
   ```

2. **Standings Freshness Alert**
   ```
   # Weekly check
   if [no commit to site/standings/standings_*_2026.json in 7 days]:
     POST to Discord: 🚨 Standings not updated in a week
   ```

3. **Acquisition Hub Validation**
   ```
   # Post-refresh validation in GitHub Action
   python -c "
   import json
   assert json.load(open('site/acquisition/manifest.json'))['count'] > 0
   "
   # On failure: post to Discord + retry with MFL API fallback
   ```

4. **Data Freshness Dashboard (D1 table)**
   ```sql
   CREATE TABLE _etl_run_log (
     script_name TEXT,
     scheduled_time DATETIME,
     actual_start DATETIME,
     actual_end DATETIME,
     status TEXT,  -- 'success', 'failure', 'skipped'
     output_path TEXT,
     output_row_count INT,
     prior_row_count INT,  -- for anomaly detection
     error_message TEXT
   );
   ```
   Query daily: `SELECT * FROM _etl_run_log WHERE status = 'failure' OR abs(output_row_count - prior_row_count) > 20%`

---

### Tier 2: Important (Weekly Cadence)

1. **Manual Refresh Reminder**
   ```
   # Weekly scan of site/
   for json in site/**/*.json:
     mtime_days = (now - mtime).days
     if mtime_days > max_expected[json]:
       POST to Discord: 📋 [json] is [mtime_days] days old
   ```

2. **Stale Script Detection**
   ```
   # Check git log for scripts in pipelines/etl/scripts/
   for script in *.py:
     if last_commit > 60 days AND script is not in deprecated_list:
       POST to Discord: 📝 [script] last touched [N] days ago
   ```

3. **Version Alias Staleness**
   ```
   # Check if ccc_latest.js, ups_options_widget_latest.js point to valid versions
   if [checksum(ccc_latest.js) == checksum(last_release)]:
     OK
   else:
     POST to Discord: ⚠️ CCC version alias is stale
   ```

---

### Tier 3: Nice-to-Have (Monthly)

1. **Hardcoded Year Scan**
   ```bash
   grep -r "202[4-9]" site/**/*.js | grep -v "\.min\." | grep -v "date\|comment"
   # Manual review monthly
   ```

2. **Data Quality Audit Report**
   ```sql
   SELECT file_path, row_count, anomaly_count
   FROM _data_quality_log
   WHERE anomaly_count > prior_month_avg * 1.5
   ORDER BY anomaly_count DESC;
   ```

---

## Implementation Roadmap

### Immediate (Next 2 Days)

- [ ] Debug `refresh-mym-dashboard.yml` GitHub Action — check runner logs, secrets
- [ ] Debug `refresh-acquisition-hub.yml` — same
- [ ] Run `build_standings_snapshot.py` manually to sync current standings
- [ ] Run `build_player_points_history_json.py` manually to sync CCC player data
- [ ] Post findings to Discord with links to this report

### Short-Term (Next Week)

- [ ] Create GitHub Action `refresh-standings.yml` (daily)
- [ ] Create GitHub Action `refresh-projections.yml` (weekly)
- [ ] Add post-run validation to existing workflows (JSON integrity checks)
- [ ] Set up Discord webhooks for failure alerts
- [ ] Create `_etl_run_log` D1 table + logging in key scripts

### Medium-Term (Next Month)

- [ ] Consolidate cron schedules (currently :05, :15, :20 overlapping)
- [ ] Document worker cron job (5 * * * *)
- [ ] Remove hardcoded year references from `roster_workbench.js` + others
- [ ] Add `window.currentSeason` global to `loader.js`
- [ ] Implement weekly freshness scan (Tier 2 monitoring above)
- [ ] Archive deprecated ETL scripts

### Long-Term (Phase 5)

- [ ] Build centralized data lineage DAG (input → script → output)
- [ ] Implement atomic writes (temp file → rename)
- [ ] Add retry + exponential backoff for MFL API calls
- [ ] Document worker data submission flow (CCC → worker → git)
- [ ] Consolidate embed loaders (currently 5+ different patterns)

---

## Conclusion

**Data Staleness Risk:** Current state has **3 critical-severity gaps** (MYM dashboard, standings, early projections) + **2 architectural weaknesses** (hardcoded years, silent cron failures). The league site displays stale data for contract management and draft analytics without user awareness.

**Keith's Directive ("Data always needs to be up to date"):** Not currently satisfied. Most user-facing data sources haven't updated in 30–71 days. Root causes are:
1. Cron jobs running but failing silently (no monitoring)
2. Manual-only scripts with no automation trigger
3. No post-run validation (data can be stale but commit anyway)

**Path Forward:** Implement Tier 1 monitoring immediately (2 days) + upgrade failing crons to hourly + add GitHub Actions for manual scripts (1 week) + consolidate cron schedule (2 weeks). See roadmap above for full implementation plan.

---

**Audit Lead:** Phase 4 Data Freshness Register  
**Generated:** 2026-04-28  
**Status:** Ready for review + implementation

