# #1307 production execution runbook: src_weekly phases A + B + C (2026-10-21)

**Status: NOT AUTHORIZED.**
- Nothing in this runbook has been run against production. No batch is scheduled.
- Each batch needs Keith's explicit approval: a GitHub comment URL passed to `--approval`.

**Scope:**
- Phases A + B + C from the accepted dry run (PR #1363). Any field that can't be recovered authoritatively is written as NULL.
- Out of scope: phase E, the rank-table / tie rebuild, the 23 unresolved player-seasons, and `win_chunks`.

**Inputs:**
- **Plan:** [`2026-10-21-1307-execution-plan.json`](2026-10-21-1307-execution-plan.json). It records 15 batches, each with its statement-file SHA-256, preimage hash, after-state hash and reconciliation effect.
- **Executor:** `pipelines/etl/scripts/run_1307_src_weekly_batches.py`.
- **Artifacts:** the reviewed dry-run SQL, statements, proposals and the D1 snapshot, plus 90 MFL replies. They live in `~/.ups_jobs/1307_src_weekly/`, which is private and outside this public repo. The executor refuses a batch if any statement file's hash differs from the plan.

## 1. The Free-plan facts the guard is built on
- **Daily reset: 00:00 UTC.** The D1 pricing page says "Free limits reset daily at 00:00 UTC", and over the limit D1 refuses queries. 00:00 UTC is 8:00 PM EDT today, and 7:00 PM EST from 2026-11-01.
- **The limit is per account.** This account has 4 D1 databases, so usage is summed over all of them. In the last 14 days, `ups-mfl-db` did about 75% of the writes.
- **Billing:** an inserted `src_weekly` row bills **4** rows written (table, PK index, `idx_src_weekly_player`, `idx_src_weekly_season`). An UPDATE of the unindexed rank / `pos_group` columns bills **1**. Both were measured on Miniflare D1 in #1363, and they match Cloudflare's rule that indexes add a written row when a write includes the indexed column. The plan's expected count, derived statement by statement, equals the Miniflare measurement for every batch, and the plan builder refuses otherwise.
- **Recent account writes per UTC day** (Cloudflare GraphQL `d1AnalyticsAdaptiveGroups`, control plane, 0 D1 rows read):

  | Day | Writes | Day | Writes |
  |---|---|---|---|
  | 10-14 | 35,921 | 10-18 | 32,345 |
  | 10-15 | 53,252 | 10-19 | 54,259 |
  | 10-16 | 35,966 | 10-20 (Tue) | 73,992 |
  | 10-17 | 30,856 | | |

  The baseline is **not** a steady 40k: Mondays and Thursdays run about 52–54k, and Tuesdays about 74k.
- **The quietest hours are 22:00–23:59 UTC:** the 7-day hourly maximum is 1,087 and 1,106 writes.
  - By 22:00 UTC, 94–98% of the day's writes have already happened. The heavy hours are the 08–17 UTC jobs.
  - So a batch run then can be judged against what the day has actually used, and only about 2,200 more writes are forecast before the reset.

## 2. The guard (every check fails closed)
Before every batch, `apply` re-runs `preflight` and requires all of the following.

1. **Projected usage stays at or under 90,000.**
   `used_today + batch_billed_writes + forecast_rest_of_day ≤ 90,000`, which leaves at least 10,000 of the Free plan's 100,000 unused.
   - `used_today` is the account-wide `rowsWritten` since 00:00 UTC, from GraphQL. If the metrics are unavailable or rate-limited, the batch stops.
   - `batch_billed_writes` counts inserts × 4 plus updates × 1, from the plan.
   - `forecast_rest_of_day` is, for each remaining UTC hour (the current hour in full), the maximum that hour reached in the last 7 complete UTC days.
2. **No unscheduled heavy writer today.** No hour today may already be 5,000+ writes above its 7-day maximum.
3. **Inside the start window.** The batch must start between 22:05 and 23:30 UTC.
4. **No write-heavy job running.** That means no in-progress run of nflverse-stats-refresh, wc-rank-rebuild, mfl-daily-snapshot, nightly-builders, nightly-config-sync, contract-reconcile, ingest-projections, owner-career-stats, roster-anomaly-check, sleeper-cache-build or discord-chat-ingest. It also means no running local live-season-sync, ups-center-auto, deadline-drop, nflverse fetch or `load_local_to_d1`. If the GitHub run list can't be read, the batch stops.
5. **The target weeks still equal the dry-run preimage**, by row count and SHA-256. The preimage is saved to `~/.ups_jobs/1307_src_weekly/preimages/` before any write.
6. **MFL still says the same thing.** For the batch's 3 weeks, `playerScores` and `weeklyResults` must give the same scores and lineups as the cached replies.

During the batch:
7. **Each statement's D1 `meta` must equal its expected value:**
   - an insert of n rows → `rows_written = 4n` and `changes = n`;
   - an update → `rows_written = 1` and `changes = 1`.

   The first deviation stops the batch at that statement. At most one 80-row insert or one 25-update command is affected.
8. **The batch total must equal the planned billed writes.**

After the batch:
9. **The season's playoff weeks must equal the planned after-state** row for row (SHA-256).
10. **The account delta must make sense.** After waiting 12 minutes for the metrics to settle, the account delta minus this batch's writes must be ≤ 3,000, the allowance for quiet-hour jobs. Otherwise: stop, and run no further batch that night.
11. **Another batch the same night** goes back through the guard from step 1 with fresh usage.

## 3. Jobs this does not overlap (inventory, 2026-10-21)
All times UTC. The LaunchAgents run on EDT; they shift +1 h UTC from 2026-11-01, and none of them reaches 22:00–23:59 UTC.

| Job | When (UTC) | Writes |
|---|---|---|
| mfl-daily-snapshot, config-sync, builders, roster-anomaly, contract-reconcile | daily 09:05–09:55 | heavy |
| sleeper-cache-build | daily 10:20 | |
| nflverse-stats-refresh | Mon 05:00, 13:00; Tue 05:00, 12:00, 20:00; Wed 11:00 | heavy |
| wc-rank-rebuild | Tue 10:40 | rewrites a table |
| owner-career-stats | Tue 13:00 | |
| discord-chat-ingest | Tue 11:00 | |
| ingest-projections | Wed 12:00, Fri 12:00, Sun 15:00 | |
| live-season-sync (LaunchAgent) | Tue 05:00, Thu 12:00, Fri 12:00 | heavy |
| ups-center-auto (LaunchAgent) | Tue / Wed 14:00, Thu / Fri 13:00 | |
| deadline-drop (LaunchAgent) | daily 10:00 | |
| auction-reports | 01:00, 13:00 | light |
| Recurring light ticks: worker hourly at :05, */2, */5, 00:05 / 12:05 / 18:05; refresh workflows at :15 / :20; discord-reconcile */30 | all day | ≤ about 1.1k/h at 22–23 |

The window 22:05–23:30 UTC (6:05–7:30 PM EDT; 5:05–6:30 PM EST from Nov 1) contains none of the heavy jobs.

Other sessions' manual imports are not scheduled. The anomaly check (step 2) and the post-batch delta (step 10) are what catch them.

## 4. Batches
All batches are one season each, in this order (most-used seasons first).

| # | Phase | Season | Wks | Inserted | Updated | Billed writes | D1 reads (pre / during / post) | MFL GETs | Preimage (rows, sha256) | After (rows, sha256) | Pts Rk shown before → after | PPG Rk before → after | Rollback changes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | B+C | 2025 | 15–16–17 | 2,664 | 630 | 11,286 | 1,071 / 630 / 3,735 | 6 | 1,071 `42e1ed4dcd50` | 3,735 `85f152adf7a1` | 671 → 1,730 of 1,742 | 384 → 1,203 | 3,294 |
| 2 | B+C | 2024 | 15–16–17 | 2,672 | 615 | 11,303 | 1,061 / 615 / 3,733 | 6 | 1,061 `21c906484ce1` | 3,733 `370312507d63` | 692 → 1,751 of 1,758 | 398 → 1,211 | 3,287 |
| 3 | B+C | 2023 | 15–16–17 | 2,694 | 620 | 11,396 | 1,069 / 620 / 3,763 | 6 | 1,069 `a170ff8eba3f` | 3,763 `5f1318f8c56b` | 675 → 1,739 of 1,743 | 393 → 1,225 | 3,314 |
| 4 | B+C | 2022 | 15–16–17 | 2,613 | 612 | 11,064 | 1,059 / 612 / 3,672 | 6 | 1,059 `1d4be6464663` | 3,672 `f8ea45e5160b` | 692 → 1,743 of 1,743 | 388 → 1,212 | 3,225 |
| 5 | B+C | 2021 | 15–16–17 | 2,749 | 586 | 11,582 | 1,031 / 586 / 3,780 | 6 | 1,031 `d3bd24a5578e` | 3,780 `0ac3c23404ce` | 637 → 1,868 of 1,868 | 353 → 1,222 | 3,335 |
| 6 | A | 2020 | 14–15–16 | 3,605 | 0 | 14,420 | 1 / 0 / 3,605 | 6 | 0 (no rows) | 3,605 `7a657edc127e` | 343 → 1,744 of 1,744 | 86 → 1,250 | 3,605 |
| 7 | A | 2019 | 14–15–16 | 3,529 | 0 | 14,116 | 1 / 0 / 3,529 | 6 | 0 (no rows) | 3,529 `144186aa3580` | 323 → 1,650 of 1,650 | 94 → 1,206 | 3,529 |
| 8 | A | 2018 | 14–15–16 | 3,490 | 0 | 13,960 | 1 / 0 / 3,490 | 6 | 0 (no rows) | 3,490 `08b54e7cd892` | 311 → 1,611 of 1,611 | 68 → 1,183 | 3,490 |
| 9 | A | 2017 | 14–15–16 | 3,466 | 0 | 13,864 | 1 / 0 / 3,466 | 6 | 0 (no rows) | 3,466 `f94b9e924a9a` | 282 → 1,575 of 1,575 | 79 → 1,184 | 3,466 |
| 10 | A | 2016 | 14–15–16 | 3,473 | 0 | 13,892 | 1 / 0 / 3,473 | 6 | 0 (no rows) | 3,473 `e151b7e61c0f` | 278 → 1,580 of 1,580 | 85 → 1,206 | 3,473 |
| 11 | A | 2015 | 14–15–16 | 3,469 | 0 | 13,876 | 1 / 0 / 3,469 | 6 | 0 (no rows) | 3,469 `c49a9fce2a91` | 277 → 1,571 of 1,571 | 89 → 1,213 | 3,469 |
| 12 | A | 2014 | 14–15–16 | 3,466 | 0 | 13,864 | 1 / 0 / 3,466 | 6 | 0 (no rows) | 3,466 `6a0ed57f4661` | 275 → 1,564 of 1,564 | 78 → 1,187 | 3,466 |
| 13 | A | 2013 | 14–15–16 | 3,461 | 0 | 13,844 | 1 / 0 / 3,461 | 6 | 0 (no rows) | 3,461 `e2f2ef57a5a8` | 260 → 1,532 of 1,532 | 58 → 1,180 | 3,461 |
| 14 | A | 2012 | 14–15–16 | 3,445 | 0 | 13,780 | 1 / 0 / 3,445 | 6 | 0 (no rows) | 3,445 `d259db0eeb2b` | 258 → 1,537 of 1,537 | 84 → 1,183 | 3,445 |
| 15 | A | 2011 | 14–15–16 | 3,496 | 0 | 13,984 | 1 / 0 / 3,496 | 6 | 0 (no rows) | 3,496 `5affc462b6af` | 259 → 1,547 of 1,547 | 72 → 1,202 | 3,496 |
| | | | **Total** | **48,292** | **3,063** | **196,231** | 5,301 / 3,063 / 53,583 | 90 | | | | | |

Notes on the table:
- **Full hashes** are in the plan JSON.
- **Reconciliation** columns count player-seasons whose rank basis equals the weekly total, so #1353 shows the rank. These counts are season-wide and exact for that season once its batch is in: a season's playoff weeks are its only missing rows.
- **What stays hidden after each batch:** 2025 has 12 correction-shifted player-seasons, 2024 has 7 duplicate-inflated ones and 2023 has 4 (all out of scope).
- **NULL statuses:** 2011–2017 and the no-lineup teams get the statuses listed in #1363's report.
- **Replay:** all 15 batches were replayed on local SQLite from the D1 snapshot, 15 of 15. Forward produces the planned after-hash, and rollback produces the exact preimage hash.

### Commands, the same for every batch N
Run from a clean checkout of the PR #1363 head, for example its worktree `.claude/worktrees/1307-dry-run-d0f362`. Never use the main checkout, which the Tuesday live sync uses.
```bash
cd ~/Code/MFL/upsmflproduction/.claude/worktrees/1307-dry-run-d0f362
```
```bash
shasum -a 256 docs/data_fixes/2026-10-21-1307-execution-plan.json
```
The output must be `199dcfcfa73d9ac66627da7fbc6c455905a9a59f1198f078e4060dd404943c9c`.
```bash
export PLAN=docs/data_fixes/2026-10-21-1307-execution-plan.json ART=$HOME/.ups_jobs/1307_src_weekly
```
```bash
npx wrangler whoami
```
1. **Usage now** (control plane only):
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py usage --batch-writes <billed writes of N>
   ```
2. **Preflight** (read-only; reads the preimage plus 6 MFL GETs, and saves the preimage):
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py preflight --plan $PLAN --artifacts $ART --batch N --allow-prod-d1-read
   ```
3. **Write.** This runs only between 22:05 and 23:30 UTC. It re-runs the preflight, checks the guard, writes with per-statement meta checks, verifies, waits 12 minutes, then rechecks usage:
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py apply --plan $PLAN --artifacts $ART --batch N --execute --approval <Keith's comment URL for batch N>
   ```
4. **Post-write, independent check:**
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py verify --plan $PLAN --artifacts $ART --batch N --allow-prod-d1-read
   ```
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py usage
   ```
5. **Rollback**, only on Keith's go. It refuses if it could breach the ceiling; then wait for 00:00 UTC:
   ```bash
   python3 pipelines/etl/scripts/run_1307_src_weekly_batches.py rollback --plan $PLAN --artifacts $ART --batch N --execute --approval <comment URL>
   ```

Every `apply` and `rollback` appends a run log to `~/.ups_jobs/1307_src_weekly/runs/`: approval URL, preflight facts, and each statement's SHA-256 plus D1 meta.

### Rollback record per batch
- **A batches (6–15).** The preimage is "no rows in the season's Wks 14–16". It is checked by preflight, which reads 1 row through the `(season, week)` index, and the saved preimage file is empty.
  - Rollback is the reviewed `A_<season>.rollback.sql`: DELETEs of exactly the inserted keys, grouped by week, 400 keys each.
  - It is idempotent: a key that was never inserted deletes nothing.
- **B+C batches (1–5).** The preimage is the season's existing 1,031–1,071 playoff rows, read and saved in full before any write (`preimages/batch_0N_<season>.json`) and matching the dry-run hash.
  - Rollback runs first `C_<season>.rollback.sql`: per-row UPDATEs that restore each changed rank or `pos_group`, but only where the row still holds the value the repair wrote.
  - Then it runs `B_<season>.rollback.sql`: DELETEs of the inserted free-agent / taxi / IR keys.
  - The rollback command finishes by re-reading the season and requiring the preimage hash.
- **Billing assumption:** rollback is budgeted at inserts × 4 + updates, assuming a DELETE also bills its index entries. Miniflare billed 1 per deleted row; production's figure is unmeasured. That is why a same-day rollback can be refused and pushed past 00:00 UTC.
- **Backstop only:** D1 Time Travel restores the whole database, losing everyone else's writes since that point.

### Stop conditions (any one stops the batch, or prevents it)
- Usage metrics unavailable, or rate-limited. GraphQL analytics has a budget: the third call within about a minute was refused here with "try again after 5 minutes". The executor makes one call before and one after each batch.
- Projected daily usage would exceed 90,000.
- Any hour today is already 5,000+ above its 7-day maximum.
- Outside 22:05–23:30 UTC at start.
- A write-heavy workflow or local job is running, or the GitHub run list can't be read.
- A statement file's SHA-256 differs from the plan.
- The target weeks differ from the dry-run preimage (row count or hash).
- MFL's scores or lineups for the batch's weeks differ from the cached dry-run replies.
- Any statement's `rows_written` or `changes` differs from its expected value, any D1 error, or any message about a daily limit.
- The batch's billed total differs from the plan.
- The after-state hash differs from the plan.
- The account delta 12 minutes after the batch exceeds the batch plus 3,000.

After a stop:
- No further batch that night.
- Run `verify` and `usage`, then record the facts on #1307.
- Roll back only on Keith's go.

## 5. Earliest safe windows and the likely calendar
- **Batch 1 earliest:** the first 22:05–23:30 UTC window after Keith approves it, if the guard passes at 22:05.
  - If approval comes today, that is **tonight, Wed 2026-10-21, 22:05 UTC (6:05 PM EDT)**.
  - At 14:16 UTC today the guard read: used 10,242; forecast for the rest of the day 54,506; projected with batch 1 76,034, which is ≤ 90,000.
- **Several batches in one night:** each runs about 20 minutes (6 MFL GETs at 6 s, the writes, verify, a 12-minute settle). So at most about 4 batches start in one window, each re-guarded.
- **Simulated calendar.** Each night was given the same usage by 22:05 UTC as the same weekday last week. The 22:00–23:59 forecast is 2,193.

| Start | Night 1 | Night 2 | Night 3 | Night 4 | Night 5 |
|---|---|---|---|---|---|
| Wed 10-21 (≈ 34.6k used) | 1–4 | Thu (51.3k): 5–6 | Fri (33.8k): 7–9 | Sat (28.9k): 10–13 | Sun (30.2k): 14–15 |
| Thu 10-22 | Thu: 1–3 | Fri: 4–7 | Sat: 8–11 | Sun: 12–15 | |

- **Flat days:** at 40,000 used per night it takes 5 nights; at 55,000 per night it takes 8.
- **Tuesday-like nights** (about 74k used by 22:00 UTC) take one B+C batch at most. A batches (13.8–14.4k) do not fit, so they wait for a lighter night.
- **Not promised:** five nights is not promised. If usage runs high, the guard stretches the calendar and no batch is forced.
- **Per-batch approval:** each batch still needs its own approval URL. Keith can approve several in one comment by listing their numbers. Use that comment's URL for each.

## 6. Not verified
- Production D1's billed counts for these writes. The first statement of batch 1 is the test: if production bills other than 4 per insert, the batch stops after 80 rows. Those rows can be removed by the batch's rollback.
- That the GraphQL `rowsWritten` total includes bulk imports. This plan never uses `--file`: every write is a `--command` with checked meta.
- How the authenticated #1353 panel behaves after the write.

## Approval request: batch 1 only
> **Approve #1307 batch 1:** phases B + C for season 2025, Wks 15–17, from plan `docs/data_fixes/2026-10-21-1307-execution-plan.json` (sha256 `199dcfcf…943c9c`, PR #1363).
> - Insert 2,664 free-agent / taxi / IR rows, all with status proven by MFL.
> - Update 630 existing rows' ranks to the table's rule.
> - Billed writes: **11,286** (inserts × 4 + updates). D1 reads: about 5,436 (1,071 preimage, 630 during, 3,735 verify). 6 MFL GETs.
> - Expected effect: 2025 player-seasons whose rank can show go from 671 to 1,730 of 1,742, and PPG Rk from 384 to 1,203.
> - Earliest window: 22:05–23:30 UTC on the first night after this approval. It runs only if the guard projects ≤ 90,000 account writes for that UTC day and every check in §2 passes.
> - Rollback: on your separate go, `rollback --batch 1`. It restores the saved preimage (1,071 rows, sha256 `42e1ed4dcd50…`) and deletes the 2,664 inserted keys.
> - Nothing else is approved by this: no other batch, no phase E, no rank rebuild.

Reply on #1307 with "approve batch 1" to approve. That reply's URL is what goes into `--approval`.
