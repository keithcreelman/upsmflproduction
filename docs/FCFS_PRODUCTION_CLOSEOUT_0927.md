# FCFS incident — production closeout (2026-09-27)

Durable record of the applied repair. Read this alongside `docs/FCFS_CONTRACTS.md` (the mechanism)
and `docs/FCFS_HOTFIX_RUNBOOK.md` (the procedure this followed).

## Status

**Closed operationally.** The FCFS defect itself is corrected going forward — every FCFS acquisition
the worker now handles gets the canonical $1,000 one-year Vet-WW/Rookie-WW contract, verified by
re-read. Every transaction-proven, approved historical FCFS record within the repair cutoff was
repaired.

**Do not read this as "every historical drop was corrected."** It was not, by design:

* **112** approved rows were repaired successfully.
* **11** rows remain intentionally held:
  * the ten non-WW $2K–$4K rows (Henley 29, E. Wilson 38, Ridley 48, Queen 54, Tucker 78, M. Jones 86,
    Franklin 98, Sherwood 124, Dulcich 132, Hufanga 151) — outside every approved rule class, not a
    defect;
  * Colbie Young (drop 96) — the stored row contradicts itself (`CL 1` vs. `pre_drop_years_remaining
    3`; `penalty_exempt=1` vs. a stored $1,000 penalty and guarantee; computed $0 vs. stored $1,000)
    and needs the full contract event chain for player 17542 before anyone rules on it.
* **19** orphan cycles remain intentionally untouched — no transaction evidence (`src_adddrop` or
  `mfl_historical_transactions`) proves them, so nothing was written or invented for them.

The held rows and orphan cycles are not FCFS repairs silently missed. They are outside the approved
rule, internally contradictory, or unprovable — each for a stated, specific reason, not by omission.

## What ran, and the cutoff that bounded it

```text
FCFS_REPAIR_AS_OF_UTC=2026-09-27T15:12:47Z
plan_sha256=9fca84303c42d9ca76f03de04c03b97ea64cc7744cb0c2934b3ffd622dcdf762
```

The cutoff exists because two dry runs taken minutes apart showed the earned-repair candidate count
moving (107 → 111 → 112) as real waiver activity continued in the live league. `scripts/
full_year_earned_repair.mjs --as-of <cutoff>` freezes the historical repair to drops at or before that
instant; anything after it is excluded from the candidate universe entirely (reported under
`summary.excluded_by_cutoff`, never silently dropped) and is left for the deployed worker's own
future-write path. `--apply` re-derives its own universe with the same cutoff, so more post-cutoff
activity landing between the dry run and the apply call can never move the bound plan — while a new
*pre-cutoff* row still trips the existing plan-drift refusal exactly as before the cutoff existed.

`plan.json` (the exact 112-row plan applied) and its SHA-256 above are the audit trail for what was
sent; the tool refuses `--apply` if a fresh plan under the same cutoff does not hash-equal what was
reviewed.

## What was applied

| Item | Result |
|---|---:|
| Earned repairs (112 rows) | **112/112 applied** |
| — unchanged-columns proof | 156/156 season-2026 rows compared, **0 violations** |
| — protected-column differences | **0** |
| — MFL financial writes | **0** |
| Al-Shaair drop repair (event 141) | **applied** — `ww_under_5k_exempt`, penalty $0, posted $0/NULL, all protected values unchanged |
| Cycle field updates | **652 applied**; independent fresh re-run afterward: 0 updates |
| Cycle INSERT-only creation | **56 applied**; independent fresh re-run afterward: 0 inserts, `periods_without_cycle: 0` |
| Orphan cycles skipped | **19** — no transaction evidence, left untouched by design |
| Ambiguous cycles | **0** |

### Add-event closures

| Event | Player | Result |
|---|---|---|
| 52 | Deshaun Watson | closed as `2`, note reads literally `superseded_by_later_owner_contract` (never `fcfs_contract_verified` — MFL no longer holds the FCFS contract) |
| 75 | Azeez Al-Shaair | closed as `1`, `fcfs_contract_settled_by_drop_repair`, explicitly **not** roster-verified (he is on no roster) |
| 76 | Kendrick Bourne | closed as `1` via a manual `stamp-ww-contracts days:9` call (outside the cron's 7-day look-back); dry-run first (`count: 0`), live call (`fcfs_reconciled: 1, count: 0`), second call proved a no-op (`fcfs_reconciled: 0, count: 0`) — zero MFL writes at any point, since this path only ever touches `ups_add_events` |
| 77 | Troy Franklin | closed as `1` by the normal `*/5` cron before the manual call was needed — `fcfs_contract_verified` |

### Parity proofs (post-write)

* **Cap totals**, all 12 franchises: byte-identical before/after (`diff` on the two snapshots: empty).
* **Dead money** (`SUM(penalty_amount)`, `SUM(posted_amount)` per franchise, season 2026): byte-identical
  before/after.
* **Migrations `0159`/`0160`**: confirmed unapplied (`d1_migrations` query: empty) before and after.
* **Live three-team trade** (`54a0306a-552e-4f79-8d34-98d72eb704a0`): confirmed untouched — `status:
  collecting`, `updated_at_utc` unchanged since 2026-09-23T20:21:41Z.

## `site/reports/salary_adjustments/salary_adjustments_2026.json` — dependency analysis

**Conclusion: the artifact is unaffected by this repair. Regeneration is unnecessary.**

The generator is `pipelines/etl/scripts/build_salary_adjustments_report.py`. Its own earned/penalty
math lives in `prorated_earned_for_drop()`, `earned_before_current_contract_year()`, and the
row-building loop (`build_...` around lines 1280–1610) — but every one of those functions computes
from rows it reads out of a **local SQLite file** (`MFL_DB_PATH`, default `pipelines/etl/data/
mfl_database.db`), never from Cloudflare D1. Its declared source tables
(`REQUIRED_SOURCE_TABLES`) are:

```
transactions_trades · transactions_adddrop · transactions_auction · transactions_base ·
contract_history_transaction_snapshots · dim_franchise · dim_player · draftresults_combined ·
rosters_weekly
```

`grep` of the whole script and its companion SQL (`site/reports/salary_adjustments/
salary_adjustments_sql.sql`) for `wrangler`, `ups_`, `D1`, `workers.dev` and `CLOUDFLARE` returns
**zero matches**. This repair changed exactly four kinds of fields, none of them present in the list
above:

| Changed field | Table | Read by the generator? |
|---|---|---|
| `earned_to_date`, `penalty_basis` | `ups_drop_events` (D1) | **No** |
| `salary_at_acquisition_usd`, `contract_years_at_acquisition` | `player_acquisition_cycles` (D1) | **No** |
| `contract_annotated` | `ups_add_events` (D1) | **No** |
| `pre_drop_contract_status` etc. (Al-Shaair reprice) | `ups_drop_events` (D1) | **No** |

The generator instead re-derives its own earned/penalty figures independently from raw historical
transaction snapshots in a disjoint local warehouse — it was never wired to read D1's operational
columns at all, so there is no path by which this repair's writes could reach it.

This conclusion is also supported empirically: cap totals, dead money, posted amounts and MFL
adjustments are proven byte-identical before and after the repair (above) — the repair changed no
cap-facing figure anywhere, so even a generator that *did* share data would have nothing new to pick up.

`pipelines/etl/data/mfl_database.db` in this environment is a 0-byte stub (dated 2026-08-14). It was
never populated and never run against. If a populated copy of that database exists in an authoritative
ETL environment, running the generator there is unnecessary for this repair specifically — the
analysis above holds regardless of which copy of that database is used, since none of its required
tables were touched.

## Post-deployment observation of the future-write path

No drop or FCFS acquisition occurred after the worker deployed (`2026-09-27T14:50:41Z`) during this
verification window, so the future-write path has not yet been exercised by a real event.

```text
Structurally and behaviorally tested; awaiting first natural post-deployment event.
```

No fake production acquisition or drop was created to force this. **When the next real FCFS
acquisition or qualifying drop occurs**, perform a read-only check confirming:

1. the contract is canonical — $1,000, one year, `Vet-WW` or `Rookie-WW` for an NFL rookie;
2. the add event closes with a verified re-read (`fcfs_contract_verified`), not on faith;
3. a qualifying drop stores `earned_to_date = NULL` with the correct basis, if it is a full-year or
   canon §C3 WW class member;
4. no duplicate stamp or duplicate `ups_contract_gate_audit` row exists for the event.

This observation is informational, not a blocker — the incident is closed regardless of its outcome,
and any finding from it is a new, separate item.

## Related

Kyler Gameday fix: [PR #1127](https://github.com/keithcreelman/upsmflproduction/pull/1127), merge
commit `da7ae833c4487662cff3bfcde5cd443820176495`.
FCFS worker + tooling: [PR #1128](https://github.com/keithcreelman/upsmflproduction/pull/1128), merge
commit `89a4a80d3f6b736d95746d256e9d3fcd12521bd7`.
FCFS client display: [PR #1129](https://github.com/keithcreelman/upsmflproduction/pull/1129), merge
commit `696b1217c1259e4c41b800adf154acbae03c79cf`.
This cleanup: the `--as-of` cutoff feature and this document, in
`fix/fcfs-repair-cutoff-and-closeout` — never merged without separate authorization.
