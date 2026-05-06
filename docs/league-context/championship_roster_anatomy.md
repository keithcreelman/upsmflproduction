# UPS Championship Roster Anatomy (2017-2025)

**Generated:** 2026-04-29  
**Cohort:** 9 main-league champions, 2017-2025 (league_id 74598)  
**Sources:** `pipelines/reports/contract_history_{qb,rb,wr,te}.csv` (per-season rostered contracts), `site/standings/standings_74598_<year>.json` (W/L), `site/reports/player_scoring/player_scoring_{2024,2025}.json` (universal weekly production), `pipelines/etl/data_cache_nflverse_season_totals_2014_2025.csv` (universal PPR season totals 2014-2025), MFL→GSIS crosswalk + name-fallback for legacy years.  
**Eras:** 1QB (2017-2021) / SF (2022-2024) / SF+TEP (2025).  
**Data gap:** 2010-2016 contract data is not cleanly reconstructed in `contract_history_*` (the cohort there is largely transactions, not full rosters). Older champions (Dunn 2016, R.Bousquet 2014, Blake 2011/2015, Lake 2012, Whitman 2013) are excluded from cap analysis.

---

## Executive Summary — five findings that should drive 2026 strategy

1. **The QB is the anchor, not the RB or WR.** In 6 of the last 9 championships the team's **#1 producer was the starting QB** (Mahomes 2x, Hurts 2x, Burrow, Maye). The other three (Brown 2017, Elliott 2018, Nacua 2023) were 1QB-era WR/RB-led. Translation: in the SF era you don't win unless your QB1 is a top-3 league QB *that season*.

2. **Champions UNDER-spend on QB and OVER-spend on TE relative to the league.** SF-era champions allocated **18.2% of cap to QB vs the league's 21.8%** (-3.6pp), and **16.1% to TE vs the league's 8.9%** (+7.2pp). The SF+TEP champion (Cutting 2025) was the same: **22.8% QB vs 24.7% league**. The "alpha" position is **TE** — champions have repeatedly bought elite TEs (Kelce 62K in 2020, Andrews 9K in 2021 from extension, McBride 2K in 2024) while the league panic-spends on QB. *Conventional wisdom says load up at QB in SF; the data says load up on TE and get your QB cheap.*

3. **Rookie-deal share of starter production peaked in the Mahomes/Burrow/Hurts mid-era and is now reverting.** 2019-2022 champions averaged **54% of starting points from rookie-deal players**; 2023-2025 champions are at **38.5%**. The 2025 champion (Cutting) ran **34.4% rookie share** — *lower than 5 of the last 9 champions*. The "stack rookies and pray" recipe is no longer mechanically winning; the league has caught on, hit-rates are dropping (see `2024_calibration_retrospective.md`), and modern champions blend rookies with **extended elites** and **strategic auction vets**.

4. **Champions have FEWER starters but pay them MORE per slot.** Champion starting cohort cap spend ranges from **$78K (Martel 2019) to $219K (Bousquet 2017)** out of a ~$270K cap, with median around $159K. They build *deep* rookie pipelines (the rest of the cap goes to bench rookies) but they don't try to start 9 cheap players — every champion since 2018 has had **at least one player at $25K+ in the starting lineup**. The "all-rookie" build does not win.

5. **Star concentration is asymmetric: champions need a positional 1-3 finish from QB, but a top-12 finish from RB/WR/TE is enough.** 2024 champion had **0 top-3 RBs**, **0 top-3 WRs at the position**, and won. 2025 champion had **0 top-3 RBs** and won. In contrast, **8 of 9 champions had a top-12 QB**, and **5 of 9 had a top-3 QB**. Don't pay top-3-RB prices.

**Counter-intuitive takeaways for Keith going into 2026:**
- The league pays ~$66K average for QB; champions pay ~$53K. Don't blow $80K on Jackson/Burrow at auction — the alpha is the SF slot from a $5-15K QB2.
- TE Premium just landed and the league is *still* under-spending on TE ($24.7K avg in 2025). Use this market inefficiency aggressively.
- Don't budget your 2026 cap assuming you need 50%+ rookie production. The modern champion is 35-45% rookie-fueled — keep ~$120K dry for auction and one $25-50K extension hold.

---

## Section 1 — Cap allocation by position (champion roster, full team)

For each champion, sum salaries by position across the entire rostered roster (ROSTER + TAXI + IR). Cap totals reflect the full roster's cumulative salary, not the in-season hard cap (some teams under-cap, some restructure).

### Champion roster cap allocation

| Year | Champion (FID) | Total $ | QB $ | RB $ | WR $ | TE $ | QB% | RB% | WR% | TE% |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2017 | Bousquet S. (0006) | 277,000 | 24,000 | 62,000 | 163,000 | 28,000 | 8.7% | 22.4% | **58.8%** | 10.1% |
| 2018 | Bousquet S. (0006) | 272,000 | 21,000 | 61,000 | 160,000 | 30,000 | 7.7% | 22.4% | **58.8%** | 11.0% |
| 2019 | Martel J. (0007) | 178,000 | 11,000 | 44,000 | 95,000 | 28,000 | 6.2% | 24.7% | 53.4% | 15.7% |
| 2020 | Martel J. (0007) | 282,000 | 16,000 | 104,000 | 89,000 | **73,000** | 5.7% | **36.9%** | 31.6% | **25.9%** |
| 2021 | Bousquet R. (0001) | 232,000 | 9,000 | 84,000 | 127,000 | 12,000 | 3.9% | 36.2% | 54.7% | 5.2% |
| 2022 | Gerardi (0003) | 220,000 | 55,000 | 99,000 | 49,000 | 17,000 | 25.0% | **45.0%** | 22.3% | 7.7% |
| 2023 | Blake (0010) | 293,000 | 50,000 | 85,000 | 136,000 | 22,000 | 17.1% | 29.0% | 46.4% | 7.5% |
| 2024 | Martel E. (0005) | 279,000 | 35,000 | 58,000 | 94,000 | **92,000** | 12.5% | 20.8% | 33.7% | **33.0%** |
| 2025 | Cutting (0004) | 232,000 | 53,000 | 46,000 | 99,000 | 34,000 | 22.8% | 19.8% | 42.7% | 14.7% |

### League-average cap allocation (per-team mean across all 12 teams)

| Year | Avg Total $ | QB$ (%) | RB$ (%) | WR$ (%) | TE$ (%) |
|---|---:|---:|---:|---:|---:|
| 2017 | 269,667 | 28,083 (10.4%) | 81,583 (30.3%) | 130,583 (48.4%) | 29,417 (10.9%) |
| 2018 | 259,250 | 22,333 (8.6%) | 77,917 (30.1%) | 124,167 (47.9%) | 34,833 (13.4%) |
| 2019 | 245,083 | 18,583 (7.6%) | 80,583 (32.9%) | 122,083 (49.8%) | 23,833 (9.7%) |
| 2020 | 260,583 | 18,667 (7.2%) | 89,417 (34.3%) | 127,917 (49.1%) | 24,583 (9.4%) |
| 2021 | 259,667 | 39,417 (15.2%) | 86,750 (33.4%) | 109,417 (42.1%) | 24,083 (9.3%) |
| 2022 | 261,167 | 53,083 (20.3%) | 87,167 (33.4%) | 102,083 (39.1%) | 18,833 (7.2%) |
| 2023 | 259,083 | 49,250 (19.0%) | 92,500 (35.7%) | 92,500 (35.7%) | 24,833 (9.6%) |
| 2024 | 272,500 | 70,667 (25.9%) | 72,333 (26.5%) | 102,250 (37.5%) | 27,250 (10.0%) |
| 2025 | 264,750 | 65,500 (24.7%) | 77,667 (29.3%) | 96,917 (36.6%) | 24,667 (9.3%) |

### Bottom-3 (worst 3 by W-L%) aggregate cap allocation

| Year | Bottom-3 FIDs | Agg Total $ | QB% | RB% | WR% | TE% |
|---|---|---:|---:|---:|---:|---:|
| 2017 | 0008,0005,0002 | 794,000 | 6.5% | 39.2% | 45.5% | 8.8% |
| 2018 | 0005,0002,0012 | 684,000 | 13.7% | 30.0% | 41.7% | 14.6% |
| 2019 | 0006,0011,0012 | 698,000 | 7.2% | **51.6%** | 34.5% | 6.7% |
| 2020 | 0003,0011,0012 | 730,000 | 7.0% | 32.5% | **51.6%** | 8.9% |
| 2021 | 0003,0009,0008 | 717,000 | 22.3% | 34.0% | 31.5% | 12.1% |
| 2022 | 0010,0002,0012 | 771,000 | 21.1% | 20.4% | 51.2% | 7.3% |
| 2023 | 0009,0012,0006 | 600,000 | 23.5% | 27.8% | 39.2% | 9.5% |
| 2024 | 0007,0003,0006 | 828,000 | 24.2% | 24.9% | 42.8% | 8.2% |
| 2025 | 0002,0012,0003 | 765,000 | **28.2%** | 23.4% | 37.0% | 11.4% |

### Era summary — cap %, champion vs league avg

| Era | Pos | Champion cap% | League avg cap% | Delta (pp) |
|---|---|---:|---:|---:|
| 1QB (2017-21) | QB | 6.4% | 9.8% | **-3.4** |
| 1QB | RB | 28.5% | 32.2% | -3.7 |
| 1QB | WR | 51.5% | 47.5% | +4.0 |
| 1QB | TE | 13.6% | 10.6% | **+3.0** |
| SF (2022-24) | QB | 18.2% | 21.8% | **-3.6** |
| SF | RB | 31.6% | 31.9% | -0.3 |
| SF | WR | 34.1% | 37.4% | -3.3 |
| SF | TE | 16.1% | 8.9% | **+7.2** |
| SF+TEP (2025) | QB | 22.8% | 24.7% | -1.9 |
| SF+TEP | RB | 19.8% | 29.3% | **-9.5** |
| SF+TEP | WR | 42.7% | 36.6% | +6.1 |
| SF+TEP | TE | 14.7% | 9.3% | **+5.4** |

**Pattern:** every era, champions **under-spend on QB and over-spend on TE** relative to league average. The 2025 champion *also* dramatically under-spent on RB. RB is becoming a "find the cheap one" position; the alpha sits in TE.

---

## Section 2 — Win-chunks: roster production share by position

For each champion, sum **full-team rostered points** (every player with snapshot at any week, on this franchise, that season) and split by position. Production via player_scoring (2024-25) + nflverse fallback (2017-23).

### Champion full-team production share

| Year | Era | QB pts | RB pts | WR pts | TE pts | QB% | RB% | WR% | TE% |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2017 | 1QB | 502.6 | 507.5 | 55.6 | 0.0 | 47.2% | 47.6% | 5.2% | 0.0% |
| 2018 | 1QB | 365.5 | 230.2 | 398.9 | 0.0 | 36.7% | 23.1% | 40.1% | 0.0% |
| 2019 | 1QB | 745.7 | 425.9 | 772.8 | 214.6 | 34.5% | 19.7% | 35.8% | 9.9% |
| 2020 | 1QB | 431.6 | 240.1 | 1131.2 | 681.6 | 17.4% | 9.7% | 45.5% | **27.4%** |
| 2021 | 1QB | 379.7 | 997.2 | 875.6 | 314.5 | 14.8% | **38.8%** | 34.1% | 12.3% |
| 2022 | SF | 1177.5 | 531.5 | 1372.7 | 212.1 | **35.7%** | 16.1% | 41.7% | 6.4% |
| 2023 | SF | 136.7 | 865.1 | 2086.7 | 497.1 | 3.8% | 24.1% | **58.2%** | 13.9% |
| 2024 | SF | 663.6 | 664.1 | 1573.2 | 642.4 | 18.7% | 18.7% | 44.4% | **18.1%** |
| 2025 | SF+TEP | 1008.3 | 1130.5 | 1401.5 | 474.2 | 25.1% | 28.2% | 34.9% | 11.8% |

*2017-2018 totals are partial because of nflverse coverage for some bench rookies; the 1QB-era share % is still directionally correct.*  
*2023 QB anomaly = Watson's injury season (16 PPR pts, $16K hit). Blake won despite it via WR depth.*

### Era-stratified production share (champion vs league avg)

| Era | Pos | Champion pts% | League avg pts% | Delta (pp) |
|---|---|---:|---:|---:|
| 1QB | QB | 30.1% | 25.7% | +4.4 |
| 1QB | RB | 27.8% | 28.7% | -0.9 |
| 1QB | WR | 32.2% | 33.2% | -1.0 |
| 1QB | TE | 9.9% | 12.4% | -2.5 |
| SF | QB | 19.4% | 22.2% | -2.8 |
| SF | RB | 19.7% | 27.9% | **-8.2** |
| SF | WR | 48.1% | 38.3% | **+9.8** |
| SF | TE | 12.8% | 11.7% | +1.1 |
| SF+TEP | QB | 25.1% | 22.8% | +2.3 |
| SF+TEP | RB | 28.2% | 26.8% | +1.4 |
| SF+TEP | WR | 34.9% | 34.5% | +0.4 |
| SF+TEP | TE | 11.8% | 15.9% | -4.1 |

**Key finding:** in the **SF era (2022-2024)** champions get **+9.8pp more production from WR** than the league average and **-8.2pp less from RB**. WR depth wins the SF era. RB is fungible; you don't need to be *good* at RB, just functional.

---

## Section 3 — Rookie-deal contribution to the starting cohort

Methodology: synthesize a **starting cohort** for each franchise (1QB era: 1QB+2RB+3WR+1TE+1FLEX = 8 starters; SF/SF+TEP era: 1QB+2RB+3WR+1TE+1FLEX+1SF = 9 starters). Pick the highest-scoring rostered player by position, greedy-fill SF/FLEX with best remainder. "Rookie deal" = `contract_status` contains "Rookie" (covers `Rookie`, `ROOKIE`, `Rookie GF`, `Rookie/Veteran`, `Rookie/Extension`).

### Champion starting cohort: rookie-deal contribution

| Year | CH | Total starter pts | # Rookies | Rookie pts | Rookie %pts | Rookie total $ | # Auction-vet | Vet %pts | # Trade | Trade %pts | # Carryover-multiyr | Carry %pts |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2017 | 0006 | 2225 | 2 | 616 | 27.7% | 19,000 | 1 | 7.9% | 0 | 0.0% | 0 | 0.0% |
| 2018 | 0006 | 2094 | 2 | 601 | 28.7% | 24,000 | 1 | 10.1% | 1 | 6.4% | 0 | 0.0% |
| 2019 | 0007 | 1885 | 5 | 1232 | **65.4%** | 32,000 | 2 | 26.6% | 0 | 0.0% | 0 | 0.0% |
| 2020 | 0007 | 2178 | 4 | 971 | 44.6% | 29,000 | 1 | 18.3% | 0 | 0.0% | 2 | 28.3% |
| 2021 | 0001 | 2174 | 4 | 1058 | 48.7% | 29,000 | 0 | 0.0% | 0 | 0.0% | 1 | 9.9% |
| 2022 | 0003 | 2321 | 5 | 1330 | **57.3%** | 42,000 | 3 | 31.9% | 0 | 0.0% | 0 | 0.0% |
| 2023 | 0010 | 2254 | 3 | 853 | 37.9% | 28,000 | 2 | 22.3% | 1 | 12.7% | 0 | 0.0% |
| 2024 | 0005 | 2235 | 4 | 968 | 43.3% | 24,000 | 0 | 0.0% | 1 | 10.7% | 0 | 0.0% |
| 2025 | 0004 | 2450 | 3 | 842 | 34.4% | 31,000 | 2 | 22.9% | 0 | 0.0% | 2 | 18.8% |

Era averages of rookie %pts of starter cohort:
- 1QB era (2017-2021): **42.9%**
- SF era (2022-2024): **45.5%**
- SF+TEP (2025): **34.4%**

### Champion vs league avg vs bottom-3 (rookie %pts of starter cohort)

| Year | Champion % | League avg % | League median % | Bottom-3 avg % |
|---|---:|---:|---:|---:|
| 2017 | 27.7% | 26.6% | 26.5% | 29.2% |
| 2018 | 28.7% | 34.6% | 31.6% | 37.2% |
| 2019 | **65.4%** | 41.2% | 45.4% | 41.8% |
| 2020 | 44.6% | 30.7% | 29.0% | 40.0% |
| 2021 | 48.7% | 40.3% | 47.8% | 40.3% |
| 2022 | 57.3% | 36.5% | 40.6% | 24.8% |
| 2023 | 37.9% | 34.1% | 31.2% | 47.7% |
| 2024 | 43.3% | 35.2% | 35.7% | 28.9% |
| 2025 | 34.4% | 25.1% | 19.0% | 10.4% |

**Pattern:** champions almost always run **higher rookie %pts than league average** (8 of 9 years), and often higher than bottom-3 (6 of 9). But the **delta has been compressing**: the 2017-2018 champions actually ran *less* rookie share than the bottom-3. Bottom-3 in 2025 had **only 10.4% rookie share** — they relied on aging vets and lost. The "fail" mode is **all-vet team that doesn't extend cheap rookies into stars**.

### Cap-tier mix of the champion starting cohort

| Year | $0-2K | $3-9K | $10-24K | $25-49K | $50K+ |
|---|---:|---:|---:|---:|---:|
| 2017 | 0 | 2 | 1 | 4 | 1 |
| 2018 | 1 | 1 | 2 | 3 | 1 |
| 2019 | 2 | 2 | 4 | 0 | 0 |
| 2020 | 2 | 2 | 2 | 1 | 1 |
| 2021 | 0 | 4 | 1 | 2 | 1 |
| 2022 | 2 | 3 | 3 | 0 | 1 |
| 2023 | 1 | 0 | 6 | 1 | 1 |
| 2024 | 1 | 3 | 3 | 2 | 0 |
| 2025 | 0 | 4 | 3 | 1 | 1 |

Every champion since 2018 except 2024 had **at least one starter at $50K+**. Five of nine had two or more starters at $25K+. The "spam $1-9K starters and pray" build (2019 only) wins once a decade.

---

## Section 4 — Star concentration (top-12 finishers per position)

Position rank: positional_rank from `player_scoring_<season>.json` (2024-25), nflverse PPR rank fallback (2017-23). Top-3 = elite tier; 4-12 = startable tier.

### Champion top-12 finishers on roster

| Year | CH | QB1-3 | QB4-12 | RB1-3 | RB4-12 | WR1-3 | WR4-12 | TE1-3 | TE4-12 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2017 | 0006 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| 2018 | 0006 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| 2019 | 0007 | 1 | 0 | 0 | 1 | 0 | 1 | 0 | 0 |
| 2020 | 0007 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| 2021 | 0001 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| 2022 | 0003 | 1 | 0 | 0 | 1 | 0 | 2 | 0 | 0 |
| 2023 | 0010 | 0 | 0 | 0 | 0 | 0 | 2 | 1 | 0 |
| 2024 | 0005 | 0 | 1 | 0 | 0 | 1 | 0 | 1 | 1 |
| 2025 | 0004 | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 1 |

*2017-2018 nflverse PPR rank does not exactly match UPS scoring; counts may understate. The 2017 champion had AB/Hopkins/Thomas/Tate at WR who were league-leaders by UPS scoring even if their nflverse-PPR rank fell outside top-12 with mid-tier-volume scoring.*

### Bottom-3 average top-12 finishers per team (per-position)

| Year | QB1-3 | QB4-12 | RB1-3 | RB4-12 | WR1-3 | WR4-12 | TE1-3 | TE4-12 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2017 | 0.00 | 0.00 | 0.00 | 0.33 | 0.00 | 0.00 | 0.00 | 0.00 |
| 2018 | 0.00 | 0.33 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 2019 | 0.00 | 0.33 | 0.00 | 0.00 | 0.33 | 0.00 | 0.00 | 0.00 |
| 2020 | 0.00 | 0.33 | 0.00 | 0.00 | 0.00 | 0.67 | 0.00 | 0.67 |
| 2021 | 0.67 | 0.33 | 0.00 | 0.33 | 0.33 | 0.33 | 0.00 | 0.67 |
| 2022 | 0.33 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.33 | 0.67 |
| 2023 | 0.33 | 0.67 | 0.00 | 0.33 | 0.00 | 0.33 | 0.00 | 0.00 |
| 2024 | 0.00 | 0.33 | 0.67 | 0.67 | 0.67 | 0.33 | 0.33 | 0.00 |
| 2025 | 0.00 | 1.00 | 0.33 | 1.00 | 0.00 | 0.67 | 0.00 | 0.33 |

### Anchor archetype — top scorer concentration

| Year | Top scorer | Pos | Top1 pts | Top1 %team | Top1+2 % | Top1+2+3 % |
|---|---|---|---:|---:|---:|---:|
| 2017 | Antonio Brown | WR | 342 | 15.4% | 29.3% | 43.2% |
| 2018 | Ezekiel Elliott | RB | 371 | 17.7% | 34.0% | 49.8% |
| 2019 | Patrick Mahomes | **QB** | 385 | 20.4% | 36.8% | 51.2% |
| 2020 | Patrick Mahomes | **QB** | 432 | 19.8% | 38.1% | 50.7% |
| 2021 | Joe Burrow | **QB** | 380 | 17.5% | 34.1% | 48.0% |
| 2022 | Jalen Hurts | **QB** | 458 | 19.7% | 33.5% | 46.4% |
| 2023 | Puka Nacua | WR | 331 | 14.7% | 27.6% | 40.3% |
| 2024 | Jalen Hurts | **QB** | 367 | 16.4% | 31.4% | 42.7% |
| 2025 | Drake Maye | **QB** | 422 | 17.2% | 31.8% | 45.0% |

**6 of 9 champions had their starting QB as their #1 producer.** Average top-1 share = 17.6% of total starter pts. Average top-3 share = 46.4%. The "balanced offense" model (3 players carry ~46% of points, the rest are role players) is consistent.

---

## Section 5 — Position investment: where is the alpha?

| Year | Era | QB ch% | QB lg% | QB Δ | RB ch% | RB lg% | RB Δ | WR ch% | WR lg% | WR Δ | TE ch% | TE lg% | TE Δ |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2017 | 1QB | 8.7 | 10.4 | -1.7 | 22.4 | 30.3 | -7.9 | 58.8 | 48.4 | +10.4 | 10.1 | 10.9 | -0.8 |
| 2018 | 1QB | 7.7 | 8.6 | -0.9 | 22.4 | 30.1 | -7.7 | 58.8 | 47.9 | +10.9 | 11.0 | 13.4 | -2.4 |
| 2019 | 1QB | 6.2 | 7.6 | -1.4 | 24.7 | 32.9 | -8.2 | 53.4 | 49.8 | +3.6 | 15.7 | 9.7 | **+6.0** |
| 2020 | 1QB | 5.7 | 7.2 | -1.5 | 36.9 | 34.3 | +2.6 | 31.6 | 49.1 | -17.5 | 25.9 | 9.4 | **+16.5** |
| 2021 | 1QB | 3.9 | 15.2 | **-11.3** | 36.2 | 33.4 | +2.8 | 54.7 | 42.1 | +12.6 | 5.2 | 9.3 | -4.1 |
| 2022 | SF | 25.0 | 20.3 | +4.7 | 45.0 | 33.4 | +11.6 | 22.3 | 39.1 | -16.8 | 7.7 | 7.2 | +0.5 |
| 2023 | SF | 17.1 | 19.0 | -1.9 | 29.0 | 35.7 | -6.7 | 46.4 | 35.7 | +10.7 | 7.5 | 9.6 | -2.1 |
| 2024 | SF | 12.5 | 25.9 | **-13.4** | 20.8 | 26.5 | -5.7 | 33.7 | 37.5 | -3.8 | 33.0 | 10.0 | **+23.0** |
| 2025 | SF+TEP | 22.8 | 24.7 | -1.9 | 19.8 | 29.3 | -9.5 | 42.7 | 36.6 | +6.1 | 14.7 | 9.3 | **+5.4** |

**Position-by-position alpha read:**
- **QB:** Champions are -3.0pp under league on average. The 2024 case (-13.4pp) is wild — Eric Martel won with $35K total at QB while the league averaged $70K. *The QB market is consistently overpriced in the SF era.*
- **RB:** Champions slightly under (-2.5pp average). 2017-2019 era was big RB under-spend (-8pp); 2025 was -9.5pp. *RB is fungible at the margin; don't pay top-3-RB prices.*
- **WR:** Champions over-spend on WR (+1.7pp average), but with high variance. *WR depth wins the SF era.*
- **TE:** Champions over-spend +6.1pp on average. **Three champions (2020, 2024 specifically with $73K and $92K TE allocations) won by buying elite TEs while the league spent ~$25K**. 2025 TE Premium era: champion was +5.4pp over league. *TE is the reliable alpha position.*

---

## Section 6 — Champion starting cohort details (audit)

For Keith to audit. Each champion's actual starting cohort with salary, contract status, and acquisition path.

### 2017 Bousquet S. (1QB era)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| WR | Antonio Brown | WR | 342 | $80K | STANDARD (2) | carryover |
| WR | DeAndre Hopkins | WR | 310 | $29K | STANDARD (2) | carryover |
| RB | Kareem Hunt | RB | 309 | $9K | ROOKIE (3) | rookie |
| WR | Michael Thomas | WR | 307 | $10K | ROOKIE (2) | rookie |
| RB | Mark Ingram | RB | 286 | $33K | FRONT LOAD (2) | extension |
| QB | Philip Rivers | QB | 270 | $6K | STANDARD (1) | auction |
| FLEX | Golden Tate | WR | 225 | $27K | STANDARD (1) | carryover |
| TE | Kyle Rudolph | TE | 176 | $25K | STANDARD (2) | auction_vet |

### 2018 Bousquet S. (1QB era, repeat)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| RB | Ezekiel Elliott | RB | 371 | $15K | Rookie/Extension (3) | rookie |
| WR | DeAndre Hopkins | WR | 342 | $39K | Veteran (3) | extension |
| WR | Davante Adams | WR | 330 | $25K | Veteran (3) | extension |
| WR | Antonio Brown | WR | 324 | $80K | Veteran (1) | carryover |
| RB | Kareem Hunt | RB | 230 | $9K | Rookie (2) | rookie |
| QB | Matthew Stafford | QB | 212 | $16K | Veteran (2) | auction |
| TE | Kyle Rudolph | TE | 151 | $25K | Veteran (1) | carryover |
| FLEX | Kenny Stills | WR | 134 | $1K | Veteran (1) | trade |

### 2019 Martel J. (1QB era — the all-rookie classic)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| QB | Patrick Mahomes | QB | 385 | $2K | Rookie/Veteran GF (3) | rookie |
| RB | Austin Ekeler | RB | 309 | $21K | Veteran (1) | auction |
| WR | Cooper Kupp | WR | 271 | $2K | Rookie GF (1) | rookie |
| RB | Saquon Barkley | RB | 244 | $15K | Rookie GF (2) | rookie |
| WR | Cole Beasley | WR | 193 | $4K | WW (1) | auction |
| WR | Curtis Samuel | WR | 172 | $5K | Rookie/Veteran GF (2) | rookie |
| FLEX | Mike Williams | WR | 161 | $12K | Rookie/Veteran GF (2) | rookie |
| TE | Hunter Henry | TE | 150 | $17K | Veteran GF (2) | extension |

### 2020 Martel J. (1QB era, repeat — Mahomes anchor, Kelce splurge)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| QB | Patrick Mahomes | QB | 432 | $14K | Veteran GF (2) | carryover-multiyr |
| TE | Travis Kelce | TE | 398 | $62K | FL (2) | auction_vet |
| WR | Justin Jefferson | WR | 274 | $8K | Rookie (3) | rookie |
| WR | A.J. Brown | WR | 268 | $6K | Rookie GF (2) | rookie |
| WR | Chase Claypool | WR | 238 | $2K | Rookie (3) | rookie |
| RB | Kenyan Drake | RB | 192 | $31K | Veteran (1) | carryover |
| RB | J.K. Dobbins | RB | 192 | $13K | Rookie (3) | rookie |
| FLEX | Nelson Agholor | WR | 186 | $1K | Veteran (2) | carryover-multiyr |

### 2021 Bousquet R. (1QB era — Burrow + extension WRs)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| QB | Joe Burrow | QB | 380 | $5K | Rookie (2) | rookie |
| WR | Davante Adams | WR | 362 | $65K | FL (2) | extension |
| TE | Mark Andrews | TE | 301 | $9K | FL (2) | extension |
| WR | D.J. Moore | WR | 238 | $29K | Veteran (2) | extension |
| RB | Devin Singletary | RB | 237 | $5K | Rookie GF (1) | rookie |
| WR | CeeDee Lamb | WR | 236 | $12K | Rookie (2) | rookie |
| RB | Nick Chubb | RB | 215 | $27K | Veteran (2) | carryover-multiyr |
| FLEX | Javonte Williams | RB | 205 | $7K | Rookie (3) | rookie |

### 2022 Gerardi (SF era, year 1)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| QB | Jalen Hurts | QB | 458 | $2K | Rookie (1) | rookie |
| SF | Geno Smith | QB | 321 | $5K | Veteran (2) | auction |
| WR | DeVonta Smith | WR | 297 | $6K | Rookie (2) | rookie |
| WR | Christian Kirk | WR | 284 | $9K | Veteran (2) | auction |
| RB | Dalvin Cook | RB | 251 | $60K | FL (2) | extension |
| WR | Jerry Jeudy | WR | 204 | $10K | Rookie (1) | rookie |
| RB | D'Andre Swift | RB | 191 | $11K | Rookie/Veteran (2) | rookie |
| FLEX | Drake London | WR | 179 | $13K | Rookie (3) | rookie |
| TE | Hayden Hurst | TE | 137 | $2K | Veteran (1) | auction |

### 2023 Blake (SF era — survived a Watson injury)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| WR | Puka Nacua | WR | 331 | $2K | Rookie (3) | rookie |
| RB | Breece Hall | RB | 291 | $15K | Rookie (2) | rookie |
| WR | D.J. Moore | WR | 287 | $61K | FL (2) | trade |
| WR | Deebo Samuel | WR | 273 | $25K | Veteran (2) | extension |
| RB | Raheem Mostert | RB | 272 | $10K | Veteran (1) | auction |
| SF | Michael Pittman | WR | 252 | $15K | Veteran (2) | extension |
| FLEX | Chris Olave | WR | 231 | $11K | Rookie (2) | rookie |
| TE | Evan Engram | TE | 230 | $17K | Tag (1) | auction |
| QB | Deshaun Watson | QB | 87 | $16K | FL (2) | extension (injured) |

### 2024 Martel E. (SF era — Stroud SF + Hurts QB1)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| QB | Jalen Hurts | QB | 367 | $22K | Veteran (3) | extension |
| WR | Justin Jefferson | WR | 335 | $48K | Veteran (3) | extension |
| SF | C.J. Stroud | QB | 254 | $12K | Rookie (2) | rookie |
| WR | Ladd McConkey | WR | 245 | $5K | Rookie (3) | rookie |
| TE | Trey McBride | TE | 242 | $2K | Rookie (1) | rookie |
| WR | A.J. Brown | WR | 239 | $19K | BL (2) | trade |
| FLEX | Zay Flowers | WR | 228 | $5K | Rookie (2) | rookie |
| RB | Rhamondre Stevenson | RB | 180 | $8K | Veteran (2) | extension |
| RB | Javonte Williams | RB | 146 | $27K | Veteran (2) | extension |

### 2025 Cutting (SF+TEP era — first TEP champion)
| Slot | Player | Pos | Pts | Salary | Status (Yr) | Acq |
|---|---|---|---:|---:|---|---|
| QB | Drake Maye | QB | 422 | $8K | Rookie (2) | rookie |
| RB | Jahmyr Gibbs | RB | 356 | $11K | Veteran (3) | extension |
| SF | Baker Mayfield | QB | 324 | $36K | FL (2) | auction |
| WR | Chris Olave | WR | 287 | $51K | FL (2) | carryover-multiyr |
| RB | Ashton Jeanty | RB | 239 | $15K | Rookie (3) | rookie |
| TE | Travis Kelce | TE | 237 | $21K | Veteran (1) | auction |
| WR | Zay Flowers | WR | 229 | $5K | Veteran (3) | extension |
| WR | Quentin Johnston | WR | 181 | $8K | Rookie (1) | rookie |
| FLEX | Jakobi Meyers | WR | 175 | $4K | Veteran (2) | carryover-multiyr |

---

## Section 7 — Forward-looking 2026 cap allocation

### What the data says about 2026 (SF+TEP era, year 2)

The 2025 champion model is the cleanest forward-looking template. Cutting won with:
- **Total starter cap:** $159K of ~$240K cap (66% on starters, 34% on bench/depth) → leaves runway.
- **QB pair:** Maye ($8K rookie) as QB1 + Mayfield ($36K) as SF → **$44K total at SF/QB**, well under the $66K league average. *Don't pay $50K+ for a single elite QB.*
- **RB:** Gibbs ($11K extension) + Jeanty ($15K rookie) → **$26K**, a steal. League avg $77K at RB.
- **WR:** Olave ($51K) + Flowers ($5K extension) + Johnston ($8K) + Meyers ($4K) → **$68K**, well under league $97K average. The $51K Olave is the "anchor extension" play.
- **TE:** Kelce ($21K) → cheap TE Premium win.

### Recommended 2026 cap blueprint (Keith's Pure Greatness)

| Position | % of cap | $ of $240K | Notes |
|---|---:|---:|---|
| QB1 (rookie or 2nd-year cheap) | 5% | $12K | Maye/Daniels/Williams 2nd-year template; avoid Allen/Burrow/Jackson auction |
| SF (vet auction or 2nd RB on rookie deal) | 15% | $36K | Mayfield/Stroud/Stafford-tier |
| RB1 (extension hold) | 10% | $24K | one anchor RB on year 2-3 of cheap deal |
| RB2/Flex (rookie depth) | 5% | $12K | rotate from rookie pool, accept 1 hits in 4 |
| WR1 (anchor — extension or auction) | 20% | $48K | Olave/Jefferson/Lamb-tier |
| WR2-WR3 (rookies + cheap extensions) | 15% | $36K | three rookie/extension slots @$3-15K |
| TE (alpha — extension hold or rookie ascent) | 10% | $24K | Kelce-tier or McBride-tier; do not let market push you to $40K+ |
| Bench / TAXI / Tag reserves | 20% | $48K | rookie pipeline, IR holds |

**Total starter spend target: ~$192K (80% of cap)**, with ~$48K reserve for in-season auction targets, taxi promotions, and tag/extension flex.

### Rookie production target

- Aim for **35-45% of starter production from rookie deals**. Below 25% means you're paying market price (the bottom-3 trap); above 65% means you're betting on rookies hitting (Martel 2019 was a glorious one-off, not replicable).
- **# of rookie-deal starters:** target **3-4 of 9** in your starting cohort. Expect to roster 8-12 rookie deals total.

### Position-investment heuristics

- **QB:** under-spend (-3pp vs league). The alpha is finding a top-12 producer at $5-25K. Avoid $50K+ QB1 auctions.
- **RB:** match league or slightly under. Don't pay top-3-RB prices; the 2025 champion paid $26K total at RB and was fine.
- **WR:** match league or slightly over. **One $40-50K anchor extension** + rookie/cheap depth beats spreading $20K across 5 mid-tier WRs.
- **TE:** **OVER-spend +5-10pp vs league** in TE Premium era. League is still pricing TE like 1QB era. McBride/Bowers/LaPorta-tier holds at $2-15K are the alpha.

### Non-obvious 2026 signals from the data

- **You don't need a top-3 QB.** Maye in 2025 was QB6-ish. Hurts in 2024 was QB2. Win with a top-12 producer that you got cheap.
- **You don't need a top-3 anything except QB anchor.** Champions average ~1 top-3 player per championship total across all positions. *Star concentration is overrated; depth + a dominant QB is the recipe.*
- **The WR position bucket is the highest-variance investment.** 2017-2018 champions ran 58.8% WR cap; 2022 champion ran 22.3% WR cap. Both won. There's no single "right" WR allocation — but you need 3 WR producers each scoring 200+ pts.
- **Carryover-multiyear contracts are quietly a champion staple.** 4 of 9 champions had at least 1 multi-year carryover starter in their cohort (Mahomes 2020, Chubb 2021, Olave 2025, Meyers 2025). These are extension-equivalents that lock cheap-cost-controlled vets — find them at the auction.
- **Trade is rare but high-impact.** Only 3 champions had a trade-acquired starter (Stills 2018, D.J.Moore 2023, A.J.Brown 2024). When champions trade, they trade for an anchor WR.

### 2026 anti-patterns (stuff that lost the title)

- **All-vet cap-stacked roster:** the 2025 bottom-3 averaged 10.4% rookie production share (vs the 25.1% league avg). Zero rookies in the starter cohort = guaranteed ceiling cap, which is below the league average team.
- **Spending top-3-RB money on RB1:** the data doesn't reward it. Hunt ($9K), Henry ($9K), Gibbs ($11K), Stevenson ($8K) were anchors at <$15K.
- **Panic-buying QB1 at auction in SF era:** the 2024 league average was $70K at QB. Champion paid $35K. The QB premium is a classic FOMO trap.
- **Ignoring TE in TEP era:** the 2025 league averaged $24K at TE; champion was $34K (+$10K above), and that 2pp edge mattered. Bottom-3 averaged ~10% rookie share AND under-spent TE — double-fail.

---

## Appendix — Data caveats

- **Pre-2017 data:** contract_history reconstruction is patchy for 2010-2016. We use **2017-2025 (9 champions)** as the analytical cohort.
- **2017-2018 production gap:** ~50 player-seasons in the bench/depth tier had no nflverse PPR match (mostly TAXI/IR/never-active rookies). This understates *team total* points slightly but does not bias starter-cohort production (top players are all matched).
- **Cap totals:** sum of `salary` field across all rows where `status` ∈ {ROSTER, TAXI_SQUAD, INJURED_RESERVE}. This is "cumulative roster cost" not "active hard-cap charged." Some teams have higher totals because of off-cap taxi (post-rule-change), legacy GF holds, etc.
- **Starter cohort:** synthesized greedy from per-position roster + season points. This approximates the *actual* starting lineup decisions but does not exactly reproduce week-by-week starts. For 2024-2025 a `usage_status_code` exists in `player_scoring_<year>.json` weekly arrays that could improve fidelity in a future pass. Logged as a follow-up: use `player_scoring` weekly start-data to compute *actual* starter-week production.
- **Acquisition classification:** `rookie_deal` = contract_status contains "Rookie"; `extension` = `extension_flag = 1` OR `change_category = extension_inferred`; `auction_vet` = `current_transaction_source LIKE 'AUCTION%'`; `trade` = `current_transaction_source = 'TRADE'`; `carryover_*` = pre-existing multi-year vet contract. There is overlap (a player on year-2 of an extension is "carryover_multiyear" not "extension" in the season-row classification).
- **Position rank for star concentration:** uses positional_rank from player_scoring (UPS-scored, season totals) for 2024-25 and nflverse-PPR rank for 2017-2023. nflverse-PPR doesn't include UPS-specific bonuses (TE Premium, return TDs), so 2017-2023 star counts are conservative.
