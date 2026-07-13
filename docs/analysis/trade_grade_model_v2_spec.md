# Trade Grade Model v2 — PAR ledger, market-calibrated (PROPOSAL, awaiting commish sign-off)

**Why:** the v1 grade math (raw points; $60/pt scalar; salary charged as permanently consumed;
flat decay; ±80%→letter cliffs) failed publicly on the 2026-07-11 Kittle trade. Three commissioner
challenges were validated against canon + 12 years of league data:
(1) cap is an ANNUAL, resetting budget — a 1-yr contract is a bounded rental with $0-cost exits;
(2) $60/pt is the median salary/raw-points of rostered legacy contracts, not what cap buys at
auction — the real marginal rate is ~$300/raw-pt (~$600/PAR); $29K buys ~45–55 marginal points,
not 483; (3) letter steps must exceed market noise (price-model RMSE ≈ $9.4K; a grade step should
require ≈110 season-pts ≈ $20–35K of marginal value).
Empirical champion profile (to grade WITH, not against): ~90% cap deployed, stars-and-scrubs
(top-3 ≈ 46% of payroll), net pick-SELLERS in title years.

## Currency: Points Above Replacement (PAR), one common window

Everything converts to PAR over the years actually held.

### 1. Player production term
- **Y1 PPG** (pre-season): blend of market projection (`/api/mfl-market` `proj`, injury-aware,
  league-scored) and ADP-implied PPG (site-exact consensus posRank → prior season's PPG at that
  rank), fallback 3-season weighted blend (games-qualified). Never current-season stats pre-season
  (standing rule). In-season: season-to-date + proj blend.
- **Expected games**: recency-weighted availability over seasons played (cameo seasons <4G
  excluded), capped 17. Current injury status (mfl-market `inj/inj_detail`) surfaces in context and
  justifies the proj input; do not double-count.
- **Y2+ (multi-year contracts only)**: age-curve compounded per year (projection.py
  `_age_multiplier(pos, age+i)/_age_multiplier(pos, age)`), replacing flat PLAYER_DECAY.
- **PAR/yr = (PPG − replacement_ppg[pos]) × expected_games**, floored at 0.
- **Replacement table** (2023–25 empirical; recompute each season from the leaderboard):
  QB 16.5 (SF demand) · RB 11.4 · WR 13.4 · TE 11.1 (TEP) · PK 9.1 · PN 7.7 · DL 7.6 · LB 8.0 · DB 9.0.

### 2. Salary term (annualized, state-dependent)
- Charge each held contract year: **(salary − startability_floor[pos]) ÷ $/PAR_marginal** where
  startability floor ≈ $2–4K (canon v13: any startable body costs $2–14K) and
  **$/PAR_marginal ≈ $1,216** [CI 1,063-1,422] (Phase-2 calibrated from 1,052 auction lots
  2020-25 with position-mapping fixed; SUPERSEDES the earlier $572-600 which only reproduces
  under a missing-position flaw. Recompute annually post-auction.)
- **Cap-relief credit to the seller: same formula, only for years actually shed, scaled by the
  seller's cap state**: ×1.25 if space < $15K; ×1.0 if < $50K; ×0.8 floor if ≥ $75K (cap is fungible
  with July auction spend — never free, never king). Symmetric multiplier for the buyer's charge.
- **Trade-timing hook (pending the pre-auction vs in-season study)**:
  `relief_multiplier = f(trade_date)` — pre-auction trades displace auction budget 1:1 (full rate);
  in-season trades operate in a thinner market with injury-freed cap (likely discounted rate).
  Placeholder = 1.0 pre-auction, 0.8 in-season until the study lands.

### 3. Pick term
- Expected 3-yr points from the slot curve **minus** the rookie replacement quantity (same PAR
  units — mixing pick-raw with player-PAR silently inflates every pick), **time-discounted
  0.9^(years until draft)**.
- **Minus expected salary commitment**: R1 = full rookie TCV; R2+ = P(promote) × TCV (≈ $6K
  expected for an R2, from the slot-history promote rates) — the taxi option is priced, not free.
- Fix the v1 bug: trading an R1 AWAY escapes a future commitment — credit the giver.

### 4. Embedded options (small, bounded)
- Final-year veterans carry free team options (extend at formula escalator; tag next spring):
  credit the acquirer min(expected option value, $5K-equivalent PAR). Canon: options are
  formula-priced, so the value is the spread, not the production.

### 5. Grade curve (noise-aware, dynasty-aware)
- Core stays zero-sum on net PAR; **letter step ≈ 110 season-PAR** (≈ half a season-sd of team
  scoring; ≈ $20–35K marginal). Bands (net PAR): |net| < 55 → B/B− "fair"; 55–165 → one step;
  165–275 → two; >275 → blowout tiers. Full scale A+…F (v1 could not express C−/D/F).
- **Timeline-fit modifier (±5 grade-points, post-zero-sum)**: contender acquiring now-production
  and rebuilder acquiring picks/youth both nudge up (predict_finish already exists) — win-win
  trades become expressible; the roast still names a winner.
- Nothing below a ~$10K-equivalent net delta may cross a letter boundary (quantization guard).

## Kittle trade under v2 (worked example, sensitivity honest)

Inputs: TE replacement 11.1 · exp games ≈ 12 · effective salary $24K (1 yr) · floor $3K ·
$600/PAR · 2027 2nd ≈ 26% usable, E[salary] ≈ $6K, discount 0.9².

| Y1 PPG input | Kittle PAR | Blake net (PAR) | Grade (Blake / Manther) |
|---|---|---|---|
| proj only (12.2, full Achilles) | ~13 | ≈ −155 | C− / B+ |
| blend of proj + ADP-implied (~15.7) | ~55 | ≈ −85 | **C+ / B** |
| 3-season blend (19.2, healthy) | ~97 | ≈ −40 | B− / B+ |

The honest read: a fair-to-slightly-negative contender rental whose grade swings on ONE
question — how much of pre-Achilles Kittle returns — rather than on cap-math artifacts. This
matches the market (TE9, trending +165/30d), the human reassessment, and the champion
playbook (winners sell picks for fairly-priced starters).

## Implementation order (after sign-off)
1. Constants module + replacement table + $/PAR calibration (annual recompute script).
2. PAR conversion in `_player_production_pts` / `_compute_side_value_pts`; proj-first Y1; age-curve Y2+.
3. Pick term rework (replacement-netted, discounted, E[salary]); R1-relief bug fix.
4. Cap-state multipliers + timing hook; new letter bands + timeline-fit.
5. Re-grade the last N historical trades as regression tests; publish methodology note to the league.

## Open items feeding this spec
- **Trade-timing study** (pre-auction vs in-season value of cap/salary-eating; Top-3 all-play
  cohorts instead of champions-only) — plan being drafted for commish approval.
- Bot-source canon diff (agent pending) → ups_canon library work.
- $/PAR and replacement tables should recompute annually post-auction (small ETL).
