# Cap-Penalty Data Migration Plan

**Status:** 🆕 NEW (added 2026-05-08). Captures what local-DB data needs to migrate to D1 to enable bot-grounded + worker-driven cap-penalty + cycle workflows.

**Background:** Stage B of the cap-penalty work needs the historical transactions to construct acquisition→drop cycles. Today those transactions live in the local SQLite DB on Keith's laptop (`mfl_database.db`). The local DB is the source for the historical backfill; long-term every consumer of cap-penalty data should read from D1.

---

## Source: `mfl_database.db` table inventory

### Cap-penalty-relevant tables

| Local table | Coverage | Row counts | Migration disposition |
|---|---|---|---|
| `transactions` | 2010-2024 | 285–1,948/year (~21K total) | **Migrate to D1** (`transactions`). Foundational for cycle backfill. |
| `transformed_transactions` | 2010-2025 | 262–1,731/year (~17K total) | **Migrate to D1** (`transformed_transactions`). Clean per-player view with `action` (add/drop/trade/draft); makes cycle pairing trivial. |
| `auction` | 2011-2024 | ~200/year (~2.7K total) | Migrate when bid-sheet/auction tooling moves; subset of transactions for the AUCTION_WON path. |
| `draft` | 2010-2025 (gaps) | 71-480/year | Migrate; needed for rookie-draft acquisition paths in cycles. Note: 2013-2014, 2016-2017 are missing — backfill from MFL API. |
| `trades` | 2010-2024 | 17-469/year (~3.6K total) | Migrate; needed to pair both ends of trades into cycles cleanly. |
| `salary_adjustments` | 2024-2025 only | 229 + 986 | **Cross-validation source** for 2024 cycles. Migrate so the worker can audit live. |
| `salary_adjustments_final` | 2024-2025 | 229 + 986 | Same shape with computed `cap_penalty`, `total_earned` fields; the OUTPUT of an earlier era of penalty math. Migrate. |
| `salary_adjustments_sent` | 2025 only | 42 | Operational log — which penalties have been pushed to MFL. Migrate for audit trail. |
| `cap_penalty_overrides` | all years | small set | **Critical** — manual TAXI overrides etc. Must be respected when computing cycles. Migrate. |
| `dropped_rosters` | EMPTY | 0 | Drop / skip — never populated. |

### Player + roster context (referenced by cycles)

| Local table | Coverage | Migration disposition |
|---|---|---|
| `rosters` | 2010-2025 (~6K rows) | Has empty `contract_info` for 2017-2021. **Pull historical contract_info from MFL API** during backfill; migrate the joined result to D1. |
| `rosters_currentseason` | current | Migrate live (or keep as worker-API-fetched view). |
| `rosters_currentseason_history` | 2025 only | Migrate; will accumulate over time. |
| `rosters_logchange` | 2025 only (469 rows) | Migrate; cycle-state-change source going forward. |
| `players` | all | Player ID → name/team/position lookup. Migrate or read from MFL API. |
| `franchises` | all | Franchise lookup. Already partial in D1 (`discord_owners`). Migrate the canonical mapping if needed. |

### Already migrated to D1

| D1 table | Source local table |
|---|---|
| `discord_owners` | `discord_accountdetails` |
| `league_events` | `league_events` |

---

## Transaction-type taxonomy (from `transactions.transaction_type`)

For cycle pairing in the backfill script, these are the action-bearing types:

| transaction_type | Cycle effect |
|---|---|
| `AUCTION_WON` | Opens cycle (auction acquisition path) |
| `AUCTION_BID` | No cycle effect (just a bid placed; not a roster change) |
| `AUCTION_INIT` | No cycle effect (auction process metadata) |
| `BBID_WAIVER` / `WAIVER` | Opens cycle (in-season WW pickup) |
| `BBID_AUTO_PROCESS_WAIVERS` / `BBID_PROCESS_WAIVERS` / `PROCESS_WAIVERS` | Process-level events; per-player adds appear in `transformed_transactions` as `action='add'` |
| `FREE_AGENT` | Opens cycle (FCFS pickup) OR closes cycle (drop, depending on context). `transformed_transactions.action` disambiguates. |
| `TRADE` | Closes cycle for the giving franchise; opens cycle for the receiving franchise |
| `IR` | NO cycle effect (state-only — player remains rostered with cap relief). Used to populate `player_weekly_active.status='ir'`. |
| `TAXI` | NO cycle effect (per Keith 2026-05-08 — taxi weeks count for earning). Populates `player_weekly_active.status='taxi'` (which still has `counts_for_earning=1`). |
| `LOCK_ALL_PLAYERS` / `UNLOCK_ALL_PLAYERS` / `LOAD_ROSTERS` | League-wide ops; not per-player cycle events |
| `DRAFT_PICK` (in `transformed_transactions`) | Opens cycle (rookie-draft acquisition) |

For backfill, the cleanest source is `transformed_transactions` (action = add | drop | trade | draft). Cycle pairing per `(player_id, franchise_id)` chronologically:
- `add` (any acquisition type) → opens cycle
- `draft` → opens cycle (rookie path)
- `trade` → closes cycle for giving franchise, opens for receiving
- `drop` → closes cycle

---

## Migration phases

### Phase 1 — Cycle backfill (in progress, Stage B)
- Read local DB `transactions` + `transformed_transactions` directly
- Construct cycles via the era-aware calculator
- Write cycles + weekly_active to D1
- **Local DB stays as source** for this one-shot backfill; no intermediate D1 mirror needed for the historical data.

### Phase 2 — Migrate live transaction infrastructure to D1 (later)
- New D1 tables: `transactions`, `transformed_transactions` (mirror local schemas)
- Worker pulls MFL TYPE=transactions periodically OR receives webhooks
- Worker computes new cycles as transactions land (live cycle creation)
- Local DB scripts continue to work but read AND write through D1 going forward

### Phase 3 — Sunset local DB for transaction storage
- Once Phase 2 is stable (all worker live-event paths verified), the local DB becomes a legacy artifact
- Reports + bid-sheet tooling repointed to read from D1
- Local DB kept as a research-archive snapshot

---

## Code that will need repointing in Phase 2/3

(For the future migration — not Stage B work. Surfaces here as a checklist for when we get there.)

| File | What it reads from local DB today |
|---|---|
| `pipelines/etl/scripts/build_salary_adjustments_report.py` | `transformed_transactions`, `rosters_logchange`, `salary_adjustments` |
| `pipelines/etl/scripts/build_contract_history_snapshots.py` | `transactions`, `rosters` |
| `pipelines/etl/scripts/trade_grader.py` | `transactions`, `trades` |
| `pipelines/etl/scripts/build_acquisition_hub_artifacts.py` | (TBD — review when Phase 2 starts) |
| `pipelines/etl/scripts/build_auction_value_model.py` | `auction`, `players`, `scores` |

Plus any worker route or admin endpoint that today fetches MFL data on the fly — those would benefit from reading the D1 mirror.

---

## Cross-validation strategy for cycle backfill

The only year with both transaction history AND `salary_adjustments` data is 2024 (and 2025 partial). The backfill script will:

1. Compute cycles 2010-2024 from `transactions`
2. For 2024 closed cycles, sum cycle.penalty_legacy_usd by (franchise_id) and compare against summed `salary_adjustments.amount` for the same franchise/year
3. Surface discrepancies in a report — Keith reviews
4. For 2010-2023 cycles, no automated cross-check possible. Hand-pick verification (Keith picks 5-10 known drops and verifies against memory).
