# Penalty Inventory

Every consequence the league can impose, in one place, so a coherent system can be designed instead of patched. Compiled 2026-08-16 at Keith's request (*"Let's compile a list of all our potential penalties and maybe come up with a system that makes sense"*).

**Status: inventory + proposal. Nothing here is a rule change.** Sources are canon (`league_context_v1.md`), the running code, and the 2012/2013/2014/2018 rulebooks (`rulebook_source_archive.md`).

---

## Part 1 — What exists today

### A. Cap penalties (charged in cap dollars)

| # | Trigger | Amount | Enforced by | Canon |
|---|---|---|---|---|
| A1 | Cutting a player | 75% of TCV − earned | **Code** (`_computeDropPenalty`) | §D1 |
| A2 | Cutting a sub-$4K multi-year deal | Flat $1K if 2+ years left, $0 in final year | Code (⚠️ **buggy** — nets against earning, produces a moving number) | §D1 |
| A3 | Loaded-contract settlement on a cap-free exit | (AAV × years served) − actually paid; can be a credit | **Code** (`_d2aSettlement`) | §D2a |
| A4 | 1st missed auction nomination | $3K, **charged to two cap years** | **Code** (`auction_compliance.js`) | §F R2 |
| A5 | 2nd missed nomination | +$7K (cumulative), two cap years | Code | §F R2 |
| A6 | 3rd missed nomination | +$15K (cumulative), two cap years | Code | §F R2 |
| A7 | 4th+ missed nomination | **$0** — "a conversation about league fit, not a transaction" | Code (ladder caps at 3) | §T4.3a |
| A8 | Late dues | $3K per week late | Commissioner, manual | §T4.4 |
| A9 | Over the 4-starting-QB cap at the contract deadline | Forced cuts in reverse-acquisition order, normal penalties to next season | **Nobody** — no code found | §B1 |
| A10 | Missing the $260K floor | "Out of compliance, draws a cap penalty" — **amount never stated** | Advisory only | §6.A2 |
| A11 | Lineup violation #2 | $5K next season (+ a 4th-round pick) | Commissioner, manual | §G3 |
| A12 | Lineup violation #3 | +$5K (+ a 2nd-round pick) | Commissioner, manual | §G3 |
| A13 | Lineup violation #4 | +$10K if retained by league vote | Commissioner, manual | §G3 |

### B. Draft-pick penalties

| # | Trigger | Amount | Enforced by | Canon |
|---|---|---|---|---|
| B1 | Lineup violation #2 | Loss of a 4th-round pick | Commissioner | §G3 |
| B2 | Lineup violation #3 | Loss of a 2nd-round pick | Commissioner | §G3 |
| B3 | Round 6 pick that isn't an IDP | Pick reversed and lost, no replacement | Commissioner | §A1 |

If a stripped pick isn't held, it's taken at the next opportunity (trade or rollover).

### C. Privilege / access penalties

| # | Trigger | Consequence | Enforced by | Status |
|---|---|---|---|---|
| C1 | Cutting a player under contract in the offseason | Barred from bidding on him in that summer's auction | Commissioner | Live (§A2) |
| C2 | Winning a player in the ERA | Cannot cut him until the FA Auction closes | Commissioner | Live (§A3) |
| C3 | Roster at 35 during the auction | Bid **refused** (HTTP 422) | **Code** | Live |
| C4 | Bid exceeds funds − reserve | Bid **refused** (422) | **Code** | Live |
| C5 | Remaining slots owed to unfilled positions | Bid **refused** (422, `position_locked`) | **Code** | Live, **undocumented anywhere** |
| C6 | In-season transaction breaking your lineup or cap | 24 hours to cure, else transaction reversed | Legacy | ⚠️ **Being replaced** — §G7.1 |
| C7 | 3 trade-response strikes in a season | Trading privileges revoked | — | **Dead** (2012–2018 rule) |
| C8 | Unpaid dues / accumulated fines | Locked out of all roster moves | — | **Dead** (2011/2014 rule) |

### D. Membership penalties

| # | Trigger | Consequence | Canon |
|---|---|---|---|
| D1 | Lineup violation #4 | League vote on retention | §G3 |
| D2 | Lineup violation #5 | Automatic expulsion | §G3 |
| D3 | Failure to submit any lineup | Explain by Tuesday, league vote; 2nd occurrence is automatic expulsion | §G3 |
| D4 | Collusion (pattern across repeated transactions) | Removal by league vote | §G2, §4 |

### E. Retired penalties — do not apply

| Trigger | Old penalty | Replaced by |
|---|---|---|
| Cutting a player | 20% of remaining salary | 75% guarantee (2019) |
| In-season waiver pickup cut | Flat 35% of current-year salary | Per-week pro-rated earning (2026-05) ⚠️ **still live in `roster_workbench.js:2148`** |
| Missed nomination | $10 / +$20 / +$30 cash, lockout at $60 | §F RULE 2 cap ladder |
| Over-cap auction bid | $10 fine | MFL blocks the bid |
| Logo change | $15 | Retired (§T4.5) |
| Not voting | Franchise forfeited to a new owner | Retired (2011) |
| Trade response > 96 hours | Strike; 3 strikes = no trading | Retired; MFL auto-expires offers at 7 days |

---

## Part 2 — What's wrong with it

**1. Four currencies, no exchange rate.** Cap dollars, draft picks, privileges, membership. Nothing relates them. Is losing a 4th-rounder heavier or lighter than $15K in cap? Nobody can say, so nobody can tell whether the ladder is proportionate.

**2. The two ladders disagree with each other.** Missed nominations: $3K → $7K → $15K → **free**. Lineup violations: warning → 4th + $5K → 2nd + $5K → retention vote → expulsion. One de-escalates to nothing on the 4th offense; the other escalates to expulsion. Both are "you didn't do a required thing repeatedly."

**3. Severity doesn't track harm.** Missing a nomination inconveniences an auction. Fielding an illegal lineup hands a free win to whoever you played and distorts All-Play for all eleven other teams — which now moves $900 of Dynasty Pot. The nomination miss is automated and precise; the lineup violation is manual and priced from a 2018 document.

**4. Enforcement is wildly uneven.** Nomination fines are fully automated and exact. The 4-starting-QB cap, the 5-QB cap, the 4-MYM limit, the $260K floor, and every lineup violation have **no implementation at all**. A rule nobody can detect isn't a rule.

**5. Two penalties have no stated amount.** Missing the cap floor "draws a cap penalty" (§6.A2) — how much has never been written. Dropping below 27 is "a compliance violation" with no consequence named.

**6. One penalty punishes the wrong person.** Transaction reversal (C6) unwinds a trade the *counterparty* completed in good faith. Keith's ruling in §G7.1.

**7. Cap penalties are self-defeating on the teams that trigger them most.** The owner who misses nominations, misses lineups, and pays late is usually the disengaged owner on a bad roster. Cap penalties make his team worse, which makes him more disengaged. The punishment accelerates the behavior.

---

## Part 3 — A proposed system

Not a rule change. A shape to react to.

### Principle 1 — Match the currency to the failure

| Failure type | Currency | Why |
|---|---|---|
| **Competitive** (illegal lineup, tanking) — distorts other teams' results | **Draft capital + membership** | The harm is to competitive integrity, so the cost should be to future competitiveness. Cap penalties make a bad team worse and feed the spiral. |
| **Administrative** (missed nomination, late dues) — inconveniences process | **Cap** | Self-limiting, automatable, precise. Already works. |
| **Compliance** (illegal roster/cap state) — a state to fix, not an act to punish | **Blocked privileges until cured** | The goal is the fix, not the fine. Keith's §G7.1 direction. |

### Principle 2 — One escalation shape everywhere

```
1st   warning, logged
2nd   penalty in the matching currency
3rd   heavier penalty, same currency
4th   league review of membership
```

Both existing ladders bend to this. The nomination ladder's "4th is free" becomes a 4th-offense review — which is what §T4.3a *already says it is* ("a conversation about league fit"), just without the fine.

### Principle 3 — Don't write a penalty you can't detect

Every penalty needs a named detector: code, an MFL setting, or a specific commissioner check on a specific date. If none exists, either build it or don't write the rule. This is what separates the nomination ladder (automated, enforced, uncontroversial) from the 4-starting-QB cap (written, never checked).

### Principle 4 — Cure beats punish on compliance

For roster/cap state, the lever is blocking further moves until legal:
- **In-season:** the weekly valid-lineup requirement is the control (Keith, §G7.1)
- **Pre-season:** cure by the earlier of the next two waiver cycles or roster deadline day
- Penalty only if the cure window lapses — and then it's a competitive penalty, since by then you've fielded an illegal roster

### Open questions for the league

1. **Is a 4th-round pick worth more or less than $15K in cap?** Answering this once makes every other tradeoff decidable.
2. **What does missing the $260K floor actually cost?** (§6.A2 has never said.)
3. **Should lineup violations reset annually, or accumulate across seasons?** Neither ladder says.
4. **Do violations 2–5 keep their 2018 prices?** Pick-stripping is heavy; nobody has been past violation 1 in the current era.
5. **What's the penalty for lapsing the compliance cure window** under the new §G7.1 model?
