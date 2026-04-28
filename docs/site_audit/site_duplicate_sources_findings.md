# Phase 5 Site Audit: Duplicate Sources of Truth — Findings Report

**Generated:** 2026-04-28  
**Branch:** `docs/site-audit-v1`  
**Audit Lead:** File Search Specialist (Haiku 4.5)  
**Status:** Complete analysis; 26 cases cataloged

---

## Executive Summary

The codebase exhibits **26 distinct duplicate-source cases** where the same fact, model, or data point has multiple "versions of truth" scattered across:
- Git-committed JSON snapshots (`site/` directory)
- D1 database tables
- Hardcoded constants in JavaScript and Python
- Worker endpoint parameters
- Rules documentation (rulebook JSON, memory files, inline comments)
- ETL script outputs and caches

**Key Finding:** Keith's directive "No multiple sources of truth" is currently violated at critical layers:
1. **Rules & configuration** — scattered across rulebook.json, code, memory file (v14 has 500+ lines of corrections)
2. **League ID & franchise config** — hardcoded in site/*.html, defaulted in pipelines/*.py, dynamic in worker
3. **Rookie contract data** — two writers, two paths, different sizes
4. **Cap math** — reimplemented in site/*, worker/*, and pipelines/*
5. **Tag system** — code-embedded logic + JSON snapshots
6. **Player identifiers** — multiple crosswalks (D1 table, CSV cache, JSON cache, JSON model fields)

**Risk Level:** **CRITICAL** for league functionality; **HIGH** for maintenance burden and drift.

---

## Top 5 Highest-Priority Consolidations

Ranked by **severity × consumer_count** (impact × breadth):

### **1. DUP-002: League ID Hardcoding (Severity: Critical, Consumers: 15)**

**The Problem:**
- `site/hpm-standings.html` hardcodes `data-standings-source-league-id=74598`
- Multiple site/*.js files hardcode league ID or rely on global undefined
- pipelines/etl/scripts default to `--league-id 74598` (good)
- Worker reads from environment variable `LEAGUE_ID` (good)
- **Mismatch:** If league expands or runs on different league ID, all site code breaks

**Why It's Critical:**
- Affects **ALL league-aware HPM pages** (standings, rosters, trades, rookies, reports)
- Expansion to other leagues would require code edits (violates principle of configuration)
- **Current risk:** hardcoded 74598 will cause outages if league ID ever changes

**Estimated Lift:** 2–3 days
- Identify all hardcoded values (done: ~15 locations)
- Create `window.UPS_LEAGUE_ID` global in site/loader.js
- Replace all hardcoded references
- Verify worker injects header/param
- Test with alternate league ID

**Blockers:** None — ready to start

---

### **2. DUP-004: Rules Text (Severity: Critical, Consumers: 8)**

**The Problem:**
- `services/rulebook/data/rules.json` is v2024.2 dated 2026-02-14 (stale)
- Memory file `league_rules_2026_corrections.md` contains v14 audit: 500+ lines of corrections
  - TCV immutability rules
  - Earning milestones (Oct 1 vs Sep 30 bug in code)
  - Tag eligibility edge cases
  - Cap floor/ceiling applicability
  - WW-Rookie distinction
  - TE Premium era (2025, NOT 2022)
  - Calvin Johnson Rule Tier-1 definitions
- Inline rule strings in site/ccc/*.js and worker/src/index.js
- docs/league_context_v1.md (may be stale)

**Why It's Critical:**
- Cap penalties, contract extensions, MYM limits, tag eligibility all depend on rules
- Code contains bugs: e.g., `build_contract_history_snapshots.py` uses Sep 30 milestone instead of Oct 1 (v11 audit confirms this)
- **Drift risk:** Rules change in Discord/Keith's docs; code doesn't update; league operates on different rule set than source-of-truth

**Estimated Lift:** 3–5 days
1. Rebuild `services/rulebook/data/rules.json` from memory/league_rules_2026_corrections.md v14 (most authoritative)
2. Create D1:mfl_league_rules table (season, rule_code, rule_value)
3. Remove inline rule constants from code; call /api/league-rules endpoint
4. Add regression tests: validate code against rule values

**Blockers:** Keith decision on which sections to backport to rules.json; rule API endpoint stability

---

### **3. DUP-013: Cap Math Implementations (Severity: Critical, Consumers: 8)**

**The Problem:**
- site/rosters/roster_workbench.js implements cap penalty logic (in-page)
- site/trades/trade_workbench.js implements cap-available calculation
- worker/src/index.js implements cap penalty scan + MYM validation
- pipelines/etl/scripts/build_contract_history_snapshots.py implements earning prorating

**Specific Bug Found:**
- `build_contract_history_snapshots.py` prorate_earned_for_drop uses milestones `[Sep 30, Oct 31, Nov 30, season_end]`
- **Should be:** `[Oct 1, Nov 1, Dec 1, season_end]` (per memory v11)
- **Impact:** Grants 25% earning at Sep 30 (preseason), which is wrong; code is more lenient than canonical rule by one milestone

**Why It's Critical:**
- **League integrity:** Incorrect cap math can cause roster violations undetected
- **Consistency:** Two owners cutting same player on same date may see different penalties depending on which tool they use
- **Audit trail:** Real-time calculations (site/worker) vs. historical snapshots (pipelines) may diverge

**Estimated Lift:** 4–6 days
1. Canonicalize cap formula: D1 table with per-contract-type calculations
2. Create worker endpoint: POST /api/cap-calculation/penalty with contract history → penalty
3. Replace all inline cap math with API calls
4. Fix Sep 30 → Oct 1 bug in build_contract_history_snapshots.py
5. Add regression tests: validate API against historical cuts

**Blockers:** Formula canonicalization (TCV immutability, earning milestones); regression test data

---

### **4. DUP-001: Rookie Draft History (Severity: Critical, Consumers: 4)**

**The Problem:**
- `site/acquisition/rookie_draft_history.json` (1.3 MB)
- `site/rookies/rookie_draft_history.json` (2.5 MB)
- **Different sizes** → different schemas or refresh cadences
- Multiple writers: `build_rookie_draft_hub.py`, `rookie_extension_followthrough.py`, `rookie_hit_rate_build.py`
- Consumers: acquisition_hub.js (reads acquisition/*), rookie_draft.js (reads rookies/*)

**Why It's Critical:**
- **Version skew risk:** One file gets updated, the other doesn't; HPM pages show inconsistent draft history
- **Schema drift:** Different sizes suggest different enrichment layers
- **Multiple writers to rookies/ path:** execution order unclear; risk of race condition if build_rookie_draft_hub.py and analytics scripts run concurrently

**Estimated Lift:** 1–2 days
1. Verify writers: which scripts write to each path?
2. Consolidate to single canonical: site/rookies/rookie_draft_history.json
3. Update acquisition_hub.js to read from rookies/
4. Update build_acquisition_hub_artifacts.py to copy/symlink from canonical
5. Delete site/acquisition/rookie_draft_history.json from git

**Blockers:** Both writers verified (done); storage strategy documented (done)

---

### **5. DUP-007: Embed Loaders (Severity: Low, Consumers: 24)**

**The Problem:**
- 13 embed loader files across site/:
  - `mfl_hpm_embed_loader.js` in 10 subdirectories (ccc, acquisition, rosters, trades, rookies, standings, reports, stats_workbench, team_operations, rosters)
  - `mcm_embed_loader.js` (separate)
  - `ups_options_widget_embed_loader.js` in two locations (root duplicate)
  - `site/loader.js` (global utility, different purpose)

**Why It's Low Priority:**
- Cosmetic pattern consistency issue
- No functional impact (each loader works independently)
- Low risk of divergence (loaders are mostly static)

**Estimated Lift:** 1–2 days
1. Audit 10 mfl_hpm_embed_loader.js files for functional differences
2. Create canonical site/embed_loader_mfl_hpm.js
3. Replace subdir loaders with import from canonical
4. Consolidate mcm_embed_loader.js into shared loader
5. Remove ups_options_widget_embed_loader.js root duplicate

**Blockers:** Code review for functional equivalence (should be trivial)

---

## Cluster Analysis: Grouped by Domain

### **Rules & Configuration (6 cases: DUP-004, DUP-010, DUP-012, DUP-014, DUP-023, DUP-025)**

**Common Pattern:** Rules live in multiple places (JSON, code, memory); changes aren't synchronized.

| Case | Source | Issue | Fix Strategy |
|------|--------|-------|---|
| **DUP-004** | rules.json vs. memory v14 | Rulebook stale (v2024.2), corrections in v14 | Rebuild rules.json from v14; add D1 table + API endpoint |
| **DUP-010** | ccc.js hardcoded franchises | Expansion requires code edit | Extract to site/ccc/franchises.json; load at runtime from /api endpoint |
| **DUP-012** | Rules in code vs. JSON | Constants scattered in site/*.js, worker/*.js | Create D1:mfl_league_rules; fetch from /api/league-rules |
| **DUP-014** | Tag logic in code + JSON | tag_tracking.json is cache; logic in worker | Move tag-eligibility logic to /api/tags/eligible endpoint |
| **DUP-023** | Auction model era definition | SF_ERA_START=2022 conflates SF+TE Premium | Split 3 eras: PRE_SF, SF_ONLY, SF_TE_PREM; recalibrate |
| **DUP-025** | Rookie salary hardcoded | site/, pipelines/, memory all have tiers | Create D1:rookie_salary_tiers; fetch from /api endpoint |

**Consolidation Strategy:** Single D1:mfl_league_rules table + worker /api/league-rules endpoint; deprecate inline constants.

---

### **Contract Data Layer (6 cases: DUP-008, DUP-018, DUP-019, DUP-020, DUP-021, DUP-022)**

**Common Pattern:** Submissions (MYM, restructure, extension, tag) logged to multiple places (D1, site/ccc/*.json, GitHub dispatch).

| Case | Data Path | Writers | Issue |
|------|-----------|---------|-------|
| **DUP-008** | D1:contract_forum_export_v3_all | 3 writers (Discord, Legacy logs 2019-2021, MYM 2025) | Race condition risk; execution order unclear |
| **DUP-018** | site/ccc/mym_submissions.json | GitHub dispatch → worker → JSON | Last modified 2026-02-16; unclear if live updates exist |
| **DUP-019** | site/ccc/extension_submissions.json | Similar to DUP-018 | Not updated since 2026-02-16 |
| **DUP-020** | site/ccc/restructure_submissions.json | Similar to DUP-018 | Not updated since 2026-02-16 |
| **DUP-021** | contract_history_*.csv | Multiple scripts + snapshots | Unclear if git snapshot or live; HPM consumer unknown |
| **DUP-022** | site/ccc/tag_submissions.json | No D1 mirror; not consolidated to v3_all | If tagging is live, submissions aren't logged |

**Consolidation Strategy:** All submissions → D1:contract_forum_export_v3_all via unified path; add submission_type field; make site/ccc/*.json READ-ONLY caches refreshed on demand.

---

### **Data Layers: Git Snapshots vs. Live (5 cases: DUP-015, DUP-016, DUP-017, DUP-024, DUP-026)**

**Common Pattern:** Large JSON files committed to git; unclear if they're refreshed or frozen snapshots.

| Case | Data | Size | Last Modified | Issue |
|------|------|------|---|---|
| **DUP-015** | site/standings/*.json | 20 files | 2026-02-24 | Unclear if live-updated or EOY snapshots |
| **DUP-016** | site/reports/salary_adjustments/*.json | Multi-year | Last refresh date TBD | Audit CSV flags mismatches; scope unclear |
| **DUP-017** | site/reports/player_scoring/*.json | 2024 (5.4MB), 2025 (5.3MB) | 2026-03-09 | Frozen EOY snapshots or live-updated? |
| **DUP-024** | site/rosters/*.js hardcoded settings | Embedded | Per-code-update | Position groups, caps, lineups hardcoded |
| **DUP-026** | site/rosters/player_acquisition_lookup_2026.json | ~116 KB | 2026-03-10 | Snapshot or live? Player lineage scattered across sources |

**Consolidation Strategy:** Document which are snapshots vs. live; move live data to R2 bucket + cron refresh; keep site/ as symbolic links or API endpoints.

---

### **Calculated Models: Pipeline Dependencies (3 cases: DUP-006, DUP-011, DUP-023)**

**Common Pattern:** Multi-stage pipelines where output of one script feeds input to another; execution order impacts downstream freshness.

| Case | Pipeline | Dependency | Issue |
|------|----------|-----------|-------|
| **DUP-006** | build_auction_value_model.py → build_auction_value_model_v2.py | v2 reads v1 as input | Unclear if v1 persists as artifact or is purely v2 input |
| **DUP-011** | pick_valuation.py → trade_grader.py / build_rookie_draft_hub.py | pick_valuation writes site/trade_value_model_2026.json | Consumers depend on freshness; race condition if concurrent |
| **DUP-023** | historical auction data → build_auction_value_model_v2.py (era-aware) | Auction model reads era definitions | SF era (2022) conflated with TE Premium era (2025); recalibration needed |

**Consolidation Strategy:** Document explicit DAG (directed acyclic graph) of script execution order; add metadata timestamps to outputs; validate freshness before consumer use.

---

## Risks and Gotchas

### 🚨 **High-Impact Risks**

1. **Cap Math Divergence (DUP-013):**
   - Real-time calculations (site/worker) may differ from historical audit (pipelines)
   - Bug in build_contract_history_snapshots.py grants 25% earning at Sep 30 (should be Oct 1)
   - **Outcome:** Owner disputes cap penalties; audit trail doesn't match real-time calculation
   - **Mitigation:** Fix earning milestone; create regression tests

2. **Rules Drift (DUP-004):**
   - Keith maintains v14 corrections in memory file (500+ lines)
   - rules.json hasn't been updated since 2026-02-14
   - Code logic (MYM limits, loaded caps) is hardcoded constants from unknown source
   - **Outcome:** New rule changes implemented in Discord/Keith's doc; code doesn't reflect them; league operates on two rule sets
   - **Mitigation:** Rebuild rules.json from v14; add D1 table + API; automated diff checks

3. **Rookie Draft Writers Race Condition (DUP-001):**
   - Multiple ETL scripts write to site/rookies/rookie_draft_history.json
   - Execution order unclear (build_rookie_draft_hub.py vs. analytics)
   - **Outcome:** Stale or incomplete rookie data in HPM pages
   - **Mitigation:** Document execution order; add metadata timestamps; validate row counts post-run

4. **Player ID Mismatch (DUP-005):**
   - player_id_crosswalk lives in D1, CSV cache, JSON cache, and embedded in trade_value_model_2026.json
   - Multiple writers (build_player_id_crosswalk.py, patch_qb_crosswalk_gaps.py)
   - **Outcome:** QB crosswalk gaps missed; PFR advanced stats not available for some QBs
   - **Mitigation:** Make D1 primary; make caches read-only; remove from model JSON

5. **League ID Expansion Impossible (DUP-002):**
   - 15+ hardcoded references to 74598
   - HPM expansion to other leagues requires code edits
   - **Outcome:** Manual code edit required per new league; error-prone; breaks CI/CD automation
   - **Mitigation:** Inject LEAGUE_ID into window.UPS_LEAGUE_ID global; update all consumers

### 🟡 **Medium-Impact Risks**

6. **Stale CCC Data Files:**
   - site/ccc/mym_submissions.json, tag_submissions.json, extension_submissions.json not updated since 2026-02-16 (71 days)
   - ccc.js updated 2026-04-10; clear evidence of active development but data not committed
   - **Theory:** Submissions stored in worker backend; git snapshot is stale
   - **Outcome:** Discrepancy between "live" submissions and git inventory
   - **Mitigation:** Clarify worker vs. git storage; add hourly refresh if git is SoT

7. **Embed Loader Duplication:**
   - 13 near-identical files; risk of accidental divergence
   - mcm_embed_loader.js in two locations (check which is active)
   - **Outcome:** Maintenance burden; potential for bug fix in one loader to be missed in others
   - **Mitigation:** Consolidate to single canonical; import in subdir loaders

8. **Auction Model Era Misalignment (DUP-023):**
   - build_auction_value_model_v2.py era definitions are wrong: SF_ERA_START=2022 conflates SF+TE Premium
   - TE Premium didn't start until 2025
   - **Outcome:** 2022-2024 TE inflation underestimated; 2025+ TE inflation over/under-calibrated
   - **Mitigation:** Split 3 eras; recalibrate; re-run v2 model

---

## Recommended Sunset Order

**Phase 1 (Immediate - Impact: Unblock CI/CD & prevent outages)**
1. **DUP-002: League ID** → Move to window.UPS_LEAGUE_ID global (2–3 days)
2. **DUP-013: Cap Math** → Canonicalize formula + fix Sep 30 bug (4–6 days)

**Phase 2 (Short term - Impact: Stabilize rule changes & consolidate logging)**
3. **DUP-004: Rules** → Rebuild rules.json from memory v14; add D1 table (3–5 days)
4. **DUP-008: Contract Forum Export** → Sequence 3 writers; add submission_type field (2–3 days)
5. **DUP-001: Rookie Draft History** → Consolidate to single path (1–2 days)

**Phase 3 (Medium term - Impact: Simplify HDM architecture)**
6. **DUP-005: Player ID Crosswalks** → Make D1 primary; remove caches (2–3 days)
7. **DUP-018, DUP-019, DUP-020, DUP-022: Submission Logging** → Consolidate to v3_all with submission_type (3–4 days, batched)

**Phase 4 (Long term - Impact: Reduce maintenance burden)**
8. **DUP-007: Embed Loaders** → Consolidate to single canonical (1–2 days)
9. **DUP-012, DUP-014, DUP-025: Rules in Code** → Remove inline constants; fetch from API (2–3 days per case)

**Phase 5 (Verification & Documentation)**
10. **DUP-011, DUP-023, DUP-006:** Document script DAG; recalibrate auction model (2–3 days)
11. **DUP-015, DUP-016, DUP-017, DUP-024, DUP-026:** Clarify snapshot vs. live; move live to R2 (2–3 days)

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| **Total Duplicate Cases** | 26 |
| **Critical Severity** | 13 (50%) |
| **High Severity** | 2 (8%) |
| **Medium Severity** | 7 (27%) |
| **Low Severity** | 4 (15%) |
| **Total Consumer Count (unique artifacts)** | ~100+ |
| **Estimated Consolidation Lift** | 30–40 days (6–8 weeks) |
| **Phase 1 Critical Path** | 6–10 days (DUP-002, DUP-013, DUP-004) |

---

## Final Recommendation

Keith's directive "No multiple sources of truth" is **fundamentally at odds** with the current architecture until the three **critical consolidations** are completed:

1. **DUP-002: League ID global** — Enables expansion & automation
2. **DUP-013: Cap math API** — Prevents audit divergence
3. **DUP-004: Rules D1 table** — Single source for all rule-dependent logic

These three are blockers for any confidently maintained codebase. The remaining 23 cases are lower-priority but contribute to maintenance debt and drift risk.

**Recommendation:** Allocate 2–3 sprints to consolidate DUP-002, DUP-013, DUP-004 (critical path). Once these three are complete, the codebase will be significantly more maintainable, and expansion/rule changes can be handled via configuration rather than code edits.

---

**End of Report**
