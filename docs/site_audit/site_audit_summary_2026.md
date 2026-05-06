# UPS Site Audit — Executive Summary

**Date:** 2026-04-28
**Branch:** `docs/site-audit-v1` (4 commits ahead of `main`; 14 deliverable files)
**Audit lead:** Claude Code (Opus 4.7) acting on Keith Creelman's directive
**Scope:** Comprehensive audit of the UPS league site, MFL Home Page Modules, Cloudflare Worker, and ETL pipelines against the authoritative spec at `docs/league_context_v1.md` (PR #8 / `docs/league-context-v1` branch).

> **Keith's framing:** *"Make sure OF EVERYTHING. I need this process done the correct way and protect me from me. Data always needs to be up to date with regards to rosters, contract functionality etc."*

---

## TL;DR

- **The league has 9 confirmed Critical rule-enforcement gaps and 4 confirmed Low-severity gaps. Two original "Critical" findings were retracted after verification — F-CRIT-003 (trade 50% cap) and F-CRIT-006 (tag limit) are correctly enforced.**
- **Two architectural gray-zone issues** need Keith's call: defense-in-depth on `validation.status` (F-CRIT-003-AMENDED) and cap floor/ceiling enforcement source (F-GRAY-001).
- **26 duplicate-source cases** identified, with 20 Critical (touching league functionality), 4 Gray-zone, 2 Low.
- **Data freshness has 5 Critical issues** — including `mym_dashboard.json` 52 days stale (silent cron failure) and `standings_*_2026.json` 64 days stale (no schedule).
- **Test → promote workflow is now codified** (Phase 6) with the test league `25625` as Tier 2 and prod league `74598` as Tier 3.
- **Tier 1 critical-path fixes total an estimated 15–25 days of focused work**; recommended sequence is in `site_enhancement_proposals.md`.

---

## Top 5 findings (in priority order)

### 1. **F-CRIT-002 — Earnings curve milestone bug since 2010 (`build_contract_history_snapshots.py:368`)**
Sep 30 cuts earn 25% (should be 0%). One-line fix; documented in spec Section 6 B2 as a known bug. **Action:** ship the fix; decide whether to retroactively recalculate historical drop penalties.

### 2. **F-CRIT-001 — MYM 4-cap NOT enforced server-side**
Worker `/offer-mym` accepts unlimited submissions per franchise per season. **Action:** add D1-count guard in worker before next MYM window.

### 3. **F-CRIT-007 — Calvin Johnson Rule completely unimplemented**
Zero references in `site/`, `worker/`, `pipelines/`. Comp picks for retired Tier-1 players require manual flagging. **Action:** Keith decides whether to automate now (5–10 days lift) or stay manual for the next 1–2 retirements.

### 4. **F-CRIT-009 — Auction nomination cadence (2 / 24hr) NOT enforced**
`performAuctionAction()` accepts unlimited nominations per franchise per day. **Action:** new `nomination_log` D1 table + worker counter before next auction window.

### 5. **F-CRIT-010 — Auction model conflates SF era with TE Premium era**
`build_auction_value_model_v2.py:233` returns `"SF_TE_PREM"` for any season ≥ 2022, applying the 2025+ TE Premium multiplier (1.48) to 2022–2024 data. TE valuations inflated ~15–20% in historical models. **Action:** add `"SF_only"` era for 2022–2024.

The remaining 4 Critical findings (F-CRIT-004 restructure window, F-CRIT-005 restructure count 4→3, F-CRIT-008 trade asset requirement, F-CRIT-011 tag eligibility re-check) are in `site_audit_findings.md` and `site_audit_findings_v2.md`.

---

## Inventory at a glance

| Surface | Count | Detail |
|---|---|---|
| `site/` artifacts | 174 | HTML, JS, CSS, JSON, embed loaders, per-feature subdirs |
| Worker routes | 59 | 28 GET + 31 POST; 24 D1 migrations; 1 cron handler |
| ETL scripts | 84 | 76 manual, 6 GHA-on-push, 2 hourly cron |
| Active HPMs | 8+ | MESSAGE2, 5, 9, 12, 13, 15, 16, 17 |
| GitHub Actions | 11 | Logging dispatchers + scheduled refreshers |
| Critical findings | 9 | After retraction of F-CRIT-003 + rescind of F-CRIT-006 |
| Low findings | 4 | Cosmetic / non-league-functional |
| Gray-zone (Keith decision) | 2 | F-CRIT-003-AMENDED, F-GRAY-001 |
| Duplicate-source cases | 26 | 20 Critical, 4 Gray, 2 Low |
| Freshness rows | 76 | 5 Critical, 31 sources >30d stale |

---

## Critical findings — full list

The full enriched list (with module paths, line numbers, spec citations, observed behavior, gaps, risks, recommended fixes, blocked-by) is in `site_audit_findings.md` and `site_audit_findings_v2.md`. Quick reference:

| Finding | Module | One-line summary |
|---|---|---|
| F-CRIT-001 | `worker/.../`+`log_mym_submission.py` | MYM 4/season cap not enforced |
| F-CRIT-002 | `build_contract_history_snapshots.py:368` | Earnings curve uses Sep 30 instead of Oct 1 |
| F-CRIT-004 | `worker/.../`+`ccc.js` | Restructure window not enforced (in-season allowed) |
| F-CRIT-005 | `site/ccc/ccc.js` | Restructure cap = 4 in code; rule is 3 |
| F-CRIT-007 | (codebase) | Calvin Johnson Rule completely unimplemented |
| F-CRIT-008 | `worker/.../`+`trade_workbench.js` | Trade asset requirement not enforced (money-only trades) |
| F-CRIT-009 | `worker/src/index.js:5229` | Auction nomination 2/24hr not enforced |
| F-CRIT-010 | `build_auction_value_model_v2.py:233` | SF era and TE Premium era conflated (2022–2024 TE inflated) |
| F-CRIT-011 | `build_tag_tracking.py`+`ccc.js` | Tag eligibility (0 yrs remaining) UI-mediated, no server re-check |

**Retracted (no longer findings):**
- F-CRIT-003 — Trade 50% cap IS enforced via UI compute → `validation.status` flag → worker reject. Indirection.
- F-CRIT-006 — Tag limit IS correct (1+1=2 via offense/defense filtering).

**New gray-zone (need Keith decision):**
- **F-CRIT-003-AMENDED** — Worker trusts UI-set `validation.status` flag; non-UI clients could bypass. Critical if defense-in-depth wanted; Low otherwise.
- **F-GRAY-001** — Cap floor ($260K) and ceiling ($300K) — no UPS-side enforcement found; either MFL handles it or there's a real gap.

---

## Top duplicate-source consolidations (Phase 5)

Top 3 by severity × consumer count:

1. **DUP-002 — League ID hardcoding** (15 consumers; `74598` baked into `site/*.html`, `site/*.js`, multiple JSON config files). Lift: 2–3 days. Unblocks tier-2 testing on league `25625`.
2. **DUP-013 — Cap math reimplemented in 3 layers** (8 consumers; UI / worker / ETL each reimplement penalty + earning + available-cap formulas). Drift surfaced as F-CRIT-002. Lift: 4–6 days. Fix is to canonicalize via worker `/api/cap-calculation/*` endpoints.
3. **DUP-004 — Rules text scattered** (8 consumers; `services/rulebook/data/rules.json` is v2024.2 stale, memory `league_rules_2026_corrections.md` is v14 canonical, code holds inline rule constants). Lift: 3–5 days. Fix is to rebuild `rules.json` from memory v14 and add `mfl_league_rules` D1 table.

Full register (26 cases): `site_duplicate_sources_register.csv` + `site_duplicate_sources_findings.md`.

---

## Data freshness — top concerns (Phase 4)

1. **MYM Dashboard 52 days stale** — `site/ccc/mym_dashboard.json` last refreshed 2026-03-07 despite hourly GitHub Action. Cron is silently failing.
2. **Standings 64 days stale** — `site/standings/standings_74598_2026.json` last refreshed 2026-02-24. No schedule on the writer (`build_standings_snapshot.py`). Owners misled about playoff position.
3. **Hardcoded `2026` in `roster_workbench.js`, `rookie_draft_hub.js`, `ups_options_widget.js`** — silent break Jan 1, 2027.
4. **31 data sources >30 days stale** — manual-only refresh with no automation.
5. **3 multi-writer outputs** with undefined merge order (subset of Phase 5's 4 cases).

Full register (76 rows): `site_data_freshness.csv` + `site_data_freshness_findings.md`.

---

## Recommended next steps (priority order)

**Quick wins (1 day combined):**
- E-CRIT-01: Earnings curve milestone fix (one line in `build_contract_history_snapshots.py`)
- E-CRIT-02: Restructure cap 4 → 3 (one constant in `ccc.js`)
- E-CRIT-12: Tag eligibility re-check at submit (worker handler)
- E-CRIT-15: `window.currentSeason` global (replace `2026` literals)

**Server-side validation block (4–5 days):**
- E-CRIT-03: MYM cap server-side guard
- E-CRIT-04: Restructure window date enforcement
- E-CRIT-05: Trade asset requirement enforcement

**Calendar-driven priority (2–3 days, before next auction window):**
- E-CRIT-10: Auction nomination cadence (2/24hr) counter

**Configuration consolidation (3 days):**
- E-CRIT-06: League ID parameterization (`window.UPS_LEAGUE_ID`)

**Operational (do whichever blocks an active issue first):**
- E-CRIT-13: Standings refresh GHA schedule
- E-CRIT-14: Investigate MYM dashboard cron failure

**Longer design work:**
- E-CRIT-07: Rules to D1 (3–5 days)
- E-CRIT-08: Cap math canonicalization (4–6 days)
- E-CRIT-09: Calvin Johnson Rule automation (5–10 days)
- E-CRIT-11: Auction model era split (3 days)

**Gray-zone decisions (Keith calls these):**
- E-HIGH-01: Defense-in-depth on `validation.status`
- E-HIGH-02: Cap floor / ceiling enforcement source

Full enhancement parking lot: `site_enhancement_proposals.md`.

---

## Test → promote workflow

Codified in Phase 6:

- **Tier 1 — Local dev:** feature branches `<type>/<slug>`; `scripts/validate_release.sh`; local D1 dev DB.
- **Tier 2 — Test league `25625` on `www48.myfantasyleague.com`:** PR review (same flow as PR #8); 72-hour hold; checklist must pass.
- **Tier 3 — Prod league `74598`:** merge to `main`; deploy artifacts; smoke test; rollback line in PR description.

**Severity gate:**
- **Critical** — anything impacting league functionality. Blocks merge until fixed.
- **Low** — cosmetic only. Doesn't block.
- **Gray** — escalate to Keith for tagging.

**Re-audit cadence:** weekly. Monday or first business day of the week.

Workflow docs: `release_workflow.md`, `release_checklist.md`, `rollback_runbook.md`.

---

## Methodology notes

- **Six parallel agents** drove the heavy lifting (Phase 1 MFL constraints, Phase 2A/B/C inventories, Phase 4 freshness, Phase 5 duplicates, Phase 3 rule violations, Phase 3b follow-up).
- **Verification pass** on Phase 3 caught two false positives: F-CRIT-003 (Keith's correction; the agent missed UI→`validation.status`→worker indirection) and F-CRIT-006 (the agent's own analysis contradicted its own classification). Both are documented in `_phase3_verification.md`.
- **Severity model** was 4-tier in the agent outputs; re-tagged to Keith's 2-tier (Critical / Low / Gray-escalated) per the 2026-04-28 governance memory.
- **Phase 2D (live HPM config)** returned a sparse `TYPE=appearance` response (4 modules visible, 8+ active per Phase 1 inventory). Either MFL only returns positioning or the league has additional tabs not in the response. Logged as enhancement E-LOW-08.
- **Spec source:** `docs/league_context_v1.md` from the `docs/league-context-v1` branch (PR #8), pinned snapshot at `/tmp/league_context_v1_for_audit.md` for the audit run. The spec itself is locked v8/v11/v13 across Sections 1, 2, 3, 4, 6.

---

## Deliverables index

All files under `docs/site_audit/`:

| Phase | File | Type | Purpose |
|---|---|---|---|
| 1 | `mfl_platform_constraints.md` | reference | What MFL allows / restricts / recommends |
| 2 | `site_inventory_summary.md` | summary | Cross-cutting view + pointer to sub-CSVs |
| 2A | `_inventory_site.csv` + `_inventory_site_summary.md` | catalogue | 174 site/ artifacts |
| 2B | `_inventory_worker.csv` + `_inventory_worker_summary.md` | catalogue | 59 worker routes |
| 2C | `_inventory_etl.csv` + `_inventory_etl_summary.md` | catalogue | 84 ETL scripts |
| 2D | `_raw/_live_appearance_74598.json` | artifact | Live MFL HPM config (sparse) |
| 3 | `site_audit_findings.md` + `site_audit_findings.csv` | findings | Phase 3 rule violations |
| 3 | `_phase3_verification.md` | verification | F-CRIT-003 retraction + F-CRIT-006 rescind trail |
| 3b | `site_audit_findings_v2.md` + `site_audit_findings_v2.csv` | findings | Phase 3 follow-up (uncovered modules) |
| 4 | `site_data_freshness.csv` + `site_data_freshness_findings.md` | findings | Per-source refresh + staleness |
| 5 | `site_duplicate_sources_register.csv` + `site_duplicate_sources_findings.md` | findings | 26 consolidation cases |
| 6 | `release_workflow.md`, `release_checklist.md`, `rollback_runbook.md` | governance | Test → promote workflow + rollback |
| 7 | `site_enhancement_proposals.md` | parking lot | Prioritized enhancement backlog |
| 8 | `site_audit_summary_2026.md` | summary | This document |

---

## Open questions for Keith

1. **F-CRIT-002 historical recalc:** retroactively correct cap penalties for every drop since 2010, or fix forward only?
2. **F-CRIT-007 Calvin Johnson Rule:** automate now (5–10 days) or keep manually flagging for next 1–2 retirements?
3. **F-CRIT-003-AMENDED:** is defense-in-depth on `validation.status` worth 3–5 days of work given league trust model?
4. **F-GRAY-001 cap floor/ceiling:** confirm whether MFL handles server-side; if not, add UPS validation?
5. **E-CRIT-11 historical TE multiplier:** what's the correct `POSITION_INFLATION["SF_only"]["TE"]` value for 2022–2024?
6. **E-MED-01 weekly automation:** ready to invest 3–4 days to automate the audit, or stay with manual + per-Keith trigger?
7. **E-LOW-08 HPM body capture:** willing to do a one-time manual export of all MFL HPM bodies into `_raw/hpm_bodies/`?

---

## Sign-off

This audit is **read-only**. No live code, no live MFL configs, no live D1 schema were modified during its production. All findings are advisory until Keith approves a fix and that fix lands via the Phase 6 release workflow.

**Branch state:** `docs/site-audit-v1` ahead of `main` by 4 commits, ready to push and open a PR.
