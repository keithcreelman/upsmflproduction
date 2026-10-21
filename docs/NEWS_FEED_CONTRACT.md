# Shared external news feed: contract `ups.news.v1`

Phase 1 of #1356 (Keith, 2026-10-21). This is ONE normalized feed of outside NFL and player news. League News shows all of it. The player panel shows it filtered to one player. UPS Wire may later read it for editor leads, but nothing is written or published automatically. There are no AI summaries.

- **Builder:** `worker/src/news_feed.js`.
- **Routes:** `GET /api/news-feed`, plus the legacy `GET /api/player-news` shape.
- **Tests:** `tests/news_feed.test.mjs` and `pipelines/etl/scripts/test_build_sleeper_cache.py`.

## What we may show

| Shown | Never shown or stored |
|---|---|
| Headline, publisher, published time, link to the publisher | Article text, RSS summary or description, images |
| Category (deterministic keywords) | MFL's RotoWire / FFToday / DLF headlines (MFL's API terms exclude third-party news) |
| Canonical player ids (MFL, plus the ESPN and RotoWire ids MFL publishes) | Injury designations as news items (the shared injury resolver owns those) |
| Each source's state, plus when it was fetched | |
| A per-player **MFL Player News ↗** link (`news_articles?L=&P=`) | |

The RSS summary is read **in memory only**, to find which players a story is about and to pick its category. It is then dropped. A test fails if a summary string appears anywhere in the output.

**Approved sources:**
- ProFootballRumors, ProFootballTalk, CBS Sports and Yahoo Sports. Each is publisher RSS published for syndication.

**Removed sources:**
- **ESPN `site.api`:** undocumented, and returned 0 items to the Worker.
- **Reddit `r/nfl` JSON:** returns 403, and Reddit's Data API needs registration.

## Response: League News

`GET /api/news-feed?L=74598&YEAR=2026[&limit=100][&category=injury]`

Real example, from the recorded 2026-10-21 feeds (trimmed):

```json
{
  "contract": "ups.news.v1",
  "generated_at": "2026-10-21T11:33:00.000Z",
  "feed_state": "ok",
  "coverage": { "since_ts": 1792537265, "hours": 12.5 },
  "sources": [
    { "id": "pfr", "publisher": "ProFootballRumors", "state": "ok", "http_status": 200, "items": 15,
      "oldest_ts": 1792516679, "newest_ts": 1792555720, "fetched_at": "2026-10-21T11:33:00Z", "error": "" }
  ],
  "player_index": { "state": "ok", "players": 2280, "error": "", "aliases": "ok", "external_ids": "ok" },
  "cache": { "hit": false },
  "categories": ["retirement", "discipline", "injury", "transaction", "contract", "role", "performance", "other"],
  "total_items": 115,
  "items": [
    {
      "id": "n_12fd9ee9446f89",
      "story_id": "s_12fd9ee9446f89",
      "headline": "NFLPA calls for \"full investigation\" into Jalen Hurts situation",
      "publisher": "ProFootballTalk",
      "source_id": "pft",
      "url": "https://www.nbcsports.com/nfl/profootballtalk/rumor-mill/news/nflpa-calls-for-full-investigation-into-jalen-hurts-situation",
      "published_ts": 1792540921,
      "published_at": "2026-10-21T00:02:01.000Z",
      "fetched_at": "2026-10-21T11:33:00Z",
      "category": "discipline",
      "players": [
        { "mfl_id": "14783", "espn_id": "4040715", "rotowire_id": "14416", "name": "Jalen Hurts",
          "team": "PHI", "position": "QB", "match": "headline", "primary": true }
      ],
      "also_reported_by": [
        { "id": "n_19fcec4bec892e", "publisher": "Yahoo Sports",
          "url": "https://sports.yahoo.com/articles/nflpa-calls-full-investigation-jalen-000201040.html", "published_ts": 1792540921 }
      ]
    }
  ],
  "diagnostics": { "articles": 131, "unique_articles": 131, "stories": 115, "unresolved_name_mentions": 0, "players_indexed": 2280 }
}
```

## Response: player filter

`GET /api/news-feed?L=74598&YEAR=2026&pids=14783,13635[&limit=10]` returns the same header fields, plus:

```json
"players": {
  "14783": {
    "mfl_id": "14783",
    "state": "items",
    "mfl_news_url": "https://www48.myfantasyleague.com/2026/news_articles?L=74598&P=14783",
    "coverage": { "since_ts": 1792537265, "hours": 12.5 },
    "unavailable_sources": [],
    "item_ids": ["n_1e8c627a2d1a85", "n_05844d66fa8e9f"],
    "items": [ "…item shape above…" ]
  }
}
```

Items where the player is in the headline or an editor's tag (`primary: true`) come first. Summary-only mentions follow, newest first within each group.

## States: an outage is never "no news"

| `feed_state` | Meaning | HTTP |
|---|---|---|
| `ok` | every source answered with current items | 200 |
| `partial` | at least one answered and at least one is `error` / `empty` / `stale` | 200 |
| `unavailable` | no source answered | **503** (the body still carries the contract) |

Source `state`:
- `ok`
- `error`: HTTP or network failure.
- `empty`: answered with 0 items, or with an HTML error page.
- `stale`: the newest item is more than 72 h old.

Player `state`, exactly one of:

| state | When | What a screen says |
|---|---|---|
| `items` | stories name this player | the list, plus the MFL link |
| `no_recent_items` | **every** source answered, and none names him | "No headlines naming him in the last *N* h (since …)", plus the MFL link |
| `partial` | no stories, and a source is down | "Some sources didn't answer (…); nothing from the rest", plus the MFL link |
| `unavailable` | no source answered, or MFL's player list couldn't be read | "News couldn't be loaded. Reopen to retry", plus the MFL link |
| `unknown_player` | id not in MFL's player list | "Not in MFL's player list" |

## Who a story is about (stable ids)

RSS carries no player ids, so each story is resolved **once**, against MFL's whole player list, to an MFL id:

- **Full names only.** Never a last name alone, and never "first name anywhere plus last name anywhere".
- **Normalized names.** Accents, punctuation, initials (`D.J.` = `DJ`), possessives and `Jr./Sr./II/III` are normalized.
- **Same-name players.** When two players share a name (Justin Jefferson, WR MIN / LB CLE), a team or position named in the same story must pick one. Otherwise the mention stays unresolved and is counted in `diagnostics`.
- **Editor tags.** An editor's `<category>` tag counts only when the whole tag is a player's name.
- **Nicknames.** Sleeper's `full_name` supplies nicknames ("Kam Curl" for MFL's "Curl, Kamren"), but only for rows the Sleeper job joined **by RotoWire / ESPN id**.

The Sleeper job's own MFL→Sleeper join (`scripts/build_sleeper_cache.py`) no longer trusts any single fact:

- **Candidates:** the Sleeper rows sharing MFL's RotoWire id, its ESPN id, or its full name + team.
- **Acceptance:** a candidate is accepted only with **at least 2 agreeing facts**: an id, birthdate, name or team. A different position or a differing id counts against it.
- **Why no single fact is trusted:** Sleeper's retired rows carry stale RotoWire ids that now belong to active players (6 found on 2026-10-21). MFL lists Ryan Izzo's ESPN id on Tyler Conklin. Birthdates disagree by days for about 40 real matches.
- **Measured against the old name match:** 0 disagreements on the 1,771 players both match, 0 dropped, 498 added.
- **Known miss:** John Parker Romo, a free-agent kicker, where only one fact agrees.

## Dedupe

- **One article = one `id`:** a hash of the canonical URL, with scheme, `www.`, query, fragment and trailing slash removed. It is the same across feeds, refreshes and feed order.
- **One story = one item.** Copies count as the same story when they:
  - share a primary player;
  - were published within 36 h;
  - share at least 65% of the shorter headline's content words (player names excluded).

  The earliest report leads, and the others are listed in `also_reported_by`. Stories about no player merge only on an identical headline.
- **Stable `story_id`:** it comes from the lead item's id, so it survives refreshes.

## Cost

Measured 2026-10-21. Local D1 runs use Miniflare's `rows_read` / `rows_written`, which matches production's 7,082 to within 0.1%.

| | Before | After |
|---|---|---|
| D1 reads, one player panel open (legacy route) | about 1–2 rows (prod: 13 for 8 players) | 1 row per player (16 for 8: more players match now) |
| D1 reads, `/api/news-feed` open | — | **0** on a cache hit (feed cached 10 min, 60 s when unavailable) |
| D1 reads, nickname list | — | 2,269 rows per refresh, at most every 6 h per Cloudflare location |
| D1 writes per day (Sleeper job) | **7,082** (delete + reinsert everything) | **654** measured day-over-day on the 1,771 known rows (≈ 840 scaled to 2,269); a same-day rerun writes **0** |
| D1 writes, first run after merge (one-time remap) | — | 5,002 |
| D1 reads per day (Sleeper job) | 0 | about 6,807 (change comparison) |
| Outbound per feed rebuild | 6 feeds + 1 MFL | 4 feeds + 2 MFL, all edge-cached (RSS 1 h, MFL 24 h) |
| CPU per feed rebuild | — | ~9 ms warm (node), once per 10 min per location |

## Consumers (inventory 2026-10-21) and how each uses this contract

None of the screens below change in this PR. Their integrations are separate and need Keith's authorization. The legacy `/api/player-news` keeps every existing field.

| # | Consumer | Loads when | Today | With `ups.news.v1` | Redundant → recommendation |
|---|---|---|---|---|---|
| 1 | Front Office News tab (`site/rosters/v2/front_office.js` `renderNewsTab`) | tab open | legacy route. **No `res.ok` check**, so an outage reads "No injury reports or news headlines" | `?pids=<pid>&limit=10`, render `state`, MFL link | **Fix belongs to the #1353 session** |
| 2 | Front Office roster news flags (`front_office.js` ~3665) | FO roster render, in ≤40-pid chunks | flag = any status/headline item | headline flag from `?pids=` (≤50), or none | **Remove the status-derived flag** (the injury resolver already badges injuries); consider removing this boot-time news fetch |
| 3 | Shared player popup (`site/shared/player_profile_master.js` `wireNewsAsync`) | popup open | legacy route; an HTTP error says "unavailable", a 200 with no items says "no news" | `?pids=`, `state` | — |
| 4 | Phone player sheet (`site/m/player_sheet.js` `loadPlayerNews`) | News view open (**not at boot** ✓) | legacy route; already separates `null` from `[]` | `?pids=`, `state`; still no boot fetch | Correct the stale "playerProfile.news returns empty" comment |
| 5 | Roster Workbench news flags (`site/rosters/roster_workbench.js` ~8660) | page render, in 50-pid batches | legacy route | — | **Remove** (legacy page; duplicates FO flags + injury resolver) |
| 6 | Team Operations profile News (`site/team_operations/team_operations.js` ~3617) | profile open | legacy route; an outage reads "no news" | `?pids=`, `state` | — |
| 7 | Team Operations "All Player News" panel (~4117) | disclosure open | fakes a league feed with ≤50-pid batches | League News (`/api/news-feed`, no pids) | **Replace with League News**; don't keep two feeds |
| 8 | Rookie hub + Roster Workbench copy "RotoWire / ESPN feed coming in v2" | static text | promise we can't keep (RotoWire is not licensed for display) | — | **Remove the text** |
| 9 | Worker cap-free retirement evidence (`_retirementNewsBatch`) | drop scan | legacy route via self-fetch | still the legacy route; matches `category === "retirement"` too (headlines have no body now); a 503 → `known:false` | Later: call the feed builder in-process |
| 10 | Worker hourly news warmer (`scheduled`) | hourly cron | 6 URLs | the 4 approved URLs | — |
| 11 | Sleeper cache job (`sleeper-cache-build.yml` → `scripts/build_sleeper_cache.py`) | daily cron | delete + reinsert, name + team | id + bio match, changed rows only | — |
| 12 | UPS Wire (`pipelines/etl/wire/*`) | — | no news input | later: editor leads from `/api/news-feed` (read only, never auto-published) | — |

**Redundant once 1–7 move to the contract.**

- The legacy route's Sleeper `status` / `depth` items (they duplicate injury designations).
- The Roster Workbench flags.
- The Team Operations batch "All Player News".
- `/api/player-news` itself, apart from the retirement leg (move that in-process).

The recommendation is to remove these rather than maintain two feeds.

## What this PR changes on merge (screens and jobs affected)

- **Every `/api/player-news` consumer (1–7, 9):**
  - Headlines now come from the shared feed: deduped (Hurts went from 16 near-duplicate headlines to 10 stories) and with no excerpt text (`body` is `""`).
  - More players match (A.J. Brown, C.J. Stroud, Marvin Harrison Jr., Kenneth Walker III, editor tags).
  - A total outage returns **503**. The popup and phone then say "unavailable". The FO tab still says "no news" until its own fix (row 1).
- **Retirement evidence (9):** a retirement story is also recognized by its category.
- **Hourly warmer (10):** 4 fetches instead of 6.
- **Sleeper job (11):** new matching and changed-row writes. The first run writes about 5,002 rows (one time), then about 650–840 a day.
- **New `/api/news-feed`:** read-only, and nothing calls it yet.
