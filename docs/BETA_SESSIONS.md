# Mobile beta sessions (Stage 1)

Status: **Stage 1, test-only, not wired to any owner.** Issue #1475. Nothing here is deployed, enabled or applied: the migration is unapplied, `BETA_ENABLED` is off, there is no key, and the original app is not changed. Keith's approval covers building and testing this slice locally and in CI; merging, applying the migration, creating the key, enabling a flag and every later stage are separate approvals.

## What this is

An optional mobile beta needs the owner's existing MFL identity without another login and without putting the MFL session in a URL or on a second web address. The design:

- **The phone holds one thing:** a random 256-bit **session id** (`ups_bs_…`), sent as `Authorization: Bearer …`, never in a URL. The MFL session itself never reaches the beta page.
- **The worker keeps the MFL session**, proved once with MFL's own league lookup, **encrypted** (AES-256-GCM) in D1, and decrypts it in memory for one request.
- **A single-use handoff code** (`ups_bh_…`, 128 bits, 60 seconds) carries the owner from the original app to the beta. Code and session id are independent random draws; only their SHA-256 is stored.
- **The server decides everything:** the proven franchise, the invitation, the kill switches, the route allowlist, the league and environment. A client-supplied mode, league, host name, marker or `Origin` never grants anything; each can only narrow.

Files: `worker/src/beta_session.js` (credentials, encryption, D1 store), `worker/src/beta_gate.js` (the gate), `worker/src/beta_routes.js` (lifecycle routes), `worker/migrations/0176_beta_sessions.sql` (provisional number, **unapplied**), hooks in `worker/src/index.js`, the beta flags in `worker/src/feature_flags.js`.

## The flow

1. The owner taps Beta in the original app (Phase 5; not built). It calls `POST /api/beta/handoff?L=…&YEAR=…` with the MFL session **in the body**.
2. The worker proves the session (`_rdhDetectFranchise`), derives the environment from the league with its own configuration, and in **one D1 batch** inserts a pending row (only if the franchise is invited) and evicts all but the newest three live rows for that franchise. It returns the code.
3. The original app opens the beta at `…/#h=<code>`; the beta removes the fragment first, then `POST /api/beta/session` with `{code, environment}`.
4. **Redemption is one guarded `UPDATE`** (`beta_session.js`, `redeem`): it matches the code hash only while the row is pending, unexpired, unrevoked, in that environment and still invited, and it sets the new session-id hash and clears the code hash in the same statement. The id is generated before the statement. Exactly one of any number of simultaneous attempts changes a row; every other case (used, expired, unknown, wrong environment, un-invited) gets the identical `code_invalid`.
5. Beta requests carry `X-UPS-Client: beta/<build>` and `Authorization: Bearer <session id>`. The gate runs first (below), then hands an **allowlisted** route the decrypted session through the single place the worker already reads it (`browserMflUserId`, `index.js`). Existing authorization (`resolveTradeCaller`, franchise checks, rule gates, ledgers) then runs unchanged.

## The gate (every refusal happens before any MFL call or D1 write, and fails closed)

A request is a **beta request** if it carries the marker or a beta-shaped credential. A request with neither is the original app and is left exactly as it is (no flag read, no D1: proven by `tests/beta_original_golden.test.mjs`). For a beta request, in order:

| # | Check | Refusal |
|---|---|---|
| 1 | `/admin/*` in any spelling | `beta_route_not_allowed` |
| 2 | a raw MFL session or key in the query, a `Cookie`, or the body | `ambiguous_credentials` |
| 3 | no session id: a public read (GET) passes as anonymous; anything else | `session_required` |
| 4 | malformed credential (including a handoff code used as a session id) | `session_invalid` |
| 5 | flags unreadable → `beta_unavailable`; master switch off | `beta_paused` |
| 6 | no live session row / revoked / expired | `session_invalid` / `session_expired` |
| 7 | league not the session's, or not a league the worker knows | `league_not_allowed` |
| 8 | franchise no longer invited | `not_invited` |
| 9 | route not on the allowlist (a GET passes **without** the session; anything else) | `beta_route_not_allowed`; flow switch off → `flow_off` |
| 10 | a franchise named in the query or body is not the session's | `franchise_mismatch` |
| 11 | the stored session cannot be opened (no key, wrong key, tampered or moved ciphertext) | `key_unavailable` / `session_invalid` |

**Expiry and revocation are enforced in the request path** (steps 6 and 8, one indexed lookup plus one invitation lookup). Cleanup never enforces anything.

**Commissioner authority is off for every beta request** in Stage 1 (`_rdhCommishFids` returns nothing, `commishSessionProven` refuses, `sessionByCookie` is false). A commissioner's franchise can use the beta as an ordinary owner only. `tests/beta_gate.test.mjs` pins every site in the worker that derives commissioner authority, so a new one fails until it is reviewed for beta requests.

**Allowlist** (`BETA_ROUTES` in `beta_gate.js`): `/api/me`, `/api/lineup`, `/api/submit-lineup`, `/api/submit-trade-bait`, `/api/trades/proposals`, `/api/trades/proposals/action`, `/api/trades/(2way|3way)/…`, `/api/waivers/{state,availability,pending,bbid-plan,fcfs}`, `/api/auction/{bid,nominate}`, `/roster-workbench/action`, `/commish-contract-update`, `/offer-mym`, `/offer-restructure`. Deliberately absent: `/api/settings`, `/api/pick` (caller proof not settled), `/api/bug-reports` (not on `main` yet), `/api/lineup-matchups` and `/api/trades/compliance-preview` (reader unconfirmed), trade outbox/reconcile/refresh, and everything under `/admin/`.

## Credential protection

| Where | Control | Test |
|---|---|---|
| Storage | Only SHA-256 hashes of the code and session id; the MFL session only as AES-256-GCM ciphertext (random 96-bit IV; the row id, franchise, league, environment and key id are bound in as additional authenticated data, so a copied or moved ciphertext fails to open) | `beta_session`: STORAGE, AES-GCM, KAT |
| Logs | No request, header or body logging; nothing in the beta code logs a credential | `beta_worker`: CANARY scans every console line |
| URLs | The MFL session and the session id never appear in a URL; only the single-use 60-second code appears, in a fragment the beta removes before any request | by design; `beta_worker` CANARY |
| Responses | The MFL session is never returned; the session id is returned once (the redemption response); every beta response is `Cache-Control: no-store` with stable error codes that echo nothing | `beta_worker`: CANARY, RESPONSES |
| Other readers of D1 | The rule-drafting agent (`rule_draft_agent.js`) runs model-written `SELECT`s on the production binding and sends rows to a model provider. It now refuses any query whose text contains `ups_beta_` (direct, join, subquery, CTE, quoted, any case, schema-qualified, UNION, comments, table-valued pragma), refuses to describe those tables, and does not list them. SQLite cannot build an identifier from pieces, so a query without the prefix in its text cannot name the table | `beta_agent_denylist` (101 attack assertions plus soundness and positive controls) |

**Dependency:** this agent change ships in this PR because the beta tables are what it protects. It is a small standalone fix (`guardSql`, `list_tables`, `describe_table`); it can be released ahead of the rest if wanted. No other code path runs arbitrary SQL against `UPS_MFL_DB` (`guardSql` is used only by this agent). D1 exports and point-in-time backups are outside the worker: they would hold ciphertext only.

## The key: access, rotation, deletion

- **Where it lives:** the Worker secret `BETA_SESSION_KEY`, format `<key id>:<base64url of 32 random bytes>` (for example `k1:…`). A second secret `BETA_SESSION_KEY_PREV` (same format) exists only during a rotation. Neither is in the repository, in `wrangler.toml`, in D1 or in any log. Only the Worker runtime reads them; the commissioner can set or delete them with `wrangler secret put|delete` but cannot read them back. A missing or malformed key means "no key": **no handoff is created and no stored session can be opened** (fail closed).
- **Generate (documentation only; nothing has been run):** `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`, then `wrangler secret put BETA_SESSION_KEY` with the value `k1:<that>`.
- **Scheduled rotation** (once a season): put the new key as `BETA_SESSION_KEY` (`k2:…`) and the old value as `BETA_SESSION_KEY_PREV`; new sessions seal with `k2`, existing ones still open through `k1`; after more than 8 hours (the session lifetime) `wrangler secret delete BETA_SESSION_KEY_PREV`.
- **Emergency rotation** (suspected leak): put a new `BETA_SESSION_KEY` and **do not** set a previous key; every stored session becomes unreadable and is refused; run the purge route to wipe the ciphertext. Owners re-enter through the Beta button. **Rotation cannot revoke an MFL session:** if a leak of the key plus stored rows is suspected, owners should also sign out of MFL.
- **Deletion:** sign-out, revocation, un-inviting, cap eviction and purge set `mfl_enc` to NULL at once. The hourly sweep wipes expired ciphertext and deletes rows 24 hours after expiry. The operator purge is `POST /admin/beta/purge-sessions` (admin key or a proven commissioner session, through the `/admin` front door). Point-in-time backups may retain older ciphertext for their retention period (**unverified**; see below); destroying the key makes that ciphertext unreadable.

## Lifecycle and operator routes

`POST /api/beta/status` (original app: booleans only), `/handoff` (original app), `/session` (beta page), `/signout` (beta page with its Bearer, or the original app with `{mfl_user_id}` to end all of that franchise's beta sessions; works while paused). Admin: `POST /admin/beta/invites` `{franchise_id, league_id, action: "invite"|"uninvite"}` (un-inviting also revokes that franchise's sessions in one transaction) and `POST /admin/beta/purge-sessions`. Every route requires `?L=<league>` (the worker's existing league guard).

**Cleanup is deletion maintenance.** The hourly cron (`5 * * * *`) calls `sweep`, wrapped in `try/catch`: while the migration is unapplied it fails harmlessly with "no such table". The sweep also runs after each handoff. A failed sweep changes nothing about who may use the beta.

## Kill switches

D1 feature flags (the Kill Switches screen), all **off** when unset: `BETA_ENABLED` (master) and `BETA_FLOW_LINEUP`, `_ROSTER`, `_TRADES`, `_WAIVERS`, `_AUCTION`, `_CONTRACTS`. The master and the route's flow are read in **one** flag read per beta request, fail closed (unreadable means off). Switching one off takes effect on the very next request, including from pages already open or cached, because the gate reads it every time; the original app never sends the marker or a session id, so it cannot be affected.

## Failure behavior

| Failure | Result |
|---|---|
| flags or session table unreadable | refuse `beta_unavailable` (503); nothing runs |
| key missing at handoff | `key_unavailable`; nothing is created |
| key missing or wrong when opening a session | refused; a wrong or moved ciphertext is `session_invalid` |
| MFL league lookup fails at handoff | `identity_unavailable`; nothing is created |
| MFL session expired at MFL | handoff `session_expired`; later beta writes fail at MFL, the owner re-enters |
| redemption response lost | the code is spent; the row is unusable (nobody holds the id) and is evicted by the cap or the sweep; the owner taps Beta again. No grace window, so no replay window |
| two simultaneous redemptions | exactly one wins |
| simultaneous handoffs | the cap is computed inside the statement; at most three live rows remain |
| sweep fails or the migration is unapplied | harmless; the request path still refuses expired and revoked sessions |
| master switch off | every beta request refused `beta_paused`; sign-out still works |

## Tests (offline; run by the safe suite)

`tests/beta_session.test.mjs` (credentials, AES-GCM, redemption, cap, revocation, sweep, query plans), `tests/beta_gate.test.mjs` (decision table, allowlist, all admin routes and spellings, raw credentials, fail-closed, commissioner tripwire), `tests/beta_worker.test.mjs` (the real worker end to end: lifecycle, commissioner authority, kill switches, expiry, no fallback to classic authentication, canary), `tests/beta_agent_denylist.test.mjs`, `tests/beta_original_golden.test.mjs` (27 original-app requests recorded from `origin/main` `7d24bc5b`; refresh the recording only with review). The D1 adapter's `batch()` now runs synchronously (the same change as #1465, identical content) so concurrency tests can overlap real D1 semantics.

## Measured D1 cost

`node scripts/beta_measure_d1.mjs` runs the real store on a local Miniflare D1 (workerd, not production; this technique matched production within about 5% for the leaderboard work). It is not part of the safe suite because it starts a local workerd process. **Measured**, one operation each, on a table at steady state (36 rows, about 272 bytes per row):

| Operation | rows read | rows written |
|---|---|---|
| flags read (master + one flow) | 1 | 0 |
| session lookup (session + invitation) | 2 | 0 |
| handoff: insert + cap eviction | 17 | 5 |
| redeem | 2 | 4 |
| sign out | 1 | 1 |
| hourly sweep, typical / nothing to do | 18 / 8 | 4 / 0 |
| sweep, worst case (100 old rows) | 802 | 200 |
| purge (36 sessions) | 33 | 33 |

**Derived:** 3 rows read per beta request; 12 rows written per session lifecycle including its later deletion. **Estimated, from assumed traffic** (12 owners, 2 sessions per owner per day, 100 beta requests per owner per day, 24 sweeps a day): about 4,272 rows read and 288 rows written a day, which is 0.085% and 0.288% of the Free limits. The estimate is only as good as those assumptions; the per-operation numbers are the measured part.

## Not in Stage 1 (and not authorized)

The Beta button and any client code; the sign-in handoff on the original app; the bug-report identity change (`/api/bug-reports` is not on `main`); the test Worker and database; real MFL sessions; iPhone storage tests; any change to the original app. Existing per-route authorization is **not** re-certified here: the auction, draft-pick and per-action roster checks remain Phase 2 audit items, and `/api/pick` and `/api/settings` stay off the allowlist.

## Unverified

Real D1 `rows_read` and `rows_written` (local numbers only); how production counts index entries for these statements; point-in-time backup retention for old ciphertext; the real MFL session lifetime; iPhone storage behavior; whether any handler outside the beta paths echoes a credential in a response (the canary test covers the beta routes and the allowlisted routes it drives, not every route).
