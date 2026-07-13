# Trade-Timing Study — Phase 2 Results (2026-07-12): cap valuation, calibrated

HEADLINES: (1) the earlier ~$572-600/PAR auction marginal had a missing-position data
flaw — corrected marginal = ~$1,216/PAR [CI 1,063-1,422]; (2) displacement b = -0.39
($1 committed pre-auction displaces only ~39c of auction spend — cap rarely binds);
(3) relief multipliers: B1-B4 = 1.0 (no detectable discount), B5 = 0.70 (deadline);
(4) in-season salary eating is ~53% IR-financed in aggregate; the MEDIAN eater
absorbs at $0 effective cap cost; contenders (Top-3) earn +3.73 PAR/$1K eating AND
get over-compensated (comp/eaten 1.24) — the deadline-subsidy pattern quantified.

---

All numbers are in. Composing the deliverable.

# Q(c) Salary-Eating Payoff + Q(e) IR-Freed Cap — 2020-2025

**Method/approximations (all stated):** Eater = trade side with net book increase = salary_in − salary_out − capcash_received > 0. Salaries from `rosters_weekly` at nearest week ≤ trade week (relinquisher first, then acquirer, then any franchise; 18 player-instances unresolvable → $0, e.g. trade2020_7/11257, trade2021_36/14851 — immaterial). Trade week = floor 7-day blocks from Week-1 Thursday 20:00 ET. Production = acquired players' **started** PAR for the eater, weeks (trade_week+1)..17 (playoffs included; 2020 data ends wk16). Picks valued R1 $15K / R2 $6K / R3 $3K / R4+ $1K (no NULL-round picks existed). CAP asset sign convention verified (ACQUIRE row = negative salary adjustment = cap received; ABS used). trade2025_35/60 excluded (recoverable $3K/$5K cap-cash = 0.7% of 2025 eaten $ — immaterial). Unknown-position legacy IDs use 10.0 replacement. All associations, not causation.

## Q(c) — Eater outcomes by bucket

| Bucket | n | Eaten med (tot) | PAR/$1K q1 / med / q3 | Agg PAR/$1K | comp/eaten (agg) | curAP>prevAP | next-ssn ΔAP med |
|---|---|---|---|---|---|---|---|
| B3 (auction→wk1) | 62 | $5.0K ($674K) | −2.64 / 0.00 / +2.21 | +0.79 | 0.51 | 31/62 | −0.01 |
| B4 (wk1→+42d) | 62 | $6.5K ($487K) | −1.33 / +0.11 / +3.68 | — | 0.67 | 27/62 | +0.00 |
| B5 (+42d→deadline) | 86 | $5.5K ($618K) | −1.84 / +0.07 / +3.38 | — | 0.77 | 43/86 | +0.00 |
| **B4+B5 pooled** | **148** | **$6.0K ($1,105K)** | **−1.72 / +0.07 / +3.53** | **+1.38** | **0.72** | **70/148 (47%)** | **+0.00 (mean +0.021)** |

Eaten $ distribution (B4+B5): q1 $2K / med $6K / q3 $10K / p90 $16K / max $44K. Eater PAR>0 in 51% of B4+B5 cases, only 40% of B3.

Per season (B4+B5): 2020 n=35 med PAR/$1K 0.00, comp/eaten 0.77 | 2021 n=18, +0.41, 0.47 | 2022 n=21, +1.17, 1.11 | 2023 n=15, −1.05, 0.52 | 2024 n=36, +0.74, 0.61 | 2025 n=23, +0.48, 0.87.

**Cohort split (B4+B5):**

| Cohort | n | PAR/$1K med (agg) | comp/eaten | curAP>prev | next-ssn ΔAP mean |
|---|---|---|---|---|---|
| Top-3 all-play | 35 | +2.50 (+3.73) | **1.24** | 27/35 (77%)* | −0.177 |
| Control | 113 | 0.00 (+0.64) | 0.56 | 43/113 (38%) | +0.076 |

*curAP>prev for Top-3 is partially circular (cohort defined on current-season all-play). Next-season deltas are mean-reversion-shaped, not eating-payoff.

**Compensation:** median comp/eaten = 0.09 (most eaters get little/nothing); comp fully covers eaten in 53/148; zero comp in 71/148. Top-3 comp is cap-cash-heavy ($289K cap + $39K picks vs $264K eaten); control is picks-heavy ($323K cap + $146K picks vs $841K eaten).

**Top 5 wins / losses (eaten ≥ $5K; raw PAR/$ leaderboard is degenerate — dominated by $1K-net cases like trade2024_57 where $18K cap-cash offset Herbert+Chase to net $1K, PAR/$1K +185):**
- Wins: trade2024_66 0010 ate $7K → Barkley +100 PAR (+14.3); trade2023_93 0002 $6K → Purdy/D.Smith +81 (+13.5); trade2025_41 0007 $20K → CMC +233 (+11.7, plus $70K comp); trade2024_49 0002 $5K → Hubbard +58 (+11.5); trade2021_39 0007 $15K → Stafford +144 (+9.6).
- Losses: trade2020_38 0011 $6K → −56 (−9.4); trade2022_39 0007 $8K → Cook/Thibodeaux/Hamilton −49 (−6.1); trade2025_64 0004 $7K → J.Jefferson −40 (−5.7); trade2022_53 0010 $5K → Mitchell/Toney −27 (−5.3); trade2024_38 0003 $5K → Minshew −24 (−4.7).

## Q(e) — IR-freed cap (0.5 × IR salary, per franchise-week)

**When it opens (per-franchise-week $, pooled 2020-25):** wk1 med $1.0K → wk4 $3.5K → wk8 $8.5K → **wk12 $13.25K (94% of teams >0)** → wk14 $9.5K (99% >0). Mean rises $4.4K→$16K. Max single-team-week $61K in-season. IR relief roughly triples between kickoff and the trade deadline.

**Per franchise-season avg weekly freed wk1-14 ($K):** range 0.0 (0005-2024) to 41.0 (0007-2025); notable: 0001-2020 27.8, 0007-2021 36.9, 0010-2023 33.4, 0007-2025 41.0. League per-franchise-week median $6.0K, mean $11.2K, >0 in 86% of weeks.

**Correlation with in-season intake:** Pearson(avg weekly freed wk1-14, B4+B5 net salary acquired) = **+0.126** (Spearman +0.083, n=72); within the 35 positive-intake franchise-seasons r = −0.003. Franchise-level: IR slack does NOT predict who eats salary.

**Case-level financing (B4+B5 eaters, freed cap at trade week):** share of eaten $ coverable = q1 0.17 / **med 1.00** / q3 1.00; **aggregate 53%** of all eaten dollars; fully covered 79/148 (53%); eater had zero IR in 20/148 (14%). Eater freed-at-trade median $7.0K vs eaten median $6.0K. Control eaters med share 1.00; Top-3 med 0.50 (they eat bigger and instead get paid in cap-cash).

**Data caveat:** no season looks under-recorded — IR rows present all 17/17 weeks every season (2020: 577, 2021: 754, 2022-24: ~424 each, 2025: 535 rows wk1-17). 2021's elevated count is real usage, not an artifact.

## Findings
1. Salary-eating is roughly break-even at the median (+0.07 PAR/$1K in B4/B5) but right-skewed: the aggregate +1.38 PAR/$1K is carried by the top quartile (q3 +3.53). Eating pre-season (B3) is strictly worse (med 0.00, agg +0.79, only 40% positive).
2. Contenders eat well, others don't: Top-3 all-play teams earn +3.73 PAR/$1K aggregate vs +0.64 for everyone else — AND they get over-compensated for eating (comp/eaten 1.24 vs 0.56). Good teams are paid to absorb salary and still win the production.
3. Compensation usually does NOT cover the eating: median comp/eaten = 0.09; 48% of eaters receive zero compensation. The comp/eaten aggregate of 0.72 is driven by a few large cap-cash-attached deals.
4. Eating has no next-season signature: mean ΔAP +0.021, median 0.00 — in-season salary absorption is a current-season play with no carryover association.
5. IR relief is the real financing channel but only case-by-case: franchise-level correlation with intake is ~0 (r=0.126), yet at trade time the median eater's IR-freed cap fully covers the eaten salary, and 53% of ALL in-season eaten dollars league-wide were coverable by IR relief alone.
6. IR space ramps predictably: median freed cap goes $1K (wk1) → $13.25K (wk12, deadline window), with 94-99% of teams holding some relief by late season — late-B5 eating is structurally cheaper than B4 eating.

## Constants for the trade-grade model
- **THE number: in-season salary eaten is ~53% IR-financed in aggregate; the MEDIAN eater absorbs at $0 effective cap cost.** Grade rule: effective_eaten = eaten × (1 − min(1, IR_freed_at_trade_week / eaten)), where IR_freed = 0.5 × Σ IR salaries that week; if IR state unknown, use the 0.47 expected-cost multiplier (= 1 − 0.53).
- Replacement-level payoff prior: E[PAR per $1K eaten] = +1.38 (B4/B5), +0.79 (B3); median 0. Contender adjustment: ×~2.7 for top-3-caliber rosters (+3.73 vs +0.64).
- Week ramp for IR-freed cap (median $K/franchise): wk1 1.0, wk4 3.5, wk8 8.5, wk12 13.25, wk14 9.5.
- Typical eaten size: med $6K, q3 $10K, p90 $16K (vs $300K cap → median eat = 2% of cap).
- Comp coverage prior: median 0.09, aggregate 0.72; pick-tier values used: R1 $15K / R2 $6K / R3 $3K / R4+ $1K.
- Excluded pairs trade2025_35 ($3K) / trade2025_60 ($5K): immaterial (0.7% of 2025 B4+B5 eaten $).

---

All verification passes (Tyreek 191.6−13×13.4=17.4 ✓, Henry 95.9 ✓; the run-1 inflation traced to auction-bought vets missing from `dim_player`). Assembling the deliverable.

# Q(b): WHAT $1 OF CAP ACTUALLY BUYS — PRE-AUCTION vs IN-SEASON (2020-2025)

**Setup (locked definitions applied):** PAR = started pts − starts × replacement (QB 16.5 / RB 11.4 / WR 13.4 / TE 11.1 / PK 9.1 / PN 7.7 / DL 7.6 / LB 8.0 / DB 9.0), weeks 1-14 unless noted. All PAR is **buyer-scoped**: only weeks the player appears in `weeklyresults` under the acquiring franchise count, so mid-season re-trades are automatically excluded from the buyer's total. Association, not causation, throughout.

## 1. AUCTION $/PAR (won FreeAgent lots, finalbid_ind=1, n=1,052)

Per season:

| season | lots | $ | PAR | PAR/$1K |
|---|---|---|---|---|
| 2020 | 167 | 604,000 | 311.4 | 0.516 |
| 2021 | 179 | 758,000 | 317.6 | 0.419 |
| 2022 | 187 | 1,048,000 | 153.0 | 0.146 |
| 2023 | 163 | 670,000 | 309.0 | 0.461 |
| 2024 | 185 | 776,000 | 503.2 | 0.648 |
| 2025 | 171 | 798,000 | 307.6 | 0.385 |
| **pooled** | **1,052** | **4,654,000** | **1,901.8** | **0.409** (= $2,447/PAR avg) |

By bid tier (pooled | 2022-25 era in parens where materially different):

| tier | n | $avg | PAR avg | PAR/$1K | avg $/PAR |
|---|---|---|---|---|---|
| $1-2K | 669 | 1,227 | −0.4 | −0.331 (−0.43) | — (sub-replacement) |
| $3-9K | 277 | 4,502 | 1.5 | 0.334 (0.21) | 2,994 |
| $10-19K | 54 | 13,833 | 9.0 | 0.652 (1.01) | 1,533 (992) |
| $20K+ | 52 | 35,365 | 24.4 | 0.691 (0.57) | 1,448 (1,768) |

Marginal $/PAR between adjacent tiers (Δmean$/ΔmeanPAR): $1-2K→$3-9K **1,724** (2022-25: 2,354) | $3-9K→$10-19K **1,244** (722) | $10-19K→$20K+ **1,398** (3,819). OLS across lots: marginal $/PAR = **1,216 [95% CI 1,063–1,422]** pooled; 1,405 [1,177–1,742] for 2022-25.

**Cross-check of the prior ~$572-600/PAR estimate: it does NOT survive correction.** With positions mapped only via `player_master` (replacement=0 for ~1,389 starter rows of players absent from `dim_player` — verified to be disproportionately auction-bought vets, e.g. Marvin Jones, Corey Davis, Will Fuller: 6 of the top 8 were auction buys), I reproduce the prior figure almost exactly (mid-tier marginal 569). After adding a `rosters_weekly.position` fallback (0 rows unmapped), the marginal roughly doubles: **use ~$1,200/PAR (range 1,050–1,450) as the auction marginal, not 572-600.** Positive PAR is concentrated in $10K+ lots; the $1-2K tier is sub-replacement dart-throwing in aggregate.

## 2. DISPLACEMENT REGRESSION (72 franchise-seasons)

Method: committed$_{i,s}$ = week-1 roster salary (ROSTER+IR; taxi excluded) − auction-won bids for players still on the winner's week-1 roster. Error sources: (a) B3-window churn (post-auction trades/cuts/BBID leak into "committed"); (b) week-1 salary ≠ bid on 31% of matched lots (median diff 0, mean |diff| $1,479 — MFL-side adjustments); (c) full IR salary counted. Committed mean $217K (sd $51K); spend mean $65K (sd $35K); mean committed+spend ≈ $282K vs $300K cap.

- **auction_spend = a + b·committed + season FE: b = −0.394 (SE 0.066, 95% CI [−0.52, −0.27])** — decisively rejects −1.0. $1 of pre-auction commitment reduces auction spend by only ~39¢; cap space is not the binding constraint for most franchises.
- committed → auction **PAR**: −1.76 PAR per $10K committed [95% −4.92, +1.40] — directionally negative, not significant.

## 3. IN-SEASON PAR-per-$ AND THE RELIEF RATIO

**Trades B4/B5** (n=493 player-acquisitions, $5.56M absorbed; salary = acquirer's first non-taxi rostered week ≥ trade week, fallback modal — exact in practice: 0.0% of player-seasons show >1 distinct in-season salary; 119 acquired rows dropped: 101 taxi [no active-cap salary], 18 unmatched; excluded pairs trade2025_35/60 carry only $3K+$5K recoverable cap — immaterial):

| tier | n | $avg | PAR/$1K (→wk14) | ratio vs auction [boot 95%] |
|---|---|---|---|---|
| $1-2K | 176 | 1,324 | −0.479 | unstable (both sides ≈0) |
| $3-9K | 127 | 5,094 | 0.652 | unstable |
| $10-19K | 82 | 13,000 | 0.223 | 0.342 [−0.23..2.09] |
| $20K+ | 108 | 33,463 | 0.368 | **0.533 [0.281..1.037]** |
| ALL | 493 | 11,278 | 0.338 | **0.827 [0.379..2.101]** |

By bucket, wks→14 and playoff-inclusive wks→17 (auction re-based to →17 for the latter; wks 15-17 include consolation starts):

| bucket | PAR/$1K wk14 | ratio wk14 | PAR/$1K wk17 | ratio wk17 |
|---|---|---|---|---|
| B4 | 0.470 | **1.151 [0.41..2.96]** | 0.617 | 1.255 [0.56..2.82] |
| B5 | 0.245 | **0.601 [0.14..1.63]** | 0.401 | 0.817 [0.30..2.01] |

Era consistency: 2022-25 gives B4 0.95, B5 0.47 (same ordering); 2020-21 trades 1.14 (note: starter-QB PPG was ~25 in 2020-21 vs ~20.5 in 2022+ — a scoring-era shift that inflates 2020-21 PAR levels against the fixed 16.5 QB replacement; ratios are more stable than levels).

**Blind-bid adds in-season** (n=2,452, $5.64M; salary = winning bid; the WW cap penalty is NOT added, so these rates are optimistic): PAR/$1K = **−0.604, negative in every tier** — BBID pickups start below replacement on average. Ratio vs auction −1.48; combined trades+BBID −0.33. Interpretation: started-PAR under-credits BBID's insurance/bye-fill option value (a sub-replacement start still beats an empty slot), so treat the negative as "BBID $ buys ~zero realized PAR," not negative value — and do NOT let it push a relief multiplier below 0.

## 4. B3 SPECIAL (auction→kickoff window — descriptive, small n)

Trades: n=167, $1.486M absorbed, PAR/$1K = 0.634 → ratio vs auction **1.553 [0.23..4.35]** (2022-25: 1.85, even wider). Pre-wk1 BBID (n=256, $611K): −0.357/1K. B3 combined 0.846 [−0.19..2.67]. No detectable discount vs auction.

## CONSTANTS FOR THE TRADE-GRADE MODEL

```
auction_par_per_$1K        = 0.41   (pooled avg; 2022-25: 0.39)
auction_marginal_$_per_PAR = 1216   (95% CI 1063-1422; supersedes prior 572-600, which
                                     reproduces only under a missing-position flaw)
auction_tier_par_per_$1K   = { "1-2K": -0.33, "3-9K": 0.33, "10-19K": 0.65, "20K+": 0.69 }
displacement_b             = -0.39  (SE 0.066; $1 committed pre-auction ≠ $1 of auction spend)

relief_multiplier (trade-channel benchmark, B1/B2 anchored = 1.0):
  B1 = 1.00
  B2 = 1.00
  B3 = 1.00   (point est 1.55, CI spans 1 widely; no discount detectable)
  B4 = 1.00   (point est 1.15 wk14 / 1.26 wk17; CI spans 1; no discount detectable)
  B5 = 0.70   (blend of wk14 0.60 and playoff-inclusive 0.82; plausible range 0.5-0.85)
  floor at 0; if instead weighting by ACTUAL historical deployment (≈50% of in-season
  cap $ flows to BBID at ~0 realized PAR): B4 ≈ 0.55, B5 ≈ 0.40 — use this stricter set
  only if the model should price how cap relief IS used rather than how it CAN be used.
```

**Approximations chosen (full list):** buyer-scoped starts via weeklyresults franchise match (re-trades excluded; same-season re-acquisition edge bounded by a from_week ≥ floor((ts−week1)/7d)+1 filter, capped at 14); positions via player_master with rosters_weekly modal-position fallback (CB/S→DB, DE/DT→DL; 0 unmapped); trade-time salary as described (in-season salaries are constant, so ~exact); taxi acquisitions excluded; committed-salary method + its three error sources as in §2; season-FE OLS with classic SEs; bootstrap (4,000 reps, resampling lots/acquisitions) for ratio CIs; BBID cap penalty omitted; wks 15-17 include consolation starts; cap-cash rider dollars in multi-asset trades not attributed per-player (excluded pairs immaterial at $8K total). Scripts: `/private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-condescending-keller-4fc8cc/213c497b-3469-4324-a0e5-1b691a06f8a6/scratchpad/{qb_final.py,qb_verify.py,qb_diag.py}` against `/tmp/mfl_arch.db` (read-only).