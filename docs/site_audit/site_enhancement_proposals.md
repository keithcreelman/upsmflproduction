# Site Enhancement Proposals — Parking Lot

**Generated:** 2026-04-28
**Branch:** `docs/site-audit-v1`
**Owner:** Keith Creelman
**Status:** Draft for review — Phase 7 of the comprehensive site audit. **No implementation here.** This document inventories enhancement opportunities surfaced by the audit, ranked by severity × impact × estimated lift.

> **Source-of-record principle:** every enhancement here ties back to a Critical finding (`F-CRIT-*`), a duplicate-source case (`DUP-*`), or a freshness gap (Phase 4). Where a fix is straightforward enough to land as a regular PR, it's tagged `[fix]`. Where it requires design or Keith's call, it's tagged `[design]`.

---

## Tier 1 — Critical-path fixes (do these first; protect cap math and league rules)

### E-CRIT-01 [fix] — Earnings curve milestone correction
- **Problem:** `pipelines/etl/scripts/build_contract_history_snapshots.py:368` uses milestones `[Sep 30, Oct 31, Nov 30, season_end]`; canonical rule is `[Oct 1, Nov 1, Dec 1, season_end]`. Code is more lenient than spec by one milestone for September cuts. Spec already documents this at Section 6 B2.
- **Source:** `F-CRIT-002`, also surfaces in `DUP-013` (cap-math duplication).
- **Lift:** ~30 minutes for the one-line fix. Plus historical recalc: re-run drop-penalty calculations for every cut since 2010 to identify any concrete dollar impact on owners. Recalc lift: 1–2 days.
- **Blocked by:** Keith decides whether to retroactively correct historical cap penalties or just fix forward.

### E-CRIT-02 [fix] — Restructure cap value: 4 → 3
- **Problem:** Code constant says 4 restructures per offseason; rule per memory `league_rules_2026_corrections.md` is 3. Off-by-one in `site/ccc/ccc.js`.
- **Source:** `F-CRIT-005`.
- **Lift:** ~15 minutes for the literal fix. Audit any submissions in 2025-2026 that hit count 4 to verify no rule was already broken.
- **Blocked by:** Nothing technical.

### E-CRIT-03 [design+fix] — MYM 4-cap server-side enforcement
- **Problem:** Worker `/offer-mym` and `pipelines/etl/scripts/log_mym_submission.py` accept unlimited MYMs per franchise per season; rule is 4.
- **Source:** `F-CRIT-001`.
- **Design:** Choose enforcement layer — worker pre-check via D1 (preferred) or ETL pre-check via JSON read.
- **Lift:** 1 day for the worker D1-count guard, plus a smoke test against test league `25625`.
- **Blocked by:** Decision on enforcement layer (worker vs. ETL).

### E-CRIT-04 [design+fix] — Restructure window date enforcement (offseason-only)
- **Problem:** No worker / UI / ETL date check. In-season restructures pass.
- **Source:** `F-CRIT-004`.
- **Design:** Window dates from Section 3 calendar — season-end roll-forward through Sep 15 contract deadline.
- **Lift:** 1 day. Worker checks `Date.now()` is within window before accepting POST.
- **Blocked by:** Where are the season-end roll-forward and contract-deadline dates currently configured? May need a `season_calendar` config injected at runtime.

### E-CRIT-05 [design+fix] — Trade asset requirement (must include player or pick)
- **Problem:** Money-only trades pass UI + worker validation. Rule: each side must include at least one non-salary asset.
- **Source:** `F-CRIT-008`.
- **Design:** Add asset-count check in `buildTradeProposalAssetLists()` at `worker/src/index.js:8852`; reject if either side has zero player + zero pick assets.
- **Lift:** 0.5 day worker + UI display when constraint not met.
- **Blocked by:** Nothing.

### E-CRIT-06 [design] — League ID parameterization
- **Problem:** Prod league `74598` hardcoded in 15+ files; tier-2 testing on league `25625` requires per-file overrides today.
- **Source:** `DUP-002` (the highest-priority consolidation in Phase 5).
- **Design:** `window.UPS_LEAGUE_ID` global injected by `site/loader.js` from URL or config; worker reads `LEAGUE_ID` from env binding; ETL scripts read `MFL_LEAGUE_ID` env var.
- **Lift:** 2–3 days.
- **Blocked by:** No technical blockers; sequenced after E-CRIT-01..05 because it touches more files.

### E-CRIT-07 [design] — Rules canonicalization to D1
- **Problem:** Rules text scattered across `services/rulebook/data/rules.json` (stale v2024.2), `docs/league_context_v1.md`, memory `league_rules_2026_corrections.md` (current canonical), and inline JS / Python constants.
- **Source:** `DUP-004` + `DUP-012`.
- **Design:** New D1 table `mfl_league_rules` (season + rule_code + rule_value); worker `GET /api/league-rules/:season` endpoint; rebuild `rules.json` from memory v14; remove inline rule constants from code.
- **Lift:** 3–5 days.
- **Blocked by:** Keith approval of D1 schema; consumer migration plan.

### E-CRIT-08 [design] — Cap math canonicalization
- **Problem:** Cap penalty / earning / available-cap formulas reimplemented in `site/rosters/`, `site/trades/`, `worker/src/index.js`, and `pipelines/etl/scripts/`. Phase 5's audit caught the Sep 30 vs Oct 1 milestone bug as a symptom of this duplication.
- **Source:** `DUP-013`.
- **Design:** Worker endpoints `POST /api/cap-calculation/penalty` and `GET /api/cap-calculation/available`. Replace inline formulas with API calls. Add regression tests on historical drops.
- **Lift:** 4–6 days.
- **Blocked by:** Done after E-CRIT-01 (so the new endpoints already use the corrected milestones); Keith approval of API shape.

### E-CRIT-09 [design] — Calvin Johnson Rule comp-pick automation
- **Problem:** Completely unimplemented. No retirement detection, no comp-pick award logic.
- **Source:** `F-CRIT-007`.
- **Design:** Three pieces — (a) retirement detection (annual; cross-reference NFL retirements with our roster); (b) tier-1 status check (was player Tier 1 the season before retirement?); (c) comp-pick generation (which round, which year, where in the rookie draft order). All three need data model + logic.
- **Lift:** 5–10 days; significant new functionality.
- **Blocked by:** Keith decision on whether to automate now or keep manually flagging for the next 1–2 retirements; data source for "Tier 1 status the season before" (likely auction model output).

### E-CRIT-10 [design] — Auction nomination cadence (2/24hr) enforcement
- **Problem:** No counter on `performAuctionAction()` for nominations.
- **Source:** `F-CRIT-009`.
- **Design:** New D1 `nomination_log` table (franchise_id, season, league_id, ts, player_id); worker rejects if `count(*) >= 2` in last 24h; UI quota indicator.
- **Lift:** 2–3 days.
- **Blocked by:** Done before next auction window. Calendar-driven priority.

### E-CRIT-11 [fix] — Auction model era split (SF_only vs SF_TE_PREM)
- **Problem:** `build_auction_value_model_v2.py:233` collapses SF (2022+) and TE Premium (2025+) into one era. 2022–2024 TE valuations inflated by ~15–20%.
- **Source:** `F-CRIT-010`.
- **Design:** Add `"SF_only"` era for 2022–2024; populate `POSITION_INFLATION["SF_only"]` with correct historical TE multiplier; re-run on historical data; audit downstream consumers (trade-grader, pick-valuation).
- **Lift:** 1 day for the era split + multipliers; 2 days for downstream regen and consumer audit.
- **Blocked by:** Keith confirms the correct historical TE multiplier value.

### E-CRIT-12 [fix] — Tag eligibility re-check at submit
- **Problem:** UI filters against cached `tag_tracking.json`; worker accepts the submission without re-validating `contract_year == 0` against fresh MFL state.
- **Source:** `F-CRIT-011`.
- **Design:** Worker tag-submit handler re-queries MFL `rosters` export and rejects if `contract_year != 0`.
- **Lift:** 0.5 day.
- **Blocked by:** Nothing.

### E-CRIT-13 [design+fix] — Standings refresh schedule
- **Problem:** `site/standings/standings_74598_2026.json` is 64 days stale; `build_standings_snapshot.py` has no schedule.
- **Source:** Phase 4 critical finding.
- **Design:** GHA `refresh-standings.yml` — daily during regular season (Sep–Dec), 4× daily during playoffs (Dec–Jan), weekly otherwise.
- **Lift:** 1 day.
- **Blocked by:** Nothing.

### E-CRIT-14 [fix] — MYM dashboard cron debug + alerting
- **Problem:** `site/ccc/mym_dashboard.json` is 52 days stale despite an hourly cron. Cron is silently failing.
- **Source:** Phase 4 critical finding.
- **Design:** Investigate the GHA runner failure; add post-run validation (assert `mym_dashboard.json` last-modified within 2h of run); Discord alert on failure.
- **Lift:** 1–2 days (depends on root cause).
- **Blocked by:** Root-cause investigation.

### E-CRIT-15 [fix] — Year-boundary time bomb (`window.currentSeason`)
- **Problem:** `2026` hardcoded in `roster_workbench.js`, `rookie_draft_hub.js`, `ups_options_widget.js`. Will silently break Jan 1, 2027.
- **Source:** Phase 4 critical, `DUP-009`.
- **Design:** `window.currentSeason` global injected by `site/loader.js`; computed from URL year segment or worker config endpoint.
- **Lift:** 1–2 days.
- **Blocked by:** Nothing.

---

## Tier 2 — High-value but non-blocking (do these in parallel)

### E-HIGH-01 [design] — Defense-in-depth on `validation.status` pattern
- **Problem:** `F-CRIT-003-AMENDED`. Worker trusts the UI-set `payload.validation.status === "ready"` flag. Hand-crafted requests can bypass UI checks.
- **Decision needed from Keith:** is defense-in-depth wanted, given league size and trust model? If yes: add server-side recomputation of every UI-side rule (50% cap, asset requirement, tagged-player block, untradeable-pick block). If no: leave the trust model documented and move on.
- **Lift if "yes":** 3–5 days (re-implement validation in worker for every trade/MYM/restructure/extension submission).

### E-HIGH-02 [design] — Cap floor / ceiling enforcement
- **Problem:** `F-GRAY-001`. No explicit cap-floor or cap-ceiling validation in UPS code. Either MFL handles it server-side (acceptable) or there's a gap.
- **Decision needed from Keith:** confirm whether MFL enforces; if not, add UPS-side checks on every cap-changing endpoint (drops, restructures, MYM, trades).
- **Lift if needed:** 2–3 days.

### E-HIGH-03 [design] — Worker route orphan cleanup
- **Problem:** 53 of 59 worker routes have no confirmed `site/` consumer per Phase 2B. Either undiscovered consumers or dead code.
- **Design:** Comprehensive `fetch()` grep across `site/`; cross-reference each route to its caller. Deprecate any orphan with a clear sunset path.
- **Lift:** 2 days for the audit; 1–2 days for cleanup PRs depending on findings.

### E-HIGH-04 [design] — ETL deprecation cleanup
- **Problem:** 14 ETL scripts flagged as deprecated; 44 are stale (>30d untouched).
- **Design:** For each: confirm "still in use" or "ready to delete." Move retired scripts to `pipelines/etl/scripts/_archive/` with a deprecation date.
- **Lift:** 2 days for the audit; 0.5 days to land the move.

### E-HIGH-05 [design] — Multi-writer race resolution
- **Problem:** 4 outputs have multiple writers (Phase 5: `DUP-001`, `DUP-005`, `DUP-006`, `DUP-008`). Risk of race conditions and out-of-order writes.
- **Design:** For each: pick canonical writer; sequence others to read-only or to a different output path. Document precedence.
- **Lift:** 1 day per case = 4 days total.

### E-HIGH-06 [fix] — Duplicate trade handler consolidation
- **Problem:** `POST /trade-offers` and `POST /api/trades/proposals` resolve to the same handler. UI uses the legacy `/trade-offers` path.
- **Source:** `DUP-003`.
- **Design:** Audit both for parity; deprecate `/trade-offers` with a 301 redirect for one release; update UI to `/api/trades/proposals`.
- **Lift:** 1 day.

### E-HIGH-07 [design] — Submission audit-trail consolidation
- **Problem:** MYM, extension, restructure, and tag submissions each have a separate JSON snapshot file under `site/ccc/` and a separate D1 mirror table. Phase 5 cases `DUP-018`–`DUP-022`.
- **Design:** Single `contract_forum_export_v3_all` table with `submission_type` discriminator; serve via worker `/api/submission-log` endpoint; deprecate the per-type JSON snapshots in repo.
- **Lift:** 4–5 days.

### E-HIGH-08 [design] — Rookie salary tier table to D1
- **Problem:** Rookie salary tiers (slot 1.01 = $15K, etc.) hardcoded in `rookie_draft_hub.js`, `mfl_hpm16_contractcommandcenter.html`, `build_rookie_draft_hub.py`. Memory `league_rules_2026_corrections.md` v12 has the canonical table.
- **Source:** `DUP-025`.
- **Design:** D1 `rookie_salary_tiers` table; worker `GET /api/rookie-salary-tiers/:season` endpoint; consumers fetch at startup.
- **Lift:** 2 days.

---

## Tier 3 — Quality-of-life and weekly-cadence enablement

### E-MED-01 [design] — Weekly re-audit automation
- **Problem:** Per Keith's 2026-04-28 governance (memory `site_audit_governance.md`): re-audit cadence is weekly. Today the audit is manual.
- **Design:** GHA workflow `weekly-site-audit.yml` that runs the inventory CSVs (Phase 2A/B/C scripts), the freshness CSV (Phase 4), and the duplicate-source register (Phase 5); diffs against the last week's outputs; posts a summary to Discord.
- **Lift:** 3–4 days (each phase needs to be made re-runnable; today they're agent-produced).
- **Blocked by:** Each phase's "make it re-runnable" lift.

### E-MED-02 [design] — Weekly diff report `site_audit_diff_YYYY-MM-DD.md`
- **Problem:** Without a diff, weekly re-audits become noise. Need to surface what changed.
- **Design:** Compare current week's CSVs to last week; surface added/removed/changed rows. Post to Discord + commit the diff to `docs/site_audit/weekly/`.
- **Lift:** 1 day after E-MED-01 lands.

### E-MED-03 [design] — Hardcoded SHA elimination in HPM wrappers
- **Problem:** `hpm-widget.html`, `hpm-standings.html`, `ups_issue_report.html` pin asset URLs to specific git commits. Updates require manual SHA bumps.
- **Design:** CDN points at `main` branch (or a "stable" tag); HPM wrappers reference the moving tag. Trade-off: faster updates, less rollback insurance.
- **Lift:** 0.5 day. Discuss trade-offs with Keith.

### E-MED-04 [design] — Lazy-load `player_scoring_*.json` (5.4 MB each)
- **Problem:** Two 5.4 MB JSON files ship to every HPM that includes `roster_workbench.js` even if the user doesn't need historical scoring.
- **Design:** Move to worker endpoint with on-demand fetch. Cache aggressively (24h TTL). Or: split into per-week chunks.
- **Lift:** 2 days.

### E-MED-05 [design] — Embed loader consolidation
- **Problem:** 13 `mfl_hpm_embed_loader.js` files, mostly identical. `DUP-007`.
- **Design:** Single canonical `site/embed_loader_mfl_hpm.js`; per-subdir loaders import from canonical (or HTTP-fetch from CDN).
- **Lift:** 1 day.

### E-LOW-06 [fix] — Public-route rate-limiting
- **Problem:** `/mcm/nominate`, `/mcm/vote`, `/bug-report` lack rate limits. `F-LOW-002` + `F-LOW-004`.
- **Design:** Cloudflare-side rate-limit rules; or worker-side IP-hash counter.
- **Lift:** 0.5 day.

### E-LOW-07 [fix] — Discord alerts on stale data
- **Problem:** Phase 4 found data sources that are silently stale despite scheduled jobs.
- **Design:** GHA workflow that posts to Discord if any displayed JSON is >7d stale (configurable per-file).
- **Lift:** 1 day.

### E-LOW-08 [design] — Live HPM body capture for inventory
- **Problem:** Phase 2D `TYPE=appearance` returned only positioning, not body content. We don't have a programmatic way to inventory what's currently pasted into each MFL HPM.
- **Design:** One-time manual capture: Keith exports each HPM body via MFL admin and drops into `docs/site_audit/_raw/hpm_bodies/`. Subsequent updates tracked through the repo's HPM source files (the moving CDN-pointed wrappers).
- **Lift:** 1 hour of Keith's time + 0 dev work.

---

## Out of scope (do not pursue)

- Section 8 of `league_context_v1.md` (Contract Activity & Player Lineage Tracking) — placeholder; let that effort scope itself.
- MFL platform feature requests (e.g., "ask MFL to enforce 2-nomination cap server-side") — we don't control MFL.
- Visual redesign of HPMs — cosmetic; not what this audit is for.

---

## Prioritization recommendation

**If Keith picks one chunk of work this month**, recommend the Tier 1 critical-path block in this order:

1. **Quick wins first** (1 day combined): E-CRIT-01 (earnings curve), E-CRIT-02 (restructure cap 4→3), E-CRIT-12 (tag re-check), E-CRIT-15 (year-boundary).
2. **Server-side validation block** (4–5 days): E-CRIT-03 (MYM cap), E-CRIT-04 (restructure window), E-CRIT-05 (trade asset requirement).
3. **Calendar-driven priority** (2–3 days, before next auction): E-CRIT-10 (auction nomination cadence).
4. **Configuration consolidation** (3 days, sequenced after the validation block to take advantage of the new patterns): E-CRIT-06 (League ID parameterization).
5. **Then** the longer design work — E-CRIT-07 (rules to D1), E-CRIT-08 (cap math canonicalization), E-CRIT-09 (Calvin Johnson Rule), E-CRIT-11 (era split).

Total Tier 1 lift estimate: **15–25 days of focused work** depending on how cleanly each lands and how much existing test coverage exists.

---

## Cross-references

- Phase 3 / 3b findings: `site_audit_findings.md`, `site_audit_findings_v2.md`
- Phase 4 freshness: `site_data_freshness_findings.md`
- Phase 5 duplicates: `site_duplicate_sources_findings.md`
- Phase 6 release governance: `release_workflow.md`
- Memory: `site_audit_governance.md`, `league_rules_2026_corrections.md`
