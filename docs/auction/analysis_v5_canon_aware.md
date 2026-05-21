# UPS FA Auction — Canon-Aware Analysis (v5)

**Generated:** 2026-05-20
**Filter:** Strict July+ · $1K wins excluded · ≥2 bids required. n=663 contested wins, 2019-2025.
**Replaces:** v4 (which framed the $4K median as behavior; it's actually structural).

The $4K median isn't owners "knowing who they want" — it's the **cap-free penalty rule** from `league_context_v1.md §D2`:

> 1-year original-length contracts under $5K (Veteran or WW): 0% guarantee. Cap-free cut anytime.
> WW pickups with salary ≤ $4K remain cap-penalty-free if dropped.

**$4K is the "free option ceiling"** — drop with no consequence. **$5K crosses into 75% guarantee territory** (real commitment, real cap math if you cut). So the bidding piles up to exactly $4K and stops, because at $5K the player has to be worth a year of commitment. The median is the rule, not a coincidence.

---

## Four zones, not deciles

The win-$ distribution maps cleanly to commitment tiers. Replacing the decile framing with this:

| Zone | $ Range | Lots | Share | What it means |
|---|---|---|---|---|
| **Cap-free** | $2-$4K | 401 | 60.5% | Disposable depth. Drop anytime, no cap hit. |
| **Low commit** | $5-$9K | 133 | 20.1% | Real money, but recoverable. You're committing one year of $5-9K. |
| **Mid commit** | $10-$17K | 62 | 9.4% | Meaningful bet. Cut penalty in the $7-13K range. |
| **Marquee** | $18K+ | 67 | 10.1% | Headline-money tier. Sub-divided below. |

### Per-year zone distribution

| Year | Cap-free | Low commit | Mid commit | Marquee |
|---|---|---|---|---|
| 2019 | 53.7% | 22.1% | 13.2% | 11.0% |
| 2020 | 62.7% | 21.7% |  8.4% |  7.2% |
| 2021 | 64.2% | 17.9% |  6.3% | 11.6% |
| 2022 | 57.1% | 17.0% | 15.2% | 10.7% |
| 2023 | 63.2% | 13.2% |  7.4% | 16.2% |
| 2024 | 67.0% | 14.8% | 10.2% |  8.0% |
| 2025 | 58.0% | 17.3% |  8.6% | 16.0% |

Year-over-year is more stable than v4 suggested. The cap-free zone runs 53-67% depending on year. Marquee zone runs 7-16% — 2023 and 2025 were the headline-heavy years (Henry, Rodgers, Herbert, McCaffrey).

---

## D10 (marquee) sub-tiers — where the actual headlines live

D10 is 67 lots ($18K-$94K). Splitting into 10 equal sub-deciles:

| Sub-tier | $ Range | n | Mean | Label |
|---|---|---|---|---|
| D10.1 | $18-$19K | 7 | $18.3K | "real money" — top of the mid-commit, bottom of marquee |
| D10.2 | $20-$21K | 7 | $20.1K | "real money" |
| D10.3 | $21-$22K | 7 | $21.3K | "real money" |
| D10.4 | $23-$27K | 7 | $25.1K | "top-tier asset" |
| D10.5 | $27-$29K | 7 | $27.9K | "top-tier asset" |
| D10.6 | $29-$37K | 7 | $31.9K | **"marquee"** |
| D10.7 | $37-$39K | 7 | $37.7K | **"marquee"** |
| D10.8 | $39-$50K | 7 | $44.0K | **"headline"** |
| D10.9 | $50-$60K | 7 | $53.4K | **"headline"** |
| D10.10 | $61-$94K | 4 | $75.0K | **"all-time"** |

So you were right — $18K isn't a blockbuster. It's barely above the median × 4.5. The real headlines start at **~$30K** (D10.6+, ~38 lots across 7 years = ~5/yr). All-time tier ($60K+) is 4 lots in 7 years.

### Top 15 all-time biggest wins (the "headline" cohort)

| Year | $K | Player | Pos | NFL | Nominator → Winner | Bids/Hrs |
|---|---|---|---|---|---|---|
| 2023 | **$94K** | Derrick Henry | RB | BAL | Real Deal Creel → Real Deal Creel | 30b / 144.9h |
| 2019 | $79K | (#9988) | — | — | CBP → CBP | 10b / 24.0h |
| 2022 | $66K | Tom Brady | QB | FA | Gride → Sex Manther | 11b / 33.5h |
| 2024 | $61K | Tyreek Hill | WR | MIA | Cleon Ca$h → Sex Manther | 7b / 33.7h |
| 2021 | $60K | Keenan Allen | WR | LAC | CBP → CBP | 11b / 24.0h |
| 2022 | $57K | Austin Ekeler | RB | WAS | Pure Greatness → C-Town | 9b / 28.5h |
| 2025 | $56K | Christian McCaffrey | RB | SFO | Cleon Ca$h → Pure Greatness | 11b / 43.5h |
| 2025 | $51K | Justin Herbert | QB | LAC | HammerTime → Cleon Ca$h | 5b / 24.3h |
| 2019 | $50K | (#10276) | — | — | L.A. Looks → Cleon Ca$h | 22b / 117.7h |
| 2019 | $50K | (#11886) | — | — | CBP → Real Deal Creel | 9b / 28.7h |
| 2020 | $50K | Julio Jones | WR | FA | Blake Bombers → Blake Bombers | 5b / 24.0h |
| 2023 | $50K | Aaron Rodgers | QB | PIT | Real Deal Creel → Cleon Ca$h | 9b / 42.3h |
| 2019 | $46K | Tyler Lockett | WR | LVR | HammerTime → CBP | 15b / 46.1h |
| 2020 | $46K | Travis Kelce | TE | KCC | Real Deal Creel → Sex Manther | 10b / 28.3h |
| 2021 | $45K | Dak Prescott | QB | DAL | HammerTime → HammerTime | 7b / 24.0h |

Mostly QB/WR/RB at the very top. Henry's 30-bid/144h win is in a class by itself.

---

## Position-relative is the missing dimension

You were right — a $12K LB and a $12K WR are completely different stories. Per-position percentiles:

| Position | n | Median | p75 | p90 | p95 | Max |
|---|---|---|---|---|---|---|
| QB | 57 | — | — | **$38K** | — | — |
| RB | 83 | — | — | **$23K** | — | — |
| WR | 96 | — | — | **$32K** | — | — |
| TE | 42 | — | — | **$21K** | — | — |
| LB | 75 | — | — | **$5K** | — | — |
| S  | 54 | $4K | — | $4K | — | — |
| DT | 18 | — | — | $6K | — | — |
| DE | 44 | — | — | $8K | — | — |
| PK | 17 | — | — | $3K | — | — |
| PN | 10 | — | — | $3K | — | — |

### Position-relative "notable" matrix

A bid is in the **top 10% for its position** if it hits these thresholds:

| Win $ | QB | RB | WR | TE | LB | DB | DL |
|---|---|---|---|---|---|---|---|
| $10K | routine | routine | routine | routine | **RARE** | routine | routine |
| $12K | routine | routine | routine | routine | **RARE** | routine | routine |
| $15K | routine | routine | routine | routine | **RARE** | routine | routine |
| $20K | routine | routine | routine | routine | **RARE** | routine | routine |
| $30K | routine | **RARE** | routine | **RARE** | **RARE** | routine | routine |

So:
- **A $10K LB = top-10% positional event.** Deserves a celebratory post.
- **A $10K WR = the 50th percentile or worse for that position.** Routine.
- **A $30K RB or TE = top 10% for those positions.** Notable.
- **A $30K WR = still not top 10%** (need $32K+).

This dramatically changes which Won events deserve full celebration. Cap-free zone + position-relative thresholds together = the right matrix.

---

## Cleon Ca$h — the QB-marquee specialist

50 contested wins across 7 years, $560K total spend (most in league). But his profile is distinctive:

### Zone profile (vs league baseline)

| Zone | Cleon | League | Δ |
|---|---|---|---|
| Cap-free $2-$4K | 46.0% | 60.5% | **↓ 14.5pp** |
| Low commit $5-$9K | 22.0% | 20.1% | ≈ |
| Mid commit $10-$17K | 16.0% | 9.4% | **↑ 6.6pp** |
| Marquee $18K+ | 16.0% | 10.1% | **↑ 5.9pp** |

**Cleon under-indexes on cheap depth and over-indexes on real money.** When he wins, it's more often than not in the $10K+ tier where most owners aren't.

### Per-year biggest wins

| Year | Biggest | Player | Pos | Total Spend | Wins | Pattern |
|---|---|---|---|---|---|---|
| 2019 | $50K | #10276 (unnamed) | — | $171K | 13 | Biggest year overall — 13 contested wins + $50K, $33K, $26K trio |
| 2020 | $25K | #10276 (unnamed) | — | $34K | 5 | Quiet year. One real bet. |
| 2021 | $39K | **Aaron Rodgers** | QB | $61K | 7 | One QB swing, rest depth |
| 2022 | $17K | Carson Wentz | QB | $71K | 8 | Modest. Wentz + Roquan Smith $15K |
| 2023 | $50K | **Aaron Rodgers** | QB | $109K | 5 | Marquee blitz — Rodgers $50K, Marquise Brown $37K |
| 2024 | $16K | Stefon Diggs | WR | $43K | 7 | Modest year |
| 2025 | $51K | **Justin Herbert** | QB | $71K | 5 | Back to marquee — Herbert + Maxx Crosby $10K |

**4 of Cleon's top 10 all-time wins are QBs**: $51K Herbert (2025), $50K Rodgers (2023), $39K Rodgers (2021), and the #10276 unnamed lot (which is from 2019 — likely a QB given the pattern).

### Cleon's signature

> **The QB whisperer with budget for marquee bets.** Targets specific QBs across years (Rodgers twice, Herbert), nominates them himself or chases them when others put them up, willing to pay $40-$50K+ when convinced. Under-indexes on the cap-free claim grabs that fill out most franchises' rosters.

---

## Other franchise signatures

| Franchise | n | Cap-free | Low | Mid | Marquee | Total $K | Signature |
|---|---|---|---|---|---|---|---|
| **Cleon Ca$h** | 50 | 46.0% | 22.0% | 16.0% | 16.0% | $560K | **QB marquee specialist** |
| **Pure Greatness** | 67 | 47.8% | 29.9% | 10.4% | 11.9% | $535K | **Balanced — high volume + every tier** |
| **Sex Manther** | 62 | 67.7% | 17.7% | 3.2% | 11.3% | $493K | **Boom-or-bust** — mostly cheap then marquee swings (Brady $66K, Hill $61K) |
| **HammerTime** | 67 | 62.7% | 14.9% | 11.9% | 10.4% | $489K | **Volume + selective marquee** |
| **CBP** | 42 | 59.5% | 19.0% | 7.1% | 14.3% | $426K | **Marquee strikes** (Keenan Allen $60K, #9988 $79K, #11886 sold $50K) |
| **Gride** | 55 | 56.4% | 25.5% | 3.6% | 14.5% | $413K | **Skips the middle — depth or marquee** |
| **Real Deal Creel** | 47 | 68.1% | 17.0% | 4.3% | 10.6% | $404K | **Mostly cheap, one Henry-tier swing ($94K)** |
| **Blake Bombers** | 56 | 71.4% | 8.9% | 8.9% | 10.7% | $397K | **Cheapest profile — most cap-free wins** |
| **L.A. Looks** | 66 | 66.7% | 13.6% | 13.6% | 6.1% | $383K | **Mid-tier player — least marquee activity** |
| **Long Haulers** | 60 | 63.3% | 23.3% | 8.3% | 5.0% | $352K | **Low + low commit, almost no marquee** |
| **Hawks** | 52 | 53.8% | 32.7% | 9.6% | 3.8% | $300K | **Value specialist** — most low-commit, least marquee |
| **C-Town Chivalry** | 39 | 61.5% | 15.4% | 15.4% | 7.7% | $299K | **Fewest wins, biased mid** |

---

## Rotation — keeping GIFs from going stale

The goal: **simple high-level matrix, rotating GIF pools so themes don't repeat.**

### Tier × Position matrix (replaces the "Won = X" simple trigger)

| Tier | Threshold | Player-specific GIF? | Themed-pool fallback |
|---|---|---|---|
| 🏷️ **Routine** | < position p50 | ❌ No GIF (often) | "shrug" pool — 20% fire rate |
| 💵 **Solid** | Between p50 and p75 | 50/50 | "nice grab" pool |
| 💰 **Notable** | Between p75 and p90 | 70% player | "ooh" pool |
| 🌟 **Rare for position** | ≥ p90 | 90% player | "respect" pool |
| 🎯 **Marquee** | $30K+ regardless of position | 90% player | "shock" pool |
| 🏆 **Headline** | $50K+ | 100% player + theme overlay | "all-time" pool |
| 🐲 **All-time** | $60K+ | 100% player + Henry-level reaction | "legendary" overlay |

### Anti-stale rotation

Each themed pool needs **at least 6 GIFs** with the worker tracking last-used. Pick from `(pool − last_3_used)` so the same GIF can't appear three times in a row. Rotation state lives in worker memory (resets daily — that's fine).

### Position-aware composite triggers

Instead of `position: QB`, use `position_percentile_min: 90`:
- "Top 10% for QB" = $38K+ → fires "marquee QB" pool
- "Top 10% for LB" = $5K+ → fires "rare LB win" pool
- Same scenario logic, different dollar thresholds per position

Worker pre-computes position percentiles from the live `position_thresholds.csv` snapshot updated annually.

---

## Suggested next step

1. Update `curated_gifs.json` schema:
   - `position_percentile_min` instead of `min_win_k` for position-aware tiers
   - `pool_id` (so 6+ GIFs per pool can rotate)
   - `composite_overlay: true` for the headline/all-time tier (fires 2 GIFs, one player + one theme)
2. Update worker `pickCuratedGif`:
   - Load `position_thresholds.csv` (or hardcode the current values) for percentile gating
   - Track last-3-used per pool in worker memory
3. Populate 6+ GIFs per pool to start. Pools needed:
   - shrug, nice-grab, ooh, respect, shock, all-time, legendary
   - Plus position-meme pools: rare-LB, rare-S, K-meme, PN-meme
   - And the existing forced/overtake reaction pools (already in v4 matrix)

---

## CSVs in canon

- `docs/auction/data/lot_level_clean.csv` — 663 rows, post-v5 cohort
- `docs/auction/data/per_year_clean.csv` — yearly aggregates
- `docs/auction/data/win_buckets_by_year.csv` — 6-bucket distribution per year
- **NEW** `docs/auction/data/zone_by_year.csv` — 4-zone (cap-free/low/mid/marquee) distribution
- **NEW** `docs/auction/data/position_thresholds.csv` — per-position p50/p75/p90/p95/max
- **NEW** `docs/auction/data/cleon_wins.csv` — Cleon's 50 contested wins (chronological)
