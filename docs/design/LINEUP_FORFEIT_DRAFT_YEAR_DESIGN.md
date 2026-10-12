# Lineup-penalty pick forfeiture: applying it in the draft year

**Status:** design draft for Keith's review, 2026-10-12. Nothing here is built. No MFL setting changes, no draft-year process.
**Classification:** enhancement plus fail-closed gap (§G3).
**Related:** #1221 (rulings), #1223 (forfeited picks can't be traded; live), #1229 (War Room greys them out; draft).

## Plain English

When a lineup violation costs a team a draft pick, the app reserves that pick and refuses it in every War Room trade. MFL itself can't delete or lock a single future pick, so the forfeiture is never actually carried out on MFL. Today the app would show the penalty as "assessed" forever.

The pick can only truly be taken away in its own draft. On draft day the commissioner tells MFL to skip that slot, and the app records the proof. This document proposes how the app keeps the owner from using the slot until then, what you do at the draft, what proof marks the penalty applied, and how to handle mismatches.

Nothing is forfeited yet. CBP's Week 5 ruling is a warning.

## What is true today (checked 2026-10-12, read-only)

| Fact | Source |
|---|---|
| A forfeited pick is reserved in `ups_lineup_pick_reservations`, with states reserved / obligation / needs_selection / traded_away / secured / released. | migrations 0171, 0172 |
| The War Room refuses a forfeited **future** pick (`FP_…` token) at Send, Accept, Execute and Recheck. | `worker/src/lineup_forfeits.js` `checkForfeitedPicks`; trade_2way/3way |
| MFL has no import or setup page that removes, locks or reassigns one **future** pick. | MFL `api_info` import list; MFL help, Future Draft Picks |
| Once its year becomes the **current** draft, the pick becomes a draft slot (`DP_…` token, round and pick number). **The guard doesn't recognise `DP_` tokens**, so a forfeited pick could be traded in the War Room once its year arrives. | `canonFpToken` handles `FP_` only; `/api/trade` maps current picks to `DP_` |
| `draftResults` slots carry only round, pick, franchise, player, timestamp and comments. There is no original-owner field, and the original owner appears only in comments like "[Pick traded from X.]". `round1DraftOrder` gives the order. | MFL export, 2025 and 2026 |
| **MFL "Skip Draft Pick"** (Commissioner Setup, `C=SKIPPICK`): pick a Round/Pick so that franchise can't draft there. It's documented as the way to remove a pick once traded picks exist. It can't be undone except by Revert Draft, or by Change Draft Pick saved with no player, which gives the pick back to the team. There is no API for it. | MFL help, Draft section |
| `live_draft?CMD=SKIP` (commissioner only) skips **only the pick on the clock**. | MFL `api_info` |
| `import?TYPE=draftResults` **deletes all existing draft results**, so it is never safe for this. | MFL `api_info`; `index.js` `/api/r6/apply-order` comment |
| The rookie draft is the Sunday before Memorial Day: 6 rounds × 12. Round 6 is untradeable. | canon §A1 |
| The hourly forfeit check (`reconcileForfeitedPicks`) runs inside a block that exits when there's no NFL week, so **it probably doesn't run January–August**, which covers the draft. (Inferred from code; not tested.) | `index.js` hourly loop `if (!lcWeek) return;` |
| How a skipped slot appears in `draftResults` is **not known**. No skipped pick exists in UPS 2015–2026, and slot 4.12 is simply missing in 2018, reason unknown. | MFL export |

## 1. Keeping the owner from using the slot

**Before the draft year** (live today): the pick's `FP_` token is refused at Send, Accept, Execute and Recheck. #1229 shows it greyed out with "Forfeited — lineup penalty".

**In the draft year** (proposed):

1. **Resolve the slot.** As soon as MFL lists the year as the current draft, the worker maps each reservation (year, round, original owner) to a concrete slot. The pick number comes from the original owner's position in `round1DraftOrder`, because rounds 1–5 use the same order every round. Store `draft_round` and `draft_pick` on the reservation and record a `slot_resolved` audit event.
   - If the slot's MFL franchise isn't the holder, go to §4.
2. **Guard the slot.** Extend the trade guard to `DP_` tokens: refuse any trade containing the resolved slot, with the same message and the same fail-closed 503. Note MFL's `DP_` tokens count from zero.
3. **Show it.** The Rookie Draft Hub board and its trade window show the slot as "Forfeited — lineup penalty", and the War Room shows it greyed out, as in #1229.
4. **Refuse the selection.** `POST /api/pick` refuses a pick made in a forfeited slot ("This pick was forfeited as a lineup penalty"), before it ever calls MFL.
   - Prerequisite fix: `/api/pick` currently takes the franchise's **first unmade slot**, not the slot on the clock.
5. **Run the check all year.** The forfeit check must run outside the NFL season (weekly, plus daily in May) or it will miss the draft.

## 2. What the commissioner does at the draft

**Recommended: one manual step in MFL, before the draft starts.**

1. **About 7 days before the draft:** the worker DMs you a checklist, for example: "Forfeited picks to skip in the 2027 rookie draft: Team X, Round 4 Pick 7 (Week 6 lineup penalty). In MFL: Commissioner Setup → Draft → Skip Draft Pick → Round 4, Pick 7."
2. **You make the skip in MFL** after the draft order is final and before the draft opens.
3. **The worker re-checks** the next hour (or when you tap a read-only "Verify" link) and records the proof (§3).
4. **On draft morning,** if any forfeited slot still isn't skipped, you get one DM.

**Alternative:** skip it live when the slot comes on the clock. That's a commissioner "Skip" in MFL's live draft, or later a worker call to `live_draft?CMD=SKIP` with your go. It's riskier because it depends on catching the moment, so it's only the backstop.

**Never** use the draftResults import or the Round 6 order rebuild to remove a pick.

## 3. What proof marks the forfeiture applied

The status changes to **applied** only when the worker reads MFL's own data showing the slot can't be used:

- **Preferred:** `draftResults` for that year shows the slot marked skipped, in whatever shape MFL uses (still unknown).
- **Backstop, after the draft completes:** the slot has no player while every later pick in that round is made.

The proof is stored as an audit event: the export URL with no credentials, the slot's fields, the time, and a hash of the export. Cap charges keep their existing salary-adjustment check.

Before any of this is built, the shape of a skipped slot should be confirmed on the **test league** (L=25625). That needs a commissioner action there, so it needs your go.

Until there's proof, the penalty stays "assessed". It is never marked applied from a commissioner's word alone.

## 4. If the pick is traded natively first

MFL's own site can't be blocked. The hourly check already catches it (`traded_away`), DMs you and the owner, keeps the pick blocked in the War Room, and never marks the forfeiture applied.

That leaves a **rule decision for you**, because the canon is silent:

- **A. Move the forfeiture** to the original team's next owned pick in that round. This mirrors the rule already used when a pick was "traded before it could be reserved". **(Recommended.)**
- **B. Reverse the trade** as commissioner, then forfeit as normal.
- **C. Skip the slot anyway** in the new holder's hands. Not recommended, because it penalises a team that did nothing wrong.

Whichever you choose, the original reservation is closed as `traded_away`, and a new one is created with an audit link.

## 5. Notices (draft wording)

Each is sent at most once, through the existing `alertOnce` / owner-DM plumbing.

| When | To | Text |
|---|---|---|
| Slot resolved | Owner | "Your 2027 4th-round pick (Round 4, Pick 7) was forfeited for your Week 6 lineup violation. It will be skipped in the rookie draft and can't be traded or used." |
| About 7 days before the draft | Commissioner | Checklist (§2). |
| Draft morning, if a slot isn't skipped yet | Commissioner | "Round 4, Pick 7 (Team X, Week 6 lineup penalty) isn't skipped on MFL yet. Skip it before the draft opens." |
| Applied | Owner and commissioner | "The forfeiture is applied: MFL shows Round 4, Pick 7 skipped." |
| Mismatch (§6) | Commissioner | Says what MFL shows, what the app expected, and what to do. |

A public follow-up in the Injury Report thread is **not** proposed. That's your call.

## 6. When MFL and the app disagree

The worker never writes to MFL to fix these. It holds the status and tells you.

| MFL shows | App expects | What happens |
|---|---|---|
| Slot drafted by the holder | Forfeited slot | DM you; the status stays assessed. Recovery is your call, for example Change Draft Pick to empty the slot, then skip it, or a rule-based substitute. Recorded as an audit event. |
| Slot skipped | No reservation | DM you. Nothing is created automatically. |
| Slot skipped, later un-skipped | Applied | Status goes back to "needs review" and you get a DM. It never stays "applied" without proof. |
| Slot owned by another team | Holder owns it | The §4 flow. |
| Export unreadable | Anything | No status change. One DM if it's still unreadable after 24 hours. |

## 7. Build plan (later, separate PRs, each with your go)

1. Run the forfeit check outside the NFL season. Fix `/api/pick` to use the slot on the clock.
2. Slot resolution, the `DP_` guard, the Rookie Draft Hub board and trade window display, and the `/api/pick` refusal.
3. The commissioner checklist DMs and a read-only Verify route.
4. Proof capture and the applied status, after the skip shape is confirmed on the test league.

## Decisions needed

1. **Pick traded natively before the draft:** A (move the forfeiture to the next owned pick), B or C? **Recommend A.**
2. **Who skips the slot:** you, manually in MFL before the draft (**recommended**), or a later worker `live_draft SKIP` at the clock as a backstop?
3. **May I confirm the skip shape on the test league** (L=25625) with one commissioner skip there? It's a write to the test league only.

## Also noticed (not part of this design)

- 2026 pick 6.03 shows a kicker taken in Round 6, which canon now limits to IDP. That may be a data discrepancy, or the rule may postdate the pick. It needs a separate check.
- The Round 6 order rebuild (`/api/r6/apply-order`) rewrites every slot's comments to blank, which drops "[Pick traded from X.]".
