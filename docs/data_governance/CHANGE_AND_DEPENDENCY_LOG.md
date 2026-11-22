# Data change-and-dependency log

One entry per data change, finding or decision that can affect other work. Newest first. Keep entries short; link the evidence. Agent entries are status, not Keith rulings. A Keith ruling is recorded only with a link to where he gave it.

Format: **date · type** (finding / change / decision / dependency) · what · why · evidence · work that may be affected · status.

---

**2026-11-22 · change (draft, on Keith's go in chat)** · The J3 snapshot backtest goes back into the safe suite as a **separate change** on its own draft PR #1504 (stacked on #1501). #1501 stays the BBID fix only.
- **What the 10% limit means:** a day is one pair of consecutive committed snapshots. The test fails when more than 10% of days flag any drop. It is an alert-noise budget. It is not a data check, and passing does not mean no anomaly happened.
- **The 4 flagged days (1.9% of 212), verified against the committed snapshots:**
  - 04-24 and 05-22: commissioner bulk `LOAD_ROSTERS` imports (1 and 27 players). Flagged by design.
  - 07-17 and 07-19: 7 auction winners rostered for 1-2 days, then gone with no drop transaction. Documented in code as the FAA test-residue purge; genuinely unexplained by MFL's log.
- **Behavior:** the test now labels each known day and prints NEW for any other.
- **Not certified by it:** the backtest does not certify contracts, salaries or 2026 cut-penalty charges. Those stay unverified until each posted charge is matched to a complete pricing snapshot and the worker's calculation (see the Mobile Build entry below). · Branch `claude/j3-backtest-reenable`. · Safe suite on every PR now runs the backtest. · Draft.

**2026-11-22 · dependency (Mobile Build)** · The mobile beta confirmed that `/api/cap-penalty/preview` uses live MFL rosters, so "If cut now" figures are unaffected by the R2 snapshot. Its 2027 cut penalties come from `/api/cap-adjustments/next-season`, which reads posted `ups_drop_events` and so inherits the R2 snapshot risk. Mobile will not call them verified until this session says the posted-charge path is sound. · Mobile Build message. · Mobile beta Contracts (#1475/#1497). · **Not certified.** It needs either: (a) the R2 completeness fix (baseline P1-7); or (b) a check that every 2026 posted charge's pre-drop snapshot parts were all present, plus the posted amounts reconciled to the worker's pricing. Partial evidence only: the backlog session reconciled all 31 2026 cut charges to the expected amounts under the sub-$5K rule (#1502, R).

**2026-11-22 · dependency (reported by the AI session)** · The Mac jobs that write `src_final_standings` and current-season `src_*` run from two checkouts: `~/Code/MFL/upsmflproduction` and the UPS Center auto-builder's cached repo. Both currently get their MFL key from the copy that draft #1489 removes. If #1489 merges before both checkouts have their runtime key file, those jobs would run without a key and the tables would go stale **with no alert** (no job alerting; baseline §4 #2). · Not re-checked here; no key values read. · #1489 merge gate; standings, history and AI desk standings/history tools. · Needs a per-checkout key check plus a freshness stamp before or with the #1489 merge.

**2026-11-22 · dependency** · The AI session confirmed conflicts C1-C3, acknowledged C4 and agreed to C5 (`AI_DATA_DEPENDENCIES.md` §4). No code has changed. · AI session message, 2026-11-22. · #1478. · Implementation owner to be assigned by Keith.

**2026-11-22 · dependency** · AI data dependencies recorded per tool in `AI_DATA_DEPENDENCIES.md` (desk `44805bec`, League Record S1, Discord/Wire/rule bots). Five conflicts opened with the AI session:
- C1: `src_trades` rows graded A.
- C2: freshness targets.
- C3: two coverage records.
- C4: history freshness depends on the Mac.
- C5: the bundle's contract tables.

· Keith asked that infrastructure work connect directly to the AI session (2026-11-22, chat). · Desk tool files on `claude/ai-commish-desk`. · #1478, #1484, #1486. · Sent to the AI session for acknowledgement; none resolved.

**2026-11-22 · correction** · `cap.penalty_quote` (desk) prices from live MFL salary via `/api/cap-penalty/preview` (`worker/src/index.js:55487-55570`), not from the R2 snapshot as the baseline §7 first said. The R2 risk applies to posted drop charges. · Corrected in the baseline; Mobile Build told.

**2026-11-22 · change (Mac, on Keith's go in chat)** · `com.keith.mfl.deadline-drop` unloaded (`launchctl bootout`, exit 0; launchd reports the service is gone). The plist was renamed `com.keith.mfl.deadline-drop.plist.DISABLED-2026-11-22` with the same SHA-256 (`92b6549e…0005`). The script in `~/.ups_jobs/` is untouched. No other Mac job was changed. · To restore: rename it back, then `launchctl bootstrap gui/$(id -u) <plist>`. · Recorded on #1503 BL-I04.

**2026-11-22 · review** · #1501 diff reviewed in full by this session, which also proposed the fix, so this is not an independent review. No defects found; CI safe suite green at `2d7d4a79`. Limitations are on the PR: live behavior is unproven until the first run after merge; the 4 backtest days the PR calls genuine were not re-checked; types absent from 2026 data were not reviewed; alerting is unchanged. · Draft until Keith decides on the backtest.

**2026-11-22 · correction (from the backlog session, #1503 H-INF-02)** · The 10 differences between the static `salary_adjustments_2026.json` and MFL's posted charges are explained by canon §D1's sub-$5K TCV rule (fixed $1K). All 10 had a pre-drop TCV ≤ $4K and posted at $1,000. With the rule applied, all 31 reconcile. The file remains a candidate projection that does not apply the rule, so it is not a ledger. On mobile its read is dead (`computeCapFor` uses the MFL feed only); the classic workbenches' use is unchecked (BL-S33). · #1502. · Classic roster and trade workbenches. · Inventory row updated.

**2026-11-22 · finding (from the backlog session, #1503 H-INF-01)** · Three items reported by the backlog session (verified there against MFL's 2026 `salaryAdjustments` export, 2026-11-22 01:30Z; not re-checked here):
- The cut-penalty poster writes an add/drop id with no player id for 31 of 41 charges (BL-I30, #1502).
- Adjustment categories depend on exact description text (BL-M06).
- The static `salary_adjustments_2026.json` (built 10-06) differs from posted charges for 10 of 31.

· Refines the 11-21 correction below: the worker ledger route is D1-backed, but mobile (`site/m/app.js:1159`), `roster_workbench.js:2856` and `trade_workbench.js:1548` still read the stale static file. · #1502, #1503. · Mobile Contracts itemized adjustments, AI `cap.adjustments` explanations, the cap reconciliation in P1-9. · Added to the inventory; a fix must be forward-only, because MFL's salaryAdj import appends and re-posting would duplicate charges.

**2026-11-22 · change (draft)** · J3 fix proposed in draft PR #1501 (head `2d7d4a79`): `BBID_WAIVER` counts as a legitimate departure, and its drop is read from the third segment. On the committed 11-19 to 11-21 snapshots the flags go from 13/3/1 to 0/0/0, and a synthetic unexplained drop still flags. · Closes the P0-1 false-positive finding once merged. · PR #1501 diff and its offline test. · Same consumers as the J3 finding below. · Awaiting CI and Keith's merge decision.

**2026-11-22 · correction** · The #1399 bot comment reports 13 safe-suite failures on `main` `bc607887`. A clean local run at `52338bf9` (the same code plus docs) passed 275 with 0 failures. · The bot-cutover job likely runs in the stale, dirty Mac checkout (inferred). · Local run log. · The trade-bot valuation snapshot delivery that the cutover job gates. · Open; tied to P0-5.

**2026-11-21 · finding** · J3 roster anomaly check red on false positives since 11-19 (17 flags, sampled 4, all explained by `BBID_WAIVER` drops in the same snapshot). · Its departure-type list omits blind-bid waivers. · `pipelines/etl/scripts/check_roster_anomalies.py:314`; runs 44590405939, 44788768764, 44927399437. · Every consumer that trusts "J3 green" as proof of no silent roster/contract change (contract integrity, FO, mobile beta parity). · Open; fix proposed (P0-1).

**2026-11-21 · finding** · R2 daily snapshot can be partial or hold MFL error bodies yet be marked complete. · `_snapshot_meta.json` is written regardless of part failures and the hourly retry checks only that file. · `worker/src/index.js:494-559, 8655-8676`. · Drop-penalty pricing (`cap.penalty_quote`, drop tracker), waiver card. · Open (P1-7, needs go for a worker change).

**2026-11-21 · finding** · `player_contracts` and `player_contract_stints` are served on the player profile but have no writer or migration in the repo. · Provenance unrecorded; related reconstruction preserved inert in #1491. · `worker/src/index.js:15483-15497`; `site/shared/player_profile_master.js:540`; `docs/specs/contract_stints_integration.md`. · Mobile beta contract card and history, FO player panel, UPS 2.0 Release 5, contract authority decision. · Open; production audit needs Keith's go.

**2026-11-21 · finding** · `etl_runs` freshness stamps come from 2 sources only (nflverse refresh, Discord reconcile). · Other jobs never stamp it. · `rg etl_runs` over `pipelines/`, `.github/`, `scripts/`. · AI desk `data.freshness()`, Stats freshness chips, v8 Release 2 "as of" requirement. · Open (P1-6).

**2026-11-21 · finding** · Mac LaunchAgents write production D1 (`src_weekly`, standings) and run from the main checkout at `55ba66be`, 35 commits behind `origin/main`, 7 uncommitted files. · Checkout is not auto-updated. · `~/Library/LaunchAgents/com.upsmfl.live-season-sync.plist`; `git -C ~/Code/MFL/upsmflproduction`. · Standings, scores, Stats, AI history tools. · Open (P0-5, needs go).

**2026-11-21 · finding** · One-time 2026-09-07 deadline-drop LaunchAgent still loaded and running daily (aborts each time). · No completion file written because it never completed. · `com.keith.mfl.deadline-drop`. · League operations (roster writes). · Decision asked of Keith.

**2026-11-21 · finding** · D1 usage on UTC day 2026-11-21: 3,246,351 rows read (64.9% of Free), 28,072 written (28.1%). · Baseline for UPS 2.0 budget planning. · `python3 scripts/d1_usage.py 1d` at 01:18Z 11-22. · Any new D1 consumer (AI desk, League Record, mobile beta). · Recorded.

**2026-11-21 · correction** · A sub-agent reported the salary-adjustment ledger as stale (static file last 10-06). Rechecked: the route reads D1 `ups_drop_events` and uses the static report only for 2025-era details. · `worker/src/index.js:53003-53100`. · AI desk `cap.adjustments`. · Not a risk; recorded so it isn't re-raised.

**2026-11-21 · dependency** · `worker/wrangler.preview.toml` binds the production D1 database id. · Any preview deploy shares production data and budget. · `worker/wrangler.preview.toml:24-26`. · Mobile beta previews, AI desk previews, v8 test-environment decision. · Open question for v8.
