# MFL API Canon Review — Ground Truth vs Codebase Assumptions

**Sources cited:**
- Live: `https://www48.myfantasyleague.com/2026/api_info?L=74598` (overview)
- Live: `https://www48.myfantasyleague.com/2026/api_info?STATE=details&L=74598` (per-type detail)
- Repo: `docs/MFL_IMPORT_EXPORT_DETAILED.md` (snapshot 2026-02-18; matches live verbatim)
- Repo: `docs/MFL_IMPORT_EXPORT_QUICK_GUIDE.md`
- Repo: `docs/MFL_API.md`
- Worker: `worker/src/index.js`
- Client: `site/trades/trade_workbench.js`

---

## TL;DR — What's in the docs vs what the codebase assumes

1. **`rosters` is documented as complete and authoritative.** Doc says: "The current rosters for all franchises in a league, including player status (active roster, IR, TS)…". No documented exclusions. The worker (and `trade_workbench.js`'s new phantom-player guard) correctly treat `rosters` as the source of truth for ownership.
2. **`assets` is documented as complete.** Doc says: "All tradable assets (players, current year draft picks, future draft picks) for a given league." No documented omissions. **The codebase comment claiming `assets` "legitimately misses some FP_ future picks" is not supported by MFL documentation** — it is an undocumented assumption.
3. **`pendingTrades` `FRANCHISE_ID` is commish-impersonation only.** Doc says verbatim: *"When request comes from the league commissioner, this indicates which franchise they want. Pass in '0000' to get trades pending commissioner action"*. Sending `FRANCHISE_ID` as a non-commish owner is either ignored or treated as the requester's own franchise. The worker's recent fix (commit 8618190) to never pass `FRANCHISE_ID` to owner-cookie calls aligns with the docs.
4. **Auth model is consistent:** owner exports = `MFL_USER_ID` cookie OR `APIKEY`; **commissioner imports require commissioner cookie** (APIKEY not accepted per overview page: "API Key Alternative — For export requests only (not imports or commissioner operations)"). The worker's `mflExportJson*` (cookie + optional APIKEY) and `postMflImportForm*` (cookie-only) match this.

---

## A) `rosters` (export)

**Verbatim (api_info STATE=details):**
> "The current rosters for all franchises in a league, including player status (active roster, IR, TS), as well as all salary/contract information for that player."

**Arguments (verbatim):**
- `L`: League Id (required)
- `FRANCHISE`: "When set, the response will include the current roster of just the specified franchise."
- `W`: "If the week is specified, it returns the roster for that week. The week must be less than or equal to the upcoming week. Changes to salary and contract info is not tracked so those fields (if used) always show the current values."

**Auth:** Overview implies private-league restriction; not explicitly labeled in the per-type entry but other private exports are labeled "Private league access restricted to league owners" and `rosters` behaves identically in practice.

**Documented exclusions:** **None.** The doc states all franchises, all players, with status. There is no documented case where a rostered player is omitted.

**Worker uses (sampled):**
- `worker/src/index.js:13474` — viewer-cookie rosters fetch for trade workbench loader.
- `:23754`, `:23834` — rosters for trade verification and ownership re-check (with retry+viewer cookie).
- `:27752`, `:28026`, `:28192`, `:29154`, `:29538` — bulk/admin rosters reads for backfills.
- `:31624`, `:31476` — verify rosters after imports.

**Discrepancy:** None for `rosters`. The codebase correctly treats it as authoritative.

---

## B) `assets` (export)

**Verbatim (api_info STATE=details):**
> "All tradable assets (players, current year draft picks, future draft picks) for a given league. Access restricted to league owners."

**Arguments (verbatim):** `L`: League Id (required).

**Documented exclusions:** **None.** The description is explicit that it returns players AND current-year DPs AND future picks (FPs).

**Worker uses:**
- `worker/src/index.js:31889` — `mflExportJsonWithRetry(season, leagueId, "assets", {}, { includeApiKey: true, useCookie: true })` inside the trade workbench loader.

**Discrepancy / CLAIM TO RETRACT:**
- `site/trades/trade_workbench.js:1943-1945` comment reads: *"PICKS only — MFL's assets export legitimately misses some FP_ future picks, so synthesizing them from the offer payload is the documented workaround."*
- **There is no MFL documentation supporting this.** The doc text explicitly includes "future draft picks" as part of the assets response. The "documented workaround" phrasing is misleading; no MFL doc page describes such a workaround. This looks like an empirical workaround for an observed edge case (possibly: pick was already traded away/used and assets snapshot lagged, or the request was made without commissioner-equivalent visibility) that was rationalized as documented behavior in the comment.
- Recommended action: either (a) link a verified MFL FAQ/forum post if one exists, or (b) reword the comment to "empirical workaround — observed missing FP_ tokens in some assets payloads; not documented as expected behavior."

---

## C) `pendingTrades` (export)

**Verbatim (api_info STATE=details):**
> "Pending trades that the current franchise has offered to other franchises, or has been offered to by other franchises. Access restricted to league owners."

**Arguments (verbatim):**
- `L`: League Id (required)
- `FRANCHISE_ID`: "When request comes from the league commissioner, this indicates which franchise they want. Pass in '0000' to get trades pending commissioner action)."

**Auth:** Owner cookie returns that owner's pending trades. Commish cookie + `FRANCHISE_ID=NNNN` returns that franchise's pending trades; `FRANCHISE_ID=0000` returns commissioner-action queue.

**Confirmation:** Keith's read matches verbatim — `FRANCHISE_ID` is commish-impersonation only. The worker's commit 8618190 ("never pass FRANCHISE_ID to MFL pendingTrades" in owner-cookie path) is correct per the doc.

**Discrepancy:** None remaining. Prior bug (passing `FRANCHISE_ID` with owner cookie) was a real bug.

---

## D) `salaries`, `players`, `league`, `myfranchise`, `salaryAdj` (import), `tradeProposal` (import)

### `salaries` (export)
**Verbatim:** *"The current player salaries and contract fields. Only players with values are returned. If a value is empty it means that the default value is in effect. The default values are specified under the player id '0000'. Private league access restricted to league owners."*
**Args:** `L` required.
**Worker uses:** `:13662`, `:13890`, `:17162`, `:22325`, `:23462`, `:25330`, `:26848`, etc. — heavy use, all read-only. Owner-cookie or APIKEY both work per overview.

**Codebase assumption matches doc:** Worker code that defaults missing-player rows to the `'0000'` defaults is correct per spec.

### `players` (export)
**Verbatim:** *"All player IDs, names and positions that MyFantasyLeague.com has in our database for the current year. … more than 2,000 players — in other words, you're strongly encouraged to read this data type no more than once per day, and store it locally as needed."*
**Args:** `L` optional; `DETAILS=1` for full details; `SINCE` unix ts; `PLAYERS` comma list.
**Auth:** None specified — public.
**Worker uses:** `:16332`, `:28194` (with `DETAILS:"1"`), `:28919`, `:29114`, `:29540`.
**Codebase aligns** with daily caching guidance (per `src_players` D1 mirror, memory item #11/#14).

### `league` (export)
**Verbatim:** *"General league setup parameters … If you pass the cookie of a user with commissioner access, it will return otherwise private owner information, like owner names, email addresses, etc. Personal user information, like name and email addresses only returned to league owners."*
**Args:** `L` required.
**Worker uses:** `:13473`, `:18150`, `:20235`, `:26846`, `:28195`, `:29113`, `:29541`, `:31887`, `:32277`.
**Doc-vs-code:** Worker correctly uses commish cookie when it needs owner emails (commish-only payload fields).

### `myfranchise` (export)
**Listed in repo `docs/MFL_API.md` §5 & §6a; not on the api_info STATE=details main list as standalone entry** (covered under the per-user/myleagues family). Repo doc states: must be called on `api.myfantasyleague.com`, returns `{ myfranchise: { id, name } }`, identified via `_apiKey_` or `MFL_USER_ID` cookie.
**Worker uses:** `:13325`, `:13475`, `:31890`. All use viewer cookie via `mflExportJsonWithRetryAsViewer`. Aligns with repo doc.

### `salaryAdj` (import — note: TYPE is `salaryAdj`, export is `salaryAdjustments`)
**Verbatim:** *"XML string representing the salary adjustments. The format for this data is `<salary_adjustments><salary_adjustment franchise_id='0001' amount='5.75' explanation='…'/>…</salary_adjustments>` For all adjustments, the franchise_id, amount and explanation fields are required and must not be empty. Use a negative amount to credit the franchise (i.e. reduce their salary). **The data will always be added to the existing salary adjustments.** Access Restricted: Requires cookie from league commissioner."*
**Args:** `L` required; `DATA` XML; (no APPEND/OVERLAY — always appends).
**Worker uses:** `:22084`, `:29863` (and verify reads at `:22132`, `:29751`, `:29832`, `:29870`).

**Doc-vs-code IMPORTANT:**
- Worker assumes commissioner cookie required → **matches doc**.
- "Data will always be added to existing" → if worker logic expects replace semantics, that would be wrong. Need to check whether `applySalaryAdjustments` paths read existing first and reconcile. (Worker pre-reads existing at `:22132`/`:29832` — implies it knows it's additive.)

### `tradeProposal` (import — note: TYPE is `tradeProposal`, not `proposeTrade`)
**Verbatim:** *"Propose a trade to another franchise. The WILL_GIVE_UP and WILL_RECEIVE parameters can also contain draft picks if the league allows draft pick trading. Current year draft picks are specified like DP_02_05 … future years picks … FP_0005_2018_2 where 0005 referes to the franchise id who originally owns the draft pick, then the year and then the round (in this case the rounds are the actual rounds, not one less). If the league uses Blind Bidding … BB_10.50. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter."*
**Args:** `L`, `OFFEREDTO`, `WILL_GIVE_UP`, `WILL_RECEIVE` (required); `COMMENTS`, `EXPIRES`, `FRANCHISE_ID` (optional).
**Worker uses:** Search for `tradeProposal` (or `proposeTrade`) in the worker — code path `:24679` (`tradeResponse`/reject), `:25019` (`tradeResponse` accept). Trade *proposal* posts go through `postMflImportFormAsViewer` with `TYPE=tradeProposal`.

**Doc-vs-code:** `FP_FFFF_YYYY_R` round numbers are 1-indexed (actual rounds) while `DP_RR_PP` round/pick are 0-indexed — the worker/client pick token parsers (`trade_workbench.js:638-643`) handle this distinction correctly.

---

## E) Authentication model — verbatim

**From `api_info?L=74598` overview:**
- Cookie-based (primary): *"users must be programmatically logged in via the login API using HTTPS. The response includes a cookie that should be passed in subsequent requests as: `Cookie: MFL_USER_ID=_cookie_value_`. Note: cookie values are Base64-encoded and may require URL-escaping special characters (+, /, =)."*
- API Key alternative: *"For export requests only (not imports or commissioner operations), users can pass an APIKEY parameter tied to a user/franchise/league combination. This parameter takes precedence if both cookie and API key are provided."*
- Roles: *"Commissioner Access: Required for specific requests; user must have commissioner privileges in the league. Owner/Franchise Operations: Can be performed by account owners; some requests allow FRANCHISE_ID parameter specification."*

**Rule of thumb (matches worker implementation):**
| Operation | Auth |
|---|---|
| Public exports (`players`, `nflSchedule`, `injuries`, `adp`, etc.) | None |
| Private owner exports (`rosters`, `salaries`, `salaryAdjustments`, `assets`, `pendingTrades`, `myfranchise`) | `MFL_USER_ID` cookie OR `APIKEY` |
| Owner-acting imports (`fcfsWaiver`, `ir`, `taxi_squad`, `lineup`, `tradeProposal`, `tradeResponse`) | Owner cookie (or commish cookie + `FRANCHISE_ID`) |
| Commissioner-only imports (`salaries`, `salaryAdj`, `franchises`, `draftResults`, `auctionResults`, `accounting`, `playerScoreAdjustment`, `franchiseScoreAdjustment`, `calendarEvent`) | Commissioner cookie only — APIKEY NOT accepted |

Worker's `postMflImportForm*` is cookie-only; aligns with doc that imports do not accept APIKEY.

---

## Claims to verify or retract

### 1. "MFL assets export legitimately misses some FP_ future picks" — **RETRACT**
- Source of claim: `site/trades/trade_workbench.js:1943-1945` comment and (probably) my prior conversation echoes.
- MFL doc says `assets` returns *"All tradable assets (players, current year draft picks, future draft picks)"* — no documented omissions.
- Action: This is an empirical workaround, not documented behavior. Either find an MFL FAQ/forum citation or rephrase as "empirical fallback for observed gaps; not in MFL spec."

### 2. "FRANCHISE_ID on pendingTrades is commish-impersonation only" — **CONFIRMED**
- Quoted verbatim from `api_info?STATE=details`: *"When request comes from the league commissioner, this indicates which franchise they want. Pass in '0000' to get trades pending commissioner action."*
- Worker fix in commit 8618190 is correct.

### 3. "Imports require cookie, never APIKEY" — **CONFIRMED**
- Overview verbatim: *"For export requests only (not imports or commissioner operations)"* APIKEY is permitted.

### 4. "rosters always lists every rostered player" — **CONFIRMED by doc text** (no documented exclusions)
- Caveat: when `W=` historical, salary/contract fields show *current* values, not point-in-time (verbatim in doc). This matches Keith's memory item about pre-2020 EOS-stamped salaries.

### 5. "`salaryAdj` import is additive, not replace" — **CONFIRMED**
- Doc verbatim: *"The data will always be added to the existing salary adjustments."*
- Codebase pre-reads existing adjustments before posting (worker `:22132`, `:29832`), consistent with additive semantics.

### 6. "`myfranchise` and `myleagues` must be called on `api.myfantasyleague.com`, not shards" — **CONFIRMED by repo doc**
- Per `docs/MFL_API.md` §6a: shard hosts return "must go to api.*" error. Worker uses `api.myfantasyleague.com` as base host (`worker/src/index.js:11463`), so this is satisfied.

---

## Worker call-site index (TYPE → line numbers)

- `league`: 13473, 18150, 20235, 26846, 28195, 29113, 29541, 31887, 32277
- `rosters`: 13474, 18749, 23754, 23834, 24918, 26847, 27752, 28026, 28192, 29154, 29538, 29962, 30157, 31476, 31624, 31888, 32278, 29539
- `salaries`: 13662, 13890, 17162, 22325, 22448, 23462, 25330, 26848, 27503, 27577, 27626, 27769, 27914, 28193, 29539, 29970, 30158, 31889(no — that's assets), 32279
- `assets`: 31889
- `myfranchise`: 13325, 13475, 31890
- `players`: 16332, 28194, 28919, 29114, 29540
- `salaryAdjustments` (export): 22132, 25980, 29751, 29832, 29870
- `transactions`: 25322, 25987, 28912, 29251
- `calendar`: 12398
- `draftResults`: 29209
- `salaryAdj` / `salaries` / `tradeProposal` / `tradeResponse` (imports via `postMflImportForm*`): 18652–18664, 22084, 22196, 22399, 22506, 22549, 24679, 25019, 25858, 29863, 30071, 30088, 30142, 31580, 31590

(Line numbers are from this branch's `worker/src/index.js`; will drift across commits.)
