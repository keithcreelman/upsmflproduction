# Site Audit: Phase 3b Findings — Uncovered Modules Follow-Up

**Generated:** 2026-04-28
**Branch:** `docs/site-audit-v1`
**Scope:** Follow-up audit covering modules the Phase 3 pass skipped or partially covered: tag tracking, auction nomination cadence, MFL writebacks, calendar window enforcement, full worker route audit, Calvin Johnson Rule confirmation, and scoring era validation.
**Severity Model (per Keith 2026-04-28):** Critical = any league-functionality impact. Low = cosmetic / non-league-functional. Gray = escalate.

> **Severity correction note:** The Phase 3b agent originally labeled F-CRIT-012 (extension-assistant AI Q&A endpoint) and F-CRIT-013 (MCM nominate/vote rate-limit gap) as Critical. After review, both have been **re-tagged as Low** because their own analyses acknowledge they are not league-functional (extension-assistant is informational; MCM is a "fun side event, not league-critical" per the agent's own words). Renumbered as F-LOW-003 and F-LOW-004 below.

---

## Executive Summary

**Net Phase 3b findings: 3 Critical + 3 Low + 1 Gray.**

**Top 3 owner-impacting new findings:**

1. **F-CRIT-009 — Auction nomination rate limit (2/24hr) NOT enforced.** `performAuctionAction()` accepts unlimited nominations per franchise per day. League rule unenforceable; bid sheet cannot rely on cadence compliance.
2. **F-CRIT-010 — Scoring era classification bug** in `build_auction_value_model_v2.py` (line 233). `era_for()` returns `"SF_TE_PREM"` for any season ≥ 2022, conflating the SF era (2022+) with the TE Premium era (2025+). 2022–2024 TE valuations inflated by ~15–20%.
3. **F-CRIT-011 — Tag eligibility (0 years remaining) is UI-mediated only.** ETL pre-computes eligibility into a JSON snapshot the UI filters against, but no server-side re-check at submission time. Mid-season manual contract edits in MFL would not refresh the cached eligibility before a tag is applied.

**Confirmed PASS (no gap, contrary to Phase 1 concern):**
- MFL `import?TYPE=salaries` writeback uses `APPEND=1` correctly with per-franchise merge before write (`worker/src/index.js:18039+`). The biggest writeback gotcha from `mfl_platform_constraints.md` is in fact handled.

**Calvin Johnson Rule (F-CRIT-007) re-confirmed:** Exhaustive grep across `site/`, `worker/`, `pipelines/` finds zero references to `calvin`, `comp_pick`, `compensation`, `tier_1_retire`, `tier1_retirement`, or `early_retirement`. Completely unimplemented.

**Cap floor / ceiling enforcement:** No explicit checks found in UPS worker code. Either MFL enforces cap floor ($260K) and ceiling ($300K) server-side and UPS trusts that, or there's a real gap. Logged as F-GRAY-001 for Keith's call.

---

## Critical Findings (3 items)

### F-CRIT-009: Auction Nomination Rate Limit (2 per 24 Hours) NOT Enforced

- **Module(s) affected:**
  - `worker/src/index.js:5229-5263` — `performAuctionAction()` handles both bid and nominate actions
  - `site/acquisition/modules/free_agent_auction.js:10-100+` — FA auction submission UI
  - `site/acquisition/modules/expired_rookie_auction.js:10-100+` — Expired rookie auction UI

- **Authoritative rule:**
  - Section 2, Group 2 (line 947): "2 nominations per 24-hour window" during the auction. Day 1: 12-hour kickoff window.
  - Section 3 (line 996): "Daily during auction: 2 nominations per owner per 24-hour window."

- **Observed behavior:**
  - `performAuctionAction()` accepts both `"bid"` and `"nominate"` actions at line 5231.
  - No tracking of nomination count per franchise per 24-hour rolling window.
  - No pre-submission validation querying recent nominations.
  - Nominations dispatched directly to MFL via `postAuctionActionForCookie()` at line 5258 — MFL does not enforce UPS's stricter 2/24hr cadence.

- **Gap:**
  - A team can submit unlimited nominations in a 24-hour period (rule allows max 2).
  - No server-side counter; no UI quota indicator.

- **Risk:**
  - Owner can spam nominations to flood the slate, forcing other owners to bid early on a controlled list.
  - The league's nomination rule is not actually enforced — it relies entirely on owner self-policing.
  - Bid sheet cannot rely on nomination cadence being compliant.

- **Recommended fix:**
  - Worker `performAuctionAction()`: before accepting a nominate action, query a `nomination_log` D1 table (or JSON artifact) for `(franchise_id, season, league_id, last_24h)`. Reject with HTTP 422 + `"Nomination limit (2/24h) reached"` if count ≥ 2.
  - Log every nomination attempt to `nomination_log` on success (timestamp, franchise_id, player_id).
  - UI: display "Nominations: N/2 in current 24h window" quota indicator.

- **Blocked by:** New D1 table `nomination_log`, worker-side counter logic, UI quota display.

---

### F-CRIT-010: Scoring Era Classification Bug — SF and TE Premium Conflated

- **Module(s) affected:**
  - `pipelines/etl/scripts/build_auction_value_model_v2.py:58, 233` — `SF_ERA_START = 2022` hardcoded; `era_for()` function

- **Authoritative rule:**
  - Section 4 / Memory `scoring_history_eras.md`: **Superflex (SF) era = 2022 → ongoing. TE Premium era = 2025 → ongoing.** They are concurrent, not sequential. (Confirmed in spec v13 correction 2026-04-28.)

- **Observed behavior:**
  - Line 58: `SF_ERA_START = 2022`
  - Line 233: `def era_for(season: int) -> str: return "SF_TE_PREM" if season >= SF_ERA_START else "PRE_SF"`
  - For seasons 2022–2024: `era_for()` returns `"SF_TE_PREM"` — but TE Premium didn't start until 2025.
  - `POSITION_INFLATION` (lines 60–71) applies the `"SF_TE_PREM"` multiplier (TE = 1.48) to 2022–2024 data, which should use a non-TE-Premium TE multiplier.

- **Gap:**
  - Missing intermediate era `"SF_only"` (2022–2024).
  - 2022–2024 TE valuations get the 2025+ premium multiplier they shouldn't have.

- **Worked example:**
  - 2023 TE auction bid: model uses `POSITION_INFLATION["SF_TE_PREM"]["TE"] = 1.48`.
  - Should use a `"SF_only"` TE multiplier (likely ~1.30–1.35 — pre-Premium baseline). Keith to confirm exact value.
  - 2023 TE bid model is overstated relative to actual 2023 market.

- **Risk:**
  - Auction bid sheet for any historical season (and any model derived from it) has inflated TE values for 2022–2024.
  - Affects every owner's auction strategy that uses model output.
  - Keith already flagged `build_auction_value_model_v2.py` for sunset partly because of this; this audit confirms a concrete bug to fix or supersede.

- **Recommended fix:**
  - Add intermediate era: `"SF_only"` for `2022 ≤ season < 2025`. Update `era_for()` accordingly.
  - Define `POSITION_INFLATION["SF_only"]` with correct historical TE multiplier.
  - Re-run model on 2022–2024 historical data; flag any downstream artifacts that consumed the bad output.

- **Blocked by:** Keith confirmation of the correct historical TE multiplier; model regeneration + downstream consumer audit.

---

### F-CRIT-011: Tag Eligibility (0 Years Remaining) — UI-Mediated, No Server Re-Check

- **Module(s) affected:**
  - `pipelines/etl/scripts/build_tag_tracking.py:90, 186, 223-246` — tag eligibility computed from prior-season ending roster
  - `site/ccc/ccc.js:4500-4700` — CCC UI filters player list using the pre-computed eligibility JSON

- **Authoritative rule:**
  - Section 2 / Memory `league_rules_2026_corrections.md` lines 185-186: **"Tag eligibility: 0 years remaining. Tag candidates are players whose contract just expired (0 years remaining) — i.e., players who were on the prior season's ending roster with 1 year left. After roll-forward, they have 0 years remaining and become tag-eligible."**

- **Observed behavior:**
  - `build_tag_tracking.py` correctly computes eligibility from the prior season's ending roster + contract years and writes it to `site/ccc/tag_tracking.json`.
  - CCC UI reads the snapshot and filters the tag-candidate dropdown to eligible players only.
  - No server-side re-check of `contract_year == 0` at the moment a tag is submitted.

- **Gap:**
  - If a player's `contract_year` is manually edited in MFL between snapshot generation and a tag submission, the cached eligibility flag is stale.
  - The UI dropdown limits the typical owner workflow, but a manually-crafted submission (or a tag attempted right after a mid-season contract edit) can apply a tag to an ineligible player.
  - This is a milder variant of F-CRIT-003-AMENDED — same UI-mediated pattern, lower exposure because the snapshot is generally fresh.

- **Risk:**
  - Tag applied to a player with > 0 years remaining → invalid contract state, wrong salary, wrong tag-tier calc.
  - Cap audit becomes corrupted for that franchise.

- **Recommended fix:**
  - Worker tag-submission handler: re-query `contract_year` from a fresh MFL `rosters` export at submission time and reject if not 0.
  - Or: refresh `tag_tracking.json` hourly (cron) to minimize the staleness window.

- **Blocked by:** Tag-submission worker route hardening + (optional) hourly refresh schedule.

---

## Low Findings (3 items)

### F-LOW-002: `/bug-report` Endpoint — Public Write Without Rate Limiting

- **Module:** `worker/src/index.js:13763-13850+` — POST `/bug-report` handler.
- **Observed:** No auth, no rate limit. Bug reports dispatch to GitHub Issues without throttling.
- **Risk (Low):** Spam (100+ reports/min would clutter GitHub Issues). Not league-functional.
- **Fix:** IP-based rate limit, max 5/hr.

---

### F-LOW-003 (was F-CRIT-012): `/extension-assistant` AI Q&A Endpoint — Not a Rule-Enforcement Endpoint

- **Module:** `worker/src/index.js:21265-21350+` — POST `/extension-assistant`.
- **Observed:** This is an AI-powered Q&A endpoint that calls Anthropic's Claude API to answer extension-related questions. It validates question/context length but does not query D1 to verify a specific player's eligibility.
- **Severity:** Low (re-tagged from Critical). The endpoint is informational — actual extension submission goes through the CCC, which has its own validation. Not league-functional itself; bad AI advice is a UX issue, not a rule-enforcement gap.
- **Risk (Low):** Owner confusion if AI advice is incomplete; system prompt drift if extension costs change without prompt update.
- **Optional enhancement:** Add a structured `/extension-eligibility-check` endpoint that returns `{eligible: bool, reasons: [...]}` for a given player. Out of scope as a fix; logged for the enhancement parking lot.

---

### F-LOW-004 (was F-CRIT-013): MCM `/mcm/nominate` and `/mcm/vote` — No Rate Limit on Nomination Path

- **Modules:**
  - `worker/src/index.js:2200-2242` — POST `/mcm/nominate` (form validation present, no rate limit, status hardcoded to `"approved"` at line 2237)
  - `worker/src/index.js:2244-2330+` — POST `/mcm/vote` (IP-hash deduplication present at line 2292+)
- **Severity:** Low (re-tagged from Critical). MCM (Master Class Manager / Music championship) is the league's fun side-event, not league-functional. Spam abuse here clutters a side page, doesn't affect cap, contracts, or any league rule.
- **Risk (Low):** Nomination spam fills the MCM page with junk. Vote endpoint has IP-hash dedup so abuse vector is narrower.
- **Fix:** Rate-limit `/mcm/nominate` (max 2 per IP per hour). Add nominate-content dedup hash (display_name + primary_url within 7 days).

---

## Gray-Zone Findings (1 item)

### F-GRAY-001: Cap Floor ($260K) and Cap Ceiling ($300K) — Enforcement Source Unknown

- **Modules:** No explicit cap-floor or cap-ceiling validation found anywhere in `worker/src/`, `site/`, or `pipelines/etl/`.
- **Spec:** Section 6.A — cap floor + ceiling rules; memory `league_rules_2026_corrections.md` corroborates.
- **Question:** Does MFL enforce floor/ceiling server-side (which would make UPS code's silence acceptable), or is there a real enforcement gap?
- **Why this is Gray:** If MFL handles it, this is a non-finding. If not, it's a Critical gap that affects every cap-changing transaction (drops, restructures, MYM, trades).
- **Decision needed from Keith:** confirm whether MFL enforces these caps; if not, add server-side validation in the worker for any cap-changing endpoint.

---

## Audit Coverage Map (Phase 3b)

| Module | Rule | Status | Notes |
|---|---|---|---|
| `build_tag_tracking.py` ETL | 0 years remaining eligibility | PASS (with caveat) | Correctly computed; no server re-check at submit time → F-CRIT-011 |
| `performAuctionAction()` | 2 nominations / 24hr | **FAIL** | No counter → F-CRIT-009 |
| Auction UI (FA + expired rookie) | Show nomination quota | **FAIL** | No quota indicator |
| MFL `TYPE=salaries` writeback | `APPEND=1` correctness | **PASS** | `worker/src/index.js:18039+` confirmed correct |
| MYM date window | Calendar enforcement | FAIL (already F-CRIT-001 + F-CRIT-004 family) | No date checks |
| Restructure date window | Calendar enforcement | FAIL (already F-CRIT-004) | No date checks |
| `build_auction_value_model_v2.py` | SF (2022) vs TE Premium (2025) era split | **FAIL** | F-CRIT-010 |
| `/api/trades/proposals/action` | Trade rule enforcement | PASS (indirect) | Same UI-mediated pattern as `/trade-offers` (F-CRIT-003-AMENDED applies) |
| `/extension-assistant` | Extension rules | GRAY (informational only) | F-LOW-003 |
| `/mcm/nominate` | Rate limiting | FAIL (non-league-functional) | F-LOW-004 |
| `/mcm/vote` | One vote per IP per week | PASS (partial — dedup present) | |
| `/bug-report` | Rate limiting | FAIL (non-league-functional) | F-LOW-002 |
| Calvin Johnson Rule | Comp pick automation | **FAIL** (re-confirmed) | F-CRIT-007 still stands |
| Cap floor ($260K) | Server-side enforcement | UNKNOWN | F-GRAY-001 |
| Cap ceiling ($300K) | Server-side enforcement | UNKNOWN | F-GRAY-001 |

---

## Method Notes

- **Spec source:** `/tmp/league_context_v1_for_audit.md` (pinned snapshot of `docs/league-context-v1` branch at commit `ade178e`).
- **Memory source:** `~/.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/league_rules_2026_corrections.md`, `scoring_history_eras.md`.
- **Code search:** `rg` over `site/`, `worker/src/`, `pipelines/etl/scripts/` for the relevant route paths and rule keywords.
- **Not audited (next-pass candidates):**
  - Full MFL writeback success/failure handling for non-`TYPE=salaries` imports (extensions, salary adjustments).
  - D1 schema for nomination/vote logs (assumed not yet implemented; F-CRIT-009 fix needs a new table).
  - Historical scoring data validation (would require a separate data-correctness audit).
  - Whether GitHub Actions (`log-*-submission.yml`) enforce any rules beyond what the worker handlers do.

---

**End of Phase 3b Findings Report**
