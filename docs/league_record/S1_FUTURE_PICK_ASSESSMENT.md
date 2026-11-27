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

The extraction computes this as a **diagnostic** (`eventAccounting`; funnel field `event_accounting_eligible_if_custody_verified`, which counts the picks that **pass the screen**, a name chosen so it is not read as "resolvable"). Nothing is linked.

**Two honest limits of the reasoning.** (1) The per-franchise comparison, |S0| against picks held, is a count comparison used as a consistency screen: it catches one error but two compensating errors would pass it. Identity comes from the slot's token trail, not from the total, but the screen cannot see compensating errors. (2) Reading "the first recorded slot-token sender" as the franchise that held the slot when MFL first listed the slots is an **assumption** that the approved rule does not make (section 7).

## 5. What the diagnostic finds

**122 of the 597 picks (20.4%) pass the event screen; 475 do not.** Passing is not identity: it means that, **if** custody were verified over the whole round and the assumptions below held, the pick-to-slot reading would follow from events.

| Draft year | 2013 | 2014 | 2015 | 2016 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Pass the screen | 8 | 5 | 13 | 14 | 11 | 4 | 10 | 9 | 4 | 10 | 17 | 17 |

(2012 and 2017: 0.) 40 are in 2012-2017 and 82 in 2018-2025. Before 2018 the draft result can name whoever clicked rather than the owner (canon T1.8), which the screen guards against only partly.

**What the 122 still rest on** (disclosed in the extraction, not hidden; a pick can have several):

| Assumption or risk | Of the 122 |
|---|---|
| The holder's slot is one that **changed hands by slot token**, so the pick-to-slot reading assumes the first recorded token sender held it when MFL listed the slots | **67** |
| The holder ends with **several slots** at the draft (the approved rule refuses these) | **33** |
| A slot-token trade is **within 24 hours of a selection** in the round; before 2024 a trade time is the commissioner's processing time, so the order of trade and selection is not certain | **115** |
| **None of the three** | **1** |

So the honest figure is **1 pick** that rests on none of the disclosed assumptions, and **122** that pass the screen. Neither is a link.

Why the other 475 do not pass (a pick can have several reasons; the first row counts a pick only when no other reason fired, so it is a **lower bound** on picks held by a franchise with several picks):

| Reason | Picks | What would change it |
|---|---|---|
| The holder holds **several picks** in the round (counted only when nothing else blocked) | 343 | Only a direct MFL record of the original franchise for a slot. Never resolvable from these events. |
| Pick and slot accounts disagree for some franchise in the round | 96 | Missing or wrong events: a verified transaction source may reveal them. |
| A draft row of the round records no franchise id | 68 | The 20 legacy rows (2012: 9, 2014: 2, 2016: 1, 2017: 8) need a source for the selector. Only 2014 is covered by a proposed request (`S1_MFL_EXPORT_REQUESTS.md`, section 3), and that source may repeat the archive's own. |
| A slot-token chain ends at a franchise other than the recorded selector (the 2014 4.12 case is one) | 54 | Clicker versus owner, or a missing transfer; needs the draft-day record. |
| A slot of the round was forfeited (2018 round 4) | 10 | Forfeiture says nothing about whose pick it was; stays unresolved. |
| The round does not list one slot per franchise | 10 | The same 2018 round. |
| A slot-token chain has a break | 8 | A missing or misrecorded transfer. |

## 6. What must hold before any pick becomes a link

No link is made now. For a later, separately approved method (working name `EVENT_ACCOUNTING_V1`, class INFERRED, never CONFIRMED):

1. **Custody verified for the whole round**, not only for the one pick: every chain of the round (all twelve future-pick chains and every slot-token trail) from its first recorded event to the last selection, under the coverage model (`S1_SOURCE_COVERAGE_MODEL.md`: every day verified, with an end-state source). The unverified intervals this touches are **31 at the least** (`summary.future_picks.event_accounting_windows_needed`); the true need is larger, because the creation dates of the picks, and never-traded picks, have no recorded event. Under the coverage model's honest limit (an end-state source for a past date is not known to exist), **none of them can be verified today**.
2. **Round consistent** for every franchise, every slot-token chain unbroken and ending at the recorded selector.
3. **The holder owns exactly one pick** of the round and ends with exactly one slot; several picks or several slots are never resolved.
4. **No forfeited slot, no draft row without a franchise id, no chain break** anywhere in the round.
5. **A slot-token trade near a selection is a blocker** (order not certain), and a pick that rests on the first-sender reading is disclosed as such, not presented as equal to a pick that does not.
6. **Disclosed as inferred**, with the sets and events used, and withdrawable by a later contradicting record.
7. **Tests before approval:** the accounting on synthetic rounds (consistent; one franchise with several picks; a slot traded during the draft; a clicker-versus-owner mismatch; a missing token event; two compensating errors that the count screen would pass; a forfeited slot); a property test that no pick resolved by it is also CONFIRMED to a different slot by a token; the 597 stay unresolved until the method is enabled; an independent re-derivation by a second code path (the architecture review reproduced the 122 and its blocker counts with its own script).

## 7. What differs from the approved standard (stated, not hidden)

The approved rule (`UNIQUE_HOLDER_V1`) refuses any round with a slot-token transfer and requires the holder to own exactly one slot. Event accounting **differs in three ways, and each would weaken the standard unless the conditions in section 6 hold**:

- It **drops the round-wide veto** on slot-token transfers and accounts for the transfers as events instead.
- It adds the **first-sender assumption** (the first recorded sender of a slot token held the slot when MFL listed it). The archive supports it as far as it can be checked (no future-pick token of a year is ever traded in or after that year's instance, and none after the first slot token of the same round), but it is an assumption.
- Its consistency check is a **count comparison** (|S0| equals picks held), which two compensating errors can pass.

What is **stricter** than today: the coverage model requires every day to be verified (section 5 of the coverage document), where today's rule only looks at quiet windows.

What is **not proposed**: accepting count-only netting; treating a quiet period or a busy stretch as proof; using MFL's "Pick traded from..." notes as an inference rule (they stay corroboration only); using a forfeiture or a complete inventory as identity; deriving any slot from standings or a projected order.

## 8. Assessment

| Question | Answer |
|---|---|
| Could any link become supportable without weakening the standard? | **Not demonstrated.** 122 picks pass a screen that differs from the approved rule in the three ways above; **1** rests on none of the disclosed assumptions. Any of them would need verified custody over the whole round, which no known source can give for a past date, plus a separately approved and tested method. |
| Is any link supportable today? | No. 0 of 597. |
| Could most of the 597 ever be resolved from this evidence? | No. At least **343** are held by a franchise with several picks in the round and need a direct MFL record of which original franchise a slot belonged to. |
| What is the cheapest step that moves the most? | Finding a source that records the original franchise for a slot (or the end state at the moment slots were first listed); the 2026 gap request does not help the 2012-2025 picks. |
| Dependence on the 2014 conflict | The 2014 4.12 conflict is not used in any of this; its round is one of the 54 whose slot-token chain disagrees with the draft result. |
