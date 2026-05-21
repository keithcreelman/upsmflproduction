# Curated GIF Library — v3 (Story-Driven Pools)

**Manifest:** `site/auction/curated_gifs.json`
**Worker:** `pickCuratedScenario` + `pickFromPool` in `worker/src/index.js`

v3 rebuilds the pools around the actual stories Keith wants told in the auction channel, not generic emotion buckets. Pools are now tied to behaviors (routine forced increase, late overtake, takeback, day-2 extender) and franchise rivalries (Hawks mocking, HammerTime vs Real Deal Creel, Long Haulers vs Sex Manther). Generic catch-all pools (`shrug`/`come_on_man`/`eye_roll`) are gone — if no story fires, we fall through to Giphy.

---

## The pools

### Behavioral story pools

| Pool | Trigger | Rate | What to populate |
|---|---|---|---|
| `routine_forced` | $2-4K forced increase (cap-free zone) | **35%** | Casual / dismissive (Keith's framework — "the most common event in the channel; don't over-celebrate") |
| `high_tension` | 3+ bids in last 30min OR same fid forces 4+ in a row OR forced in final 60min | 50-70% | Building anticipation, "uh oh things are heating up" |
| `late_overtake` | Overtake in final 60min before lot locks | 70% | "You wait until now?" energy |
| `takeback` | Actor previously held the lead, lost it, now reclaiming | 80% | **"I'm back" GIFs specifically.** Keith called this out as distinct from late_overtake — takeback gets its own line. |
| `day_2_extender` | Lot duration ≥ 48hr and still bidding | 60% | "This lot has legs" — Day 2+ tension |
| `random_spice` | Any non-nom/won event | 5% | One-off weirdness; keeps the feed from feeling deterministic |

### Franchise-specific pools

| Pool | Trigger | Rate | Visual direction |
|---|---|---|---|
| `hawks_mock` | F0012 (Hawks) nominates OR wins | 35% | Mock the perennial Hawktuah Bowl participant |
| `hammertime_vs_creel_trey_mcbride` | F0005 (HammerTime/Eric Martel) forced increase against F0008 (Real Deal Creel) | 100% | **Trey McBride GIFs** |
| `longhaulers_vs_martel_rashee_rice` | F0006 (Long Haulers) overtakes OR significant force (≥$5K) on F0007 (Sex Manther/Josh Martel) | 100% | **Rashee Rice GIFs** |
| `longhaulers_late_expensive` | More specific: F0006 late + expensive (≥$10K) overtake on F0007 | 100% | **Home Alone GIFs** — more dramatic visual for the bigger moment |

### Dollar-tier wins (kept from v2)

| Pool | Trigger | What |
|---|---|---|
| `shock` | $30-49K win | Marquee — full-on shock |
| `all_time` | $50-59K win (and $60K+ as primary) | Headline tier |
| `legendary` | $60K+ win (composite OVERLAY on `all_time`) | "Stop the presses" — 4 lots per 7yr |
| `respect` | Top-10% for position, any $ | Rare-for-position, nod-of-approval |
| `self_nom_marquee` | Self-nominated win ≥$10K | Called-shot — "I told you so" |
| `k_meme` / `pn_meme` | K/PK or PN nomination | Universal kicker/punter comedy |

---

## Franchise ID map (UPS league 74598)

| ID | Team | Owner |
|---|---|---|
| 0001 | L.A. Looks | |
| 0002 | CBP | |
| 0003 | Gride | |
| 0004 | Pure Greatness | |
| 0005 | HammerTime | Eric Martel |
| 0006 | The Long Haulers | Brian Cross |
| 0007 | Sex Manther | Josh Martel (treasurer) |
| 0008 | Real Deal Creel | |
| 0009 | C-Town Chivalry | |
| 0010 | Blake Bombers | Shawn Blake |
| 0011 | Cleon Ca$h | Keith Creelman |
| 0012 | Hawks | |

The manifest's `_franchise_map` block is display-only — the worker reads fids from D1, not JSON.

---

## New trigger fields (v3)

These extend v2's trigger vocabulary:

| Field | Semantics |
|---|---|
| `actor_franchise_id` | 4-digit fid; the franchise INITIATING this event (winner / forcer / overtaker / nominator) |
| `target_franchise_id` | The franchise on the receiving end. For overtakes = prior leader. For forced_increase = the franchise whose bid triggered the actor's proxy walk (most recent non-actor bid in history). |
| `is_takeback: true` | Actor previously held the lead on this lot, was passed, is now reclaiming. Detected via bid history scan. |
| `is_late_in_lot: true` | `minutes_to_close ≤ time_to_close_max_minutes` (default 60). Uses `locks_at_unix - now`. |
| `time_to_close_max_minutes` | Override the 60-min default for `is_late_in_lot` |
| `extends_past_day_2: true` | `duration_hours ≥ 48` |
| `min_same_fid_consecutive` | Trailing N bids on this lot all from `actor_fid` |
| `min_bids_in_30min` | At least N non-nom bids in the 30-min window ending at this event |
| `_event_kind_one_of` | Array of event_kinds (alternative to single `event_kind`); useful for "nom OR won" |

All compose with existing v2 fields (`min_win_k`, `position`, `min_position_percentile`, `self_nominated`, etc).

---

## Scenario evaluation order

Top-down; first match wins. Order matters — specific pair triggers run BEFORE generic dollar-tier triggers so a Long-Haulers-vs-Martel Rashee Rice GIF can land on a $50K overtake before `won_headline` (no — pair triggers are on overtake/forced; wins still go through dollar tiers).

Current order:

1. **Franchise-pair triggers** (Long Haulers ↔ Martel; HammerTime ↔ Creel) — highest priority, 100% rate
2. **Won-tier scenarios** (all_time / headline / marquee / position_rare / self_nom_marquee)
3. **Hawks mock** (nom OR won, 35%)
4. **Takeback overtake** (80%)
5. **Late overtake** (70%)
6. **Day-2+ extender** (forced/overtake on long-running lot, 60%)
7. **High-tension burst** (same-fid streak / 30-min burst / late forced, 50-70%)
8. **Routine forced cap-free** ($2-4K forced, 35%) — Keith's signature rate
9. **K/PK/PN nominations** (kicker/punter comedy, 100%)
10. **Random spice** (5%)

---

## Status: most pools empty (TODOs)

After Keith's pushback on v2's generic pools, v3 ships the SCHEMA + WORKER LOGIC but most pools are empty pending real GIF URLs:

- `routine_forced` — needs Keith's 5 URLs + 5 more for rotation
- `high_tension` — needs Keith's 4 URLs + 2-3 more
- `late_overtake` — needs Keith's URLs
- `takeback` — needs Keith's "I'm back" URLs specifically
- `day_2_extender` — needs Keith's 2 URLs + 2-3 more
- `hawks_mock` — needs Keith's 5 URLs
- `longhaulers_vs_martel_rashee_rice` — needs Rashee Rice GIFs
- `longhaulers_late_expensive` — needs Home Alone GIFs
- `hammertime_vs_creel_trey_mcbride` — needs Trey McBride GIFs

Empty pools fall through to the next scenario, and ultimately to Giphy fallback, so the feed degrades gracefully — but the stories Keith wants won't land until pools are populated.

---

## Position percentiles

Worker uses hardcoded `POS_P90` constants from `docs/auction/data/position_thresholds.csv`:

```
QB:38  RB:23  WR:32  TE:21
LB:5   S:4    CB:4   DB:4
DT:6   DE:8   DL:8
PK:3   K:3    PN:3   P:3
```

A trigger with `min_position_percentile: 90` matches when `win_k >= POS_P90[position]`. Update annually after each season.

---

## Adding GIFs to a pool

1. Find a stable `.gif` URL. Giphy: copy the `media.giphy.com/.../giphy.gif` form, NOT the `giphy.com/gifs/...` browser URL.
2. Edit `site/auction/curated_gifs.json`:
   ```json
   "pools": {
     "routine_forced": {
       "gifs": [
         { "url": "https://media.giphy.com/media/.../giphy.gif", "label": "casual shrug" },
         { "url": "https://...", "label": "sure why not", "weight": 2 }
       ]
     }
   }
   ```
3. Commit + push. Worker picks up within ~60s (manifest cached at edge + worker memory).

`weight` biases random selection — default 1; higher = more likely.

---

## Rotation mechanics

`POOL_LAST_USED` is a `Map<pool_id, [last_3_urls]>` in worker module scope. On every pool pick:
1. Filter pool to GIFs NOT in `last_3` for that pool
2. If filter drains the pool to 0 (pool < 4 GIFs), use all gifs
3. Weighted-random pick from eligible
4. Prepend chosen URL to `last_3`, trim to 3

Resets on worker cold-start (~hourly under typical load).

---

## Source data + canon refs

- `docs/auction/analysis_v5_canon_aware.md` — the analysis justifying thresholds
- `docs/auction/data/position_thresholds.csv` — per-position p50/p75/p90/p95/max
- `docs/auction/data/zone_by_year.csv` — cap-free/low/mid/marquee distribution
- `docs/auction/data/lot_level_clean.csv` — 663 rows; query to test scenario fire rates
- `docs/league_context_v1.md §D2` — the cap-free penalty rule that makes $4K the magnet
- `docs/league_context_v1.md §C` — owner / franchise canon (incl. F0005 HammerTime, F0007 Sex Manther = Josh Martel)
