# League Record S1 (trade and draft-pick lineage): methodology

**Status:** draft, read-only research. Nothing here touches D1, a Worker route, the ETL, a deployment or a model. It reads two committed sources (below) and writes plain files. Code: `scripts/league_record/s1/`. Evidence: `docs/league_record/pilot/`. Tests: `tests/league_record_s1_pilot.test.mjs`.

## 1. Rules this work follows (the commissioner's, 2026-11-20)

1. **Draft slots come only from authoritative MFL data:** MFL draft results, the slot named by an MFL slot token (`DP_<round>_<slot>`) in a trade record, and MFL's own pre-draft slot lists. **A slot is never derived from standings, league finishes, brackets or a projected order.** No such reconstruction exists in this design, and the build fails if one is introduced (section 9).
2. Preserve every transaction date and time, asset identity, franchise identity, source reference and gap. Do not fill missing history.
3. **A franchise id is not an owner.** Franchise continuity never proves owner continuity. Output says "franchise" and carries `owner_identity: not_asserted`. Owner columns are never read.
4. Separate proven outcomes from missing or ambiguous history in every view.

## 2. Evidence classes

| Class | Meaning | Counts in confirmed totals? |
|---|---|---|
| **CONFIRMED** | A recorded MFL event states it: a trade leg, an MFL draft result for a slot that the chain names, a roster or add/drop record | yes |
| **CALCULATED** | Code arithmetic over recorded inputs (points, salary), no stronger than its inputs | yes, when every input is confirmed |
| **INFERRED** | A link no record states, derived by a named rule with every condition met (section 6); always labeled, never confirmed | **no**, shown in a separate view |
| **UNRESOLVED** | Incomplete or competing evidence. A candidate may be listed; it counts for nothing | no |

A node whose path of links includes an INFERRED or UNRESOLVED link is never counted in a confirmed-only total.

## 3. Sources

| Source | What it holds | Caveats carried as gaps |
|---|---|---|
| Archive `data/db-archives/mfl_database_2026-06-05.db.gz` (sha256 pinned in `archive.mjs`; opened read-only) | trades 2010-2025 with pick identity, draft results 2012-2025, add/drop and auction events, weekly rosters, weekly scores | trade times before 2024 are mostly the commissioner's processing time; the archive ends with the 2025 season; weeks after the league's last week are copies of the last week |
| Committed daily snapshots `data/mfl-snapshots/<day>/` (the pilot pins `2026-11-19`) | 2026 transactions from 2026-03-08, 2026 draft results, MFL's pre-draft slot lists with its "Pick traded from..." notes (from 2026-04-21), rosters and contracts | the first snapshot is 2026-04-21; the transaction window starts 2026-03-07 evening Eastern |

Only the tables on the allowlist in `archive.mjs` can be queried. Tables holding standings, brackets, history rollups or forecasts are refused at runtime.

## 4. Asset identity

- **Player:** the MFL player id (`player:14104`).
- **Slot pick:** `(year, round, slot)` once a trade names the slot with a `DP_` token (`spick:2025:1:8`). The archive stores the slot zero-indexed in a column named `asset_draftpick_overall`; the loader makes it one-indexed (stored 7 is pick 1.08).
- **Future pick:** `(original franchise, year, round)` from an `FP_` token (`fpick:0006:2026:3`). The token names who the pick originally belonged to, **not its slot**. Which slot it became is never stated by a token.
- **Cap money:** an amount moving between franchises in a trade, shown as recorded; it is not an asset with a chain.
- **Trade ids** like `trade2025_5` are labels the archive assigns; every use also carries the table, the group and the row ids.

## 5. Possession chains

A chain is the time-ordered list of recorded events for one asset (trades, draft selections, adds, drops, auction wins), each with its source. The holder before the first event is **asserted by that event's sender**, and is labeled so. Three listed conditions:
- **discontinuity:** an event's sender is not the holder the previous events leave. Something between them is missing or recorded differently. It is listed, never repaired.
- **implicit release:** an add by another franchise ends a stint with no recorded release by the holder (for example a contract that expired before an auction). The add is the first record that ends the stint.
- **unobserved period:** see section 7.

## 6. Slot resolution

1. **SLOT_TOKEN_DRAFT_RESULT (CONFIRMED).** A trade record names the slot with an MFL slot token, and MFL's draft result for that slot records the franchise that made the selection. CONFIRMED when that franchise is the one the chain leaves holding the slot at the selection time; a difference is reported as a conflict (draft results record who made the pick, which before 2018 can be the clicker, not the owner).
2. **UNIQUE_HOLDER_V1 (INFERRED), conditionally approved.** A future pick's last holder owns exactly **one** slot in that round on the evidence date, **and** custody of the pick by that holder is observed from its last recorded transfer to the evidence date (no unobserved period between), **and** the evidence date's record is authoritative (MFL's slot list or the draft results). The holder, season, round and possession period must be supported by records; every competing slot the holder owns on that date is counted (the slot list is the inventory); the rule id is recorded; any missing period is disclosed. The link is labeled INFERRED, never CONFIRMED, never establishes a confirmed draft selection by itself, and is excluded from confirmed-only totals. **If any condition fails the identity is UNRESOLVED**; uniqueness is never used as proof when the inventory is incomplete.
3. **Notes are not a rule.** MFL's "Pick traded from..." notes on a slot are listed beside candidate slots as corroboration only. Using them as an inference rule needs the commissioner's ruling (open question in the pilot report).

## 7. Coverage gaps

- **Named gap:** the day after the last recorded trade of the archive (2025-11-27, the trade deadline) through the evening before the first 2026 snapshot transaction (2026-03-07). Other archive transaction types continue to 2025-12-29. Any custody check that crosses it is incomplete.
- **Data-driven windows:** every stretch of 14 or more days with no recorded transaction of any kind in the archive (the annual offseason windows are among them).
- **Supporting indication, not proof:** the archive records no trade in January and one in December across its seasons, which fits a closed window after the deadline. It cannot prove an empty window.

## 8. Points and salary (CALCULATED)

- **Points** come from MFL's per-week scoring record, which names the franchise it credits each week, and are cross-checked against the plain weekly score table. A week is **verified** for a franchise only when the possession chain and MFL's weekly record name the same franchise. Other weeks are classed `asserted` (before the chain's first record, supported only by its sender), `outside_window` (before the first record and the weekly record names someone else; not part of this trace), `disputed`, or `transition` (a possession change between Thursday and Monday of that week). Only verified weeks enter verified totals. Weeks past the league's last week (16 through 2020, 17 from 2021) are copies in the archive and are excluded. A week with no scoring row has no points; it is never filled with zero. No 2026 points exist in any committed source.
- **Salary and contract** are shown exactly as MFL's weekly roster record has them (salary, years remaining, status, contract text), by run of identical weeks. Nothing is estimated. A franchise's total cap position is not computed (it needs the full roster and adjustment record: League Record slice S2).

## 9. The build guard

`guard.mjs` (runtime table refusal in `archive.mjs`) and `scanExtractionSources` (every extraction module, comments removed) fail on any reference to standings, finishes, brackets, seeds, projections, a derived draft order or the finish routes. `tests/league_record_s1_pilot.test.mjs` T9 runs both, and a test proves that adding a banned idea to a module fails the scan.

## 10. Reproduce

```bash
node scripts/league_record/s1/run_pilot.mjs           # writes docs/league_record/pilot/*
node scripts/league_record/s1/run_pilot.mjs --check   # fails if the committed files differ from a fresh build
node tests/league_record_s1_pilot.test.mjs            # acceptance tests T1-T15 and unit tests
```

## 11. Not verified

- MFL itself (live) was not queried; points and rosters are checked against a second archive table, not against MFL.
- The archive's completeness beyond the records the pilot uses.
- How compensation or supplemental picks appear in MFL.
- Trade order within a day before 2024 (processing times).
