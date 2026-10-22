# Shared external news feed: contract `ups.news.v1`

Phase 1 of #1356, revised 2026-10-22 to include MFL Player News as a real source.

This is ONE normalized feed of outside NFL and player news. League News shows all of it. The player panel shows it filtered to one player. UPS Wire may later read it for editor leads, but nothing is written or published automatically. There are no AI summaries.

- **Builder:** `worker/src/news_feed.js`.
- **Routes:** `GET /api/news-feed`, plus the legacy `GET /api/player-news` shape.
- **Tests:** `tests/news_feed.test.mjs` and `pipelines/etl/scripts/test_build_sleeper_cache.py`.

## Sources

| Source | What it is | Auth | Fields we keep and show |
|---|---|---|---|
| ProFootballRumors, ProFootballTalk, CBS Sports, Yahoo Sports | Publisher RSS, published for syndication | none | headline, publisher, time, link, category, event |
| **MFL Player News** | MFL export `TYPE=playerProfile` (see below) | none (public) | **metadata only**: MFL player id, MFL article id, provider, approximate time, category, event, link to MFL's article page. **No headline, no text.** |

**Removed sources:**
- **ESPN `site.api`:** undocumented, and returned 0 items to the Worker.
- **Reddit `r/nfl` JSON:** returns 403, and its Data API needs registration.

## MFL Player News: provenance (checked 2026-10-21 and 2026-10-22)

1. **Route.** `GET https://api.myfantasyleague.com/{YEAR}/export?TYPE=playerProfile&P={id,id,…}&JSON=1`.
   - The export is in MFL's documented API list, but the doc text mentions only DOB, ADP and height/weight. The `news` node isn't described.
   - Per player it returns `news.article[] = { id, headline, published }`: at most 3 items, about the last 7 days. On 2026-10-22 the oldest item was 6 days old.
   - A player with nothing new returns `news: {}`.
   - MFL's own pages show the same items:
     - `news_articles?L=&P=` (list);
     - `view_news_article?L=&ID=` (full text, an exact "Published Mon Oct 19 10:18:44 a.m. ET 2026 (Rotowire)", and a link to the provider's page).

   We read only the export; MFL's HTML pages are never scraped.
2. **Public or authenticated.** Public. No cookie or API key: verified for the export and for MFL's two pages. No owner session is involved.
3. **Whose content.** The provider's, named by the article id and credited on MFL's page:

   | Article id | Provider |
   |---|---|
   | `rotowire643298` | RotoWire |
   | `https…dynastyleaguefootball` | Dynasty League Football |
   | `https…FFToday` | FFToday |

   On 2026-10-22, for 479 rostered players, there were 538 items: 479 RotoWire, 42 Dynasty League Football, 17 FFToday.
4. **What we may keep and show.**
   - **Not licensed to us:**
     - MFL's developer terms: MFL "can not make third party content (such as player news) available".
     - MFL's site terms: no redistribution without FPL's written consent.
   - **Treatment:** the headline and text are therefore treated as **licensed**. The headline is read in memory only, to set `event` and `category` and to dedupe, and is then dropped. It is never returned, stored, cached by us, or put in a preview.
   - **What we show:** the provider ("RotoWire"), "via MFL", the approximate time, the category/event, and a link to MFL's article page, where MFL shows the text.
   - **Not a news item:** injury *status* stays in the shared injury resolver (MFL `injuries` export).
5. **Refresh, limits, failure.**
   - **Refresh:** items appear as RotoWire posts them. On 2026-10-22 the newest was 11 h old at 13:40 UTC (an overnight lull). None of 15 sample players gained an item between 10-21 11:34 and 10-22 13:40 UTC.
   - **Our cadence:** edge cache 30 min per 100-player chunk. That is 5 calls per refresh for 479 rostered players, ≤ 240 MFL calls a day per Cloudflare location.
   - **Rate limits:** MFL throttles unregistered clients per IP and doesn't publish numbers. Registered clients get 2.5×. Over the limit returns **HTTP 429**, and MFL says don't retry.
   - **Failure handling:**
     - A failed or 429 chunk marks MFL `error`, or `incomplete` if only some chunks failed.
     - A player MFL didn't answer for is `partial` (or `unavailable` when nothing answered), never "no recent items".
     - A body with an `error` node counts as a failure.
6. **Outside the signed-in MFL experience.**
   - **UPS servers never carry the provider's words.** The Worker, its caches, the legacy route and any public preview hold only the metadata above.
   - **Inside MFL, the owner still sees the text:**
     - The Front Office embed and the HPM modules run **in the league's own page on `*.myfantasyleague.com`**.
     - From there the owner's browser asks MFL directly: `site/shared/mfl_player_news.js` calls `TYPE=playerProfile` and attaches each headline to its `ups.news.v1` item **by MFL article id**.
     - MFL allows this. Its API echoes an MFL origin in `Access-Control-Allow-Origin` (with credentials); verified 2026-10-22 from `Origin: https://www48.myfantasyleague.com`.
     - MFL's developer page forbids API calls by JavaScript only "from web pages outside the myfantasyleague.com domain".
     - The text goes MFL → owner, on MFL's site.
   - **Off MFL** (the phone app and standalone pages on github.io):
     - MFL's API refuses the browser call (verified: other origins get another host's `Access-Control-Allow-Origin`).
     - Those screens keep metadata + **read on MFL ↗**.
     - They can also show **MFL's own page in a frame**: `news_articles?P=<pid>`, without `L=`. That's 169 KB with no league header; MFL sends no `X-Frame-Options` or CSP frame rule.
     - Inside the frame, MFL serves its own headlines and summaries, so we copy nothing.

### Permission to show provider text on UPS (searched 2026-10-22): none found

| Source | What it says |
|---|---|
| [MFL Developers Program](https://api.myfantasyleague.com/2026/api_info) | MFL "can not make third party content (such as player news) available". JavaScript API calls are forbidden only from pages outside `myfantasyleague.com`, and "calls from within league pages" are named as normal use. |
| [MFL Terms of Service](https://home.myfantasyleague.com/terms.html) | Distributing site content to third parties, "including through another website", needs "the express prior written consent of FPL"; no screen scraping |
| [MFL Acceptable Use Policy](https://home.myfantasyleague.com/use.html) | No unauthorized copying of copyrighted material. Nothing on framing or linking. |
| [MFL developer API overview](https://home.myfantasyleague.com/features/developers-api/), [RotoWire on MFL](https://home.myfantasyleague.com/rotowire.html) | RotoWire is an MFL partner. No statement that its news is offered to third-party developers. |
| [RotoWire v. Swish Analytics](https://www.rotowire.com/swish-lawsuit/) | RotoWire sues over unlicensed scraping and use of its data, so it treats its news as licensed |

RotoWire's own terms page wasn't reachable (404).

**Result:**
- Showing RotoWire / DLF / FFToday headlines or summaries **on UPS's own site** needs written permission from MFL (FPL), or a feed license from the providers.
- Showing them **inside MFL's pages**, delivered by MFL to the owner's browser, matches how MFL's API is meant to be used.
- MFL's page shows the text publicly, but that is MFL's license, not one extended to us.

## Response: League News

`GET /api/news-feed?L=74598&YEAR=2026[&limit=100][&category=injury]`

```json
{
  "contract": "ups.news.v1",
  "generated_at": "2026-10-22T13:40:17.000Z",
  "feed_state": "ok",
  "coverage": { "since_ts": 1792623000, "hours": 12.6, "mfl": "each checked player's latest MFL updates (MFL keeps about 7 days, at most 3)" },
  "sources": [
    { "id": "pfr", "publisher": "ProFootballRumors", "state": "ok", "http_status": 200, "items": 15, "oldest_ts": 1792600000, "newest_ts": 1792660000, "fetched_at": "2026-10-22T13:40:17Z", "error": "" },
    { "id": "mfl", "publisher": "MFL Player News", "state": "ok", "http_status": 200, "items": 538, "oldest_ts": 1792120000, "newest_ts": 1792630000, "fetched_at": "2026-10-22T13:40:17Z", "error": "", "players_checked": 479, "players_requested": 479 }
  ],
  "player_index": { "state": "ok", "players": 2280, "error": "", "aliases": "ok", "external_ids": "ok" },
  "cache": { "hit": false },
  "categories": ["retirement", "discipline", "injury", "transaction", "contract", "role", "performance", "other"],
  "total_items": 639,
  "items": [
    {
      "id": "n_1f86bad40302e8", "story_id": "s_1f86bad40302e8",
      "headline": "Rams place Puka Nacua on injured reserve", "headline_policy": "display",
      "publisher": "ProFootballRumors", "via": null, "source_id": "pfr", "mfl_article_id": null,
      "url": "https://www.profootballrumors.com/…",
      "published_ts": 1792669217, "published_at": "2026-10-22T11:40:17.000Z", "published_precision": "exact",
      "fetched_at": "2026-10-22T13:40:17Z", "category": "injury", "event": "ir_move",
      "players": [ { "mfl_id": "16211", "espn_id": "4426515", "rotowire_id": "16790", "name": "Puka Nacua", "team": "LAR", "position": "WR", "match": "headline", "primary": true } ],
      "also_reported_by": [
        { "id": "n_…", "publisher": "RotoWire", "via": "MFL", "url": "https://www48.myfantasyleague.com/2026/view_news_article?L=74598&ID=rotowire…", "published_ts": 1792664000, "published_precision": "hour" }
      ]
    },
    {
      "id": "n_0e2c7059059fc3", "story_id": "s_0e2c7059059fc3",
      "headline": null, "headline_policy": "read_on_mfl",
      "publisher": "RotoWire", "via": "MFL", "source_id": "mfl", "mfl_article_id": "rotowire990002",
      "url": "https://www48.myfantasyleague.com/2026/view_news_article?L=74598&ID=rotowire990002",
      "published_ts": 1792460417, "published_at": "2026-10-20T01:40:17.000Z", "published_precision": "day",
      "fetched_at": "2026-10-22T13:40:17Z", "category": "injury", "event": "designation",
      "players": [ { "mfl_id": "13635", "espn_id": "3915416", "rotowire_id": "12477", "name": "D.J. Moore", "team": "BUF", "position": "WR", "match": "mfl_id", "primary": true } ],
      "also_reported_by": []
    }
  ],
  "diagnostics": { "articles": 669, "rss_articles": 131, "mfl_articles": 538, "unique_articles": 664, "stories": 639, "unresolved_name_mentions": 0, "players_indexed": 2280 }
}
```

The example uses synthetic MFL article ids. Real MFL text is never shown, even here.

### Item fields

| Field | Meaning |
|---|---|
| `id` | Stable item id. Publisher: hash of the canonical URL. MFL: hash of `mfl:` + the article id (lower-cased). Neither the age ("5 hours" → "1 day") nor the provider's spelling changes it. |
| `story_id` | `s_` + the lead item's id |
| `headline` | Publisher headline, or **`null`** for an MFL-led story |
| `headline_policy` | `display` (publisher), or `read_on_mfl` (licensed: show provider + event + link) |
| `publisher` / `via` | Who wrote it / who it came through: `"RotoWire"` / `"MFL"`. Never relabeled. |
| `url` | Publisher article, or MFL's `view_news_article` page |
| `published_ts` / `published_precision` | `exact` for RSS. For MFL, `hour` or `day`: the midpoint of MFL's floored age ("1 day" = 24–48 h) |
| `category` | Topic: retirement, discipline, injury, transaction, contract, role, performance, other |
| `event` | What happened: `ir_move`, `ir_return`, `season_ending`, `designation`, `practice`, `starting_role`, `trade`, `signing`, `release`, `suspension`, `retirement`, `other` |
| `players[].match` | `mfl_id` (MFL filed it under this player), `tag`, `headline`, or `summary` (a summary-only mention: not primary) |
| `also_reported_by[]` | The same story from other outlets, each with its own `publisher` / `via` / link / time |

## Response: player filter

`GET /api/news-feed?L=74598&YEAR=2026&pids=14783,13635[&limit=10]` returns the header fields plus:

```json
"players": {
  "13635": {
    "mfl_id": "13635", "state": "items",
    "mfl_news_url": "https://www48.myfantasyleague.com/2026/news_articles?L=74598&P=13635",
    "coverage": { "…": "…" }, "mfl_checked": true, "unavailable_sources": [],
    "item_ids": ["n_0e2c7059059fc3"], "items": [ "…item shape above…" ]
  }
}
```

- **Every rostered player is checked with MFL.** For anyone else, the route makes one extra MFL call for those ids (cached separately).
- **MFL Player News ↗** (`mfl_news_url`) is on every player, always.

## States: an outage is never "no recent stories"

**Feed** `feed_state`:

| State | Meaning | HTTP |
|---|---|---|
| `ok` | All 5 sources answered | 200 |
| `partial` | At least one source answered and at least one didn't | 200 |
| `unavailable` | Nothing answered | **503** (the body still carries the contract) |

**Source** `state`:
- `ok`
- `error`
- `empty`: an RSS feed with 0 items, or MFL with 0 items for ≥ 50 players.
- `stale`: RSS newest item older than 72 h.
- `incomplete`: some MFL chunks failed.

**Player** `state`:

| State | When |
|---|---|
| `items` | Something about him |
| `no_recent_items` | Every RSS source answered **and MFL answered for this player**, and nothing is about him |
| `partial` | Nothing found, and some source (MFL included) didn't answer for him |
| `unavailable` | Nothing answered, or MFL's player list couldn't be read |
| `unknown_player` | Not in MFL's player list |

## Who a story is about

- **MFL items:** by the MFL player id MFL filed them under, only.
  - The text's names, Sleeper aliases and third-party ids are never used. This holds even when they conflict: MFL lists Ryan Izzo's ESPN id on Tyler Conklin, and that id is reported as MFL's but never used to re-match.
  - An article filed under two players (a trade) belongs to both.
- **RSS items:** resolved once against MFL's whole player list to an MFL id:
  - by full name only (initials, Jr./II and possessives normalized);
  - same-name players need a team or position in the story, or the mention stays unresolved;
  - nicknames come only from Sleeper rows joined **by id**.
- **Sleeper job** (`scripts/build_sleeper_cache.py`): an id match needs ≥ 2 agreeing facts. This is unchanged from the first revision. (Today it only feeds the legacy status card and nicknames.)

## Dedupe: one event once, different updates kept

1. **One item per article.** RSS: canonical URL. MFL: article id.
2. **Never merged** (`conflicts`):
   - two updates from the **same MFL provider** (each RotoWire update is its own);
   - two **different specific events**, such as a practice report, a game designation and an IR move about the same injury.
3. **Same story** = shares a primary player, and EITHER:
   - **Same specific event:** within 24 h, or 12 h for practice reports, because Thursday's and Friday's are two updates. MFL's coarse ages are compared as ranges.
   - **No conflicting events:** within 36 h, with ≥ 65% of the shorter headline's content words shared (names excluded).

   Stories about no player merge only on an identical headline.
4. **Lead and credit.** A story is led by a publisher with a displayable headline when it has one. Every other outlet, MFL providers included, keeps its own credit in `also_reported_by`.

### Real examples, recorded 2026-10-22 13:40 UTC

- **Kept as one story:**
  - **Jalen Hurts, season-ending:** Dynasty League Football's and RotoWire's MFL updates.
  - **Romeo Doubs, IR move:** FFToday's and Dynasty League Football's MFL updates.
  - **Jacory Croskey-Merritt, IR:** FFToday + Dynasty League Football + RotoWire.
  - **J.J. McCarthy, starting role:** CBS "Giants plan to start JJ McCarthy vs. Texans in Week 7" with PFT, plus RotoWire and Dynasty League Football via MFL.
  - **Lamar Jackson, practice:** PFT "Rashod Bateman joins Lamar Jackson as limited participant Wednesday" with CBS, Yahoo and RotoWire via MFL.
  - **Kyle Monangai, designation:** "ruled out" from a publisher plus RotoWire via MFL.
- **Kept apart:**
  - A second RotoWire McCarthy update ("confirmed to start"). It's the same provider as one already in the story, so it's its own item.
  - Baker Mayfield's RotoWire "full practice Wednesday" vs a publisher's "status for Week 7 uncertain". Same provider rule again: a RotoWire update was already in that story.
  - Every practice / designation / IR pair on one player.
- **Totals:** 7 stories merge MFL with a publisher, and 5 merge across MFL providers. The other MFL updates stand alone: 268 rostered players have news **only** from MFL.

## Coverage (same recorded moment, 2026-10-22 13:40 UTC, 479 rostered players)

| | Players with stories | Player–story links | Stories in the feed |
|---|---|---|---|
| Old live rule (before #1362) | 35 | 51 | — |
| Phase 1 v1 (RSS only) | 39 | 59 | 119 |
| **Revised (RSS + MFL)** | **307** | **584** | **639** |

## Cost

D1 numbers are measured locally with Miniflare's `rows_read` / `rows_written`, which matches production's 7,082 to within 0.1%.

| | Before | After |
|---|---|---|
| D1 reads, one player panel open (legacy route) | ≈ 1–2 rows | 1 row per player |
| D1 reads, `/api/news-feed` open | — | **0** on a cache hit (feed cached 10 min, 60 s when unavailable) |
| D1 reads, nickname list | — | 2,269 per refresh, at most every 6 h per location |
| D1 reads/writes for **MFL news** | — | **0**: nothing about it is stored in D1 |
| D1 writes per day (Sleeper job) | 7,082 | 654 measured (≈ 840 scaled); 5,002 once on the first run |
| Outbound per feed rebuild | 6 feeds + 1 MFL | 4 feeds + MFL rosters (5 min cache) + 5 MFL `playerProfile` (30 min cache) + 2 MFL `players` (24 h cache) |
| CPU per Worker invocation | — | Split into separate invocations through the Worker's own `SELF` binding: 1 name index (cached 6 h), 4 RSS parts and ≤ 5 MFL parts (cached 10 / 30 min), and 1 merge (cached 10 min). Warm: **2.0–4.6 ms** each. A fresh isolate's first call: 7–12.7 ms (fresh node process, an upper-bound proxy). |

**CPU on the Free plan.**
- **The limit:** Cloudflare's limit is 10 ms per invocation. Each isolate "has some built-in flexibility" for infrequent overruns, and only consistent overruns are terminated (Error 1102) ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **Before the split:** one rebuild needed about 11 ms warm on every rebuild.
- **After the split:** every steady-state invocation is under 5 ms. Only an isolate's first call (one-time compilation) runs over, which is the infrequent case Cloudflare allows for.

## Consumers (inventory) and how each uses the contract

None of these screens change in this PR. Their integrations are separate and need Keith's authorization. The legacy route keeps every field; MFL-led stories appear there with the neutral headline "RotoWire update (IR move): read it on MFL" and the MFL link.

| # | Consumer | Loads when | With `ups.news.v1` | Redundant → recommendation |
|---|---|---|---|---|
| 1 | Front Office News tab (`site/rosters/v2/front_office.js`) | tab open | `?pids=`, render `state`, `headline_policy`, MFL link | Its missing `res.ok` check belongs to the #1353 session |
| 2 | Front Office roster news flags | FO roster render | headline flag from `?pids=` or none | Remove the status-derived flag |
| 3 | Shared player popup (`site/shared/player_profile_master.js`) | popup open | `?pids=`, `state` | — |
| 4 | Phone player sheet (`site/m/player_sheet.js`) | News view open (not at boot) | `?pids=`, `state` | Fix the stale "playerProfile.news returns empty" comment (it returns news) |
| 5 | Roster Workbench flags | page render | — | Remove |
| 6 | Team Operations profile News | profile open | `?pids=`, `state` | — |
| 7 | Team Operations "All Player News" | disclosure open | League News | Replace |
| 8 | "RotoWire / ESPN feed coming in v2" copy | static | — | Remove the text |
| 9 | Worker retirement evidence | drop scan | legacy route; matches `category === "retirement"` too | Later: in-process |
| 10 | Hourly news warmer | hourly | the 4 RSS URLs (MFL is cached per chunk on demand) | — |
| 11 | Sleeper cache job | daily | id + bio match, changed rows | — |
| 12 | UPS Wire | — | later: editor leads (read-only) | — |

## Risks and not verified

- **CPU:** a fresh isolate's first call can run past 10 ms (one-time compilation, up to ~12.7 ms in the node proxy). Steady state is 2–5 ms per invocation. If production shows `exceededCpu` on the Free plan, the parts move to a GitHub Actions job that writes one R2 object (no CPU cap there).
- **MFL:**
  - It could throttle a busy Worker IP. Each failure shows as `partial`.
  - Registering an MFL API client (2.5× limit) is an option.
  - MFL's ages are floored, so an MFL item's time can be off by up to a day.
- **Keyword rules:** `event` and `category` are keyword-based and can mislabel. A wrong event can split or merge a story that a person wouldn't.
- **Not verified:** the live edge cache, real iPhone Safari, and authenticated MFL pages.

## Internal routes (read-only, no licensed text)

- `GET /api/news-feed/index?YEAR=`: the name index, built once and cached 6 h.
- `GET /api/news-feed/part?kind=rss&id=pfr` or `?kind=mfl&pids=…`: one normalized source. MFL records carry hashed words for dedupe, never the headline.

`/api/news-feed` calls these through `env.SELF`. Without the binding (tests), it builds them in-process. Both paths give an identical feed (tested).

## Decisions needed

- **Approve this contract** (MFL as a metadata-and-link source).
- **Inside MFL (Front Office embed):** approve showing provider headlines read by the owner's browser from MFL (`site/shared/mfl_player_news.js`). No UPS copy is made.
- **Off MFL:** the "Open MFL Player News here" frame of MFL's own page, or link only.
- **Ask MFL (FPL) for written permission** to show provider headlines/summaries on UPS's own site. A grant flips `headline_policy` to `display` for MFL items, with no contract change.
- **Rolling history:** a separate decision. MFL already gives about 7 days per player.
