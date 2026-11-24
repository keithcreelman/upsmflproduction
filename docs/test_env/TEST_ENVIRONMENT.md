# UPS isolated test environment (#1475)

Status: **draft code and local tests only.** Nothing here has been deployed, created or run against
MFL, Cloudflare, Discord or GitHub. Creating the test database, setting secrets, deploying, merging,
changing the MFL test league and the first connected transaction each need Keith's separate go.

## 1. What it is, in plain English

A second copy of the UPS worker that can only ever touch MFL test league **25625**. It has its own
database, its own MFL account and its own admin key, runs no scheduled jobs, and cannot reach the
production league, the production database, Discord (except an optional test webhook), GitHub or the
production worker. If any of that is misconfigured, it refuses every request instead of guessing.

Production is unchanged: with `UPS_ENV = "production"` (now pinned in `wrangler.toml`) the new entry
file hands every request straight to the existing worker code.

## 2. Environment map

| | Production | Test (this design) |
|---|---|---|
| Worker | `upsmflproduction` (`wrangler.toml`), auto-deploys from `main`, 5 crons | `ups-test` (`wrangler.test.toml`), manual deploy only, **no crons** |
| Entry | `src/entry.js` → `src/index.js` unchanged (refuses `UPS_ENV=test`; never loads the test runtime) | `src/entry_test.js` → `src/test_env_runtime.js` → `src/index.js` (refuses anything but `UPS_ENV=test`) |
| Compatibility flags | none added | `nodejs_als` (AsyncLocalStorage, for per-request attribution) |
| `UPS_ENV` | `"production"` | `"test"` |
| League | 74598 | 25625 only (`LEAGUE_ID` = `WRITE_LEAGUES` = 25625) |
| D1 | `ups-mfl-db` as `UPS_MFL_DB` and `TWB_OUTBOX_DB` | `ups-test-db` as **both** names; must carry the `ups_env_marker` row |
| R2 | `ups-mfl-backups` | none |
| Service binding | `SELF` → production worker | none |
| Assets | `FPA_STORE` (static files) | `FPA_STORE` (same static files, read-only) |
| MFL credentials | `MFL_COOKIE`, `MFL_APIKEY` (Keith's commissioner account) | `MFLTEST_COMMISHCOOKIE`, `MFLTEST_APIKEY` (a **dedicated** account: commissioner of 25625, not a member of 74598) |
| Admin key | `COMMISH_API_KEY` | `TEST_ADMIN_API_KEY` |
| Discord | bot tokens, production channels | no bot tokens; every channel id = test channel `1089538054236160010`; only `TEST_DISCORD_WEBHOOK_URL` may be called |
| GitHub | `GITHUB_PAT` (offer files, contract-log dispatch) | none; every non-GET to GitHub refused |
| Edge cache | `caches.default` | the same shared cache, but every key moved under `ups-test-25625.` |
| `wrangler.preview.toml` | binds the **production** D1 and R2 (not isolated) | now uses `entry.js` with no `UPS_ENV`: a redeploy refuses every request |

## 3. How isolation works (each layer fails closed)

Code: `worker/src/entry.js` (production), `worker/src/entry_test.js` (test), `worker/src/ups_env_guard.js` (pure policy), `worker/src/test_env_runtime.js`.

1. **Environment.** `UPS_ENV` must be exactly `production` or `test`. Unset, empty, `prod`, `TEST`,
   `" test"`: every request returns 503 `ups_env_unconfigured` and no cron job runs (`entry.js`).
2. **Configuration** (`testConfig`). Test league is a single league id, not 74598, equal to
   `WRITE_LEAGUES`. The worker refuses to run if any production credential name is present:
   `MFL_COOKIE`, `MFL_APIKEY`, `COMMISH_API_KEY`, `TEST_SYNC_API_KEY`, `UPS_ADMIN_KEY`,
   `BETA_SESSION_KEY`, `GITHUB_PAT`, `DISCORD_BOT_TOKEN`, `DISCORD_BOT`, `Discord_bot`,
   `DISCORD_CONTRACT_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `ANTHROPIC_API_KEY`, `GIPHY_API_KEY`,
   `ROAST_TRACK_API_KEY`, `MCM_SALT`, `HALL_IP_SALT`. There is no fallback from a test secret to a
   production one: the code sees the test values under the names it already reads (`deriveTestEnv`).
3. **Bindings** (`inspectBindings`). Only D1 and the `FPA_STORE` assets binding. R2, KV, queues,
   Durable Objects, analytics and service bindings (including `SELF`) are refused.
4. **Test database marker.** Every D1 binding must return rows from `ups_env_marker`, all with
   `env = 'test'` and the test league. The table exists only via `worker/test_env/ups_test_db_setup.sql`,
   run by hand against `ups-test-db`; a test fails if any migration ever creates it, and its `CHECK`
   refuses league 74598. A binding pointed at the production database (no such table) refuses everything.
5. **Outbound guard** (`egressDecision`, applied to the global `fetch`). Refused: any URL or body naming
   74598; any MFL write (non-GET, or an `/import` URL) that names no league, another league, or whose
   body can't be read; Discord except the exact test webhook; every non-GET to any other host (GitHub
   contents and dispatch, Anthropic, ...); any `*.workers.dev` or `*.pages.dev` host (so the production
   worker can't be reached over HTTP). An MFL write is also refused when it comes from a read request
   or from no request at all, and when its request's ledger is already final.
   - **Redirects:** every outbound call is sent with `redirect: "manual"`, and each hop is decided again
     before it is followed (at most 5 hops, `https` only). Method and body follow the fetch standard:
     a 303, or a 301/302 after a POST, continues as GET without the body; a 307/308 keeps both. On a
     cross-origin hop `Authorization` is dropped, and the MFL session cookie is kept only from one MFL
     host to another (api to www48). A caller that asked for `manual` gets the 3xx; `error` throws.
   - Refusals return a synthetic 403 without touching the network and are written to
     `ups_test_egress_log` in the test database, with the hop and the phase (response, background,
     after_finalize).
6. **Edge cache namespace.** `caches.default` is shared by every worker on
   `keith-creelman.workers.dev`, and this worker's keys use fixed fake hosts (proven 2026-10-11). Every
   `match`, `put` and `delete` key is moved under `ups-test-25625.`; if that can't be installed the
   worker refuses every request.
7. **Inbound league** (`inboundDecision`). A request naming 74598 anywhere is refused before the worker
   code runs: query, path, JSON at any depth, form and multipart fields, URL-encoded, inside a list
   (`25625,74598`) or inside a URL string. Any other league, or conflicting league values, is refused.
   Otherwise the worker sees `L=25625` whatever the client sent or omitted. Routes that default to
   74598 when `L` is missing (`index.js:43282` `_wvLeague`, `/api/submit-lineup`, ...) therefore see
   25625.
8. **Credentials.** On every write and every `/admin/` request, the forwarded owner session
   (`MFL_USER_ID` cookie, `?MFL_USER_ID=`, or a body field) and the test commissioner session are
   checked against MFL `myleagues`: they must be in 25625 and **not** in 74598. Keith's own session is
   refused (it is a 74598 member). Results are cached for 10 minutes per isolate.
9. **Write ledger** (`ups_test_write_ledger` in the test database). A write needs an `Idempotency-Key`
   header. The intent row is written before the worker code runs; the outcome, response and outbound
   calls after. The same key replays the first answer and never calls MFL twice.
   - **Per-request context.** Each request runs in its own AsyncLocalStorage context, so every outbound
     call is attributed to exactly one request, including calls made later from `ctx.waitUntil`.
     The worker code gets a ctx whose `waitUntil` promises are tracked. The ledger answers with state
     `background` and becomes final only after all of that request's background work has settled.
     Work still running after 20 seconds makes the outcome `uncertain`; any call it makes after that
     is refused and logged.
   - **Operation lock.** Every write has an operation identity: method, path, query and body, with key
     order and volatile fields ignored, plus the sender's session hash. The ledger row and a row in
     `ups_test_open_operations` (primary key = the identity) are inserted in one transaction, so a
     second send of the same operation is refused (`operation_unresolved`) under ANY key while the
     first is running or unknown.
   - **MFL-write lock.** The same lock one level down: each MFL write's identity (path and all fields,
     credentials left out) goes in `ups_test_open_mfl_writes` before it is sent. A different route or
     body that produces the same MFL write is refused while it is unresolved, and the worker code
     can't retry a write inside one request after an uncertain answer.
   - **Release.** A known outcome (any answer below 500, no lost calls) releases both locks. A lost,
     5xx or timed-out answer marks the row `uncertain` and keeps both locks until someone reads 25625
     in MFL and records the outcome with `POST /__test-env/ledger/resolve`. That call changes the row
     and releases both locks together.
10. **Labels.** Every response carries `x-ups-env: test` and `x-ups-league: 25625`; every log line
   starts `[ups-env=test league=25625]`; every ledger and egress row has `env = 'test'` (a `CHECK`).

## 4. Shared resources and execution paths: what covers each

The outbound guard covers HTTP only. Database writes, bindings, jobs and caches are covered separately:

| Path | Production exposure today (line refs on `main` 68ce6aa1) | Covered in test by |
|---|---|---|
| D1 writes: transactions, contracts, adjustments, audit (`salary_change_log`), pending/retry rows (`twb_trade_outbox`, `trade_offer_dm`, submissions) | One D1 for everything, bound twice (`wrangler.toml`) | Both binding names on `ups-test-db`; marker check per binding; no other D1 accepted unmarked |
| Global D1 state: `ups_settings` (`feature_flags`, `discord_routing`), `ups_runtime_flags`, `league_events` | No league column; shared by anything on the production D1 | Separate database: the test copies start empty, so the `wrangler.test.toml` values (all off) apply |
| Dry runs that still write `*_submissions` rows | Contract routes write the row even on `dry_run` | Rows land in the test database |
| R2 backups (`index.js:495`) | Production bucket | No R2 binding allowed |
| `SELF` service binding (62 uses) | Points at the production worker | No service binding allowed; HTTP to `*.workers.dev` refused |
| Queues, KV, Durable Objects | None configured today | Refused if ever bound |
| Cron jobs (5 schedules: drop tracker cap penalties, settlements, lineup rulings, auctions, Hall) | Run on `env.LEAGUE_ID` | `crons = []` in `wrangler.test.toml`, and `entry.js` refuses every scheduled run in test |
| Retries driven by jobs (trade DM reminders, settlement sweeps, drop-penalty posting) | Cron-driven | No crons; a pending row in the test database is never retried automatically |
| Retries inside a request, and resends under a new key | Worker code can retry; a client can resend | Operation lock and MFL-write lock (layer 9) until the outcome is known or resolved |
| Background work (`ctx.waitUntil`: announcements, DMs, logs, follow-up writes) | Runs after the response | Tracked per request; the ledger waits for it; calls after finalization refused |
| Redirects | Followed by the runtime | Manual redirects only; every hop re-decided (layer 5) |
| Edge cache | Shared `caches.default`; fixed fake hosts | Key namespace (layer 6) |
| MFL writes (imports, form posts) | Client `L` chooses the league (`index.js:9054`); one account commissions both leagues | Inbound pin plus outbound league check plus a test-only account |
| Manual admin routes (`/admin/*`) | `COMMISH_API_KEY`; `/admin/test-sync/prod-rosters` (`index.js:55857`) reads 74598 with `MFL_COOKIE` | `TEST_ADMIN_API_KEY` only; admin calls are ledgered and credential-checked; any 74598 read or write refused, so test-sync can't run here |
| GitHub: `log-contract-activity` dispatch (`index.js:62344`, also on dry runs), trade-offer file commits (`index.js:28224`), other dispatches (`24007`, `24089`, `48214`) | Public repository | No `GITHUB_PAT`; every non-GET to GitHub refused and logged |
| Discord: IR announcements (`_announceIrMove`, `index.js:51446`), `/api/pick` (`index.js:22792`), drop/add trackers, trade DMs, contract posts (`silenceDiscordFlag`, `index.js:61058`), Hall, bots | Production channels; hardcoded production fallbacks | No bot tokens; every `*CHANNEL_ID` rewritten to the test channel; all Discord calls refused except the test webhook |
| Discord interactions (`/discord/interactions`) | Bot entry point | Refused in test |
| Exports (JSON the worker serves) | Production data | Test database only; every response labeled `x-ups-env: test` |
| MFL email to owners | MFL sends from its side | **Not covered by code.** See section 7, prerequisite P3 |
| Account-wide Cloudflare limits (D1 rows read/written, Worker requests) | Free-plan budget | **Shared.** Test traffic counts against the same daily budget |

## 5. Configuration (redacted)

`worker/wrangler.test.toml` is in the repo; the only placeholder is the D1 id (a deploy fails until it is
replaced, by design). Secrets, set only after approval, with **test** values:

```text
npx wrangler secret put MFLTEST_COMMISHCOOKIE   --config wrangler.test.toml   # dedicated test account session: MFL_USER_ID=<redacted>
npx wrangler secret put TEST_ADMIN_API_KEY      --config wrangler.test.toml   # new random key, never production's
npx wrangler secret put MFLTEST_APIKEY          --config wrangler.test.toml   # optional: the test account's 25625 API key
npx wrangler secret put TEST_DISCORD_WEBHOOK_URL --config wrangler.test.toml  # optional: https://discord.com/api/webhooks/<id>/<redacted>
```

Local bundle check (no deploy), run 2026-11-24 with wrangler 4.87.0:

```text
wrangler.toml        Total Upload 3940.26 KiB / gzip 910.29 KiB   (no AsyncLocalStorage, no test runtime in the bundle)
  env.UPS_MFL_DB (ups-mfl-db)  env.TWB_OUTBOX_DB (ups-mfl-db)  env.UPS_MFL_BACKUPS (ups-mfl-backups)
  env.SELF (upsmflproduction)  env.FPA_STORE  env.UPS_ENV ("production")  env.LEAGUE_ID ("74598")
wrangler.test.toml   Total Upload 3990.40 KiB / gzip 923.96 KiB   (compatibility_flags = ["nodejs_als"])
  env.UPS_MFL_DB (ups-test-db)  env.TWB_OUTBOX_DB (ups-test-db)  env.FPA_STORE
  env.UPS_ENV ("test")  env.LEAGUE_ID ("25625")  env.WRITE_LEAGUES ("25625")
```

## 6. Verifying the deployed bindings and credential separation (later, after approval)

1. **Before deploy:** `npx wrangler deploy --dry-run --config wrangler.test.toml` prints the binding
   table above. Confirm: two D1 bindings, both `ups-test-db`; no R2, no `SELF`; no cron schedule.
2. **Database:** `npx wrangler d1 execute ups-test-db --remote --config wrangler.test.toml --command "SELECT * FROM ups_env_marker"`
   shows one `test / 25625` row. Separately (one production read, needs its own go):
   `SELECT name FROM sqlite_master WHERE name = 'ups_env_marker'` on `ups-mfl-db` returns nothing.
3. **Secrets:** `npx wrangler secret list --config wrangler.test.toml` lists names only. It must show
   only `MFLTEST_COMMISHCOOKIE`, `TEST_ADMIN_API_KEY` and the optional test names. Any production
   name present makes the worker refuse every request, so step 4 also proves it.
4. **Status:** `GET https://ups-test.<account>.workers.dev/__test-env/status` (no key). Expect
   `env: test`, `league: 25625`, `database_marker: ok`, `egress_guard: true`,
   `cache_namespace: ups-test-25625`, bindings `UPS_MFL_DB: d1`, `TWB_OUTBOX_DB: d1`, `FPA_STORE: fetcher`.
5. **Credential separation and outbound proof:** `GET /__test-env/verify` with header
   `x-ups-test-admin-key`. Expect `commissioner_session.ok: true`: MFL says the test account is in 25625
   and **not** in 74598. Expect every `egress_probes` entry `refused: true`: Discord bot API, a 74598
   read, a 74598 import, a test-league import made outside a ledgered request, a GitHub dispatch, the
   production worker. Add `?owner_contacts=1` to list, per
   franchise, whether an email is on file (a count and an 8-character hash, never the address).
6. **Cache, both directions:** repeat the 2026-10-11 probe with a never-used key on a cached stats path.
   The test worker's response must not appear on production, and the reverse.
7. **Production unchanged:** after merge, production's `/api/...` responses match the pre-merge ones.
   The test `UPS_ENV=production: entry.js hands the same request, env and ctx to index.js` asserts this
   locally; the deployed check is a before/after of a few read routes.

## 7. First connected test: one FCFS add/drop (proposal, not approved)

**Resolved from MFL's public exports today (2026-11-24, no login, no writes):**

- **Franchise and roster.** Franchise **0003** in 25625 has 27 players, all active: no taxi or IR
  entries in the export. That is within MFL's limits for 25625 (minimum 27, recorded from an MFL
  refusal on 2026-10-07; maximum 30 from `rosterSize`), and an add/drop leaves it at 27.
  - 0008, the franchise used in earlier tests, has 26 players. That is under the minimum, so it is not proposed.
  - 0006 has 34 and 0007 has 35, so those 25625 rosters are stale.
- **Ownership: not resolvable from public data.** The public league export has no owner fields.
  On 2026-10-07 Keith's own account acted as 0008 in 25625. Who holds 0003 in 25625 is unknown.
  **Prerequisite P2:** assign 0003 to the dedicated test account.
- **Transaction window.** UPS's rule (canon §A5) is that FCFS opens after the Sunday 9:00 AM ET run and
  lasts until each player's kickoff; waivers re-lock Monday at 9:00 PM ET.
  - 25625 runs its own MFL schedule. Its last unlock was Saturday Nov 21 at 10:00 PM ET, and it had no Sunday run.
  - Every 25625 free agent reads `locked` today.
  - Both proposed players play Monday night (CAR at TB, Nov 30, 8:15 PM ET). The window is therefore
    **Sunday Nov 29 9:05 AM ET to Monday Nov 30 8:00 PM ET**, and only while MFL shows the player unlocked.
  - The worker's own gate (`index.js:45932`) also reads 25625's calendar with the test session. Its
    dry run reports `window_open`, which is the last check before sending.
- **MFL email recipients: not resolvable from public data.** Owner emails need a commissioner login.
  **Prerequisite P3:** Keith checks every 25625 franchise's email, and the league's email and
  notification settings, before any write. Alternatively, `GET /__test-env/verify?owner_contacts=1`
  on the deployed test worker reports which franchises have an address on file, without showing the
  addresses. Any franchise carrying a real owner's address is changed first (an MFL change to the
  test league; needs its own go) or explicitly accepted.

**The exact proposed transaction:**

| Field | Value |
|---|---|
| Target | MFL league **25625** "TEST UPS", www48, season **2026**, week **12** |
| Franchise | **0003** (to be owned by the dedicated test account) |
| Action | one `fcfsWaiver` import: **ADD 13348** David Moore (WR, CAR, free agent, $1,000) / **DROP 17509** Chris Brazzell II (WR, CAR, WW, $1,000, contract year 1 of 1) |
| Sent by | the test worker only: `POST /api/waivers/fcfs`, body `{"add_pid":"13348","drop_pids":["17509"]}`, owner session of the test account, `Idempotency-Key: adddrop-2026-11-29-0003` |
| When | inside the window above, after `scripts/test_env/first_adddrop_preflight.mjs` prints READY and the route's dry run shows `window_open: true` |
| Cap | roster salary $167,000 → $167,000 (cap $300,000.49) |
| Drop cost (UPS rule) | $0: a one-year WW of $4K or less is a cap-free cut (§A5, §C3) |

Today the preflight passes every check except the two that should fail before Sunday: the window, and MFL still showing the free agent locked.

**Prerequisites before any write:**
- P1: approved resources: the test D1, the secrets, the test worker deployed, and §6 steps 1–6 passing.
- P2: the dedicated MFL test account exists, is commissioner of 25625, owns 0003, and is not a 74598 member.
- P3: the owner emails and MFL notifications are checked.
- P4: Keith approves this exact transaction.

**Run order:**
1. `prod_untouched_check.mjs snapshot --out before.json --markers markers.json --prod-d1`. The D1 part
   is a set of production reads that needs its own go; without it the comparison can only report
   `incomplete_evidence`.
2. Preflight, then the route's dry run, with the same idempotency key prefix.
3. One live send.
4. On an uncertain answer, a timeout or a 5xx: read 25625 `transactions` and `rosters` before anything
   else. The ledger refuses a retry of the same operation under any key, and the same MFL write from
   any route, until the outcome is recorded with `/__test-env/ledger/resolve`.
5. Verify:
   - a fresh 25625 rosters read shows 13348 on 0003 and 17509 gone;
   - the 25625 `transactions` export shows the `FREE_AGENT 0003 13348,|17509,` row;
   - the test ledger row is `responded`, and its outbound log shows exactly one `mfl_write` to `L=25625`
     and no allowed Discord or GitHub call.
6. `snapshot --out after.json --markers markers.json --prod-d1 --before before.json`, then
   `compare before.json after.json --markers markers.json`.
   - The markers are the window, player ids 13348 and 17509, franchise 0003, the key and league 25625.
   - **MFL 74598:** every transaction, roster and salary row, by content. Transactions are compared only
     over the range both 7-day exports cover, so one aging out is not a deletion.
   - **GitHub:** commits and workflow runs. A `repository_dispatch` in the window needs review.
   - **Production D1, per table:**
     - a fingerprint (count, max rowid, rowid total), which finds deletions and replaced rows anywhere;
     - every row in scope of the markers (a test player, franchise id 0003 or league 25625; the whole
       table when it has no such column and is under 5,000 rows), compared by content, so an UPDATE
       to an existing row is found;
     - every row added since BEFORE, by content;
     - the full global `ups_settings` and `ups_runtime_flags`.
   - **Verdicts:** `associated_activity_found` (a change mentions a test player, the key, league 25625 or
     a test label), `review_required` (a relevant change or a deletion that can't be attributed
     automatically), `incomplete_evidence` (any source not compared, unreadable, truncated or without a
     scope), and `untouched` only when every automated source was compared in full. Real owners'
     activity is listed separately. Exit code 0 only for `untouched`.
   - **Discord** is always listed as a manual check: production channels by eye for the window, plus
     the test worker's `ups_test_egress_log`.
   - **Cost:** the fingerprint and unindexed scopes read each listed table in full, twice. Measure it
     once (`rows_read` is printed) before relying on it.

**What success means, in three separate steps:**
1. **Roster-only success (this test).**
   - MFL 25625 shows the add and the drop.
   - The ledger is `responded` and matches.
   - The production check reports no associated activity.
   - Nothing in production changed because of the test.
2. **Contract stamp (a later acceptance step, not part of this test).** UPS's FCFS contract is
   $1,000, one year, `Vet-WW`, `contractYear 1`, `CL 1| TCV 1K| AAV 1K` (§A5). The stamp is written by the
   production WW-stamp path, which is off in the test worker (`WW_CONTRACT_STAMP_ENABLED = "0"`, no
   crons). Testing it means a separately approved run of the stamp against 25625, with a read-back
   of the `salaries` export.
3. **Cap penalty (a later acceptance step).**
   - This drop is a $0 cap-free cut, so no penalty row is expected.
   - Pricing a real penalty needs a different drop: a multi-year contract.
   - The production drop tracker posts the penalty to MFL `salaryAdjustments` and Discord. It is off
     in the test worker.
   - Testing it means a separately approved run, with an `salaryAdjustments` read-back in 25625.

**Then lineup submission (test B):** the same target, a swap of two unlocked, eligible players through `POST /api/submit-lineup`, ledgered and read back. A locked-player swap must be refused with no MFL call.

## 8. Deferred: not done, not scheduled

- **Test-league presentation.**
  - What to back up, by hand while logged in to 25625:
    - Home Page Messages 1–20: the header in #1, the footer in #20, and any `MESSAGEn` module;
    - the custom CSS URL or file (Setup › Appearance › Images & Other URLs);
    - the skin page (skin 1024);
    - the Home Page Modules & Tabs layout (saved from `TYPE=appearance` on 2026-11-23).
  - What would be removed: those HPM contents, the CSS URL, and the custom skin (back to stock).
  - What stays: settings, rules, scoring, rosters, contracts, schedule and franchises.
  - Preview without changing anything: `https://www48.myfantasyleague.com/2026/logout?L=25625&HIDE_CUST=1`.
  - Never use MFL's "Load Template"; it wipes HPMs irreversibly.
  - Cost: 25625 is today's staging step for header changes.
- **Scoring.** 25625 differs from production in 36 of 244 rule values. Copying production scoring is
  an MFL settings write to the test league; it is not done.
- **Nightly production → test refresh (proposal only).**
  - One way only, run by a separate job, never by the test worker, and never with production
    credentials in the test worker.
  - Order: take a lock; refuse if any test ledger row is `pending` or `uncertain`; archive the test
    ledger (copy, never delete); copy rosters, salaries and contracts into 25625 with the existing
    `test-sync`; read back; copy selected D1 tables, mapping `league_id` 74598 → 25625, with
    franchise ids unchanged; count and hash checks; release.
  - Refreshed rows are marked `source = 'refresh'`; notification queues are never copied, so nothing replays.
  - Not copied today by test-sync: draft picks, cap adjustments, pending trades, settings and scoring.
  - A full-table production read counts against the D1 Free budget, so measure it before any schedule.

## 9. Remaining exposure

- **The production worker still accepts a client `L`** (`index.js:9054`) and still has the production
  commissioner cookie, so a request sent to production with `L=25625` writes the test league with
  Keith's account. This design keeps test traffic off production (the test worker is a different host;
  a later test site would be limited to it by its content security policy). Restricting production
  itself to 74598 is a separate decision: production legitimately writes 25625 today (test-sync,
  sentinel battery, auction simulator).
- **MFL email** to whoever owns franchises in 25625 is outside the code (P3).
- **Cloudflare account limits are shared**: D1 rows read and written, Worker requests.
- **Operation identity is by request content.** Two different requests that mean the same thing to
  MFL are caught at the MFL-write lock. A write MFL would treat as different (another player, another
  franchise) is a different operation by design.
- **The test D1 starts empty** apart from migrations. Contract history the routes read from D1 (tag,
  extension, restructure history) is absent until a refresh exists. Routes that need it answer from
  MFL or refuse.
- **Not verified:**
  - real MFL behavior on 25625 for FCFS during its own unlock schedule;
  - who owns each 25625 franchise;
  - the 25625 owner emails;
  - the Workers Free size limit against this 0.92 MB gzip bundle (not re-checked today);
  - whether the test account's `myleagues` lists 25625 under season 2026 (it is the year in `YEAR`).
