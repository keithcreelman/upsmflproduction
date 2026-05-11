# Current Work Handoff — for resuming via Dispatch / fresh Claude session

**Last updated:** 2026-05-09 (during active work; update as we go)

**One-line status:** ✅ Pass 2 cycle backfill written to D1 (10,497 cycles, 2011-2024). Next is Pass 3 — financial enrichment from MFL contract_info (TCV, contract_type, GF flag, weeks_active).

---

## How to resume

1. Read this file end-to-end.
2. Read `docs/league_context_v1.md` Section 6.B (current cap-penalty rule) and the **2019 cap-penalty system overhaul** subsection in Section 4.
3. Read `docs/cap_penalty_data_migration_plan.md` (long-term migration plan).
4. Run `cd /Users/keithcreelman/Code/MFL/upsmflproduction && git status` to see uncommitted state.
5. Pick up from "Next 3 actions in order" below.

---

## Project: cap-penalty cycle backfill (Stage B of multi-stage work)

**Why we're doing this.** May 2026 the league passed three rule changes: taxi flexibility, true pro-rated salary depreciation, captain-based realignment. The pro-rated rule means cap penalties are now computed per-week-active. To support this AND give owners side-by-side "old rule vs new rule" comparison on every historical cut, we need:

- An era-aware calculator (✅ DONE — Stage A, committed)
- A `player_acquisition_cycles` table in D1 with one row per ON→OFF round per (player_id, franchise_id) (table exists, empty)
- A historical backfill of all cycles since 2011 (✅ Pass 2 STAGED to JSON, awaiting D1 write)
- Financial enrichment pulled from MFL contract_info (Pass 3 — not started)

### Three rule eras (per `docs/league_context_v1.md`)

| Era | Effective | Rule |
|---|---|---|
| `era_pre_2019_flat` | 2010 → 2018 NFL season | 20% × salary remaining; loaded contracts use a "target_total - actual_paid" correction (handled in calc) |
| `era_2019_calendar_monthly` | 2019 NFL season → 2026-05-07 | 75% TCV guarantee, calendar-month earning (25/50/75 Oct/Nov/Dec), flat 35% WW |
| `era_2026_05_08_per_week` | 2026-05-08 → present | 75% TCV guarantee, per-completed-week pro-rated, uniform across paths |

### Where each piece is

| Piece | Location | State |
|---|---|---|
| Era-aware calculator (Python) | `pipelines/etl/lib/cap_penalty.py` | Committed `2a3b1f1`. 17/17 simulator tests pass. |
| Era-aware calculator (JS mirror) | `worker/src/lib/cap_penalty.js` | Committed. Mirrors Python parity. |
| Simulator | `pipelines/etl/scripts/simulate_cap_penalty.py` | Committed. 17 hand-crafted test scenarios. |
| Migration 0028 (4 D1 tables) | `worker/migrations/0028_cap_penalty_cycles.sql` | Committed + applied to remote D1. Tables empty. |
| NFL season calendar seed (2010-2027) | seeded into D1 | Applied. 18 rows. |
| Cap-penalty rule eras seed | seeded into D1 via migration | Applied. 3 rows. |
| MFL transactions API client | `pipelines/etl/lib/mfl_transactions.py` | **UNCOMMITTED** — local only. Parses MFL `TYPE=transactions` into canonical events. |
| Pass 2 backfill orchestrator | `pipelines/etl/scripts/backfill_cycles_pass2.py` | **UNCOMMITTED** — local only. Pulls + pairs cycles. |
| Pass 1 backfill (local DB based) | `pipelines/etl/scripts/backfill_cap_penalty_cycles.py` | **UNCOMMITTED** — superseded by Pass 2. Keep for diff comparison. |
| Migration plan doc | `docs/cap_penalty_data_migration_plan.md` | **UNCOMMITTED** — describes long-term migration of transactions/trades/etc. to D1. |
| Staged canonical events (14 years) | `/tmp/mfl_canonical_events_<year>.json` | 14 files, 22K canonical events. Re-pull is idempotent. |
| Staged Pass 2 cycles | `/tmp/cycle_backfill_pass2_cycles_all.json` | 10,497 cycles ready for D1 write. |

### Current Pass 2 stats (last run 2026-05-09)

```
closed cycles:                9,360
still open (current rosters): 1,137
inferred expirations:           425
inferred from overlap:          425
data gaps flagged:              777    (concentrated 2011-2016, MFL data quality)
unmatched drops:              1,125    (mostly pre-2017 carryover)
overlapping warnings:           113
```

### Spot-checks Keith verified (✅ all pass with Pass 2)

- **Owen Daniels** (player_id=8339): Bousquet 2011 → expired 2012-03-01; C-Town 2012 auction → traded → Pure Greatness → Blake Bombers (the trades local DB lost). 10 cycles total, ZERO data gaps.
- **Ray-Ray McCloud** (player_id=13641): All 8 cycles 2021-2024 match the official history page exactly.
- **Case Keenum** (player_id=10948): All 9 cycles 2017-2023 match. Note: parser bug found + fixed (BBID_WAIVER uses 3-field `<adds>|<bid>|<drops>` format, was treated as 2-field).

---

## Stage timeline (full project)

- **Stage A — calculator + simulator** ✅ DONE (committed 2a3b1f1)
- **Stage B — cycle backfill**
  - B1-B3: D1 schema + seeds ✅ DONE
  - B4: Pass 1 backfill (local DB) → Pass 2 (canonical MFL) ✅ Pass 2 staged
  - B5: Spot-checks ✅ DONE
  - B6: Compare local-DB vs canonical (deferred — not blocking)
  - B7: Write Pass 2 to D1 ✅ DONE — 10,497 cycles in `player_acquisition_cycles`, source='backfill_pass2_2026_05_09'
  - **B8: Pass 3 — financial enrichment** ← WE ARE HERE
    - Pull MFL `TYPE=rosters` per (year, league_id) for `contract_info` strings
    - Parse contract_info → `salary_at_drop`, `tcv_at_drop`, `contract_type`, `contract_years_remaining`, `original_tcv_usd`, `actual_paid_total_usd`
    - Detect GF flag from contract_info (`GF` substring)
    - Re-run calculator on closed cycles with full financials → populate `earned_legacy_usd`, `penalty_legacy_usd`, comparison columns
    - For weeks_active: derive from MFL `TYPE=playerScores` per week (was player active for that week's lineup?)
- **Stage C — site/code repointing** to use the era-aware calculator (not started). Targets:
  - `pipelines/etl/scripts/build_salary_adjustments_report.py` (currently uses 4-step milestone array; flagged as TODO in Stage A)
  - `pipelines/etl/scripts/build_contract_history_snapshots.py` (same)
  - Site files with cap-penalty math (low risk — most use 75% guarantee which is unchanged)

---

## Known minor display issue (not blocking)

- **Timestamps stored UTC, league site displays ET.** Drop dates in cycles will look ~1 day off when compared to the league history page (e.g., 2021-12-01 22:45 ET = 2021-12-02 02:45 UTC). The DB stores UTC for math consistency; any human-facing report needs to render in ET. To convert: `dt_utc - 5h` (EST) or `-4h` (EDT, March-Nov). The `nfl_season_calendar.week1_thursday` is stored as ET date — keep that consistent. **Don't "fix" UTC→ET in the cycles table; fix at render time only.**

## Critical context decisions made (don't re-litigate)

- **2010 EXCLUDED entirely.** Pre-dynasty era (FA Auction only, no rookie draft). Per league_context Section 4 line 1243.
- **Trades come ONLY from explicit data.** Don't infer trades from roster gaps. The only allowed inference is natural-expiration (player on roster end of year Y, not on any roster end of year Y+1, no explicit drop event).
- **MFL API is canonical; local DB is backup.** MFL wins 99/100 in discrepancies. Local DB ingestion has known gaps (Daniels 2012 trades missing entirely, etc.).
- **Stage to JSON first, then D1.** All cycle data dry-run lands in `/tmp/cycle_backfill_pass2_cycles_all.json` for spot-check before any D1 write.
- **2019 cutover for 75% guarantee + monthly earning** (start of 2019 NFL season). Pre-existing contracts at end of 2018 with 2+ years remaining were tagged `GF` in MFL `contract_info` — those stayed on the OLD 20% flat rule until extension/restructure/release.
- **Taxi weeks count for earning** (Keith 2026-05-08: "they all earn"). IR weeks count too. Only `not_rostered` = 0 weeks_active.
- **UPS regular-season weeks: 16 for 2010-2024, 17 from 2025+.** From the `scores` table.
- **GitHub PAT** has Contents:write + Pull-requests:write + Actions:read+write. Worker secret `GITHUB_PAT`.
- **CI auto-deploys** worker on push to `worker/**` or `docs/league_context_v1.md`. Workflow: `.github/workflows/deploy-worker.yml`.

---

## Next 3 actions in order

### Action 1: Implement D1 write logic in `backfill_cycles_pass2.py`

The `--apply` flag currently prints "TBD". Need to:

1. Read cycles from `/tmp/cycle_backfill_pass2_cycles_all.json`
2. Map cycle dict → `player_acquisition_cycles` schema (defined in `worker/migrations/0028_cap_penalty_cycles.sql`)
3. Bulk INSERT to D1 in batches of 50-100 (D1 statement-size limit)
4. For Pass 2 cycles, populate the COMPUTED columns where possible:
   - `rule_era_at_drop`: from calculator's `determine_rule_era`
   - For closed cycles where the calculator can run (need salary data), populate `earned_legacy_usd`, `penalty_legacy_usd`, etc.
   - For cycles where financial data is missing → leave NULL, mark `pass = 'needs_pass3_enrichment'` in the `notes` field
5. Use `npx wrangler d1 execute --remote --file=...` with batched SQL files for the writes (avoid HTTP body size limits)

### Action 2: Run the D1 write + verify

```bash
cd /Users/keithcreelman/Code/MFL/upsmflproduction
python3 pipelines/etl/scripts/backfill_cycles_pass2.py --apply
# Then verify
cd worker && npx wrangler d1 execute ups-mfl-db --remote --command="SELECT COUNT(*) FROM player_acquisition_cycles;"
# Should show ~10,497
```

Spot-check 5 cycles in D1 by player_id (Keith picks 5).

### Action 3: Commit Pass 2 work

Once D1 verification passes:

```bash
git add pipelines/etl/lib/mfl_transactions.py \
        pipelines/etl/scripts/backfill_cycles_pass2.py \
        pipelines/etl/scripts/backfill_cap_penalty_cycles.py \
        docs/cap_penalty_data_migration_plan.md \
        docs/CURRENT_WORK_HANDOFF.md
git commit -m "feat(cap): Pass 2 cycle backfill from MFL canonical transactions"
git push origin main
```

(2010 stays excluded; the 14 years 2011-2024 backfill is the deliverable.)

---

## Open questions / pending Keith decisions

- **D1 batch size for cycle inserts.** D1 has a per-statement size limit (~1MB SQL). With 10K+ rows, need to batch. Default to 100/batch unless Keith says otherwise.
- **Pass 3 scope** (financial enrichment). Need to decide: pull `TYPE=rosters` per (year, league_id) for contract_info, OR `TYPE=salaries`. Both options on the table; I haven't run either yet.
- **Stage C repointing** — when we get to Stage C, identify every script/page that does cap-penalty math and either repoint to the era-aware calculator OR add a "show legacy + current side-by-side" widget. Keith asked for this earlier in the work but it's deferred until cycles are in D1.

---

## File paths cheat sheet

```
docs/league_context_v1.md                            ← single source of truth, league rules
docs/league_context_changelog.md                      ← rule-change history
docs/cap_penalty_data_migration_plan.md               ← long-term migration plan
docs/CURRENT_WORK_HANDOFF.md                          ← this file

worker/migrations/0028_cap_penalty_cycles.sql         ← schema for cycles + weekly_active + calendar + eras
worker/src/lib/cap_penalty.js                         ← JS calculator (mirrors Python)

pipelines/etl/lib/cap_penalty.py                      ← canonical Python calculator
pipelines/etl/lib/mfl_transactions.py                 ← MFL API client + parser
pipelines/etl/scripts/simulate_cap_penalty.py         ← 17 hand-crafted test scenarios
pipelines/etl/scripts/backfill_cycles_pass2.py        ← MFL canonical → cycles
pipelines/etl/scripts/backfill_cap_penalty_cycles.py  ← old Pass 1 (local DB based, kept for diff)

/tmp/mfl_canonical_events_<year>.json                 ← 14 staged canonical event files
/tmp/cycle_backfill_pass2_cycles_all.json             ← 10,497 cycles ready for D1
/tmp/cycle_backfill_pass2_data_gaps_all.json          ← 777 flagged for review
```

---

## Style notes for the next Claude session

- Keith hates fabrication. **Never guess.** When unsure, search files / DB / API for the answer. If still ambiguous, ask.
- Stage data to JSON first; spot-check; THEN write to D1.
- Use `wrangler d1 execute --remote --file=...` for D1 writes (not inline `--command` for anything large).
- Keith uses `gh` CLI for GitHub work. Repo is `keithcreelman/upsmflproduction`.
- Commits go through standard `git commit` with the Co-Authored-By trailer for Claude Opus 4.7. Pushes only when Keith says so.
- Worker version IDs are tracked in CF — last deploy `2a3b1f1` (Stage A).
- Bot DMs: never spam owners. The Hall bot has cron-based safeguards (kickoff_anchor_message_id required; quiet hours 10 PM – 6 AM ET).

---

## Recent commits worth knowing about

```
2a3b1f1 feat(cap): era-aware cap-penalty calculator with pre-2019 loaded correction
ae5457d chore: remove site/rulebook/ entirely (never trafficked)
c2355d6 docs(rules): integrate 3 May-2026 passed rules; archive legacy rulebook files
```
