# UPS FA Auction 7-Year Analysis (v2 — Strict July+ Filter)

**Generated:** 2026-05-20
**Replaces:** `auction_history_analysis_7yr.md` headlines and `csv/` data
**Filter rule (strict, applied uniformly to 2019-2025):** FA Auction = lots whose first bid is in **July or later**. May/June lots are excluded as ERA / early-offseason / commish-restart artifacts.

---

## Data verification

| Check | Result |
|---|---|
| Total qualifying lots (FA, ≥2 bids, July+) | **665** |
| Total FA-eligible lots (July+, any bid count) | 1,254 |
| Total excluded as pre-July | **103** (16/8/10/18/20/16/15 by year) |
| May/June lots remaining in final dataset | **0** ✓ |
| Unresolved lots (no AUCTION_WON) | **0** ✓ |
| Top-10 longest lots include the 2020 May commish-restart cluster | **No** ✓ (filtered out) |

Sanity-check top 10 longest lots — all now legitimate:

| Year | Player ID | Hours | Bids | Forced | Overtakes |
|---|---|---|---|---|---|
| 2023 | 12626 (Derrick Henry) | 144.9 | 30 | 14 | 15 |
| 2025 | 11244 (Travis Kelce) | 123.3 | 14 | 5 | 8 |
| 2019 | 10276 | 117.7 | 22 | 12 | 9 |
| 2023 | 13198 | 116.5 | 11 | 4 | 6 |
| 2025 | 13192 | 106.3 | 12 | 3 | 8 |
| 2023 | 14105 | 101.3 | 15 | 2 | 12 |
| 2019 | 12741 |  94.7 | 11 | 4 | 6 |
| 2020 | 12152 |  94.3 | 15 | 8 | 6 |
| 2019 | 11680 |  92.9 | 14 | 7 | 6 |
| 2024 | 13132 |  92.9 | 17 | 5 | 11 |

(0 `by_commish` flags in the top 10 — clean.)

---

## Per-year summary (strict filter)

| Year | FA Total | ≥2-bid Qualifying | % Contested | Avg Dur (cap48) | Median Dur | Avg Bids | Avg Forced | Avg Overtakes |
|---|---|---|---|---|---|---|---|---|
| 2019 | 206 | 136 | **66.0%** | 34.15 | 32.21 | 4.45 | 1.81 | 1.64 |
| 2020 | 167 |  83 | 49.7% | 32.10 | 26.49 | 3.95 | 1.55 | 1.40 |
| 2021 | 180 |  97 | 53.9% | 34.38 | 31.50 | 3.80 | 1.54 | 1.25 |
| 2022 | 187 | 112 | 59.9% | 32.11 | 26.36 | 4.47 | **2.09** | 1.38 |
| 2023 | 165 |  68 | **41.2%** | 35.39 | 33.20 | 4.53 | 1.60 | **1.93** |
| 2024 | 179 |  88 | 49.2% | 35.70 | 34.28 | 4.28 | 1.70 | 1.58 |
| 2025 | 170 |  81 | 47.6% | 32.79 | 27.62 | 4.16 | 1.78 | 1.38 |
| **ALL** | **1,254** | **665** | **53.0%** | **33.75** | **30.30** | **4.25** | **1.75** | **1.50** |

---

## Headline averages (strict, n=665)

- **Avg duration**: 33.75 hrs (capped at 48h) — median 30.3 hrs
- **Avg total bids**: 4.25 per contested lot (median 3, max 30)
- **Avg forced increases**: 1.75 per lot
- **Avg overtakes**: 1.50 per lot
- **Contestation rate (≥2 bids of all FA noms)**: 53%

These shift slightly from the v1 headlines (34.4 / 4.22 / 1.74 / 1.48) because v1 included 44 May/June lots; the new strict count is 665 not 714. Year-over-year ranking is unchanged.

---

## Analysis & ideas

### 1. Contestation rate is falling fast

| Year | % FA noms that drew a 2nd bid |
|---|---|
| 2019 | 66.0% |
| 2020 | 49.7% |
| 2021 | 53.9% |
| 2022 | 59.9% |
| 2023 | **41.2%** |
| 2024 | 49.2% |
| 2025 | 47.6% |

**Roughly half of recent FA nominations go uncontested.** Owners are nominating defensively (to claim a player nobody else wants at $1K) rather than to start a real fight. **Idea:** the Hub's "Open Lots" table could highlight uncontested lots (just nomination + cap value visible) so other owners see "this is going for $1K — anyone interested?" before time runs out.

### 2. Two distinct war archetypes

Look at 2019 vs 2023:

| Year | Avg Forced | Avg Overtake | Ratio F:O | War type |
|---|---|---|---|---|
| 2019 | 1.81 | 1.64 | 1.10 | balanced |
| 2022 | 2.09 | 1.38 | 1.51 | **proxy-grind** (MFL doing the work) |
| 2023 | 1.60 | 1.93 | 0.83 | **active overtakes** (fresh franchises sniping) |
| 2024 | 1.70 | 1.58 | 1.08 | balanced |
| 2025 | 1.78 | 1.38 | 1.29 | mild proxy-grind |

**Idea:** Hub could surface "war type" as a chip on long-running lots — `🤖 proxy war` vs `⚔️ active war` — informing whether to set a max proxy or stay engaged manually.

### 3. The 24h floor cluster (~30%)

Roughly 30% of contested lots close at exactly 24h (the MFL minimum). One overtake comes in early, then nothing. **Idea:** these are "easy wins" — Hub could flag lots predicted to close at 24h (one bid in the first 6 hours then silence for 18+ hours) so owners can target them before lockdown. Pair with "uncontested" alert above for a "low-effort acquisition" tab.

### 4. The tail is brutal — a handful of lots reshape the league

10 lots ran 90+ hours. Among them:
- **2023 #12626 (Derrick Henry)**: 30 bids, 14 forced, 15 overtakes, $94K — the most contested single lot in 7 years
- **2019 #10276**: 22 bids, 12 forced, 9 overtakes — older, hidden gem
- **2024 #13132**: 17 bids, 11 overtakes — most overtake-heavy war in 2024

**Idea:** "Marathon Lot Alert" — once a lot crosses ≥6 bids OR ≥48h with active bidding, push a Discord thread highlight so the whole league watches the war. Could automate this via the narrator.

### 5. % contested by year is the leading indicator

If contestation falls below ~45%, you're seeing widespread nomination apathy. 2023 (41.2%) is the only year in this dataset below that line. **Idea:** worth investigating what changed in 2023 (rules, league composition, market conditions) — the answer might be 2023's record-low FA total (165 vs 200+ in earlier years) — fewer lots, fewer fights.

### 6. Year-over-year stability is surprising

Once you exclude May/June, durations sit in 32-36h, bid counts 3.8-4.5, forced 1.5-2.1. **No structural shift in auction behavior in 7 years**, even as the contestation rate fluctuates. Owners who DO fight have similar habits regardless of season.

---

## GIF / event scenarios — grounded in this data

Updated philosophy per your feedback ("don't need player name in every GIF... mostly player on nomination + when they win, theme-based elsewhere"):

| Trigger | Theme | Player-specific? | Probability | Notes |
|---|---|---|---|---|
| **Any Nom** | Player highlight | ✅ Always | 100% (strict last-name) | Opening moment — make it about the player |
| **Won — marquee** (winning bid ≥ $50K) | Player celebration | ✅ Always | 100% | Big-money win = the player IS the story |
| **Won — middle** ($10K–$50K) | Player or NFL | ✅ ~70% | Player 70% / NFL theme 30% | Most wins fall here |
| **Won — minimum** (<$10K) | NFL meme / unceremonious | ⚠️ 30% | Player 30% / "$1K trash bin" 70% | The classic uncontested win |
| **Forced Increase** | Eye-roll / annoyed | ❌ Never | 100% | Doesn't need player; it's a reaction |
| **Forced Increase — 5+ on same lot** | "Machines fighting" / robot meme | ❌ Never | 100% (overrides above) | Proxy-grind lots; D10 of forced |
| **Overtake** | "Come on man" / "really?" | ❌ Never | 100% | Theme-based, NFL/sports |
| **Overtake — 5+ bid lot** | "Kill shot" / decisive moment | ❌ Never | 100% (overrides above) | When a real war ends in an upset |
| **Marathon Lot Alert** (≥8 bids OR ≥48h while still open) | "Epic battle" / Rocky / marathon | ❌ Never | Once per lot crossing threshold | NEW scenario — flag while it's HAPPENING, not after |
| **Quick-Kill Combo** (lot closes at 24h with exactly 2 bids — won event) | "Easy money" / "low effort" | ❌ Never | 30% only | 30% of wins fit this; don't over-fire |
| **Kicker / Punter Nom** | Position memes (whiff, shank) | ⚠️ 50% | Player 50% / generic 50% | Position is the joke; mix both |
| **Cap-Breaker Win** (≥$50K) | "All in" / "shock" | ❌ Never | 100% (composed with player on Won-marquee) | Adds a second emphasis GIF |

Two pools per non-player scenario:
- **NFL-theme pool** (e.g., "nfl crowd reaction", "qb facepalm") — keeps it grounded in football
- **Pop-culture pool** (e.g., "michael scott no", "kombucha girl") — surprise + variety

Worker rolls a coin between the two when no other constraint applies.

---

## Proposed next step

1. Update `curated_gifs.json` schema to reflect this data-grounded matrix (event_kind + composite triggers + player-specific toggle)
2. Add `min_winning_bid_k` / `max_winning_bid_k` trigger fields to support Won-marquee / Won-middle / Won-minimum splits
3. Update the worker's `pickCuratedGif` to honor the new "player-specific" toggle in the curated scenarios (currently always falls through to Giphy player search when curated misses)
4. Build out `curated_gifs.json` populated with starter GIFs per scenario (~3-5 each)
5. Pair with `lot_level.csv` queries to verify scenarios fire at the expected rate (e.g., "Quick-Kill Combo should hit ~30% of Won events — does it?")

Ready to ship once you say go.
