# League Record S1: proposed read-only MFL export requests (for approval; decision 4 of 2026-11-21)

**Status (2026-11-21): A1 to A4 APPROVED by the commissioner, limited to these exact GET/export requests and their documented purpose, to be run by the commissioner locally with the commissioner's own credentials; Claude does not run them or fetch a credential. B1, B2 and N1 to N3 are NOT approved (N1 to N3 is the recorded next research action for the 2014 4.12 conflict, to be authorized separately). The runnable package and its review steps are in `S1_EXPORT_LOCAL_RUNBOOK.md`. NOTHING HAS BEEN SENT.** (Earlier status: proposed, revised after the architecture review.) No MFL call, no external request, no Cloudflare or D1 access was made to write this document. Each request below is an exact URL template for the commissioner to approve, change or refuse. Approval of "the exact requests" means these templates, in this order, with this handling. Anything else needs a new approval.

## 0. Common rules (apply to every request)

| Topic | Rule |
|---|---|
| **Method** | `GET` only, every request. Every URL uses the `export` path; **no `import` URL appears here, and none may be added**. No request body, no `DATA` parameter, no cookie-setting call, no login call. `curl` runs without `-X POST`, `-d`, `--data*`, `-F` or `-T`. |
| **Host and league** | **They differ by year.** The archive's `league_years` table gives: 2010 `www45` / 60671, 2011 `www46` / 40832, 2012 `www45` / 37227, 2013 `www46` / 42721, **2014 `www45` / 30590**, 2015 `www44` / 29015, 2016 `www48` / 27191, and **`www48` / 74598 for 2017 through 2026**. Requests for 2025 and 2026 use `https://www48.myfantasyleague.com` and `L=74598`; requests for 2014 use `https://www45.myfantasyleague.com` and `L=30590`. A call with the wrong pair could fail or return another league's data, so each request below names its own pair. **Redirects are not followed** (see the command block). |
| **Season** | The season is the first path segment: `/2025/export` is the 2025 league instance, `/2026/export` the 2026 instance, `/2014/export` the 2014 instance (section 3). |
| **Format** | `JSON=1`. |
| **Never used** | `COUNT` and `DAYS` (MFL documents `COUNT` as returning only the most common types; both truncate), `TYPE=league` (with a commissioner credential it returns owner names and e-mail addresses), and any import. |
| **Rate** | One request at a time, at least one second apart (`docs/MFL_API.md` canon); on `429` or `5xx`, exponential backoff of 2, 4, 8 seconds and stop after three tries. At most **10** requests in total across all sets. |
| **Client name** | A generic stable `User-Agent: ups-league-record-readonly/1`. No person's name, e-mail or project detail in any header or URL. |
| **Production** | None. The calls run from a local shell, not through the Worker, not through the ETL, not through any Cloudflare route. No production D1 read or write, no R2, no KV. |
| **Output location** | Raw responses are saved **outside the repository** (a local scratch folder), never committed, never pasted into a pull request or comment. |

### Authentication

The league is private (MFL documents these exports as "private league access restricted to league owners"), so each call needs a credential.

- **Preferred:** an **owner-level** API key, passed as `&APIKEY=<key>`. Whether a key issued to the commissioner's own user carries commissioner rights is **not verified**; if it does, `transactions` returns **all** pending transactions for every franchise (MFL documents this), so a key for a non-commissioner franchise is better if one exists. That is a question for the commissioner, not an assumption.
- **API keys are believed to be issued per user, league and year (not verified).** One key may therefore not serve the 2014 league (`L=30590`) and the 2025 and 2026 league (`L=74598`). Each league-year may need its own key; if a call is refused for authorization it stops and the commissioner is asked. It is never retried with a different credential.
- **Not used:** the commissioner **cookie**, and `TYPE=league` (with a commissioner credential it returns owner names and e-mail addresses).
- **The credential is supplied by the commissioner at run time** and is read without echo (`read -s`, below), kept only in a shell variable, and passed to `curl` through its standard input so it is **not visible in the process list**. I do not read, print, log or store it. No command line, file or document contains it.
- **Who runs it (commissioner's ruling, 2026-11-21): the commissioner only, locally.** Claude does not run the requests, does not retrieve a credential from the repository, an account or the environment, and has not seen any response. The runnable, tested package is `scripts/league_record/s1/export_package/` (see `S1_EXPORT_LOCAL_RUNBOOK.md`); the script is the single source of the command.

### What is kept, what is dropped

1. The raw response is saved to a local file; its **SHA-256, byte count, HTTP status, redirect target (if any) and UTC capture time** are recorded.
2. A **sanitizer** keeps only: `timestamp`, `type`, `franchise`, `franchise2`, the asset lists (`franchise1_gave_up`, `franchise2_gave_up`), `expires`, and for picks the year, round and original franchise. It **drops free-text `comments`** (they can carry personal remarks) and counts what it dropped without recording the content.
3. **Pending items:** a record that is not an executed trade (no `timestamp`, or marked pending) is dropped and counted; its content is not kept. MFL's own documentation says an owner request returns that owner's pending transactions (and a commissioner request returns everyone's), so a pending offer **will** appear unless the response says otherwise; the sanitizer drops every one of them.
4. Only the sanitized extract and a **request record** (the URL with `APIKEY=REDACTED`, parameters, capture time, hash) may enter the repository, in a later pull request that the commissioner reviews. The raw file never does.

## 1. The question these requests answer

The archive covers trades up to **2025-11-27** and other transactions up to **2025-12-29**; the committed 2026 snapshot starts **2026-03-07**. Nothing observes a trade in **2025-11-28 to 2026-03-07** (100 days). The archive is a copy of the 2025 instance and the snapshots are the 2026 instance, so a trade in those months would sit in whichever instance MFL was running. The requests ask both instances for every executed trade and for the end-state holder of every future pick.

## 2. Request set A: the 2025-11-28 to 2026-03-07 gap (4 requests)

| # | Instance | Request (exact) | Expected data | Why |
|---|---|---|---|---|
| **A1** | 2025 | `GET https://www48.myfantasyleague.com/2025/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1&APIKEY=<MFL_KEY_2025>` | Every executed trade of the 2025 season: for each, `timestamp`, `type`, the two franchises and the two give-up lists with player ids, `FP_<franchise>_<year>_<round>` future-pick tokens, `DP_<round-1>_<slot-1>` slot tokens and `BB_` cap tokens (zero-indexed, as in the archive). Approximately 74 trades (the archive holds 74 for 2025). | Compare with the archive record for record (check E1); any trade dated 2025-11-28 or later is a finding. |
| **A2** | 2026 | `GET https://www48.myfantasyleague.com/2026/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1&APIKEY=<MFL_KEY_2026>` | Every executed trade of the 2026 instance from its start. The snapshot's first 2026 transaction is 2026-03-07 and its first trade 2026-03-27. | Anything dated before 2026-03-07 would sit in the gap; compare the rest with the committed snapshots. |
| **A3** | 2025 | `GET https://www48.myfantasyleague.com/2025/export?TYPE=futureDraftPicks&L=74598&JSON=1&APIKEY=<MFL_KEY_2025>` | For each franchise, its future picks: `year`, `round`, `originalPickFor` (this repository's code reads that field), as the instance last held them. | An end-state observation of **unknown date**: the 2025 instance may have been frozen at the rollover or written later, and the response does not say. It brackets the start of the gap but is **not a dated end state** and cannot serve as check E3 by itself. |
| **A4** | 2026 | `GET https://www48.myfantasyleague.com/2026/export?TYPE=futureDraftPicks&L=74598&JSON=1&APIKEY=<MFL_KEY_2026>` | The same for the 2026 instance on the capture date. | An end-state observation after the gap: the holder of each 2027-and-later pick on the capture date, to compare with the chains. |

**Optional cross-check (2 more requests, separate yes/no):**

| # | Request (exact) | Expected data | Why |
|---|---|---|---|
| **B1** | `GET https://www48.myfantasyleague.com/2025/export?TYPE=salaryAdjustments&L=74598&JSON=1&APIKEY=<MFL_KEY_2025>` | The 2025 instance's salary-adjustment entries (cap entries with dates and trade references where present). | A cap transfer tied to a trade inside the gap would show here even if the trade record were missing. Only trades that moved cap money; the entries are also written by commissioner tools. |
| **B2** | `GET https://www48.myfantasyleague.com/2026/export?TYPE=salaryAdjustments&L=74598&JSON=1&APIKEY=<MFL_KEY_2026>` | The same for the 2026 instance. | The same, for the other side of the boundary. |

**What the answers can and cannot show.** MFL returns what it still holds. A response with no trade in the gap supports "this export, captured on this date, shows none", never "none occurred". A response that shows a trade is a new record to add to the ledger in a separate pull request, after which the chains crossing it are re-evaluated. Neither result resolves a future pick by itself (`S1_COVERAGE_GAP_SOURCES.md`, last section).

**Decision rules, set before any call:**

1. A1/A2 agree with the archive and snapshots in the covered range and show **no trade in the gap**, and A4 (the only end state with a known date: its capture date) agrees with the chains, and A3 is consistent with them: record **one verification candidate per instance** (2025 for 2025-11-28 to 2025-12-31 and 2026 for 2026-01-01 to 2026-03-07) under `S1_SOURCE_COVERAGE_MODEL.md`. A candidate becomes VERIFIED_COMPLETE only if every required check passes; an end state dated after the interval's end covers days before it only as far as the chains connect them, and where it cannot be shown the days stay unverified. The 597 stay unresolved.
2. A1 or A2 shows **a trade in the gap**: add it to the ledger in a separate change; the gap stays a KNOWN_GAP until the chains and end states agree.
3. **Any difference** from the archive inside the covered range (a record present on one side only, or different assets): reported as a finding with both versions; nothing is verified or repaired.

## 3. Request set N: the 2014 pick 4.12 selector conflict (2 requests, optional third)

The conflict is described in `S1_CONFLICT_2014_4_12.md`. It is **a different record from the 2018 forfeiture and is not decided by it.** The archive cannot settle it: its weekly rosters cover 2010, 2011 and 2017 onward only, and the drafted player has no add or drop record. Narrow requests to the 2014 instance (**host `www45`, league `30590`**, from the archive's `league_years`; whether the key works for that league-year is not verified):

| # | Request (exact) | Expected data | Why |
|---|---|---|---|
| **N1** | `GET https://www45.myfantasyleague.com/2014/export?TYPE=draftResults&L=30590&JSON=1&APIKEY=<MFL_KEY_2014>` | The 2014 draft's picks: `round`, `pick`, `franchise`, `player`, `timestamp`, `comments`. 60 picks. | Which franchise MFL itself records for pick 4.12 (round 4, pick 12); whether the two 2014 rows the archive has without a franchise id carry one; MFL's note on 4.12. Compare with the archive's draft row (franchise 0006). |
| **N2** | `GET https://www45.myfantasyleague.com/2014/export?TYPE=transactions&L=30590&TRANS_TYPE=TRADE&JSON=1&APIKEY=<MFL_KEY_2014>` | All 2014 executed trades. The archive holds 86. | Whether `trade2014_4` (2014-05-06, which moved the `DP_3_11` token from 0008 to 0004) is recorded identically, and whether any record moves that token afterward, which would explain the draft row. |
| **N3 (optional)** | `GET https://www45.myfantasyleague.com/2014/export?TYPE=transactions&L=30590&TRANS_TYPE=*&JSON=1&APIKEY=<MFL_KEY_2014>` | All 2014 transactions of every type (about 2,000 records, in the archive 1,983). | Whether an add or drop by franchise 0004 or 0006 around 2014-06-15 shows who rostered the drafted player. Larger and broader; ask for it only if N1 and N2 do not settle the record. |

Decision rules: if N1 records franchise 0004 for pick 4.12, the archive's draft row is wrong and the conflict disappears as a data error; if N1 records 0006 and N2 shows a later transfer of the token to 0006, the chain was incomplete; if both agree with the archive, the conflict stays open and is reported again with these sources named. None of this uses the 2018 ruling.

## 4. The command (the script is the single source)

The command is **`scripts/league_record/s1/export_package/run_a1_a4.sh`**, reviewed with `--print` (no key read, no network). It sends exactly the four requests of section 2 and nothing else, and the tests fail if it, the sanitizer or this document ever differ. Its properties (each tested with a stub `curl`):

- plain GET only, redirects refused, any status other than 200 or any MFL error body stops the run, and nothing is sent after a failure;
- the key is typed at a prompt (`read -s`) for each instance (2025, 2026), kept only in an unexported shell variable (an inherited variable of the same name is unset first), URL-encoded, and passed to `curl` on its standard input: never in a file, a history line, a printed line, a process argument or a child's environment;
- raw responses go to a private folder outside any git work tree (mode 700, files 600);
- the sanitizer then writes the only shareable output (`sanitized/` and `manifest.json`).

**Strictly read-only confirmation:** every URL is an `export` request; the script calls no import, login, pending-trade, offer or settings endpoint; it writes only files in the private folder on the commissioner's machine; it touches no Cloudflare resource and no production database. The optional sets B and N are **not** in the script (they are not approved).

## 5. Not requested here

**Past quiet windows (2013-2025).** An earlier draft proposed one trade-only export per year to verify the quiet windows. It is **withdrawn**: an export of an old year compared with the archive (check E1) only detects loss in the copy, because the archive is a copy of MFL's own transaction log, and an end-state export for a past date does not exist (an export shows the state on the capture date). Under `S1_SOURCE_COVERAGE_MODEL.md` these windows therefore cannot be verified by an export. If the commissioner still wants an E1-only comparison for a particular year (to look for loss in the copy), it is a separate request with its own league id and host from the table in section 0, and its own approval.

## 6. Unverified details (stated, not assumed)

- Whether **MFL still serves old instances** (2014) for this league through these exports, and whether the 2025 instance accepts `futureDraftPicks` after the rollover: unknown until a call is made; a refusal is recorded as a result.
- Whether **one key serves several league-years** (believed not) and whether the commissioner's user key carries commissioner rights (section 0).
- The exact **field set** of `futureDraftPicks` beyond `year`, `round` and `originalPickFor`: only what this repository's code reads is relied on.
- **Pending trade offers will appear** in a `TRANS_TYPE=TRADE` response according to MFL's documentation; they are dropped and counted by the sanitizer, never kept.
- **MFL can return an error with HTTP 200**; the block checks the first bytes of each body.
- **What the answers cannot show:** a response with no trade in the gap supports "this export, on this date, shows none"; it cannot show a pick-ownership change MFL never logged as a trade (a commissioner edit). The two future-picks end states (A3, A4) are the only check against that, and only as to the holder on the capture date (A4's is known; A3's is not).
