# UPS-Specific Analytical Metrics — Provenance and Calibration

*This file documents analytical metrics that were built FOR the UPS league against UPS-specific data. These are league-specific and empirically tuned — not borrowed from external public analysts. Treat as the source of truth when building any roster / extension / draft analysis. Updated 2026-04-30.*

---

## NET tier classification (Smash / Hit / Contrib / Bust)

**Formula:** `NET = E+P_rate − 0.5 × Dud_rate`, computed over games-weighted 3-year averages.

**Components:**
- **E+P rate (Elite + Plus):** % of played weeks where the player's positional z-score is ≥ +0.25
- **Dud rate:** % of played weeks where the player's positional z-score is < -0.5
- Weeks where the player didn't play count as games-weighted-out, not as duds

**Tier cutoffs (anchored to rookie-pool distribution + "thrilled to draft" framing):**
- **Smash:** NET ≥ +0.30 (top ~20% — reliably elite, build a team around)
- **Hit:** NET ∈ [+0.15, +0.30) (next ~18% — more elite weeks than typical starter)
- **Contrib:** NET ∈ [0, +0.15) (next ~20% — useful rotational piece)
- **Bust:** NET < 0 (remainder — duds outweigh peaks, or never played enough)

**Calibration data (the part Keith specifically wants documented):**

| Formula | Correlation with All-Play % (r) |
|:--------|:-------------------------------:|
| E+P rate alone (no dud penalty) | +0.834 |
| NET with k=1 (EP − 1×Dud) | +0.844 |
| **NET with k=0.5 (EP − 0.5×Dud)** | **+0.851 (OPTIMAL)** |
| NET with k=2 (EP − 2×Dud) | +0.827 (over-penalizes) |

Sample: 192 team-seasons 2010-2025.

**The empirical finding:** duds matter, but only **half as much** as peaks. A player who has 10 elite weeks and 5 dud weeks is more valuable than k=1 weighting suggests, because elite weeks win you matchups while duds are partially survivable through bench depth. Setting k=0.5 captures this asymmetry and gives the best correlation with realized winning record.

**Source code:** `pipelines/etl/scripts/build_rookie_draft_hub.py:classify_tier()` (lines ~370-410).

**This is NOT JJ Zachariason's framework.** JJ's tier definitions are different (top-12/top-24 finish-rate-based; "league winner" rate as top-3 redraft finish). We built our own metric and tuned k against UPS All-Play history specifically. Direct attribution is *UPS league analytical work*.

---

## Why E+P rate beats best-2-of-3 ppg (B2S) for "worthy" decisions

**B2S = best-2-of-3 PPR ppg over Y1-Y3.** Used by JJ's ZAP model as the prediction target. Smooths peak production with floor production via simple averaging.

**Problem:** averaging hides single-season elite performance.
- Drake Maye Y1=13.6, Y2=19.85 → B2S = 16.74 (looks "SF-startable mediocrity")
- But Y2=19.85 was a literal QB1-tier finish (top-12 PPG, ~QB1 in total points)
- B2S undercounts the *peak* that actually wins championships

**E+P rate is championship-relevant.** It counts the elite weeks themselves, not the season-average that includes weak weeks. A QB with 8 elite weeks and 4 dud weeks has a higher E+P rate than a QB with 17 mediocre weeks averaging the same total — and wins more matchups.

**Use NET tier classification (not B2S thresholds) as the worthy signal going forward.**

---

## Position-specific UPS auction price benchmarks (from auction history)

*To be filled in by parsing `transactions_auction` table. For now, working approximations from 2024-2025 UPS auctions:*

| Position | QB1 / RB1 / WR1 / TE1 (top 12) | QB2 / RB2 / WR2 / TE2 (13-24) | Replacement (24+) |
|:---------|:-:|:-:|:-:|
| **QB (SF era)** | **$25-40K AAV** | **$8-18K AAV** | $1-5K |
| **RB** | $30-50K AAV | $10-20K AAV | $1-5K |
| **WR** | $25-40K AAV | $10-20K AAV | $1-5K |
| **TE (TEP era)** | $15-30K AAV | $5-15K AAV | $1-5K |

**Critical correction (2026-04-30):** earlier analysis assumed QB2-tier vet auction price was $30-40K AAV — that's the QB1 tier. **QB2-tier vets in SF go for ~$8-18K AAV.** This materially changes cap-arbitrage math for rookie QBs:
- A rookie QB at $12K AAV producing **SF-startable (QB13-24)** is roughly break-even vs a $10-15K auction QB2
- Cap surplus only materializes if rookie QB hits **QB1 tier** (then $12K vs $30-40K = $18-28K/yr surplus)
- This is why historical QB hit-rate analysis (15-25% R1.1-3 QB1 rate) is the dominant decision factor, not "cap surplus from cheap rookie deal"

**TODO:** wire actual auction-price-by-position-by-year parser against `transactions_auction` to replace these approximations.

---

## Replacement-level production (per-game PPR ppg, from 2024-2025 UPS scoring)

| Position | Top-N starter avg ppg | Replacement (top-N+1 to 2N) avg ppg | Spread (VOR) |
|:---------|:-:|:-:|:-:|
| QB (SF starts 24) | 19.2 | 8.85 | 10.35 ppg |
| RB (12-team starts 24) | 15.3 | 7.85 | 7.45 ppg |
| WR (12-team starts 36) | 13.8 | 8.65 | 5.15 ppg |
| TE (TEP starts 12) | 12.7 | 8.10 | 4.60 ppg |

**Source:** `pipelines/analytics/positional_scarcity.py` against 2024-2025 player_scoring data.

---

## ROC-optimal "worthy" thresholds (B2S, per position)

Computed by finding the B2S threshold that maximizes prediction accuracy of `paid_off_y4_5 == 1` given 2017-2021 cohort outcomes.

| Position | ROC-optimal B2S threshold | Accuracy | Sample n |
|:---------|:-:|:-:|:-:|
| RB | 17.18 ppg | 93.6% | 94 |
| WR | 16.80 ppg | 96.3% | 107 |
| TE | 12.94 ppg | 96.6% | 29 |
| QB | 21.64 ppg | 100% | 28 |

**Caveat:** these are B2S-based and inherit B2S's peak-smoothing weakness. The NET tier classification above is the better signal for championship-relevant decisions.

---

## Open methodological questions

1. **NET tier classification has not been re-validated post-2022 (SF era).** The original k=0.5 tuning used 2010-2025 team-seasons but didn't separate eras. SF + TEP scoring may shift optimal k.

2. **Auction-price benchmarks** above are working approximations. Need to wire the real auction history parser.

3. **NET tier × cap cost intersection** isn't formalized yet. The "is this player worth extending" decision needs to combine tier (championship value) with cap cost (auction-market-relative pricing).

---

## Source files / data

- `pipelines/etl/scripts/build_rookie_draft_hub.py` — original `classify_tier()` and the All-Play correlation comments
- `site/rookies/rookie_draft_history.json` — per-player tier classification, 2012-2025 cohort
- `site/rookies/rookie_extension_followthrough.csv` — Y1-Y3 best-2-of-3 + Y4-Y5 outcomes
- `pipelines/analytics/positional_scarcity.py` — replacement-level / VOR computation
- `mfl_database.db` (path varies by env) — `transactions_auction` for actual auction prices
- `docs/ups_v2/V2_GOVERNED/rules/claude_canonical_rules.md` — rookie salary structure rules
