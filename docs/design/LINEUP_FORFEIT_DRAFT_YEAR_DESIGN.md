# Lineup-penalty pick forfeiture: applying it in the draft year

**Status:** design draft, revised with Keith's rulings of 2026-10-12. Nothing here is built. No MFL setting changes.
**Classification:** enhancement plus fail-closed gap (§G3).
**Related:** #1221 (rulings), #1223 (forfeited picks can't be traded; live), #1229 (War Room greys them out; draft).

## Keith's rulings (2026-10-12)

1. **How it's applied:** once the pick's year is the current draft, MFL's draft settings let the commissioner delete that draft pick. Keith deletes it there.
2. **Done means removed:** the issue is solved once the pick is removed in the settings.
3. **App scope:** the app only has to block the pick from trading. No test-league check is needed. A worker that removes picks through the settings is a topic to discuss later.

## Plain English

When a lineup violation costs a team a draft pick, the app reserves it and refuses it in every War Room trade. MFL can't delete a single *future* pick. Once that pick's year becomes the current draft, though, you can delete it in MFL's draft settings, and that settles it.

So the app has one job: keep the pick out of trades until you delete it. Today the block covers the pick only while it's a future pick. It has to keep working after the year becomes the current draft and the pick turns into a numbered draft slot, until you delete it.

Nothing is forfeited yet. CBP's Week 5 ruling is a warning.

## What is true today (checked 2026-10-12, read-only)

| Fact | Source |
|---|---|
| A forfeited pick is reserved in `ups_lineup_pick_reservations` (states reserved / obligation / needs_selection / traded_away / secured / released). | migrations 0171, 0172 |
| The War Room refuses a forfeited **future** pick (`FP_…` token) at Send, Accept, Execute and Recheck. | `worker/src/lineup_forfeits.js` `checkForfeitedPicks`; trade_2way/3way |
| Once its year is the **current** draft, the pick is a draft slot (`DP_…` token: round and pick number). **The block doesn't recognise `DP_` tokens**, so from that point until you delete the pick, it could be traded in the War Room. | `canonFpToken` handles `FP_` only; `/api/trade` maps current-year picks to `DP_` |
| The current draft's slots come from `draftResults`. Each slot has round, pick, franchise, player, timestamp and comments, with no original-owner field. `round1DraftOrder` gives the order rounds 1–5 follow. | MFL export, 2025 and 2026 |
| The 2018 draft results are missing slot 4.12 entirely. That fits a pick deleted in the settings, which is the shape a deleted pick should have. | MFL export, 2018 |
| The rookie draft is the Sunday before Memorial Day: 6 rounds × 12. Round 6 is untradeable. Future picks are tradeable only for the next year (§A6). | canon §A1, §A6 |
| The hourly forfeit check (`reconcileForfeitedPicks`) probably doesn't run January–August: it sits in a block that exits when there's no NFL week. That's inferred from code, not tested. | `index.js` hourly loop `if (!lcWeek) return;` |

## 1. Keeping the pick out of trades (the app's whole job)

**While it's a future pick** (live today): the `FP_` token is refused at Send, Accept, Execute and Recheck. #1229 shows it greyed out with "Forfeited — lineup penalty".

**After its year becomes the current draft, until you delete it** (to build):

1. **Find the slot.** For each reservation (year, round, original owner), the pick number is the original owner's position in that year's `round1DraftOrder`. Confirm the slot in `draftResults` still belongs to the team that holds the reservation; if it doesn't, it was traded on MFL (§3).
2. **Block it.** Extend the trade check to `DP_` tokens: refuse a trade containing that slot, with the same message, and refuse it while the check can't be completed (the same fail-closed 503 as today). MFL's `DP_` tokens count from zero.
3. **Show it.** The War Room and the Rookie Draft Hub trade window show the slot greyed out with "Forfeited — lineup penalty", the same as #1229.
4. **Stop once deleted.** When the slot no longer appears in `draftResults`, there's nothing left to block. The reservation can be marked done, and the slot is gone from every builder anyway.

No checklist messages, reminders or draft-day steps from the app.

## 2. Deleting the pick (Keith)

Once that year's draft exists on MFL, delete the pick in MFL's draft settings. That settles the forfeiture.

**Optional, read-only:** the app can confirm the deletion by noticing the slot is gone from `draftResults`, the way 2018's 4.12 is missing. It would then mark the penalty "applied" instead of leaving it "assessed". It never writes to MFL.

**Later, to discuss:** a worker that deletes the pick for you. MFL's draft settings have no API, so a worker would have to drive MFL's commissioner web page with your login. That's riskier than one manual delete a year, so it's a separate decision.

## 3. If the pick is traded on MFL's own site first

The app can't block MFL's own trade page. Today's hourly check catches such a trade (`traded_away`), DMs you and the owner, keeps the pick blocked in the War Room, and never marks the penalty applied.

**Open question for you:** what happens to the forfeiture then?

- **A.** Move it to the original team's next owned pick in that round. This mirrors the rule already used when a pick is traded before it can be reserved. **(Recommended.)**
- **B.** Reverse the trade as commissioner, then forfeit as normal.
- **C.** Delete the slot anyway, in the new holder's hands. Not recommended, because it penalises a team that did nothing wrong.

## 4. Smaller fixes needed for the block to hold

- **Run the forfeit check all year**, including weekly from January to August. Otherwise a trade on MFL's own site in the offseason, or a deletion, goes unnoticed until September.
- **Note, not part of this design:** `POST /api/pick` takes the franchise's first unmade slot rather than the slot on the clock. Worth a separate fix before the 2027 draft.

## 5. Build plan (later, its own PR, with your go)

1. A `DP_` trade block for forfeited slots in the draft year, plus the greyed display, with tests.
2. Run the forfeit check all year. Optionally mark "applied" when the slot disappears from `draftResults`.
3. *(To discuss)* A worker that deletes the pick in MFL's draft settings.

## Also noticed (not part of this design)

- 2026 pick 6.03 shows a kicker taken in Round 6, which canon now limits to IDP. That's a possible data discrepancy, and it's flagged as a separate read-only check.
- The Round 6 order rebuild (`/api/r6/apply-order`) blanks every slot's comments, which drops "[Pick traded from X.]".
