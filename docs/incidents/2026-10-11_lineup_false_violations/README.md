# 2026-10-11 — 48 false §G3 lineup violations voided

**Classification:** data discrepancy, caused by a fix-class bug (PR #1220). **Approved:** Keith, 2026-10-11 ("I approve correcting the 48 false violations from Weeks 1–4"). **Applied:** 2026-10-11 23:34:38Z (7:34 PM ET), one guarded D1 transaction.

## What was wrong
- `ups_lineup_violations` held one row per franchise for every week 1–4 of 2026: 48 rows, all `voided=0`, `offense_no` 1–4. That put every team at offense #4.
  - 44 rows said "Only 0 of 18 starting slots filled".
  - 0004 week 1 said 16 of 18, 0008 week 1 said 15 of 18, and 0004 week 3 said 17 of 18.
  - 0004 week 4 named two starters as OUT. Both were actually week-4 **non**-starters.
- **Cause:** the end-of-week booking (~05:05 UTC Tuesday) read `TYPE=playerRosterStatus` without `W=`. MFL had already rolled to the next week's mostly-unset lineup.
- **Evidence the rows are false:**
  - MFL `weeklyResults&W=1..4` shows 18 starters for all 12 teams every week (re-read 2026-10-11 23:3xZ).
  - A replay through the repo's own evaluator, using each week's real lineup plus the D1 injury ledger, found **no** violation in weeks 1–4.
- **Impact:** none reached an owner. Nothing read the table: no notice, no penalty, no page.

## What was done (`02_void_false_rows.sql`)
1. **Restore point:** D1 time-travel bookmark `0000f04a-00000000-00005101-6ec9425c0e5622da1cf35122a55992ab`, plus the full table pre-image (`preimage.json`, 48 rows, every column).
2. **Proof the rows still matched the known false state**, done twice:
   - offline, against the first audit read (fid, week, `recorded_at_utc`, reasons, `offense_no = week`, unvoided, no review flag);
   - in-transaction guards:
     - row count = 48;
     - all 48 match the exact `(fid, week, recorded_at_utc)` tuples;
     - Σ`length(reasons_json)` = 6164.
3. **Void, not delete:** `voided=1`, with a `void_reason` that cites this evidence and PR #1220, `voided_by` = Keith's approval, and `voided_at_utc` = `2026-10-11T23:34:38Z`. `reasons_json` and `offense_no` are kept untouched as evidence.
4. **Post-guards in the same transaction:** exactly 48 rows carry this void stamp, 0 rows remain live, and Σ`length(reasons_json)` is unchanged. Any guard failing rolls back the whole file. This was rehearsed on SQLite with three tampered states, and each was caught and fully rolled back.

## Verified after (read-only)
- 48 rows, the same keys. **Only** the four void columns changed on any row (diff against `preimage.json`).
- **Per franchise:** 0 live, 4 voided, for all 12 teams. The season ladder (counts unvoided rows) is **0 for every team**. Re-deriving offense numbers touches only live rows, of which there are none.
- **Unrelated tables unchanged:**
  - `ups_lineup_dm_log` 278;
  - `ups_lineup_sat_announce_log` 4;
  - `ups_injury_polls` 1021;
  - `ups_injury_status` 3878;
  - table count 210;
  - the guard table was dropped.

## Rollback
`05_rollback.sql` (guarded, not run), or the time-travel bookmark above.

## Follow-ups
- **#1220:** books from `weeklyResults&W=` at the final kickoff, refuses zero-starter lineups, and refuses more than 4 bookings per week.
- **#1221:** commissioner ruling ledger, so a booked row is never itself an offense.
