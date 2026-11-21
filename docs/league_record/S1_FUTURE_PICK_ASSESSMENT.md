# League Record S1: which future-pick links could become supportable (assessment, decision 3 of 2026-11-21)

**Status:** an assessment with reproducible diagnostics, not a rule change. No link is added, `UNIQUE_HOLDER_V1` is unchanged (0 inferred), all 597 unresolved future picks stay in every report. Count-only reconciliation stays diagnostic and is not authoritative. Local and read-only. Every number below is a count of records in the committed extraction (`docs/league_record/archive/extraction.json`, `summary.future_picks`).

## 1. The identity problem in one paragraph

A future-pick token names the **original franchise, year and round**; it never names a slot. A slot token names the **slot**; it never names the original franchise. Draft results name the slot and the franchise that made the selection. Nothing the archive holds says "the pick that began as franchise A's became slot 7"; the draft order that would say so comes from the standings, which this project never uses. So a link from a future pick to a slot can only come from **accounting for events** (who held which pick and which slot, when) until a direct MFL record names the original franchise for a slot.

## 2. Why matching counts is not enough

If a franchise holds two picks and two slots in a round, the totals agree and the pairing is still undetermined. A slot-token trade tells us a slot moved from X to Y; it does not tell us which pick that slot came from. Count netting ("the number of picks X holds equals the number of slots X has") can show that the books *balance*, never *which pick is which slot*. So it stays a diagnostic. Likewise a **known forfeiture** (2018 pick 4.12) or a **complete round inventory** shows that nothing is missing from a round; neither identifies any individual pick.

## 3. Where the 597 stand today

| Condition | Picks | Note |
|---|---|---|
| Traded future picks, draft years 2012-2025 | **597** | 2010 and 2011 have no draft results |
| Custody observed under the strict rule | **0** | every pick crosses at least one unverified quiet window |
| Round inventory complete under the approved rule | **0** | every round that has a traded future pick also has a slot-token transfer, and the approved rule refuses such a round |
| Round would reconcile if slot-token transfers were netted by count (diagnostic) | 147 | not an inference method |
| Holder owns exactly one slot in the round | 193 | one slot is not one pick |
| Both of the two lines above (diagnostic) | 51 | not an inference method |
| CONFIRMED / INFERRED / UNRESOLVED | 0 / 0 / **597** | unchanged |

## 4. The event-based accounting that could carry identity

For one round, per franchise F, define **S0(F)**: the slots F held when MFL first listed the slots. From events and draft results:

- a slot with **no** slot-token event belongs to the franchise recorded as its selector;
- a slot **with** slot-token events belongs to the first recorded sender of its token;
- S0 is complete only if every slot-token chain is unbroken and ends at the franchise recorded as selector.

The future-pick chains independently say how many picks each franchise held at that moment. The round is **consistent** when |S0(F)| equals the picks F held, for **every** franchise. In a consistent round, a franchise that holds **exactly one pick** has exactly one slot in S0, and that slot is that pick's. That conclusion comes from events (the slot's token trail), not from a matched total, and a franchise holding several picks is never resolved. The round-wide veto on slot-token transfers is replaced by a per-slot trail: a round with a slot-token transfer is still evaluated, because the transfer is one more event to account for.

The extraction computes this as a **diagnostic** (`eventAccounting`, funnel field `event_accounting_eligible_if_custody_verified`), assuming custody were verified. Nothing is linked.

## 5. What the diagnostic finds

**122 of the 597 picks (20.4%) are evaluable by event accounting if custody were verified**; 475 are not.

| Draft year | 2013 | 2014 | 2015 | 2016 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Evaluable | 8 | 5 | 13 | 14 | 11 | 4 | 10 | 9 | 4 | 10 | 17 | 17 |

(2012 and 2017: 0.) 40 are in 2012-2017 and 82 in 2018-2025. The earlier group carries an added uncertainty: before 2018 the draft result can name whoever clicked rather than the owner (canon T1.8). The round-wide consistency test guards against it only partly, so **the 2018 and later group is the one to approve first.**

Why the other 475 are not evaluable (a pick can have several reasons; they are not additive):

| Reason | Picks | What would change it |
|---|---|---|
| The holder holds **several picks** in the round | 343 | Only a direct MFL record of the original franchise for a slot. Never resolvable from these events. |
| Pick and slot accounts disagree for some franchise in the round | 96 | Missing or wrong events: a verified transaction source may reveal them. |
| A draft row of the round records no franchise id | 68 | The 20 legacy rows need a source for the selector (MFL 2014 draft results export, section 2 of the requests document). |
| A slot-token chain ends at a franchise other than the recorded selector (the 2014 4.12 case is one) | 54 | Clicker versus owner, or a missing transfer; needs the draft-day record. |
| A slot of the round was forfeited (2018 round 4) | 10 | Forfeiture says nothing about whose pick it was; stays unresolved. |
| The round does not list one slot per franchise | 10 | The same 2018 round. |
| A slot-token chain has a break | 8 | A missing or misrecorded transfer. |

## 6. What must hold before any of the 122 becomes a link

No link is made now. For a later, separately approved method (working name `EVENT_ACCOUNTING_V1`, class INFERRED, never CONFIRMED):

1. **Custody verified** for the event class `pick_transfer` over every interval the pick's chains cross, under the coverage model (`S1_SOURCE_COVERAGE_MODEL.md`). Today 0 of the 122 qualify; they need 30 distinct unverified quiet windows verified (in the 2013-2025 league instances; the list is in `summary.future_picks.event_accounting_windows_needed`).
2. **Round consistent** for every franchise, with every slot-token chain unbroken and ending at the recorded selector.
3. **The holder owns exactly one pick** of the round; several picks are never resolved.
4. **No forfeited slot, no draft row without a franchise id**, no chain break anywhere in the round.
5. **The result is disclosed as inferred**, with the S0 sets and the events it used, and it can be withdrawn by a later contradicting record.
6. **Tests before approval:** the accounting on synthetic rounds (consistent, one franchise with several picks, a slot traded in the draft, a clicker-versus-owner mismatch, a missing token event, a forfeited slot); a property test that no pick resolved by it is also CONFIRMED to a different slot by a token; a check that the 597 stay unresolved until the method is enabled; and an independent re-derivation of every eligible pick by a second code path.

## 7. What does not weaken the evidence standard

- Replacing the **round-wide veto** with **per-slot event accounting** (section 4), because the same facts are required and more are checked (every franchise, every token chain).
- Replacing the 14-day **quiet window** with the **coverage state**, because a verified interval is a stronger statement than a quiet period.

What would weaken it, and is **not** proposed: accepting count-only netting; treating a quiet period as proof; using MFL's "Pick traded from..." notes as an inference rule (they stay corroboration only); using a forfeiture or a complete inventory as identity; deriving any slot from standings or a projected order.

## 8. Assessment

| Question | Answer |
|---|---|
| Could any link become supportable without weakening the standard? | Yes, up to **122** (82 in 2018-2025), **if** custody is verified and a separate method is approved and tested. |
| Is any link supportable today? | No. 0 of 597. |
| Could most of the 597 ever be resolved from this evidence? | No. **343** are held by a franchise with several picks in the round and need a direct MFL record of which original franchise a slot belonged to. |
| What is the cheapest step that moves the most? | Verifying custody for the 30 windows (an optional trade-only export per instance year) plus approving a tested method; the 2026 gap request does not help the 2012-2025 picks. |
| Dependence on the 2014 conflict | The 2014 4.12 conflict is not used in any of this; its round is one of the 54 whose slot-token chain disagrees with the draft result. |
