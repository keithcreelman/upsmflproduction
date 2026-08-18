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
| A9 | Over the 4-starting-QB cap at the contract deadline | Forced cuts in reverse-acquisition order, normal penalties to next season | **Nobody** — no code found | §B1 |
| A10 | Missing the $260K floor (auction → contract deadline) | **The shortfall, charged to the current season AND the next.** End $10K light → $10K + $10K | **Nobody** — no worker-side check | §6.A2 |
| A14 | 2nd extra nomination | $3K current + next | **Nobody** — `closeEtDay` never tests `used > required` | §T4.3a |
| A15 | 3rd extra nomination | +$7K cumulative, current + next | Nobody | §T4.3a |
| A16 | 4th extra nomination | +$15K cumulative, current + next | Nobody | §T4.3a |
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
| Late dues | $3K per week against the cap (was A8) | **Retired 2026-08-17 (Keith).** *"We had to do [this] occasionally but that might've been a 1 or 2 off because we had some bad eggs in the league."* Ad-hoc enforcement aimed at specific owners who are gone, not a standing rule. Never had code behind it. Non-payment is now a commissioner conversation. |
| Trade response > 96 hours in-season (2 weeks offseason) | Strike; 3 strikes in a Feb 1–Jan 31 season = trading privileges revoked for the rest of it | Retired — no strike since 2017. MFL now auto-expires offers at 7 days, which is the same intent mechanized. Full text: forum `/t12-trade-violation-rules`. |

---

## Part 2 — What's wrong with it

**1. ~~Four currencies, no exchange rate.~~** *(Overstated — revised 2026-08-17.)* The four currencies are real, but the **cap-dollar penalties are already one consistent family**: every auction-period penalty charges the current season *and* the next, and the three offense ladders all run $3K → $7K → $15K cumulative, ending in a league-fit review. Keith supplied the exchange rate that was missing (a 4th ≈ $15K cap, cap possibly lighter), which is enough to check proportionality — and on it, the lineup and nomination ladders match rather than diverge. What is left is not an exchange-rate problem.

**2. ~~The two ladders disagree with each other.~~** *(Wrong — withdrawn 2026-08-17.)* I read the nomination ladder's 4th offense as de-escalating "to nothing." It isn't a de-escalation: the 4th offense is a **league-fit review**, which escalates *out of* the cap currency into membership — the heaviest rung there is. Both ladders end at a membership review. There are in fact **three** ladders (missed nomination, extra nomination, lineup violation) and they share one shape: an optional free first offense, then $3K/$7K/$15K-equivalent escalation, then membership. They agree.

**3. ~~Severity doesn't track harm.~~** *(Half wrong — revised 2026-08-17.)* The harm ranking is right — an illegal lineup hands a free win to your opponent and distorts All-Play for eleven other teams, which now moves $900 of Dynasty Pot, while a missed nomination inconveniences a queue. But I used it to argue the free first lineup violation was mispriced, and **the first rung is not priced on harm at all.** Keith 2026-08-17: it is priced on whether a diligent owner can trip it by accident. Eighteen starting slots can be overlooked; nominating two players in a day cannot. From offense #2 onward the ladders do track harm and do match each other. What survives from this item is only the enforcement half: the nomination ladder is automated and exact, the lineup ladder is counted by hand in Discord.

**4. Enforcement is wildly uneven — the one real problem left.** Missed-nomination fines are fully automated, exact, ledgered, and have a working immunity path. Against that:

| Rule | What actually happens |
|---|---|
| Missed nomination | Fully automated: detected, priced, ledgered, re-derived on excuse |
| Roster < 27 | **Blocked by MFL.** Nothing to enforce |
| 3rd nomination in a day | Blocked by the UPS app — but **not by MFL**, so a native MFL nom slips through and nothing books the offense (`closeEtDay` tests only the miss side) |
| Illegal lineup | **Built 2026-08-17** (`lineup_compliance.js`). Hourly injury-status snapshots make the 24-hour anchor computable for the first time; one violation per franchise-week; refuses to judge an unobserved window |
| $260K floor | No worker-side check. Now that the amount exists, it is computable |
| 4-starting-QB cap, 5-QB cap, 4-MYM limit | No implementation at all |

The pattern: where a rung is automated it is uncontroversial, and where it is manual it has never been applied past #1. Detection — not pricing — is what separates the two.

**5. ~~Two penalties have no stated amount.~~** — **BOTH CLOSED 2026-08-17.** The cap floor now has its amount: the shortfall, charged to the current season *and* the next (§6.A2, from Keith's §F RULE 1 text). And dropping below 27 needs no penalty — **MFL blocks it outright** (Keith 2026-08-17), so it is a hard constraint, not an unenforced rule. It should never have been on this list.

**6. One penalty punishes the wrong person.** Transaction reversal (C6) unwinds a trade the *counterparty* completed in good faith. Keith's ruling in §G7.1.

**7. ~~Cap penalties are self-defeating on the teams that trigger them most.~~** *(Argued, then withdrawn.)* The claim was that cap penalties make a bad team worse and feed disengagement. **Keith 2026-08-16: "Cap Penalties is the same as draft capital imo even less painful."** That is the commissioner's read of how the two currencies actually land in this league, and it is better evidence than the theory — a $15K cap hit is absorbable, a lost 2nd-rounder is not. Recorded here rather than deleted so the reasoning isn't re-proposed later. **Open for the league**: if cap and draft capital really are near-equivalent, the two ladders in issue 2 are less mismatched than they look, and the fix is mostly to align their *escalation shape* rather than their currency.

---

## Part 3 — A proposed system

Not a rule change. A shape to react to.

### Principle 0 — The free first offense is priced on accident-risk, not harm (Keith 2026-08-17)

Whether offense #1 is free tracks **whether a diligent owner can trip it by accident**, not how much damage it does:

| Failure | #1 | Why |
|---|---|---|
| Missed nomination | **$3K + $3K** | *"You need to be dumb as shit not to understand to nominate 2 guys in a day."* |
| Extra nomination | **Warning** | *"It can happen by accident we've all done it."* |
| Illegal lineup | **Warning** | *"It's easy to overlook a lineup decision especially with all of the roster spots. So we allow for 1 mistake."* |

The lineup warning is also doing the job I thought was missing — it absorbs the genuine emergency, and Keith 2026-08-17 confirms *"in a situation like this we give deference to family issues"* on top of it. **Test for any new penalty: can a diligent owner do this by accident?** Yes → free first offense. No → price it from #1.

### Principle 1 — Match the severity to the harm

Per Keith (2026-08-16), cap and draft capital are near-equivalent in felt cost, with cap arguably the *lighter* of the two. So currency is the weaker lever; **severity and escalation are the real ones.** Revised:

| Failure type | Response | Why |
|---|---|---|
| **Compliance** (illegal roster or cap state) — a state to fix, not an act to punish | **Block further moves until cured.** Penalty only if the cure window lapses. | The goal is a legal roster, not revenue. Keith's §G7.1 direction, and it can't be gamed as buyer's remorse. |
| **Administrative** (missed nomination) — costs the league process | **Cap**, escalating | Automatable and precise. Already works; leave it. **Late dues no longer belongs in this row** — retired 2026-08-17 (§T4.4). It was also the one cross-currency case here: a cap fine for a cash obligation. If the league ever wants a standing consequence for non-payment, design it as a *cash* one. |
| **Competitive** (illegal lineup, not fielding a real team) — distorts every other team's record | **Cap or draft capital, escalating to membership** | This is where severity has to exceed the administrative ladder, because the harm is to everyone else. Whether it's paid in cap or picks matters less than that it out-weighs a missed nomination — which today it does not consistently. |

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

### Principle 5 — One structure, already in use

Every auction-period cap penalty charges **the current season and the next**: nomination fines, extra-nomination fines, and the cap-floor shortfall. It is worth stating as the house rule rather than rediscovering it per penalty — and the floor case shows why it exists. Charging a floor shortfall *once* would be a no-op, since you'd owe exactly the cap dollars you declined to commit; the second year is the entire deterrent.

### Open questions for the league

1. ~~**Is a 4th-round pick worth more or less than $15K in cap?**~~ **Answered (Keith 2026-08-16): roughly equivalent, cap possibly lighter.** The follow-on I raised — whether a $5K lineup violation is weaker than a $7K nomination miss — **was my arithmetic error and is withdrawn.** It compared the cash halves only, dropping the 4th-round pick attached to violation #2 and the fact that nomination fines charge to two cap years while the lineup fine charges to one. Corrected: lineup #2 ≈ $20K vs nomination #2 = $20K; lineup #3 ≈ $55K vs nomination #3 = $50K. **The ladders match. Neither needs re-pricing.**
2. ~~**What does missing the $260K floor actually cost?**~~ **ANSWERED 2026-08-17** — the shortfall, current season and next (§6.A2, §F RULE 1).
3. ~~**Should lineup violations reset annually, or accumulate across seasons?**~~ **ANSWERED 2026-08-17 (Keith): they reset each season.** Count starts at zero every year, which means expulsion at #5 requires five illegal lineups *in one season*. Matches §F RULE 2, which was already season-scoped in code. See §G3.
4. ~~**Do violations 2–5 keep their 2018 prices?**~~ **CONFIRMED 2026-08-16 (Keith): "yes that's the current penalty."**
5. ~~**What's the penalty for lapsing the compliance cure window?**~~ **ANSWERED 2026-08-17 (Keith).** Pre-season cap non-compliance → **the amount you are out by, this season and next** (§F RULE 1's floor penalty pointed at the ceiling). In-season illegal roster → **it becomes a §G3 lineup violation**, since by then you have fielded an illegal roster and the harm is the same. Derived from existing structures: no new currency, no new numbers. See canon §G7.1a.

### Detection, as of 2026-08-17

Principle 3 says a rule nobody can detect is not a rule. Where each stands now:

| Rule | Before | Now |
|---|---|---|
| Missed nomination | automated | automated |
| Extra nomination | **nothing** — app-side block only, bypassable via MFL | **built** — `closeEtDay` books the over side (0128) |
| Illegal lineup | **nothing** — counted by hand in Discord | **built** — `lineup_compliance.js` + `lineup_wiring.js` (0129) |
| 4 MYMs/season | **nothing** — the client claimed the worker did it | **built** — `mym_guard.js`, blocks at submit |
| 14-day MYM window | **nothing** — same false claim | **built** — same guard |
| 5-QB active max | **nothing** | **built** — `/admin/qb-caps/check`, deterministic |
| 4-starting-QB cap | **nothing** | **reported** — same endpoint; starter status is a commissioner input, never inferred |
| Roster < 27 | blocked by MFL | blocked by MFL |
| $260K floor | no check | amount now stated (§6.A2); check still unbuilt |

The 4-starting-QB cap stops at *reported* on purpose. Canon's consequence is real cuts with real dead money, and canon itself makes starter status a commissioner determination — FantasyPros' depth-chart page is client-rendered (verified 2026-08-17: zero `QB` in the served HTML), so there is no honest scrape behind an automated answer either. Making it **visible** is the most a rule of that shape can honestly be.

**Still unbuilt:** the $260K floor check. It is now computable — the amount is stated — but nothing runs it.
