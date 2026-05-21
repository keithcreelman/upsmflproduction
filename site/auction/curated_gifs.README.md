# Curated GIF Library — Discord Auction Narrator

**Manifest:** `site/auction/curated_gifs.json`

Hand-picked GIFs that override the default per-event Giphy search for
specific high-signal scenarios. Each scenario has a trigger (when it
qualifies), a probability (how often to use a curated GIF when it
qualifies), and a pool of GIFs (random pick, weight-aware).

## How it works at runtime

The auction narrator (`worker/src/index.js` → `pickAuctionGifForPlayer`)
evaluates scenarios in order, top to bottom in the manifest:

1. For each scenario, check if the event matches its `trigger` fields.
2. If matched, roll a random number 0–99. If < `probability_pct`, this
   scenario wins.
3. From the winning scenario's `gifs` array, pick a random one
   (weighted by `weight` if set; default weight 1).
4. If no scenario wins, fall back to the existing per-event Giphy
   search (Nom + Won are strict last-name match; Forced + Overtake
   allow generic reaction fallbacks).

## Trigger fields

All must match for the scenario to qualify:

| Field | Type | Description |
|---|---|---|
| `event_kind` | `"nom" \| "forced_increase" \| "overtake" \| "won"` | Which observer-kind triggered the post |
| `min_total_bids` | integer | Lot has at least this many bids (cumulative) |
| `max_total_bids` | integer | Lot has at most this many bids |
| `min_forced` | integer | Lot has at least this many forced increases |
| `min_overtakes` | integer | Lot has at least this many overtakes |
| `position` | `"QB" \| "RB" \| ...` | Player's primary position |
| `min_bid_k` | integer | Current bid is at least $XK |
| `by_commish` | boolean | This event was posted by the commish |

Omit a field to leave it unconstrained.

## Scenario design rules of thumb

Calibrated from the 7-year analysis (`docs/auction/auction_history_analysis_7yr.md`):

| Scenario type | Trigger heuristic | Why |
|---|---|---|
| Bidding-war hype | `min_total_bids: 10` | Top decile of contested lots (avg 11.4 bids) |
| Proxy-grind reaction | `min_forced: 4` | D10 of forced (mean 6.4) |
| Decisive overtake | `event_kind: overtake, min_total_bids: 5` | Kill shot on a real fight |
| Quick close | `event_kind: won, max_total_bids: 2` | 30% of contested lots close at the 24h floor with just 2 bids |
| Position-specific | `position: K`, `position: PN`, etc. | Position memes (kickers/punters are inherent comedy) |
| Marquee nominations | `event_kind: nom, position: QB, min_bid_k: 10` | Opening big at a high price = headline moment |
| Commish intervention | `by_commish: true` | 18 lots in 7 years had these — always worth flagging |

## How to add GIFs

1. Find a GIF you want to use. Sources:
   - https://giphy.com (just grab the URL of the `original` GIF file, ends in `.gif`)
   - https://tenor.com (right-click → Copy GIF address)
   - Self-hosted (e.g., `https://www.mflscripts.com/...gif` if you already have UPS assets)
2. Edit `site/auction/curated_gifs.json`. Find the scenario, add to its `gifs` array:
   ```json
   { "url": "https://media.giphy.com/media/.../giphy.gif", "label": "Rocky training montage", "weight": 1 }
   ```
3. Commit + push. Worker picks up the change at the next `*/5` poll.

The `weight` field lets you bias toward certain GIFs:
- All weight 1 → uniform random
- One GIF weight 3, others weight 1 → 3× more likely
- Use sparingly — random surprise is the point

## Adding new scenarios

1. Edit `site/auction/curated_gifs.json`, add a new entry to `scenarios[]`
2. Pick a stable `id` (used in worker logs for traceability)
3. Define the `trigger`, `probability_pct`, and (eventually) `gifs`
4. The worker reads the manifest on every poll — no code change needed

## Tuning the probabilities

- **100** = always use this scenario's GIFs when it qualifies (zero chance of Giphy fallback)
- **30–60** = mix it in occasionally; keep the surprise factor
- **0** = scenario is muted (debugging / temp-disable without deleting)

If multiple scenarios qualify for the same event, the FIRST one in the
manifest that survives its probability roll wins. Order scenarios from
most-specific to most-generic.

## Examples Keith might want

```json
{
  "id": "kelce_won",
  "label": "Travis Kelce specifically — 2025 reference",
  "trigger": { "event_kind": "won" },
  "probability_pct": 100,
  "gifs": [
    { "url": "https://...kelce-touchdown.gif", "label": "TD celebration" },
    { "url": "https://...kelce-spike.gif", "label": "Spike", "weight": 2 }
  ]
}
```

(Player-specific scenarios would need a `player_id` trigger — easy to add when needed.)

## Operational notes

- Manifest is fetched on every `*/5` cron tick via jsDelivr at the
  active SHA (same CDN path as the rest of `site/auction/*`).
- Caching: 60s edge cache. Adding GIFs takes effect within a minute.
- Empty `gifs` arrays are safe — scenario falls through to Giphy as if
  it didn't fire.
- If the manifest fetch fails, all scenarios silently skip and
  default Giphy search runs.

## Source data

See `docs/auction/data/*.csv` for the per-lot/decile/year data that
informed these scenario triggers.
