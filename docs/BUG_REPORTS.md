# Owner bug reports (Step 2: test-only draft)

A signed-in owner reports a failed page to the commissioner. This slice is **test-only and dark**:
the flag ships off, nothing is wired into the live mobile app, and nothing posts anywhere.
This page holds no real report, name, team or error text: only rules.

## What this slice is, and is not

| Is | Is not |
|---|---|
| A phone sheet (`site/m/report_bug.js`) that shows what will be sent, then sends it | Wired into `site/m/index.html` or `app.js` (not loaded by the app yet) |
| Worker routes behind `BUG_REPORT_ENABLED`, a wrangler var that ships `"0"`. Off means **zero D1 calls and zero MFL calls**: the flag is read from the environment only, never from the database | Enabled in production |
| Private D1 storage (`ups_bug_reports`, `ups_bug_report_events`) | A repo file, a Pages file or a cache |
| One MFL identity read per request, plus D1 | A Discord post, a DM, a GitHub call, an Anthropic call or an agent |
| Text only | Screenshots |

Not built here, by decision: `#app_bugs`, the Discord approval DM, status updates, the AI fix agent.

## Exactly what an owner submits

`POST /api/bug-reports?L=<league>&YEAR=<season>`, JSON body. Every field is on an allowlist; any
other field, anywhere in the body, is refused by name.

| Field | Required | Limit | Notes |
|---|---|---|---|
| `client_request_id` | yes | 8–64 chars `A-Za-z0-9_-` | Made once per open sheet. A retry reuses it, so a double tap or flaky network never makes two reports |
| `summary` | yes | 3–120 | "What went wrong?" |
| `note` | no | 1,000 | "What were you doing?" |
| `screen` | yes | 80 | The app's page name, not the address bar |
| `build` | no | 40 | App version |
| `client_time` | no | ISO time | The phone's clock |
| `viewport` | no | `{w, h}` | Screen size |
| `online` | no | boolean | |
| `error.name` | no | 60 | |
| `error.message` | no | 500 | |
| `error.endpoint` | no | 160 | Path only: no host, query string or fragment; token-looking segments become `:id` |
| `error.status` | no | 100–599 | HTTP status |
| `mfl_user_id` | yes | | The owner's MFL sign-in, used for the identity check. **Never stored, logged or echoed** |

Never sent or accepted: franchise id (the team is **proven** from the MFL session), cookies,
passwords, keys, full web addresses, page text, response bodies, screenshots, localStorage.

## Who can read what

| Reader | Route | Sees |
|---|---|---|
| The owner | `POST /api/bug-reports/mine` | Their own reports only (`WHERE franchise_id =` the proven team): code, status, their summary, times, how many times they reported it. No notes, errors or team ids |
| The commissioner | `POST /api/bug-reports/commish/list`, `/commish/get` | Everything, including team, note, error fields, redaction count and events. Allowed: a proven commissioner MFL session in the body, or the commissioner key as `Authorization: Bearer` **only**. A key in the address (`?APIKEY=` or a look-alike such as `key`, `token`) is **refused with 400 before anything is read**, even beside a valid session or header; the response never repeats it |
| Everyone else | | Nothing |
| Discord, GitHub, the repo, public Pages | | Nothing in this slice. Later steps may carry only an ID, the page name and a one-line summary: never error text, notes, team names or screenshots |

Every response is `Cache-Control: no-store, private`. The owner's sign-in travels in the body, so it
never appears in an address, history or a log line. The commissioner routes are deliberately **not**
under `/admin/`: that front door takes a commissioner session only as `?MFL_USER_ID=` in the address
and would add a second MFL read.

## Failed sign-in: what the owner sees

The sheet keeps the owner's words on screen and shows a banner above the form. Nothing is sent.

| Situation | Server code | Banner |
|---|---|---|
| No MFL sign-in on the phone | `unauthenticated` (also detected on the phone, no request made) | **Sign in to MFL first.** Open UPS from MFL, then tap Report bug again. |
| MFL rejects the session | `session_expired` | **Your MFL sign-in expired.** Sign in to MFL again, open UPS from there, tap Send. |
| MFL login is not a team in this league | `forbidden` | **That MFL login isn't in this league.** |
| MFL does not answer (or takes over 5 s) | `identity_unavailable` | **Can't check your sign-in right now.** Try again in a minute. |
| Phone can't reach UPS | (none) | **Couldn't reach UPS.** Check your connection. |

Each banner offers **Try again** and **Copy details**, so an owner whose sign-in is the failure can
still pass the facts to the commissioner another way.

## Rate limit, duplicates, redaction

* **Retry** (same `client_request_id`): answered with the first report. Never a second row; does not count.
* **Same problem, same team, within 24 h** (same page + error name + message with digits collapsed + endpoint + status; with no error captured, the owner's words): added to the open report as a `duplicate` event instead of a new report. Up to 10, then refused. Does not use the daily allowance. **The cap is atomic:** the duplicate event is inserted by a statement that checks `fewer than 10 duplicate events exist` in the same statement, and the counter is then derived from the events (never blindly incremented), so more than 10 simultaneous duplicates stop at exactly 10 and the rest are refused with `duplicate_limit` and write nothing.
* **Rate limit** (new reports only, per team): at least 20 s apart; 5 per rolling 24 h. A refusal carries `retry_after_seconds` and a `Retry-After` header.
* **The limit is an atomic reservation, not a read followed by a write.** The gap and the cap are conditions *inside* the same `INSERT … SELECT … WHERE NOT EXISTS (newer than 20 s) AND (count in window) < 5` that stores the report, so simultaneous submissions from one team cannot all pass on the same earlier read (SQLite runs one statement under its write lock; D1 runs the report and event inserts as one batch/transaction). A refused attempt writes **0 rows**. It then reads the team's recent reports, only to tell the owner which limit applies and how long to wait. A same-`client_request_id` request that raced and lost is answered as a replay, not as a limit.
* **Two simultaneous reports of the same problem** (different request ids; both passed the duplicate lookup before either was saved): the one that wins the reservation is stored; the other, after losing it, looks for the now-open report and is recorded there as a duplicate (its note kept), never as a rate-limit refusal. Only when no matching open report exists does a refused reservation answer with the limit.
* A double tap that lands *after* the original was saved matches its own report by request id and is a replay, never a "duplicate" of itself.
* **Redaction** (server side, authoritative, before anything is stored): drops control and bidi-override characters; removes `key=value` pairs whose key is an API key, MFL user id, cookie, token, session, password, secret, authorization or signature; `Bearer …`; Discord webhook addresses; e-mail addresses; any 32+ character token-like string; and the query string and fragment of every address. The response says how many items were removed; the row stores the count.

## The one MFL read

Proving the owner's team uses `_rdhDetectFranchise` through `resolveTradeCaller` (`trade_authz.js`):
**one** request, `GET https://api.myfantasyleague.com/<season>/export?TYPE=myleagues&JSON=1`, carrying the
owner's own session as a cookie (the same thing the app already does for trades and lineups). It reads **0 D1
rows**, is **not cached** (a stale answer would be wrong about who someone is), and is bounded here to
**5 s** (the shared helper has no timeout of its own). Every request to these routes makes exactly
one such read, and none is made when the flag is off or the body is invalid or too large.
Its latency was **not measured** (no live MFL call in this slice).

## D1 cost (measured locally in Miniflare with D1's own counters; production not touched)

Table at its one-day worst case (12 teams × 5 reports = 60 rows). The SQL measured is the exact SQL in `makeD1Store`.

| Step | rows read | rows written |
|---|---|---|
| Retry check (unique index) | 1 | |
| Duplicate check (pinned to its index) | 1 | |
| Save a new report, rate check included: one conditional insert (report row + 4 indexes) | 8 (team already at 4 reports; 4 for a team with none) | 6 |
| Save a new report: event row (+ index) | 4 | 3 |
| Read the saved row back | 1 | |
| **A new report in total** | **≈ 15** | **9** |
| Refused by the 20 s gap: conditional insert + its event statement | 3 + 3 | **0** |
| Refused by the daily cap | 8 + 3 | **0** |
| After a refusal: recent reports, to word the message | 5 | |
| Duplicate added (atomic: capped event insert + counter derived from the events) | 12 for the 1st, up to ~39 for the 10th | 4 |
| Duplicate refused at the cap (the 11th, if it got past the early check) | ≈ 28 | **0** |
| Owner's own list (20 max) | 6 | |
| Commissioner list (50 of 60) | 50 | |
| Commissioner open one report | 1 + 2 | |
| Feature off | **0** | **0** |

At most 60 new reports a day, so the whole feature is a few hundred rows read and about 540 written per day at its ceiling. A refused attempt needs a proven owner session and costs about 14 rows read, 0 written.
Two real problems were caught by measuring and testing: without `INDEXED BY` the duplicate check read all 60 rows; and a separate "read recent, then insert" let simultaneous requests all pass the limits (now the single conditional insert; the old separate rate read is gone from the happy path).


## Integration with the phone app (test-only, issue #1473)

Still test-only: `site/m/index.html` does **not** reference `report_bug.js`, the worker flag stays `"0"`, the migration stays unapplied. A page that wants the sheet loads `report_bug.js` **before** `app.js` and calls `UPSReportBug.install({ build, observe: true })`; with the script absent the app behaves exactly as before (a recorded golden proves it).

**Where a failure is caught**
| Source | How | Visible to the owner as |
|---|---|---|
| Any failed request (network error, timeout/abort, HTTP 400+), including ones the app swallows with `.catch(() => [])` | `install({ observe: true })` wraps the global `fetch`. Every request in `site/m` goes through it (a test fails the build if an XHR, beacon, EventSource, WebSocket, Worker or an aliased `fetch` ever appears) | the **chip** on the route where the request **started** |
| A render error the app catches (`renderRoute`) | guarded hook `reportBugNote` in `app.js` | the chip |
| An error toast (`showToast(text, "err")`) | guarded hook in `app.js` | the chip |
| A page that looks wrong with nothing recorded | **More → Report a problem** (a row `app.js` shows only when the script is present) | the sheet, with "No error message was captured" |

**Not covered, stated plainly:** a JavaScript error swallowed by one of the app's `try/catch` blocks that never reaches the render boundary or a toast. No network layer can see it; the owner can still report it from More.

**The chip** ("Something didn't load · Report bug") sits above the bottom nav while the screen the owner is on has a recorded failure from the last 10 minutes. It carries that failure's screen name, endpoint path, status and error name/message. A route that redirects (`#market` goes to `#players`) is named for the page the owner lands on. A request that starts on route A and fails after the owner has moved to route B is attributed to **A**: no chip on B; it stays reportable from More (the sheet lists recent failures newest first, then "Something else looks wrong") and the chip returns on A.

**Expected-exception ledger** (`EXPECTED_NON_FAILURES` in `report_bug.js`): HTTP 400+ and network errors are reportable **unless** a path + status + reason is listed. The list is short and each entry is checked against real app code by a test: `/api/trades/proposals` 401 and 403 (signed-out Trades state), `/api/auction/*` 503 (falls back to MFL's page), `/api/trades/2way` 409 (rule gates the app explains itself), `/api/player-weekly-box` 404 (shown as unavailable). Matching is by path and status only because response bodies are never read. **Noise is unverified** until a real signed-in phone runs it: a missing static Pages data file (a 404 the app treats as "no data") would show the chip, and the ledger is where such a case would be added once it is seen.

**What the observer never does:** read a request or response body or header; keep the query string or fragment (the endpoint is a path); record the bug-report POST itself; change the request, the response or the promise the app gets back.

**Tests:** `tests/report_bug_transport.test.mjs` (the global `fetch` is the only transport; ledger and page names), `tests/report_bug_integration.test.mjs` (the real `app.js` and `report_bug.js` on a fake phone with the real handler behind a stub worker: identical-without-script golden, healthy phone, every request on every route in every failure mode, the navigation race, More, render errors, toasts, leaks, mutation checks), `tests/fixtures/phone_vm.mjs` (the fake phone). Not in the safe suite: the real views and real Chromium (there is no DOM or browser dependency); those run separately as evidence.

## Migration

`worker/migrations/0175_bug_reports.sql` has a **provisional** number. `0174` is held by the
trade-idempotency PRs; `0173` collides between `main` and #1306. Re-scan open PRs and branches
before merging and renumber if needed. `CREATE … IF NOT EXISTS`, safe to re-apply. **Nothing in this slice applies it to production.**

## Release dependencies (unverified, deliberately deferred)

Not needed for this slice; needed before any Discord step. Nothing here was checked against the live server:

* the league bot's real permissions in the server and in the Discord test channel;
* which Discord application owns the interactions endpoint, versus the bot that sends the DM;
* that `DISCORD_CONTRACT_TEST_CHANNEL_ID` equals the intended test channel;
* creating `#app_bugs` and proving it is read-only to members.

## Tests

`node scripts/safe_tests/run.mjs` (offline, no production). Files: `tests/bug_report_core.test.mjs`
(rules and redaction corpus), `tests/bug_reports.test.mjs` (the real worker, real SQLite, stubbed MFL),
`tests/report_bug_client.test.mjs` (what the sheet sends and shows, and its agreement with the server).
Concurrency tests hold every request at the moment it is about to write until all have arrived, so each decided on the same earlier state (the worst case), and fail against a read-then-insert design. The test D1 adapter runs a batch with no `await` between statements, as D1 does. Not verified: behavior under real D1's concurrency (no production call in this slice).
