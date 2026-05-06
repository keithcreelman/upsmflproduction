# Phase 3 Critical Findings Verification Report

**Date:** 2026-04-28  
**Auditor:** Claude Code  
**Branch:** docs/site-audit-v1  
**Scope:** Re-verification of Phase 3 findings with attention to indirect validation paths (UI → validation.status → worker)

---

## F-CRIT-001 — MYM Submissions NOT Validated for 4-per-Season Cap

**Status:** CONFIRMED

**Evidence:**
- `site/ccc/ccc.js:16` — Constant `const SEASON_CAP_PER_TEAM = 5;` (loaded contract cap, NOT MYM cap)
- `worker/src/index.js:20600-21050` — POST `/offer-mym` handler has NO count check before dispatching to GitHub; only validates required fields (league_id, year, player_id, salary, contract_year, contract_info) and MYM clock eligibility. Calls `dispatchRepoEvent(eventType, {...})` with no preceding `SELECT COUNT(*) FROM mym_submissions`.
- `pipelines/etl/scripts/log_mym_submission.py:122-199` — `main()` function appends to submissions array without counting existing submissions for `(league_id, season, franchise_id)`.

**Notes:**
- The audit correctly identified that validation.status flow does NOT apply to MYMs (contrast with trades, which rely on this pattern).
- MYM submissions are logged directly via ETL without a server-side count gate.
- Rule requires 4/season per spec (Section 2, T3.2 line 575), but code has no enforcement.

**Proposed amendment:** None — finding is valid as stated.

---

## F-CRIT-002 — Earnings Curve Bug (Sep 30 vs Oct 1)

**Status:** CONFIRMED

**Evidence:**
- `pipelines/etl/scripts/build_contract_history_snapshots.py:358-379` — Function `prorate_earned_for_drop()`:
  - Line 368-372: `milestones = [date(season, 9, 30), date(season, 10, 31), date(season, 11, 30), season_end_date]`
  - Line 376: `earned_steps = sum(1 for m in milestones if drop_date_obj >= m)`
  - **BUG:** Drop on 9/30 → `9/30 >= 9/30` (YES, step 1) → 25% earned. Should be 0% per spec.
  - **BUG:** Drop on 10/1 → `10/1 >= 10/31` (NO, stop at step 1) → 25% earned. **Correct**, but only by accident because Oct 31 is the next threshold.

**Canonical spec (per `/tmp/league_context_v1_for_audit.md` lines 1340-1348):**
- FA Auction start through 9/30 = **0%**
- 10/1 – 10/31 (October, entire month) = **25%**
- 11/1 – 11/30 (November, entire month) = **50%**
- 12/1 – season end = **75%**

**Notes:**
- Keith confirmed in the spec (line 1352) that the code is "more lenient than canonical rule by one milestone for September cuts."
- This is a **known documented bug** referenced in the spec itself.
- Owners can time pre-season cuts (Sep 1–30) to minimize cap penalties.
- **Residual risk:** No duplicate of this bug found in worker code (worker does not recompute earning curves; ETL is the sole source).

**Proposed amendment:** None — finding is valid as stated; documented in spec as known issue requiring code fix.

---

## F-CRIT-004 — Restructure Window NOT Enforced (In-Season Allowed)

**Status:** CONFIRMED

**Evidence:**
- `worker/src/index.js:20600-21050` — POST `/offer-restructure` handler (shared endpoint with `/offer-mym`):
  - `isRestructure` flag set at line 20652-20654.
  - NO date/window validation: no checks for `current_date < contract_deadline` or `current_date >= season_end`.
  - Line 20840-20889 shows player status lookup skipped for restructures: `if (!isRestructure && !isManualContractUpdate) { ... }`.
  - Handler directly proceeds to MFL import without window validation.
- `site/ccc/ccc.js:7854-8140` — Restructure UI conditionally hides/shows UI but no explicit date-range validation.

**Canonical spec (Section 2, T3.4 line 599):**
- Window: "OFFSEASON UNTIL CONTRACT DEADLINE. Mid-season restructures BANNED."

**Notes:**
- Restructures can be submitted at any time of year (Oct 15, in-season, etc.).
- No gate prevents off-season-only submission.
- UI may conditionally hide buttons, but worker accepts restructures regardless.

**Proposed amendment:** None — finding is valid as stated.

---

## F-CRIT-005 — Restructure Count Cap = 4 (Should Be 3)

**Status:** CONFIRMED

**Evidence:**
- `site/ccc/ccc.js:17` — `const RESTRUCTURE_CAP_PER_TEAM = 4;`
- Spec (Section 2, T3.4 line 603): "**Limit:** 3 restructures per team per season"

**Notes:**
- Hardcoded constant is 4, contradicting the rule.
- No server-side count validation found in worker or ETL (same gap as MYM).

**Proposed amendment:** None — finding is valid as stated.

---

## F-CRIT-006 — Tag Limit Count Bug (Should Be 2 Total, NOT 2 "per side")

**Status:** FALSE_POSITIVE

**Evidence:**
- `site/ccc/ccc.js:15` — `const TAG_LIMIT_PER_SIDE = 1;` ✓
- Lines 3254-3255, 3592-3593: UI filters displayed players into "Offense" and "Defense/ST" tabs, enforcing 1 tag per side.
- Spec (Section 2.G, invariant #8 line 759): "Tag events per team per season ≤ 2 (1 offense + 1 defense/ST)."

**Notes:**
- Code is **correct**: TAG_LIMIT_PER_SIDE = 1 combined with position-based filtering (Offense vs Defense/ST tabs) enforces 1 offense + 1 defense = 2 total per team per season.
- The findings document's own analysis (lines 233-235) agrees: "This is NOT a violation. The code is correct."
- **Recommend rescinding F-CRIT-006.**

**Proposed amendment:** RESCIND — this is not a finding. Move to "Non-findings" section.

---

## F-CRIT-007 — Calvin Johnson Rule Completely Unimplemented

**Status:** CONFIRMED

**Evidence:**
- No files in the codebase contain references to: `calvin`, `comp_pick`, `compensation`, `tier_1_retire`, `tier1_retirement`, `early_retirement`, `comp_pick_award`.
- Verified via exhaustive grep across:
  - `site/**/*.js`
  - `worker/src/**/*.js`
  - `pipelines/etl/scripts/**/*.py`

**Canonical spec (Section 1 D2 / Section 2 T1.10 lines 507-516):**
- Comp pick awarded for **current season's rookie draft** by default when a Tier-1 player retires.
- If retirement happens AFTER current rookie draft → comp pick held for **next season's draft**.
- Cannot be traded until the following season.

**Notes:**
- **CRITICAL finding:** If a Tier-1 player retires, the receiving team is NOT auto-awarded their comp pick.
- No automation to detect player retirement.
- No MFL writeback to add comp pick to a team's draft picks.
- No data tracking of which teams are owed comp picks.
- This violates the Calvin Johnson Rule entirely.

**Proposed amendment:** None — finding is valid as stated. CRITICAL severity per Keith's directive.

---

## F-CRIT-008 — Trade Offer Asset Requirement NOT Enforced (Money-Only Trades Allowed)

**Status:** CONFIRMED

**Evidence:**
- `worker/src/index.js:8852-8878` — Function `buildTradeProposalAssetLists()` validates:
  - Line 8872-8876: `isValid: !!willGiveUp.length && !!willReceive.length && !leftTokensOut.invalid.length && !rightTokensOut.invalid.length`
  - This checks that both sides have at least ONE token (player, pick, OR blind-bid money).
  - **DOES NOT enforce:** each side must have a NON-SALARY asset (player or pick).
  
- Blind-bid token generated at line 8857-8860: `blindBidTokenFromDollars()` creates `BB_5000` (cap money).
- **Result:** Trade can have:
  - Left: `[BB_5000]` (money only)
  - Right: `[DP_0_0]` (rookie pick)
  - This passes validation (both sides have length > 0, no invalid tokens).

- `site/trades/trade_workbench.js` — No UI validation that each side includes a player or pick. Searching for "each side", "must include", "player count", "pick count" yields no matches.

**Canonical spec (Section 2, T1.7 line 482):**
- "Cannot send money without a non-salary asset (player or pick)."
- Memory `league_rules_2026_corrections.md` line 42: "CANNOT send only money + draft pick — must include a non-salary asset (a player or a current/future-year pick)."

**Notes:**
- Owner could propose: "$5K only → Player X" (money-only trade, banned).
- No UI validation.
- No worker re-validation.
- Violates trade rules; cap math becomes inconsistent.

**Proposed amendment:** None — finding is valid as stated.

---

## F-LOW-001 — Hardcoded Franchise IDs Throughout Codebase

**Status:** CONFIRMED

**Evidence:**
- `site/ccc/ccc.js:39-130+` — `const EXT_OWNER_BY_NICKNAME = { uw: "0001", lh: "0006", ... }` (hardcoded franchises 0001–0012 with nicknames).
- `site/ccc/ccc.js:58-68` — Hardcoded franchise ID → nickname map (e.g., `"0001": "UW"`).
- `site/ccc/ccc.js:73-79` — Hardcoded franchise ID → color map (HSL values).

**Notes:**
- If league adds a 13th franchise or commish changes ownership, code must be edited.
- Cosmetic; not a league-rule violation.
- Recommendation: Move franchise roster to runtime JSON config; fetch from worker `/api/league-config` or similar.

**Proposed amendment:** None — finding is valid as stated. LOW severity (cosmetic, non-functional).

---

## Summary Table

| Finding | Status | Severity | Notes |
|---------|--------|----------|-------|
| F-CRIT-001 | CONFIRMED | Critical | MYM cap (4/season) not enforced anywhere |
| F-CRIT-002 | CONFIRMED | Critical | Sep 30 earning bug; documented in spec |
| F-CRIT-003 | RETRACTED | — | Already retracted; indirect enforcement verified |
| F-CRIT-004 | CONFIRMED | Critical | Restructure window (offseason-only) not enforced |
| F-CRIT-005 | CONFIRMED | Critical | Restructure cap constant is 4, should be 3 |
| F-CRIT-006 | FALSE_POSITIVE | — | Tag limit is correct (1 per side enforces 2 total) |
| F-CRIT-007 | CONFIRMED | Critical | Calvin Johnson Rule completely absent |
| F-CRIT-008 | CONFIRMED | Critical | Trade asset requirement (player/pick per side) not enforced |
| F-LOW-001 | CONFIRMED | Low | Hardcoded franchise IDs; cosmetic only |

---

## Overall Assessment

**7 Critical findings CONFIRMED, 1 Low finding CONFIRMED, 1 False Positive (F-CRIT-006).**

The original Phase 3 audit correctly identified all major gaps. The F-CRIT-003 retraction shows that indirect validation chains CAN exist in the codebase (UI compute → validation.status → worker reject), but:
- **F-CRIT-001** (MYM cap): No indirect path — worker has no count check, ETL appends unconditionally.
- **F-CRIT-004** (restructure window): No indirect path — worker accepts restructures at any time.
- **F-CRIT-005** (restructure cap = 4): Constant mismatch with spec, no server-side count check.
- **F-CRIT-008** (asset requirement): Validation checks token count, not token type (player/pick vs. money).

**No previously-unknown indirect paths discovered during re-verification.** All findings stand as originally stated.

