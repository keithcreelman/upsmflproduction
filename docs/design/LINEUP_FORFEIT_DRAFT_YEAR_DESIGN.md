# Lineup-penalty pick forfeiture: applying it in the draft year

**Status:** design draft, revised with Keith's rulings of 2026-10-12 (two rounds). Nothing here is built. No MFL setting changes.
**Classification:** enhancement plus fail-closed gap (§G3).
**Related:** #1221 (rulings), #1223 (forfeited picks can't be traded; live), #1229 (War Room greys them out; draft).

## Keith's rulings (2026-10-12)

1. **How it's applied:** once the pick's year is the current draft, MFL's draft settings let the commissioner delete that draft pick. Keith deletes it there.
2. **Done means removed:** the issue is solved once the pick is removed in the settings.
3. **App scope:** the app only has to block the pick from trading. No test-league check is needed. A worker that removes picks through the settings is a topic to discuss later.
4. **If a forfeited pick is traded on MFL's own site: option B.** A worker reverses the whole trade, then posts in Discord that the trade was reversed because the pick was forfeited (Keith: "I would prefer to have a reversal and then a post in discord").

## Plain English

When a lineup violation costs a team a draft pick, the app reserves it and refuses it in every War Room trade. MFL can't delete a single *future* pick. Once that pick's year becomes the current draft, though, you can delete it in MFL's draft settings, and that settles it.

So the app has two jobs. First, keep the pick out of War Room trades until you delete it. Today the block covers the pick only while it's a future pick; it has to keep working after the year becomes the current draft and the pick turns into a numbered draft slot. Second, if someone trades the pick on MFL's own site, where the app can't block it, reverse that trade and tell the league why.

MFL's commissioner lockout stops any worker from processing a trade as the two teams, so a reversal needs you to turn lockout off for a moment (§3.4).

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

## 3. If the pick is traded on MFL's own site first: reverse the trade (Keith: B)

### The blocker: MFL's commissioner lockout

MFL only processes a trade as the two teams: one proposes, the other accepts. A worker can do that only by acting as each team (commissioner impersonation). **While MFL's commissioner lockout is on, MFL refuses every such call**: "Commissioner can not impersonate another franchise with lockout on." No API key changes that. The worker already holds the commissioner's MFL credentials (`MFL_APIKEY`, `MFL_COOKIE` secrets), so nothing new is needed from Keith.

- **Lockout is on right now** (league export, 2026-10-12 11:35 AM ET).
- Keith has said to treat it as permanently on (memory, 2026-10-06).
- The 3-way trade engine already hits this wall: it pauses with "Commish: toggle lockout off and re-run" (`worker/src/trade_3way.js`).

So "a worker reverses the trade" needs a decision on lockout (§3.4).

### 3.1 Finding the trade

1. The hourly forfeit check sees a reserved pick on another team (today's `traded_away`). In the draft year it sees the slot owned by another team.
2. Read MFL's trade transactions (`TYPE=transactions&TRANS_TYPE=TRADE`, read-only, no impersonation) and find the one trade whose assets include that pick.
3. **Hold and DM Keith instead** if there's no such trade, more than one (the pick moved twice), or the export can't be read.

### 3.2 Checking the reversal is clean

The reversal returns **every** asset in the trade, both ways: players, picks and cap money. Before anything runs, the worker confirms each asset is still with the team that received it (rosters, future picks, salary adjustments). **If anything moved on** (traded again, dropped, released, on another roster), it does nothing, holds, and DMs Keith the details. Never a partial reversal.

Details the build must handle:
- **Cap money:** the settlement sweep (#1181) settles traded cap money hourly. A reversal moves the cap money back, and the sweep settles that too, so the net is zero. This needs a test before enabling.
- **The forfeit block itself:** today's final check before MFL (`executeCommishTwoPartyTrade`) refuses any trade containing a forfeited pick. The reversal needs a narrow exemption: only that exact pick, only going back to the team that forfeited it.
- **Taxi players come back active** (MFL lands traded players active). This is noted in the DM.
- **Pre-trade extensions** don't exist in trades made on MFL's own site, so there's nothing to undo there.

### 3.3 Idempotency

One reversal per original trade, recorded in D1 with the original trade id. It's guarded by a time-limited lease like the lineup post (#1227), so overlapping runs can't produce two reversals, two posts or two DMs. Every step is written to the forfeit audit log.

### 3.4 Running it: three options (decision needed)

- **Option 1 (recommended): you flip lockout off; the worker does the rest.**
  - On detection, the worker DMs you "Reversal ready: turn MFL lockout off", with the full asset list.
  - It re-checks every 2 minutes for 24 hours. The moment lockout is off, it re-runs §3.2, executes the reversal through the same path as 3-way trade legs, confirms on MFL that every asset is back, and DMs you "Done: turn lockout back on".
  - Then it posts in Discord.
  - Your lockout toggle is the approval for that one reversal; nothing runs while lockout is on.
- **Option 2: the worker toggles lockout itself.** Not recommended. It changes a league setting automatically, and while lockout is off the commissioner account can act as any team. MFL's API for that setting is also unverified.
- **Option 3: you reverse it yourself on MFL.** The worker notices the pick is back with its team and posts in Discord.

### 3.5 Notices (draft wording)

| When | To | Text |
|---|---|---|
| Detected | Keith | "⛔ A forfeited pick was traded on MFL: Team A's 2027 4th-round pick (Week 6 lineup penalty) went to Team B in trade #…. Reversal ready: [assets both ways]. Turn MFL lockout off and the worker will reverse it." |
| Detected | Both owners | "Your trade with Team B included Team A's 2027 4th-round pick, which was forfeited as a lineup-violation penalty. The trade will be reversed and every asset returned." |
| Reversed | Discord (channel to confirm) | "↩️ **Trade reversed.** The trade between Team A and Team B on Oct 14 has been reversed because it included Team A's 2027 4th-round pick, which was forfeited as a lineup-violation penalty (Week 6). Every player, pick and cap dollar is back with its original team." |
| Reversed | Keith | "Done: every asset is back. Turn MFL lockout back on." |
| Held | Keith | What MFL shows, what moved, and that nothing was changed. |

### 3.6 Canon (to add when this is built)

§G3: "A trade made on MFL's own site that includes a forfeited pick is reversed in full by the commissioner, and the league is told in Discord (Keith 2026-10-12)." This is an exception to §A6's "no vetoes".

### 3.7 Testing

Tests use a fake MFL: no real trade, pick or Discord message. Because a reversal is a real trade write, I recommend one supervised reversal on the **test league** (L=25625) before the feature is switched on, with your go. The feature ships switched off.

## 4. Smaller fixes needed for the block to hold

- **Run the forfeit check all year**, including weekly from January to August. Otherwise a trade on MFL's own site in the offseason, or a deletion, goes unnoticed until September.
- **Note, not part of this design:** `POST /api/pick` takes the franchise's first unmade slot rather than the slot on the clock. Worth a separate fix before the 2027 draft.

## 5. Build plan (later, its own PRs, with your go)

1. A `DP_` trade block for forfeited slots in the draft year, plus the greyed display, with tests.
2. Run the forfeit check all year. Optionally mark "applied" when the slot disappears from `draftResults`.
3. Trade reversal (§3): find the trade, run the clean check, idempotent ledger, Option 1 execution, notices, canon line. Ships switched off, with tests on a fake MFL, then one supervised test-league reversal.
4. *(To discuss)* A worker that deletes the pick in MFL's draft settings.

## Decisions needed

1. **Lockout:** Option 1, you flip lockout off and the worker reverses (recommended); Option 2, the worker toggles lockout; or Option 3, you reverse it and the worker posts.
2. **Discord channel** for the "Trade reversed" post, and whether it tags both owners.
3. **Test-league reversal:** one supervised reversal on L=25625 before switching it on (recommended)?

## Also noticed (not part of this design)

- 2026 pick 6.03 shows a kicker taken in Round 6, which canon now limits to IDP. That's a possible data discrepancy, and it's flagged as a separate read-only check.
- The Round 6 order rebuild (`/api/r6/apply-order`) blanks every slot's comments, which drops "[Pick traded from X.]".
