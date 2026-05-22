# Auction Discord Narrator — GIF Matrix

**Updated:** 2026-05-20 (commits `ec620d7`, `a671cb8`, `638c419`)
**Source:** `worker/src/index.js` → `narrateAuctionEvents` + `pickAuctionGifForPlayer`

## Cadence — when GIFs fire

The auction-poll cron runs every 5 minutes. On each tick:

1. Ingests new MFL `AUCTION_INIT` / `AUCTION_BID` / `AUCTION_WON` transactions
2. Classifies each event as Nom / Forced Increase / Overtake / Won
3. Posts to Discord (channel or thread, per the thread-routing rules in commit `4584bff`)
4. **Every event kind gets a GIF attempt** (per Keith 2026-05-20 — "Forced bids should be almost like eye roles and other like come on man")

Filters that suppress GIF lookup:
- `GIPHY_API_KEY` missing
- Event predates the 1-hour lookback window (first-deploy catch-up safety)
- `AUCTION_DISCORD_NARRATOR=0` (kill switch — disables the whole narrator)

Posts are throttled 250ms apart inside `narrateAuctionEvents` regardless of GIF presence.

## Per-event matrix

| Event | Discord text | GIF query order | Last-name match required? | Fallback to generic? | Discord rendering |
|---|---|---|---|---|---|
| 🆕 **Nom** | `**Team** **nominated** **Player** (POS · TEAM) — opening at **$1K**` | 1. `{Name} touchdown`<br>2. `{Name} hype`<br>3. `{Name} nfl` | **Yes** | **No** — skip if no name match (commish rule: no GIF beats wrong-player) | Image embed (no URL text) |
| ⬆ **Forced Increase**<br><small>(same fid as prior bid — MFL walked the leader's hidden proxy)</small> | `**Team** **Forced Increase** to **$X K** on **Player** (POS · TEAM)` | 1. `{Name} ugh`<br>2. `{Name} angry`<br>3. `eye roll reaction`<br>4. `facepalm reaction`<br>5. `sigh reaction`<br>6. `ugh` | **No** (player-name queries try first, generic reactions allowed as fallback) | **Yes** — generic reactions are the point ("annoyed at getting walked up") | Image embed |
| 💰 **Overtake**<br><small>(different fid from prior bid — new franchise dethroned)</small> | `**Team** **Overtake** at **$X K** on **Player** (POS · TEAM)` | 1. `{Name} reaction`<br>2. `come on man reaction`<br>3. `are you kidding me`<br>4. `really reaction`<br>5. `stop it reaction` | **No** (player query first, generic OK) | **Yes** — "you took MY player" energy | Image embed |
| 🏆 **Won** | `**Team** **won** **Player** (POS · TEAM) for **$X K**` | 1. `{Name} celebration`<br>2. `{Name} touchdown`<br>3. `{Name} nfl` | **Yes** | **No** — skip if no name match | Image embed |

## Query mechanics

For each event:

1. Build query list per the matrix above
2. For each query in order:
   a. Hit `https://api.giphy.com/v1/gifs/search` with `limit=25`, `lang=en`, cached 600s at the CF edge
   b. Filter results by the strictness rule:
      - **Strict (Nom + Won)**: result's `title` OR `slug` must include the player's last name (lowercased)
      - **Loose (Forced + Overtake)**: player-name queries still require last-name match; generic-reaction queries accept any result
   c. If any result survives the filter, pick a random one and return its image URL
3. Return empty string if all queries strike out (no GIF attached)

Image URL preference (first non-empty wins):
1. `images.original.url`
2. `images.downsized_large.url`
3. `images.fixed_height.url`
4. `url`

## Discord rendering

- **`content`** field carries text only (no raw URL in the message body)
- **`embeds`** field carries the GIF as `[{ image: { url: gifUrl } }]`
- Discord renders the image without the URL appearing as text
- Switched from content-appended URL in commit `638c419`

## Volume + throttling

Estimated event load during a live FA Auction:
- ~12 franchises × 2 nominations/24h × 6-day window ≈ **~144 nominations** (each gets a GIF)
- Bid wars: variable; high-traffic lots can see 10–20 forced/overtake events. With GIFs on every event, this is loud.

Throttling levers we can pull if it gets too noisy (none active today):
- Bid-threshold gate (e.g., GIF only when bid jump ≥ $5K)
- Random sampling (e.g., 30% of forced/overtake get GIFs)
- Per-lot cap (e.g., max 5 GIFs per lot lifetime)

## Quick changes worth knowing

If you want to:

| Change | Where | Effort |
|---|---|---|
| Disable all GIFs | Set env `GIPHY_API_KEY=""` (or unset) | trivial |
| Disable narrator entirely | Set env `AUCTION_DISCORD_NARRATOR=0` | trivial |
| Route to test channel | `AUCTION_DISCORD_USE_TEST=1` + `DISCORD_AUCTION_TEST_CHANNEL_ID` | trivial |
| Add a new event kind's vibe | Edit `pickAuctionGifForPlayer` in `worker/src/index.js` — add a branch to the per-kind `queries` / `strictLastNameMatch` block | ~5 lines |
| Tighten Nom/Won to FULL-name match | Add a `firstName + lastName` check in the strict branch | ~5 lines |
| Loosen Nom/Won to allow generic fallback | Flip `strictLastNameMatch = false` for those branches | 1 line |
| Add bid-threshold gate | Wrap the `wantGif` boolean with `&& ev.bid_k >= 5` (or similar) | 1 line |

## Cross-references

- Commit `ec620d7` — added GIFs for Nom + Won
- Commit `a671cb8` — added GIFs for Forced + Overtake (vibe queries)
- Commit `638c419` — switched to `embeds.image.url` (no URL text in message body)
- Commit `4584bff` — added per-lot threads (migration 0051); GIFs now post into the lot's thread, not the parent channel, for non-Nom events
- `docs/mfl_native/league_settings_automation_plan.md` — related TODO for automating MFL setting changes (separate scope)
