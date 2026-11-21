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
2. **UNIQUE_HOLDER_V1 (INFERRED), conditionally approved.** A future pick's last holder owns exactly **one** slot in that round on the evidence date, **and** custody of the pick by that holder is observed from its last recorded transfer to the evidence date (no unobserved period between), **and** the evidence date's record is authoritative (MFL's slot list or the draft results). The holder, season, round and possession period must be supported by records; every competing slot the holder owns on that date is counted; the rule id is recorded; any missing period is disclosed. The link is labeled INFERRED, never CONFIRMED, never establishes a confirmed draft selection by itself, and is excluded from confirmed-only totals. **If any condition fails the identity is UNRESOLVED**; uniqueness is never used as proof when the inventory is incomplete.

   **What "the inventory is demonstrably complete" means in code (`inventoryCheck`):** (a) the season's team list is known and the evidence lists exactly one slot per team for the round (slots 1..N, every holder a franchise of the season); (b) no slot-token (`DP_`) transfer exists for that season and round, because slot-named transfers need their own accounting that the pilot does not do; (c) for every original franchise, the chain of its future pick has no break, and the number of picks the records say each franchise holds equals the number of slots the evidence gives it, so every possible competing pick is accounted for franchise by franchise. Any failed condition is printed beside the pick and the link stays UNRESOLVED.
3. **Notes are not a rule (commissioner's ruling, 2026-11-20: NO).** MFL's "Pick traded from..." notes on a slot are listed beside candidate slots as corroboration only. They do not establish a pick's original franchise or its complete ownership chain and are never a standalone inference rule. The authoritative slot token, the recorded pick identity, corroboration and unresolved candidates are always shown apart.

## 7. Coverage gaps

- **Named gap:** the day after the last recorded trade of the archive (2025-11-27, the trade deadline) through the evening before the first 2026 snapshot transaction (2026-03-07). Other archive transaction types continue to 2025-12-29. Any custody check that crosses it is incomplete. The bundle and report mark **every** chain (player or pick) with a possession period that spans it, not only the picks whose evidence date lies beyond it.
- **Data-driven windows:** every stretch of 14 or more days with no recorded transaction of any kind in the archive (the annual offseason windows are among them).
- **Supporting indication, not proof:** the archive records no trade in January and one in December across its seasons, which fits a closed window after the deadline. It cannot prove an empty window.

## 8. Points and salary (CALCULATED)

- **Points** come from MFL's per-week scoring record, which names the franchise it credits each week, and are cross-checked against the plain weekly score table. A week is **verified** for a franchise only when the possession chain and MFL's weekly record name the same franchise. Other weeks are classed `asserted` (before the chain's first record, supported only by its sender), `outside_window` (before the first record and the weekly record names someone else; not part of this trace), `disputed`, or `transition` (a possession change between Thursday and Monday of that week). Only verified weeks enter verified totals. Weeks past the league's last week (16 through 2020, 17 from 2021) are copies in the archive and are excluded. A week with no scoring row has no points; it is never filled with zero. No 2026 points exist in any committed source.
- **Salary and contract** are shown exactly as MFL's weekly roster record has them (salary, years remaining, status, contract text), by run of identical weeks. Nothing is estimated. A franchise's total cap position is not computed (it needs the full roster and adjustment record: League Record slice S2).

## 8b. Trade packages and economic attribution (commissioner's ruling, 2026-11-20)

A trade is one transaction. Everything a franchise surrendered was exchanged for everything it received, together, and the record states no split. Three notions are kept apart (`scripts/league_record/s1/packages.mjs`):

1. **Direct consideration:** all assets (and cap money, in its direction) received in exchange for the complete set surrendered in that transaction.
2. **Lineage participation:** a traced asset took part in that transaction. It records the direction and the full package on both sides; it says nothing about value.
3. **Attributable economic return:** the value reasonably assignable to one asset. It is **ESTABLISHED** only when the transaction itself pairs the assets (exactly one asset each way and no cap money in the trade). Otherwise it is **NOT_ESTABLISHED** and nothing is allocated: no incoming asset, point total, salary or cap amount is credited to a single outgoing asset, and an outgoing pick is said to have been *included in the package* that acquired a player, never to have *become* or *bought* him. (A pick that is *selected* in the draft is a different thing: that is identity, recorded by MFL's draft result, not trade value.)

Consequences: every trade in the bundle has a `packages` entry listing every asset and cap amount in its direction; every node lists its `participation`; totals such as "verified points for the traced player possession periods" are sums over periods and are never described as a net gain or as the return of one trade. Acceptance test T17 and the regression tests in `tests/league_record_s1_pilot.test.mjs` fail if a package drops a leg, flips a direction, allocates without an established pairing, or double-credits.

## 9. The build guard

`guard.mjs` (runtime table refusal in `archive.mjs`) and `scanExtractionSources` (every extraction module, comments removed) fail on any reference to standings, finishes, brackets, seeds, projections, a derived draft order or the finish routes. `tests/league_record_s1_pilot.test.mjs` T9 runs both, and a test proves that adding a banned idea to a module fails the scan.

## 10. Reproduce

```bash
node scripts/league_record/s1/run_pilot.mjs           # writes docs/league_record/pilot/*
node scripts/league_record/s1/run_pilot.mjs --check   # fails if the committed files differ from a fresh build
node tests/league_record_s1_pilot.test.mjs            # acceptance tests T1-T15 and T17, and unit tests
node scripts/league_record/s1/run_archive_extract.mjs          # writes docs/league_record/archive/* (2010-2025)
node scripts/league_record/s1/run_archive_extract.mjs --check  # fails if the committed files differ from a fresh build
node tests/league_record_s1_archive.test.mjs          # extraction tests (separate SQL, older-period examples, guards)
```

## 11. The 2010-2025 archive extraction (Step 1b)

`scripts/league_record/s1/archive_extract.mjs` (run with `run_archive_extract.mjs`; output in `docs/league_record/archive/`) measures the archive years season by season with the same rules: draft slots only from MFL slot tokens and MFL draft results; every trade is one package; a future pick is never CONFIRMED to a slot; INFERRED only under `UNIQUE_HOLDER_V1`; production is a sum over verified possession periods per franchise and is never attributed to a pick or a trade. Findings that shaped the code:

- **Legacy draft table slot defect (2012-2017):** the tenth pick of each round ("1.10", raw text "1.1") is stored with slot 1, so slot 1 appears twice and slot 10 never. MFL's overall pick number is stored correctly, so the slot is `overall - 12 x (round - 1)`, applied only where the stored slot disagrees and the result is 1 to 12. Each corrected row keeps its stored value and the rule (`slot_correction`). This uses MFL's own pick number; no finish, standing, bracket or order is involved.
- **Slot status and known forfeitures (commissioner clarification, 2026-11-21):** every scheduled slot of a season that has draft results has exactly one status. SELECTED: one recorded selection. FORFEITED: no selection and a known forfeiture from a named provenance; the slot and its MFL overall number are kept and the player stays empty. UNRESOLVED: the source holds more than one row for the slot. MISSING_SOURCE_RECORD: no selection and nothing explains the absence. Forfeitures live in `docs/league_record/known_forfeitures.json`, which accepts only the fields its provenance supplies (season, round, slot, overall, status, reason, provenance); a violation, owner or franchise, penalty ruling date, MFL transaction or player is refused by the loader. An absence is never called a forfeiture without a source, and a forfeiture beside a recorded selection for the same slot stops the build. 2018 pick 4.12 (overall 48) is the one known forfeiture: reason "owner violation", provenance "commissioner clarification". 2018 reads as 71 recorded selections plus one known forfeiture. It is a different record from the 2014 pick 4.12 selector conflict, which stays a conflict on a SELECTED slot. A selected slot whose row has no franchise id stays SELECTED (a player was recorded); the missing selector is reported as `selector_not_recorded`. A slot pick traded on a forfeited slot has no draft result to link and is counted as `forfeited_slot`, never CONFIRMED; the future picks of that round are not reconciled because the provenance does not name a holder.
- **Legacy rows without a franchise id** cannot confirm or contradict a chain: they are `selector_not_recorded`, never a conflict.
- **Weekly franchise record:** the scoring table's franchise column holds the placeholder `FA` for 2012-2019. Where the weekly roster record exists (2010, 2011, 2017 on) it names the franchise; where neither exists (2012-2016) the week is `no_franchise` and is never verified. Free-agent weeks are `no_franchise` too.
- **The funnel for future picks** is a diagnostic, not a result: it shows which condition stops each pick (custody across quiet windows, slot-token transfers in the round, the slot count, a unique candidate) and what the count would be if one condition were met another way. Whether to meet a condition another way is a commissioner decision.
- **Banned columns:** the guard refuses `waiver_sort_order` and similar columns even in an allowlisted table (the franchise list table also holds a waiver order derived from the standings).

## 12. Not verified

- MFL itself (live) was not queried; points and rosters are checked against a second archive table, not against MFL.
- The archive's completeness beyond the records the pilot uses.
- How compensation or supplemental picks appear in MFL.
- Trade order within a day before 2024 (processing times).
