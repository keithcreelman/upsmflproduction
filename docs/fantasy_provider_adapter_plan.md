# Fantasy Provider Adapter Plan — CBS and ESPN into the same model

**Status:** **ESPN is implemented as a lighter first pass** (2026-08-12) — see
`pipelines/fantasy/providers/espn/`. CBS remains design only; nothing
CBS-specific has been written. This document was originally written before
either existed; the sections below are updated in place rather than kept as a
historical prediction, so read it as current state, not as a plan.
**Raised:** 2026-08-11, alongside the Yahoo pipeline — the `fantasy_*` schema
was designed for more than one platform from the first migration, and ESPN's
implementation is the receipt for that claim: **zero new migrations were
needed.** Every ESPN row lands in the same tables Yahoo uses, disambiguated
purely by `platform='espn'` being first in every primary key.

**Prerequisite:** read `docs/yahoo_fantasy_ingestion.md` and
`docs/yahoo_data_dictionary.md` first. This document only covers what is
*different* for a second and third platform.

⚠️ **UPDATED 2026-08-12 — partially resolved.** This section originally said
the Yahoo adapter had never made a live call and a second provider should wait
for that proof. Two things changed: (1) Yahoo's approval application is now
submitted and pending (see `docs/yahoo_fantasy_ingestion.md`), with no further
code work possible until it clears; (2) Keith asked to start ESPN "while we
wait," specifically because ESPN has no approval gate at all. The ESPN adapter
**has** made a real, live, unauthenticated call to
`lm-api-reads.fantasy.espn.com` (a genuine HTTP 401, correctly mapped to
`AccessDeniedError`) — proving transport and URL construction the same way the
Yahoo 401 proof did. What is **still unproven** is a full authenticated
payload against Keith's real league, which needs his ESPN cookies (session
credentials — never pasted into this session; see
`pipelines/fantasy/providers/espn/auth.py`) and has not happened yet.

---

## The claim being tested

> Adding `platform='cbs'` or `platform='espn'` requires **no schema change**,
> **no change to the loader, the quality checks, the crosswalk, or the CLI**,
> and no consumer of the `fantasy_v_*` views needs to know which platform a row
> came from.

Two design decisions make that possible, both already in the migrations:

1. **`platform` is the first column of every composite primary key** in all 35
   tables — not a tag bolted on afterwards. Values are lowercase and closed:
   `'yahoo'` | `'cbs'` | `'espn'`. A CBS row and a Yahoo row for the same
   nominal league id cannot collide.
2. **The adapter boundary is absolute.** `pipelines/fantasy/providers/base.py`
   states it as a design contract: *"nothing outside `providers/yahoo/` may know
   that Yahoo collections are objects with a `count` sibling, that its league
   key embeds the game key, or that a throttle arrives as HTTP 999. If any of
   those facts leak upward, a second provider becomes a rewrite instead of a new
   directory."*

A new platform is therefore one new directory —
`pipelines/fantasy/providers/<name>/` — containing its own client, its own shape
normalizer, its own parsers, and one class implementing `FantasyProvider`.

---

## The 14-method interface every provider must implement

From `pipelines/fantasy/providers/base.py`. Each method returns
**platform-neutral row dicts keyed exactly like the `fantasy_*` columns**.

| # | Method | Returns | Notes for a new platform |
|---|---|---|---|
| 1 | `discover_leagues(seasons=None)` | `list[LeagueRef]` | Should use **more than one** discovery mechanism where the platform offers them — each has blind spots. |
| 2 | `fetch_league_metadata(league)` | `FetchResult` | Identity, calendar, status. |
| 3 | `fetch_league_settings(league)` | `FetchResult` | Returns rows for **several tables at once**, each tagged with a `_table` key. Splitting the request would multiply API cost for no benefit. |
| 4 | `fetch_teams(league)` | `FetchResult` | |
| 5 | `fetch_managers(league)` | `FetchResult` | **Must key on the platform's stable account identifier, never a display name.** |
| 6 | `fetch_draft_results(league)` | `FetchResult` | ⚠️ Auction price preserved as-is: `None` when unstated, `0.0` only when genuinely zero. |
| 7 | `fetch_transactions(league)` | `FetchResult` | Parent rows **plus** asset legs. Never collapses a multi-asset move into one row. |
| 8 | `fetch_standings(league)` | `FetchResult` | Only what the provider **actually said**. Weekly reconstruction happens elsewhere and is flagged `inferred`. |
| 9 | `fetch_scoreboard(league, week)` | `FetchResult` | |
| 10 | `fetch_rosters(league, week)` | `FetchResult` | Starter status derived from **the league's own slot definitions**, not a hardcoded bench list. |
| 11 | `fetch_player_stats(league, week)` | `FetchResult` | |
| 12 | `fetch_players(league, status=None, max_pages=None)` | `FetchResult` | **Must paginate to exhaustion.** A bounded read sets `complete=False` and says so in `notes`. |
| 13 | `sync_season(league, since_week=None)` | `Iterator[FetchResult]` | Yields so the caller can write and checkpoint rather than buffering a season in memory. |
| 14 | `backfill_season(league)` | `Iterator[FetchResult]` | Full historical capture of one league-season. |

Plus two non-abstract helpers with sensible defaults:
`resource_supported(resource)` — which drives the `not_exposed` /
`not_applicable` distinction — and `close()`.

### The five guarantees, restated because they are what actually matters

An adapter that implements all fourteen signatures and breaks any of these is
worse than no adapter.

1. **RAISE, NEVER RETURN EMPTY, ON AN UNREADABLE RESPONSE.** An empty list means
   *"the provider says there are none."* An unreadable payload means *"we do not
   know"* and must raise `ProviderError`. Conflating them is the single root
   cause behind every data-destruction incident in this repo.
2. **NEVER FABRICATE.** A field the provider does not expose is absent or
   explicitly `None`. No defaults, no inference, no carrying a value over from
   another season. Derived values are marked as derived by the column that holds
   them.
3. **PRESERVE PROVIDER VOCABULARY VERBATIM.** Statuses, draft types, waiver
   rules and position labels pass through unnormalized. Cross-season vocabulary
   drift is a known silent-failure class; normalizing on ingest hides it, and
   the point is to see it.
4. **BE IDEMPOTENT.** The same call over the same upstream state produces the
   same rows with the same keys, so a re-run upserts rather than duplicates.
5. **STAMP PROVENANCE.** Every row carries `platform`; the caller adds
   `source_run_id`. **Adapters never write to the database** — they return rows
   and the loader writes. That separation is what lets the whole pipeline be
   tested against fixtures with no network and no D1.

A platform that genuinely cannot serve a resource returns an **empty
`FetchResult` with `complete=False` and a note explaining why** — which becomes
a `not_exposed` completeness row. It does **not** raise `NotImplementedError`,
because "this platform has no such endpoint" is a fact about the data worth
recording, not a bug.

### The error vocabulary is shared

`ProviderError` and its four subclasses are platform-neutral and already carry
enough structure to become a `fantasy_api_errors` row without re-parsing an
exception string:

| Exception | `error_kind` | Retryable | When |
|---|---|---|---|
| `AuthError` | `auth` | no | Credentials missing/expired/revoked. Retrying makes it worse; a human must re-consent. |
| `RateLimitError` | `rate_limited` | yes | Throttled. Always with backoff. |
| `UnreadableResponseError` | `unparseable` | yes | A 2xx response whose body could not be interpreted. **Exists so "the body was an HTML throttle page" can never be mistaken for "the collection was empty."** |
| `AccessDeniedError` | `auth` | no | The resource exists but this account cannot read it. Permanent. |
| `ProviderError` | `unknown` | no | Everything else. |

A new adapter maps its platform's failures onto these five. It does not invent a
sixth.

---

## Why no schema change is needed

| Concern | Why it is already handled |
|---|---|
| Key collisions between platforms | `platform` is first in every composite PK across all 35 tables. |
| Different id formats | `league_key`, `team_key`, `player_uid` are opaque TEXT. Nothing parses them outside the owning adapter. |
| Different identifier kinds | `fantasy_player_identifiers` is a **tall** table keyed `(platform, player_uid, id_type, id_scope)`. A new platform's id kinds slot in with no migration. |
| Different stat sets | `fantasy_player_week_stats` is **tall**, one row per `(player, week, stat_id)`. A new stat absorbs with no migration — and it must, because D1 enforces a **hard 100-column cap** that `nfl_player_weekly` already hit and can never be widened past. |
| Different scoring | `fantasy_scoring_rules` is one row per stat per league-season, joined on `stat_id`. |
| Different lineup slots | `fantasy_roster_positions.is_starting_slot` is computed per league from that league's own slot list. |
| Different vocabularies | Everything vocabulary-shaped is stored verbatim, so drift is visible as data. |
| The crosswalk | `fantasy_player_crosswalk` is keyed `(platform, player_uid)`. The **resolution order** (`provider_id` → `gsis_id` → `name_team_position` → `manual`) is platform-neutral; only step 1's source column differs. |

**One thing that would need work, honestly stated:** `ff_player_ids` carries a
`yahoo_id` column (added by 0132) because DynastyProcess publishes one. It does
**not** publish a `cbs_id`, and its ESPN coverage would need checking. Step 1 of
the resolution order therefore degrades to step 3 (`name_team_position`) for
those platforms unless another id source is found — which means **lower
confidence and a bigger manual review queue**, not a broken model. That is a
data-availability problem, not a schema problem, and the `confidence` /
`review_status` columns already exist to express it.

---

## Per-platform: what is known to differ

### ESPN

**Authentication is the whole story.** ESPN has **no official public fantasy
API**. What exists is a **private JSON API** that the ESPN web app itself uses,
reached with two browser cookies — **`SWID`** and **`espn_s2`** — rather than
OAuth.

**⚠️ Before any code was written, the cookie question was raised explicitly
with Keith** (matching this document's own prerequisite above): SWID/espn_s2
are live session credentials, functionally equivalent to a password, and were
never to be pasted into this session under any circumstances. Keith was told
this and the Keychain-based storage flow (`pipelines/fantasy/providers/espn/auth.py`)
was built before any ESPN request was made. That is the "explicit decision"
this document called for — it was about credential handling, not about
whether reading a private API is acceptable, which remains Keith's call to
make about his own account.

| Dimension | ESPN — CONFIRMED (2026-08-12, via github.com/cwendt94/espn-api source + one live unauthenticated request) |
|---|---|
| Auth | Two cookies, `SWID` + `espn_s2`, extracted from a logged-in browser session. **No OAuth, no consent screen, no refresh token, no documented expiry.** Confirmed live: an unauthenticated request against a private league returns a real HTTP 401. |
| Contract | **None.** No published API, no terms granting access, no support channel, no deprecation policy. |
| Response shape | JSON, and considerably more conventional than Yahoo's — real arrays, real nested objects. **No shape-normalizer module was needed** (unlike Yahoo's `shape.py`) — `parse.py` reads field paths directly. The `?view=` parameter selects which blocks come back; this pass uses `mTeam`, `mSettings`, `mStandings`, `mBoxscore`, `mMatchup`. |
| Base host | `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl` — **confirmed to have moved without notice once already** (from `fantasy.espn.com`, April 2024). Treat a transport-level failure as a possible second silent move, not just a credential problem. |
| Historical seasons | Confirmed two distinct URL shapes: `seasons/{year}/segments/0/leagues/{id}` for 2018+, `leagueHistory/{id}?seasonId={year}` for earlier — the latter wraps the response body in a single-element list. Both are implemented and tested (`client.py`, `test_espn_pipeline.py` block F). |
| Rate limits | Undocumented, like Yahoo's, and no 999-style throttle signature is known for ESPN. Paced conservatively anyway (0.5s default). |
| Public leagues | Confirmed: an unauthenticated request is a real, valid mode — `EspnCookies.is_present == False` sends no Cookie header at all rather than refusing to try. |

⚠️ **The cookie approach is materially less durable than OAuth. Say so plainly
rather than discovering it in production.** Concretely:

- **A cookie has no refresh flow.** When it expires — and there is no documented
  lifetime — a human must log into a browser, open developer tools, and copy two
  values out by hand. Every scheduled sync fails until they do. OAuth's refresh
  token renews unattended; this does not.
- **A cookie is a full-account session credential, not a scoped grant.** OAuth
  `fspt-r` is read-only and fantasy-only. `espn_s2` is the user's ESPN session.
  Storing it means storing something far more powerful than the task needs —
  which sits badly against the rule that this project holds **no** browser
  cookies anywhere.
- **The endpoints can change without notice and without recourse.** There is no
  contract to breach and no deprecation window. A working integration can stop
  on any Tuesday.
- **Terms are a real question, not a formality.** Reading an app's private API
  is not the same as scraping HTML, but it is also not sanctioned access. This
  needs an explicit decision from Keith before any code is written — not an
  assumption inherited from the Yahoo work.

**How the boundary absorbs it, CONFIRMED not just planned:** everything ESPN-
specific is confined to `providers/espn/{client,auth,constants,parse,adapter}.py`.
`EspnProvider` implements the `FantasyProvider` ABC and returns the same row
dicts Yahoo does. The loader (`d1.py`), the quality checks, and the CLI needed
**zero ESPN-specific changes** beyond dispatching on `--platform` in
`_build_provider` — the exact validation this document predicted.

**The credential-storage question was resolved more simply than predicted.**
The original text here proposed reusing `fantasy_oauth_tokens` with a
`key_version` variant or a sibling table. What was actually built: **neither**.
ESPN cookies are NOT stored in D1 at all in this pass — they're sourced
directly from the macOS Keychain via the same shared
`pipelines/fantasy/keychain.py` helper Yahoo's `client_id`/`client_secret` use
(promoted out of `providers/yahoo/oauth.py` specifically because ESPN needed
the identical pattern). This is simpler than a cookie ever touching D1 — no
encryption-at-rest question to solve, no `fantasy_oauth_tokens` row shaped
wrong for a cookie pair, no ciphertext to protect. The tradeoff: cookies are
per-machine (Keychain, not centrally stored), so a CI-driven ESPN sync would
need `ESPN_SWID`/`ESPN_S2` as GitHub Actions secrets instead — not yet wired,
since this pass has no scheduled ESPN workflow (see "not shipped" below).

**Also confirmed: ESPN's numeric ids are structurally simpler than Yahoo's.**
`lineupSlotId` (starter/bench/IR) is a **fixed global enum**, identical in
every league — unlike Yahoo, where which position *labels* are bench-like is
configured per league. This means `is_starter` derives directly from
`constants.BENCH_SLOT_IDS`/`INJURY_SLOT_IDS` with **no need to fetch this
league's own roster-position settings first** — `fetch_league_settings` is
consequently one of the methods NOT built in this pass (see below), and it
genuinely doesn't block starter derivation the way it would for Yahoo.

**Columns confirmed NULL for ESPN in this pass** (observed, not predicted —
several corrected from the original guess):

| Table.column | Confirmed reality |
|---|---|
| `fantasy_league_seasons.renew_key` / `renewed_key` | Correct as predicted — ESPN's `discover_leagues()` isn't built (raises `NotImplementedInThisPass`; no account-wide discovery endpoint exists), and there's no renewal-chain idiom to populate these from. |
| `fantasy_draft_events.*` (whole table) | **Not populated at all this pass** — `fetch_draft_results` raises `NotImplementedInThisPass`. ESPN's `mDraftDetail` view is confirmed to exist (per community docs) but is unparsed. |
| `fantasy_transactions.*` / `fantasy_transaction_assets.*` | **Not populated at all this pass** — same reasoning; a transactions view exists (`ACTIVITY_MAP` in the reference client) but is unparsed. |
| `fantasy_managers.display_name` | **CORRECTED from the original guess.** The modern `owners` array is bare GUID strings with no embedded display name in the confirmed shape — `display_name` is NOT better populated than Yahoo's; it is simply absent for ESPN in this pass. |
| `fantasy_standings_snapshots.rank` / `playoff_seed` | Not in the original prediction table — added after implementation. ESPN's team object does not expose a confirmed "current rank" field; sorting to compute one would be a real calculation presented as a fact, which the `is_inferred` discipline exists to prevent. Left NULL, not computed. |
| `fantasy_matchups.is_playoffs` | Added after implementation. `playoffTierType` is stored verbatim, but its enum values (`NONE`? `WINNERS_BRACKET`? — genuinely unconfirmed, a web search only echoed back the query terms) are not confirmed, so the derived boolean is not guessed at. |
| `fantasy_matchups.recap_url` / `recap_title` | Correct as predicted — Yahoo-specific surface. |

**Not shipped this pass** (deliberately, not silently): `fetch_league_settings`
(scoring rules — not needed for starter derivation on this platform, see
above; would only add value for points reconstruction, and this pass captures
ESPN's own pre-computed `appliedStatTotal` instead), `fetch_players` (full
player-universe pagination via `kona_player_info`), a scheduled sync workflow
(no `.github/workflows/espn-fantasy-sync.yml` yet, unlike Yahoo's), and a
`docs/espn_api_coverage_matrix.md` / `docs/DATA_AUTHORITY_MAP.md` §C row for
ESPN specifically (the Yahoo row there does not cover ESPN).

### CBS

| Dimension | CBS |
|---|---|
| Auth | A **partner API requiring approval**, plus a per-application key. Not self-serve. |
| Contract | A real one, if approval is granted — which is the meaningful difference from ESPN. |
| Response shape | Documented JSON. Expected to be the most conventional of the three. |
| Historical depth | Unknown until access exists. |
| Rate limits | Unknown; assume undocumented and pace conservatively. |

**The blocker for CBS is approval, exactly as it is for Yahoo** — and the same
lesson applies: **submit the application early and do not build against an
assumed grant.** Unlike ESPN, a CBS integration would rest on sanctioned access
with a support path, which makes it the *better* second platform to add if
Keith has a CBS league worth ingesting.

**Columns expected to be NULL for CBS:** genuinely unknown until access exists.
Filling this in from guesswork would be exactly the fabrication the interface
forbids. It gets written after the first real payload, not before.

---

## Per-platform risk notes

### Yahoo (current)

- **Access approval is the blocker**, with no published SLA and no appeal step.
- Whether an existing YDN app is grandfathered is **undocumented**. Do not
  assume it.
- `?format=json` is undocumented; the raw archive is the mitigation.
- Blocks are per `client_id` and last minutes to hours.

### ESPN

- **Highest ongoing operational risk of the three.** Cookie expiry is manual to
  fix, undocumented in timing, and breaks every scheduled run until a human
  intervenes.
- **Highest legal ambiguity.** No terms grant this access. Needs an explicit
  decision before any code exists.
- **Highest breakage risk.** Unversioned private endpoints, no deprecation
  policy, no notice.
- **Security posture cost.** Storing a full-account session cookie contradicts
  the current rule that no browser cookie is stored anywhere.
- **Mitigation, if it proceeds:** treat it as best-effort and non-critical.
  Never let an ESPN failure downgrade a Yahoo run. Its completeness rows should
  read `failed` loudly and often rather than pretending stability the mechanism
  does not have.

### CBS

- **Approval may simply not be granted** for a personal use case, and there is
  less community documentation than for the other two.
- **Effort is unknowable until access exists**, so do not put it on a roadmap
  with an estimate attached.
- **Lowest ongoing risk if approved**, because a sanctioned key with documented
  endpoints is a fundamentally more stable object than a scraped cookie.

---

## Recommended order

**⚠️ REVISED 2026-08-12, at Keith's direction — the order below is what was
originally recommended, kept for the reasoning; what actually happened is
noted under each step.**

1. **Prove Yahoo against live payloads.** Until the abstraction has survived one
   real API, it is a hypothesis. Every fixture is synthetic.
   *What happened:* Yahoo's access application is submitted and pending (no
   published SLA; the confirmation email says "typically 1-2 weeks"). No live
   payload has flowed yet — blocked entirely on Yahoo's review, not on
   anything in this codebase.
2. **Then CBS, if a league exists worth ingesting** — sanctioned access, a real
   contract, and the cleanest test of whether the boundary actually holds.
   *What happened:* Keith has a real CBS league, but CBS's approval process is
   unresearched and would likely mean a THIRD parallel "submit and wait,"
   exactly like Yahoo's. Not started.
3. **ESPN last, and only with an explicit decision from Keith** on the cookie
   question. It is the platform most likely to work on day one and least likely
   to still be working a year later.
   *What happened:* built FIRST among the two waiting platforms, precisely
   BECAUSE it needs no approval queue — while Yahoo and (likely) CBS sit in
   review, ESPN is the one platform where work can proceed today. The cookie
   question was raised with Keith before any code was written (see the ESPN
   section above); he confirmed he has a real ESPN league and asked for "the
   lighter first pass." The original ordering logic (durability, legal
   clarity) still holds for a *production-grade, full-parity* build — it just
   doesn't determine what's worth prototyping while two other platforms wait
   on human review outside this codebase's control.

---

## What a new adapter must ship with

Not optional, because the pipeline's guarantees are only as strong as the
weakest adapter. **ESPN's status against each item, as of this lighter first
pass:**

- `providers/<name>/` with client, shape normalizer, parsers, adapter. —
  ✅ shipped, **minus the shape normalizer**: ESPN's confirmed JSON shape is
  real arrays/objects throughout, with none of Yahoo's numeric-string-keyed
  collection pathology, so `parse.py` reads field paths directly and no
  `shape.py`-equivalent module exists. A deliberate, documented simplification,
  not an oversight — see the ESPN section above.
- **Synthetic fixtures** under `tests/fixtures/<name>/`, each carrying a header
  saying it is synthetic — matching the Yahoo convention exactly. —
  ✅ shipped: 2 fixtures under `tests/fixtures/espn/`, each with a `_comment`
  provenance block naming the exact community source the shape was transcribed
  from.
- Cases in `tests/test_fantasy_pipeline.py` covering, at minimum: **NULL is not
  zero**, **an unreadable payload raises rather than returning empty**, **no
  fixture parses to zero rows**, and **every parsed row carries the right
  `platform`**. —
  ✅ shipped, **in a separate file**: `tests/test_espn_pipeline.py` (67
  checks), not folded into the Yahoo file — a smaller adapter earns a smaller,
  separately-readable test file rather than growing an already-large one.
  Covers all four required cases plus ESPN's own critical invariant: every
  not-yet-built resource (`fetch_draft_results`, `fetch_transactions`,
  `fetch_players`, `fetch_league_settings`, `discover_leagues`) **raises**
  `NotImplementedInThisPass` rather than returning an empty, `complete=False`
  result — which is the shape reserved for "the platform doesn't offer this,"
  and would be a lie here.
- A `resource_supported()` implementation that is **honest about the gaps** —
  every `False` becomes a `not_exposed` completeness row someone will read
  later. — ✅ shipped.
- A coverage-matrix document in the shape of
  `docs/yahoo_api_coverage_matrix.md`, including the "visible on the website but
  not in the API" section. — ❌ **NOT shipped this pass.** Genuinely deferred,
  not silently skipped — flagged here so it isn't mistaken for done.
- A row in `docs/DATA_AUTHORITY_MAP.md` §C. — ❌ **NOT shipped this pass.**
  Only the Yahoo row exists there.
- Confirmation that `scripts/check_fantasy_isolation.py` scans the new
  directory. — ✅ confirmed: the guard's own scan count rose from 20 files to
  27 the moment `providers/espn/` and the promoted `keychain.py` landed, with
  no changes needed to the guard itself (it globs `pipelines/fantasy/**/*.py`).
