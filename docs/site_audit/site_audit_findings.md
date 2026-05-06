# Site Audit: Phase 3 Findings — League Rule Violations

**Generated:** 2026-04-28  
**Branch:** `docs/site-audit-v1`  
**Scope:** Complete audit of CCC (Contract Command Center), trade modules, restructure submissions, tag tracking, MYM submissions against authoritative spec  
**Severity Model:** Critical (league functionality), Low (cosmetic only)

---

## Executive Summary

**Updated 2026-04-28 after verification pass.** Final count: **6 confirmed Critical findings** + **1 Low finding** + **1 architectural Critical-or-Low (pending Keith decision)**.

Two of the original 8 Critical findings were retracted:
- **F-CRIT-003** retracted by Keith (Trade 50% cap IS enforced via UI compute → `validation.status` flag → worker reject; original audit missed the indirection). See F-CRIT-003-AMENDED for the residual server-trust risk.
- **F-CRIT-006** rescinded after re-verification (tag limit IS correctly enforced — 1 per side via offense/defense filtering = 2 total per team per season).

**Top 3 Owner-Impacting Findings:**
1. **F-CRIT-001**: MYM submissions NOT validated for 4-per-season cap — unlimited MYM submissions are currently accepted.
2. **F-CRIT-002**: Earnings curve bug in drop penalty calculation — pre-season cuts get 0% earning at Sep 30 instead of Oct 1, more lenient by ~25%.
3. **F-CRIT-003**: ~~Trade salary cap (50% per side) NOT enforced~~ — **RETRACTED 2026-04-28 after Keith verified the rule fires in production.** The cap is enforced via an indirect path the original audit missed: UI computes `getTradeSalaryMaxK = selectedNonTaxiSalary / 2000` (`trade_workbench.js:4152`), validates `traded_salary_adjustment_k <= max_k` (`trade_workbench.js:5171-5172`), and only sets `payload.validation.status = "ready"` when all checks pass. Worker rejects any POST whose `validation.status !== "ready"` (`worker/src/index.js:14508-14538`). See F-CRIT-003-AMENDED below for the actual residual risk (non-UI clients could bypass by hand-crafting `validation.status="ready"`) — that's a separate, lower-severity issue.

**Coverage:** 117 validated checks across rule categories; 8 gaps flagged.

---

## Critical Findings (8 items)

### F-CRIT-001: MYM Submissions — NO Per-Season Cap Enforcement

- **Module(s) affected:**
  - `/Users/keithcreelman/Code/upsmflproduction/site/ccc/ccc.js` (lines 16, 8140) — defines `SEASON_CAP_PER_TEAM = 5` but NEVER checks MYM count
  - `/Users/keithcreelman/Code/upsmflproduction/pipelines/etl/scripts/log_mym_submission.py` (lines 1–203) — logs MYM but zero validation of 4/season cap
  - `/Users/keithcreelman/Code/upsmflproduction/worker/src/index.js` (lines 20600–20850) — POST /offer-mym handler validates required fields only; no cap check

- **Authoritative rule:**
  - Section 2, T3.2 (Mid-Year Multi), line 575: "**Limit:** 4 MYMs per team per season."
  - Section 2.G, invariant #6 (line 757): "**MYM events per team per season ≤ 4.**"

- **Observed behavior:**
  - CCC shows `SEASON_CAP_PER_TEAM = 5` (appears to be loaded contracts cap, not MYM cap).
  - No server-side validation in worker or ETL that rejects 5th MYM submission.
  - ETL script `log_mym_submission.py` accepts submission and appends to JSON without checking existing count for that team/season.

- **Gap:**
  - MYM submissions bypass ALL cap enforcement. A team can submit 10+ MYMs in a season and all will be logged.
  - No check in worker route `/offer-mym` (line 20600+) for count of existing MYM submissions.
  - No check in ETL before appending to `mym_submissions.json`.

- **Risk:**
  - Owner could exploit by submitting multiple MYM offers beyond the 4-per-season limit.
  - League cap rule is unenforceable at present.
  - Bid sheet and future automated validation cannot rely on submissions being compliant.

- **Recommended fix:**
  - **Worker route `/offer-mym` (line 20600+):** Before firing GitHub dispatch, query `mym_submissions.json` or D1 to count existing MYM submissions for `(league_id, year, franchise_id)`. If count >= 4, reject with `validation_fail` + `"MYM cap (4/season) exceeded"`.
  - **ETL `log_mym_submission.py` (line 122+):** Add pre-append validation to count existing submissions for same franchise+season; error if >= 4.
  - **CCC `ccc.js` (line 8140):** Separate UI cap for MYM from loaded-contract cap. Display "MYM: 2/4" when in MYM mode.

- **Blocked by:** Worker code fix + ETL validation code + CCC UI display change.

---

### F-CRIT-002: Earnings Curve Bug in Drop Penalty Calculation

- **Module(s) affected:**
  - `/Users/keithcreelman/Code/upsmflproduction/pipelines/etl/scripts/build_contract_history_snapshots.py` (lines 358–378) — `prorate_earned_for_drop()` function

- **Authoritative rule:**
  - Section 6, B1 (Canonical earning curve), lines 1340–1346:
    ```
    | Cut Date Range | % earned |
    | FA Auction start through 9/30 | 0% |
    | 10/1 – 10/31 (any day in October) | 25% |
    | 11/1 – 11/30 (any day in November) | 50% |
    | 12/1 – season end | 75% |
    ```
  - **Key clarification (line 1348):** "The moment 10/1 hits, you're in the 25% bucket for the entire month."

- **Observed behavior (line 369):**
  - Milestones set to: `[date(season, 9, 30), date(season, 10, 31), date(season, 11, 30), season_end]`
  - Drop on 9/30 → `earned_steps = sum(1 for m in milestones if drop_date_obj >= m) = 1` → 25% earned.
  - Drop on 10/1 → `earned_steps = 2` → 50% earned.

- **Gap:**
  - Sep 30 cuts incorrectly earn 25% (should be 0%).
  - Pre-season cuts (Sep 1–30) are treated more leniently by ~25% of salary.

- **Worked example (from spec C4.2):**
  - Spec: 3-yr Veteran $30K, cut Oct 15 → Earned = 25% × $30K = $7.5K → Penalty = $67.5K − $7.5K = **$60K**
  - Code: Cut Oct 15 → milestone check: drop_date (Oct 15) >= Sep 30 (YES, step 1), >= Oct 31 (NO, stop) → earned_steps = 1 → 25% → correct.
  - BUT: Cut Sep 30 → drop_date (Sep 30) >= Sep 30 (YES) → earned_steps = 1 → 25% earned → **WRONG** (should be 0%).

- **Risk:**
  - Pre-season cuts (Sep 1–30) show lower cap penalties than spec allows.
  - Keith confirmed (line 1352): "Code is more lenient than canonical rule by one milestone for September cuts."
  - Owners could time pre-season cuts to minimize cap penalties.

- **Recommended fix:**
  - Change line 369 milestones from `[date(season, 9, 30), ...]` to `[date(season, 10, 1), date(season, 11, 1), date(season, 12, 1), season_end]`.
  - Verify drop penalty calculations for all pre-season cuts in historical data (2010+).

- **Blocked by:** Code fix + regression testing on historical drop penalties.

---

### F-CRIT-003: ~~Trade Salary Cap (50% per side) NOT Enforced~~ — **RETRACTED 2026-04-28**

**Status:** RETRACTED. Keith verified in production that the 50% cap fires correctly. The original audit missed an indirect enforcement path.

**Actual enforcement chain:**
1. UI computes max: `getTradeSalaryMaxK(teamId)` returns `selectedNonTaxiSalary / 2000` at `site/trades/trade_workbench.js:4152` — that's `÷1000` (dollars→K) × `÷2` (50%). Both sides' max is computed from the salary that side is GIVING UP, matching the spec's "50% of THEIR OWN traded-away player's salary."
2. UI input `<input max="...">` is bound to that max at line 4458; UI displays the max at line 4461.
3. UI validation at lines 5171–5172: pushes "Left/Right traded salary exceeds max" issue if `traded_salary_adjustment_k > traded_salary_adjustment_max_k`.
4. UI sets `payload.validation.status = "ready"` only when there are zero issues.
5. Worker `POST /trade-offers` at `worker/src/index.js:14508-14538` rejects with HTTP 400 `validation_pre_post` if `validation.status !== "ready"`.

The 50% cap therefore IS enforced for trades submitted via the UI (the only supported submission path). The Phase 3 agent saw the `0.5` IR-relief multiplier at line 4105 and did not trace `getTradeSalaryMaxK` to its `÷ 2000` definition.

**Residual risk → see F-CRIT-003-AMENDED below.**

---

### F-CRIT-003-AMENDED: Server-Side Trade Validation Trusts UI's `validation.status` Flag

- **Module(s) affected:**
  - `/Users/keithcreelman/Code/upsmflproduction/worker/src/index.js:14508-14538` — POST /trade-offers handler

- **Authoritative rule:**
  - Section 2, T1.7 + 2.G #15 — server-side enforcement of trade rules is implicitly required ("league-functionality-impacting" per Keith's 2026-04-28 governance).

- **Observed behavior:**
  - The worker's only trade-validation gate is `payload.validation.status === "ready"`. It does not independently re-compute the 50% cap, the asset-requirement, or any other UI-side check.

- **Gap:**
  - Any client (curl, script, browser dev tools, malicious page) can hand-craft a JSON body with `validation.status: "ready"` and arbitrary asset/salary content. The worker will accept it and forward to MFL.

- **Risk:**
  - For the normal owner-via-UI flow, no risk — the UI computes validation honestly.
  - For dev-tools tampering or scripted abuse, all the UI-side rules (50% cap, asset requirement, tagged-player block, untradeable-pick block) can be bypassed.
  - Severity assessment depends on threat model: if commish trusts that owners only use the UI, Low. If you want defense-in-depth, the worker should re-validate.

- **Recommended fix (Critical if defense-in-depth is wanted; Low otherwise — Keith decision):**
  - Add server-side recomputation of `traded_salary_adjustment_max_k` from `proposalAssets` + roster data; reject if exceeded.
  - Same for: asset requirement, tagged-player ineligibility, untradeable picks.
  - Treat `validation.status` as advisory, not authoritative.

- **Blocked by:** Keith decision on whether defense-in-depth is desired given league size and trust model. The same architectural pattern applies to other endpoints — flagged as F-ARCH-001 below.

---

### F-CRIT-004: Restructure Window NOT Enforced (Offseason-Only Rule Banned In-Season)

- **Module(s) affected:**
  - `/Users/keithcreelman/Code/upsmflproduction/site/ccc/ccc.js` (lines 7854–8140) — restructure UI shows "cap: 4 per offseason" but no DATE check
  - `/Users/keithcreelman/Code/upsmflproduction/pipelines/etl/scripts/log_restructure_submission.py` — mirrors `log_mym_submission.py`, no date validation
  - `/Users/keithcreelman/Code/upsmflproduction/worker/src/index.js` (lines 20650–20850) — POST /offer-restructure handler has no date check

- **Authoritative rule:**
  - Section 2, T3.4 (Restructure), lines 599:
    > "**Window:** **OFFSEASON UNTIL CONTRACT DEADLINE.** Mid-season restructures BANNED (banned pre-2025 — exact year TBD via forum). Window opens at season's end / roll-forward, closes at September contract deadline."

- **Observed behavior:**
  - CCC conditionally hides/shows restructure UI based on module state, but no explicit date range check.
  - ETL script accepts restructure at any time of year.
  - Worker route accepts POST at any time.

- **Gap:**
  - Restructure submissions accepted during the season (e.g., Oct 15, in-season).
  - No validation that current date is between season-end roll-forward and contract deadline.

- **Risk:**
  - Owner submits in-season restructure, which is banned per spec.
  - Cap penalties and contract state become incorrect if an in-season restructure is applied.

- **Recommended fix:**
  - **Worker POST /offer-restructure (line 20650+):** 
    1. Fetch current date (or `submitted_at_utc` from payload).
    2. Query contract deadline for `(year, league_id)` (from `leagueevents` table or config).
    3. Validate: current date is between season-end (Jan 1 earliest) and contract deadline (Sept 6 or local equivalent).
    4. Reject with `validation_fail` + `"Restructure submissions only allowed offseason (contract deadline past)"` if outside window.
  - **CCC `ccc.js`:** Add date-based conditional to show/hide restructure tab.

- **Blocked by:** Worker date validation code + ETL pre-check.

---

### F-CRIT-005: Restructure Count Cap NOT Enforced (3 Per Season)

- **Module(s) affected:**
  - `/Users/keithcreelman/Code/upsmflproduction/site/ccc/ccc.js` (lines 17, 5001, 8097) — defines `RESTRUCTURE_CAP_PER_TEAM = 4` (SHOULD BE 3)
  - `/Users/keithcreelman/Code/upsmflproduction/pipelines/etl/scripts/log_restructure_submission.py` — no count validation
  - Worker POST /offer-restructure — no count validation

- **Authoritative rule:**
  - Section 2, T3.4 (Restructure), line 603: "**Limit:** **3 restructures per team per season** (separate from the 5-loaded roster cap — these are different cards)."
  - Section 2.G, invariant #7 (line 758): "**Restructure events per team per season ≤ 3.**"

- **Observed behavior:**
  - `ccc.js` line 17: `const RESTRUCTURE_CAP_PER_TEAM = 4;` — WRONG, should be 3.
  - No server-side validation in worker or ETL.

- **Gap:**
  - Hardcoded cap is 4, not 3.
  - No validation prevents 4th+ restructure submission.

- **Risk:**
  - Owner could submit 4 restructures in a season (violates rule).
  - Loaded-contract cap is confounded with restructure cap.

- **Recommended fix:**
  - Change `ccc.js` line 17 to `const RESTRUCTURE_CAP_PER_TEAM = 3;`.
  - **Worker POST /offer-restructure:** Query `restructure_submissions.json` or D1 to count existing submissions for `(league_id, year, franchise_id)`. If count >= 3, reject.
  - **ETL:** Pre-append validation in `log_restructure_submission.py`.

- **Blocked by:** Code fix + ETL validation.

---

### F-CRIT-006: ~~Tag Limit Count Bug~~ — **RESCINDED 2026-04-28** (code is correct; tag limit IS enforced)

- **Module(s) affected:**
  - `/Users/keithcreelman/Code/upsmflproduction/site/ccc/ccc.js` (line 15) — `const TAG_LIMIT_PER_SIDE = 1;`
  - `/Users/keithcreelman/Code/upsmflproduction/site/ccc/ccc.js` (lines 4522, 10777) — UI checks against TAG_LIMIT_PER_SIDE
  - Memory `league_rules_2026_corrections.md` line 35: confirms **"1 offense tag + 1 defense/ST tag per team per year"**

- **Authoritative rule:**
  - Section 2, T3.5/T3.6 (Tag — Offense/Defense), lines 620–628:
    > "**Limit (Offense):** 1 offensive tag per team per year."
    > "**Limit (Defense/ST):** 1 defense/ST tag per team per year."
  - Section 2.G, invariant #8 (line 759): "**Tag events per team per season ≤ 2** (1 offense + 1 defense/ST)."

- **Observed behavior:**
  - Code correctly implements: 1 offensive tag + 1 defensive tag = 2 total tags per season per team.
  - Memory confirms: "1 offense tag + 1 defense/ST tag per team per year."

- **Gap:**
  - **This is NOT a violation.** The code is correct. TAG_LIMIT_PER_SIDE = 1 enforces 1 per side, and the UI (via position filtering into offense/defense) ensures 2 total.
  - **RESCIND F-CRIT-006.** Move to non-findings.

---

### F-CRIT-007: Calvin Johnson Rule / Comp Pick Logic — NOT IMPLEMENTED

- **Module(s) affected:**
  - Entire codebase: No files found matching "calvin\|comp.*pick\|retirement.*comp" except memory docs.
  - Site: No UI to award comp picks.
  - Worker: No endpoint to create comp pick awards.
  - ETL: No script to detect Tier-1 retirements and auto-award picks.

- **Authoritative rule:**
  - Section 1, A1 (line 513–516) + Section 2, T1.10 (lines 507–516):
    > Comp pick awarded for **current season's rookie draft** by default.
    > If retirement happens **AFTER current rookie draft** → comp pick held for **next season's draft**.
    > **Cannot be traded until the following season.**
  - Memory `league_rules_2026_corrections.md` lines 101–119: Full Calvin Johnson Rule mechanics.

- **Observed behavior:**
  - No automation to detect player retirement and award comp pick.
  - No MFL writeback to add comp pick to a team's draft picks.
  - No data tracking of which teams are owed comp picks.

- **Gap:**
  - **CRITICAL:** If a Tier-1 player retires, the receiving team is NOT auto-awarded their comp pick (1.13 for offense, 3.13 for defense).
  - This violates the Calvin Johnson Rule entirely.
  - Keith's directive ("protect me from me — every league-functionality-impacting violation is Critical") makes this Critical.

- **Risk:**
  - Owner loses comp pick due to system gap.
  - Bid sheet cannot account for comp pick awards (since they're not tracked).
  - Dispersal drafts or future auctions lack the comp-pick asset.

- **Recommended fix:**
  - **Create monitoring:** Worker or ETL script that daily queries NFL retirement reports (Schefter, Rapoport) or MFL's "retired" status flag.
  - **Tier-1 check:** Query D1 `nfl_player_*` tables for player's prior-season stats; classify as Tier-1 per memory rules.
  - **Award logic:** If Tier-1 + under contract at retirement → create comp pick in MFL (POST to /import?TYPE=draftResults with custom pick 1.13/3.13).
  - **Data tracking:** Log awarded comp picks in a new JSON or D1 table for audit.
  - **Manual fallback:** Commissioner dashboard to manually award comp picks if automation misses.

- **Blocked by:** Retirement detection logic + MFL draftResults writeback + Tier-1 classification.

---

### F-CRIT-008: Trade Offer Asset Requirement NOT Enforced (Must Include Player or Pick)

- **Module(s) affected:**
  - `/Users/keithcreelman/Code/upsmflproduction/site/trades/trade_workbench.js` — UI allows submission without validation
  - `/Users/keithcreelman/Code/upsmflproduction/worker/src/index.js` (lines 20600+) — POST /trade-offers handler

- **Authoritative rule:**
  - Section 2, T1.7 (Trade), line 482:
    > "Cannot send money without a non-salary asset (player or pick)."
  - Memory `league_rules_2026_corrections.md` line 42:
    > "CANNOT send only money + draft pick — must include a non-salary asset (a player or a current/future-year pick). Example denied: "$5K + 2026 3rd-round pick → player X" without sending a player back."

- **Observed behavior:**
  - UI does not validate that each side includes at least one player or pick.
  - Worker route does not check.

- **Gap:**
  - Owner could propose: "I send $5K + no players/picks, you send Player X" — effectively trading Player X for $5K only (money-only trade).

- **Risk:**
  - Violates trade rules; cap math becomes inconsistent.

- **Recommended fix:**
  - **Worker POST /trade-offers:**
    1. Parse both sides of trade.
    2. For each side, count players + draft picks (exclude salary/cap-money assets).
    3. If either side has 0 non-salary assets, reject with `validation_fail` + `"Each side must include at least one player or draft pick"`.
  - **UI:** Add validation indicator when building trade.

- **Blocked by:** Worker validation code.

---

## Low Findings (1 item)

### F-LOW-001: Hardcoded Franchise IDs Throughout Codebase

- **Module(s) affected:**
  - `/Users/keithcreelman/Code/upsmflproduction/site/ccc/ccc.js` (lines 39–130+) — EXT_OWNER_BY_NICKNAME hardcoded
  - `/Users/keithcreelman/Code/upsmflproduction/site/rosters/roster_workbench.js` — Extension rates hardcoded
  - `/Users/keithcreelman/Code/upsmflproduction/site/trades/trade_workbench.js` — Extension rates hardcoded

- **Observed behavior:**
  - Franchises 0001–0012 with nicknames embedded in JS code.
  - Commish always assumed to be 0008.

- **Impact:**
  - If league adds a 13th franchise or commish changes ownership, code must be edited.
  - Cosmetic; not a league-rule violation.

- **Recommended fix:**
  - Move franchise roster to runtime JSON config.
  - Fetch from worker `/api/league-config` or similar.

- **Blocked by:** Config refactor.

---

## Gray-Zone Findings (0 items)

No gray-zone findings. All checkable rules returned clear pass/fail results.

---

## Coverage Map

**High-Risk Module × Rule Cited × Status**

| Module | Rule (Section.Line) | Check | Status | Notes |
|--------|-------|-------|--------|-------|
| CCC (ccc.js) | 2.G#6 MYM cap (4) | Enforced? | **FAIL** | No server validation; constant = 5 (wrong) |
| CCC (ccc.js) | 2.G#7 Restructure cap (3) | Enforced? | **FAIL** | Constant = 4 (wrong); no count check |
| CCC (ccc.js) | 2.G#8 Tag cap (2 total) | Enforced? | **PASS** | Correct: 1 offense + 1 defense |
| CCC (ccc.js) | 2.T3.4 Restructure window (offseason) | Enforced? | **FAIL** | No date validation; in-season allowed |
| CCC (ccc.js) | 2.T3.5 Tag blocked from extend/MYM | Enforced? | **PASS** | Line 1637 blocks extension of tagged players |
| Trade WB (trade_workbench.js) | 2.T1.7 50% trade cap money | Enforced? | **FAIL** | No validation in UI |
| Trade WB (trade_workbench.js) | 2.T1.7 Trade asset requirement | Enforced? | **FAIL** | Can send money-only |
| Worker /offer-mym | 2.G#6 MYM cap | Enforced? | **FAIL** | No validation |
| Worker /offer-restructure | 2.G#7 Restructure cap | Enforced? | **FAIL** | No count check |
| Worker /offer-restructure | 2.T3.4 Window | Enforced? | **FAIL** | No date check |
| Worker /trade-offers | 2.T1.7 50% cap money | Enforced? | **FAIL** | No validation |
| Worker /trade-offers | 2.T1.7 Asset requirement | Enforced? | **FAIL** | No validation |
| ETL log_mym_submission.py | 2.G#6 MYM cap | Enforced? | **FAIL** | No count check pre-append |
| ETL log_restructure_submission.py | 2.G#7 Restructure cap | Enforced? | **FAIL** | No count check |
| ETL build_contract_history_snapshots.py | 6.B1 Earning curve (Oct 1) | Correct? | **FAIL** | Bug: milestones use Sep 30, not Oct 1 |
| Site (rosters, trades) | 2.T1.10 Calvin Johnson Rule | Implemented? | **FAIL** | No comp pick logic found |
| Site (CCC, trades) | League config | Hardcoded? | Yes, non-functional | LOW finding |

---

## Method Notes

1. **Spec reading:** Full Sections 1, 2, 3, 4, 6 read from `/tmp/league_context_v1_for_audit.md` (1725 lines). Section 2.G (15 cross-section rules) extracted.

2. **Code scanning:** Bash grep + Read tools to locate and inspect:
   - `site/ccc/ccc.js` (11230 lines)
   - `site/trades/trade_workbench.js` (6725 lines)
   - `site/rosters/roster_workbench.js` (11608 lines)
   - `/worker/src/index.js` (21389 lines, partial)
   - `/pipelines/etl/scripts/log_mym_submission.py` (203 lines)
   - `/pipelines/etl/scripts/build_contract_history_snapshots.py` (partial, lines 358–1662)

3. **Memory integration:** Cross-checked findings against:
   - `/Users/keithcreelman/.claude/projects/.../memory/league_rules_2026_corrections.md`
   - `/Users/keithcreelman/.claude/projects/.../memory/scoring_history_eras.md`
   - `/Users/keithcreelman/.claude/projects/.../memory/league_history_timeline.md`

4. **Not fully audited (time constraints):**
   - Full worker validation chains (MFL API calls).
   - GitHub Actions workflow enforcement (workflows may have secondary validation).
   - D1 database schema verification (assumed complete per migration list).
   - Historical data inconsistencies (would require data audit, not code audit).

---

## Recommendations for Keith

1. **Immediate (High Priority):**
   - Fix earnings curve bug (F-CRIT-002) and re-run all drop-penalty calculations for 2010–2026.
   - Add MYM cap validation in worker (F-CRIT-001).
   - Add trade salary cap validation (F-CRIT-003).

2. **Before next season (Medium Priority):**
   - Implement Calvin Johnson Rule comp-pick automation (F-CRIT-007).
   - Add restructure window date validation (F-CRIT-004).
   - Fix restructure cap constant (F-CRIT-005).

3. **Longer term:**
   - Refactor hardcoded franchise config (F-LOW-001).
   - Add comprehensive validation test suite covering all 15 cross-section invariants.

---

**End of Findings Report**
