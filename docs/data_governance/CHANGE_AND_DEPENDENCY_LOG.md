# Data change-and-dependency log

One entry per data change, finding or decision that can affect other work. Newest first. Keep entries short; link the evidence. Agent entries are status, not Keith rulings. A Keith ruling is recorded only with a link to where he gave it.

Format: **date · type** (finding / change / decision / dependency) · what · why · evidence · work that may be affected · status.

---

**2026-11-22 · change (draft #1504, head `2a7eb821`)** · Keith's ruling, relayed by the backlog fork, revises his every-PR blocking rule. The PR backtest is now pinned to reviewed snapshot days (`REVIEWED_THROUGH = 2026-11-21`, which must be a committed date).
- Reviewed counts 1/27/5/2 still fail on change; new days are left to the nightly `roster-anomaly-check`.
- That removes the dependency that let an unreviewed flag block unrelated PRs or the trade-bot cutover. Bot checks are untouched.
- Mutation-proven; CI PASS (run 45012422587); local 276/0.
- **Reporting gap stated plainly:** the nightly check reports by a red scheduled run, `::error` lines and a JSON artifact. Only GitHub's own failed-run notice reaches anyone (delivery unverified). An alert step is P0-3, not built.
- The fork merges. · #1504. · All PRs' CI, trade-bot cutover. · Ready for the fork.

**2026-11-22 · change / risk** · #1501 merged (`c1ad9d4e`, 10:13:07Z) by the backlog fork on Keith's go in its chat; this session merged nothing. #1504 was retargeted to `main` with main merged in (`b1ff3110`); its earlier red was `twr_merge_state` on the stacked base.
- **Coupling risk, recorded on #1504:** the cutover gate runs the full safe suite on `origin/main`. With #1504, a new flagged roster day would block trade-bot snapshot delivery. Options A/B/C are on the PR; B (pin the backtest to reviewed snapshots) is recommended but needs Keith.
- **Plan (the fork's, per Keith):** merge #1504 only after the Week 11 snapshot is delivered and loaded.
- **Watching:** BL-I33, the first scheduled J3 run after #1501; BL-A12, `snapshot_weeks` reaching 11.

· #1504 comment 7077672843. · Trade grading, all PRs' CI. · Open.

**2026-11-22 · audit record** · Keith's verbatim approval for the cutover plist change, the #1508 merge and the #1506 closure is posted with the clock order on #1399 (comment 7077605181) and #1503 (comment 7077605341). It is this session's own evidence; the message was typed into this session's chat. Its arrival is bounded between 03:41:35Z and 03:46:35Z; the exact time is not available. It is not retroactive approval from another session. #1501 and #1504 are not merged by this session; the backlog fork will relay the merge go. · Audit trail. · #1508, #1506.

**2026-11-22 · verified** · First real cutover after the fix **succeeded** at 04:20Z (launchd exit 0).
- CI passed 275/0 on `4bd2b0b3`.
- Pull `55ba66be → 4bd2b0b3`, with 208 runtime files unchanged.
- Bot restarted as pid 77983, on the snapshot as of 2026-11-18, Week 10.
- 0 held trades retried or posted. 1793273314 still needs a person.

The job closed #1399. The shared main checkout is now even with `origin/main`, which also addresses BL-I01's "35 commits behind". **Open:** Week 11 snapshot delivery before the 11-25 deadline (unverified until it happens). · #1399 comment 7074125588. · Trade grading. · Watch the next delivery.

**2026-11-22 · change (Mac + merge, on Keith's direct go in chat)** · Trade-bot snapshot cutover (#1399, BL-A12/BL-I01).
- **Cause:** under the launchd PATH, `python3` was Apple 3.9.6 (`/opt/homebrew/bin/python3` does not exist), and the job's temp worktree path has a space. 11 + 3 test failures, the "13 failures on main" alert; `main` itself passes.
- **Changes:**
  - plist PATH now starts with `~/.local/share/mise/shims`. Backup `…cutover.plist.BACKUP-2026-11-22`, sha256 `aa1a7e62…`. Reloaded 03:47:35Z.
  - #1508 merged as `4bd2b0b3` (3 tests made space-safe; CI passed; no deploy triggered).
  - #1506 closed as a duplicate of #1504; its one unique fact (52 of 212 pre-fix days) was carried over.
- **Trades since 11-18:** 0 held or missed (MFL export 03:36Z 11-22). 1793273314 stays on human review.
- **Blocker stays open** until a real cutover run succeeds. · #1399, #1503, #1508. · Trade grading around the 11-25 deadline. · Awaiting the ~04:17Z run.

**2026-11-22 · change (draft #1504, head `20608580`)** · On Keith's recommendation, the backtest is now two checks:
- **(a) Reviewed baseline:** flagged days must equal `KNOWN_FLAGGED_DAYS` exactly, with drop counts 1/27/5/2. An unlisted day fails. A listed day that stops flagging or changes count also fails; that half is this session's addition.
- **(b) Noise limit:** the separate 10% limit.

Mutation-tested (an unlisted day and a changed count both fail, exit 1); local safe suite 276/0. **Consequence:** daily snapshot commits to `main` mean a real new flagged day turns every PR's safe-tests red until it is reviewed and recorded. **Follow-up validation after merge (open):** record the first scheduled `roster-anomaly-check` run (expected green, or red only on a reviewed real event). 2026 cut-penalty charges stay unverified. · #1504, #1503. · All PRs' safe-tests. · Draft; CI pending on this head.

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
