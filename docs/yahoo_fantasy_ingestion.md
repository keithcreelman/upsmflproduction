# Yahoo Fantasy Ingestion — Design + Operations

**Status:** ⚠️ **STILL BLOCKED — the agreement did not clear it.**

⚠️ **RETESTED LIVE 2026-08-28: `/oauth2/request_auth?scope=fspt-r` still
returns `error=invalid_scope`,** straight back to the redirect URI with no
consent screen. That is nine days after the API Access and Use Agreement went
effective, and sixteen days after the first identical result on 2026-08-12.

**⚠️ CORRECTED 2026-08-28 — an earlier draft of this section said the access
application had never been submitted. That was wrong.** Yahoo's approval email
from `fantasyapiapplications@yahoosports.com` reads *"Your application for
access to the Yahoo Fantasy API has been approved"* and then asks for the
agreement to be signed, closing: *"Upon execution of the agreement, we will
provide information regarding next steps and API access."*

**So the real sequence, and where it is genuinely stuck:**

1. Access application submitted → **approved by Yahoo**
2. Agreement sent, signed and countersigned → **executed 2026-08-19,
   effective 2026-08-21, all parties complete**
3. *"we will provide information regarding next steps and API access"* →
   **never delivered**

Nothing is outstanding on our side. The `fspt-r` scope is attached to a Client
ID by Yahoo as a provisioning step AFTER execution, and that step has not
happened nine days later. **This is a follow-up on an existing thread, not a
new application** — resubmitting the form would duplicate something already
approved.

An earlier version of this header read "✅ APPROVED — the access blocker
described below is cleared". That was wrong: it read the countersigned
agreement as clearing a block that is enforced somewhere else entirely.

**Next action: reply on the existing approval thread**
(`fantasyapiapplications@yahoosports.com`), quoting the executed agreement and
the dated `invalid_scope` evidence, and ask for the provisioning they committed
to. Do NOT submit a second access application.

There is no code change that helps. Everything downstream of the authorize step
is verified against synthetic fixtures and cannot be exercised live until the
scope is issued. What follows in this document is a set of binding contractual
limits that apply the moment it is.
**Raised:** 2026-08-11 — Keith asked for his Yahoo fantasy league's full history
in the same database as everything else, so that fifteen years of drafts,
trades, waivers and weekly lineups become queryable instead of trapped behind
Yahoo's web UI.

**Two facts to hold on to before reading anything else:**

1. **No live Yahoo API call has ever been made by this code.** Every fixture in
   `tests/fixtures/yahoo/` is **SYNTHETIC** — hand-built from the documented and
   community-reported shape of Yahoo's payloads, not captured from the wire. The
   parsers are tested, the schema is applied-ready, and the OAuth flow is
   implemented; none of it has met a real response.
2. **Access is now granted, but NARROWLY.** The signed agreement licenses a
   specific, limited use case — not "the Yahoo API." Several things this
   codebase is technically capable of are now contractually off-limits.

---

## 🔒 CONTRACTUAL LIMITS — read before running anything

Source of truth: the executed **API Access and Use Agreement** (Docusign
envelope `218A63FC-5AC9-88F0-8234-5FC8BE152918`), signed by Keith Creelman
2026-08-19 and by Yahoo (Dipesh Raichura, Sr Dir Product Management) the same
day. Territory: US + Canada. Developer Application on record is
`https://github.com/keithcreelman/upsmflproduction`.

**This section is a summary for engineers, not legal advice, and the PDF wins
over anything paraphrased here.**

### The Approved Use Case (Cover Page)

> read-only access to pull **completed drafts, transactions, weekly rosters,
> and final standings** for the purpose of **computing historical statistics**.

Anything outside that list needs written approval from Yahoo. §1.c is explicit
that the Approved Use Case *"excludes any other purposes (including, without
limitation, profiling, data enrichment, model training, or resale)."*

### What that changed in this codebase

| Limit | Clause | How it is enforced |
|---|---|---|
| No league-wide player catalog | Exhibit A §2.c.x — bars compiling *"all players in a fantasy league"* | `YahooProvider.fetch_players()` **raises `OutsideApprovedUseCase`** and never reaches the network. `backfill_season`/`sync_season` never call it. Guarded by test section L. Rostered players still arrive via `fetch_rosters`, which is roster data under the Approved Use Case. |
| Don't store/cache/index Yahoo data | Exhibit A §2.c.vii | `--raw-sink` now **defaults to `none`**: the provenance index row (hash, resource, byte count, timestamp) is still written, Yahoo's response **bodies are not retained**. `file`/`r2`/`d1` remain available but are a deliberate legal-exposure decision. |
| Attribution required wherever displayed | Cover Page | `ATTRIBUTION_TEXT` / `ATTRIBUTION_URL` in `pipelines/fantasy/providers/yahoo/adapter.py`. **Any UI surfacing Yahoo data must render it** — web: footer of each page, hyperlinked to Yahoo Fantasy; mobile: About/Legal section. |
| Rate limits are our problem | Exhibit A §2.c.v | Client already does retry/backoff and `--min-interval` throttling. Yahoo may throttle or suspend with **no notice**. |
| Single account only | Exhibit A §2.c.vi | One credential, one `--account`. Never script multiple API accounts. |

### ⚠️ Two clauses that constrain what we may BUILD, not just fetch

- **§3.e AI Tools.** If any feature using generative AI or ML processes Yahoo
  data, **all input and output belongs exclusively to Yahoo**, must be deleted
  on request and at least every 30 days, and Yahoo data may **not** be used to
  train, ground, or improve any model. Practical read: the kind of generated
  dashboard we built for ESPN is materially riskier over Yahoo data. Don't
  assume ESPN precedent carries over — ESPN has no such agreement in force.
- **§2.c.xi No competing product.** Cannot be used in a product or service that
  competes with Yahoo's own offerings.

### Termination and deletion duty (§6, §13, §14)

Yahoo may terminate **immediately, for any reason or no reason**. On
termination we have **10 business days** to delete all Yahoo Materials and
Yahoo Fantasy Information from systems and servers — *including "any analyses,
test results or other data created in connection with"* it. §14 gives Yahoo
audit rights over practices, books, and records at any time.

**Design consequence:** keep Yahoo-sourced rows identifiable and deletable.
Every row carries `platform='yahoo'`, so the deletion path is a
`WHERE platform='yahoo'` sweep across the `fantasy_*` tables plus
`raw_yahoo_api_responses` — that is not an accident of schema design, and it
should stay true.

---

## ⚠️ YAHOO API ACCESS IS GATED — DO THIS FIRST

As of 2026 the old developer documentation URL
`https://developer.yahoo.com/fantasysports/guide/` **308-redirects to
`https://sports.yahoo.com/developer`**. The self-serve era is over: getting a
Fantasy Sports API credential that actually works now requires an approved
**access application** at `https://sports.yahoo.com/developer/access/`, which
Yahoo describes as a three-stage process — **Submit → Review → Access**.

Two statements on that page are load-bearing for this project:

- **The API is READ-ONLY.** Yahoo states plainly that *"Write access is not
  available at this time."* This project only ever reads, so that costs us
  nothing — but it does permanently rule out ever using this pipeline to set a
  lineup or process a transaction.
- **A weak application is silently binned.** Yahoo states that *"incomplete or
  insufficiently detailed submissions cannot be evaluated and will be closed
  without further correspondence."* There is no appeal step and no
  clarification round. The application has to be right the first time.

### The exact walkthrough

**Step 1 — Register the application.**

Go to `https://developer.yahoo.com/apps/create/` and create an app.

⚠️ **Confirmed 2026-08-12 against the live form** — Yahoo redesigned this page
at some point after the older OAuth guide (which described "Installed
Application" vs "Web Application" and a "Fantasy Sports → Read" checkbox) was
written. The current form has neither. What you actually see:

| Field | What to choose | Why |
|---|---|---|
| Application Name / Description | anything descriptive | Not load-bearing. |
| Homepage URL | any real URL you control | e.g. the GitHub repo URL. Yahoo does not appear to fetch or validate it, but it wants something plausible. |
| Redirect URI(s) | **`https://localhost:8080`** (or any port) | ⚠️ Confirmed 2026-08-12: the form rejects the bare string `oob` with **"Invalid URI"** — it validates as a URI, and `oob` isn't one. Use a loopback URL instead. Nothing needs to actually be listening on that port: after you approve access, Yahoo redirects the browser there, the page fails to load (expected), but the address bar still shows `https://localhost:8080/?code=XXXXX&state=YYYYY`. `npm run yahoo:auth` already prompts you to paste that `code` value — see `cmd_auth`'s non-`oob` branch in `pipelines/fantasy/cli.py`, which needed no changes for this. Set `YAHOO_REDIRECT_URI` to the exact same string you register here; Yahoo byte-matches it at token exchange. |
| OAuth Client Type | **Confidential Client** | The RFC 6749 term for what the old docs called "Installed Application" in this context: an app that CAN protect a `client_secret` (ours does — it's held in the macOS Keychain / a Worker secret and sent via HTTP Basic at token exchange). "Public Client" is for apps that cannot keep a secret (SPAs, mobile apps using PKCE) — not this pipeline. |
| API Permissions | **leave both unchecked** | The listed options (`OpenID Connect Permissions`, `TW Auction`) do NOT include Fantasy Sports — it is no longer offered at app-creation time. Ticking OpenID Connect is unnecessary (this flow's `scope` is just `fspt-r`, no `openid`) and `TW Auction` is unrelated to Fantasy Sports. This is the empirical confirmation of the ambiguity flagged below: Fantasy Sports access is granted entirely through the separate application in Step 2, keyed to this app's Client ID. |

Registering the app yields a **Client ID** and **Client Secret**. Keep them out
of git — the storage rules are in "Setup".

**Step 2 — Submit the access application.**

Go to `https://sports.yahoo.com/developer/access/` and fill in the form.

⚠️ **Confirmed 2026-08-12 against the live form** — it has significantly more
required fields than the older Yahoo access-page copy implied, and it is
framed for a business/company applicant even though the page elsewhere
explicitly recognizes personal/single-league use. The full required set:

| Field | What to put | Why |
|---|---|---|
| Business Title * | `Individual Developer (personal project, no company)` | Honest, and there is no company to name a real title at. |
| Business Name & Address * | your own name and home address | There is no business; this is the standard way an individual satisfies a form built for one. Yahoo appears to want a verifiable identity/contact, not a registered entity. |
| Consumer-Facing Product or App Name * | the app name you registered (e.g. `BTNH_FFL`) | Keep it identical to the app's registered name in case Yahoo cross-references the two. |
| Brief Company Description * | `No company — individual developer building a personal, non-commercial analytics tool for my own fantasy football league.` | Same honesty as above. |
| Website URL or App Store Details * | the GitHub repo URL used as the app's Homepage URL | The closest thing to a public presence this project has; keep it consistent with Step 1. |
| Describe Your Intended Use Case * | see below | The field the whole application turns on. |
| Expected Users * | **Small (<1,000)** | One Yahoo account reading one league's own history. Claiming a larger tier invites scrutiny the use case cannot support. |
| (read/write note) | nothing needed, unless it reveals its own field | Access is read-only by default, which is exactly what this pipeline wants — there is nothing to justify. |
| Client ID | paste the Client ID from Step 1 | New users without a YDN account can leave this blank per the form's own hint, but registering first and pasting it in is simpler — one fewer thing to reconcile later. |
| Additional Notes | optional | Can restate "read-only, single league, personal use" or be left blank. |

**What to write in "Describe Your Intended Use Case."** Yahoo's own page
explicitly names *"where access is limited to personal or single league use"*
as a category it recognises, so say exactly that, in plain language, and cover
all five points:

> Personal, non-commercial historical analysis of a single fantasy football
> league I have played in for many years. Read-only: I need `fspt-r` to pull my
> own league's completed drafts, transactions, weekly rosters and final
> standings so I can compute my own historical statistics. One Yahoo account,
> one league, no redistribution, no public product, no user sign-in — the data
> is stored privately and viewed only by that league's members. Low volume: a
> one-time historical backfill paced at roughly one request per second, then an
> incremental weekly refresh during the season. No write access needed or
> wanted.

Do not pad it, do not describe a product that does not exist, and do not
overstate the audience. "Insufficiently detailed" is the failure mode Yahoo
names — so be specific about *which* resources, *which* league, *what* volume,
and *why*.

**Step 3 — Wait.**

**Correction (2026-08-12):** the public access page states no SLA, but the
confirmation email Yahoo sends on submission does — **"typically 1-2 weeks,
depending on the complexity of your use case."** No status page and no way to
check progress beyond that email (or a follow-up if they need more info), so
still don't schedule anything downstream against an exact date, but 1-2 weeks
is the number to plan around rather than genuinely open-ended.

### ⚠️ The grandfathering question is now CONFIRMED, not ambiguous

**Confirmed 2026-08-12, live: a freshly-registered app cannot even complete
the OAuth authorize step without the access application being approved.**
Keith registered a new app (Confidential Client, no permissions ticked — none
were offered) and ran the real authorize flow. Yahoo did not show a consent
screen at all; `/oauth2/request_auth?scope=fspt-r&...` returned straight back
to the redirect URI with:

```
error=invalid_scope&error_description=invalid+scope
```

So this is stronger than "assume nothing is grandfathered" — for a NEW app,
there is nothing to grandfather. Fantasy Sports permission is granted
per-app by Yahoo attaching it after the access application is approved, and
there is no self-serve path to it anymore, not even a checkbox at
registration (the Create Application form now offers only "OpenID Connect
Permissions" and "TW Auction" — see the walkthrough above). The block is on
the authorize step itself, not merely on data calls afterward.

**Practical consequence:** register the app, submit the access application
with its Client ID, and wait. There is no way to test, probe, or partially
exercise this pipeline against live Yahoo data before approval — the very
first OAuth round trip is where it stops. Everything else in this pipeline
(schema, parser, tests, fixtures) is independently verified against synthetic
fixtures and does not need live access to be trusted; only the final
authorize→token→fetch chain is gated.

### Attribution requirement

Yahoo's terms require attribution wherever this data is displayed. Any surface
that renders Yahoo-sourced data must carry:

- the literal string **"Fantasy data provided by Yahoo Fantasy"**, as a link
  back to Yahoo, and
- the **Yahoo Fantasy logo**.

This applies to every UI that reads a `fantasy_*` table with
`platform = 'yahoo'` — a workbench view, a Discord embed, a mobile card. Put it
in the shared component when the first surface ships, so it cannot be forgotten
by the second.

---

## Consumers

Who this data is actually for, in the order it gets built:

1. **League history queries** — "who has the best draft-day ROI", "what did
   this manager pay for that player in 2017", "how many titles has this GUID
   won". Served from the `fantasy_v_*` analytical views.
2. **Lineup-decision retrospectives** — bench points, optimal-vs-actual lineup
   efficiency, "did he start the right guy". Needs weekly rosters, which are
   only obtainable week by week and are the single most valuable table in the
   family.
3. **Cross-platform comparison, later** — the same normalized model can hold a
   CBS or ESPN league with no schema change. See
   `docs/fantasy_provider_adapter_plan.md`.

**Explicitly not a consumer: anything UPS.** The Yahoo league is a different
league on a different platform that happens to share a database. See
"Separation guarantees".

---

## Sources (tiered by confidence)

### Tier 1 — the Yahoo Fantasy Sports API (authoritative, gated)

`https://fantasysports.yahooapis.com/fantasy/v2` with OAuth 2.0 and scope
`fspt-r`. Everything the pipeline captures comes from here. Per-resource
coverage — including what the API does *not* expose — is in
`docs/yahoo_api_coverage_matrix.md`.

XML is the only **documented** response format; `?format=json` is undocumented
but universal and is what every community wrapper uses. The client requests
JSON for ergonomics and **archives the raw body regardless**, so if Yahoo ever
retires the JSON switch the cost is a new parser, not a re-fetch of fifteen
seasons.

### Tier 2 — the raw archive (authoritative for reparse)

Every response is written to `data/yahoo-raw/` as gzipped JSON and indexed in
`raw_yahoo_api_responses`. Parser improvements replay locally against the
archive instead of re-requesting from a rate-limited API. This is the tier that
makes the whole thing survivable.

### Tier 3 — DynastyProcess `db_playerids.csv` (identity only)

Already fetched by an unrelated existing job into `ff_player_ids`. Its
`yahoo_id` column — which the existing fetcher simply did not select — is what
resolves a Yahoo player to the `mfl_id`/`gsis_id` identity space. Migration
0132 adds the column and the resolution table. **Identity only, never scoring
and never contracts.**

### Not a source: Yahoo's website

HTML scraping is explicitly rejected as a primary mechanism. Reasons and the
narrow exceptions are in `docs/yahoo_api_coverage_matrix.md` §3.

---

## Architecture

### Data flow

```
  Yahoo Fantasy API  (fantasysports.yahooapis.com/fantasy/v2, OAuth fspt-r)
        │
        │  ①  access token (1 hour)
        ▼
  worker/src/yahoo_oauth.js        ← the ONLY holder of credential material
        │   GET  /admin/yahoo/auth/start      mint CSRF state → 302 to consent
        │   GET  /admin/yahoo/auth/callback   validate state → exchange → encrypt
        │   POST /admin/yahoo/token           mint a 1-hour access token
        │   GET  /admin/yahoo/status          names + booleans, never a value
        │   POST /admin/yahoo/revoke          mark revoked, tell the human what to do
        │
        │   refresh token, AES-256-GCM  →  fantasy_oauth_tokens (D1)
        ▼
  pipelines/fantasy/  (Python 3, stdlib only)
        │
        ├── providers/yahoo/client.py    paced ~1 req/s, retries, HTTP 999 → typed error
        ├── providers/yahoo/shape.py     Yahoo's JSON pathologies live and die here
        ├── providers/yahoo/parse.py     payload → platform-neutral row dicts
        ├── providers/yahoo/adapter.py   the 14-method FantasyProvider implementation
        │
        ├── raw/sink.py                  every body archived + indexed BEFORE parsing
        ├── normalize/crosswalk.py       yahoo_id → mfl_id / gsis_id, with evidence
        ├── quality/checks.py            NULL-vs-zero, orphan legs, duplicate picks
        ├── quality/completeness.py      per (league-season, resource) status rollup
        └── d1.py                        batched idempotent upserts via wrangler
        │
        ▼
  D1 `ups-mfl-db`  —  fantasy_* (35 tables, migrations 0127-0132)
        │              raw_yahoo_api_responses  (the payload index)
        ▼
  worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql
        yahoo_draft_results · yahoo_transactions · yahoo_weekly_rosters
        yahoo_player_week_points · yahoo_team_seasons
        fantasy_v_draft_value · fantasy_v_roster_construction
        fantasy_v_bench_points · fantasy_v_waiver_value
        fantasy_v_trade_ledger · fantasy_v_all_play
```

### Why the Worker hosts OAuth but Python does the ingesting

This split looks odd until you see what each side cannot do.

**Why OAuth lives in the Worker:**

- **A redirect URI must be a public HTTPS endpoint.** Yahoo redirects a browser
  to it. A laptop CLI has no such address; the Worker already has one.
- **A Worker cannot rotate its own secrets.** There is no runtime
  `wrangler secret put`, and Yahoo may return a **new refresh token on any
  refresh** which must then be persisted or access is lost permanently. There
  is no KV binding in this project, so D1 is the only durable store — which is
  exactly why the refresh token is AES-256-GCM encrypted with a key held only
  in the `YAHOO_TOKEN_ENCRYPTION_KEY` Worker secret. The whole database is
  snapshotted to R2 hourly; an unencrypted token there would be a standing
  breach.
- **CI must never hold a long-lived credential.** `POST /admin/yahoo/token`
  mints a one-hour access token on demand, so a workflow run holds something
  that expires before the next one starts.

**Why ingestion is Python, not the Worker:**

- **A full backfill is hours long and multi-hundred-megabyte.** Paced at ~1
  req/s across fifteen seasons × ~18 weeks × several resources, it is far
  outside a Worker's CPU and wall-clock budget. A Worker already died on this
  database with `statement too long: SQLITE_TOOBIG` and landed **zero rows**.
- **The repo's ETL is already Python** (`pipelines/etl/`), with the same
  stdlib-only, no-dependency posture.
- **Reparse must be a local operation.** `verify --from-dir` replays the
  archive with no network at all, which is only possible when the parser runs
  where the archive is.

The boundary is clean: the Worker holds credentials and mints tokens; Python
holds no refresh token in production and never writes a UPS table.

### The ID crosswalk

`fantasy_player_crosswalk` (0132) resolves a Yahoo player to the existing
identity space, in **strict order**, each step running only if the previous
found nothing:

1. **`provider_id`** — `ff_player_ids.yahoo_id`, guarded.
2. **`gsis_id`** — where the provider supplies one directly.
3. **`name_team_position`** — normalized name **and** NFL team **and** position
   must all agree. **A name match alone never writes a mapping.** Two different
   players legitimately share a normalized name, and merging them silently
   corrupts every downstream career total.
4. **`manual`** — a human decision, recorded, never overwritten by the weekly
   `ff_player_ids` refresh.

⚠️ **The `'NA'` trap.** `ff_player_ids` stores missing external ids as the
literal string `'NA'` — 4,740 of 12,468 rows carry it in at least one column.
`'NA'` passes both `IS NOT NULL` and `!= ''`, so an unguarded join reports 100%
coverage while matching garbage. Every predicate on `yahoo_id` must be written
`COALESCE(f.yahoo_id, '') NOT IN ('', 'NA')`, and on `gsis_id`
`COALESCE(f.gsis_id, '') LIKE '00-%'`.

⚠️ **`ff_player_ids.gsis_id` is not unique.** Several MFL ids can share one
`gsis_id`, so any yahoo→gsis→mfl path fans out rows unless it uses the
aggregate-subquery form already used at `worker/src/index.js:10320-10337`. The
`yahoo_id → mfl_id` direction is safe because `mfl_id` is the primary key.

**An unresolved player is a row, not an absence.** Non-matches are written with
`confidence='unmapped'` and `mfl_id` NULL. Team defenses, kickers and pre-2015
players are the expected tail — DynastyProcess is skill-position biased.

---

## Setup

### Worker secrets

```bash
wrangler secret put YAHOO_CLIENT_ID              # from developer.yahoo.com/apps/create/
wrangler secret put YAHOO_CLIENT_SECRET          # ⚠️ no trailing newline
wrangler secret put YAHOO_REDIRECT_URI           # byte-identical to the registered value
wrangler secret put YAHOO_TOKEN_ENCRYPTION_KEY   # openssl rand -base64 32
```

`COMMISH_API_KEY` must already be set — every `/admin/yahoo/*` write route is
gated on it and **fails closed** if it is missing. `GET /admin/yahoo/status` is
deliberately not gated on the feature flag, so you can always ask what state
the credential is in.

`YAHOO_SYNC_ENABLED` defaults to `"0"` in `wrangler.toml` — the whole feature
ships **dark**. Flip it to `"1"` only after the access application is approved
and the first authorization has succeeded.

Two Yahoo failure modes are worth memorising because both present as a bare
`401` with no body: a `YAHOO_REDIRECT_URI` that is not byte-identical to the
registered value, and a client secret with a trailing newline.

### Apply the migrations

⚠️ **NEVER `wrangler d1 migrations apply` on this database.** The tracker is
~47 entries behind and applying it corrupts contracts. Use `execute --file`, in
order:

```bash
for n in 0127_fantasy_control_and_raw 0128_fantasy_leagues_and_settings \
         0129_fantasy_teams_managers_players 0130_fantasy_drafts_and_transactions \
         0131_fantasy_rosters_and_scoring 0132_fantasy_player_crosswalk; do
  npx wrangler@4 d1 execute ups-mfl-db --remote --file="worker/migrations/${n}.sql"
done
```

0127–0131 are entirely `IF NOT EXISTS`, so re-running them is a safe no-op.
**0132 will error on a re-run** with `duplicate column name: yahoo_id` — SQLite
has no `ADD COLUMN IF NOT EXISTS`. That error is expected and harmless; it is
the same accepted behaviour as migration 0036.

Analytical views are applied separately and are the only file that must be
`DROP VIEW`n before a redefinition takes effect:

```bash
npx wrangler@4 d1 execute ups-mfl-db --remote \
  --file=worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql
```

### Local credentials for the CLI

The Python side reads `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` from the
environment, falling back to the macOS Keychain (`yahoo_client_id` /
`yahoo_client_secret`), and **refuses loudly** when either is missing rather
than defaulting. `YAHOO_REDIRECT_URI` defaults to the out-of-band value when
unset. The refresh token is read from `YAHOO_REFRESH_TOKEN` or the Keychain.

### The auth flow

**Via the Worker (the real path):**

1. Open `https://<worker>/admin/yahoo/auth/start?APIKEY=…` in a browser.
2. Approve the Yahoo consent screen. Yahoo redirects to
   `/admin/yahoo/auth/callback`, which validates the single-use CSRF state,
   exchanges the code, encrypts the refresh token and stores it. States expire
   after 10 minutes and a replayed state is **refused**, not tolerated. If the
   callback 403s, re-open it with `&APIKEY=…` appended — a 403 consumes
   nothing.
3. Confirm with `curl -s 'https://<worker>/admin/yahoo/status?APIKEY=…'` —
   names and booleans only, never a value.
4. CI/CLI then mints short-lived access tokens with
   `curl -s -X POST 'https://<worker>/admin/yahoo/token?APIKEY=…'`.

**Locally:** `npm run yahoo:auth` prints the authorize URL and walks the same
exchange, storing the refresh token in the Keychain.
`npm run yahoo:auth:status` reports credential *presence* only.

---

## Commands reference

Every command is an alias over `python3 pipelines/fantasy/cli.py <subcommand>`.

| npm alias | CLI | What it does |
|---|---|---|
| `npm run yahoo:auth` | `auth` | One-time authorization. `--status` reports credential presence only; `--forget` deletes the stored refresh token. |
| `npm run yahoo:auth:status` | `auth --status` | Presence check. Prints no secret values. |
| `npm run yahoo:discover` | `discover` | Finds reachable league-seasons and writes `fantasy_league_seasons`. `--league-id`, `--seasons`. |
| `npm run yahoo:backfill` | `backfill` | Full historical capture. `--league-id`, `--seasons`, `--since-week`, `--include-inaccessible`. |
| `npm run yahoo:sync` | `sync` | Incremental refresh of mutable state. Same arguments as backfill. |
| `npm run yahoo:report` | `report` | Prints season discovery + the completeness report. Read-only. |
| `npm run yahoo:verify` | `verify` | Re-parses the raw archive and runs the quality checks. **No network.** `--from-dir` (default `data/yahoo-raw`). |
| `npm run test:fantasy` | — | `node --test tests/fantasy_*_test.mjs` then `python3 tests/test_fantasy_pipeline.py`. |

`--seasons` accepts `2019`, `2019,2021`, `2014-2025`, and combinations.

**Global arguments** (before the subcommand):

| Flag | Default | Notes |
|---|---|---|
| `--platform` | `yahoo` | Only `yahoo` is implemented today. |
| `--account` | `primary` | An opaque local label, **not** an email address. |
| `--target` | `local` | `local` \| `remote`. **Defaults to local on purpose** — no command in this pipeline hits production D1 unless a human types `--target remote`. |
| `--db` | `ups-mfl-db` | |
| `--dry-run` | off | Parse and report; write nothing. |
| `--raw-sink` | `file` | `file` \| `r2` \| `d1` \| `none`. |
| `--raw-dir` | `data/yahoo-raw` | |
| `--min-interval` | `1.0` | Seconds between requests. Lowering this is how you get the app throttled. |

### The exit-code contract

Exit code **is** the contract — every command returns one of four values and
prints one human-readable final line.

| Code | Constant | Meaning |
|---|---|---|
| `0` | `EXIT_OK` | Everything asked for was done. |
| `1` | `EXIT_DATA` | A data problem: an unreadable payload, a failed quality check, a refusal to report success over an empty scan. |
| `2` | `EXIT_AUTH` | Credentials missing, expired, or revoked. Retrying makes it worse; a human must re-consent. |
| `3` | `EXIT_THROTTLED` | Yahoo is throttling. Retryable, later, with backoff. |

A run that could not read something never exits `0`. `verify` exits `1` rather
than `0` when the archive directory is missing or empty — *"refusing to report
success over an empty scan"*.

---

## Operational notes

### Rate limiting

**Yahoo publishes no rate limit.** The only public statement is that excessive
use "over the course of short periods" may be throttled. No numbers, no
`Retry-After`, no documented headers.

What is known:

- The throttle arrives as **HTTP 999** with an **HTML body** (a Yahoo "Request
  denied" page) — not a `429`, not JSON. **Status is checked before the body is
  parsed**, always, because parsing first turns a clean throttle into a JSON
  decode error and a broad `except` turns it into `[]`.
- Blocks are applied **per `client_id`**, not per user. One greedy script
  blocks every use of that app.
- Blocks last **minutes to hours**, not seconds.

The defaults are deliberately conservative: ~1 request/second sustained. **A
backfill that finishes in four hours is strictly better than one that gets the
app blocked in ten minutes.**

### Pagination

The players collection **hard-caps at 25 items per page regardless of the
`count` you ask for**. Asking for 500 returns 25 and no error, so a naive
single-page read turns a 1,000-player league into 25 players and looks like
success.

The client therefore paginates with `;start=N;count=25` until a short page
arrives — **a full page always triggers another request**, because "exactly 25
left" is indistinguishable from "25 of many" without asking. When `--max-pages`
bounds a read, the `FetchResult` carries `complete=False` and says so in
`notes`: *a bounded read that reports itself as complete is worse than no read
at all.*

### Numbers, and other Yahoo pathologies

Everything the parsers must survive, in one list, because each one returns
**fewer rows rather than an error** when handled wrong:

- **Collections are objects**, keyed `"0"`, `"1"`, … with a sibling `"count"`
  integer — not arrays. Keys must be ordered **numerically**: lexical ordering
  puts element `"10"` before element `"2"`, which quietly reorders a 12-team
  league.
- **Single-element collections sometimes collapse** to a bare object.
- **Resources are heterogeneous arrays** mixing metadata dicts and sub-resource
  wrappers at **shifting indices**. Never index positionally.
- **Sub-resources hide one level down** under a numeric wrapper key.
- **For trades, `transaction_data` is a list of one dict**; for add/drop it is a
  bare dict.
- **Numbers arrive as strings**, and percentages have a **leading dot**
  (`".571"`).
- **`player_key` is season-scoped** (`'461.p.30121'`);
  `editorial_player_key` (`'nfl.p.30121'`) is season-independent and is what
  `player_uid` uses.
- **Yahoo has no `is_started` field.** Starter status is derived from
  `selected_position` against **this league's own** `roster_positions` — never a
  hardcoded `{'BN','IR'}` set, because leagues define `IR+`, `IR-R`, `NA` and
  others that a hardcoded set silently counts as starters.

⚠️ **Game keys change every season.** A Yahoo league key is
`{game_key}.l.{league_id}`, and the game key is different every year. The
**documented** values this project relies on are: **2014 = 331, 2019 = 390,
2020 = 399, 2025 = 461**. Other years' ids are discovered at runtime from
Yahoo's own `games` resource — none are hardcoded, and no community-reported
value is treated as fact. Sending the season-independent code form
(`'nfl.l.576919'`) makes Yahoo silently rewrite it to the numeric form in every
key it returns, which produces phantom duplicates — so everything stores the
**canonical numeric** form.

### The raw archive and the reparse workflow

Every response body is archived **before** it is parsed:

- Written to `data/yahoo-raw/` as gzipped JSON (`--raw-sink file`, the default).
- Indexed in `raw_yahoo_api_responses` with `request_key =
  sha256(resource || canonicalized params)`, the SHA-256 of the body, the HTTP
  status, the parser version, and the field paths the parser **saw but did not
  map** (`unmapped_fields`).
- `UNIQUE(request_key, response_hash)` is the idempotency contract: re-fetching
  an unchanged resource is a no-op, while a genuinely changed response creates a
  new row and history is preserved.

**The index row is always written regardless of sink**, so provenance never
depends on the body still existing.

To improve a parser: bump `PARSER_VERSION` in `pipelines/fantasy/version.py`,
then `npm run yahoo:verify` — which re-parses every `*.json.gz` under the
archive and runs the full quality-check suite with **no network calls**. The
`idx_raw_yahoo_parser_version` index answers "which payloads has this parser
version never touched".

### Retention

`payload_sink` records where each body went:

| `payload_sink` | Meaning |
|---|---|
| `'d1'` | Body is inline in the `payload` column. Small responses only — D1 caps a statement at ~100KB and escaping roughly doubles a wide statement. The sink **refuses** an over-limit payload rather than truncating it. |
| `'r2'` | `payload_ref` is the key in the existing R2 bucket. |
| `'file'` | `payload_ref` is a path under the local raw archive. **Default.** |
| `'none'` | Retention pruned the body. **The index row survives.** |

A full backfill is roughly 180MB of raw payload, which is why `file` (or `r2`)
is the default and `d1` is for small responses only. When a pruned body is
requested, `read_archived` raises with an explicit message that the payload
*"was pruned or moved — not that the request never happened."*

---

## Separation guarantees

The Yahoo league is **somebody else's league on somebody else's platform that
happens to share our database**. That database also holds every live UPS
contract and cap ledger for a real 12-team money league. Four separate
incidents have already damaged it — the 2026-08-02 FAA sweep whose guard failed
open and flattened 18 owner contracts, the 2026-08-06 ERA auto-drop that
unloaded 3 live contracts through MFL's commish web form, the 2026-08-07
`contractInfo`-only import that blanked salary/status/year on 3 contracts, and
the standing `wrangler d1 migrations apply` hazard.

So the separation is structural, not aspirational:

1. **A new table prefix.** `fantasy_*` is the platform-neutral canonical model;
   `raw_yahoo_*` is the provider-specific payload index. Neither may read or
   write `ups_*` / `src_*` / `mfl_*` / `nfl_*` rows.
2. **The single sanctioned crossing point** is the read-only NFL
   player-identity crosswalk in 0132. It resolves **identity only** — never
   scoring, never contracts. Its one write to an existing table is
   `ALTER TABLE ff_player_ids ADD COLUMN yahoo_id TEXT`, purely additive.
3. **⚠️ Never import UPS scoring.** The UPS league's PPR-by-position thresholds
   (TE 1.5 / WR 1.0 / RB 0.8, first-down 0.2, sack-yard −0.1) are MFL-league
   rules with nothing to do with this league. Every points calculation over
   `fantasy_*` rows reads `fantasy_scoring_rules` for the matching
   `(platform, league_key, season)` and **fails rather than falling back to a
   default** when the rules are missing.
4. **`--target` defaults to `local`.** No command reaches production D1 unless a
   human types `--target remote`.
5. **No credential in git.** The only table holding credential material is
   `fantasy_oauth_tokens`, and what it holds is AES-256-GCM ciphertext. Yahoo
   passwords, MFA codes, browser cookies and the account email address are
   **never stored anywhere**. Manager email addresses are not stored either,
   even though Yahoo returns them for the authenticating user's own record —
   nothing needs them and storing them would put personal data in an hourly R2
   snapshot.

### The CI guard

`scripts/check_fantasy_isolation.py` is the machine that holds the prose to
account. It reads every file the fantasy ingestion is allowed to consist of —
`pipelines/fantasy/`, `worker/src/yahoo_oauth.js`, migrations 0127–0132, and
the manual views file — and **fails the pull request** if any of them contains
a write statement (INSERT / UPDATE / DELETE / REPLACE / DROP / ALTER /
TRUNCATE) naming a UPS/MFL-side table, a committed credential, or a command
that would target production implicitly.

It is honest about its limits: it is a **lexical scan with a comment stripper,
not a SQL grammar**, so the table name must be visible. It catches
`DELETE FROM ups_transactions` written literally or concatenated on one line;
it does not catch a name assigned to a variable on a previous line, because it
does no dataflow analysis. *A tripwire that catches the honest mistake, not a
sandbox that contains a determined one.*

⚠️ **It does not fail open.** A path that does not exist, a file that cannot be
decoded, or a scan set that came back empty is a **REFUSAL**, not a pass —
every expected input kind has a declared minimum count. The specific way this
check could betray its purpose is by "passing" because it silently scanned
nothing after somebody renamed a directory.

It runs in `.github/workflows/test-fantasy.yml` as the third of three jobs,
alongside the Python pipeline suite and the Node OAuth suite. Everything is
stdlib-only — `python3` (CI pins 3.12) and Node 22, no install step, no
`node_modules`, no secrets, and **no Yahoo access required**, because every
fixture is synthetic.

---

## Test status — the real output

`npm run test:fantasy` runs two suites. Below is what they actually printed.

**Python — `python3 tests/test_fantasy_pipeline.py`.** 19 synthetic fixtures.
The captured output contains **343 `ok` lines and zero `FAIL` lines**, and the
process exited **0**. Its final verdict line was:

```
PASSED — no read can fail open, NULL never became 0, and no shape silently returned zero rows
```

Cases worth naming, quoted from that run:

```
  ok    numeric-string keys are ordered NUMERICALLY, not lexically  (order was [0, 1, 2, ...])
  ok    element '10' comes AFTER element '2' (the 12-team league case)
  ok    the roster fixture yields 18 snapshots, NOT ZERO (numeric wrapper key)  (got 18)
  ok    the scoreboard yields 2 matchups, NOT ZERO (numeric wrapper key)  (got 2)
  ok    pick 6 auction_cost IS NONE (asserted with `is None`, never `== 0`)  (None)
  ok    pick 5 auction_cost IS 0.0 and is NOT None (a real free keeper)  (0.0)
  ok    NOT ONE bad payload returned a value — never {}, never an empty collection
  ok    every loader-written table has a PRIMARY_KEYS entry  (missing: [])
  ok    EVERY parsed row across every fixture is platform='yahoo' (226 rows)
  ok    ⚠️ and mfl_id is None — it REFUSES to merge two players  (None)
  ok    the d1 sink REFUSES a payload over the inline limit (never truncates)
```

Writing that suite **found real bugs**: three fixtures parsed to **zero rows
without raising**, which is precisely the failure mode the suite exists to
catch.

**Node — `node --test tests/fantasy_worker_oauth_test.mjs`.** The captured
output shows `ok 1` through `ok 18` with no failing line, covering redaction
(`redactText`, `redactUrl`, `redactHeaders`), base64 round-tripping including
`0x00`/`0xFF`, the refusal to treat undecodable base64 as "no key", and the
AES-GCM round trip — including `ok 18 - the IV is FRESH on every write — a
reused GCM nonce is a total break`. **The capture is truncated mid-line at
`ok 19`**, so this document does not claim a total count or a final summary for
the Node suite; what can be said is that no `not ok` line appears in what was
captured.

**What has NOT been tested:** anything requiring a live Yahoo response. Zero
network calls have been made. The fixtures encode our best understanding of
Yahoo's shapes from documentation and community reports — they are **not
captures**, and the first live call may still find a shape nobody predicted.

---

## Phased rollout

### Phase 0 — API access (blocking, no estimate possible)

Register the app, submit the access application, wait. **Nothing else can
start**, and no date can be committed to because Yahoo publishes no SLA. Set
the Worker secrets while waiting — they cost nothing and are needed either way.

### Phase 1 — First live call + fixture reconciliation (≈ 1 day after approval)

Authorize, then pull **one** league-season's settings and diff the real payload
against the synthetic fixture. Every difference is a parser fix and a fixture
correction. **Do not backfill before this passes** — a backfill against a wrong
parser burns the rate-limit budget on rows that will be re-parsed anyway.

### Phase 2 — Discovery (≈ 1 day)

`discover` across the account's game history, then walk `renew_key` backwards
to catch seasons the user-login query misses. Hand-insert any missing season
with `discovery_source='manual'` — that is the documented path, not a
workaround.

### Phase 3 — Backfill, oldest season first (≈ 1 week of wall-clock, mostly waiting)

One season at a time, paced. Read the completeness report after each. Oldest
first, because the oldest seasons are the most likely to be inaccessible and
finding that out early changes the plan.

### Phase 4 — Crosswalk + quality (≈ 2 days)

Resolve players, produce the unresolved report, work the manual review queue.
Reconcile `points_provider` against `points_recomputed` — that check is the only
proof the scoring table was parsed correctly.

### Phase 5 — Forward-looking capture (ongoing, starts immediately at Phase 3)

Weekly `sync` during the season. This is the phase that matters most for the
things that **cannot be recovered backwards** — see
`docs/yahoo_api_coverage_matrix.md` §3(a).

### Phase 6 — Surfaces

Analytical views already exist. A UI on top of them is a separate piece of
work, and whatever it is **must carry the Yahoo attribution**.

---

## Non-goals

- **Write access.** Yahoo does not offer it; we do not want it.
- **Live in-game updates.** A weekly refresh is enough.
- **Any interaction with UPS contracts, caps, or scoring.** Ever.
- **HTML scraping as a primary mechanism.** See
  `docs/yahoo_api_coverage_matrix.md` §3(d).
- **Public redistribution of Yahoo data.** Attribution permits display, not
  republication as a dataset.
- **Projections.** Historical per-player projections are definitively
  unavailable; `projected_points` is NULL for every backfilled week and that is
  correct rather than missing.

## Open questions for Keith

1. **Which league(s), and how far back?** Discovery will report what is
   reachable, but the account may have played leagues you do not care about.
2. **Is there an existing YDN app on the account?** If so we can test the
   parsers against real shapes immediately — provisionally, and while still
   filing the access application.
3. **Where does this surface?** A workbench view, a Discord command, or nothing
   for now. Affects nothing upstream but decides where the attribution goes.
4. **Retention policy for raw payloads.** ~180MB for a full backfill. Keep
   everything forever (simplest, and reparse stays free), or prune bodies after
   N months and keep index rows?
5. **Weekly-snapshot cadence during the season.** Ownership percentages and
   standings are only capturable forward. Once a week is the minimum; more
   often costs rate-limit budget.

## Risks

- **Access is never approved, or is approved and later revoked.** The whole
  project is downstream of a decision we do not control and cannot appeal.
  Mitigation: the raw archive means a revocation after backfill costs future
  data, not past data.
- **Yahoo retires `?format=json`.** Undocumented and unsupported. Mitigation:
  raw bodies are archived, so this costs a parser, not a re-fetch.
- **The first live payload has a shape no fixture predicted.** Likely, not
  hypothetical — the fixtures are synthetic. Mitigation: `unmapped_fields`
  surfaces unexpected paths as data instead of dropping them, and Phase 1 exists
  specifically to catch this before the backfill.
- **Rate-limit block mid-backfill.** Blocks are per `client_id` and last hours.
  Mitigation: conservative pacing, `EXIT_THROTTLED` as its own exit code, and
  `complete=False` so a short read is never recorded as a complete one.
- **Private historical seasons the account never played are permanently
  unreachable.** Not a bug and not retryable — recorded as `access_denied`.
- **Schema drift between the loader and the migrations.** An upsert whose
  `PRIMARY_KEYS` entry is missing inserts duplicates instead of updating. The
  Python suite asserts every loader-written table has one; keep that assertion.

---

*See also: `docs/yahoo_data_dictionary.md` (all 35 tables, column by column,
with NULL semantics), `docs/yahoo_api_coverage_matrix.md` (what is and is not
obtainable), `docs/fantasy_provider_adapter_plan.md` (CBS and ESPN later).*

---

## 🃏 ESPN PLAYBOOK — `mDraftDetail` roundId is NOT the real draft round

**Found 2026-08-22 against league 176898, by comparing ESPN's data to a photo of
the physical draft board.** This one silently corrupts keeper/valuation math, so
read it before trusting a draft round from ESPN.

For an **offline draft** (`settings.draftSettings.type == "OFFLINE"`), ESPN does
NOT record what actually happened at the table. It emits a **synthetic, perfect
snake**: every team gets exactly 16 picks at their default slot
(`r1#10, r2#15, r3#34, r4#39, …`), regardless of any trade.

That means:

* **Traded picks are invisible.** A manager who traded away his 2nd and 3rd
  rounders still shows 16 picks in ESPN. His remaining picks are simply shifted
  EARLIER to fill the grid.
* **The shift is systematic, not random.** In the observed case the owner traded
  1.10 + R2 + R3 for 1.01, so every pick after round 1 appears **exactly 2
  rounds too early**: Skattebo really went R9 but ESPN says r7; Burden really
  went R11 but ESPN says r9.
* **You cannot detect it from ESPN alone.** Pick counts are 16 for every team,
  so there is no "this team has fewer picks" tell. The only ground truth is the
  league's own draft board / commissioner record.

**Consequence for keeper leagues:** keeper cost is derived from the round a
player was drafted (here: drafted round − 2). Using ESPN's roundId therefore
UNDERSTATES the cost for any team that traded picks, making keepers look
cheaper — and more attractive — than they are. A model built on it will
recommend the wrong keeper.

**Rule:** treat `mDraftDetail.roundId` from an OFFLINE draft as a *slot index*,
not a draft round. Only trust it when `draftSettings.type` is an ESPN-run draft,
or when a human-sourced board confirms it. `keeper: true` picks are likewise all
filed under round 1 regardless of their real keeper cost, so they carry no cost
basis at all.
