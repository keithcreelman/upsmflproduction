# FCFS hotfix — production correction runbook

**Status: PREPARED, NOT EXECUTED.** Branch `fix/fcfs-contract-stamping`, cut from `origin/main` (`122b3fb6` when it was cut — step 1 re-checks). It carries only the FCFS work: no Trade War Room UI or authorization, **no migrations** (`0159` / `0160` are not part of it; `worker/migrations/` still ends at `0158`), no execution ledger, no cap gate, no three-team cancel, no extension work, no admin-routing refactor. It is independently deployable: the one new route, `POST /admin/drops/full-year-repair`, is protected by the same commissioner-key check (`sessionByApiKey`) as its `/admin/drops/*` siblings, and it needs no new table (`ups_contract_gate_audit` is created on first write by the route itself; `ups_bot_heartbeat` and `ups_auction_contract_finalizations` already exist).

## How to read this

* Every step is marked **READ** (touches nothing) or **WRITE** (publishes or changes production). **A WRITE step needs Keith's explicit go — that includes steps 3 and 5: merging to `main` publishes the site and deploys a worker that writes MFL contracts.** The contract-change gate applies to all of it: canon → dry run → show Keith → confirm → commit + memory note.
* The counts (118 candidates / 107 planned / 11 held / 652 cycle updates / 56 cycle inserts …) are a **2026-09-26 snapshot**. Live drops and adds move them. A difference is not a failure, but it must be **explained row by row before Keith approves** (a new drop row, a new FCFS add). Never approve a plan nobody has read.
* Every `--apply` is **bound to the plan that was reviewed** (`--plan` / `--reviewed-updates`): if the fresh plan differs by a single action, it refuses before sending anything.

Set the shell once. The commissioner key is read from the macOS Keychain *inside* each command and is never echoed or written to a file:

```bash
export W="https://upsmflproduction.keith-creelman.workers.dev"
export OUT="$HOME/fcfs_correction_$(date +%Y%m%d)"     # evidence + rollback files live OUTSIDE the repo; never reuse a sub-directory
mkdir -p "$OUT"
K() { security find-generic-password -s ups-commish-api-key -w; }
d1() { (cd worker && npx --yes wrangler d1 execute ups-mfl-db --remote --json --command "$1"); }     # READ helper — only ever pass a SELECT
```

## The twelve steps

| # | Step | Type | Expected |
|---|---|---|---|
| 1 | Confirm the latest `origin/main` | READ | `122b3fb6…` and "up to date". If `main` moved: `git merge origin/main` into the branch, resolve, then repeat steps 2 and 6 in full. |
| 2 | Validate the isolated branch | READ | all green; the only failures in the full sweep are the four that also fail on `origin/main`: `leaderboard_cache_ttl`, `leaderboard_precompute`, `lineup_compliance`, `lineup_wiring` |
| 3 | Deploy the future-write worker fix | **WRITE** | `deploy-worker.yml` green. No migration, no `wrangler.toml` change. |
| 4 | Verify the FCFS path is live | READ | both flags true · `fcfs_rule: "canon_a5_2026-09-26"` · a blank fixture would be priced `$1,000 / Vet-WW / 1 / CL 1\| TCV 1K\| AAV 1K` |
| 5 | Deploy the display changes | **WRITE** | mobile build `2026.09.26.1` live · Front Office `?v=2026.09.26.v1.37.0` |
| 6 | Run the 2026 earned repair in dry-run mode | READ | 118 candidates · **107 planned (98 class-1 + 3 legacy + 6 WW earned-n/a)** · 11 held · server dry run `{"would_apply":107}` |
| 7 | Review the exact affected fields | READ | Keith approves the plan |
| 8 | Apply the approved earned repair | **WRITE** | 107 × `applied` · `report.success: true` · `unchanged_proof.ok: true` · exit 0 |
| 9 | Al-Shaair's drop repair, then the add-event closures (Al-Shaair 75, Watson 52) | **WRITE** | drop event 141 → `ww_under_5k_exempt`; add event 75 → `1`, 52 → `2`; penalty / dead money / cap charge unchanged |
| 10 | Reconcile, then regenerate and complete `player_acquisition_cycles` | **WRITE** | reconciliation balanced (708 = 652 + 56 · 671 = 652 + 19) · 652 guarded UPDATEs · 19 skipped · **56 guarded INSERTs (2025)** |
| 11 | Verify everything | READ | the checklist below |
| 12 | Re-run every dry-run / verification tool | READ | exit 0 · `remaining_actions: 0` · `unchanged_proof.ok: true` · top-level `updates: 0` |

### Step 1 — confirm the latest `origin/main` (READ)

```bash
git fetch origin && git rev-parse origin/main
git merge-base --is-ancestor origin/main HEAD && echo "up to date"
```

### Step 2 — validate the isolated branch (READ)

```bash
for f in fcfs_contract fcfs_contract_display full_year_earned_repair fcfs_cron fcfs_cycles_etl; do node tests/$f.test.mjs 2>&1 | tail -1; done   # FCFS suites (fcfs_contract_display added 09-27 when the test file split for the PR A / PR B release)
for f in cap_penalty_canon cap_penalty_preview_integration completed_payable_weeks front_office_earned_authority; do node tests/$f.test.mjs 2>&1 | tail -1; done   # drop rule + FO earned authority
python3 scripts/check_mobile_build.py && node scripts/check_inline_js.mjs && node scripts/check_mfl_paste_safety.mjs && python3 scripts/build_rulebook_data.py --check
(cd worker && npx --yes eslint@9 src/ && npx --yes wrangler deploy --dry-run --outdir "$OUT/wrangler_dry")
for f in $(git diff --name-only origin/main..HEAD | grep -E '\.(m?js)$'); do node --check "$f" || echo "BAD $f"; done
git diff --check origin/main..HEAD && git diff --check
for f in tests/*.mjs tests/*.js; do [ -f "$f" ] && { node "$f" >/dev/null 2>&1 || echo "FAIL $f"; }; done      # full sweep — compare with the four baseline failures above
```

### Step 3 — deploy the worker fix (WRITE — Keith's go)

Upstream is deliberately unset on the branch so nothing can push to `main` by accident.

```bash
git push -u origin fix/fcfs-contract-stamping
gh pr create --base main --head fix/fcfs-contract-stamping
```

Review, then merge (Keith). The merge starts `deploy-worker.yml` and the Pages deploy together.

### Step 4 — verify the FCFS path is live (READ)

```bash
# (a) the flags — a dry run BYPASSES them, and with either flag off nothing stamps and nothing alerts
d1 "SELECT value FROM ups_settings WHERE key='feature_flags'" | jq -r '.[0].results[0].value | fromjson | {ADD_TRACKER_ENABLED, WW_CONTRACT_STAMP_ENABLED}'      # both true

# (b) the deployment discriminator — read-only (dry_run is in the body AND the query)
curl -s -X POST "$W/admin/adds/stamp-ww-contracts?L=74598&YEAR=2026&dry_run=1&APIKEY=$(K)" -H 'content-type: application/json' \
  -d '{"season":"2026","league_id":"74598","dry_run":true}' | jq '{fcfs_rule, count, needs_input_count, rows: [.rows[]? | {player_id, rule, bid_dollars, salary, contractStatus, contractYear, contractInfo}]}'
```

* `fcfs_rule` must be **`"canon_a5_2026-09-26"`**. An old worker returns `null`; a 403 / 500 / 503 pre-flight refusal carries no `fcfs_rule` — that is a refusal, not an old worker.
* If any rostered contract is blank, it appears in `rows` with `rule:"fcfs_canon_a5"`, `bid_dollars:1000`, `salary:"1000"`, `contractStatus:"Vet-WW"`, `contractYear:"1"`, `contractInfo:"CL 1| TCV 1K| AAV 1K"` — and **never** as `needs_input: no_bid_establishable`. (The dry-run body has `rows`; the per-row `fcfs_outcomes` list exists only on a real run.)
* **Live proof:** the next FCFS window (Sunday after the 9 AM run, from Week 1). Within one tick the pickup's MFL row reads salary 1000 · `Vet-WW` · year 1 · the canonical contract info; `ups_add_events.contract_annotated = 1`; one `ups_auction_contract_finalizations` row with `source = 'fcfs'`; no DM. A DM "Blank contract needs review" means a rule could not decide — read it. The same fixture is proven end to end, cron tick included, by `tests/fcfs_cron.test.mjs` (step 2).

### Step 5 — deploy the display changes (WRITE — same merge as step 3)

Mobile build **`2026.09.26.1`** (`site/m/version.json`, `app.js` `BUILD`, `index.html` `app.js?v=` / `front_office_penalty.js?v=` / `cap_math.js?v=`); Front Office `front_office.js?v=2026.09.26.v1.37.0`. **No MFL header change is needed** — the embed loaders cache-bust with `Date.now()`.

```bash
curl -s https://keithcreelman.github.io/upsmflproduction/m/version.json | jq -r .build      # 2026.09.26.1
```

Deploy order is harmless either way: a new client against the old worker keeps the old numeric earned (the client only rewrites the *pre-batch local estimate*, never a row the worker has answered); an old client against the new worker renders the new `null` earned as `$0` — never a weekly amount. Penalties are identical in every combination.

### Step 6 — earned repair, dry run (READ)

```bash
node scripts/full_year_earned_repair.mjs --out "$OUT/earned_dry"                          # reads D1 + MFL; writes only into $OUT
UPS_COMMISH_API_KEY="$(K)" node scripts/full_year_earned_repair.mjs --server-dry-run --season 2026 --out "$OUT/earned_srv"    # the worker re-proves every row with dry_run:true; nothing is written
```

### Step 7 — review the exact affected fields (READ)

* `$OUT/earned_dry/earned_rows_dryrun.csv` — one row per candidate: player, franchise, contract type, TCV, AAV, term, drop date, current / proposed earned **and basis**, penalty, the canonical **computed penalty**, dead money, cap adjustment posted, the class **proof** (or the reason it is held), and `repair_kind` / `approved`.
* `$OUT/earned_dry/plan.json` — the exact before-state each write is guarded by. **Three kinds**: `clear_full_year_earned` (98 — earned → NULL only), `reconcile_legacy_guarantee_basis` (3 — earned → NULL and basis `tcv_under_5k_guarantee` → `full_year_1k_contract`: rows 32, 33, 40), `clear_ww_earned_na` (6 — earned → NULL and basis `ww_under_5k_exempt` → `ww_under_5k_earned_na`: rows 116, 117, 122, 131, 136, 140).
* `report.summary.financial_reconciliation` — for **every** planned row: penalty before = after, dead money before = after, posted cap before = after, protected columns identical, the stored penalty equals the canonical computation, `mfl_financial_writes_proposed: 0`. `report.summary.approvals` — nothing planned-but-unapproved, nothing approved-but-unproven.
* **11 held rows.** 10 `hold_for_ruling` (the non-WW $2K–$4K deals: they keep their earned figure and their actual per-week rate) and **1 `hold_conflict` — Colbie Young (drop 96): the stored row contradicts itself** (contract text `CL 1| TCV 1K| AAV 1K`, `pre_drop_tcv` $3,000, 3 years remaining, $1,000 penalty flagged exempt). The reconciliation refuses it fail-closed; it needs its own ruling and is never written by this tool.
* Rows 149 (Carter), 150 (Kolar) and 151 (Hufanga) are the drops of the 2026-09-26 13:00Z waiver run — they were not in the reviewed list; 149 / 150 prove into class 1 by the same rule, 151 is a held non-WW $3K deal. **Keith accepts or excludes 149 / 150 before step 8**: exclude with `--exclude 149,150` on the dry run (they become `hold_excluded`, never planned) — and pass the SAME `--exclude` to the `--apply` (the plan is bound to the reviewed one: a different plan is refused).
* `$OUT/earned_dry/rollback.sql` — the exact reverse of the plan (earned, and the basis for the two basis kinds), each guarded on the AFTER state.

### Step 8 — apply the approved earned repair (WRITE — Keith's go)

Snapshot first (**the cap-totals file must have 12 lines — an empty file would pass a diff vacuously**):

```bash
curl -s "$W/roster-workbench?L=74598&YEAR=2026" | jq -r '.teams[] | [.franchise_id, .summary.cap_total_dollars, .summary.salary_adjustment_total_dollars] | @tsv' | sort > "$OUT/cap_before.tsv"
wc -l "$OUT/cap_before.tsv"
d1 "SELECT franchise_id, COUNT(*) n, SUM(penalty_amount) pen, SUM(COALESCE(posted_amount,0)) posted FROM ups_drop_events WHERE season='2026' GROUP BY franchise_id ORDER BY franchise_id" > "$OUT/dead_before.json"
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/step8_started_utc.txt"
```

Apply, **bound to the reviewed plan** (refuses if the fresh plan differs):

```bash
UPS_COMMISH_API_KEY="$(K)" node scripts/full_year_earned_repair.mjs --apply --yes --season 2026 --plan "$OUT/earned_dry/plan.json" --out "$OUT/earned_apply"
```

`--apply` REQUIRES `--plan` (the tool refuses without it, before reading or sending anything), the plan is compared on id, KIND, expected before-state AND after-state, and combining `--apply` with `--server-dry-run` / `--verify` is refused. The exit code is non-zero for a partial apply or a failed proof.

### Step 9 — Al-Shaair's drop repair, then the add-event closures (WRITE — Keith's go)

```bash
node scripts/fcfs_contract_backfill.mjs --season 2026 --out "$OUT/fcfs_dry"        # READ: plan_proposed_after_state.json + rollback.sql; report.json (zero-period classes, anomalies, closures)
UPS_COMMISH_API_KEY="$(K)" node scripts/fcfs_contract_backfill.mjs --apply --yes --season 2026 --plan "$OUT/fcfs_dry/plan_proposed_after_state.json" --out "$OUT/fcfs_apply"
d1 "SELECT id, penalty_basis, penalty_amount, posted_to_mfl, posted_amount, earned_to_date FROM ups_drop_events WHERE id=141"      # ww_under_5k_exempt, 0, 0, NULL, NULL
d1 "SELECT id, player_id, contract_annotated, notes FROM ups_add_events WHERE id IN (52,75,76,77) ORDER BY id"
```

The plan is **dependency-ordered** and holds three actions: (1) `reprice_unstamped_fcfs_drop` 141 (Al-Shaair — 13 columns change; penalty $0 · dead money $0 · `posted_to_mfl` 0 / `posted_amount` NULL · `guaranteed_amount` NULL · `applies_to_season` 2027 stay), (2) `close_fcfs_add_event` 75 (**depends on (1)** — sent only after it landed; the route also refuses it until the repair's audit row exists), (3) `close_fcfs_add_event` 52 (Watson: canonical stamp `salary_change_log` 1865 → the owner's `/offer-mym` conversion 1875). Closure states: **75 → `1`** with a note that it is **not roster-verified** (a dropped player is on no roster), **52 → `2`** ("a described contract is never reverted"). **Bourne (76) and Franklin (77) need nothing here**: MFL holds exactly the canonical contract for both, so the stamper's reconcile step closes them to `1` on its next tick after step 3 (or by the optional manual call in step 11, item 7).

**If the dry run shows `blocked: conflict_penalty_would_change`, stop and report — do not apply.** If Keith withholds this step, skip it: step 12 then reports the pending actions (drop event 141 and add events 75 / 52), and that is the expected residual.

### Step 10 — reconcile, then regenerate and complete `player_acquisition_cycles` (WRITE — Keith's go)

```bash
# READ: nothing is written. Read reconciliation.md FIRST — the UPDATE plan is approvable only when it balances; exits 1 if the second-run proof fails
python3 pipelines/etl/scripts/backfill_cycles_pass2.py --fcfs-acquisition-fields --simulate --out "$OUT/cycles_dry"
cat "$OUT/cycles_dry/reconciliation.md"        # 708 periods = 652 matched + 56 without a cycle · 671 cycles = 652 matched + 19 orphans · ambiguous 0 · updates approvable: True
# WRITE (a) the 652 UPDATEs, bound to the reviewed updates.sql (refuses a differing plan, an offline snapshot, an unbalanced reconciliation; the run's own timestamp is not drift)
python3 pipelines/etl/scripts/backfill_cycles_pass2.py --fcfs-acquisition-fields --simulate --apply --yes --reviewed-updates "$OUT/cycles_dry/updates.sql" --out "$OUT/cycles_apply"
# READ: the 56 missing 2025 cycles — INSERT-only, one guarded row each
python3 pipelines/etl/scripts/backfill_cycles_pass2.py --fcfs-create-missing --out "$OUT/cycles_create_dry"
# WRITE (b) the 56 INSERTs, bound to the reviewed inserts.sql (each is `… WHERE NOT EXISTS (natural key)`; refuses a differing plan and --input-dir)
python3 pipelines/etl/scripts/backfill_cycles_pass2.py --fcfs-create-missing --apply --yes --reviewed-inserts "$OUT/cycles_create_dry/inserts.sql" --out "$OUT/cycles_create_apply"
```

Every `--apply` here refuses BEFORE any read or write when `--yes`, the reviewed file or an online snapshot is wrong, reads the reviewed `updates.sql` / `inserts.sql` BEFORE the run writes anything, and refuses a reviewed file that is inside the new `--out` (use a NEW `--out` every time). `--pair --apply` is refused unless `--full-pair-delete-and-reinsert` is given — do not give it. Outputs: `reconciliation.json/.md/.csv`, `cycles_before.json`, `cycles_after.json`, `updates.sql` / `inserts.sql`, `rollback.sql`, `plan_rows.json` / `insert_rows.json`, `summary.json`. The creation plan touches **no existing row** (proved: `existing_rows_untouched: true`, second run 0 inserts, identical), never reaches into 2026, and ends a period only from a later same-season drop by the same franchise (38 closed, 18 open with `end_not_proven_by_ledger`). **Never `--pair --apply` on this table** — it DELETEs every `backfill_pass2%` cycle and re-INSERTs it, which would duplicate the cycles passes 3 / 4 enriched in place. The 2025 rows carry no drop-side financials (NULL) and the note `needs_pass3_enrichment`.

### Step 11 — verify everything (READ)

1. **MFL contracts** of the FCFS players — Bourne 13418 and Franklin 16619: `salary` 1000, `Vet-WW`, year 1, `CL 1| TCV 1K| AAV 1K`. **Watson 13113 is `Vet-MYM` (3 years, $1K a year, GTD 1K) — his owner converted the canonical contract on 2026-09-26 13:20Z (`salary_change_log` 1875); that is correct and is never overwritten.**
   ```bash
   curl -s "$W/api/mfl-export?L=74598&YEAR=2026&TYPE=salaries" | jq '.salaries.leagueUnit.player[] | select(.id=="13113" or .id=="13418" or .id=="16619")'
   ```
2. **Earned rows** — 11 (the held rows; fewer only if Keith ruled on some):
   ```bash
   d1 "SELECT COUNT(*) n FROM ups_drop_events WHERE season='2026' AND earned_to_date IS NOT NULL AND pre_drop_tcv BETWEEN 1 AND 4000"
   d1 "SELECT penalty_basis, COUNT(*) n FROM ups_drop_events WHERE season='2026' AND penalty_basis IN ('full_year_1k_contract','ww_under_5k_earned_na','tcv_under_5k_guarantee') GROUP BY penalty_basis"
   ```
   `tcv_under_5k_guarantee` must be gone (its three rows are now `full_year_1k_contract`); `ww_under_5k_earned_na` 6.
3. **Penalties, dead money and cap adjustments unchanged.** The authoritative proof is the tool's `unchanged_proof` (step 8) plus this D1 diff — it must print `IDENTICAL`:
   ```bash
   d1 "SELECT franchise_id, COUNT(*) n, SUM(penalty_amount) pen, SUM(COALESCE(posted_amount,0)) posted FROM ups_drop_events WHERE season='2026' GROUP BY franchise_id ORDER BY franchise_id" > "$OUT/dead_after.json"
   diff "$OUT/dead_before.json" "$OUT/dead_after.json" && echo IDENTICAL
   ```
   The MFL-side smoke check reads live MFL (`Cache-Control: max-age=60` — wait a minute after the last write) and moves with unrelated adds, trades and drops, so a difference must be **explained, not assumed to be ours**:
   ```bash
   curl -s "$W/roster-workbench?L=74598&YEAR=2026" | jq -r '.teams[] | [.franchise_id, .summary.cap_total_dollars, .summary.salary_adjustment_total_dollars] | @tsv' | sort > "$OUT/cap_after.tsv"
   diff "$OUT/cap_before.tsv" "$OUT/cap_after.tsv" && echo IDENTICAL
   ```
4. **Drop history** — the per-row read is D1 (`/admin/drops/inspect` returns neither `earned_to_date` nor `posted_amount` and is capped at 30 rows across seasons):
   ```bash
   d1 "SELECT id, player_id, penalty_amount, penalty_basis, earned_to_date, posted_to_mfl, posted_amount, applies_to_season FROM ups_drop_events WHERE season='2026' ORDER BY id" > "$OUT/drops_after.json"
   ```
5. **The audit reconciles with the writes** — 98 + 3 + 6 = 107 earned repairs, 1 reprice, 2 closures; every `_ABORTED` count 0. A count below the number of `applied` results means a write landed unaudited — stop and report:
   ```bash
   d1 "SELECT field, COUNT(*) n FROM ups_contract_gate_audit WHERE field LIKE 'full_year_clear_earned%' OR field LIKE 'legacy_guarantee_reconcile%' OR field LIKE 'ww_earned_na_clear%' OR field LIKE 'fcfs_reprice_unstamped_drop%' OR field LIKE 'fcfs_add_event_closed%' GROUP BY field"
   ```
6. **Cycles** — NULL-salary FCFS cycles 671 → **19**; canonical (`1000` / `1`) 652 + the 56 created = **708**; the created rows carry the source tag `fcfs_narrow_create_2026_09_26`:
   ```bash
   d1 "SELECT SUM(salary_at_acquisition_usd IS NULL) null_salary, SUM(salary_at_acquisition_usd = 1000 AND contract_years_at_acquisition = 1) canonical, SUM(source = 'fcfs_narrow_create_2026_09_26') created FROM player_acquisition_cycles WHERE acquisition_path='fcfs'"
   ```
7. **The incident's own completion ledger.** All four incident add events (Watson 52, Al-Shaair 75, Bourne 76, Franklin 77) start at `contract_annotated = 3` ("refused"); after step 9 Al-Shaair is `1` (settled by the drop repair — **not roster-verified**) and Watson is `2`, with a note that literally reads `superseded_by_later_owner_contract` — **never** `fcfs_contract_verified` (MFL no longer holds the FCFS contract; that string is reserved for a roster-verified canonical contract, which Watson's no longer is). Bourne and Franklin close to `1` by the cron's reconcile step, **but only inside its 7-day look-back** — by the time this runs they may be outside it. To close them — **optional WRITE, Keith's go** — every one of the following six conditions must hold, in order:
   ```bash
   d1 "SELECT id, player_id, franchise_id, contract_annotated FROM ups_add_events WHERE season='2026' AND source='fcfs' ORDER BY id DESC LIMIT 8"
   ```
   1. **Dry-run first:**
      ```bash
      curl -s -X POST "$W/admin/adds/stamp-ww-contracts?L=74598&YEAR=2026&APIKEY=$(K)" -H 'content-type: application/json' -d '{"season":"2026","league_id":"74598","days":30,"dry_run":true}' | jq '{fcfs_reconciled, fcfs_outcomes, count, needs_input_count}'
      ```
      Read the output before the live call runs.
   2. **Exactly those expected events identified** — `fcfs_reconciled` names Bourne (13418) and Franklin (16619) and **no one else**; if a third id appears, stop and read it before going further (something else drifted into the 30-day window).
   3. **No salary write when MFL already holds the canonical contract** — `count: 0` (`rowsToWrite.length`) proves nothing blank was found to stamp; the live call writes to MFL **only** for a genuinely blank rostered contract, exactly as the cron does — never to move an already-canonical one.
   4. **Event closure only after a verified re-read** — the shared stamp path re-reads MFL after any write (`verification`) and only writes `contract_annotated = 1` (note `fcfs_contract_verified: …`) for a player whose re-read matches the canonical contract exactly; a re-read that does not match stays open, not closed on faith.
   5. **The live call, then a second call that is a no-op:**
      ```bash
      curl -s -X POST "$W/admin/adds/stamp-ww-contracts?L=74598&YEAR=2026&APIKEY=$(K)" -H 'content-type: application/json' -d '{"season":"2026","league_id":"74598","days":30}' | jq '{fcfs_reconciled, count, verified_count}' | tee "$OUT/bourne_franklin_live.json"
      curl -s -X POST "$W/admin/adds/stamp-ww-contracts?L=74598&YEAR=2026&APIKEY=$(K)" -H 'content-type: application/json' -d '{"season":"2026","league_id":"74598","days":30}' | jq '{fcfs_reconciled, count, verified_count}' | tee "$OUT/bourne_franklin_second.json"
      ```
      Expected first call: `fcfs_reconciled` names Bourne and Franklin, `count: 0`. Expected second call: `fcfs_reconciled: []`, `count: 0` — both events are already `contract_annotated = 1`, so there is nothing left to reconcile.
   6. **Audit output retained** — keep the dry-run response, both live-call responses, and a before/after `SELECT` of the two `ups_add_events` rows under `$OUT`, the same paper trail every other FCFS write keeps.

   **Watson is not reconciled by this call** (MFL no longer holds the FCFS contract — that is why step 9 closes him through the audited route), and **Al-Shaair is never reconciled by it** (he is on no roster).
8. **Screens** — Front Office and the roster workbench (the phone app shows only the penalty — no Earned / PER WK column): a `$1K`-a-year player shows EARNED `Full-year rule` and PER WK `1K Per Yr`; a one-year WW deal of $2K–$4K shows EARNED `Not applicable` and PER WK `2K Per Yr` / `4K Per Yr`; a non-WW $2K–$4K deal still shows its number and its actual per-week rate (a $4K Vet-FAA reads $235, **not** `1K Per Yr`); the player-profile popup and Team Operations "Earned to Date" agree; a taxi $1K-a-year rookie shows its numeric earned everywhere.

### Step 12 — the "zero actionable rows" proofs (READ)

```bash
node scripts/fcfs_contract_backfill.mjs --verify --out "$OUT/verify_fcfs"
node scripts/full_year_earned_repair.mjs --verify --against "$OUT/earned_apply/dataset_before_state/drops.json" --out "$OUT/verify_earned"
python3 pipelines/etl/scripts/backfill_cycles_pass2.py --fcfs-acquisition-fields --simulate --out "$OUT/verify_cycles"
python3 pipelines/etl/scripts/backfill_cycles_pass2.py --fcfs-create-missing --out "$OUT/verify_create"
```

* **FCFS backfill `--verify`** — exit 0. If step 9 was withheld it exits 1 with `N action(s) still pending`; that is the expected result **only** when the pending actions are exactly the Al-Shaair repair (drop event 141) and the add-event closures (75 and 52).
* **Earned repair `--verify --against`** — `verify.ok: true`, `remaining_actions: 0`, `unchanged_proof.ok: true`. Only the rows the reviewed plan listed may differ, only in the columns their kind names (earned; earned + basis for the legacy and WW-n/a kinds) and ending on the planned values; the row step 9 repriced may additionally differ in exactly its 13 columns. A violation on `posted_to_mfl` / `discord_posted` of an unrelated row means live activity landed between the snapshots — read it, do not dismiss it.
* **Cycles** — the meaningful numbers are the **top-level `updates: 0`** (fields) and **`summary.planned_inserts: 0`** (create): nothing left to write. `second_run.*` is 0 even before step 10 ran, so it proves idempotence, not completion. `reconciliation.md` must still say `balanced: True`, with **0** periods without a cycle in seasons 2011–2025. Use a **new** `--out` each time: re-using one overwrites the before-state.
* Anything a tool lists that was not in the reviewed plan is a *new* item (a new drop, a new add), not a failure of this correction.

## Rollback

| What | How |
|---|---|
| **Worker change** | one revert commit on `main` → `deploy-worker.yml` redeploys in ~30 s (`npx wrangler rollback` also works). Contracts the worker already stamped on MFL stay — they are the canonical contract, and removing one would recreate the blank-contract defect. |
| **Display changes** | the same revert — shipped as a **new** mobile build number (e.g. `2026.09.27.1`, never the old string), or already-updated phones would keep the newer bundle. |
| **Earned repair (step 8)** | `$OUT/earned_dry/rollback.sql`: one guarded `UPDATE ups_drop_events SET earned_to_date = <old>[, penalty_basis = '<old>'] WHERE id = <id> AND earned_to_date IS NULL[ AND penalty_basis = '<new>'];` per row, the exact reverse (guarded on the AFTER state). **Keith reviews and runs it** — `(cd worker && npx wrangler d1 execute ups-mfl-db --remote --file "$OUT/earned_dry/rollback.sql")`; no tool runs it. The `ups_contract_gate_audit` rows stay as history. |
| **Al-Shaair repair + add-event closures (step 9)** | `$OUT/fcfs_dry/rollback.sql` — restores the 13 drop columns (guarded on `penalty_basis = 'ww_under_5k_exempt'`) and sets each closed add event back to `contract_annotated = 3` with its previous `annotated_at_utc` / `notes` (guarded on the closed state AND the closure note). Reviewed and run by Keith. |
| **Cycles (step 10)** | (a) `$OUT/cycles_dry/rollback.sql` — 652 statements restoring `NULL, NULL` and the previous `updated_at_utc`, guarded on the canonical values. (b) `$OUT/cycles_create_dry/rollback.sql` — 56 single-row `DELETE … WHERE <natural key> AND source = 'fcfs_narrow_create_2026_09_26'` statements (they can only ever delete a row this pass created). Reviewed and run by Keith. |

Keep `$OUT` until Keith signs off — it is the only copy of the before-states and the rollback scripts.

## What the hotfix changes outside FCFS (deliberately, and worth knowing)

* **The blank-contract DM covers every blank rostered contract the WW stamp could not decide** (a BBID with no bid, no waiver evidence), not only FCFS. The previous behaviour was a log line, and a blank contract is never a success. It is sent once per distinct batch, with a 24-hour reminder.
* **The post-write verification re-read** (a retry after a short wait) is in the shared stamp path, so BBID stamps get it too.
* **Every drop of a `$1K`-a-year contract from now on stores `earned_to_date` NULL**, and the §D2a retirement settlement derives "actually paid" from the stored schedule when earned is NULL (tested).

## Known limits (reported, not silently accepted)

* The cron looks back **7 days**. An FCFS row that stays retryable or needs-review longer loses its FCFS identity for the *cron* (it stays visible to the manual route with `days: 30` and to the inventory tool). The escalation DM fires long before that.
* The candidate filter treats a `contractYear` of `0` as "MFL described it"; the classifier calls that state `zero`. Those rows are never stamped and never alerted by the cron — the inventory tool lists all 89 (all historical), each classified (58 transaction-proven · 1 superseded · 30 conflicting evidence · 0 insufficient), and leaves the 189 unverifiable closed-season gaps unchanged.
* A player dropped while his FCFS contract is still unresolved is priced `contract_unstamped_needs_review` at drop time (the Al-Shaair class); the after-the-fact `reprice_unstamped_fcfs_drop` route action is the cover.
* The client `isOneKPerYearPlayer` / `isWwEarnedNaPlayer` helpers only ever adjust the **pre-batch local estimate**; once the worker's row arrives, the worker decides. The profile popup and Team Operations use `UPS_CAP_MATH.isOneKPerYear` / `isWwEarnedNa`, which mirror the worker's proofs (every AAV tier, every year, a complete schedule; a blank `contractYear` is never "final year").
* The PER WK label `1K Per Yr` no longer prints for a TCV ≤ $4K contract that is not $1K a year (it is class-based now). `site/reports/salary_adjustments/salary_adjustments_2026.json` is a static era-at-time ETL report of 2025 contracts and keeps its earned figures: its generator needs the full local ETL database and a live MFL feed, neither of which exists in this environment, so it was **not** regenerated and must not be hand-edited.

  **Required post-repair step (do not skip, do not hand-edit):**
  1. Apply only the production repairs Keith has approved (steps 8–10) — never regenerate against a partially-applied state.
  2. Regenerate `salary_adjustments_2026.json` through its normal ETL environment (the full local ETL database plus a live MFL feed) — never by hand.
  3. Diff the regenerated file against the pre-repair copy and verify every changed row is an approved consequence of steps 8–10 (a cleared `earned_to_date`, a rebased legacy/WW basis, Al-Shaair's repriced drop) — nothing else.
  4. Never hand-edit the file, before or after regeneration.
  5. If any row changes that is **not** a traceable consequence of the approved repairs, stop and roll back the regeneration (restore the pre-repair copy) rather than publish an unexplained diff.
* Colbie Young (drop 96) is held on THREE self-contradicting fields, none of which the drop repair may resolve on its own: (1) `contract_length` is 1 but `pre_drop_years_remaining` is 3 — a one-year contract cannot have three years left; (2) `penalty_exempt` is set (1) but the stored `penalty_amount` and `guaranteed_amount` are both $1,000 — an exempt row should carry $0; (3) the canonical rule computes $0 from the stored `CL 1` while the stored penalty is $1,000. **Source needed to resolve it:** the full contract event chain for player 17542 (Colbie Young, franchise 0003) — `src_contracts` / `ups_add_events` / `salary_change_log` — read chronologically from his rookie acquisition forward, per [[feedback_trace_contracts_back_in_time]], to establish whether `CL 1` or `years_remaining = 3` is the stale value; the single `contractInfo` snapshot cannot resolve it alone. The ten non-WW $2K–$4K rows keep their earned figure until Keith rules on them.
* The stamper's roster-based reconcile cannot close an add event whose player was dropped (Al-Shaair) or whose canonical contract was converted by its owner (Watson): both go through `close_fcfs_add_event` (step 9), which is an audited D1 step and NOT a roster verification.

## After the hotfix merges

The Trade War Room integration branch must merge `origin/main`. Its earlier FCFS commits (`0005680f`, `14326f33`, `d623d176`) overlap this work — resolve every conflict **in favour of the hotfix** (the class-narrowed rule, the generalized route, the plan-bound tools, the `2026.09.26.1` mobile build) and re-bump its own mobile build above it. That branch dispatches `/admin/*` through an exact-match **generated route table** (`node scripts/build_admin_route_table.mjs`): **regenerate it after the merge**, or `/admin/drops/full-year-repair` will not be routed there.

### Mobile build sequencing with the Gameday hotfix

The Kyler Murray Gameday fix (`fix/gameday-player-status-kyler`, PR #1127) independently bumped the mobile build to `2026.09.26.2`; this branch bumped it to `2026.09.26.1`. The Gameday PR lands first. Once it merges:

1. `git fetch origin main` and confirm the new `origin/main` sha.
2. `git merge origin/main` into `fix/fcfs-contract-stamping`. Resolve `site/m/version.json`, `site/m/app.js` and `site/m/index.html` by **preserving both** sets of client changes — the Gameday season/week-scoped injury-override logic AND this branch's class-based `1K Per Yr` / `Not applicable` labels — never by reverting either side.
3. Bump all three mobile build stamps consistently to a version newer than both (`2026.09.27.1` if done the same day) — never reuse either branch's old string.
4. Re-run `python3 scripts/check_mobile_build.py`, the full FCFS test suites, and `tests/gameday_player_status.test.mjs` — the merge must leave both fixes' tests green.
