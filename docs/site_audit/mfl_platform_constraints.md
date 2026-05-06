# MFL Platform Constraints — Site Audit Reference

Compiled 2026-04-28 for the UPS league site audit (league `74598` on `www48.myfantasyleague.com`).

This document captures what MyFantasyLeague (MFL) **allows, restricts, and recommends** for site customization and API use, grounded in:

- The repo's own captured docs (`docs/MFL_API.md`, `docs/MFL_IMPORT_EXPORT_DETAILED.md`, `docs/MFL_IMPORT_EXPORT_QUICK_GUIDE.md`)
- Live MFL API docs at `https://www03.myfantasyleague.com/2026/api_info` (fetched 2026-04-28)
- Observed behavior in the worker (`worker/src/index.js`) and embed loaders (`site/loader.js`, `site/ccc/mfl_hpm_embed_loader.js`)
- Repo git history (commit messages quoted with SHAs)

When a claim is "observed in repo" rather than documented by MFL, that is called out explicitly. Items still unknown after this pass are flagged at the bottom.

---

## Site Customization

### HTML / CSS / JavaScript

MFL exposes Header, Footer, and Home Page Module (HPM / "MESSAGE") fields where commissioners paste raw HTML. **The platform does not document any tag allow-list, sanitizer, or CSP** — observed in repo, the entire UPS site is delivered by injecting `<script>` tags into these fields and letting them execute.

- **`<script>` tags: allowed and execute as the page.** Every UPS embed (header, footer, every HPM) is a `<script src="…cdn.jsdelivr.net…/loader.js">` tag pasted into the corresponding MFL field.
  - Reference: `site/README.md:1-79` lists the exact `<script>` snippet for each slot.
  - Reference: `apps/mfl_site/header_custom_v2.html` and `footer_custom_v2.html` are full HTML documents with multiple inline `<script>` blocks (see lines 10, 1380, 1559, 1667, 1867 in header_custom_v2.html) that MFL renders without modification.
- **External JS/CSS resources: allowed.** The footer pulls scripts from third-party hosts (`https://www.mflscripts.com/mfl-apps/global/footer.js`, `https://mflscripts.com/mfl-apps/playoffs/standingsColumns.js` — `apps/mfl_site/footer_custom_v2.html:96-97`). UPS code pulls from `cdn.jsdelivr.net` and `rawcdn.githack.com` (see `docs/API_GUIDE_FOR_CLAUDE.md:236`).
- **`<iframe>` tags: allowed.** The Contract Command Center is rendered inside an iframe injected by `site/ccc/mfl_hpm_embed_loader.js:308-316`. The iframe communicates with its host via `postMessage` (lines 333, 343).
- **CSP rules: not enforced by MFL on these embeds** — no `Content-Security-Policy` header restrictions show up in repo code, and inline scripts execute freely. (Observed; not explicitly documented by MFL.)
- **Cross-origin from non-MFL pages: blocked.** The official docs explicitly say: *"Accessing the API via Javascript from web pages outside the myfantasyleague.com domain. Normal browser security will prevent this and we will not put your domain in our cross-domain file to allow it."* (https://www03.myfantasyleague.com/2026/api_info). This is why the UPS Cloudflare Worker exists as a proxy — see `worker/src/index.js:619-623` "*The Workbench iframe srcdoc can't hit api.myfantasyleague.com directly (null origin → CORS blocked). Worker fetches server-side, returns a flat JSON the UI can overlay.*"

### Home Page Modules (HPMs)

- **Slot count and naming:** MFL provides numbered MESSAGE slots referenced as `MODULE=MESSAGE<N>`. The UPS league actively uses at least MESSAGE2, MESSAGE5, MESSAGE9, MESSAGE12, MESSAGE13, MESSAGE15, MESSAGE16, MESSAGE17 (refs: `apps/mfl_site/README.md:13-21`, `site/README.md:23-69`, commit `78a63a9` — "auto-render Stats Workbench on MESSAGE13", commit `bf3c957` — "Auto-mount Rookie Draft Hub on MESSAGE12"). The exact upper-bound slot count is **unknown** — not stated in the captured docs and the test endpoint did not return module limits.
- **Size limits:** **Unknown** from MFL docs. Observed in repo, large payloads are deferred via the embed-loader pattern (the MESSAGE field holds only a `<script src=…>` reference and the actual HTML/JS lives at `cdn.jsdelivr.net`), which strongly implies MFL has either a character cap or simply made the workflow painful enough that the league switched to remote loading. Bumping `?v=…` query strings is required to bust MFL's HTML cache (`site/README.md:87`).
- **Formatting:** HPM HTML is rendered inside MFL's existing page chrome (DOM class `homepagemodule.report` — see `apps/mfl_site/header_custom_v2.html:445`, `:454`, `:467`, `:474`). Custom CSS targets `.homepagemodule.report` to override MFL defaults.
- **Embed types:** Image, table, raw HTML, `<script>`, `<iframe>` all observed working. Tabs are commissioner-defined — `TYPE=appearance` (`docs/MFL_IMPORT_EXPORT_DETAILED.md:348-354`) returns "*the skin, home page tabs, and modules within each tab set up by the commissioner.*"
- **Positioning rules:** Tabs and module-to-tab assignments are configured server-side via the Appearance setup. There is no public import endpoint to write `appearance` — only export. This means HPM placement must be done by hand in MFL admin UI.

### League Host Pages (Header / Footer / About)

- **Header field:** editable, executes scripts. UPS injects a multi-lane marquee, full custom dark skin, quick-actions UI (commit `b256bc2` per `docs/ai-change-log.md:78-95`).
- **Footer field:** editable, executes scripts. UPS injects league links + 3rd-party scripts (`apps/mfl_site/footer_custom_v2.html`).
- **Skin / theme:** controlled per-league by Appearance setup. The list of available skins is **not documented** in repo or the captured API docs.
- **About / Static Pages:** **unknown** — not enumerated in the captured docs.

---

## API Surface

### Authentication

| Method | Read (export) | Write (import) | Source |
|---|---|---|---|
| **Cookie** (`Cookie: MFL_USER_ID=<value>`) | Works for public + private + commissioner-only | **Required** for all imports | https://www03.myfantasyleague.com/2026/api_info ; `worker/src/index.js:2380-2383`; `docs/MFL_API.md:84-94` |
| **API key** (`?APIKEY=<key>`) | Works for many export calls | Not supported — *"does not work for import requests"* | https://www03.myfantasyleague.com/2026/api_info |
| **OAuth** | Not offered | Not offered | (absent from docs) |

Specifics:
- Cookie value is base64 — *"may contain the special symbols `+`, `/` and/or `=`"* (https://www03.myfantasyleague.com/2026/api_info). Worker handles raw vs. `MFL_USER_ID=…`-prefixed values: `worker/src/index.js:2361-2383`.
- APIKEY is *"tied to a user/franchise/league combination and does not work outside that context"* and if both cookie and APIKEY are sent on an export, "the APIKEY parameter will take precedence" (https://www03.myfantasyleague.com/2026/api_info).
- Login endpoint is `POST /<season>/login?USERNAME=…&PASSWORD=…&XML=1` and returns the cookie value (`<status cookie_name="…">`).
- Commissioner can impersonate any owner on writes by adding `FRANCHISE_ID=<id>` (every import endpoint that supports owner actions exposes this — see `docs/MFL_IMPORT_EXPORT_DETAILED.md:556-843`).

### Rate Limits

Documented (https://www03.myfantasyleague.com/2026/api_info, "starting 2020"):
- Per-IP baseline limit for unregistered clients.
- Registered clients (registration requires cell phone validation + a User-Agent) get *"about 2.5X of the limits for un-registered clients."*
- *"Wait one second between making requests."*
- Exceeding triggers `HTTP 429 Too Many Requests`.
- *"We are not counting all requests, just a sample of them. So the limits won't ever be exact."*
- Specific request-per-second numbers are **not published** by MFL.

Observed in repo:
- Hit-and-recover seen in production: commit `5af4652` "*fix(header): soft-handle MFL export 429 with cached fallback*" — added 160 lines to `apps/mfl_site/header_custom_v2.html` to degrade gracefully when MFL throttled the marquee feeds (Feb 2026).
- Worker retry logic only retries once on 429/502/503/504 with a 250 ms gap (`worker/src/index.js:2742-2750`; `:2784-2795`). Aggressive retries are intentionally avoided.
- Recommended baseline in `docs/MFL_API.md:97-103`: *"Baseline: 1 request/sec. On 429: exponential backoff (2s, 4s, 8s) with jitter. Drop concurrency to 1. Always send a stable User-Agent."*

### Endpoints In Use (catalog)

Read endpoints actively wired into the UPS worker (from `worker/src/index.js` greps + `docs/API_GUIDE_FOR_CLAUDE.md:31-43`):

| TYPE | Where used | Notes |
|---|---|---|
| `league` | `worker/src/index.js:46`, `:1396`, `:635` | League meta, franchises, commissioner email visibility (commish cookie unlocks owner emails per `docs/MFL_IMPORT_EXPORT_DETAILED.md:20`) |
| `rosters` | `worker/src/index.js:44`, `:1395`, `:637` | Current rosters with status (R/S/NS/IR/TS) |
| `salaries` | `worker/src/index.js:42` | Contracts; export is owner-only |
| `transactions` | `worker/src/index.js:43`, `:1966` | Filtered via `TRANS_TYPE`/`DAYS`/`COUNT` |
| `freeAgents` | `worker/src/index.js:47`, `:1483` | Owner-only on private leagues |
| `injuries` | `worker/src/index.js:45`, `:1394` | Daily-cadence data |
| `draftResults` | `worker/src/index.js:48` | "Up to 15 minutes delayed" per MFL |
| `playerScores` | `worker/src/index.js:1952` | YTD/AVG/per-week |
| `playerProfile` | `worker/src/index.js:1392` | Public, no L required |
| `players` | `worker/src/index.js:1393`, `:20861` | DETAILS=1 for full schema; *"max once per day"* per MFL |
| `myfranchise` | `worker/src/index.js:2427` (`myFrUrl`) | Owner-context resolution |
| `nflSchedule`, `nflByeWeeks`, `pointsAllowed`, `adp`, `salaryAdjustments` | various | Reference feeds (`docs/MFL_API.md:64-81`) |

Write endpoints in use:
- `import?TYPE=salaries` — commissioner-only contract writes (`worker/src/index.js:18156`)
- `import?TYPE=salaryAdj` — commissioner-only salary adjustments (`worker/src/index.js:18398`)
- All other write endpoints are documented in `docs/MFL_IMPORT_EXPORT_DETAILED.md:542-843` but not wired into the worker today.

The full export catalog (58 types) and import catalog (27 types) are in `docs/MFL_IMPORT_EXPORT_DETAILED.md` — that file is the canonical reference for what's possible.

### Real-time vs Cached vs Manual-Trigger Endpoints

Per MFL docs (https://www03.myfantasyleague.com/2026/api_info?STATE=details) and `docs/MFL_IMPORT_EXPORT_DETAILED.md`:

| Endpoint | Cadence | Source |
|---|---|---|
| `liveScoring` | Real-time during games | Endpoint description (line 158-165) |
| `nflSchedule` | Updated every ~15 min during games (does **not** update *while games in progress* — 2020 change) | Endpoint description (line 518-524) |
| `nfl_sched.xml` (alt static feed) | Same 15-min cadence; *"will no longer update while games in progress"* | https://www03.myfantasyleague.com/2026/api_info?STATE=details |
| `injuries` | Daily during season + preseason | Endpoint description (line 510-516) |
| `players` | "Updated at most once per day" — store locally | Endpoint description (line 391-401) |
| `draftResults` (export) | "Up to 15 minutes delayed" | Endpoint description (line 197) |
| `topAdds`/`topDrops`/`topStarters`/`topTrades`/`topOwns` | Aggregate, current week / past 7 days during pre-season | Endpoint descriptions (line 449-491) |
| `playerScores` | Per-week, YTD, AVG | Endpoint description (line 167-180) |
| `transactions` | Live (post-commit) | Endpoint description (line 88-100) |
| Salary/contract changes | **Not version-tracked** — historical `rosters?W=` queries always return *current* salary fields, not historical | Endpoint description (line 42-43): *"Changes to salary and contract info is not tracked so those fields (if used) always show the current values"* |

Manual-trigger / write-only:
- All `import?TYPE=…` endpoints fire only on explicit POST.
- `assignFranchise` is **not** in the export/import catalog captured here — likely an admin-UI-only action; **flag for follow-up**.

### Caching Recommendations (repo policy)

From `docs/MFL_API.md:106-111`:
- `players`: refresh daily at most.
- `league`: once per run/session unless troubleshooting.
- `schedule`, `leagueStandings`, `rosters`, `salaries`: refresh as needed for current week.
- `nflSchedule`: refresh weekly or on demand.
- `adp`: refresh at modeling cadence, not every pipeline step.

Worker-side cache TTLs (Cloudflare `cf.cacheTtl` in seconds — `worker/src/index.js`):
- `playerProfile` → 60 (line 1392)
- `players` (with DETAILS) → 86400 (line 1393)
- `injuries` → 300 (line 1394)
- `rosters` → 60 (line 1395)
- `league` → 600 (line 1396)
- `/api/mfl-league-state` proxy: league 300, rosters 60 (lines 636-638)

---

## Data Refresh Patterns (consolidated)

| Pattern | Endpoints |
|---|---|
| **Real-time** (poll for live data) | `liveScoring`, `transactions` (after commit) |
| **15-minute lag** | `draftResults`, `nflSchedule`/`nfl_sched.xml` during games |
| **Daily** | `injuries`, `players` |
| **On-demand** (no internal cache layer documented) | `league`, `rules`, `rosters`, `salaries`, `schedule`, `leagueStandings`, `weeklyResults`, `playerScores`, `freeAgents`, `assets` |
| **Aggregate / public** | `adp`, `aav`, `topAdds`, `topDrops`, `topStarters`, `topTrades`, `topOwns`, `whoShouldIStart` |
| **Manual-trigger only** | All `import?TYPE=…` endpoints |

Side-channel observations:
- `https://api.myfantasyleague.com/fflnetdynamic<YYYY>/mfl_status.xml` and `nfl_sched.xml` are direct static-feed shortcuts (https://www03.myfantasyleague.com/2026/api_info?STATE=details, "MISC ENDPOINTS").
- `appearance` is read-only via API — site customization changes must be made through the MFL admin UI, then read back via `TYPE=appearance` for inspection.

---

## Auth for Write Operations

Every write that the UPS league performs against MFL:

| Operation | Endpoint | Auth | Notes |
|---|---|---|---|
| Roster moves (add/drop) | `import?TYPE=fcfsWaiver` | Owner cookie (commish can impersonate via `FRANCHISE_ID`) | `docs/MFL_IMPORT_EXPORT_DETAILED.md:582-590` |
| Waiver/blind-bid claim | `import?TYPE=waiverRequest` / `blindBidWaiverRequest` | Owner cookie | `docs/MFL_IMPORT_EXPORT_DETAILED.md:592-614` |
| Lineup set | `import?TYPE=lineup` | Owner cookie | `docs/MFL_IMPORT_EXPORT_DETAILED.md:546-557` |
| IR move | `import?TYPE=ir` | Owner cookie | `docs/MFL_IMPORT_EXPORT_DETAILED.md:616-625` |
| Taxi move | `import?TYPE=taxi_squad` | Owner cookie | `docs/MFL_IMPORT_EXPORT_DETAILED.md:627-637` |
| Trade propose / respond | `import?TYPE=tradeProposal` / `tradeResponse` | Owner cookie | `docs/MFL_IMPORT_EXPORT_DETAILED.md:639-663` |
| MYM submission (extension write) | `import?TYPE=salaries` | **Commissioner cookie** | `worker/src/index.js:18133` enforces; `docs/MFL_IMPORT_EXPORT_DETAILED.md:748-756` |
| Restructure submission | `import?TYPE=salaries` | **Commissioner cookie** | Same path as MYM |
| Contract edits / commissioner override | `import?TYPE=salaries` (whole-table replace) | **Commissioner cookie** | See "silent reject" gotcha below |
| Salary adjustments | `import?TYPE=salaryAdj` | **Commissioner cookie** | `worker/src/index.js:18398` |
| Score adjustments | `import?TYPE=playerScoreAdjustment` / `franchiseScoreAdjustment` | **Commissioner cookie** | `docs/MFL_IMPORT_EXPORT_DETAILED.md:768-820` |
| Franchise edits (names, icons, contact) | `import?TYPE=franchises` (XML) | **Commissioner cookie** | `docs/MFL_IMPORT_EXPORT_DETAILED.md:559-567` |
| Draft / auction results upload | `import?TYPE=draftResults` / `auctionResults` (XML) | **Commissioner cookie** | `docs/MFL_IMPORT_EXPORT_DETAILED.md:677-694` |
| Email blast | `import?TYPE=emailMessage` | Owner cookie (any owner) | `docs/MFL_IMPORT_EXPORT_DETAILED.md:728-737` |

Cookie scoping rules:
- **A single `MFL_USER_ID` cookie carries that user's identity across every league they own.** Commissioner privilege isn't a separate auth — it's the same cookie, recognized as commish on the leagues where that user is configured as commish. The worker explicitly returns `403` if the configured `MFL_COOKIE` lacks commish privileges on the target league: `worker/src/index.js:15960-15969`, `:18133`, `:18398`, `:18642`.
- The worker carries two separate secrets in different cases: `MFL_COOKIE` (commish identity for league writes) and `COMMISH_API_KEY` (UPS-internal admin gate, not an MFL key) — see `docs/API_GUIDE_FOR_CLAUDE.md:215-218`.

---

## Known Gotchas

### 1. `TYPE=salaries` import silent-reject (FIXED Apr 2026)

The worker's `import?TYPE=salaries` POST was returning HTTP 200 with an empty body and **no actual write** until 2026-04-18.

Triggering combination (any one of these caused silent reject):
- `User-Agent: upsmflproduction-worker` (non-browser UA).
- `redirect: "manual"` instead of `"follow"`.
- Sending `APIKEY` alongside the cookie on an import.

Fix recipe (now in production):
- Browser-like UA: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`
- `redirect: "follow"`
- `Accept-Encoding: identity`
- Cookie-only auth, NO APIKEY in form body

References: `worker/src/index.js:18147-18170` (the canonical comment block), commit `dccfe62` "*Fix MFL TYPE=salaries silent-reject + contract tracer/audit tools*".

### 2. `import?TYPE=salaries` is whole-table replace

*"CRITICAL: MFL's TYPE=salaries import REPLACES the entire salaries table"* — `worker/src/index.js:18036`. The worker reads the current salary table, merges the desired delta, and posts the full merged set. Sending a partial DATA payload erases everything not included unless `APPEND=1` is set (`docs/MFL_IMPORT_EXPORT_DETAILED.md:756`).

### 3. APIKEY can be rejected mid-flight

Worker has explicit fallback: if APIKEY auth fails, retry with cookie-only auth (`worker/src/index.js:2698`, retry logic at `:2747` — *"errText.includes('api key validation failed')"*). Commit `21d8c21` "*Worker: fallback to cookie auth when MFL API key is rejected*" landed Mar 2026.

### 4. 429 throttling on the league header

Commit `5af4652` (Feb 2026) added a 160-line cached-fallback path to `apps/mfl_site/header_custom_v2.html` because the MFL marquee feeds were getting throttled when many owners loaded the home page concurrently. Lesson: client-side widgets must tolerate 429 from MFL on every fetch, not just batch jobs.

### 5. CORS blocks browser-direct calls to `api.myfantasyleague.com`

Cross-origin from non-MFL domains is blocked at the browser, and MFL refuses to add domains to its cross-domain file. Comment at `worker/src/index.js:619-623`: *"The Workbench iframe srcdoc can't hit api.myfantasyleague.com directly (null origin → CORS blocked). Worker fetches server-side, returns a flat JSON the UI can overlay."* All cross-origin reads must go through the Cloudflare Worker proxy.

### 6. League host is sharded (`www44`/`www45`/`www46`/`www48`/`api`)

`api.myfantasyleague.com` usually resolves and may redirect to the shard host, but **don't hardcode** — leagues can move shards. Use the explicit per-season mapping in `docs/MFL_API.md:8-26` for the UPS league. The worker mostly uses `www48` for league-scoped reads and `api` for global ones (`worker/src/index.js:42-48`).

### 7. Player IDs and franchise IDs are zero-padded strings

- Player IDs preserve leading zeros (e.g. `"0531"`).
- Franchise IDs are 4-char strings (`"0001"`).
- Cast to integers in raw extraction breaks join keys. (`docs/MFL_API.md:114-118`, `docs/API_GUIDE_FOR_CLAUDE.md:243-245`.)

### 8. `rosters?W=<past_week>` does not historicize salary fields

Salary/contract fields are always *current* on `rosters` exports, even when `W` is in the past — *"Changes to salary and contract info is not tracked so those fields (if used) always show the current values"* (`docs/MFL_IMPORT_EXPORT_DETAILED.md:42-43`). Build your own historical snapshots if you need year-over-year contract lineage. (UPS does this in `pipelines/etl/`.)

### 9. `draftResults` lags up to 15 minutes

Not safe to drive a live-draft UI from this endpoint. MFL's docs explicitly say *"this data may be up to 15 minutes delayed as it is meant to display draft results after a draft is completed. To access this data while drafts are in progress, check out this FAQ"* (`docs/MFL_IMPORT_EXPORT_DETAILED.md:197`). Use the `live_draft` MISC endpoint or `liveScoring` style polls for live state.

### 10. Login cookies have no documented TTL

The captured docs do not state when an `MFL_USER_ID` cookie expires. Observed in repo: the worker treats cookie staleness as a 403 from MFL with a generic error and surfaces it as *"MFL_COOKIE secret likely needs refresh"* (`worker/src/index.js:18479`). **Flag for follow-up:** the actual cookie lifetime is unknown.

### 11. HPM cache busting

MFL caches the HTML inside MESSAGE blocks. Bumping the `?v=YYYY.MM.DD.N` querystring on the embed-loader script is the documented way to force a refresh without re-pasting (`site/README.md:87`).

---

## Items Flagged for Follow-Up

These are explicitly **unknown** from this pass and would need direct experimentation or MFL support to resolve:

1. **Total HPM (MESSAGE) slot count.** The repo uses MESSAGE2/5/9/12/13/15/16/17 but the upper bound is undocumented. Observation: counts up to MESSAGE17 are confirmed wired.
2. **HPM character / size limits.** Not stated in docs. The defacto workaround (script-loader pattern) suggests one exists, but the actual cap is unknown.
3. **`assignFranchise` admin action.** Not in the export/import catalog captured here. Likely admin-UI-only or unlisted misc endpoint — verify against the MFL test page if needed.
4. **MFL_USER_ID cookie expiration.** Not documented; observed in repo only as "needs refresh" symptom.
5. **Available skin / theme list.** `TYPE=appearance` returns the current skin name but the catalog of valid skins is not surfaced in the captured docs.
6. **Per-IP rate limit numerics.** MFL says ~2.5x bonus for registered clients but does not publish the base rate. The repo's empirical "~1 req/sec is fine" is the only quantitative anchor.
7. **`MODULE=MESSAGE<N>` URL routing** — confirmed used in commit `b256bc2` and `apps/mfl_site/README.md:13`, but the MFL routing semantics for tabs vs. modules vs. pages aren't fully captured here.

---

## Sources

- `docs/MFL_API.md` (UPS league host map + extraction rules)
- `docs/MFL_IMPORT_EXPORT_DETAILED.md` (58 export + 27 import types, full arg lists)
- `docs/MFL_IMPORT_EXPORT_QUICK_GUIDE.md` (single-table summary)
- `docs/API_GUIDE_FOR_CLAUDE.md` (worker endpoint surface)
- `worker/src/index.js` (canonical write paths + retry/fallback)
- `site/README.md`, `apps/mfl_site/README.md` (HPM/MESSAGE wiring)
- `site/loader.js`, `site/ccc/mfl_hpm_embed_loader.js` (embed patterns)
- Git log: commits `5af4652`, `21d8c21`, `dccfe62`, `b256bc2`, `78a63a9`, `bf3c957`
- https://www03.myfantasyleague.com/2026/api_info (live API docs, fetched 2026-04-28)
- https://www03.myfantasyleague.com/2026/api_info?STATE=details (live endpoint catalog, fetched 2026-04-28)
