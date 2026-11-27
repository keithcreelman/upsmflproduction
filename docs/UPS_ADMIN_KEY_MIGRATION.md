# UPS_ADMIN_KEY: an independent, header-only admin credential for the worker

Status: **Phase 1 is a draft PR: code and tests only, not deployed, no secret created.** Phases 2 to 5 below are a plan; each one needs an explicit go from Keith (checkpoints in section 4).

Generated 2026-11-21 from the code at the PR head. Line numbers drift; every statement here can be re-derived with `grep` for `matchAdminSecret(`, `sessionByApiKey` and the `.github/workflows` secret references.

## 1. Design

**Plain English.** Today the worker's admin routes accept one of three "worker secrets" (`COMMISH_API_KEY`, `TEST_SYNC_API_KEY`, `MFL_APIKEY`), mostly from the URL (`?APIKEY=`). `MFL_APIKEY` is also the key the worker uses to talk to MyFantasyLeague, so the same value is both a credential for MFL and a credential for UPS admin routes, and the URL form puts it in logs, shell history and job output. Phase 1 adds a fourth secret, `UPS_ADMIN_KEY`, that is **only** an UPS admin credential, can be **only** sent in a header, and is accepted **in addition to** what each route accepts today. Nothing is removed or narrowed. Until the secret exists in Cloudflare, the worker behaves exactly as before.

**Technical why** (caller, then ingest, validate, store, serve):

- One new pure module, `worker/src/admin_secrets.js`, holds the **policy table**: for each credential-checking site, which legacy secret is accepted from which source (query parameter, `X-COMMISH-APIKEY`, `X-Internal-Auth`, Bearer, ...), and whether the site also has a commissioner-session path. `matchAdminSecret({request,url,env,site})` returns `{ok, via}` with `via` one of `ups_admin_key | commish_key | test_sync_key | mfl_apikey`. All comparisons go through one constant-time `safeEqual` (the same function the worker already used; `trade_authz.js` re-exports it).
- `UPS_ADMIN_KEY` is accepted only from `Authorization: Bearer <key>` or `X-UPS-ADMIN-KEY`. It is never read from the URL, so a URL parameter carrying it is just a wrong key. Unset, blank or shorter than **24 characters**, it is ignored completely. It is also ignored if it equals any legacy secret: a copy of an existing credential is not an independent one. A wrong `X-UPS-ADMIN-KEY` is treated as "a credential was presented" (403 rather than 401) only when a usable key is configured, so with the key unset the answer is byte-for-byte today's.
- The seven checks (eight policy sites, see section 2) call the module with minimal diffs. Every branch, status code and message is preserved; the commissioner-session logic is untouched. Two sites compared with `===` / `!==` (the calendar commit check and the Hall admin check); they now use the constant-time comparison, which changes timing only.
- **Logging for later phases.** When a request is authorized by a legacy credential the module prints one line, `[admin-auth] via=<type> site=<site>`, with the type and the site id only: never a value, never the URL. It prints nothing for `UPS_ADMIN_KEY` and nothing on a denial, and prints at most once per request per type and site. A request to a route that is checked twice (front door, then the route itself) therefore logs two lines with different `site` values. Worker-internal calls to its own routes (the scheduled jobs call `/admin/...` with the key in the URL) also count as legacy uses: the log cannot yet tell internal from external callers, which matters for Phase 3 (section 4).
- **Why an independent secret, header-only.** It can be created, rotated and revoked without touching MFL or any job that talks to MFL. Because it is only ever a header, new callers stop putting a credential in URLs. Because every site reads it through one table, Phase 3 (stop accepting MFL keys) is a one-line edit to that table rather than a hunt through a 62k-line file.
- **CORS.** The worker answers every `OPTIONS` preflight with a fixed `Access-Control-Allow-Headers: Content-Type`. A browser page that sends a custom header would fail its preflight, so Phase 1 changes that list to `Content-Type, X-UPS-ADMIN-KEY`. `Authorization` is deliberately not added: browser pages use `X-UPS-ADMIN-KEY`; `Authorization: Bearer` is for non-browser callers (workflows, scripts) which have no preflight. This is the only response-header change and is covered by a test.
- **Alternatives considered.** (a) Reusing `COMMISH_API_KEY` as the header credential: rejected, it is a legacy credential this plan eventually retires. (b) Changing every `sessionByApiKey` gate at once: rejected for this PR, too wide for one reviewable diff; recommended as the next PR (section 2b). (c) Replacing the URL form outright: rejected, it would break ~45 workflows, the pages and the scheduled jobs on the same day.

### What to rely on, stated plainly
- **Power.** Where `UPS_ADMIN_KEY` is accepted it is exactly as powerful as the commissioner key is at that site. It is a new way to present the same authority, not a reduced one.
- **Fail closed elsewhere.** Routes whose own check still compares directly against the commissioner key (the `sessionByApiKey` gates and the direct comparisons in section 2b) **refuse `UPS_ADMIN_KEY`** until the Phase 1b extension: it passes the front door and is then refused with that route's own 403, never a 500 and never a success. A test pins this on four real routes (two `sessionByApiKey` gates, two direct comparisons) and checks that the legacy key is still accepted there exactly as before.
- **Log volume (a note for Phase 3).** A call authorized by a legacy credential now logs one `[admin-auth]` line per site that checks it, so a route checked twice (the front door, then its own migrated check) logs two lines. Worker-internal scheduled calls add lines too. Budget for that when reading a window of logs.

### Known strict-reading differences
- None for existing credentials' accept/refuse decisions. One was found in review and **restored exactly**: the trade-execution routes read `?APIKEY=` **or, if absent,** `X-COMMISH-APIKEY`, deciding which to use *before* trimming, so `?APIKEY=%20` beside a valid `X-COMMISH-APIKEY` is refused. The policy table now chooses on the raw value (`pick: "first"`) and a test pins both that and the empty-query fall-through to the header.
- Timing only: the calendar-commit and Hall checks used `===` / `!==` and now use the constant-time comparison.
- New header only: with `UPS_ADMIN_KEY` configured, a wrong `X-UPS-ADMIN-KEY` alone is a presented credential (403) rather than none (401); with the key unset the answer is today's.

## 2. The sites

### 2a. Migrated in Phase 1 (verified by reading the code, then by the tests)

"Before" is what the site accepted at the base commit; "after" adds `UPS_ADMIN_KEY` from `Authorization: Bearer` or `X-UPS-ADMIN-KEY` at every row, and nothing else changes. COMMISH = `COMMISH_API_KEY`, TEST_SYNC = `TEST_SYNC_API_KEY`, MFL = `MFL_APIKEY`.

| # | Site id | Route(s) | Accepted before (and still) | Commissioner-session path? |
|---|---|---|---|---|
| 1 | `admin_authority` | the front door for every exact `/admin/*` route (122 exact + 1 dynamic route; 1 public read is exempt) and `GET /bug-reports` | COMMISH, TEST_SYNC or MFL from any of: `?APIKEY=`, `?key=`, `X-COMMISH-APIKEY`, `X-MFL-APIKEY`, `X-Internal-Auth`, Bearer; or an `MFL_USER_ID` that MFL proves is a commissioner franchise | **yes** |
| 2 | `trade_caller` | `resolveTradeCaller`: `/api/trades/2way*`, `/api/trades/3way*`, `/api/trades/outbox` and the trade routes in `index.js` (callers that pass `allowAdminKey:false` never accept an admin key) | COMMISH from `?APIKEY=`; otherwise an owner session | **yes** (owner session; commissioner via `commishFids`) |
| 3 | `push_mfl_calendar_commit` | `POST /admin/auction/push-mfl-calendar?commit=1` | COMMISH or TEST_SYNC from `?APIKEY=`; or a verified commissioner session | **yes** |
| 4 | `three_way_cancel` | `POST /admin/3way/cancel` | COMMISH from `?APIKEY=` only | **no** |
| 5 | `trade_execution_admin` | `/admin/trade/execution`, `/admin/trade/postprocess-retry`, `/admin/trade/reconcile-execution`, `/admin/trade/extension-review`, `GET /admin/release-info` | COMMISH from `?APIKEY=` or, when no query key is present, `X-COMMISH-APIKEY` (a present-but-wrong query key wins over a right header, as today) | **no** |
| 6 | `three_way_compliance` | `POST /admin/3way/compliance` (called by the 3-way engine through the worker's own service binding) | COMMISH from `?APIKEY=` only | **no** |
| 7 | `leaderboard_precompute_build` | `POST /admin/leaderboard-precompute/build` | COMMISH from `?APIKEY=` or Bearer | **no** |
| 8 | `hall_admin` | `/admin/hall/*` (`checkAdmin` in `hall.js`; answered before the front door) | COMMISH from `X-Internal-Auth` only | **no** |

Corrections to the list I was given: the seven items map to eight policy sites because item 7 was two code locations (the Bearer check in `index.js` and `checkAdmin` in `hall.js`) and they are separate policies. Item 5 is one check shared by five routes. Item 1 is called from two places (front door and `GET /bug-reports`) with one policy.

**Lockout risk, stated plainly.** Five of the eight sites have **no commissioner-session path**: `three_way_cancel`, `trade_execution_admin`, `three_way_compliance`, `leaderboard_precompute_build`, `hall_admin`. For these, if every key were retired, a signed-in commissioner could not use them at all. Note also that a route behind the front door (site 1) passes a commissioner session at the front door and then fails its own key check, so for these routes the session path is effectively absent too. The same is true of nearly all the un-migrated checks below. A session path must exist (or the route must be declared key-only on purpose, as `/admin/3way/compliance` is: only the worker's own engine calls it) before any credential is cut off.

### 2b. Found beyond the seven (not changed in this PR)

There are many more credential comparisons in `worker/src/index.js`, in routes that sit behind the front door. For these, `UPS_ADMIN_KEY` **already passes the front door (site 1) but is then refused by the route's own check**, which still wants a legacy key. Measured at the PR head:

- `sessionByApiKey` (the shared gate `?APIKEY=` equals COMMISH): 66 references, 42 of them `if (!sessionByApiKey` gates on routes. It is defined once, so migrating all of them is a small, central change (recommended as "Phase 1b").
- About 25 direct comparisons of the form `browserKey === commishKey` (some also accept TEST_SYNC; five accept COMMISH or MFL; one reads an `Authorization` header equal to COMMISH), spread over routes such as the calendar and test-sync routes, bug-report triage, the drop tracker and trade-offer routes.
- About 55 worker-internal calls to its own routes put `APIKEY=<COMMISH>` in a URL (42 in `index.js`, the rest in `trade_2way.js`, `trade_3way.js`, `trade_dm.js`).

A structural test (`tests/admin_key_phase1.test.mjs`, "structure" tests) freezes these counts: a new credential comparison anywhere in `worker/src` outside `admin_secrets.js` fails the test unless it is added to the policy table. The allowlist names the files that legitimately mention the secrets because they present them outward (to MFL or to the worker itself): `lineup_forfeit_reversal.js`, `trade_2way.js`, `trade_3way.js`, `trade_dm.js`, plus the migrated `hall.js` message and the remaining un-migrated lines in `index.js`.

## 3. Dependency map

Regenerated from `.github/workflows/*.yml` (47 workflows reference `COMMISH_API_KEY`, `MFL_COOKIE` or `MFL_USER_ID`), the repo's `site/` pages and `scripts/`. Counts are from a text scan plus manual review of the ambiguous ones; treat them as a good inventory, not a proof.

**Aggregate (workflows).** 47 total: 40 use `COMMISH_API_KEY`; 7 use only `MFL_COOKIE` (they talk to MFL, not the worker); 2 also pass `MFL_USER_ID` to the worker as a commissioner session fallback. Triggers: **4 have a schedule** (`roster-max-reminder`, which uses the worker key; `delete-custom-waiver-order`, `nightly-config-sync`, `refresh-mym-dashboard`, which use the MFL cookie only); the other 43 are manual dispatch (one of them, `leaderboard-current-season-rebuild`, also fires on `workflow_run`). Targets: 36 call only the worker; 3 call the worker and MFL directly (`aav-restore-2026`, `unification-write`, `ww-salary-repair-2026-08-07`); 8 call only MFL (the 7 cookie-only ones and `restore-salaries`). How the worker key is sent: 35 URL query, 3 `X-COMMISH-APIKEY` header, 1 `Authorization: Bearer` (`players-data-backfill`), 1 sends the secret to MFL as a form field and not to the worker (`restore-salaries`). Two other workflows (`ww-salary-repair-2026-08-07` and `restore-salaries`) present the `COMMISH_API_KEY` secret's value to MFL as an MFL API key, so they depend on that value independently of the worker.

| Workflow | Triggers | Secrets used | Calls | How the key is sent |
|---|---|---|---|---|
| `aav-restore-2026.yml` | dispatch | COMMISH_API_KEY | worker + MFL | URL query |
| `backfill-playoff-weekly.yml` | dispatch | COMMISH_API_KEY | worker | X-COMMISH-APIKEY header |
| `capfree-backfill.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `capfree-decide-dryrun.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `capfree-preview.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `contractinfo-write.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `delete-custom-waiver-order.yml` | schedule, dispatch | MFL_COOKIE | MFL only | n/a (MFL cookie) |
| `discord-cleanup-messages.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `discord-thread-diag.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `drop-penalty-capyear-repair-2026-08-08.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `drops-catch-up-scan.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `drops-post-discord.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `drops-reconcile.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `extension-forum-backfill.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `health-summary-live-check.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `ir-announce.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `leaderboard-current-season-rebuild.yml` | workflow_run, dispatch | COMMISH_API_KEY | worker | URL query |
| `leaderboard-precompute.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `lh-waiver-diag-2026-08-13.yml` | dispatch | MFL_COOKIE | MFL only | n/a (MFL cookie) |
| `load-forum-extensions.yml` | dispatch | COMMISH_API_KEY | worker | X-COMMISH-APIKEY header |
| `mfl-waiver-log-diag.yml` | dispatch | MFL_COOKIE | MFL only | n/a (MFL cookie) |
| `mym-backfill-d1.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `nightly-config-sync.yml` | schedule, dispatch | MFL_COOKIE | MFL only | n/a (MFL cookie) |
| `players-data-backfill.yml` | dispatch | COMMISH_API_KEY | worker | Authorization: Bearer |
| `post-deadline-reminders.yml` | dispatch | COMMISH_API_KEY, MFL_USER_ID | worker | URL query (session fallback) |
| `post-drop-penalties-mfl.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `processed-waivers-scan.yml` | dispatch | MFL_COOKIE | MFL only | n/a (MFL cookie) |
| `refresh-mym-dashboard.yml` | dispatch, repo-dispatch, schedule | MFL_COOKIE | MFL only | n/a (MFL cookie) |
| `restore-salaries.yml` | dispatch | COMMISH_API_KEY | MFL only | key sent to MFL (form field), not to the worker |
| `restructure-ingest-d1.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `restructure-reconcile.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `restructure-repair-d1.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `roster-max-reminder.yml` | schedule, dispatch | COMMISH_API_KEY | worker | URL query (via script) |
| `salary-row-call.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `sync-src-draft-picks.yml` | dispatch | COMMISH_API_KEY | worker | X-COMMISH-APIKEY header |
| `tag-backfill-d1.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `test-deadline-reminder.yml` | dispatch | COMMISH_API_KEY, MFL_USER_ID | worker | URL query (session fallback) |
| `transactions-sync-d1.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `unification-write-dryrun.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `unification-write.yml` | dispatch | COMMISH_API_KEY | worker + MFL | URL query |
| `waiver-franchise-cell-diag.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `waiver-post-test-fire.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `waiver-report-replay-test.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `waiver-settings-read.yml` | dispatch | MFL_COOKIE | MFL only | n/a (MFL cookie) |
| `ww-salary-repair-2026-08-07.yml` | dispatch | COMMISH_API_KEY | worker + MFL | URL query |
| `ww-stamp-dryrun.yml` | dispatch | COMMISH_API_KEY | worker | URL query |
| `ww-stamp-run-2026-08-08.yml` | dispatch | COMMISH_API_KEY | worker | URL query |

**Commissioner pages under `site/` that send a key.**

- `site/commish/commish_settings.html` and `site/commish/trade_review_queue.html`: the commissioner pastes (or opens a link with) `?APIKEY=<key>`; the page stores it in `localStorage` under `ups_commish_apikey`, strips it from the visible URL, and sends it as `?APIKEY=` on fetches. These are the two pages that hold a commissioner key in the browser.
- Pages that read an `APIKEY` from MFL's own page globals / cookie and forward it as `?APIKEY=` to the worker for identity lookups: `site/rosters/roster_workbench.js`, `site/rosters/v2/front_office.js`, `site/trades/trade_workbench.js`, `site/trades/mfl_hpm_embed_loader.js`, `site/team_operations/team_operations.js`, `site/ups_options_widget.js`. That value is the viewer's own MFL page key; it is not an admin credential, and the trade caller deliberately ignores a key that does not match when an owner session is present.
- The mobile app (`site/m/app.js`) sends no key.
- 8 files in total read a key from the URL or page globals; 2 persist one to `localStorage`.

**Local scripts that call worker admin routes** (13 files by text scan): `scripts/auction_poll_tick.sh`, `auction_reports_tick.sh`, `drop_scan_tick.sh`, `cron_liveness_tick.sh` (query; the last also uses headers), `hall_seed.sh`, `hall_test_summaries.sh`, `discord_seed_round.sh`, `discord_seed_round_prod.sh` (header), `fcfs_contract_backfill.mjs`, `full_year_earned_repair.mjs`, `ci_roster_max_reminder.py`, and `pipelines/etl/scripts/build_rookie_draft_hub.py`, `audit_contract_info.py`. Other pipeline scripts present an MFL key to MFL directly and are out of scope here.

**The worker itself.** The scheduled handlers and several engines call the worker's own admin routes over the service binding with `APIKEY=<COMMISH>` in the URL (about 55 call sites). These are legacy callers of sites 1 and 3-7 until Phase 2 moves them (or they are declared internal).

## 4. Migration plan

Four kinds of step need Keith's separate, explicit go: **(A) live secret creation, (B) production deploy, (C) credential cutoff, (D) destructive cleanup.** None happens in Phase 1. Every phase below is a PR or a procedure; none starts without its checkpoint. A production deploy or a secret change is never used as a test.

### Phase 1 (this PR): additive code, tests, docs
- **Does:** `admin_secrets.js`, the eight sites, the CORS allow-list entry, tests, this document.
- **Checkpoint B (deploy):** Keith reviews the diff and the test run, then decides when the worker is deployed. Deploying with `UPS_ADMIN_KEY` unset changes nothing observable except the new log line for legacy credentials and the longer CORS allow-list.
- **Rollback:** redeploy the previous worker version (or revert the PR). With the secret unset, nothing depends on this code.

### Phase 1b (recommended next PR): migrate the remaining in-route checks
- Extend the policy table to the shared `sessionByApiKey` gate and the ~25 direct comparisons (section 2b), so `UPS_ADMIN_KEY` works on every admin route and not only on the eight. Phase 2 cannot start for a route until that route is covered; this is the main dependency of the whole plan.
- **Rollback:** revert the PR; same tests prove today's policy is unchanged.

### Phase 2: move the callers (needs checkpoint A first; no credential is cut off in this phase)
- **Checkpoint A (live secret creation):** Keith creates `UPS_ADMIN_KEY` (at least 24 random characters, not derived from any other secret) as a worker secret and as a GitHub Actions secret. Not done by Claude.
- **Order and verification per group.** Each group is one PR changing only the call from URL `?APIKEY=` to `Authorization: Bearer`, plus one run of a read-only route through the new header (for example `GET /admin/release-info`, which needs no state) to confirm the credential works before the real job is touched.
  1. Scheduled first: `roster-max-reminder.yml`. It posts to Discord, so it is never test-fired: confirm the header form with the read-only route above, switch the job, and let the next scheduled day (the August/September cron) be its first real run, with the revert ready.
  2. `workflow_run`: `leaderboard-current-season-rebuild.yml`.
  3. Dispatch workflows by family, each with its existing dry-run input where one exists (drops, restructure, capfree, ww-stamp, unification, waiver diagnostics, D1 backfills).
  4. The three workflows that also call MFL (`aav-restore-2026`, `unification-write`, `ww-salary-repair-2026-08-07`) keep their MFL credential **for the MFL calls only**; only the worker call moves. `restore-salaries` talks only to MFL and is untouched by this migration.
  5. Worker-internal self-calls: change them to present `UPS_ADMIN_KEY` from the binding, or mark them internal so the log can exclude them. Decision for Keith.
- **Commissioner pages:** `commish_settings.html` and `trade_review_queue.html` ask the commissioner to paste the key once, keep it in `localStorage`, and send it as `X-UPS-ADMIN-KEY` (a header, never a URL). Requires the CORS entry from Phase 1.
- **Sessions before Phase 3:** add a commissioner-session path to every site without one that a commissioner uses by hand (`three_way_cancel`, `trade_execution_admin`, `leaderboard_precompute_build`, `hall_admin`, and any un-migrated route a person opens). `three_way_compliance` is internal and may stay key-only by decision. This is reviewed route by route; a commissioner session is verified against MFL, which cannot be tested offline.
- **Phone-review plan for the pages:** an HTTPS preview of the two commissioner pages with a non-production key and a stub worker, plus a 320px and 375px screenshot; real Safari and a real MFL session are verified separately and stated as unverified until then.
- **Rollback:** each group's PR reverts independently; the legacy credentials are still accepted, so a revert needs no secret change.

### Phase 3: stop accepting MFL keys as admin credentials (Checkpoint C, then B)
- **Precondition:** the Phase 1 log lines, read over a defined window, show **zero** `via=mfl_apikey` (and, as a separate decision, `via=test_sync_key`) lines. Suggested window: at least 14 consecutive days that include at least one run of every scheduled job and one manual-dispatch family cycle. Internal self-calls must be excluded or already moved (Phase 2, item 5), otherwise they show up as legacy uses. Reading production logs is itself a production read and needs Keith's go.
- **Change:** delete the `mfl_apikey` entry from `ADMIN_SECRET_SITES.admin_authority.legacy` (one line), tests updated to expect refusal, redeploy.
- **Rollback:** redeploy the previous worker version (the entry comes back). Keep that version number in the PR.
- `commish_key` is a separate later decision after Phase 2 callers and Phase 1b are complete and its own zero-use window.

### Phase 4: replace the worker's commissioner session material (Checkpoint C)
- Coordinated with an MFL sign-out and commissioner password change, **at a time with no contract, waiver, trade or auction deadline in the following days** and no live-sync run pending. No deadline pressure is the main requirement.
- Sequence: confirm Phase 2 and 3 are complete and stable; announce a quiet window; change the credential at MFL; sign out other sessions; update the worker's stored session secret and the matching GitHub secret; verify with one read-only worker route and one read-only MFL export; then watch the logs for failures for a full scheduled-job cycle.
- **Rollback:** an MFL password change is not reversible, so this is a forward-fix: re-authenticate and store the new value. Keep the procedure and the account recovery path ready before starting.

### Phase 5: hygiene (Checkpoint D for any destructive step)
- Purge CDN copies of files that referenced retired values (the existing `purge-jsdelivr.yml` workflow covers the mechanism).
- Review old branches and PR refs that carry retired values; deleting a branch is destructive and needs its own go (take a `git bundle` backup first). Rewriting history is **not** proposed here.
- Turn on GitHub secret scanning and push protection for the repository, and add a local pre-commit scan, so a value cannot be committed again.
- **Rollback:** CDN purge is idempotent; branch deletion is recoverable from the bundle taken beforehand.

## 5. What cannot be verified offline
- Live worker behavior: the deployed worker, its routes, and real Cloudflare secret bindings (the tests drive the real handlers with an in-memory database and stubbed network, with synthetic values only).
- Whether `UPS_ADMIN_KEY` exists, its length, and that it is not equal to another secret in production.
- GitHub Actions runs: the workflow inventory is a text scan of the YAML; no workflow was run.
- A real commissioner MFL session (the tests stub MFL's `myleagues` answer) and real Safari/phone behavior of the commissioner pages (not changed in Phase 1).
- The CORS preflight as a real browser sees it (a test checks the header value the worker sends, not a browser).
- Log volume in production (one line per legacy authorization per site; internal scheduled calls will add lines).
- `eslint` (`no-undef`) could not run offline; every touched file passes `node --check`, and the new tests import every touched module and assert its exports.

## 6. Tests
`tests/admin_key_phase1.test.mjs`: for each site a table of every credential and source accepted before (still accepted) and every refused case (still refused: wrong key, key in the wrong source, unset secret, empty key, an MFL key at a COMMISH-only site, a legacy value in the new header); `UPS_ADMIN_KEY` accepted by both headers at every site, refused from the URL, refused when unset, short or wrong, and independent of the legacy secrets; the log lines and the absence of any value in output; denial bodies unchanged; CORS; the policy table; and the structural scan. The accepted/refused tables for the legacy credentials were run against the unchanged base code before the change and passed, so they describe today's policy; the `UPS_ADMIN_KEY`, logging and CORS tests failed there, as they should.
