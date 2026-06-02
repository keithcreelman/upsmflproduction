## MyFantasyLeague (MFL) API Notes (Extraction Only) — UPS League Edition

This document is intentionally limited to **reading/extracting data from MFL**.

### 0) UPS league host map (season -> league id -> base host)
Use this table to construct requests correctly. Do **not** assume host is constant.

| Season | League ID | League Name | Base URL (Host) |
|---:|---:|---|---|
| 2010 | 60671 | UPS WCBDFY Salary Cap League | https://www45.myfantasyleague.com |
| 2011 | 40832 | UPS Dynasty Cap | https://www46.myfantasyleague.com |
| 2012 | 37227 | UPS Dynasty Cap | https://www45.myfantasyleague.com |
| 2013 | 42721 | UPS Dynasty Cap | https://www46.myfantasyleague.com |
| 2014 | 30590 | UPS Salary Cap Dynasty | https://www45.myfantasyleague.com |
| 2015 | 29015 | UPS Salary Cap Dynasty | https://www44.myfantasyleague.com |
| 2016 | 27191 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2017 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2018 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2019 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2020 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2021 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2022 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2023 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2024 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |
| 2025 | 74598 | UPS Salary Cap Dynasty | https://www48.myfantasyleague.com |

How to use mapping:
- URL pattern: `{base_url}/{season}/export?{args}`
- Example:
  - `https://www48.myfantasyleague.com/2024/export?TYPE=rosters&L=74598&JSON=1`

### 1) URL format (extraction)

All read calls should use:
- `https://{host}/{season}/export?TYPE=...&...`

Example:
- `https://api.myfantasyleague.com/2025/export?TYPE=leagueStandings&L=74598&JSON=1`

### 2) Host selection rules

- League-specific extraction (`L=` present):
  - Prefer known league host (`www44`, `www45`, `www46`, `www48`) from mapping.
  - `api.myfantasyleague.com` usually works and may redirect to shard host.
- Non-league extraction (no `L=`):
  - Use `api.myfantasyleague.com`.
- Do not hardcode one host forever; leagues can move.

### 3) Season-year rules

- `season` in URL is fantasy season year, not always current calendar year.
- Historic extraction can require correct historic host + league id pairing.

### 4) Common extraction query args

- `TYPE` (required): dataset selector.
- `L`: league id (required for league-scoped exports).
- `W`: week for weekly endpoints (`playerScores`, etc.).
- `JSON=1`: request JSON.
- `APIKEY`: optional for some export calls (if cookie unavailable).

### 5) Extraction endpoint catalog (high-value)

Core league extraction:
- `TYPE=league`
- `TYPE=players`
- `TYPE=rosters`
- `TYPE=salaries`
- `TYPE=schedule`
- `TYPE=leagueStandings`
- `TYPE=transactions`
- `TYPE=myfranchise` (owner context)

Scoring and game context:
- `TYPE=playerScores` (week-based, supports league/global patterns)
- `TYPE=nflSchedule` (global)

Market/reference feeds:
- `TYPE=adp`
- `TYPE=salaryAdjustments`

### 6) Authentication for extraction

Cookie-based (most reliable for private/owner-scoped data):
- Header: `Cookie: MFL_USER_ID=<cookie>`

API key option:
- `APIKEY=<key>` can work for many export calls.
- Some endpoints/older leagues may behave differently with API keys.
- If an endpoint fails with API key, retry with cookie-only.

Practical rule:
- For admin/private extraction, use cookie.
- For public/global extraction, use no auth or API key as needed.

### 6a) User identity via `_apiKey_` (canonical pattern for in-page hubs)

MFL exposes a per-user, per-page API key as the JavaScript variable
`window._apiKey_` on every authenticated page. This is the canonical
way for our in-page hubs (Team Operations, Roster Workbench, etc.) to
identify the logged-in user without dealing with session cookies.

**Pattern:**
```js
var apiKey = window._apiKey_;        // set by MFL on authenticated page loads
if (apiKey) {
  var url = "/api/mfl-export?TYPE=myfranchise&L=" + leagueId
          + "&YEAR=" + year + "&APIKEY=" + apiKey + "&JSON=1";
  fetch(url).then(r => r.json()).then(data => {
    // data.myfranchise.id = the user's franchise for this league
  });
}
```

**Host requirements (critical):**
| TYPE | Must be called on |
|---|---|
| `myleagues` | `api.myfantasyleague.com` only — www48 returns "must go to api.*" |
| `myfranchise` | `api.myfantasyleague.com` only — same error on shards |
| `myleague` | `api.myfantasyleague.com` only |
| (all others) | League shard (e.g. `www48`) or `api.*` |

Our worker `/api/mfl-export` proxy routes user-scoped TYPEs to `api.*`
automatically — frontends just call the proxy with the TYPE + APIKEY
and the worker picks the right host.

**Why this pattern wins over cookies:**
- No `MFL_USER_ID` cookie reading required
- Works through cross-origin worker proxy (cookies don't survive cross-origin)
- Reliable on every authenticated page; `_apiKey_` is always set when logged in
- No CORS issues — APIKEY is a URL param, not a header

**Where it doesn't work:**
- Offline / not logged in (no `_apiKey_` set)
- Outside MFL pages (e.g., local dev) — fall back to URL `?F=` param or picker

**Response shape examples:**
- `TYPE=myleagues` → `{ myleagues: { league: [{ league_id, franchise_id, name, host, ... }] } }`
- `TYPE=myfranchise&L=<lid>` → `{ myfranchise: { id: "0008", name: "Real Deal Creel" } }`

### 7) Throttling and retry policy (CANON — required for batch fetches)

- Baseline: 1 request/sec.
- On `429 Too Many Requests` (or `5xx`):
  - Exponential backoff (`2s, 4s, 8s, ...`).
  - Drop concurrency to 1.
  - Do not spam retries.
- Always send a stable `User-Agent`.

**Standard helper — route batch MFL fetches through it, do NOT call bare `fetch()`
in a loop.** The worker exposes `fetchWithBackoff(url, opts, tries=4, baseDelay=600)`
(defined next to `safeStr` in `worker/src/index.js`): it retries on 429/5xx with
exponential backoff and returns the final response. Any endpoint that fans out
across seasons/weeks/players (e.g. `/admin/backfill-playoff-weekly`,
`/admin/sync-src-draft-picks`) MUST use it.

> Why this is canon: the 5-season playoff backfill (35 MFL fetches in one request)
> rate-limited mid-batch — 2024 W17 + all of 2025 silently came back empty — and
> had to be re-run per-season. `fetchWithBackoff` + per-season runs is the rule.
> When a batch is large, still prefer one season per invocation over one giant run.

### 8) Caching policy (recommended)

- `players`: refresh daily at most.
- `league`: once per run/session unless troubleshooting.
- `schedule`, `leagueStandings`, `rosters`, `salaries`: refresh when needed for current week.
- `nflSchedule`: refresh weekly or on demand.
- `adp`: refresh based on your modeling cadence (not every pipeline step).

### 9) Data typing and parsing pitfalls

- Player IDs are strings; preserve leading zeroes (e.g. `"0531"`).
- Franchise IDs are 4-char strings (`"0001"` style), not integers.
- Keep `season`, `week`, and IDs as strings in raw layer; cast later in transforms.
- Treat missing fields as normal; MFL payload shape can vary by endpoint/year.

### 10) Response format guidance

- Prefer `JSON=1` where supported.
- Some feeds are XML-first in practice; if needed, parse XML fallback.
- Build extractors defensively:
  - object-or-list normalization
  - optional key handling
  - backward-compatible field mapping

### 11) Canonical extraction examples

League metadata:
- `https://api.myfantasyleague.com/2025/export?TYPE=league&L=74598&JSON=1`

Rosters:
- `https://api.myfantasyleague.com/2025/export?TYPE=rosters&L=74598&JSON=1`

Salaries:
- `https://api.myfantasyleague.com/2025/export?TYPE=salaries&L=74598&JSON=1`

Standings:
- `https://api.myfantasyleague.com/2025/export?TYPE=leagueStandings&L=74598&JSON=1`

Schedule:
- `https://api.myfantasyleague.com/2025/export?TYPE=schedule&L=74598&JSON=1`

Weekly player scores:
- `https://api.myfantasyleague.com/2025/export?TYPE=playerScores&W=1&L=74598&JSON=1`

NFL schedule (global):
- `https://api.myfantasyleague.com/2025/export?TYPE=nflSchedule&W=ALL&JSON=1`

### 12) Extraction-only operating rules for Claude

- Focus on `export` endpoints only.
- Never mutate league data in extraction workflows.
- Keep host/season/league mapping explicit and auditable.
- Store raw payload snapshots before transformations when debugging.
- Log URL (minus secrets), status code, and retry count for each call.
- Never commit cookies/API keys to repo or docs.
