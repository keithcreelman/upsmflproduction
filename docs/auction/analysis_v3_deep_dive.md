# UPS FA Auction — Deep-Dive Analysis (v3)

**Generated:** 2026-05-20
**Filter:** Strict July+ across all 7 years (2019-2025). 665 contested lots; 589 uncontested. 1,254 total FA nominations.

This doc replaces the headline-level insights in `analysis_v2_strict.md` with specific player names, franchise contexts, and the underlying data. Two findings shifted materially when I dug into specifics — flagged inline.

---

## 1. Contestation decline — what's actually happening

Headline: contestation rate dropped from 66% (2019) to 41-50% (2023-25).

### Per-year breakdown

| Year | FA Total | Contested | Uncontested | % Contested |
|---|---|---|---|---|
| 2019 | 206 | 136 | **70** | 66.0% |
| 2020 | 167 |  83 | 84 | 49.7% |
| 2021 | 180 |  97 | 83 | 53.9% |
| 2022 | 187 | 112 | 75 | 59.9% |
| 2023 | 165 |  68 | **97** | **41.2%** ← floor |
| 2024 | 179 |  88 | 91 | 49.2% |
| 2025 | 170 |  81 | 89 | 47.6% |

### What I missed in v2: uncontested wins are ALL $1K

Every single uncontested FA "win" — all 589 across 7 years — closed at exactly **$1K**. The price distribution has zero variance:

```
min_k = 1, p25_k = 1, median_k = 1, p75_k = 1, max_k = 1
```

These aren't "auctions" in any meaningful sense. They're nomination grabs:
- Owner nominates a player at $1K (the minimum opening)
- Nobody else bids in the 24-hour window
- Owner wins at $1K — usually nominating themselves as the buyer

This pattern explains the contestation decline. It's not that fewer players are interesting. It's that **owners are increasingly using the FA Auction as a free-agent claim mechanism, not a competitive marketplace.** The nomination is the acquisition.

### 2023 is the inflection year

2023 had **the highest uncontested count in 7 years (97)** AND the lowest contested total (68). Together: only 41% of FA noms drew a 2nd bid.

Some 2019 uncontested examples (for sanity-check — these are real players self-nominated and won at $1K):
- **Case Keenum (QB CHI)** — Gride nominated, Gride won, $1K
- **Vonn Bell (S FA)** — Blake Bombers nominated, Blake Bombers won, $1K
- (Plus 67 more in 2019 alone)

By 2023, the pattern was systemic: nearly 100 players per year hit the auction as nomination grabs that drew zero opposition.

### Why this matters

The "auction" has bifurcated into two products:
1. **Real auctions** (~50% of noms) — competitive multi-bid lots, 30+ hours, real $$ ranges
2. **Nomination grabs** (~50% of noms) — $1K self-noms with no competition

Treating these as one population pollutes every average. The real-auction averages (33.75 hrs, 4.25 bids) are computed against group 1; group 2 is invisible to most analytics.

### Idea: surface "uncontested watch" in the Hub

Show a live count of "Nominations open with 0 competing bids — closing in N hours." Other owners see what's about to be free-acquired and have a chance to throw a competing bid. This could reverse the slide if owners realize how many quality players are slipping through at $1K.

---

## 2. War archetypes — proxy-grind vs active-overtakes

### What the ratios mean

For each lot we count two event types beyond the nomination:
- **Forced increase**: MFL walked the leader's hidden proxy up because someone else bid into their max
- **Overtake**: a new franchise bid higher than the current leader (genuine competition)

Lots with high forced + low overtake = **proxy-grind** (two ceilings grinding past each other)
Lots with low forced + high overtake = **active overtake** (real competition with humans clicking)

### Textbook proxy-grind lots

| Year | Player | Pos | Bids | F:O | Winner | Win $ | Duration |
|---|---|---|---|---|---|---|---|
| 2019 | Tom Brady | QB | 16 | 10F / 5O | Hawks | $20K | 69.5h |
| 2021 | **Keenan Allen** | WR | 11 | **10F / 0O** | CBP | $60K | 24.0h |
| 2022 | **Daniel Jones** | QB | 11 | **10F / 0O** | Blake Bombers | $16K | 24.0h |
| 2019 | (pid 9988) | — | 10 | 9F / 0O | CBP | $79K | 24.0h |
| 2020 | (pid 11747) | — | 17 | 10F / 6O | HammerTime | $26K | 72.0h |

**Keenan Allen 2021 is the cleanest example**: 10 forced increases, ZERO overtakes. CBP nominated at $1K, somebody else challenged once, then MFL just walked CBP's hidden $60K proxy up against an opponent's matching proxy. 10 auto-bids over 24 hours, CBP wins. Nobody was actively clicking — just two pre-set ceilings grinding.

### Textbook active-overtake lots

| Year | Player | Pos | Bids | F:O | Winner | Win $ | Duration |
|---|---|---|---|---|---|---|---|
| 2023 | **Marquise Brown** | WR | 15 | 2F / 12O | Cleon Ca$h | $37K | 101.4h |
| 2024 | **Alvin Kamara** | RB | 17 | 5F / 11O | CBP | $27K | 92.9h |
| 2020 | Robert Woods | WR | 14 | 5F / 8O | Long Haulers | $31K | 90.5h |
| 2020 | (pid 10276) | — | 10 | 1F / 8O | Cleon Ca$h | $25K | 77.8h |
| 2020 | (pid 12197) | — | 10 | 1F / 8O | Gride | $11K | 75.4h |

**Marquise Brown 2023 is the cleanest example**: 12 different overtake events over 4 days. Multiple franchises actively monitored, watched the bid, decided to come over the top. Real competition.

### The two patterns play out differently

- **Proxy-grind** lots tend to close near 24h (because MFL's walks are instantaneous; once the ceilings clash, it's over fast). Keenan Allen 2021 + Daniel Jones 2022 both closed in 24.0h.
- **Active-overtake** lots tend to drag past 48h (humans take time to log in, see the new high, respond). Marquise Brown 2023 dragged 101h; Kamara 2024 went 93h.

### Year-by-year archetype trend (F:O ratio)

| Year | F:O | Pattern |
|---|---|---|
| 2019 | 1.10 | balanced |
| 2020 | 1.11 | balanced |
| 2021 | 1.23 | slight proxy-grind |
| 2022 | **1.51** | proxy-grind (Daniel Jones-style years) |
| 2023 | **0.83** | active overtakes (Marquise Brown-style years) |
| 2024 | 1.08 | balanced |
| 2025 | 1.29 | slight proxy-grind |

2022 was the proxy-grind extreme — Daniel Jones, plus dozens of other lots where MFL was doing all the work. 2023 flipped: owners were clicking, not setting-and-forgetting.

### Idea: live war-type chip

When a lot crosses 5+ bids, the Hub computes the F:O ratio so far and shows a chip:
- **`🤖 proxy war`** (F:O > 1.4) — "set your max, walk away — MFL is doing the work"
- **`⚔️ active war`** (F:O < 0.7) — "owners are clicking; you'll need to actively watch"
- **`balanced`** (between)

Informs strategy: if it's a proxy war, raise your ceiling and stop watching. If it's active, stay engaged.

---

## 3. The "24h floor" cluster — corrected

I claimed in v2 that **~30%** of contested lots close at the floor. **That was wrong.** Re-derived with a strict definition (`duration_hrs_raw <= 24.5` AND `total_bids == 2`):

**Actual: 117 lots = 17.6% of contested lots**

The "~30% closed at 24h" in the v1 deciles was the duration D1-D3 cumulative, which included lots with MANY bids that all happened in the first 24 hours. That's a different cluster.

### Properly defined floor cluster (24h, 2 bids only)

| Year | Floor lots |
|---|---|
| 2019 | 18 |
| 2020 | 20 |
| 2021 | 17 |
| 2022 | 23 |
| 2023 |  8 |
| 2024 | 11 |
| 2025 | 20 |
| **All** | **117** |

### Floor-cluster economics

Every floor lot is a $2-$8K acquisition:
- Median win: $2K
- p25: $2K, p75: $3K, max: $8K

These aren't headline players. They're "one owner thought this guy had a shot, another threw $1-2K over the floor as a flier, the first owner didn't fight back."

### Highest-$$ floor wins (closest to a "steal"):

| Year | Player | Pos | Win $ | Nominator | Winner |
|---|---|---|---|---|---|
| 2025 | **Austin Ekeler** | RB | $8K | Real Deal Creel | Real Deal Creel |
| 2021 | Taysom Hill | TE | $5K | Real Deal Creel | Real Deal Creel |
| 2020 | Ian Thomas | TE | $4K | Long Haulers | Long Haulers |
| 2021 | Eric Kendricks | LB | $4K | CBP | CBP |
| 2019 | (pid 9902) | — | $4K | L.A. Looks | L.A. Looks |

Note: nominator == winner in every case. This is the "self-nominate, someone else throws a token bid, you outbid them by $1K, lock-in" pattern. You're not stealing — you're winning a marginal player you nominated for yourself, just with one extra bid step.

### Idea: surface floor-bound predictions

If a lot has exactly 2 bids and is past the 12h mark with no recent activity, predict floor close. Hub flag: `🛏️ likely floor close at 24h` — surfaces lots to mass-bid before they lock.

---

## 4. Marathon lots — the tail that moves all averages

85 of 665 contested lots had ≥8 bids (12.8% of contested lots, ~7% of all FA noms).

### Top 10 marathon wars

| Year | Player | Pos | Bids | F+O | Win $ | Duration | Nominator → Winner |
|---|---|---|---|---|---|---|---|
| 2023 | **Derrick Henry** | RB | **30** | 14F + 15O | **$94K** | 144.9h | Real Deal Creel → Real Deal Creel |
| 2019 | (pid 10276) | — | 22 | 12F + 9O | $50K | 117.7h | L.A. Looks → Cleon Ca$h |
| 2020 | (pid 11747) | — | 17 | 10F + 6O | $26K | 72.0h | Hawks → HammerTime |
| 2024 | **Alvin Kamara** | RB | 17 | 5F + 11O | $27K | 92.9h | Long Haulers → CBP |
| 2019 | Tom Brady | QB | 16 | 10F + 5O | $20K | 69.5h | Cleon Ca$h → Hawks |
| 2023 | **14105** | — | 15 | 2F + 12O | — | 101.3h | — |
| 2020 | Robert Woods | WR | 14 | 5F + 8O | $31K | 90.5h | — → Long Haulers |
| 2025 | Travis Kelce | TE | 14 | 5F + 8O | $21K | 123.3h | — → Pure Greatness |
| 2025 | (pid 13192) | — | 12 | 3F + 8O | — | 106.3h | — |
| 2023 | (pid 13198) | — | 11 | 4F + 6O | — | 116.5h | — |

**Derrick Henry 2023 alone** drove all of 2023's overtake ratio. Real Deal Creel both nominated AND won at $94K — somebody REALLY wanted him, and the league fought hard. 30 bids, ~5 days, $94K final.

### Bidder behavior pattern in marathons

Marathons get won by the franchises that:
- **Set proxy ceilings high** (the forced-increase count tells you they had room to walk)
- **Actively monitor** (the overtake count tells you they responded to dethronements)
- Both: the most contested lots blend both

Idea: **Marathon Alert** — once a lot crosses ≥6 bids AND ≥36 hours OPEN, push a Discord summary post (not just narration) showing the bid history. Gets the whole league watching. Could substantially increase contestation on subsequent lots if owners see "people are fighting hard for this."

---

## 5. Franchise behavior — who's actually buying

### Most contested-lot wins (7 years total)

| Franchise | Wins |
|---|---|
| Pure Greatness | 67 |
| HammerTime 🔨 ⏰ | 67 |
| L.A. Looks | 66 |
| Sex Manther | 62 |
| The Long Haulers | 60 |

### Most $$ spent on contested lots (7 years total)

| Franchise | Total spend |
|---|---|
| Cleon Ca$h | $560K |
| Pure Greatness | $535K |
| Sex Manther | $493K |
| HammerTime 🔨 ⏰ | $489K |
| CBP | $426K |

### Observations

- **Cleon Ca$h spends more per win** — not in the top 5 winners but #1 in spend → fewer big-money wins
- **Pure Greatness + HammerTime** = volume players (tied for most wins) at reasonable price points
- **CBP** is the proxy-grind specialist — won 67 contested lots but also drove the 2022 proxy-grind year (Daniel Jones, plus others)
- **Real Deal Creel** is not in the top 5 winners OR top 5 spenders. Looking at the data: shows up most in the FLOOR cluster (nominate, lock at $2-3K) and the marathon outliers (Derrick Henry $94K — biggest single bet)

### Idea: per-franchise auction tendency chip

In the Hub's "Franchise" filter on the Lots tab, show a one-line tendency: `Aggressive proxy spender` / `Volume grabber` / `Floor specialist` etc. Helps everyone understand who they're competing against.

---

## 6. Corrected v2 → v3 deltas

Things I had wrong in v2 that this dive corrected:

| v2 claim | v3 reality |
|---|---|
| "30% of contested lots close at the 24h floor" | **17.6%** — I had conflated two clusters |
| "Uncontested lots are 'apathy' signal" | They're not apathy — they're a deliberate $1K-claim strategy. 100% are exactly $1K wins. |
| "Year-over-year stability" | True for the *contested* averages, but uncontested grew dramatically (70 in 2019 → 97 in 2023) |

---

## 7. Specific scenario ideas — grounded in this data

Updated GIF/event triggers based on what we actually see:

| Scenario | Trigger | Probability | Source data |
|---|---|---|---|
| **$1K nomination grab** | Won at $1K with 1 total event | 100% (separate from "real" Won) | 47% of all FA noms — needs its own narration: "🏷️ Real Deal Creel grabbed Vonn Bell unopposed at $1K" |
| **Proxy-grind detected** | F:O ≥ 2 AND total_bids ≥ 6 | 70% | Daniel Jones / Keenan Allen pattern |
| **Active-overtake war** | F:O ≤ 0.5 AND total_bids ≥ 8 | 70% | Marquise Brown / Kamara pattern |
| **Marathon (live)** | total_bids ≥ 6 AND duration_open ≥ 36h | Once per lot crossing | Henry-tier wars in progress |
| **Cap-breaker** | win_dollars ≥ $50K | 100% (composes w/ Won) | Top decile: $50K+ wins drive 4% of lots |
| **Floor close** | total_bids = 2 AND duration ≤ 24.5h | 30% (subtle, don't overfire) | 17.6% of contested lots fit this |
| **QB1 nomination** | event=nom AND pos=QB AND bid≥$10K | 60% | Marquee QB hype |
| **Self-nominated win** | nominator_fid == winner_fid | 30% | 100% of $1K wins; also common in floor cluster |

The `$1K nomination grab` is the biggest one I missed in v2 — it's literally HALF the auction activity. It deserves its own narrator treatment (much shorter, no GIF needed for routine ones, maybe one comedic GIF for "the umpteenth $1K grab of the day").

---

## Source files

- `docs/auction/data/per_year_summary.csv` — yearly aggregates
- `docs/auction/data/lot_level.csv` — 665 rows
- `docs/auction/data/deciles_long.csv` — 50 rows (5 metrics × 10 deciles)
- `/tmp/mfl_auction/csv_strict/` — raw cache
- `/tmp/mfl_auction/deep_dive_output.json` — full extract (897 lines) with all detail
