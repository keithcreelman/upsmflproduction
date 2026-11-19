# Owner bug reports (Step 2: test-only draft)

A signed-in owner reports a failed page to the commissioner. This slice is **test-only and dark**:
the flag ships off, nothing is wired into the live mobile app, and nothing posts anywhere.
This page holds no real report, name, team or error text: only rules.

## What this slice is, and is not

| Is | Is not |
|---|---|
| A phone sheet (`site/m/report_bug.js`) that shows what will be sent, then sends it | Wired into `site/m/index.html` or `app.js` (not loaded by the app yet) |
| Worker routes behind `BUG_REPORT_ENABLED`, which ships `"0"` | Enabled in production |
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
* **Same problem, same team, within 24 h** (same page + error name + message with digits collapsed + endpoint + status; with no error captured, the owner's words): added to the open report as a `duplicate` event instead of a new report. Up to 10, then refused. Does not use the daily allowance.
* **Rate limit** (new reports only, per team): at least 20 s apart; 5 per rolling 24 h. A refusal carries `retry_after_seconds` and a `Retry-After` header.
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

Table at its one-day worst case (12 teams × 5 reports = 60 rows):

| Step | rows read | rows written |
|---|---|---|
| Retry check (unique index) | 1 | |
| Duplicate check (pinned to its index) | 1 | |
| Rate window (≤ 5 rows) | 5 | |
| Save a new report: report row (+ 4 indexes) | 1 | 6 |
| Save a new report: event row (+ index) | 3 | 3 |
| Duplicate added: counter + event | 3 | 4 |
| Owner's own list (20 max) | 6 | |
| Commissioner list (50 of 60) | 50 | |
| Commissioner open one report | 1 + 2 | |

A new report is about **9 rows written and ~12 read**. At most 60 new reports a day.
The measurement caught a real problem: without `INDEXED BY`, the duplicate check read all 60 rows.

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
