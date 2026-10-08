# Relabel of 27 mislabeled dry-run rows in `salary_change_log`: prepared, NOT applied

**Status: APPLIED 2026-10-08 on Keith's approval** (all 27 rows, Tier B included, and the 20 timeline entries). Exact steps, restore point and per-row before/after: [`RESULTS.md`](RESULTS.md). It was prepared and tested against the exact production rows (`tests/salary_change_log_relabel_plan.test.mjs`). No row was deleted.

**Why:** until the audit-writer fix, `/commish-contract-update`, `/offer-mym` and `/offer-restructure` logged every **dry run** as a landed change. The row read `dry_run = 0`, `landed = 1`, `notes = import_ok_log_dispatched`, with `import_status = 0` (no MFL request) and the after-fields copied from before. There are 27 such rows, ids 1233–1876; 1876 is the 2026-10-07 auth-check probe. See `../2026-10-07_contract_route_probe.md`.

**Did anything act on them? No** (read-only check, 2026-10-08).
- Both FCFS repair paths, the worker's `close_fcfs_add_event` (path B) and `scripts/fcfs_contract_backfill.mjs`, have acted exactly once on the change log: add event 52, on 2026-09-27.
- That closure used rows 1865 and 1875. Both are real, MFL-confirmed (status 200), and neither is among the 27.
- None of the 27 rows' players has an FCFS add event.
- The full FCFS audit trail is three entries, all on 2026-09-27.

## Files

| File | What it is |
|---|---|
| `classification.md` / `classification.json` | Each row, its evidence and its tier. 22 rows are Tier A (a record of the request's own mode survives). 5 are Tier B: 1238 and 1264–1267, proven by the code path and by MFL's later reads. |
| `verify_code_path.py` | Re-runs the 13 code-path checks on every worker version live when a row was written (exit 0 = all hold). |
| `build_sql.py` | Regenerates the five SQL files from `classification.json`. |
| `01_verify_before.sql` | Read-only. All 27 rows in their exact original state, and no other row carrying the label. |
| `02_apply_tier_a.sql` / `03_apply_tier_b.sql` | Per row, two guarded statements: (1) an audit record in `ups_contract_gate_audit` (field `salary_change_log_dry_run_relabel`) with the complete original row as JSON, the new values and the evidence; (2) an update of only `dry_run`→1, `landed`→0 and `notes` (original text kept, explanation appended). Both run only while the row is still in its exact original state, and the update also needs the audit record to exist. Re-running is a no-op. |
| `04_verify_after.sql` | Read-only. Relabeled; exactly one audit record each; no other column changed (compared with the stored original); no false label left; rows 1865/1875 untouched. |
| `05_rollback.sql` | Restores the exact original values from the audit records; the records are kept and marked `_rolled_back`. |
| `activity_log_entries.json` / `activity_log_relabel.py` | **Separate proposal.** 20 of these dry runs also appear on the Front Office activity timeline as real activity. The script sets `test_flag = 1` on exactly those entries, which shows the existing "DRY" badge, and changes nothing else. Check mode by default; `--apply` refuses unless all 20 are in their expected state. |

## Order (each step is Keith's call)

1. **First, release the writer fix** (the PR that adds this folder), so no new mislabeled rows are written.
2. **Verify before** (read-only). Expect 27 rows, each `in_original_state = 1` and `audit_records = 0`.
   ```bash
   npx wrangler d1 execute ups-mfl-db --remote --config worker/wrangler.toml --file docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/01_verify_before.sql
   ```
3. **Tier A** (22 rows):
   ```bash
   npx wrangler d1 execute ups-mfl-db --remote --config worker/wrangler.toml --file docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/02_apply_tier_a.sql
   ```
4. **Tier B** (5 rows), separately:
   ```bash
   npx wrangler d1 execute ups-mfl-db --remote --config worker/wrangler.toml --file docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/03_apply_tier_b.sql
   ```
5. **Verify after** (read-only). Expect:
   - (1) every corrected row `dry_run 1`, `landed 0`;
   - (2) `n` = the rows corrected, `dupes 0`;
   - (3) no rows;
   - (4) `n 0` after both tiers (5 after Tier A only);
   - (5) 1865 and 1875 unchanged.
   ```bash
   npx wrangler d1 execute ups-mfl-db --remote --config worker/wrangler.toml --file docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/04_verify_after.sql
   ```
6. **If needed, roll back:** `05_rollback.sql`.
7. **Activity log** (separate approval):
   - run `python3 docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/activity_log_relabel.py` to check;
   - then run it with `--apply` and commit the one-file change through a PR.

Run all commands from the repo root.
