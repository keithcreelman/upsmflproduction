# Curated GIF Library — v2 (Pool-Based with Rotation)

**Manifest:** `site/auction/curated_gifs.json`
**Worker:** `pickCuratedScenario` + `pickFromPool` + `POS_P90` in `worker/src/index.js`

This is v2. Schema changed from v1 — scenarios no longer hold `gifs` directly; they reference named **pools** by `pool_id`. The worker rotates within each pool to keep GIFs fresh.

---

## Why v2 — what changed from v1

| | v1 | v2 |
|---|---|---|
| GIF storage | inline per-scenario `gifs[]` | named `pools.<id>.gifs[]`; scenarios reference `pool_id` |
| Rotation | none — random pick each time | last-3-used per pool tracked in worker memory; same GIF can't fire 3× in a row |
| Position-aware triggers | trigger by exact `position` | also `min_position_percentile` (e.g., "top 10% for any position") |
| Composite overlays | none | `overlay_pool_id` fires a second GIF stacked on the first |
| Player-specific toggle | mixed-in via Giphy fallback | explicit `player_specific: true` or `player_specific_pct: 70` |
| Default pools | 8 scenario-tied stubs | 18 reusable pools shared across scenarios |

Pool reuse: e.g., `won_marquee` and `won_top_tier` both point at the same `shock` pool — populate once, both scenarios benefit.

---

## The 18 pools

| Pool | When it fires | What to populate (Giphy search hint) |
|---|---|---|
| `shrug` | $2-$4K cap-free win (20% fire rate) | "shrug emoji", "meh whatever", "sure why not" |
| `nice_grab` | $5-$9K solid win | "nice grab nfl", "good pick reaction", "small smile nod" |
| `ooh` | $10-$22K real-money win | "ooh reaction", "eyebrow raise", "oh nice" |
| `respect` | Top-10% for position regardless of $ | "respect reaction", "tip hat", "salute reaction" |
| `shock` | $23-$49K marquee win | "mind blown", "jaw drop", "wow no way", "holy moly" |
| `all_time` | $50-$59K headline | "goat reaction", "legendary moment", "one for the ages" |
| `legendary` | $60K+ all-time (composite overlay on top of all_time) | "breaking news", "stop everything", "this is biblical" |
| `rare_lb` | $5K+ LB | "defense celebrate", "linebacker sack", "big hit" |
| `rare_db` | $4K+ S/CB/DB | "interception", "pick six", "safety big hit" |
| `k_meme` | K nomination | "kicker miss field goal", "kicker shank", "wide right" |
| `pn_meme` | PN nomination | "punter punt", "football punter funny" |
| `eye_roll` | Forced increase default | "eye roll", "facepalm", "ugh whatever", "sigh" |
| `come_on_man` | Overtake default | "come on man", "are you kidding me", "really reaction" |
| `kill_shot` | Overtake on ≥5-bid lot — decisive | "mic drop", "walk away cool", "boom done" |
| `proxy_grind` | F:O ≥ 2 AND ≥6 bids while OPEN | "robot vs robot", "machine grind", "beep boop" |
| `active_war` | F:O ≤ 0.5 AND ≥8 bids while OPEN | "rocky training", "epic battle", "crowd erupts" |
| `floor_close` | Won at 24h with 2 bids | "too easy", "easy money", "free real estate" |
| `self_nom_marquee` | Self-nominated win ≥$10K | "babe ruth called shot", "i told you so" |

Each pool ships with `gifs: []` and a TODO comment. Populate with 6+ entries per pool for proper rotation.

---

## Scenario evaluation order

Scenarios in `curated_gifs.json` are ordered most-specific to most-generic. Worker walks the list top-down; first scenario whose trigger matches AND survives `probability_pct` wins.

Top-down ordering for Won events:

1. `won_all_time` ($60K+) — fires composite (all_time + legendary)
2. `won_headline` ($50-59K)
3. `won_marquee` ($30-49K)
4. `won_top_tier` ($23-29K)
5. `won_position_rare` (≥p90 for position, any $ — catches $10K LB)
6. `won_real_money` ($10-22K)
7. `won_solid` ($5-9K)
8. `won_routine_floor` (24h close + 2 bids)
9. `won_routine` ($2-4K)

Order matters: a $94K QB hits `won_all_time` first and never falls to the lower scenarios. A $10K LB hits `won_position_rare` before falling to `won_real_money`.

---

## Position percentiles

Worker uses hardcoded `POS_P90` constants from `docs/auction/data/position_thresholds.csv`:

```
QB:38  RB:23  WR:32  TE:21
LB:5   S:4    CB:4   DB:4
DT:6   DE:8   DL:8
PK:3   K:3    PN:3   P:3
```

Update annually after each season — re-run `docs/auction/data/v5_analysis.py` and copy `position_thresholds.csv` p90 values.

A trigger with `min_position_percentile: 90` matches when `win_k >= POS_P90[position]`.

---

## Player-specific behavior

A scenario can prefer Giphy player search over (or alongside) its pool:

| Field | Behavior |
|---|---|
| `player_specific: true` | Always try Giphy player search. If it returns a hit, that becomes the PRIMARY embed; the pool pick demotes to overlay. |
| `player_specific_pct: 70` | 70% of the time, try Giphy player search (same demote-to-overlay logic). |
| neither | Pool pick is always primary; no Giphy player search. |

This means a $94K Henry win can fire: **player celebration GIF (primary) + all_time pool GIF + legendary pool overlay** = up to 3 embed images in the same Discord post (capped at 2 by Discord's limit per message in the current worker).

---

## Adding GIFs to a pool

1. Find a stable `.gif` URL. Giphy: click the GIF → copy URL → use the `media.giphy.com/.../giphy.gif` form, NOT the `giphy.com/gifs/...` browser URL.
2. Edit `site/auction/curated_gifs.json`:
   ```json
   "pools": {
     "shock": {
       "gifs": [
         { "url": "https://media.giphy.com/media/.../giphy.gif", "label": "Wendy williams jaw drop" },
         { "url": "https://...", "label": "Stephen A choking", "weight": 2 }
       ]
     }
   }
   ```
3. Commit + push. Worker picks up within ~60s (manifest cached at edge + worker memory).

The `weight` field biases random selection — default 1; higher = more likely.

---

## Adding a new scenario

1. Edit `curated_gifs.json`, add to `scenarios[]`:
   ```json
   {
     "id": "won_rookie_explosion",
     "label": "Rookie QB nominated > $30K",
     "trigger": {
       "event_kind": "nom",
       "position": "QB",
       "min_win_k": 30
     },
     "probability_pct": 100,
     "pool_id": "shock",
     "player_specific": true
   }
   ```
2. Place it in the scenarios list ABOVE more-generic scenarios that would also match (otherwise the generic catches first).
3. Pool can be existing or new (define a new entry under `pools`).

---

## Tuning probabilities

| Value | Meaning |
|---|---|
| 100 | Always fire when trigger matches |
| 50-80 | Mix it in often, leave room for randomness |
| 20-30 | Occasional surprise — used for high-volume events (`won_routine`, `floor_close`) |
| 0 | Mute (temporary disable without deleting) |

**Don't over-fire on common events.** 60% of contested wins are $2-4K cap-free — if every one of those gets a GIF, the channel becomes noise. The `won_routine` scenario uses `probability_pct: 20` for exactly this reason.

---

## Rotation mechanics

`POOL_LAST_USED` is a `Map<pool_id, [last_3_urls]>` in worker module scope. On every pool pick:
1. Filter pool to GIFs NOT in `last_3` for that pool
2. If filter drains the pool to 0 (because pool is < 4 GIFs), use all gifs
3. Weighted-random pick from eligible
4. Prepend the chosen URL to `last_3`, trim to 3

Resets on worker cold-start (~hourly under typical load). Doesn't need to persist longer than that — Discord users don't notice repeats spaced an hour apart.

---

## Source data + canon refs

- `docs/auction/analysis_v5_canon_aware.md` — the analysis that justifies the thresholds
- `docs/auction/data/position_thresholds.csv` — per-position p50/p75/p90/p95/max (use to update `POS_P90`)
- `docs/auction/data/zone_by_year.csv` — cap-free/low/mid/marquee distribution per year
- `docs/auction/data/lot_level_clean.csv` — 663 rows; query to test scenario fire rates against history
- `docs/league_context_v1.md §D2` — the cap-free penalty rule that makes $4K the magnet
