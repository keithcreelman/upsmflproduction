# #1307 production execution runbook, v2: Batch 1A only (2026-10-21)

**Status: NOT AUTHORIZED.**
- Nothing in this runbook has run against production, and nothing is scheduled.
- A write needs Keith's approval comment URL passed to `--approval`.

**Plan v2** ([`2026-10-21-1307-execution-plan.json`](2026-10-21-1307-execution-plan.json), sha256 `46ee764f3cdf3af57324e440fb2bc3290d1348be16407d0e946c500d1028ff79`) follows Keith's 2026-10-21 revision: **authoritative scores are separated from disputed ranks.**

| Batch | Status | What |
|---|---|---|
| **1A** | **ready** (needs approval) | Phase B 2025 only: insert the 2,664 playoff-week score rows MFL proves (free agent / taxi / IR). Weekly `pos_rank` / `overall_rank` are **NULL**. |
| 1C | **held** | The 630 updates to 2025 weekly ranks. They wait for the rank-definition review (§2). |
| Everything else | **pending** | B 2021–2024 (10,728 rows), A 2011–2020 (34,900), C 2021–2024 (2,433). The plan holds no executable SQL for them; they will be regenerated after the rank review. |

**Still separate later work:** phase E, the `src_pointssummary` rank / tie rebuild, the 23 unresolved player-seasons, and `win_chunks`.

**Executor and artifacts:**
- Executor: `pipelines/etl/scripts/run_1307_src_weekly_batches.py`.
- Artifacts: `~/.ups_jobs/1307_src_weekly/`, private and outside the public repo.
- 1A's statement file is `out_ranks_null/statements/B_2025.json`, sha256 `f499e9d2b3caf50cc5fb595c393053b39eac20e3c53cae5414bb18ce9fb8253c`. The executor refuses to run if the file differs.

## 1. Why the rank updates (1C) are held, and why 1A writes no weekly ranks
Phase C does **not** touch the season rank table (`src_pointssummary`), where the float-tie defect lives. It changes the **weekly** game ranks in `src_weekly`. Of the 630 2025 changes:

| Count | Cause | Example (before → after) |
|---|---|---|
| 625 | **Tie re-ordering only.** The existing row holds the tie-shared rank (1 + players who scored more); C moves it to a position chosen by numeric player id among the tied scores. | Wk 15, 10814 (PN), 0.0 pts, tied with 241 players: overall 962 → 963, pos 29 → 30. Wk 15, 11769 (DL), 7.5 pts, 14 tied: overall 305 → 307, pos 34 → 35. |
| 14 | Tie re-ordering plus a different position-group mapping. The old route mapped positions by majority vote. | Wk 15, 16586 (QB), 0.0 pts: overall 962 → 1132, pos 34 → 35. |
| 5 | A missing `pos_group` filled; no rank changes. | Wk 15, 7394 (QB): `pos_group` NULL → QB, ranks unchanged. |

- **The choice behind C:** C would replace a tie-sharing convention with an arbitrary id-ordered one, just to match the regular-season rows. That is a rank definition, not a recovered fact, so it is held.
- **The same choice is in 1A's rows:** **2,590 of the 2,664** new rows have a tied score, mostly 0.0. So 1A writes their weekly ranks as **NULL**.
- **Readers:** only the player-bundle Game Log reads weekly ranks, and only to display them. A NULL shows as no Pos Rk on rows that are missing entirely today.
- **Cost of the later fill:** filling those ranks after the review is 1 write per row (2,664 for 2025). That is not counted in 1A.

## 2. Batch 1A: what it changes
- **Source and timing:** MFL `playerScores` for 2025 Wks 15–17, every player MFL scored. Status / team come from the MFL lineup record or a consistent weekly rosters export; 2025's export matches the lineups 100%. NULL status: **0** rows.
- **Season ranks on the player card** (the #1353 rule shows a rank only when `src_pointssummary`'s own basis equals the weekly total):

  | Measure | Today | After 1A | Of the newly showable: equal to a clean recount / differ |
  |---|---|---|---|
  | **Pts Rk** showable (2025, of 1,742) | 671 | **1,730** (+1,059) | 806 / **253** |
  | **PPG Rk** showable (needs ≥ 9 of 17 wks) | 384 | **1,203** (+819) | 483 / **336** |

  - 1A writes **no** rank value. The values that become showable are the ones `src_pointssummary` already stores.
  - The "differ" column is the known rank-table defect: dense ranks on unrounded floats, plus 12 corrected totals shifting the players near them. It is visible once the totals agree.
  - If those values should stay hidden until the rank rebuild, #1353 (the other session's stack) needs a rule change; this write doesn't need one.
- **Phase C would add nothing to these counts:** ranks don't change totals.
- **Still hidden after 1A: every unresolved 2025 player-season (12).** In each, MFL's total differs from the rank table's basis because of stat corrections after the table was built.

  | Player | Rank basis (pts / wks) | After 1A = MFL | Stored rank (Pts, PPG) | Clean recount |
  |---|---|---|---|---|
  | 12772 Eric Murray | 78.3 / 11 | 77.0 / 11 | 108, 72 | 110, 78 |
  | 13688 Marcus Davenport | 18.0 / 7 | 19.0 / 7 | 150, 169 | 148, 166 |
  | 13714 Derwin James | 144.2 / 16 | 143.7 / 16 | 10, 20 | 10, 22 |
  | 13813 Foyesade Oluokun | 135.5 / 16 | 136.5 / 16 | 12, 19 | 11, 18 |
  | 14896 Patrick Queen | 112.0 / 16 | 112.5 / 16 | 24, 34 | 24, 34 |
  | 15914 Malcolm Rodriguez | 7.0 / 6 | 6.5 / 6 | 112, 120 | 113, 122 |
  | 16280 Daiyan Henley | 112.0 / 16 | 112.5 / 16 | 24, 34 | 24, 34 |
  | 16288 Mekhi Blackmon | 98.3 / 16 | 96.8 / 16 | 75, 108 | 78, 110 |
  | 17059 Ollie Gordon | 56.9 / 16 | 57.4 / 16 | 66, 88 | 66, 87 |
  | 17137 Derrick Harmon | 37.0 / 11 | 36.5 / 11 | 117, 139 | 118, 141 |
  | 17200 Jason Marshall | 37.4 / 11 | 36.6 / 11 | 184, 201 | 183, 203 |
  | 17430 Jordan Clark | 8.0 / 3 | 8.9 / 3 | 196, 162 | 190, 155 |

- **Dak Prescott and Jacoby Brissett 2025:** unchanged by 1A. Both were rostered, so their playoff rows already exist.
  - Dak: 409.3 / 16 before and after; rank shown before and after; stored and clean ranks both QB 4 / PPG 5.
  - Brissett: 259.9 / 13 before and after; rank shown; stored and clean ranks both QB 17 / 17.
  - Their earlier seasons (Dak 2016–2019, Brissett 2017–2022 and 2024) are fixed only by later batches, which are pending.

## 3. The guard (fails closed)
`apply` refuses to start unless **all** of these hold:
1. **Projected usage, including the full rollback, stays at or under 90,000.**
   `used_today + forecast_rest_of_day + forward_writes + rollback_reserve ≤ 90,000`
   - **Facts it rests on:** Cloudflare's Free limits reset at **00:00 UTC** and are **account-wide** (4 D1 databases), so `used_today` is every database's `rowsWritten` since 00:00 UTC, from GraphQL `d1AnalyticsAdaptiveGroups` (control plane, 0 D1 rows read).
   - `forecast_rest_of_day`: for each remaining UTC hour (the current one in full), that hour's maximum over the last 7 complete UTC days.
   - 1A: `forward_writes` = 2,664 × 4 = **10,656** (table + PK + 2 indexes, measured on Miniflare D1). `rollback_reserve` = **10,656**: a DELETE is assumed to bill its index entries too. Miniflare billed 2,664 for the rollback, and production's figure is unmeasured, so the reserve takes the worst case.
   - That leaves at least 10,000 unused even if the batch has to be rolled back the same day.
2. **No unscheduled heavy writer today:** no hour today is 5,000+ writes above its 7-day maximum.
3. **Inside the start window, 22:05–23:30 UTC.** That is 6:05–7:30 PM EDT, or 5:05–6:30 PM EST from Nov 1. No scheduled write-heavy job runs then, and the 7-day hourly maximum there is about 1.1k. These jobs are avoided (all times UTC; the LaunchAgents run on local time and shift +1 h from Nov 1, never reaching 22:00–23:59):
   - Daily snapshot / config-sync / builders / roster-anomaly / contract-reconcile: 09:05–09:55.
   - sleeper-cache-build: 10:20. deadline-drop: 10:00.
   - nflverse refresh: Mon 05:00 and 13:00; Tue 05:00, 12:00 and 20:00; Wed 11:00.
   - wc-rank-rebuild: Tue 10:40. owner-career-stats: Tue 13:00. discord-chat-ingest: Tue 11:00.
   - ingest-projections: Wed and Fri 12:00, Sun 15:00.
   - live-season-sync: Tue 05:00, Thu and Fri 12:00. ups-center-auto: Tue and Wed 14:00, Thu and Fri 13:00.
   - auction-reports: 01:00 and 13:00.
   - Light recurring ticks (worker crons, refresh workflows, discord-reconcile) are already inside the forecast.
4. **No write-heavy workflow or local job running.** If the GitHub run list can't be read, it stops.
5. **The 2025 playoff weeks equal the dry-run preimage:** 1,071 rows, sha256 `42e1ed4dcd50…`. The preimage is saved before any write.
6. **Season reconciliation before the write equals the approved before-state.** The exact set of 2025 player-seasons whose Pts Rk / PPG Rk is showable today must be 671 / 384 (set hashes in the plan). This also proves D1's 2025 regular-season rows still match the dry run.
7. **MFL's 2025 Wk 15–17 scores and lineups are unchanged** from the cached dry-run replies.

## 4. Automatic rollback, authorized by the batch approval
- **When it runs:** `apply` restores the preimage at once, with no further approval, when any of these happen:
  - **The billed count differs from plan.** Every statement is checked: an insert of n rows must report `rows_written = 4n` and `changes = n`. So is the batch total, 10,656.
  - **A row- or season-level invariant fails.** That covers any write error, a row-count mismatch, or a playoff-week after-state hash that isn't the plan's `489b6dbe…` (3,735 rows).
  - **The post-batch reconciliation differs from the approved result.** It must give Pts Rk showable = 1,730 and PPG Rk = 1,203 (exact set hashes), and the hidden set must be exactly the 12 above.
- **What it does:** it deletes exactly 1A's inserted keys. That is idempotent, so a key never inserted deletes nothing. It then re-reads the weeks and requires the preimage hash. If the hash doesn't match, it stops and reports the failure to escalate to Keith.
- **Calibration:** 1A's first statement is 80 rows (expected 320 billed). If production bills differently, the batch stops after that one statement. The automatic rollback then removes those 80 rows within the reserved 10,656, which needs about 320 at most. Local replay path 3 below demonstrates it.
- **A batch that verifies successfully is never rolled back automatically.** A discretionary `rollback` needs its own approval URL. It also re-checks that the rollback fits under 90,000.

## 5. Writes, reads and timing for 1A
| Item | Value |
|---|---|
| Rows inserted / updated | 2,664 / 0 |
| Billed writes | **10,656** (+ 10,656 reserved for a full rollback) |
| D1 reads, preflight | 19,604 (1,071 preimage + 16,791 season totals + 1,742 rank basis), by index SEARCH (`EXPLAIN`ed 2026-10-21) |
| D1 reads during writes | 0 (measured) |
| D1 reads, post-verify | 24,932 (3,735 after-state + 19,455 season totals + 1,742) |
| D1 reads if auto-rollback runs | about 9,100 more (Miniflare: 7,990 + a 1,071 re-read) |
| MFL GETs | 6 (6 s apart) |
| Panel check | 8 worker `/api/player-bundle` GETs (per-player D1 reads; unmeasured) |
| Latest permissible start | **23:30 UTC.** Preflight takes about 1.5 min, 34 inserts about 2 min, verify about 0.5 min, and a worst-case auto-rollback about 1 min, so every write lands by about 23:35 UTC, before the 00:00 reset. The 12-minute settle check only reads, and its account delta is measured across midnight. |
| Earliest start | 22:05 UTC on the first night after approval, and only if the guard passes. Tonight that is Wed 10-21 22:05 UTC. Wednesdays used about 35k by 22:00 last week, so the projection would be about 35k + 2.2k + 21.3k ≈ 58.5k. |

**Later batches** are not scheduled and not approved. Each will come with its own approval request after the rank review. With the rollback reserve, a typical night (30–55k used by 22:05) fits 1–2 batches.

## 6. Local replay, from plan v2 (no network)
**1. SQL replay.** Miniflare D1, the production schema and the 1,071-row 2025 snapshot.
- Forward writes **10,656** (0 read).
- A re-run writes **0**.
- Rollback restores the identical hash.

**2. Executor end-to-end** (`apply` / `rollback`). This ran on a local SQLite stand-in for D1 holding all 2025 rows (archive regular weeks + snapshot playoff weeks + `src_pointssummary`), with cached metrics and MFL replies and the clock set to 22:10 UTC:

| Path | Result |
|---|---|
| Clean apply | 34 statements, 10,656 billed; after-hash `489b6dbe…`; reconciliation 1,730 / 1,203 |
| Discretionary rollback | Back to the preimage `42e1ed4d…` (1,071 rows) |
| Calibration billed 5 per row | Stopped after statement 1 (400 ≠ 320); automatic rollback to the preimage |
| One row silently missing | After-state 3,734 ≠ 3,735; automatic rollback to the preimage |
| Regular-season drift (one Dak 2025 score) | Preflight refused (670 / 383 ≠ 671 / 384); nothing written |

## 7. Commands
Run from a clean checkout of the PR #1363 head, for example its worktree. Never use the main checkout, which the Tuesday sync uses.
```bash
cd ~/Code/MFL/upsmflproduction/.claude/worktrees/1307-dry-run-d0f362
```
```bash
shasum -a 256 docs/data_fixes/2026-10-21-1307-execution-plan.json
```
The output must be `46ee764f3cdf3af57324e440fb2bc3290d1348be16407d0e946c500d1028ff79`.
```bash
export PLAN=docs/data_fixes/2026-10-21-1307-execution-plan.json ART=$HOME/.ups_jobs/1307_src_weekly
```
```bash
npx wrangler whoami
```
1. **Usage** (control plane only):
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py usage --batch-writes 10656 --rollback-reserve 10656
   ```
2. **Preflight** (read-only, any time; saves the preimage):
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py preflight --plan $PLAN --artifacts $ART --batch 1A --allow-prod-d1-read
   ```
3. **Write** (only between 22:05 and 23:30 UTC, and only with the approval URL). It repeats the preflight, writes, verifies, rolls back automatically on any invariant failure, then rechecks usage:
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py apply --plan $PLAN --artifacts $ART --batch 1A --execute --approval <URL>
   ```
4. **Post-write:**
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py verify --plan $PLAN --artifacts $ART --batch 1A --allow-prod-d1-read
   ```
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py panel-check --plan $PLAN --batch 1A --allow-prod-read
   ```
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py usage
   ```
5. **Discretionary rollback**, only on a separate approval:
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py rollback --plan $PLAN --artifacts $ART --batch 1A --execute --approval <URL>
   ```

Run logs go to `~/.ups_jobs/1307_src_weekly/runs/`: approval URL, preflight facts, and each statement's SHA-256 plus D1 meta.

**Stop conditions:** any failed check in §3 stops the batch before writing. Any trigger in §4 stops it and rolls back. Two more stop the night, without a rollback, because the batch itself verified:
- usage metrics unavailable (GraphQL rate-limits quick repeat calls);
- an account delta, 12 minutes later, of more than this batch plus 3,000.

## 8. Post-run player-panel verification
1. **`verify`:** the after-state hash, then the full-season reconciliation. Exactly 1,730 Pts Rk / 1,203 PPG Rk showable, with the 12 hidden player-seasons listed above.
2. **`panel-check`:** reads the live worker's `/api/player-bundle` for 8 players. Each player's 2025 `career_summary` row must equal:

   | Player | 2025 pts / wks after | Rank basis | Stored Pts Rk, PPG Rk | Rank shows under #1353 |
   |---|---|---|---|---|
   | 12620 Dak Prescott | 409.3 / 16 (unchanged) | 409.3 / 16 | 4, 5 | yes (already) |
   | 12616 Jacoby Brissett | 259.9 / 13 (unchanged) | 259.9 / 13 | 17, 17 | yes (already) |
   | 17039 Tyler Shough | 91.6 / 7 → 162.6 / 10 | 162.6 / 10 | 28, 29 | yes (new) |
   | 17424 Charlie Smyth | 11.6 / 2 → 60.5 / 5 | 60.5 / 5 | 31, 3 | Pts Rk yes; PPG Rk no (5 < 9 wks) |
   | 14252 Michael Jackson | 91.6 / 13 → 132.3 / 16 | 132.3 / 16 | 21, 38 | yes (new) |
   | 13307 Matt Milano | 36.5 / 9 → 74.0 / 12 | 74.0 / 12 | 46, 45 | yes (new); the clean PPG recount is 46 |
   | 16224 Myles Murphy | 50.0 / 13 → 87.0 / 16 | 87.0 / 16 | 41, 64 | yes (new) |
   | 12772 Eric Murray | 52.8 / 8 → 77.0 / 11 | 78.3 / 11 | 108, 72 | no (MFL stat correction) |

3. **Not verifiable yet:**
   - The hide / show rule exists only in draft #1353 (not deployed), so the phone panel can't show this change until #1353 ships.
   - #1353's preview is a recorded replay and won't reflect it.
   - Authenticated FO behavior and real Safari are unverified.
   - 1A's new rows show no weekly Pos Rk in the Game Log until the rank review (§1).

## 9. Approval request: Batch 1A only
> **Approve #1307 Batch 1A:** phase B for 2025 Wks 15–17 only, from plan sha256 `46ee764f3cdf3af57324e440fb2bc3290d1348be16407d0e946c500d1028ff79` (PR #1363).
> - **Rows:** insert 2,664 playoff-week score rows that MFL proves (free agent / taxi / IR; 0 NULL statuses). Weekly ranks are NULL; no rank value of any kind is written, and 1C is not included.
> - **Writes:** **10,656**, plus 10,656 reserved for a same-day rollback. The guard requires usage + forecast + 21,312 ≤ 90,000.
> - **Reads:** about 44.5k D1 reads, plus about 9.1k only if an auto-rollback runs; 6 MFL GETs; 8 panel GETs.
> - **Window:** start 22:05–23:30 UTC on the first night after approval, only if every check passes.
> - **Effect:**
>   - 2025 Pts Rk showable goes from 671 to 1,730, and PPG Rk from 384 to 1,203.
>   - Of the newly showable stored values, 253 Pts Rk and 336 PPG Rk differ from a clean recount (the known rank-table defect).
>   - 12 player-seasons stay hidden.
> - **Automatic rollback:** on any billing, invariant or reconciliation mismatch. It restores the 1,071-row preimage `42e1ed4d…`.
> - **What this does not approve:** a discretionary rollback after a verified run, 1C, and any other batch.

Reply "approve batch 1A" on #1307. That reply's URL goes into `--approval`.
