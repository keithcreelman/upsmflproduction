# UPS Auction History — 7-Year FA Auction Analysis

**Generated:** 2026-05-20
**Scope:** 2019–2025 FA Auctions only · lots with ≥2 bids
**Total qualifying lots:** 714 (across 7 seasons)
**Source:** MFL transactions export (`TYPE=transactions, TRANS_TYPE=AUCTION_INIT|AUCTION_BID|AUCTION_WON`) for league L=74598 per season
**Per-year league_id:** All seasons map to L=74598 (per `mfl_league_years` table — UPS has used the same MFL league ID throughout)

## Executive summary

- Across 7 years and 714 contested FA Auction lots (lots with at least one competing bid beyond the nomination), the **average auction completes in ~34.4 hours** (capped at 48h for sanity), with a **median of 31.9h**.
- A contested lot draws **4.2 bids on average** (median 3) — split into **1.7 forced increases** (MFL stepping a proxy bid up to match a competitor) and **1.5 overtakes** (a new franchise dethroning the leader).
- Year-to-year averages are remarkably stable: duration sits in a tight 32.8–35.6h band; bid counts in 3.7–4.5; forced and overtakes both within ±0.5 of their long-run means. UPS auction behavior has not meaningfully changed across the post-2019 era.
- **Top 3 surprising findings:**
  1. **Forced bids slightly out-number overtakes (1.74 vs 1.48).** Most lots get decided by MFL grinding two proxy ranges past each other, not by a fresh challenger jumping in mid-auction.
  2. **The top decile of contested lots is dramatically heavier than the median:** D10 averages 11.4 bids, 6.4 forced, 5.7 overtakes, and 93h on the clock — the bidding wars on a handful of marquee players (Travis Kelce 2025, Derrick Henry 2023, etc.) bend the tail enormously.
  3. **2022 is the outlier season for forced increases (2.06/lot, ~15% above the long-run mean),** and **2023 is the outlier for overtakes (1.91/lot, ~30% above).** Different mechanics drove the heat in those two seasons.

## Per-season summary

| Year | League | FA lots | ≥2-bid lots | Avg dur (cap48, hrs) | Avg dur (raw, hrs) | Median dur (raw) | Avg total bids | Avg forced | Avg overtakes |
|------|--------|---------|-------------|----------------------|--------------------|--------------------|----------------|------------|---------------|
| 2019 | 74598  | 223     | 145         | 35.0                 | 42.4               | 34.0               | 4.54           | 1.74       | 1.80          |
| 2020 | 74598  | 175     | 91          | 33.5                 | 42.9               | 27.4               | 3.78           | 1.51       | 1.27          |
| 2021 | 74598  | 190     | 107         | 35.6                 | 41.7               | 35.2               | 3.70           | 1.52       | 1.18          |
| 2022 | 74598  | 205     | 129         | 33.3                 | 35.9               | 29.3               | 4.36           | **2.06**   | 1.30          |
| 2023 | 74598  | 166     | 69          | 35.3                 | 39.5               | 33.2               | 4.51           | 1.59       | **1.91**      |
| 2024 | 74598  | 183     | 92          | 35.5                 | 38.7               | 33.8               | 4.38           | 1.83       | 1.55          |
| 2025 | 74598  | 170     | 81          | 32.8                 | 35.8               | 27.6               | 4.16           | 1.78       | 1.38          |
| **All** | —    | 1,312   | **714**     | **34.4**             | **39.7**           | 31.9               | **4.22**       | **1.74**   | **1.48**      |

> "FA lots" counts every player nominated to FA Auction in that year, regardless of bid count. The "≥2-bid lots" column is the cohort everything else in this document uses.

## Headline averages (across all 7 years, ≥2-bid lots, n = 714)

- **Avg auction duration:** 34.4 hours (capped at 48h) / 39.7 hours (raw) — median 31.9, p25 24.2, p75 46.8 (capped); raw max 144.9
- **Avg total bids per lot:** 4.22 — median 3, p25 2, p75 5, max 30
- **Avg forced increases per lot:** 1.74 — median 1, p25 0, p75 2, max 14
- **Avg overtakes per lot:** 1.48 — median 1, p25 0, p75 2, max 15

> **Why duration has a 24-hour floor:** MFL FA Auction lots have a minimum live window before a bid is allowed to close, plus the league's 36-hour soft-lock per `league_context_v1.md §A3`. Nothing closes faster than ~24 hours after nomination, even if no one contests.

## Deciles

Each metric is bucketed into 10 equal-frequency buckets (~71-72 lots each, sorted ascending).

### Duration (hours, raw — no 48h cap)

| Decile | Range (hours)     | Lot count | Mean (hrs) | Notes |
|--------|-------------------|-----------|------------|-------|
| 1st    | 24.0 – 24.0       | 71        | 24.0       | Closed at the soft-lock minimum |
| 2nd    | 24.0 – 24.1       | 71        | 24.0       | Same, basically — closed right at the floor |
| 3rd    | 24.1 – 24.4       | 72        | 24.2       | Floor-cluster (no late drama) |
| 4th    | 24.4 – 26.6       | 71        | 25.3       |       |
| 5th    | 26.7 – 31.9       | 72        | 29.2       | Median bucket |
| 6th    | 32.0 – 37.9       | 71        | 34.8       |       |
| 7th    | 38.0 – 42.9       | 71        | 40.5       |       |
| 8th    | 43.0 – 48.1       | 72        | 46.3       | Late drama before the lock cycle |
| 9th    | 48.1 – 67.3       | 71        | 54.7       | Multi-day grinds |
| 10th   | 67.5 – 144.9      | 72        | 93.4       | Bidding wars + commish-extended lots |

> Roughly **30% of contested lots close right at the 24-hour floor** (D1-D3) — these are lots where the second bid hit early, then no one fought further.

### Total bids per lot

| Decile | Range (bids) | Lot count | Mean | Notes |
|--------|--------------|-----------|------|-------|
| 1st    | 2 – 2        | 71        | 2.00 | Bare-minimum contest (nomination + 1) |
| 2nd    | 2 – 2        | 71        | 2.00 |      |
| 3rd    | 2 – 2        | 72        | 2.00 |      |
| 4th    | 2 – 3        | 71        | 2.59 |      |
| 5th    | 3 – 3        | 72        | 3.00 | Median bucket |
| 6th    | 3 – 4        | 71        | 3.34 |      |
| 7th    | 4 – 4        | 71        | 4.00 |      |
| 8th    | 4 – 6        | 72        | 4.88 |      |
| 9th    | 6 – 8        | 71        | 6.89 |      |
| 10th   | 9 – 30       | 72        | 11.44 | Bidding wars |

> **~30% of contested lots have exactly 2 bids.** Most "fights" are over before they start.

### Forced increases per lot

| Decile | Range | Lot count | Mean | Notes |
|--------|-------|-----------|------|-------|
| 1st    | 0 – 0 | 71        | 0.00 |       |
| 2nd    | 0 – 0 | 71        | 0.00 |       |
| 3rd    | 0 – 1 | 72        | 0.47 |       |
| 4th    | 1 – 1 | 71        | 1.00 |       |
| 5th    | 1 – 1 | 72        | 1.00 | Median bucket |
| 6th    | 1 – 1 | 71        | 1.00 |       |
| 7th    | 1 – 2 | 71        | 1.92 |       |
| 8th    | 2 – 3 | 72        | 2.11 |       |
| 9th    | 3 – 4 | 71        | 3.39 |       |
| 10th   | 4 – 14 | 72       | 6.44 | Proxy-war lots |

### Overtakes per lot

| Decile | Range | Lot count | Mean | Notes |
|--------|-------|-----------|------|-------|
| 1st    | 0 – 0 | 71        | 0.00 |       |
| 2nd    | 0 – 0 | 71        | 0.00 |       |
| 3rd    | 0 – 0 | 72        | 0.00 |       |
| 4th    | 0 – 1 | 71        | 0.72 |       |
| 5th    | 1 – 1 | 72        | 1.00 | Median bucket |
| 6th    | 1 – 1 | 71        | 1.00 |       |
| 7th    | 1 – 2 | 71        | 1.51 |       |
| 8th    | 2 – 2 | 72        | 2.00 |       |
| 9th    | 2 – 3 | 71        | 2.83 |       |
| 10th   | 4 – 15 | 72       | 5.72 | True bidding wars |

> **Roughly 30% of contested lots had zero overtakes** (only the original bidder ever held the lead — they were force-bid up by MFL but no fresh franchise jumped in). This is the "scared off after the first ping" pattern.

## Outliers + flags

### Lots that ran > 48 hours (146 of 714)

The 48h cap is artificial. 146 lots (~20%) ran longer than that in raw time. The longest:

| Year | Player ID | Hours | Bids | Note |
|------|-----------|-------|------|------|
| 2023 | 12626 (Derrick Henry, RB) | 144.9 | 30 | Heaviest bidding war in dataset |
| 2025 | 11244 (Travis Kelce, TE) | 123.3 | 14 | Veteran TE auction war |
| 2020 | 13214 (T.J. Watt, DE), 13354 (Harrison Butker, PK), 13404 (Austin Ekeler, RB), 12620 (Dak Prescott, QB), 12447 (Raheem Mostert, RB), 12151 (Melvin Gordon, RB), 12678 (Tyler Higbee, TE), 13251 (Budda Baker, S) | 122.0–122.2 | 2 each | **2020 commish-restart cluster** — 9 lots all completed within minutes of each other at ~122h, all with only 2 bids and `by_commish=1`. Smells like a commish-intervention restart that batch-closed a window. Flagged below. |

### Unresolved lots (no AUCTION_WON event)

**0.** Every qualifying lot in the 7-year window resolved cleanly with a WON event.

### Commish-posted bids (`by_commish=1`)

**18 lots** across 2020 (8) and 2021 (10) had at least one event posted by the commish on a bidder's behalf. The 2020 set is essentially the same 122h-cluster called out above; the 2021 commish events are spread across normal auction times. No 2019, 2022, 2023, 2024, or 2025 lots had commish-posted bids in this dataset.

### Other anomalies worth noting

- **2022 forced-increase spike:** 2.06 forced per lot is the highest in any year. Hypothesis: more proxy bidding (auto-bid ceilings stacked close together) rather than more competition. Worth checking against per-franchise behavior in a follow-up if you want to know who was force-stomping the field.
- **2023 overtake spike:** 1.91 overtakes per lot is the highest. This is *fresh-franchise-jumping-in* heat, not proxy heat — different signal from 2022. Notably, 2023 is also the year of the 30-bid Derrick Henry war.
- **2024 had the most long-running lots** (22 lots > 48h) — more drawn-out fights than any other year, but average bid counts were typical. Owners were patient/slow, not feverish.

## Methodology + caveats

### What's included

- **FA Auction only.** Lots are FA if (a) the year is pre-2023 (ERA didn't exist yet) or (b) the first event of the lot has timestamp in July or later. Earlier-month lots in 2023+ are classified as ERA (Expired Rookie Auction, late-May/early-June) and excluded.
- **≥2 bids required.** A lot must have at least 2 AUCTION_BID/AUCTION_INIT events (i.e., the nomination plus at least one competing or forcing bid). Pure-nomination lots that never drew a second bid are excluded per Keith's instruction.

### FA vs ERA classification per year

| Year | Approach | ERA lots filtered |
|------|----------|-------------------|
| 2019 | All FA (pre-ERA era) | 0 |
| 2020 | All FA | 0 |
| 2021 | All FA | 0 |
| 2022 | All FA | 0 |
| 2023 | Month-based: lots starting before July = ERA | filtered (~20) |
| 2024 | Month-based | filtered |
| 2025 | Month-based | filtered |

Total ERA-window lots filtered out: **51** across 2023–2025. Lots whose first event landed in June were treated as ERA. This is a heuristic — `league_context_v1.md §A3` documents ERA as "late May / early June" and FA as "July." There was no observed timestamp ambiguity (the gap between the two clusters is sharp in 2023+).

### Forced vs overtake classification

Each AUCTION_BID/AUCTION_INIT event is tagged using the **MFL note marker** baked into the `transaction` field's pipe-delimited 3rd segment:

- **Note contains `forced bid increase`** → classified as **forced**. This is MFL's own label when it walks a leader's hidden proxy ceiling up to match a competing bid.
- **Note contains `nomination`** or the event is `AUCTION_INIT` → **nomination** (not counted in forced/overtake totals).
- **Anything else** (no note, owner trash-talk in the note, "Opening Bid", etc.) → **overtake** (a fresh competitive bid).

This is more reliable than a fid-comparison heuristic because MFL labels its own forced bids explicitly. Sanity-checked against sample lots: matches.

### Duration computation

- `duration_hrs = (AUCTION_WON.timestamp − first_event.timestamp) / 3600`
- Two views are reported: **raw** (uncapped) and **capped at 48h** (per the operational rule). Long-running lots (raw > 48h) are flagged separately.
- All 714 qualifying lots have an AUCTION_WON event (no unresolved cases).

### What was NOT included

- Single-bid lots (per Keith's "remove nomination-only" filter)
- ERA lots from 2023+ (filtered by month heuristic)
- Pre-2019 seasons (out of scope; Keith asked for last 7 years)
- Tag/auction-tag events (these are separate `FRANCHISE_TAG` / similar transaction types, not part of FA Auction in MFL's TRANS_TYPE taxonomy)

### Known limitations

- The **24-hour floor** is real and structural (MFL minimum) — it compresses the bottom 3 deciles of duration into a single value. If you ever want resolution below 24h, you'd need a different data source than MFL's transaction log.
- A handful of 2020 commish-restart lots (the 122h × 9 cluster on 2020-08-XX) are likely a single league-wide commish action that batch-closed an auction window. Their durations inflate the 2020 raw-duration mean from ~30h to ~43h. The capped-48h view neutralizes this.
- Note-marker classification depends on MFL labelling its own forced bids consistently. Spot-checked across 2019, 2022, and 2025 — markers are present and consistent in all sampled years.

---

*All raw data cached at `/tmp/mfl_auction/mfl_txn_{YEAR}_{TYPE}.json` and intermediate results at `/tmp/mfl_auction/result.json`.*
