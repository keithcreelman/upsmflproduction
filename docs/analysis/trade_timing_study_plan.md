# Trade-Timing Study — Design (approved plan lives here once commish signs off)

All feasibility probes are done — archive inspected, worker GET verified live, canon located. Here is the complete study plan.

---

# Trade-Timing Study — Design for Commissioner Approval

**Purpose:** replace the champions-only anatomy (n=5) with a Top-3 all-play cohort study whose core question is whether the value of cap relief / salary absorption is regime-dependent on trade date. Primary consumer: the `relief_multiplier = f(trade_date)` hook in `docs/analysis/trade_grade_model_v2_spec.md` (§2, lines 40–43).

## 0. Data feasibility — verified this session

| Source | Verified state |
|---|---|
| Archive sqlite (`data/db-archives/mfl_database_2026-06-05.db.gz`) | Opens clean. `transactions_trades` 2010–2025 (45–101 trade-groups/season from 2012). Asset rows: PLAYER 4,420 / pick 4,064 / **CAP 260 — 2020+ only** (26/42/56/54/38/44 per season 2020→2025). CAP rows pair exactly per `trade_group_id`: SENDER RELINQUISH +$X / RECEIVER ACQUIRE −$X. One 2025 pair (`trade2025_35`) has NULL amounts — data-quality flag. |
| `transactions_auction` | 2011–2025; per-season FA-auction window cleanly derivable (first FreeAgent event → last `finalbid_ind=1`), e.g. 2024: Jul 27→Aug 7; 2025: Aug 3→Aug 13. `TagOrExpiredRookie` (May) must be filtered out of anchors. |
| `rosters_weekly` | **2010, 2011, 2017–2025 only — 2012–2016 missing entirely.** Weekly status ROSTER / INJURED_RESERVE / TAXI_SQUAD with salary. Combined with the §1.C10 EOS-stamping caveat: salary/cap metrics are trustworthy **2020+ only**. |
| `weeklyresults` / `standings` | 2010–2025 complete. `standings.allplay_pct` per (season, franchise) ranks the Top-3 directly (verified 2025: 0004/.717, 0009/.636, 0007/.626). Regular-season-only AP computable from `weeklyresults` (`is_playoff=0`); canonical copy in D1 `src_standings.allplay_regseason_*` (migrations 0040/0041), surfaced live via `GET /api/hall-of-champions` (worker GET verified; returns champions only — cohort selection must come from standings tables, not that endpoint). |
| League ids / deadline canon | `league_years` (archive) = D1 `mfl_league_years` (read at `worker/src/index.js:7929`). Trade deadline canon: `docs/league_context_v1.md` line 249 — window runs offseason → **NFL Thanksgiving-week kickoff**; data agrees (last in-season trades 2023-11-23, 2025-11-27 = Thanksgiving Thursdays). |
| Prior art | Archive already has `trade_salary_analysis` (2020–2025, 128 rows, `trade_timing` ∈ pre_auction 60 / in_season 68) and `trade_winning_team_analysis` (1,749 rows) — reusable precursors. |
| Caveats found | Remote D1 (`npx wrangler d1 execute --remote`) returned auth error 7403 in this sandbox — analysis session needs either fresh archive or CF auth. The Kittle trade (2026-07-11) post-dates the 2026-06-05 archive; pull via MFL API `TYPE=transactions` with the 2026 league id. IR 50% relief is canon (§B3) but never live-verified (Q5 deferred) and its **start year is unknown** — commissioner input requested. |

## 1. Cohorts

- **Unit of analysis:** franchise-season. **Treatment = Top-3 by regular-season all-play % per season** (from `standings` / `src_standings.allplay_regseason_*`; O=101 scrape as audit). **Control = the other 9.**
- **Three era tiers**, each used only for the questions its data supports (per §4.C era buckets):
  - **Tier A — SF+current era, 2022–2025:** 12 treatment / 36 control franchise-seasons. Primary tier for all salary and cap-cash questions.
  - **Tier B — reliable-salary extension, 2020–2025:** 18 / 54. Adds 2020–21 (pre-SF) with an era dummy; salary math valid (post-stamping, CAP rows exist).
  - **Tier C — pick-flow-only, 2012–2025:** 42 / 126. Pick and player-count behavior only; **no salary math** (stamping + missing `rosters_weekly` 2012–2016). 2010–2011 excluded (2010 non-comparable format; 2011 has 10 trades).
- Sensitivity runs: Top-2 and Top-4 cutoffs; champions-vs-Top-3 overlay to reconcile with the prior 5-sample study.

## 2. Timing buckets (COMMISH-APPROVED structure, 2026-07-12)

Keith's directive: "Off-Season (Pre Rookie Draft vs. Pre Auction), then in season
(Weeks 1-6) and Weeks 7-trade deadline."

| Bucket | Window | Anchor derivation |
|---|---|---|
| **B1** Pre-Rookie-Draft | season open → rookie draft start | MIN(ts) of that season's rookie draft picks |
| **B2** Pre-Auction | rookie draft → FA auction start | MIN(ts) of FreeAgent auction rows (the Kittle zone) |
| **B3** Auction→Kickoff (residual) | auction start → Week 1 | kept so no trade is silently dropped; flagged small-n |
| **B4** In-season early | Weeks 1–6 | first NFL Thursday after Labor Day |
| **B5** In-season late | Week 7 → trade deadline | deadline = Thanksgiving kickoff (canon L249, data-confirmed) |

**IR rule (commish 2026-07-12): the 50% IR cap relief is and always has been in effect** —
question (e) runs across all salary-reliable seasons (2020+) with no rule-start cutoff.

## 3. Ranked questions (commissioner's order kept; b and d feed the v2 hook most directly)

**(a) Do Top-3-AP teams trade differently pre-auction vs in-season?** Per franchise-season × bucket: trade count, net players in/out, net salary flow (Tier A/B), net pick flow in slot-curve value (Tier C), cap-cash sent/received. Contrast treatment vs control within season.

**(b) Realized value of $1 cap, pre-auction vs in-season.** Pre-auction side: seasonal marginal $/PAR from auction results (join WON bids → same-season `weeklyresults` PAR; v2-spec method, ~$600/PAR). Displacement test: regress franchise auction spend on pre-auction committed salary across 72 franchise-seasons (2020–25); slope ≈ −1 confirms 1:1 displacement. In-season side: realized rest-of-season PAR-per-$ of in-season acquisitions (trades + blind-bid pickups from `transactions_adddrop`). The ratio in-season/auction PAR-per-$ **is** the empirical relief discount.

**(c) Who eats salary in-season and does it pay?** Eater = trade side with net book increase (salary_in − salary_out − capcash_received > 0). Measure compensation received per $ eaten (picks at slot-curve value + cap-cash) and points-added-per-$-eaten = Σ acquired players' started PAR (weeks w+1→17, `weeklyresults.status='starter'` per RULE-DATA-004) ÷ $ eaten; plus next-season regseason-AP delta. Split by cohort and bucket.

**(d) Kittle-archetype census.** Filter: W0b/W1 trades where acquirer receives a veteran ($15K+ salary or non-rookie contract) — optionally with cap-cash sweetener — and relinquishes future pick(s). For each: acquirer's same-season AP vs prior season, realized vet PAR vs the pick's eventual realized PAR (`draftresults_combined` 2012–2025 resolves picks to players), and auction-$-displaced from (b)'s regression. Output: historical win/loss profile of exactly this move.

**(e) Injury-freed cap.** Per franchise-week 2020+: Σ IR salaries × 50% (`rosters_weekly.status='INJURED_RESERVE'`). Distribution by week; correlation with in-season acquisition activity; share of in-season buying financed by IR relief vs residual cap. **Canon ask:** confirm the year the 50% IR relief rule took effect — if recent, pre-rule seasons are counterfactual only.

## 4. Pitfalls and mitigations

1. **§1.C10 stamping + missing 2012–2016 snapshots** → hard rule: no salary/cap math before 2020. Enforced by the tier structure.
2. **Era normalization (§4.C):** all points as within-season PAR (per-season replacement recompute); all $ as % of that season's cap; SF/TEP era dummies for Tier B pooling; QB/TE flows reported separately across the 2022/2025 breaks.
3. **Small per-bucket samples:** bootstrap CIs on franchise-season units, cluster by owner, pool seasons; per-bucket cap-cash results labeled descriptive, not inferential.
4. **Survivorship/selection:** Top-3 status is caused by rosters, trades may be markers not causes. Mitigate with prior-season-AP conditioning (change-on-change), within-season controls, tenure-floor exclusions for dispersal/partial owners (per league_context A7 cross-link), and explicit "association, not causation" framing in deliverables.
5. **Cap-cash pairing:** verify ± pair orientation against the live salaryAdjustments feed on known trades before aggregating; handle NULL-amount pair (`trade2025_35`) and `threeway_group_id` trades explicitly.
6. **Anchor contamination:** exclude `TagOrExpiredRookie` from auction anchors; 2019–2020 auctions ran late (mid/late Aug) — days-to-auction, never fixed calendar cutoffs.

## 5. Deliverables and phasing

- **Phase 0 — conformance (0.5 day):** per-season anchor table, trade→bucket map, cohort table (validated vs `src_standings` + O=101), cap-cash orientation check, counts table → **commissioner checkpoint before any findings**.
- **Phase 1 — behavior (1–1.5 days):** Q(a) contrasts across all tiers + Q(d) archetype census with case list. Output: one behavior table per bucket, Top-3 vs control, plus the named Kittle-comparable trades and their outcomes.
- **Phase 2 — valuation (1.5–2 days):** Q(b) displacement regression + $/PAR ratios, Q(c) points-per-$-eaten, Q(e) IR quantification; fit the relief curve. Output: **constants block for the v2 spec hook** — `relief_multiplier` per bucket with uncertainty bands — plus a Kittle re-grade under the fitted curve as regression test.
- **Phase 3 (optional, 0.5–1 day):** robustness — Top-2/4 sensitivity, owner clustering, champions-overlay reconciliation, methodology note for the league.

## 6. Model implication preview

`cap_relief_value($1, t, buyer) = base_regime(bucket(t)) × cap_state_mult(buyer_space) × season_fraction(week)`

- `base_regime`: W0a/W0b/W1 ≈ 1.0 (full auction purchasing power — study tests whether W0b should exceed 1.0 for cap-tight buyers); W2 drops to the in-season ratio; W3/W4 = fitted in-season/auction PAR-per-$ ratio (hypothesis 0.5–0.8, the current 0.8 placeholder sits at the top of that band), with a possible deadline scarcity bump in W4.
- `cap_state_mult`: v2's ×1.25 / ×1.0 / ×0.8 breakpoints re-fit from data; interacted with IR-freed cap (IR-financed space should carry a lower marginal value).
- `season_fraction(week)` ≈ (18 − week)/17 rest-of-season decay on production-denominated relief.
- Deliverable is piecewise constants per bucket — deliberately simple enough to drop into the spec's §2 as a lookup, not a fitted model owners can't audit.

### Critical Files for Implementation
- /Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/condescending-keller-4fc8cc/docs/analysis/trade_grade_model_v2_spec.md
- /Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/condescending-keller-4fc8cc/docs/league_context_v1.md
- /Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/condescending-keller-4fc8cc/data/db-archives/mfl_database_2026-06-05.db.gz
- /Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/condescending-keller-4fc8cc/worker/src/index.js
- /Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/condescending-keller-4fc8cc/worker/migrations/0040_franchise_weekly_score_and_allplay_metrics.sql