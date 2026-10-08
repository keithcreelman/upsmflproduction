# Incident: a production auth check of `/commish-contract-update` wrote to production (2026-10-07)

**Status:** closed for code. The data correction is prepared and awaiting Keith's approval.

## What happened

While releasing #1186 (contract writes need a proven caller), I sent read-only auth checks to production seconds after the deploy job reported success. Cloudflare rolls a new version out gradually. One check reached an isolate still running the **previous** version (`4c1286cc`), which had no caller check, and that version ran the request.

The request carried `dry_run=1`, a made-up session and a nonexistent player (99999999). In that code a dry run is **not** side-effect-free: it simulates a successful import and then runs the post-import steps for real.

## What it wrote

| Where | What | State now |
|---|---|---|
| **Production D1, `salary_change_log`** | **Row 1876**: `endpoint /commish-contract-update`, `player_id 99999999`, mislabeled `dry_run = 0, landed = 1, notes = import_ok_log_dispatched` by the audit-writer bug below (`import_status 0`) | **Still present, unchanged.** The guarded relabel, together with the 26 older rows with the same false label, is prepared in [`2026-10-08_salary_change_log_dry_run_relabel/`](2026-10-08_salary_change_log_dry_run_relabel/README.md) and runs only on approval. The row is not deleted. |
| Test Discord channel `1089538054236160010` | A "[DRY RUN]" contract card (message `1557486147171647600`) | Left for Keith to delete. I don't delete messages. |
| GitHub `main` (via `repository_dispatch` → `log-contract-activity`) | github-actions commit `38b2bc4e` added an activity row for player 99999999 to `site/rosters/contract_submissions/contract_activity_2026.json` | Reverted by `21a78025` ([keithcreelman/upsmflproduction#1188](https://github.com/keithcreelman/upsmflproduction/pull/1188)). Confirmed live on 2026-10-07: GitHub Pages and raw `main` both serve 159 rows and none for 99999999. |

**Not written:**
- **MFL.** The dry-run branch skips the salaries import (`import_status 0`), and player 99999999 doesn't exist.
- **Any other D1 table.** A read-only sweep of all 42 production tables with a `player_id` column found that player only in `salary_change_log` 1876.

**Correction to my first report:** my first account listed only the Discord card and the activity-log row. Row 1876 was found later on 2026-10-07, during the read-only check that #1188's correction was live.

## Timeline (UTC)

| Time | Event |
|---|---|
| 20:13:12 | #1186 merged (`750b32df`); deploy job 20:13:16 → 20:13:50, reported success |
| 20:13:51.9 | The check reaches an old isolate (`4c1286cc`); the request begins |
| 20:13:55.1 | D1 `salary_change_log` 1876 written; Discord card posted; `log-contract-activity` dispatched |
| 20:14:12 | github-actions commits `38b2bc4e` (activity row) |
| 20:16:16 / 20:16:33 | Revert `21a78025`; #1188 merged |
| later 2026-10-07 | Row 1876 found in D1; the audit-writer bug traced (27 rows) |
| 2026-10-08 | Writer and FCFS fixes; classification and guarded correction prepared |

## Why

1. **Gradual rollout.** "Deploy job green" does not mean every request sees the new code.
2. **The check was not proven safe on the old version.** It was safe on the new version, which refuses it with 401 before anything else. On the old version, `dry_run=1` meant "simulate success, then post to Discord, dispatch the GitHub activity log and write the D1 audit row".
3. **The audit writer mislabeled dry runs.** The three contract routes hard-coded `dry_run: false` and took `landed` from the simulated success. Every dry run since the audit row was added therefore read as a real, landed change: 27 rows, ids 1233–1876. The same writer also sent dry runs to the activity log with `test_flag 0`: 20 timeline entries.

## What changed

- **Writer fixed** (PR `fix/contract-audit-dry-run-2026-10-08`). A dry run is now recorded as one: `dry_run = 1`, `landed = 0`, and a note that no MFL request was made. Its activity-log entry carries `test_flag = 1`, which the Front Office already badges "DRY".
- **The two FCFS repair paths no longer trust the label.** Path B of `close_fcfs_add_event` and `scripts/fcfs_contract_backfill.mjs` count a change-log row as proof of a contract change only if it is an **MFL-confirmed write**: not a dry run, landed, **and** MFL answered with a 2xx `import_status` (`isMflConfirmedWrite`). Every genuinely landed production row has status 200; all 27 mislabeled rows have 0. A read-only check found neither path had acted on any of the 27.
- **Rule for future production auth checks.** A check is sent to production only if it is **proven to stop before any audit or other write path on both the version being replaced and the new one**:
  1. Run the exact request, through the worker harness, against both commits: the one live now and the one being deployed.
  2. Assert zero D1 writes in every table, zero Discord calls, zero GitHub dispatches and zero MFL imports.
  3. Only then send it to production, and repeat it after the rollout settles.
  - `dry_run` is never used as a probe; a dry run has side effects by design.
  - A request whose old-version path is unknown is not sent.
