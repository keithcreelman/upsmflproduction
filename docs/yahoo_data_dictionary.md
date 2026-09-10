# Yahoo / Multi-Platform Fantasy — Data Dictionary

**Status:** schema written, migrations 0127–0132 **unapplied** as of writing
**Covers:** all 35 tables created by `worker/migrations/0127…0132`, plus the one
additive column added to the pre-existing `ff_player_ids`
**Companion docs:** `docs/yahoo_fantasy_ingestion.md` (how it is filled),
`docs/yahoo_api_coverage_matrix.md` (what can and cannot be filled)

⚠️ **No live Yahoo API call has been made.** Every column below is described
from the migration source and from the synthetic fixtures under
`tests/fixtures/yahoo/`. Column *meanings* are what the schema commits to;
whether Yahoo actually populates a given field is answered in the coverage
matrix, not here.

---

## Conventions that apply to every table

**`platform` is the first column of every composite primary key.** Values are
lowercase and closed: `'yahoo'` | `'cbs'` | `'espn'`. Adding a second platform
needs no schema change and cannot collide.

**`season` is INTEGER everywhere, deliberately.** The `ups_*` family is split
between TEXT and INTEGER, and a silent TEXT/INTEGER mismatch in SQLite returns
**zero rows with no error** — that exact failure already bit the cross-season
`contract_status` joins. This family commits to INTEGER and casts at every
boundary.

**No foreign keys.** D1 does not enforce them by default; joins go by convention
on `(platform, league_key, season, …)`.

**Provider vocabulary is stored VERBATIM.** Statuses, draft types, waiver rules
and position labels are never normalized on ingest. Cross-season vocabulary
drift is a known silent-failure class here, and normalizing hides it.

### The four NULL rules — read these before writing any query

| Rule | What it means |
|---|---|
| **NULL means "the provider did not say."** | It does not mean zero, and it does not mean false. `uses_faab IS NULL` is a different fact from `uses_faab = 0`. |
| **NULL is never coerced to 0.** | `auction_cost`, `faab_bid`, `faab_balance`, `modifier`, `stat_value` and `points_provider` are all nullable **and** legitimately zero-valued. Collapsing the two destroys facts nothing downstream can rebuild. |
| **A derived value never occupies a "provider said so" column.** | `is_keeper` stays NULL and the inference lands in `keeper_inferred` + `keeper_inference_basis`. `is_starter` is derived and documented as such. `is_inferred` on standings is NOT NULL with no default. |
| **An unreadable read is not an empty one.** | Absence of rows means the provider said there were none. Failures land in `fantasy_api_errors` and downgrade the run to `partial`/`failed`. |

### Columns that recur everywhere

| Column | Meaning |
|---|---|
| `source_run_id` | The `fantasy_sync_runs.run_id` that last wrote this row. NULL only for rows written outside a run. |
| `raw_*_json` | The provider's own object for this row, verbatim, so a reparse never needs a re-fetch. |
| `unmapped_fields` | JSON array of field paths the parser **saw but did not map**. Not decoration — a provider that adds a field without notice is otherwise indistinguishable from a parser that handled it. |
| `updated_at_utc` / `fetched_at_utc` | `datetime('now')` defaults. |

---

# Migration 0127 — control plane, provenance, raw payloads, OAuth

## 1. `fantasy_sync_runs`

**Purpose:** one row per invocation of `discover` / `backfill` / `sync` / `auth`
/ `quality`. This is the run ledger the whole pipeline reports into. It is
**not** `etl_runs`, which holds exactly one overwritten row per source and so
cannot answer "what did the 2019 backfill actually do". Both are written.

**Primary key:** `run_id` (caller-generated, unique per invocation)

| Column | Meaning / NULL semantics |
|---|---|
| `run_id` | Caller-generated unique id. |
| `platform`, `mode` | `mode` ∈ `'discover'`,`'backfill'`,`'sync'`,`'auth'`,`'quality'`. |
| `league_key` | **NULL for discovery runs** — there is no league yet. |
| `season`, `week` | **NULL when the run spans seasons / weeks.** |
| `requested_scope` | JSON: the exact arguments the run was asked for. |
| `started_at_utc` | Defaults to now. |
| `finished_at_utc` | **NULL while running, and still NULL after a crash — that is itself the signal.** |
| `status` | `'running'`\|`'ok'`\|`'partial'`\|`'failed'`. |
| `rows_inserted`, `rows_updated`, `rows_unchanged` | **`rows_unchanged` is tracked separately on purpose.** An UPSERT that rewrites a row with identical values is not evidence the sync worked; 4,000 unchanged and 0 inserted on a fresh season is a red flag, not a success. |
| `api_calls`, `api_retries`, `error_count` | Counters, NOT NULL default 0. |
| `completeness_status` | Rollup of `fantasy_data_completeness` for this run's scope. |
| `parser_version` | NOT NULL — so a reparse can find every row a given parser wrote. |
| `runner_host` | `'github-actions'` or the local hostname. |
| `notes` | Prose. |

## 2. `fantasy_data_completeness`

**Purpose:** the honest answer to "do we have this?", one row per
(league-season, resource).

**Primary key:** `(platform, league_key, season, resource)`

`resource` ∈ `settings`, `teams`, `draft`, `transactions`, `rosters`,
`matchups`, `standings`, `players`, `player_week_stats`, `player_week_points`.

**The `status` vocabulary is closed, and each value means something different:**

| Status | Meaning |
|---|---|
| `complete` | The platform exposes it and we captured all of it. |
| `partial` | Exposed; we captured some of it. |
| `not_exposed` | **The API does not offer this. The website may still show it.** |
| `access_denied` | The API offers it but this token cannot see it (private league the account never played). Permanent, not retryable. |
| `not_applicable` | The concept does not exist for this league — e.g. FAAB in a waiver-priority league. **Not the same as missing.** |
| `failed` | We tried, the attempt errored, and it is retryable. |
| `inferred` | The value was **RECONSTRUCTED by us**, not read from the API. |

| Column | Meaning / NULL semantics |
|---|---|
| `expected_units` / `observed_units` | e.g. weeks expected vs captured. Either may be NULL when unknown; an `expected_units` that is set with `observed_units` NULL classifies as **`failed`**, not complete. |
| `row_count`, `first_week`, `last_week` | Observed. |
| `is_inferred` | NOT NULL default 0. 1 = values were reconstructed. |
| `missing_notes` | Prose: **what** is missing and **why**. |
| `last_run_id`, `checked_at_utc` | Provenance. |

## 3. `fantasy_api_errors`

**Purpose:** append-only error ledger. It is a table and not a log line because
Yahoo's throttle arrives as HTTP 999 with an HTML body — a client that parses
before checking status turns that into an exception, and a client that catches
broadly turns it into an empty collection, silently writing "this league had no
transactions in 2021". **Every non-2xx and every unparseable body lands here as
evidence.**

**Primary key:** `id` (AUTOINCREMENT)

| Column | Meaning / NULL semantics |
|---|---|
| `run_id`, `platform`, `resource` | Context. |
| `endpoint_path` | **Redacted** — query-string secrets stripped. |
| `league_key`, `season`, `week` | Scope; NULL where not applicable. |
| `http_status` | **NULL for transport-level failures** (no response at all). |
| `error_kind` | `'rate_limited'`\|`'auth'`\|`'not_found'`\|`'unparseable'`\|`'transport'`\|`'server'`\|`'unknown'`. |
| `attempt`, `is_retryable` | Retry bookkeeping. |
| `message` | **REDACTED before insert.** Access tokens, refresh tokens, authorization codes and the client secret must never reach this table. |
| `occurred_at_utc` | Defaults to now. |

## 4. `fantasy_league_seasons`

**Purpose:** the league registry **and** the manual-override table. A Yahoo
league key is `{game_key}.l.{league_id}` and the game key changes every season
(2014=331, 2019=390, 2020=399, 2025=461 — the documented ones), so the same
league in a different season is a different key. When automatic discovery cannot
connect a historical season, a row is **inserted here by hand** with
`discovery_source='manual'` and the backfill picks it up unchanged. That is the
documented path for adding league keys later, not a workaround.

**Primary key:** `(platform, league_key)`

| Column | Meaning / NULL semantics |
|---|---|
| `league_key` | **Canonical numeric form** `'{numeric_game_id}.l.{league_id}'`. Sending the code form (`'nfl.l.576919'`) makes Yahoo rewrite it silently and produces phantom duplicates. |
| `league_uid` | Groups this season with the same league's other seasons (see `fantasy_leagues`). NULL until the chain is minted. |
| `season`, `game_key`, `league_id` | `game_key` is the numeric game id as TEXT, e.g. `'461'`. |
| `game_code` | `'nfl'` — season-independent, **never a key**. |
| `league_name`, `league_url`, `num_teams` | Descriptive. |
| `draft_type`, `scoring_type`, `league_type` | Platform vocabulary, **verbatim**. |
| `is_auction_draft` | 1/0/**NULL — NULL means the platform did not say.** |
| `start_week`, `end_week`, `current_week` | Calendar bounds. |
| `renew_key` / `renewed_key` | Yahoo's own cross-season links, canonicalized from its native `'{game_id}_{league_id}'` form. Walking `renew_key` backwards catches seasons the user-login query misses. |
| `my_team_key` | The authenticating user's team in this league-season. |
| `discovery_source` | NOT NULL: `'users_games_leagues'`\|`'renew_chain'`\|`'manual'`\|`'seed'`. |
| `is_accessible` | 1 = this token can read it; 0 = access denied; **NULL = untested.** |
| `backfill_status` | `'pending'`\|`'in_progress'`\|`'complete'`\|`'partial'`\|`'failed'`\|`'inaccessible'`. |
| `notes`, `added_at_utc`, `updated_at_utc` | |

## 5. `raw_yahoo_api_responses`

**Purpose:** the verbatim payload **index**. Without it, every parser
improvement means re-requesting fifteen seasons from a rate-limited API that
answers throttling with HTTP 999.

**Primary key:** `id` (AUTOINCREMENT), with **`UNIQUE(request_key,
response_hash)`** as the real idempotency contract — same request + same content
= one row, forever; changed content = a new row and history preserved.

| Column | Meaning / NULL semantics |
|---|---|
| `request_key` | `sha256(resource ‖ canonicalized params)`. Stable across runs. |
| `resource` | Logical name, e.g. `'league.settings'`, `'team.roster'`. |
| `endpoint_path` | The request URI, **secrets stripped**. |
| `request_params` | JSON, canonicalized (sorted keys). |
| `league_key`, `team_key`, `player_key`, `season`, `week` | Scope; NULL where the request had none. |
| `http_status`, `content_type` | Recorded **before** parsing. |
| `payload` | The inline body — **small responses only**; NULL otherwise. D1 caps a statement at ~100KB and escaping roughly doubles a wide statement; a build already died here with `statement too long: SQLITE_TOOBIG` and landed **zero rows**. |
| `payload_bytes` | NOT NULL. Real size regardless of sink. |
| `payload_sink` | `'d1'` (inline) \| `'r2'` (`payload_ref` = R2 key) \| `'file'` (`payload_ref` = archive path) \| **`'none'` (retention pruned the body; the index row survives)**. |
| `payload_ref` | NULL when `payload_sink='d1'` or `'none'`. |
| `response_hash` | SHA-256 hex of the raw body. |
| `parser_version` | Which parser last touched it — drives reparse targeting. |
| `unmapped_fields` | JSON array of field paths seen but not mapped. |
| `run_id` | |

**The index row is ALWAYS written regardless of sink**, so provenance never
depends on the payload still being around.

## 6. `fantasy_oauth_tokens`

⚠️ **The only table in the database that holds credential material.**

**Purpose:** encrypted refresh-token storage. A Cloudflare Worker cannot rotate
its own secrets, Yahoo may return a **new refresh token on any refresh** which
must be persisted or access is lost permanently, and there is no KV binding in
this project — so D1 is the only durable store, which makes encryption
mandatory rather than nice.

**Primary key:** `(platform, account_key)`

| Column | Meaning / NULL semantics |
|---|---|
| `account_key` | An opaque local label, e.g. `'primary'`. **NOT an email address.** |
| `refresh_token_ciphertext` | base64 AES-256-GCM ciphertext + tag. Key lives **only** in the `YAHOO_TOKEN_ENCRYPTION_KEY` Worker secret — never in this table, never in git. |
| `token_iv` | base64 96-bit nonce, **unique per write**. A reused GCM nonce is a total break. |
| `key_version` | Lets the encryption key rotate without a migration. |
| `scope` | Granted scope, e.g. `'fspt-r'`. |
| `yahoo_guid` | Stable account id. **NOT an email.** |
| `obtained_at_utc`, `last_refreshed_at_utc` | `last_refreshed_at_utc` NULL until the first refresh. |
| `last_refresh_status` | `'ok'`\|`'invalid_grant'`\|`'error'` — surfaces a dead token *before* a sync fails. |
| `refresh_failure_count` | |
| `revoked_at_utc` | Set on `invalid_grant`. **A revoked row is kept, not deleted.** |

**Never stored anywhere:** Yahoo passwords, verification/MFA codes, browser
cookies, the account email address. The **access** token is deliberately not
persisted — it lives one hour and is cheap to re-mint.

## 7. `fantasy_oauth_states`

**Purpose:** short-lived CSRF state for the authorization redirect. Rows are
single-use and expire. The callback **refuses** any state it cannot find or
that has already been consumed; it does not fall back to "no state supplied,
probably fine".

**Primary key:** `state`

| Column | Meaning / NULL semantics |
|---|---|
| `state` | 256 bits of CSPRNG, base64url. |
| `platform`, `account_key` | |
| `nonce` | Stored NULL on purpose — this is a non-OIDC flow. |
| `redirect_uri` | Echoed back at token exchange; **Yahoo byte-matches it**, so the value used at `/auth/start` is persisted here rather than re-read from config. |
| `created_at_utc`, `expires_at_unix` | 10-minute lifetime. |
| `consumed_at_utc` | **Non-NULL = already used; replay is refused.** |

---

# Migration 0128 — league continuity, settings, scoring, slots

## 8. `fantasy_leagues`

**Purpose:** the league as a **continuity** across every season it ran — the
thing a human means by "my league". `league_uid` is a **locally minted**
identifier we never change, precisely because the platform's own key embeds the
game key and therefore differs every season.

**Primary key:** `(platform, league_uid)`

| Column | Meaning / NULL semantics |
|---|---|
| `league_uid` | Locally minted, stable forever. |
| `display_name` | Most recent season's league name. Presentation only. |
| `first_season`, `last_season`, `season_count` | Derived from the member rows. |
| `seed_league_key` | The key the chain was discovered from. |
| `provider_account` | Which `fantasy_oauth_tokens.account_key` can read it. |
| `notes`, `created_at_utc`, `updated_at_utc` | |

## 9. `fantasy_league_settings`

**Purpose:** one row per league-season, holding the settings every analytical
question depends on. ~40 columns — deliberately well under D1's **hard
100-column-per-table cap**, which `nfl_player_weekly` hit exactly and is now
permanently frozen (`ALTER TABLE` fails with `SQLITE_ERROR` once you reach it).
Anything further goes in a 1:1 `_ext` companion.

**Primary key:** `(platform, league_key, season)`

⚠️ **NULL means "the platform did not say." It does not mean zero and it does
not mean false.**

| Group | Columns | Notes |
|---|---|---|
| Identity | `league_name`, `league_url`, `logo_url`, `league_type`, `num_teams`, `max_teams` | `league_type` = `'private'`\|`'public'`. |
| Calendar | `start_week`, `end_week`, `current_week`, `start_date`, `end_date`, `is_finished`, `weekly_deadline`, `league_update_timestamp_unix` | Dates are `'YYYY-MM-DD'` **as given — no timezone is documented**. `weekly_deadline` is roster-lock behaviour, verbatim. |
| Draft | `draft_status`, `draft_type`, `is_auction_draft`, `draft_time_unix`, `draft_pick_time_sec`, `post_draft_players` | `draft_status` = `'predraft'`\|`'drafted'`\|`'postdraft'`. `draft_type` and `post_draft_players` (e.g. `'W'`) are verbatim. |
| Scoring / transactions | `scoring_type`, `uses_fractional_points`, `uses_negative_points`, `waiver_type`, `waiver_rule`, `waiver_time_days`, `uses_faab`, **`faab_budget`**, `trade_end_date`, `trade_ratify_type`, `trade_reject_time_days`, `max_acquisitions`, `max_weekly_acquisitions`, `max_trades`, `player_pool`, `cant_cut_list` | **`faab_budget` is NULL when the platform does not expose it — never 0.** `max_acquisitions` NULL = uncapped **or** unexposed. `waiver_type`/`waiver_rule`/`player_pool`/`cant_cut_list` verbatim. `trade_ratify_type` = `'vote'`\|`'commish'`\|`'none'`. |
| Playoffs | `uses_playoff`, `playoff_start_week`, `num_playoff_teams`, `num_playoff_consolation_teams`, `has_playoff_consolation_games`, `uses_playoff_reseeding`, `uses_lock_eliminated_teams`, `has_multiweek_championship` | `playoff_start_week` is what keeps postseason results out of reconstructed regular-season records. |
| Keepers / divisions | **`uses_keepers`**, `num_keepers`, `uses_divisions`, `num_divisions` | **`uses_keepers` is NULL when not exposed** — see the keeper-inference note on `fantasy_draft_events`. |
| Provenance | `raw_settings_json`, `unmapped_fields`, `source_run_id`, `fetched_at_utc`, `updated_at_utc` | |

## 10. `fantasy_scoring_rules`

**Purpose:** one row per scoring stat per league-season. Scoring is a table and
not a JSON blob because a blob cannot be joined, cannot be diffed across
seasons, and cannot answer "when did the TE premium change".

**Primary key:** `(platform, league_key, season, stat_id)`

| Column | Meaning / NULL semantics |
|---|---|
| `stat_id` | The platform's own numeric id, as TEXT. **The join key.** Yahoo's stat_id set changes between game keys, so the pair is stored per season rather than in a global dictionary. |
| `stat_name`, `stat_display_name`, `stat_abbr`, `stat_group` | Human-readable; `stat_group` is the provider grouping, verbatim. |
| `position_type` | `'O'`\|`'K'`\|`'DT'`\|`'DP'` etc., verbatim. |
| `applies_to_positions` | JSON array of positions, **or NULL for all**. |
| **`modifier`** | Points per unit, REAL. ⚠️ **NULL = the stat is tracked/displayed but NOT SCORED. That is a different claim from `0.0`, which means scored and worth nothing.** Collapsing the two makes "does this league score first downs" unanswerable. |
| `is_enabled`, `is_display_only` | `is_display_only` = tracked for display, never scored. |
| `sort_order`, `raw_stat_json`, `source_run_id`, `updated_at_utc` | |

⚠️ **Never import UPS scoring here.** The UPS league's PPR-by-position values
are MFL rules with nothing to do with this league. Every points calculation
must read this table for the matching `(platform, league_key, season)` and
**fail rather than fall back to a default** when rows are missing.

## 11. `fantasy_scoring_bonuses`

**Purpose:** threshold bonuses, kept separate from linear scoring. A bonus
fires once when a stat crosses a target (e.g. +3 at 100 rushing yards) rather
than accruing per unit; modelling it as a scoring rule makes every points
reconstruction wrong **at the threshold**.

**Primary key:** `(platform, league_key, season, bonus_id)`

| Column | Meaning / NULL semantics |
|---|---|
| `bonus_id` | The provider's id, or a deterministic `'<stat_id>:<target>'` when it has none. |
| `stat_id`, `stat_name` | Which stat the threshold is measured on. |
| `target_value` | The threshold that must be reached, REAL. |
| `bonus_points` | REAL. |
| `position_type` | Verbatim. |
| `raw_bonus_json`, `source_run_id`, `updated_at_utc` | |

## 12. `fantasy_roster_positions`

**Purpose:** the starting-lineup requirement, per season. **Load-bearing:**
Yahoo has no `is_started` field, so starter status is derived from whether a
player's lineup slot is bench-like — and the set of bench-like slots is
**league-defined** (`BN`, `IR`, `IR+`, `IR-R`, `NA`, and whatever else a
commissioner configures). Hardcoding `{'BN','IR'}` would silently count `IR+`
players as starters.

**Primary key:** `(platform, league_key, season, position)`

| Column | Meaning / NULL semantics |
|---|---|
| `position` | `'QB'`, `'RB'`, `'W/R/T'`, `'BN'`, `'IR'` — **verbatim**. |
| `position_type` | `'O'`\|`'K'`\|`'DT'`\|`'DP'` etc. |
| `slot_count` | NOT NULL. How many of this slot the lineup has. |
| **`is_starting_slot`** | NOT NULL. **Computed once, here, from this league's own slot list.** Every starter/bench query reads this rather than pattern-matching a position string. |
| `is_bench_slot`, `is_injury_slot`, `is_flex_slot` | NOT NULL default 0. |
| `flex_positions` | JSON array of eligible positions for a flex slot; NULL for non-flex. |
| `sort_order`, `raw_position_json`, `source_run_id`, `updated_at_utc` | |

## 13. `fantasy_divisions`

**Purpose:** present only in divisioned leagues. **Absence of rows means "this
league-season had no divisions"**, recorded as `not_applicable` in
`fantasy_data_completeness` rather than as a gap.

**Primary key:** `(platform, league_key, season, division_id)`

| Column | Meaning |
|---|---|
| `division_id`, `division_name` | |
| `raw_division_json`, `source_run_id`, `updated_at_utc` | |

## 14. `fantasy_schedule_periods`

**Purpose:** one row per scoring week, so backfill loops are bounded by **data
rather than by a hardcoded 17**. Season length changed (the NFL moved to 18
weeks in 2021) and playoff start weeks vary by league-season; a constant-bounded
loop silently skips real weeks in some seasons and requests non-existent ones in
others.

**Primary key:** `(platform, league_key, season, week)`

| Column | Meaning / NULL semantics |
|---|---|
| `week_start`, `week_end` | `'YYYY-MM-DD'` as given. |
| `is_playoff`, `is_consolation`, `is_championship` | NOT NULL default 0. **These are what keep playoff results out of regular-season records when standings are reconstructed.** |
| `status` | `'preevent'`\|`'midevent'`\|`'postevent'`, verbatim. |
| `source_run_id`, `updated_at_utc` | |

---

# Migration 0129 — teams, managers, players

## 15. `fantasy_teams`

**Purpose:** one row per team per league-season.

**Primary key:** `(platform, team_key)` — `team_key` already encodes
platform+game+league+team, so it alone is unique. `league_key` and `season` are
carried as columns because every analytical query filters on them and a `LIKE`
against a composite string is not an index.

| Column | Meaning / NULL semantics |
|---|---|
| `team_key` | `'{game_key}.l.{league_id}.t.{team_id}'`. |
| `team_id` | The within-league team number, as TEXT. |
| `team_name`, `team_url`, `logo_url`, `division_id` | `division_id` NULL in undivisioned leagues. |
| `is_owned_by_current_login` | 1 = the authenticating user's team. |
| `name_history` | JSON array of every `team_name` observed. **Yahoo exposes only the CURRENT name**, so a mid-season rename is otherwise invisible. The array is appended to, never replaced. |
| `raw_team_json`, `unmapped_fields`, `source_run_id`, `first_seen_at_utc`, `updated_at_utc` | |

## 16. `fantasy_managers`

**Purpose:** one row per human, across every league and season.

**Primary key:** `(platform, manager_uid)`

| Column | Meaning / NULL semantics |
|---|---|
| `manager_uid` | The provider's **stable account GUID**. The only safe join key — team names and nicknames change every season. |
| `display_name` | Latest nickname, **presentation only, explicitly not a key**. ⚠️ **`'--hidden--'` is a legal value** that Yahoo returns for managers who have not made their nickname public, and several distinct managers can carry it simultaneously. |
| `name_history` | JSON array of observed nicknames. |
| `image_url`, `first_season`, `last_season` | |
| `raw_manager_json`, `source_run_id`, `created_at_utc`, `updated_at_utc` | |

⚠️ **Manager email addresses are NOT stored**, even though the provider returns
them for the authenticating user's own record — nothing needs them and storing
them would put personal data in an hourly R2 snapshot.

## 17. `fantasy_team_managers`

**Purpose:** which humans ran which team, in which season. A join table rather
than a `manager_uid` column on `fantasy_teams`, because **co-managers exist** —
flattening would silently drop one.

**Primary key:** `(platform, team_key, manager_uid)`

| Column | Meaning |
|---|---|
| `league_key`, `season` | Carried for filtering. |
| `nickname_at_time` | What they were called **that** season. |
| `is_commissioner`, `is_comanager` | NOT NULL default 0. |
| `source_run_id`, `updated_at_utc` | |

## 18. `fantasy_team_season_state`

**Purpose:** the mutable per-team counters, separated from `fantasy_teams`
because these change during a season while the team's identity does not.
Captured on every sync; the row reflects the **most recent observation** and
`captured_at_utc` says when.

**Primary key:** `(platform, team_key)`

| Column | Meaning / NULL semantics |
|---|---|
| `waiver_priority` | ⚠️ **Current only.** The provider exposes no history, so priority-over-time can only be inferred from the transaction sequence and must be labelled inferred. |
| **`faab_balance`** | ⚠️ **NULL = NOT EXPOSED, never "zero left".** Yahoo documents `faab_bid` only as a *write* input; whether a remaining-budget field comes back on a GET is unverified. The difference matters enormously for waiver analysis. |
| `number_of_moves`, `number_of_trades`, `roster_adds_week`, `roster_adds_value` | Provider counters. |
| `draft_position` | |
| `draft_grade`, `has_draft_grade`, `draft_recap_url` | Provider **team-level** letter grade, e.g. `'B-'`. Per-*pick* grades are not available — see the coverage matrix. |
| `clinched_playoffs` | |
| `captured_at_utc`, `source_run_id` | |

## 19. `fantasy_players`

**Purpose:** the player universe — **every player the pipeline has ever seen**,
not just current rosters: drafted, rostered, transacted, on any historical
weekly roster, and free agents as pagination allows. **A draft pick whose player
is missing here is a data-quality failure, not an acceptable gap.**

**Primary key:** `(platform, player_uid)`

| Column | Meaning / NULL semantics |
|---|---|
| `player_uid` | The **season-INDEPENDENT** provider key, e.g. `'nfl.p.30121'`. Yahoo's `player_key` is season-scoped (`'390.p.30121'` in 2019, `'461.p.30121'` in 2025) because the game key is embedded; the numeric tail happens to match across seasons today, but that is a property of Yahoo's numbering, not a documented guarantee. |
| `provider_player_id` | The bare numeric id, e.g. `'30121'`. |
| `full_name`, `first_name`, `last_name`, `ascii_first_name`, `ascii_last_name` | |
| `normalized_name` | Lowercase, punctuation/suffix stripped — **for FALLBACK matching only**, never sufficient alone. |
| `display_position`, `primary_position`, `position_type` | Latest seen; `position_type` verbatim. |
| `uniform_number` | |
| `editorial_team_key` | Season-independent NFL team key. |
| `editorial_team_abbr`, `editorial_team_full` | **Latest seen** — tells you nothing about a 2016 roster. |
| `headshot_url`, `image_url`, `is_undroppable` | |
| `first_season_seen`, `last_season_seen` | |
| `raw_player_json`, `unmapped_fields`, `source_run_id`, `created_at_utc`, `updated_at_utc` | |

Season-varying facts live in `fantasy_player_eligibility` and
`fantasy_player_status_snapshots`, not here.

## 20. `fantasy_player_identifiers`

**Purpose:** every id this player has carried, including per-season keys. A tall
table because the set of identifier kinds is open-ended and differs by platform;
a column per kind would need a migration every time one appears.

**Primary key:** `(platform, player_uid, id_type, id_scope)`

| Column | Meaning / NULL semantics |
|---|---|
| `id_type` | `'player_key'`\|`'player_id'`\|`'gsis_id'`\|`'mfl_id'`\|`'pfr_id'`\|… |
| `id_scope` | **The season as TEXT for season-scoped ids (`'2025'`), and the empty string `''` for season-independent ones.** It is part of the key so the 2019 and 2025 `player_key`s coexist rather than overwriting. |
| `id_value` | NOT NULL. |
| `id_source` | Who asserted it: `'yahoo_api'`\|`'ff_player_ids'`\|`'manual'`. |
| `confidence` | `'exact'`\|`'fuzzy_auto'`\|`'fuzzy_review'`\|`'manual'`\|`'unmapped'`. |
| `source_run_id`, `updated_at_utc` | |

## 21. `fantasy_player_eligibility`

**Purpose:** which slots a player could fill, **per season** — because
eligibility genuinely changes, and optimal-lineup reconstruction is wrong
without the eligibility that applied **that** season.

**Primary key:** `(platform, player_uid, season, position)`

| Column | Meaning |
|---|---|
| `position` | One row per eligible position. |
| `source_run_id`, `updated_at_utc` | |

## 22. `fantasy_player_status_snapshots`

**Purpose:** injury / status / ownership **as observed**. Keyed by league
because `ownership_type` is a league-relative fact — the same player is rostered
in one league and a free agent in another.

**Primary key:** `(platform, league_key, season, week, player_uid)`

| Column | Meaning / NULL semantics |
|---|---|
| `week` | **NOT NULL, and uses `0` for a preseason/undated observation**, so the key stays total. |
| `injury_status`, `injury_note` | Verbatim provider vocabulary. |
| `nfl_team_abbr`, `bye_week` | As of **this** observation. |
| `ownership_type` | `'team'`\|`'waivers'`\|`'freeagents'`, verbatim. |
| `owner_team_key` | NULL unless `ownership_type='team'`. |
| `waiver_date` | |
| `percent_owned`, `percent_owned_delta` | **Provider-wide** ownership %, not league-relative. **NULL when not exposed.** ⚠️ Only capturable going forward — a historical ownership curve cannot be reconstructed. |
| `observed_at_utc`, `source_run_id` | |

---

# Migration 0130 — drafts and transactions

## 23. `fantasy_drafts`

**Purpose:** one row per league-season draft. `draft_kind` is derived **once**
here so downstream code never has to re-derive whether `auction_cost` is
meaningful.

**Primary key:** `(platform, league_key, season)`

| Column | Meaning / NULL semantics |
|---|---|
| `draft_kind` | `'auction'`\|`'snake'`\|`'unknown'`. |
| `is_price_bearing` | NOT NULL default 0. **1 = `auction_cost` carries meaning.** Read this before interpreting any price. |
| `draft_type` | Provider vocabulary, verbatim. |
| `draft_status` | `'predraft'`\|`'drafted'`\|`'postdraft'`. |
| `draft_time_unix`, `pick_time_sec`, `num_rounds` | |
| `num_picks` | **Observed count, not an assumption.** |
| `has_keepers` | **NULL when the provider does not expose keeper status** — which is the normal case. |
| `raw_draft_json`, `unmapped_fields`, `source_run_id`, `fetched_at_utc`, `updated_at_utc` | |

## 24. `fantasy_draft_events`

**Purpose:** one row per pick (or per nomination + winning bid).

**Primary key:** `(platform, league_key, season, pick_number)` — the **natural**
key, not a surrogate. `pick_number` is unique within a draft in both snake and
auction formats, and keying on it makes re-ingest idempotent. **A duplicate
`pick_number` is exactly the corruption the validators check for, so it must be
the key rather than a surrogate id that would hide it.**

| Column | Meaning / NULL semantics |
|---|---|
| `pick_number`, `round_number`, `pick_in_round` | Overall pick / nomination order. |
| `team_key` | Who made the pick. |
| `player_uid` | Season-independent player key. |
| `player_key_at_draft` | The season-scoped key **as returned**. |
| `provider_player_id` | |
| **`auction_cost`** | REAL. ⚠️⚠️ **NULL = the provider did not state a price. `0` = genuinely free (a real, meaningful $0 keeper). NEVER coerced, in either direction.** Coercing NULL→0 makes "average auction spend by position" wrong in a way nobody notices and makes free keepers indistinguishable from unpriced picks. **In a snake league the field is meaningless rather than zero** — read `fantasy_drafts.is_price_bearing` first. |
| **`is_keeper`** | ⚠️ **Usually NULL, and that is honest.** There is no documented or community-confirmed per-pick keeper flag in Yahoo's `draftresults`; the only keeper surface is a players-collection filter showing who is *currently* designated, which is point-in-time rather than a historical per-pick attribute. **This column means "the provider said so" and nothing else may occupy it.** |
| `keeper_inferred` | 1 = **WE** inferred it (e.g. the player was on the roster at the end of season N−1 **and** was drafted at an anomalous round in season N). |
| `keeper_inference_basis` | Prose explanation of that inference. **Read it before trusting `keeper_inferred`.** |
| `is_auto_pick` | **NULL when not exposed.** |
| `picked_at_unix` | **NULL when not exposed.** |
| `player_position_at_draft`, `nfl_team_at_draft` | Reconstructed from that season's own player records where possible — **a player's position and team today tell you nothing about a 2016 draft.** NULL where unreconstructable. |
| `raw_pick_json`, `unmapped_fields`, `source_run_id`, `updated_at_utc` | |

## 25. `fantasy_draft_player_metadata`

**Purpose:** the provider's **platform-wide** draft analysis (average pick,
average round, average cost, percent drafted). ⚠️ **This is NOT this league's
ADP** and the column names say so.

**Primary key:** `(platform, player_uid, captured_for_season)`

| Column | Meaning / NULL semantics |
|---|---|
| `captured_for_season` | The season we **asked** for. |
| `platform_average_pick`, `platform_average_round`, `platform_average_cost`, `platform_percent_drafted` | Platform-wide, **not league-specific**. |
| `preseason_average_pick`, `preseason_average_cost`, `preseason_percent_drafted` | Preseason variants where exposed. |
| **`historicity_verified`** | NOT NULL default 0. ⚠️ **0 = these may be CURRENT-season values.** Whether querying a historical game key returns that season's frozen values or today's is **undocumented**. `captured_at_utc` records when we asked, so if it turns out the provider serves current values for historical keys, the affected rows are identifiable rather than silently wrong. **Snapshot each preseason going forward rather than assuming a backfill is possible.** |
| `raw_analysis_json`, `source_run_id`, `captured_at_utc` | |

## 26. `fantasy_transactions`

**Purpose:** the parent row of every completed transaction.

**Primary key:** `(platform, transaction_key)`

⚠️ **What cannot be here, ever:** losing waiver claims (once waivers process,
competing claims vanish — who else bid and how much is permanently
unrecoverable), pending transactions belonging to other teams, and
rejected/vetoed trades. This table is "accepted/completed transactions plus
whatever pending items this token can see", recorded as `not_exposed` in
`fantasy_data_completeness` rather than left for someone to discover when they
wonder why the waiver market looks uncontested.

| Column | Meaning / NULL semantics |
|---|---|
| `transaction_key` | The provider's own key, **opaque TEXT** — it comes in several shapes (completed / waiver-claim / pending-trade) and is deliberately not parsed into parts. |
| `transaction_id` | |
| `transaction_type` | NOT NULL. `'add'`\|`'drop'`\|`'add/drop'`\|`'trade'`\|`'commish'`\|`'waiver'`\|`'pending_trade'` — **VERBATIM**. |
| `status` | `'successful'`\|`'pending'`\|`'proposed'` — **VERBATIM**. |
| `timestamp_unix` | Provider timestamp, unix seconds. |
| `processed_date` | `'YYYY-MM-DD'` where the provider gives one. |
| `week` | **Derived** from timestamp + `fantasy_schedule_periods`; **NULL if underivable.** |
| **`faab_bid`** | ⚠️ **NULL = NOT EXPOSED. `0` = a real zero bid** (legal in a FAAB league). |
| `waiver_priority_at_processing` | **NULL when not exposed — which it usually is.** |
| `is_commissioner_action` | |
| `trade_note` | **Rarely exposed on completed trades.** Mostly NULL. |
| `asset_count` | Observed leg count. Validators check it against `transaction_type` — a parent with an implausible leg count is a data-quality failure. |
| `raw_transaction_json`, `unmapped_fields`, `source_run_id`, `fetched_at_utc`, `updated_at_utc` | |

## 27. `fantasy_transaction_assets`

**Purpose:** one row per asset movement **leg**. A three-player trade is one
transaction with six legs; an add/drop is one transaction with two. **Collapsing
either into a single player row destroys the counterparty structure that every
trade and waiver question depends on.**

**Primary key:** `(platform, transaction_key, leg_index)`

| Column | Meaning / NULL semantics |
|---|---|
| `leg_index` | 0-based; the provider's ordering where one exists, else parse order. **What makes the key total and re-ingest idempotent** — two legs of a trade can otherwise be identical in every other column. |
| `asset_kind` | NOT NULL default `'player'`. `'player'`\|`'draft_pick'`\|`'faab'`. |
| `movement_type` | `'add'`\|`'drop'` — **VERBATIM**. |
| `player_uid` | **NULL for non-player assets.** |
| `player_key_at_txn` | Season-scoped key as returned. |
| `player_name_at_txn`, `player_position_at_txn`, `nfl_team_at_txn` | **As returned at the time** — players get renamed and traded. |
| `source_type` | `'waivers'`\|`'freeagents'`\|`'team'`, verbatim. |
| `source_team_key`, `source_team_name` | ⚠️ **Absent (NULL) unless `source_type='team'` — not empty string, because the concept does not apply.** That distinction is what lets waiver analysis separate a waiver claim from a free-agent pickup. |
| `destination_type` | `'team'`\|`'waivers'`\|`'freeagents'`. |
| `destination_team_key`, `destination_team_name` | **NULL unless `destination_type='team'`.** |
| `pick_season`, `pick_round` | **Draft-pick assets only**; NULL otherwise. |
| `faab_amount` | **FAAB-as-trade-asset only**; NULL otherwise. Distinct from `fantasy_transactions.faab_bid`. |
| `raw_asset_json`, `source_run_id`, `updated_at_utc` | |

## 28. `fantasy_waiver_state_snapshots`

**Purpose:** waiver order / FAAB budgets **as observed**. The provider exposes
only current priority and (maybe) current balance, with no history — capturing a
snapshot on every sync is the only way to build a time series.

**Primary key:** `(platform, league_key, season, team_key, observed_at_utc)` —
`observed_at_utc` is **part of the key** because two syncs in one week are two
legitimate observations.

| Column | Meaning / NULL semantics |
|---|---|
| `week` | The week the observation falls in; NULL if underivable. |
| `waiver_priority` | Point-in-time. |
| **`faab_balance`** | ⚠️ **NULL = not exposed, NOT zero.** |
| `faab_spent_todate` | **Derived from transactions; NULL if bids are unavailable.** |
| `is_derived` | NOT NULL default 0. |
| `source_run_id` | |

**Every row here is explicitly an observation, not an authoritative historical
record.**

---

# Migration 0131 — rosters, stats, scores, matchups, standings

## 29. `fantasy_roster_snapshots`

**Purpose:** who was on which roster, in which slot, per week. **The most
valuable table in the family** — bench points, optimal-vs-actual lineup
efficiency, "did this manager start the right guy", and
games-started-after-acquisition all reduce to this. **None of it is recoverable
later:** the provider serves one roster at a time with no bulk or date-ranged
form, so it is captured week by week or not at all.

**Primary key:** `(platform, league_key, season, week, team_key, player_uid)`

| Column | Meaning / NULL semantics |
|---|---|
| `selected_position` | The lineup slot, **VERBATIM** (`'QB'`, `'W/R/T'`, `'BN'`, `'IR'`). |
| **`is_starter`** | ⚠️ **DERIVED, NOT READ. Yahoo has no `is_started` field anywhere.** Computed from `selected_position` against **this league's own** `fantasy_roster_positions` — never from a hardcoded `{'BN','IR'}` set, because leagues define `IR+`, `IR-R`, `NA` and other bench-like slots that a hardcoded set would silently count as starters. **NULL if the slot definitions are unknown.** |
| `is_bench`, `is_injury_slot`, `is_flex_slot` | Same derivation. |
| `eligible_positions` | JSON array, **as of this week**. |
| `player_position`, `nfl_team_abbr`, `injury_status` | `injury_status` VERBATIM. |
| `acquisition_type`, `acquisition_date` | ⚠️ **DERIVED from the transaction log where derivable, NULL where not.** These are **not** provider fields on a roster response. |
| `is_derived_acquisition` | NOT NULL default 0 — marks which is which. |
| `game_started_before_lock` | "Was this player's NFL game already underway when the roster was observed" — matters for judging a lineup decision. **NULL = could not be established, rather than guessed at.** |
| `roster_observed_at_utc` | NOT NULL. |
| `is_editable_at_capture` | Provider flag: was the lineup still changeable. |
| `raw_player_json`, `unmapped_fields`, `source_run_id` | |

## 30. `fantasy_player_week_stats`

**Purpose:** one row per (player, week, stat). **A tall table, deliberately** —
three reasons in order of severity: (1) D1's **hard 100-column cap**, which
`nfl_player_weekly` hit exactly and can never be widened again; (2) the stat set
differs by season and by platform, and a tall table absorbs a new `stat_id` with
no migration; (3) it joins directly to `fantasy_scoring_rules` on `stat_id`,
which is what makes points reconstruction **checkable instead of assumed**.

**Primary key:** `(platform, league_key, season, week, player_uid, stat_id)`

| Column | Meaning / NULL semantics |
|---|---|
| `league_key` | **Part of the key** because fantasy points are league-relative and the provider only populates them in a league context. Keeping stats league-scoped keeps stats and points joinable on one key. |
| `stat_id` | Joins to `fantasy_scoring_rules.stat_id`. |
| **`stat_value`** | REAL. ⚠️ **NULL = the provider returned NO VALUE for that stat. `0` = it returned zero.** Different claims; the ingester never converts one into the other. |
| `source_run_id`, `updated_at_utc` | |

## 31. `fantasy_player_week_points`

**Purpose:** the provider's own fantasy points per week, stored **beside** what
this league's scoring rules produce. When both are present and disagree, either
the scoring model is wrong or the stat capture is incomplete — and that check is
**the only way to know the scoring table was parsed correctly**.

**Primary key:** `(platform, league_key, season, week, player_uid)`

| Column | Meaning / NULL semantics |
|---|---|
| `points_provider` | As reported. **NULL = not reported.** |
| `points_recomputed` | From `fantasy_scoring_rules` + `fantasy_player_week_stats`. NULL when not computed. |
| `points_reconciled` | **1 = agree within tolerance, 0 = disagree, NULL = not checked.** |
| `reconcile_delta` | Signed difference. |
| **`projected_points`** | ⚠️ Captured only where the provider actually exposes it. **There is no documented per-player projection resource and historical projections are definitively unavailable, so this is NULL for every backfilled week — and that is CORRECT rather than missing.** |
| `source_run_id`, `updated_at_utc` | |

## 32. `fantasy_team_week_scores`

**Purpose:** one row per team per week, with the provider total and the
recomputed total side by side. A disagreement means the roster capture is
incomplete or the starter derivation is wrong — **that validation needs both
numbers stored to be checkable at all.**

**Primary key:** `(platform, league_key, season, week, team_key)`

| Column | Meaning / NULL semantics |
|---|---|
| `points_provider` | The provider's team total. |
| `points_from_starters` | Recomputed from roster + player points. |
| `points_bench` | Recomputed — the bench-points metric. |
| `points_optimal` | Best legal lineup under **this league's** slots. |
| `lineup_efficiency` | `points_from_starters / points_optimal`. NULL when either input is missing. |
| `projected_points` | **Only where exposed** — NULL for backfilled weeks. |
| `scores_reconciled`, `reconcile_delta` | 1 = provider and recomputed agree. |
| `is_derived` | NOT NULL default 0. |
| `source_run_id`, `updated_at_utc` | |

## 33. `fantasy_matchups`

**Purpose:** one row per head-to-head pairing per week.

**Primary key:** `(platform, league_key, season, week, matchup_key)`

⚠️ **`matchup_key` is SYNTHESIZED** — the provider gives matchups no id of their
own. It is the two team keys **sorted lexically** and joined with `'|'`. Sorting
is what makes it deterministic: without it, the same matchup ingested from team
A's perspective and from the league scoreboard produces two rows. This mirrors
the existing repo idiom (`ups_transactions.mfl_txn_id`,
`ups_drop_events.ledger_key`) rather than a content hash.

| Column | Meaning / NULL semantics |
|---|---|
| `team_a_key`, `team_b_key` | Stored in the **same sorted order** so the pairing is canonical. |
| `team_a_points`, `team_b_points` | |
| `team_a_projected`, `team_b_projected` | NULL where not exposed. |
| `team_a_grade`, `team_b_grade` | Provider matchup grade where exposed. |
| `team_a_win_probability`, `team_b_win_probability` | Only meaningful live; NULL historically. |
| `winner_team_key` | **NULL when tied or not yet decided** — read `is_tied` alongside it. |
| `is_tied` | |
| `status` | `'preevent'`\|`'midevent'`\|`'postevent'`, **VERBATIM**. |
| `is_playoffs`, `is_consolation`, `is_division_matchup` | |
| `tiebreaker_note`, `recap_url`, `recap_title` | |
| `raw_matchup_json`, `unmapped_fields`, `source_run_id`, `updated_at_utc` | |

## 34. `fantasy_standings_snapshots`

**Purpose:** standings as of a point in time.

**Primary key:** `(platform, league_key, season, as_of_week, team_key)`

⚠️⚠️ **MOST ROWS HERE ARE INFERRED, AND THE COLUMN SAYS SO.** The provider
returns exactly **ONE** standings state per league — final for a completed
season, current for a live one. There is no `standings;week=N` and no historical
snapshot endpoint. Week-by-week standings therefore have to be **accumulated
from the scoreboard**, respecting `playoff_start_week` and the
`is_playoffs`/`is_consolation` flags so postseason results do not pollute
regular-season records.

| Column | Meaning / NULL semantics |
|---|---|
| `as_of_week` | Distinguishes the two kinds of row: the provider's actual response carries the league's final/current week with `is_inferred=0`; **every reconstructed week carries `is_inferred=1`**. |
| `rank`, `playoff_seed` | |
| `wins`, `losses`, `ties`, `win_percentage` | |
| `points_for`, `points_against`, `games_back` | |
| `streak_type`, `streak_value` | `'win'`\|`'loss'`, VERBATIM. |
| `division_id`, `division_rank` | NULL in undivisioned leagues. |
| `clinched_playoffs` | |
| `is_final` | NOT NULL default 0. 1 = end-of-season standings. |
| **`is_inferred`** | ⚠️ **NOT NULL and deliberately has NO DEFAULT**, so an unset value cannot hide. **1 = RECONSTRUCTED by us, not read.** A reconstructed rank must never be presented as a source value. |
| `inference_basis` | How it was reconstructed. |
| `raw_standings_json`, `source_run_id`, `updated_at_utc` | |

---

# Migration 0132 — the player-identity crosswalk

## `ff_player_ids.yahoo_id` (ADDED COLUMN, not a new table)

⚠️ **The only place in 0127–0132 that touches an existing table, and it only
adds a column.** `ALTER TABLE ff_player_ids ADD COLUMN yahoo_id TEXT` is purely
additive: no existing column is read, written, renamed or dropped, and no
existing row's values change. **SQLite has no `ADD COLUMN IF NOT EXISTS`, so
re-running 0132 errors with `duplicate column name: yahoo_id`** — expected and
harmless, the same accepted behaviour as migration 0036.

The value stored is the **bare numeric id** (the tail of a Yahoo player key:
`'461.p.30121'` → `'30121'`), because that is the form DynastyProcess publishes
and the form that is stable across seasons. Full season-scoped keys live in
`fantasy_player_identifiers`.

⚠️ **The `'NA'` trap.** `ff_player_ids` stores missing external ids as the
**literal string `'NA'`** (R's missing idiom, serialized to text) — **4,740 of
12,468 rows** carry it in at least one column. `'NA'` passes both `IS NOT NULL`
and `!= ''`, so an unguarded join reports 100% coverage while matching garbage.
Every predicate on `yahoo_id` **must** be guarded:

```sql
COALESCE(f.yahoo_id, '') NOT IN ('', 'NA')
COALESCE(f.gsis_id, '') LIKE '00-%'
```

⚠️ **`ff_player_ids.gsis_id` is NOT unique.** Several MFL ids can share one
`gsis_id`, so any yahoo→gsis→mfl path fans out result rows unless it uses the
aggregate-subquery form at `worker/src/index.js:10320-10337`. The
`yahoo_id → mfl_id` direction is safe because `mfl_id` is the primary key.

## 35. `fantasy_player_crosswalk`

**Purpose:** the resolved mapping **with its evidence**. A separate table rather
than columns on `fantasy_players` for two reasons: a mapping is a **claim** with
a confidence and a method, not an attribute of the player; and `ff_player_ids`
is refreshed weekly by an unrelated job, so keeping our resolutions out of it
means that refresh can never overwrite a manual decision.

**Primary key:** `(platform, player_uid)`

| Column | Meaning / NULL semantics |
|---|---|
| `player_uid` | Season-independent provider key. |
| `provider_player_id` | Bare numeric provider id. |
| `provider_name`, `provider_position`, `provider_team_abbr` | As the provider gave them, **for human review**. |
| `mfl_id` | `ff_player_ids.mfl_id`. **NULL when unresolved.** |
| `gsis_id` | Guarded `LIKE '00-%'` at every use. |
| `pfr_id` | For the snaps join, which is keyed on PFR not GSIS. |
| `sleeper_id` | |
| `match_method` | `'provider_id'`\|`'gsis_id'`\|`'name_team_position'`\|`'manual'`\|`'none'`. |
| `confidence` | NOT NULL. `'exact'`\|`'fuzzy_auto'`\|`'fuzzy_review'`\|`'manual'`\|`'unmapped'` — **reused verbatim from the existing `player_id_crosswalk` (0006)** rather than inventing parallel labels for the same idea. |
| `match_score` | 0–1. **NULL for exact-id matches.** |
| `review_status` | NOT NULL default `'none'`. `'none'`\|`'needed'`\|`'approved'`\|`'rejected'`. |
| `resolved_by`, `resolved_at_utc`, `notes`, `source_run_id` | `resolved_by` is the resolver name, or a human for manual decisions. |

**Resolution order is strict** — each step runs only if the previous found
nothing: `provider_id` → `gsis_id` → `name_team_position` → `manual`.
⚠️ **A name match ALONE is never sufficient and never writes a mapping.** Two
different players legitimately share a normalized name, and merging them
silently corrupts every downstream career total. The `name_team_position` step
requires normalized name **and** NFL team **and** position to all agree.

⚠️ **An unresolved player is a ROW, not an absence.** Non-matches are written
with `confidence='unmapped'` and `mfl_id` NULL. Dropping them would make the
unresolved report impossible to produce and would quietly shrink the player
universe. Team defenses, kickers and pre-2015 players are the expected tail —
DynastyProcess is skill-position biased.

---

## Analytical views (applied separately)

`worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql` defines
eleven views over the tables above. They are **not** part of the 35 and are not
created by 0127–0132.

| View | What it answers |
|---|---|
| `yahoo_draft_results` | Flat, readable draft log. |
| `yahoo_transactions` | Flat transaction log with legs joined. |
| `yahoo_weekly_rosters` | Weekly lineups with starter derivation applied. |
| `yahoo_player_week_points` | Player scoring by week. |
| `yahoo_team_seasons` | One row per team-season. |
| `fantasy_v_draft_value` | Draft price vs. season production. |
| `fantasy_v_roster_construction` | Positional allocation over time. |
| `fantasy_v_bench_points` | Points left on the bench. |
| `fantasy_v_waiver_value` | Return on waiver acquisitions. |
| `fantasy_v_trade_ledger` | Both sides of every trade, by leg. |
| `fantasy_v_all_play` | All-play records from the scoreboard. |

Every statement is `CREATE VIEW IF NOT EXISTS`, so re-applying the file changes
nothing. **To change a view you must `DROP VIEW <name>` first, then re-apply.**
There are zero `CREATE VIEW` statements in all 132 prior migrations, which is
why this file is manual rather than numbered.
