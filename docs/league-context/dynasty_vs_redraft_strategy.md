# Dynasty vs. Redraft Strategy in a Hybrid League

**Author:** Keith + Claude analysis | **Date:** 2026-04-30 | **Status:** Living draft — additive analysis welcome

## TL;DR

UPS is structurally a **hybrid dynasty/redraft league**: 3-yr contracts and dynasty mechanics exist, but the annual FA Auction reshuffles ~200 players every year, and most cheap bets bust within 12 months. The empirical evidence says:

1. **Sub-$5K bids drop 80% of the year-1 time.** A 3-yr $5K deal is a **net-negative EV bet** unless you genuinely believe the player will price at $25K+ in years 2-3 — that bar is almost never cleared.
2. **$30K+ bids drop only ~30% of the time.** This is where multi-year deals start to pay off. Breakeven for a 3-yr $30K bet is "must be worth $43K+ in years 2-3."
3. **The cap-math asymmetry is brutal.** A 3-yr $5K player cut in October of Year 1 costs **$15K total ($5K paid + $10K dead)** for one year of bench production. A 1-yr $5K cut the same date costs **$5K**. Two-thirds of the cost difference disappears with no upside.
4. **Rookie picks are the dynasty efficiency play.** Rookie auction R3+ taxi-eligible cuts are cap-free pre-promotion. R1-R2 contracts default to 3-yr at low salaries with built-in cost lock. A 1st-round rookie pick is worth ~$25K equivalent in expected dynasty value, and the variance is asymmetric (huge upside, low downside).
5. **Position determines horizon.** QB in SF era = dynasty (long career arcs). RB = mostly redraft (age cliff at 28-30). WR/TE = mixed.

The "fine line" Keith asks about is real but knowable: it depends on bid amount, drop probability, and projected market value over the remaining contract years. The math is in section 3 below.

---

## 1. The Hybrid Structure

| Mechanic | Dynasty-flavored | Redraft-flavored |
|---|---|---|
| Default contract length | 3 yrs (dynasty) | 1 yr (redraft default for FA Auction) |
| Annual auction | — | ~200 players auctioned every July (redraft) |
| Extensions / restructures | Allowed (dynasty) | Bound by 6×3-yr cap, 4 MYM/season, 3 restructures/season |
| Taxi (10 slots) | Holds rookies multi-year cheap | Off-cap = no annual cost |
| Rookie draft | 6 rounds, 3-yr default | — |
| Tags (1 off + 1 def-ST/season) | — | 1-yr cap commitment, prevents departure |
| Cap floor ($260K) | — | Forces minimum spend each year |
| Cap ceiling ($300K) | — | Hard cap each year |
| Drop penalty | (TCV × 0.75) − earned | Pushes against multi-year speculation |

**Key insight:** Any roster decision lives somewhere on a spectrum from pure-redraft (1-yr cheap auction win) to pure-dynasty (3-yr cheap rookie pick + extension). The cap math + drop penalty create the price signal that says *which way the spectrum tips for a given player*.

---

## 2. The Cap-Math Decision Framework

Every multi-year decision is a bet against the cut-penalty formula (Section 6.C1):

```
Penalty = (TCV × 0.75) − Salary Earned
```

The penalty hits the cap of either the current season (offseason cuts) or next season (in-season cuts) per the Section 3 timing buckets.

### Worked example: $5K bet, 3-yr contract

| Cut date | Earned | Penalty | Total cost (Y1 paid + dead) |
|---|---|---|---|
| March (offseason post-Y1) | $5,000 | $6,250 | **$11,250** for 1 yr of value |
| October Y1 | $1,250 | $10,000 | **$15,000** for 1 yr of value |
| December Y1 | $3,750 | $7,500 | **$12,500** for 1 yr of value |
| Never cut (full 3 yrs) | $15,000 | $0 | **$15,000** total over 3 yrs |

**Compare to 1-yr $5K:** Total cost = $5,000 + walk-away. Saves $6,250–$10,000 per cut event.

### Worked example: $30K bet, 3-yr contract

| Cut date | Earned | Penalty | Total cost |
|---|---|---|---|
| March (offseason post-Y1) | $30K | $37.5K | **$67.5K** for 1 yr of value |
| October Y1 | $7.5K | $60K | **$90K** for 1 yr of value |
| Never cut (full 3 yrs) | $90K | $0 | **$90K total over 3 yrs** |

**Compare to 1-yr $30K:** $30K and walk. Saves $37-60K per cut event.

The asymmetry: **the penalty as a multiple of Y1 salary is brutal.** A 3-yr $5K cut Oct Y1 is **3× more expensive** than just paying $5K for 1 year. For $30K it's also 3× more.

So multi-year deals only pay off when the **probability of staying through the contract** is high enough to amortize the dead-money risk.

---

## 3. Empirical Drop Rates by Bid Band

Pulled from `transactions_auction` joined with `transactions_adddrop`, 2020-2024 (5 SF-era seasons):

| Bid band | Auction wins (5 yr) | % dropped within year | Implication |
|---|---|---|---|
| **<$5K** | ~1,160 | **~83%** | Most dollar-store bets bust |
| **$5K-$15K** | ~157 | **~50%** | Coin flip; no edge for multi-yr |
| **$15K-$30K** | ~55 | **~58%** | High variance band — proven vets vs. uncertain breakouts mix |
| **$30K-$60K** | ~38 | **~32%** | Sticky: these are usually proven elites |
| **$60K+** | ~9 | ~50% | Small sample (one bad bet ≠ "never multi-yr 60K+") |

**Interpretation:**
- Below $15K: drop rates above 50% mean **multi-year deals are a coin flip whether you eat dead money or not**. The expected cost of a multi-year is HIGHER than 1-yr unless you've identified a clear breakout candidate.
- $30-60K: only 32% drop — these are typically *known producers* and the multi-year discount can pay off if extension-eligible market value rises.
- $60K+: too few data points to generalize, but most of these are tag transfers or one-off elites (Brady 2022, Henry 2023).

### Why the long tail of <$5K bets fails so often

Most $1K-$3K bids are filler/lottery picks: backup RBs, deep-bench WRs, IDP rotations. They're picked up then dropped within weeks because:
- Better waiver targets emerge
- Injuries shift roles
- Performance-based judgments after Week 2-4

This is **structurally a redraft mechanic** masquerading as a multi-year contract.

---

## 4. Multi-Year Contract Breakeven Math

For a contract worth `S` dollars at AAV with length `L`, drop probability `p` per year, and projected year-N market value `M_n`, the breakeven condition is:

```
Expected gain (if retained) ≥ Expected loss (if cut)

(1 − p) × Σ_n=2^L (M_n − S) ≥ p × E[penalty | cut]
```

**$5K-3yr case (the question Keith asked):**
- p ≈ 0.80 (year-1 drop rate)
- E[penalty | cut] ≈ $10K (October Y1 average)
- For breakeven: `0.20 × 2 × (M − $5K) ≥ 0.80 × $10K`
- → `M − $5K ≥ $20K`
- → **The player must project to be worth $25K+ in years 2-3 for the gamble to break even.**

For a $5K bet to hit a $25K+ market value in years 2-3 requires: NFL breakout AND fantasy ascension AND injury-free. Empirical hit rate << 20%.

**Conclusion: 3-yr $5K bets are net-negative EV almost always.** Use 1-yr deals for cheap bets; if the player ascends, you pay the new market price next auction (you don't lose the asset — the Comp pick + cap structure means cost-of-keeping is bounded).

**$30K-3yr case:**
- p ≈ 0.32
- E[penalty | cut] ≈ $60K (October Y1)
- For breakeven: `0.68 × 2 × (M − $30K) ≥ 0.32 × $60K`
- → `M − $30K ≥ $14.1K`
- → **Player must project to be worth $44K+ in years 2-3 for breakeven.**

This is **plausible** for elite RBs/WRs entering primes (e.g., Bijan, Puka, ARSB types). Multi-year on $30K+ is a defensible play *if you've correctly identified a rising star*.

**$5K-1yr (no risk):**
- Cost: $5K. No multi-year exposure.
- Re-bid next year if ascended. Pay market value.
- This is the **default winning strategy at low bid bands** unless you have very strong conviction.

---

## 5. Young (Picks) vs. Veteran (Auction) — Which Is the Better Buy?

### Rookie picks have built-in dynasty efficiency

| Pick | Default contract | Year-1 salary | TCV | Cap-free cut window |
|---|---|---|---|---|
| 1st-round | 3-yr | $15K | $45K | Promoted from taxi → standard rules |
| 2nd-round | 3-yr | $10K | $30K | Promoted from taxi → standard rules |
| 3rd-6th-round | 3-yr | $5K (R3-R5), $1K (R6) | $15K / $3K | **Cap-free if never promoted from taxi** (Section 6.C2) |

**Key escape hatch:** R3+ rookies can be cut cap-free if they never come off taxi. So for R3+ picks, the multi-year exposure is **functionally a free option**: hit on the player → lock 3 years cheap; miss → cap-free cut. Asymmetric upside.

This is **fundamentally different** from a $5K vet bet on 3-yr (which incurs the $10K penalty if cut).

### Trading vet for picks: empirical conversion rates

Pick → first market event ($ value at extension AAV, tag salary, FA auction win, or $0 if cut/expired-unsigned). Pulled from `pipelines/analytics/rookie_pick_value_realization.py` over 2017-2021 cohorts (5 fully-resolvable draft classes, offensive picks only). Per-pick detail in `pipelines/reports/rookie_pick_value_realization.csv`; rollup JSON at `site/analytics/rookie_pick_value_summary.json`.

| Pick tier | Range | n | Mean | Median | p10 | p90 | % Ext | % FA/Tag | % Zero |
|---|---|---|---|---|---|---|---|---|---|
| Early 1st | 1.01–1.04 | 21 | $13.9K | $14.0K | $1.0K | $28.3K | 67% | 24% | 10% |
| Mid 1st | 1.05–1.08 | 20 | $14.3K | $11.5K | $0 | $29.1K | 60% | 25% | 15% |
| Late 1st | 1.09–1.12 | 19 | $13.6K | $15.0K | $0 | $26.2K | 74% | 11% | 16% |
| Early 2nd | 2.01–2.04 | 21 | $5.0K | $1.0K | $0 | $18.3K | 43% | 14% | 43% |
| Mid 2nd | 2.05–2.08 | 20 | $10.5K | $7.0K | $0 | $25.0K | 45% | 40% | 15% |
| Late 2nd | 2.09–2.12 | 19 | $7.1K | $1.0K | $0 | $18.1K | 37% | 16% | 47% |
| Early 3rd | 3.01–3.04 | 21 | $6.2K | $2.0K | $0 | $22.0K | 43% | 19% | 38% |
| Mid 3rd | 3.05–3.08 | 20 | $3.5K | $0 | $0 | $13.0K | 15% | 15% | 70% |
| Late 3rd | 3.09–3.12 | 19 | $1.6K | $0 | $0 | $2.8K | 11% | 11% | 79% |
| 4th+ | 4.01–6.12 | 167 | $1.4K | $0 | $0 | $3.0K | 6% | 9% | 85% |

**What "first market event" measures:** the $ figure is the AAV at the player's first resolving event after the rookie deal — extension AAV (most common for hits), tag/FA auction price (if rookie deal expired), or $0 if cut, expired-unsigned, or never-rostered. It is *not* multi-year locked-in value: a 1.01 hit who extends at $28K AAV for 3 yrs is worth ~$84K total to the team, but the table reports the per-year AAV at conversion.

**Three big findings vs. the prior heuristic:**

1. **Round 1 is a nearly flat $14K AAV mean across early/mid/late.** The pre-empirical guess put mid-1st at $30K and late-1st at $22K — empirically those tiers converge because (a) extension AAVs are formula-capped and (b) busts pull the mean down at every slot. The p90 ($26-29K across R1) shows the upside ceiling.
2. **Round 2 is a coin flip — 40-50% of picks resolve to $0.** Empirical mean $5-10K (vs. heuristic $10-15K). Mid-2nd outperforms early/late-2nd because it's lined up with where teams actually find depth-tier hits (sample skewed by a couple of $25K extensions).
3. **Round 3+ is a lottery, dominated by zeros.** Mid-3rd has 70% zeros, late-3rd 79%, 4th+ 85%. The few hits in this range are real value-generators (p90 mid-3rd = $13K) but expected value is firmly under $4K.

**Strategic implication (revised):** Trading a 1-yr $20K vet for any mid/late-1st rookie pick is **roughly even on expected single-year value**, BUT the pick carries multi-year extension optionality the vet doesn't. For a 1-yr $30K vet → mid-1st pick swap, you're trading ~$15K of expected single-year value against the option to lock the hit at $14K AAV for 2-3 more years. The variance is asymmetric:
- Vet path: capped upside, bounded downside (1 yr only)
- Pick path: 60-75% chance the pick converts to *some* $ (mostly via extension), 15% bust to $0, p90 hits at $26-29K AAV with multi-year lock-in

For a **rebuilding team**, trade vets for picks. The variance lifts your team faster.
For a **win-now team**, hold the vets — dynasty optionality has 3-yr ROI horizon, you need this year.

---

## 6. Position-Specific Horizon

The dynasty/redraft tilt depends heavily on position, because career arcs differ:

| Position | Career arc | Aging cliff | Horizon |
|---|---|---|---|
| **QB** | 5-15+ years | Late 30s | **DYNASTY** — In SF era, the 4 elite QB tier is multi-year scarcity. Pay up for 1, lock multi-year (or Ext1/Ext2) where market lets you. |
| **RB** | 3-7 years | **28-30** | **REDRAFT** — RBs collapse fast. Multi-year on a 26-yr-old RB is rolling-the-dice. Bid year-by-year unless rookie pick. |
| **WR** | 5-10 years | **31-32** | **MIXED** — Younger WRs (under 27): dynasty. Veterans (28+): redraft. |
| **TE** | 4-10 years | **30** | **MIXED** — TE Premium era inflates the top, but talent thin in 2026; mostly redraft now. |

**Specific implications for 2026:**

- **Allen / Lamar / Burrow** are 28-30. SF era + NFL prime + 5+ year window = **definitely worth a 3-yr lock if your team can absorb the TCV**. 3-yr Lamar at $71K AAV = TCV $213K — that's a huge cap commitment, but if Lamar plays through 2030, it's a $40K-equivalent steal in years 2-3.
- **Mahomes** (age 30) — the swoop pick. 3-yr at $43K = TCV $129K. If he returns to MVP form, you've acquired a top-3 QB at half-market. If he doesn't, drop penalty hurts.
- **Top RBs (Taylor 27, Saquon 29, Jacobs 28)** — all entering or past the cliff zone. **1-yr deals strongly preferred.** Re-bid annually.
- **ARSB / Pickens / DeVonta / Jameson** — all ages 25-27. Younger WRs on multi-year if you believe in the player and have the cap. ARSB at age 26 on 3-yr is a long-term cornerstone bet.
- **Pitts (25), Likely (26)** — multi-year possible but TE talent variance is high. Probably 1-yr unless extension comes cheap.

---

## 7. Drop-Timing Reality Check

When do players actually get cut, and what does that mean for cap impact?

Pulled from `transactions_adddrop` (DROP events 2018-2025):

| Period | % of total drops | Cap penalty bucket |
|---|---|---|
| Aug-Sep (pre-FA-Auction-close to pre-Oct-1) | **~25%** | **0% earned — MAX penalty** |
| Oct | **~25%** | 25% earned |
| Nov | ~22% | 50% earned |
| Dec | ~17% | 75% earned |
| Mar (post-rollover) | ~7-10% | 100% earned (offseason) |

**Critical finding:** **A quarter of all drops happen pre-October**, when 0% of salary is earned and the penalty is max. This is exactly the scenario where multi-year deals get expensive.

Implication: when you sign a multi-year deal, you're not only betting on the player's *career* — you're betting that **you won't realize they're a bust before October**. The data shows that's actually quite common (~25% of drops happen exactly there).

---

## 8. Team-State Strategy Matrix

Where you are in the win-curve drives whether dynasty or redraft mode wins:

### Win-now (championship window 2026)
- Trade picks for vets (sell future for now)
- 1-yr deals on top auction wins (max flexibility)
- Pay full price for elite scarcity (e.g., a top-3 QB at $71K is worth 1-yr-of-cap if it wins you a title)
- Avoid multi-year cap commitments that bind you next year

### Rebuild (championship window 2027+)
- Hoard rookie picks (cheap multi-year + cap-free taxi cuts on R3+)
- Take 3-yr deals on young auction wins ($5-30K young assets)
- Sell vets for picks (trade Lamar/Allen 1-yr for 2027 1st)
- Build cap flexibility for 2027+

### Balanced / mid (oscillating contender)
- Mix 1-yr stars + 3-yr core
- Don't trade picks for short-term gains
- Use Ext1/Ext2 to lock cheap years on producing youth
- Tag elite players to prevent walk-aways

### Real Deal Creel (Keith) 2026 specifically
**State:** Rebuild-tilting-balanced. Most cap in league ($238K). Young WR core but no QB. Fits "win-now opportunity in SF cluster year."

**Strategy:** **Use the cluster year to build a multi-year QB foundation.** Lamar $71K on 3-yr (TCV $213K, ~70% of cap) is the kind of franchise-anchor move that defines a window. Or Mahomes 3-yr at $43K is the value-equivalent ($129K TCV, swoop tier). Don't waste the cap advantage on 1-yr deals at every position; secure a multi-year foundation while the structural opportunity exists.

---

## 9. The "$5K-3yr" Question — Final Verdict

Keith's specific question: **"Is it better to give a $5K guy a 3-yr deal and eat the cap hit if dead after 1 yr?"**

**Answer: Almost never.**

Math:
- 80% they bust → eat $10K dead money → effective cost $15K for 1 yr
- 20% they hit → save vs market (let's call it $20K savings in yr 2-3 combined)
- Expected value: 0.20 × $20K + 0.80 × (−$10K) = $4K − $8K = **−$4K EV**

**Exception case:** When you have **specific information** the market doesn't (insider knowledge, scout grade, age curve insight) that flips your hit-rate above 35%. At 35% hit-rate, breakeven holds.

For routine $5K bets (waiver-clearance fillers, dart throws), 1-yr is mathematically dominant.

**The flip side:** There's *one* circumstance where 3-yr at $5K wins systematically — when the player's extension would have cost MORE if signed 1-yr-then-extended. Specifically, if the player's market jumps from $5K to $30K, a 1-yr $5K + Ext1 (+$10K → $15K AAV ext yr) → TCV at extension = $5K + $15K = $20K. Compare to 3-yr $5K AAV (TCV $15K). The 3-yr lock-in at $5K is **$5K cheaper** than the 1-yr-then-extend path.

**So:** 3-yr $5K wins ONLY if you're highly confident the player will be EXTENSION-WORTHY in year 2 or 3. That's still a high-conviction bet, not a flier.

---

## 10. Specific 2026 Applications

### Malik Willis upside (Keith's call-out)
- Currently NFL Week-1 starter (MIA per depth chart)
- Bid range: $20K (model)
- 1-yr deal (auction default): $20K, walk away if Tua returns / Willis benched
- 3-yr Multi-Year Auction Contract (MYAC) at $20K AAV: TCV $60K. Drop Oct Y1 = $40K dead.
- **Recommendation:** **1-yr deal.** QB upside in dynasty is real, but Willis hasn't proven enough to justify multi-year exposure. If he hits, you re-bid next year (Ext1 path is cheaper than absorbing the dead money risk). Save the multi-year cap commitments for Lamar/Burrow tier.

### MHJ extension decision (March 2027)
- Currently $14K Y3 of his rookie 3-yr deal (yr=1 = 1 yr remaining = 2026 only)
- Extension Ext1 in March 2027: AAV +$10K → $24K AAV ext yr; TCV becomes $42K + $24K = $66K
- For breakeven on Ext1: he needs to be worth $24K+ in 2027 (ext yr) and not bust
- **Decision logic:** Extend if he produces top-30 WR in 2026. Walk if WR3+ disappointment.

### The 4-elite-QB cluster opportunity
- This is a **once-per-decade** structural moment
- Multi-year locks on Allen / Lamar / Burrow / Mahomes are the highest-EV multi-year bets in the league right now because:
  1. p (drop rate) is ~10-20% (proven elite QBs almost never get cut)
  2. TCV cost is high but lifetime value over 3-5 years is higher
  3. SF era + QB scarcity + 28-30 age = peak window
- **Recommendation:** if you're going to commit cap to a multi-year, this is the year and these are the players.

---

## 11. Open Questions / Data Work for Future Iteration

To make this analysis more rigorous, the following data work would tighten the conclusions:

1. **Multi-year contract ROI by historical contract** — Need to join `auction_contracts` (which has length, AAV, TCV) with `transactions_auction` (which has bid_amount and `won_ind`) and `nfl_player_weekly` (actual production). The current `auction_contracts` table appears mostly empty for analytical use; need a contract reconstruction pipeline.

2. **Pick-to-market-value conversion rates** — Quantify "1.05 pick converts to $X equivalent over N years" using actual rookie auction outcomes 2018-2025. We have the data, just need the analysis pipeline.

3. **Position-specific drop rate decomposition** — The 80% drop rate at <$5K is across all positions. RB-specific or WR-specific drop rates would tighten the position-level recommendations.

4. **Extension hit rate** — How often do Ext1/Ext2 contracts perform vs. the extension salary? This drives the "1-yr-then-extend" vs "3-yr-direct" decision.

5. **Owner pattern model (Layer 4 of bid sheet build)** — Which owners systematically over- or under-pay? Can identify trade partners + auction bidding-war risk.

6. **Tag economics** — When does tagging make sense vs letting walk + re-bidding? Math depends on tag formula tier (Avg Top-N AAV per Section 6) vs. expected market.

These are tractable analyses with the data we have. Each would tighten one of the heuristics in this doc.

---

## Reference: Cap Math Formulas Used

From `pipelines/etl/lib/cap_math.py` (Section 6 of `docs/league_context_v1.md`, locked v11):

```python
# Section 6.C1 — Drop penalty
penalty = max(0, int(0.75 * tcv) - salary_earned)

# Section 6.B1 — Earning curve (calendar month)
earned_pct = {3-9: 0.0, 10: 0.25, 11: 0.50, 12: 0.75, 1-2: 1.0}

# Section 6.F — Available cap
available = $300K - active_roster + ir_refunds + adjustments_owed - charges

# Section 6.F1 — Max bid with reserve
max_bid = available_cap - $1K × roster_slots_needed
```

All worked examples (C4.1–C4.10) reproduce penny-accurate against `tests/test_cap_math.py` (37/37 passing).
