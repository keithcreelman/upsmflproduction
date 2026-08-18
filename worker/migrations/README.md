# Migrations

**The tracker is current. `wrangler d1 migrations apply` is the correct way to apply migrations.**

```bash
cd worker && npx wrangler d1 migrations apply ups-mfl-db --remote
```

---

## Read this if you see a "NEVER run migrations apply" warning

Sixteen migration files carry a header saying *"NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts."* **That warning was true when written and is now obsolete.** It is left in place because those files are history and history should not be quietly rewritten — but do not act on it.

### What was wrong

`d1_migrations` on the remote DB had stopped being written around **0056**, while migrations kept being applied by hand with `d1 execute --file`. The schema ran ~55 migrations ahead of the ledger. Anyone running the tracker would replay everything from 0057, which is why the warning existed.

### What happened on 2026-08-17

The tracker was run. It replayed **0057–0072** and then halted at 0073 on `duplicate column name: contract_end_year` — the ledger's own inconsistency stopping it.

**Nothing was corrupted.** Verified afterwards:

- `ups_extension_master` — 621 rows, **0 duplicate keys**. The unique index on `(league_id, season, player_id)` would have rejected a genuine re-insert and never fired.
- The extension backfills (0063 / 0064 / 0071) are **`ON CONFLICT … DO UPDATE`, written to be re-runnable**. Their conflict blocks are fill-only:
  ```sql
  new_salary      = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  evidence_grade  = CASE WHEN ...evidence_grade='evidenced' THEN 'evidenced' ELSE 'derived' END
  ```
  Salary, status, term and evidence grade cannot be overwritten — only NULLs get filled, and an evidenced row can never be downgraded by derived data.
- The only unconditionally-written fields are `franchise_id` and `updated_at_utc`, and 0070/0072 (the franchise corrections) re-ran immediately after in the original order, so `franchise_id` lands where it did the first time.

The one gap that cannot be closed retroactively: a **hand-edit to an extension row made after June 2026** would have been reverted. Nothing indicates one exists.

### The reconciliation

Every migration from 0073–0127 was checked against the live schema — table, index and column presence, with index ownership resolved by `tbl_name` rather than by name (see the gotcha below). Fifty were already applied. Four were not, and were applied:

| | |
|---|---|
| **0074** | 5 missing indexes on `ups_mym_submissions` — the table had none at all |
| **0075** | 3 missing indexes on `ups_transactions`, incl. `idx_txn_unposted`, which the Discord poster scans |
| **0118** | 419 all-zero rows pruned from `nfl_player_weekly_ext` |
| **0126** | 2026 extension deadline `2026-10-07` → `2026-10-08` (the real Week 5 kickoff) |

Then all 55 were written to `d1_migrations`, and `migrations list --remote` returned **"No migrations to apply!"**

## Gotcha: SQLite index names are database-global

Not per-table. `CREATE INDEX IF NOT EXISTS idx_foo ON my_table(...)` is a **silent no-op** if *any* table already owns an index called `idx_foo`.

That is a real bug in 0075: its `idx_txn_type` collided with an index of the same name on `mfl_historical_transactions`, so it never created one on `ups_transactions` — on any run, ever. Fixed by **0130** under `idx_ups_txn_type`. 0075 is left as written.

Prefix index names with the table (`idx_ups_txn_*`, not `idx_txn_*`) so this cannot happen again.

## House rules

- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` so a migration is safe to re-run.
- Data migrations should be idempotent: `ON CONFLICT … DO UPDATE`, or an `UPDATE` whose `WHERE` stops matching once applied (0126 does this deliberately — the guard is not decoration).
- `ALTER TABLE … ADD COLUMN` is **not** re-runnable and will halt a run the way 0073 did. Keep those in their own migration so a failure cannot strand a larger batch.
- Applying by hand is still fine, but **log it** afterwards or the ledger drifts again:
  ```sql
  INSERT OR IGNORE INTO d1_migrations (name) VALUES ('00NN_your_migration.sql');
  ```
