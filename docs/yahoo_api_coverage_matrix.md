# Yahoo Fantasy API — Coverage Matrix

**Status:** written against the documented and community-reported API surface.
**⚠️ No live Yahoo API call has been made.** Access is gated behind an
approval application that has not been submitted — see
`docs/yahoo_fantasy_ingestion.md` §"YAHOO API ACCESS IS GATED".

**Purpose:** the honest answer to "can we get X?", so that a gap is recognised
as a property of the API rather than mistaken for an ingestion bug six months
from now. Every "no" below also has a home in `fantasy_data_completeness` with
status `not_exposed`, `access_denied` or `not_applicable` — the schema records
the gap, this document explains it.

Base URL: `https://fantasysports.yahooapis.com/fantasy/v2`, OAuth 2.0, scope
`fspt-r`. XML is the only **documented** format; `?format=json` is undocumented
but universal.

---

## 1. Resources — what the adapter calls, and what it deliberately does not

| Resource | Yahoo endpoint | Captured? | Target table(s) | Notes / caveats |
|---|---|---|---|---|
| NFL games (seasons) | `games` (`?game_codes=nfl`) | ✅ yes | *(none — used to resolve game keys)* | The only safe way to learn a season's `game_key`. Documented values relied on: **2014 = 331, 2019 = 390, 2020 = 399, 2025 = 461**. All other years are discovered at runtime; **no game id is hardcoded**, and no community-reported value is treated as fact. |
| User's games | `users;use_login=1/games` | ✅ yes | `fantasy_league_seasons` | Blind spot: only reaches seasons **this account actually played**. |
| User's leagues per game | `users;use_login=1/games/leagues` | ✅ yes | `fantasy_league_seasons` | Primary discovery path. `discovery_source='users_games_leagues'`. |
| League renewal chain | `league/{league_key}` walked via `renew_key` | ✅ yes | `fantasy_league_seasons` | Catches seasons the login query misses. `discovery_source='renew_chain'`. Canonicalized from Yahoo's native `'{game_id}_{league_id}'` form. |
| League metadata | `league/{league_key}` | ✅ yes | `fantasy_league_seasons`, `fantasy_leagues` | |
| League settings | `league/{league_key}/settings` | ✅ yes | `fantasy_league_settings`, `fantasy_scoring_rules`, `fantasy_scoring_bonuses`, `fantasy_roster_positions`, `fantasy_divisions` | One payload, five tables — splitting the request would triple the API cost for no benefit. Roster slots from here are what make `is_starter` derivable at all. |
| Teams | `league/{league_key}/teams` | ✅ yes | `fantasy_teams`, `fantasy_team_season_state` | Includes team-level `draft_grade`. |
| Managers | *(from the teams payload)* | ✅ yes | `fantasy_managers`, `fantasy_team_managers` | No separate request. ⚠️ Other managers' nicknames come back as the literal `'--hidden--'`; join on the account GUID only. |
| Draft results | `league/{league_key}/draftresults` | ✅ yes | `fantasy_drafts`, `fantasy_draft_events` | `auction_cost` preserved exactly: **NULL ≠ 0**. No per-pick keeper flag exists — see §2. |
| Transactions | `league/{league_key}/transactions` | ✅ **completed only** | `fantasy_transactions`, `fantasy_transaction_assets` | ⚠️ Yahoo documents **no `start` parameter** on this collection — only `count`. Whether it silently paginates is undocumented and untested, so the adapter makes the **unfiltered** request (which returns full history for a completed season) and reports the observed count. The completeness check compares it against the teams' own `number_of_moves`/`number_of_trades`; a shortfall is **surfaced, not assumed away**. |
| Standings | `league/{league_key}/standings` | ✅ **one state only** | `fantasy_standings_snapshots` | Final for a completed season, current for a live one. There is no `standings;week=N`. Every other week is reconstructed with `is_inferred=1`. |
| Scoreboard | `league/{league_key}/scoreboard;week=N` | ✅ yes, per week | `fantasy_matchups`, `fantasy_team_week_scores` | One request per week. The source for reconstructed weekly standings. |
| Weekly rosters | `league/{league_key}/teams/roster;week=N` | ✅ yes, per week | `fantasy_roster_snapshots` | ⚠️ **No bulk and no date-ranged form.** Captured week by week or not at all. The most valuable and least recoverable table in the family. |
| Player weekly stats + points | `league/{league_key}/teams/roster/players/stats;week=N` | ✅ yes, per week | `fantasy_player_week_stats`, `fantasy_player_week_points` | Rostered players only — this path cannot see a week's free agents. |
| Player universe | `league/{league_key}/players;start=N;count=25` | ✅ yes, paginated | `fantasy_players`, `fantasy_player_identifiers`, `fantasy_player_eligibility`, `fantasy_player_status_snapshots` | ⚠️ **Hard-capped at 25 items per page** regardless of the `count` requested, and the cap is undocumented. A 1,000-player league is 40+ requests per season. A bounded read reports `complete=False`. |
| Player draft analysis | `players;out=draft_analysis` | ❌ **not called yet** | *(would be `fantasy_draft_player_metadata`)* | The table exists and is ready. ⚠️ **Historicity is unverified**: whether a historical game key returns that season's frozen values or today's is undocumented, which is why `historicity_verified` defaults to 0. **Capture it forward each preseason** rather than assuming a backfill works — see §3(a). |
| Player ownership % | `players;out=ownership` / `percent_owned` | ⚠️ **structure ready, forward only** | `fantasy_player_status_snapshots.percent_owned` | Provider-wide, not league-relative. Only capturable going forward; a historical ownership curve cannot be reconstructed. |
| Game stat categories | `game/{game_key}/stat_categories` | ❌ not called | — | Not needed: `stat_id` + name arrive inside `league/settings`, already scoped to the right season. |
| Game position types | `game/{game_key}/position_types` | ❌ not called | — | Not needed: `position_type` arrives with roster positions and players. |
| Game weeks | `game/{game_key}/game_weeks` | ❌ not called | *(would refine `fantasy_schedule_periods`)* | Week bounds currently come from the league's own `start_week`/`end_week`, and the adapter **refuses** (`cannot determine week bounds`) rather than defaulting to 17 when they are absent. Worth adding if a season's bounds turn out unreliable. |
| Team matchups | `team/{team_key}/matchups` | ❌ deliberately not called | — | Fully redundant with the league scoreboard, at 12× the request cost. |
| Leagues by public id | `leagues;league_keys=…` | ❌ not called | — | We only ever read leagues this account is a member of. |
| **Any write endpoint** | — | ❌ **never** | — | Yahoo: *"Write access is not available at this time."* This pipeline reads only, permanently. |

**Access ceiling on all of the above:** a private league is readable **only by
its members**. A historical season the authenticating account never played is
permanently unreachable — recorded as `access_denied`, which is not a transient
failure and not an empty season.

---

## 2. Visible on Yahoo's website, NOT available from the API

These are the genuine gaps. Each one is something you can see in a browser and
cannot get through the API.

| Fact | What it would enable | Why it is unavailable |
|---|---|---|
| **Losing / failed waiver claims and competing FAAB bids** | The whole waiver **market**: what a player was actually worth, who else wanted him, how contested each week was, whether a winning bid was efficient or wildly over. Without it, every waiver claim looks uncontested. | Once waivers process, competing claims **vanish from the API entirely**. The transactions collection returns accepted moves only. A pending claim is visible only to the team that owns it, and only before processing. **Permanently unrecoverable for any past week.** |
| **Rejected / vetoed trades** | Trade-proposal behaviour: who proposes constantly, what gets refused, whether the league vetoes. | No documented endpoint returns a rejected or vetoed trade. Pending trades are visible only to the counterparties. Assumed unrecoverable. |
| **Weekly standings snapshots** | Actual playoff races as they were lived — "he was 6th in week 10 and made the final". | The API returns **exactly one** standings state: final for a completed season, current for a live one. There is no `standings;week=N` and no historical snapshot endpoint. |
| **Per-player projections (historical)** | Projection-vs-actual accuracy, start/sit decisions judged against what was known at the time. | There is no documented per-player projection resource, and **historical projections are definitively unavailable**. `projected_points` is NULL for every backfilled week, which is correct rather than missing. Current-week projections may appear on live matchup/roster payloads and are captured where they do. |
| **Waiver-priority history** | Who spent priority when, and whether it was worth it. | Only the **current** priority is exposed. No history endpoint exists. |
| **Per-pick draft grades and per-pick keeper flags** | "Which pick was the steal", and clean keeper-vs-drafted separation. | Yahoo exposes a **team-level** `draft_grade` (e.g. `'B-'`) and nothing per pick. For keepers, the only surface is a players-collection filter showing who is **currently** designated — a point-in-time flag, not a historical per-pick attribute. `is_keeper` therefore stays NULL and any inference lands in `keeper_inferred` + `keeper_inference_basis`. |
| **Manager real names** | Human-readable league history without a hand-maintained name map. | Yahoo returns other managers' nicknames as the literal string **`'--hidden--'`** unless that manager made theirs public. Several distinct managers can carry it simultaneously, so it is not even a usable temporary key. The stable account GUID is the only join key. |
| **Trade notes on completed trades** | Why a trade happened; side agreements; the league's actual negotiating culture. | The field exists on the parent row but is **rarely populated** on completed trades. Mostly NULL, and there is no second source. |

**Two more worth knowing about**, though they are absences rather than website
features:

- **In-season roster history between observations.** The roster endpoint serves
  one week at a time and only in its current state — a player added and dropped
  within the same week between two syncs leaves no roster trace (though the
  transactions do record it).
- **Team name history.** Yahoo exposes only the **current** team name, so a
  mid-season rename is invisible unless we happened to observe both. Hence
  `fantasy_teams.name_history`, which is appended to and never replaced.

---

## 3. Recommendations for filling genuine gaps — without brittle or unauthorized scraping

Ordered strongest to weakest. **The honest summary is that most of the §2 gaps
are permanent for the past and only partially closeable for the future.** Say
that out loud rather than building something fragile that pretends otherwise.

### (a) Capture forward-looking snapshots NOW — the highest-value action by a wide margin

Several of the §2 gaps are **only unrecoverable backwards**. Every week that
passes without a snapshot converts a "we can start collecting this" into a "this
is gone forever". Nothing else in this document has a comparable return.

Start capturing on a weekly cadence, from the first sync after approval:

| Capture | Where it lands | Why now |
|---|---|---|
| **`draft_analysis` each preseason** | `fantasy_draft_player_metadata` | Historicity is unverified — a backfill may silently return **today's** values for a historical key. A snapshot taken in the right preseason is unambiguously correct, and `captured_for_season` + `captured_at_utc` make it auditable. |
| **Weekly ownership %** | `fantasy_player_status_snapshots.percent_owned` | There is no historical ownership endpoint. A weekly point gives you an ownership *curve* from now on. |
| **Standings every week** | `fantasy_standings_snapshots` with `is_inferred=0` | The only way to ever have a **real** (not reconstructed) weekly standings row. |
| **Waiver priority + FAAB balance every week** | `fantasy_waiver_state_snapshots` | Neither has any history endpoint. `observed_at_utc` is part of the primary key precisely so two syncs in a week are two legitimate observations. |
| **Weekly rosters, always** | `fantasy_roster_snapshots` | No bulk form, no date range. Week by week or not at all. |
| **Current-week projections where they appear** | `fantasy_player_week_points.projected_points`, `fantasy_team_week_scores.projected_points` | Historical projections are gone; future ones are only gone if you do not collect them. |

**Cost:** a handful of extra requests per week. **Value:** the only path to
these facts existing at all. Do it before anything cosmetic.

### (b) Reconstruct what is reconstructible — and label it `inferred`, always

Some gaps have a legitimate derivation from data we **do** have. The rule is
absolute: **a reconstructed value never occupies the column that means "the
provider said so."**

| Gap | Reconstruction | Where the flag lives |
|---|---|---|
| Weekly standings for past seasons | Accumulate the scoreboard week by week, respecting `playoff_start_week` and the `is_playoffs`/`is_consolation` flags so postseason results do not pollute regular-season records. | `fantasy_standings_snapshots.is_inferred = 1` + `inference_basis` |
| Keeper status | Player was on the roster at the end of season N−1 **and** drafted at an anomalous round in season N. | `keeper_inferred` + `keeper_inference_basis`; **`is_keeper` stays NULL** |
| Roster acquisition type/date | Join the roster snapshot back to the transaction log. | `is_derived_acquisition = 1` |
| Waiver priority over time | Derive from the transaction sequence. | `fantasy_waiver_state_snapshots.is_derived = 1` |
| FAAB spent to date | Sum winning bids from transactions. | `faab_spent_todate`, **NULL if bids are unavailable** |
| Bench points, optimal lineup, lineup efficiency | Roster snapshots + player points + this league's slot definitions. | `fantasy_team_week_scores` recomputed columns, reconciled against the provider total |

**What is NOT reconstructible, and must not be faked:** losing waiver claims,
competing bids, rejected trades, historical projections, and manager real names.
There is no derivation. Leave them absent and let
`fantasy_data_completeness.status = 'not_exposed'` say so.

### (c) A one-time manual CSV export by the commissioner — where Yahoo's own UI offers one

Yahoo's web UI offers some exports the API does not, and a commissioner
exporting **their own league's** data through the interface Yahoo provides is
using the product as intended — no terms problem, no brittleness.

Where this is worth doing:

- A **one-time** export at the start of the project, for anything the API cannot
  reach and the UI can.
- Land it in a clearly-marked staging path, with `source_run_id` naming the
  manual import and `discovery_source`/`match_method` recording `'manual'`.
- **Never** let a manual import silently overwrite an API-sourced row. Manual
  data is a supplement with its own provenance, not a competing authority.

**Be realistic about the ceiling:** a manual export will not resurrect losing
waiver bids or rejected trades either — those are not in Yahoo's UI for past
weeks. This helps with bulk convenience, not with facts Yahoo has discarded.

### (d) ⚠️ Explicitly AGAINST HTML scraping as a primary mechanism

**Do not build the pipeline on scraping Yahoo's website. This is a
recommendation against, not a fallback plan.**

Three independent reasons, any one of which is sufficient:

1. **It would violate Yahoo's terms.** Yahoo's terms prohibit reverse
   engineering and **separating the underlying data** from the service. A
   scraper exists specifically to do the second of those. This is a compliance
   objection, not a taste one — and it applies regardless of how small or
   personal the use is.
2. **It is brittle in the way that costs the most.** Markup changes silently.
   A scraper that breaks loudly is an inconvenience; a scraper that breaks
   *quietly* — a renamed class turning a populated table into zero rows —
   writes a permanent lie into a database that has already been damaged four
   separate ways by code that failed open. That failure mode is the single thing
   this entire pipeline is architected against.
3. **It needs session credentials the architecture refuses to hold.** Scraping
   a private league means holding a Yahoo login session. This project stores
   **no** Yahoo password, MFA code, or browser cookie, anywhere, on purpose.
   Adding a cookie jar to reach a few extra columns would trade the security
   posture of the whole system for marginal data.

**The narrow, non-primary exception:** a human, logged into their own account,
manually exporting or copying **their own league's** data once — that is (c),
and it is a person using a product, not an automated separation of data from a
service. An automated fetch-and-parse loop against Yahoo HTML is out of scope,
now and later.

### (e) What to do with the gaps that remain

Record them and stop. `fantasy_data_completeness` exists so that
`not_exposed` is a **fact in the database**, queryable and dated, rather than a
mystery someone rediscovers. When a report cannot answer a question, the right
outcome is the report saying *"Yahoo does not expose this"* — not a plausible
number nobody can trace.
