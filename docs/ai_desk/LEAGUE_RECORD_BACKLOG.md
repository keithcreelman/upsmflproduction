# League Record backlog: historical inconsistencies (2026-11-19)

**Status:** planning record only. Nothing here is fixed, rewritten or filed. Each item says what Phase 1 does instead, so none of it blocks Phase 1.

**Rule for every item:** history is evidence-dependent.
- No derived value is shown as fact unless its method has been tested against clean cases and passed.
- When sources disagree, the desk shows both values and both sources (`answer_with_conflict`).

**Labels:** [V] verified in the local archive (`mfl.db`, MFL league 74598 2017+ plus earlier league ids) · [R] reported by the independent reviewer, not re-checked by me · [U] open.

| # | Item | Evidence | Slice that fixes it | Phase 1 behavior (no block) |
|---|---|---|---|---|
| LR-01 | **Pick slots can't be derived from standings.** Rule tested: "slot = 13 − last season's final finish". | [V] Matched about 10% of never-traded picks. | S1: store the **actual per-season draft order** from MFL draft results, reconciled with the trade-token chain. Your ruling where they conflict. | `pick.lineage` is not a Phase 1 tool. The desk names the round and the original franchise only, and states "slot not on record" (`answer_with_gap`). |
| LR-02 | **GF (grandfathered) tags exist, in `contract_status`, not `contract_info`.** | [V] Week 1 counts: 2019 = 224, 2020 = 113, 2021 = 34. | S2 `contract.timeline` reads `contract_status`. | Contract-history questions before 2026 are beyond Phase 1, so the desk abstains with the source named. An earlier walkthrough statement ("no GF tags") was corrected. |
| LR-03 | **GF tags appear on contracts created in 2019, rookie deals included.** That conflicts with canon's definition (contracts active at the end of 2018). | [R] | S2 + S4: grade each tag (A as recorded vs. canon-consistent); Keith ruling on which governs. | Never assert GF status from the tag alone; if asked, show the conflict. |
| LR-04 | **`final_finish` 7 = Toilet Bowl winner,** not seventh place. | [V] for the seasons checked. | Phase 1 `history.finishes` must return a labeled finish (champion, runner-up, …, Toilet Bowl winner), not the raw number. | **Phase 1 requirement**: a labeling map plus a golden test. |
| LR-05 | Pick chains with a hand-off that has no trade record. | [R] at least one. | S1: a chain with a gap row graded NO RECORD. | Not traced in Phase 1. |
| LR-06 | MFL "Pick traded from" draft notes disagree with the trade log and list only some holders. | [R] | S1: trade log is authority for transfers; notes are corroboration (grade B/C). | n/a |
| LR-07 | Draft order derives cleanly only for the 2018 and 2020–24 drafts. | [R] | S1 needs a stored per-season order for 2012–17, 2019, 2025 (and later). | n/a |
| LR-08 | Contract strings sometimes disagree with salaries; FL/BL labels persist after the contract's shape changes. | [R] | S2: event-chain authority (auction or extension events) over snapshot strings. | 2026 values come from the live `/roster-workbench` path. |
| LR-09 | Some rookie picks carry veteran or WW statuses. | [R] | S2 status crosswalk (contract-status vocabulary map) plus exceptions list. | `glossary.lookup` explains statuses; it doesn't reclassify history. |
| LR-10 | Several 2020–25 trades moved more cap than the 50% rule allows (by archive salaries). | [R] | S1/S4: check against the rule version in force at the trade date; could be data or could be a rule-era difference. | Not asserted as a violation; `needs_ruling` if asked. |
| LR-11 | Trades between the deadline and the March rollover fall outside both the archive and the snapshots. | [R] | S1: identify a source (MFL transactions export for the offseason window). | `coverage.check` reports the gap. |
| LR-12 | Some player acquisitions have no matching event. | [R] | S2 | Answer with gap. |
| LR-13 | 2011 all-play totals fit neither convention. | [R] | S3/history cleanup | Flag 2011 all-play as unverified. |
| LR-14 | Team-name spellings differ across tables in at least one season. | [R] | S3 identity registry (franchise id is the key, names are labels). | Always show franchise id beside the name. |
| LR-15 | Canon contradicts itself on three points: the 2026 Week 1 date, the trade-deadline wording, and which rookie round's taxi cuts are cap-free. | [R]; the calculator check (below) confirms or refutes each. | Rule decisions for Keith (canon edit) before S4. | `explain_conflict` with both quotes; never pick one. |
| LR-16 | An unused era-aware penalty library sits beside the charged penalty calculator; it is not wired into the code that charges. | [V] earlier audit; re-checked in the readiness review. | S4: consolidate into one era-aware calculator, then retire copies. | Phase 1 quotes **current-rule** penalties only, from the charged calculator. |

**Where this should live:** a private record (your "Keith · Work and Learning" Project, or a UPS issue if you approve posting). It isn't posted anywhere yet.

## Added 2026-11-20 (found while building and testing the Phase 1 tools)
| # | Item | Evidence | Slice that fixes it | Phase 1 behavior (no block) |
|---|---|---|---|---|
| LR-17 | **Stored final finishes disagree with the corrected fixture in three seasons:** 2011 has places 8 and 11 swapped, 2015 is defective (two franchises at 6, none at 10), 2023 has a stored 9th/10th swap (per the fixture's own note). | [V] `tests/fixtures/final_finish_history_2010_2025.json` vs stored D1 values | S3 history cleanup, with Keith's rulings on the true places | `history.finishes` flags those places as unverified (grade D) and refuses to label 2015's lower places. |
| LR-18 | **`/api/player-transactions` reads the MFL ledger only from 2019 onward** (code floor 2019), so earlier adds, drops and trades are not returned, although the catalog says all years. | [V] route code | S2 `contract.timeline` / archive-backed transactions | The tool attaches a standing gap to every result; it never says "no transactions" for earlier seasons. |
| LR-19 | **The route's per-event contract strings are reconstructed, and some are even-split guesses.** | [V] route code | S2 (event-chain evidence) | `player.transactions` omits contract terms; a historical contract question gets a decline. |
| LR-20 | **Drop-penalty rounding is not exposed by the preview.** The route returns raw per-drop amounts; the $1K rounding happens at team level in a write route (reconcile-post). | [V] | S4 era-aware calculator | The desk quotes the per-drop figure and says the team-level rounding is not applied. |
| LR-21 | **`regular_season_finish` has duplicate values in 2013** (two franchises at 6). | [V] | S3 | Passed through with a note that it is the seed by all-play percent. |
| LR-22 | **The calendar's FA Auction start row is a placeholder in 2026**, so the tag-cut guard cannot resolve the auction start from data. | [V] | Calendar data entry | `cap.penalty_quote` refuses tag-cut quotes in the window (fails closed). Supplying `knowledge.calendar.faAuctionStart` removes the refusal. |
