# League Record S1: proposed read-only MFL export requests (for approval; decision 4 of 2026-11-21)

**Status: PROPOSED. NOTHING HAS BEEN SENT.** No MFL call, no external request, no Cloudflare or D1 access was made to write this document. Each request below is an exact URL template for the commissioner to approve, change or refuse. Approval of "the exact requests" means these templates, in this order, with this handling. Anything else needs a new approval.

## 0. Common rules (apply to every request)

| Topic | Rule |
|---|---|
| **Method** | `GET` only, every request. Every URL uses the `export` path; **no `import` URL appears here, and none may be added**. No request body, no `DATA` parameter, no cookie-setting call, no login call. `curl` runs without `-X POST`, `-d`, `--data*`, `-F` or `-T`. |
| **Host** | `https://www48.myfantasyleague.com` (the host this repository already uses for league 74598). If MFL redirects to another shard, the redirect is followed once and noted; no other host. |
| **League** | `L=74598` (UPS), the same league id in both seasons. |
| **Season** | The season is the first path segment: `/2025/export` is the 2025 league instance, `/2026/export` the 2026 instance, `/2014/export` the 2014 instance (section 3). |
| **Format** | `JSON=1`. |
| **Never used** | `COUNT` and `DAYS` (MFL documents `COUNT` as returning only the most common types; both truncate), `TYPE=league` (with a commissioner credential it returns owner names and e-mail addresses), and any import. |
| **Rate** | One request at a time, at least one second apart (`docs/MFL_API.md` canon); on `429` or `5xx`, exponential backoff of 2, 4, 8 seconds and stop after three tries. At most **10** requests in total across all sets. |
| **Client name** | A generic stable `User-Agent: ups-league-record-readonly/1`. No person's name, e-mail or project detail in any header or URL. |
| **Production** | None. The calls run from a local shell, not through the Worker, not through the ETL, not through any Cloudflare route. No production D1 read or write, no R2, no KV. |
| **Output location** | Raw responses are saved **outside the repository** (a local scratch folder), never committed, never pasted into a pull request or comment. |

### Authentication

The league is private (MFL documents these exports as "private league access restricted to league owners"), so each call needs a credential.

- **Preferred:** an **owner-level** API key for the commissioner's own franchise, passed as `&APIKEY=<key>`. An owner key never returns commissioner-only data.
- **Not used:** the commissioner **cookie**. With it, `transactions` returns *all* pending transactions for every franchise and some exports return private owner information.
- **The credential is supplied by the commissioner, at run time, through an environment variable (`MFL_APIKEY`).** I do not read, print, log or store it; the key is never written into a file, command history I produce or a document. URLs are logged **with the key replaced by `REDACTED`**.
- **Two ways to run, commissioner's choice:** (a) the commissioner runs the printed command block in their own terminal and hands back the output files, or (b) after approval, I run the exact block with the variable the commissioner has set. In both cases the block is the one printed in section 4.

### What is kept, what is dropped

1. The raw response is saved to a local file; its **SHA-256, byte count, HTTP status, redirect target (if any) and UTC capture time** are recorded.
2. A **sanitizer** keeps only: `timestamp`, `type`, `franchise`, `franchise2`, the asset lists (`franchise1_gave_up`, `franchise2_gave_up`), `expires`, and for picks the year, round and original franchise. It **drops free-text `comments`** (they can carry personal remarks) and counts what it dropped without recording the content.
3. **Pending items:** a record that is not an executed trade (no `timestamp`, or marked pending) is dropped and counted; its content is not kept. Whether a pending offer can appear in a `TRANS_TYPE=TRADE` response for an owner key is **not verified**; the sanitizer assumes it can.
4. Only the sanitized extract and a **request record** (the URL with `APIKEY=REDACTED`, parameters, capture time, hash) may enter the repository, in a later pull request that the commissioner reviews. The raw file never does.

## 1. The question these requests answer

The archive covers trades up to **2025-11-27** and other transactions up to **2025-12-29**; the committed 2026 snapshot starts **2026-03-07**. Nothing observes a trade in **2025-11-28 to 2026-03-07** (100 days). The archive is a copy of the 2025 instance and the snapshots are the 2026 instance, so a trade in those months would sit in whichever instance MFL was running. The requests ask both instances for every executed trade and for the end-state holder of every future pick.

## 2. Request set A: the 2025-11-28 to 2026-03-07 gap (4 requests)

| # | Instance | Request (exact) | Expected data | Why |
|---|---|---|---|---|
| **A1** | 2025 | `GET https://www48.myfantasyleague.com/2025/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1&APIKEY=<MFL_APIKEY>` | Every executed trade of the 2025 season: for each, `timestamp`, `type`, the two franchises and the two give-up lists with player ids, `FP_<franchise>_<year>_<round>` future-pick tokens, `DP_<round-1>_<slot-1>` slot tokens and `BB_` cap tokens (zero-indexed, as in the archive). Approximately 74 trades (the archive holds 74 for 2025). | Compare with the archive record for record (check E1); any trade dated 2025-11-28 or later is a finding. |
| **A2** | 2026 | `GET https://www48.myfantasyleague.com/2026/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1&APIKEY=<MFL_APIKEY>` | Every executed trade of the 2026 instance from its start. The snapshot's first 2026 transaction is 2026-03-07 and its first trade 2026-03-27. | Anything dated before 2026-03-07 would sit in the gap; compare the rest with the committed snapshots. |
| **A3** | 2025 | `GET https://www48.myfantasyleague.com/2025/export?TYPE=futureDraftPicks&L=74598&JSON=1&APIKEY=<MFL_APIKEY>` | For each franchise, its future picks: `year`, `round`, `originalPickFor` (this repository's code reads that field), as the instance last held them. | An end-state observation near the start of the gap (check E3). The time the 2025 instance was last written is not known; the capture records what it shows, not when. |
| **A4** | 2026 | `GET https://www48.myfantasyleague.com/2026/export?TYPE=futureDraftPicks&L=74598&JSON=1&APIKEY=<MFL_APIKEY>` | The same for the 2026 instance on the capture date. | An end-state observation after the gap: the holder of each 2027-and-later pick on the capture date, to compare with the chains. |

**Optional cross-check (2 more requests, separate yes/no):**

| # | Request (exact) | Expected data | Why |
|---|---|---|---|
| **B1** | `GET https://www48.myfantasyleague.com/2025/export?TYPE=salaryAdjustments&L=74598&JSON=1&APIKEY=<MFL_APIKEY>` | The 2025 instance's salary-adjustment entries (cap entries with dates and trade references where present). | A cap transfer tied to a trade inside the gap would show here even if the trade record were missing. Only trades that moved cap money; the entries are also written by commissioner tools. |
| **B2** | `GET https://www48.myfantasyleague.com/2026/export?TYPE=salaryAdjustments&L=74598&JSON=1&APIKEY=<MFL_APIKEY>` | The same for the 2026 instance. | The same, for the other side of the boundary. |

**What the answers can and cannot show.** MFL returns what it still holds. A response with no trade in the gap supports "this export, captured on this date, shows none", never "none occurred". A response that shows a trade is a new record to add to the ledger in a separate pull request, after which the chains crossing it are re-evaluated. Neither result resolves a future pick by itself (`S1_COVERAGE_GAP_SOURCES.md`, last section).

**Decision rules, set before any call:**

1. A1/A2 agree with the archive and snapshots in the covered range and show **no trade in the gap**, and A3/A4 agree with the chains: record a verification candidate for the gap under `S1_SOURCE_COVERAGE_MODEL.md` (it becomes VERIFIED_COMPLETE only if every check passes). The 597 stay unresolved.
2. A1 or A2 shows **a trade in the gap**: add it to the ledger in a separate change; the gap stays a KNOWN_GAP until the chains and end states agree.
3. **Any difference** from the archive inside the covered range (a record present on one side only, or different assets): reported as a finding with both versions; nothing is verified or repaired.

## 3. Request set N: the 2014 pick 4.12 selector conflict (2 requests, optional third)

The conflict is described in `S1_CONFLICT_2014_4_12.md`. It is **a different record from the 2018 forfeiture and is not decided by it.** The archive cannot settle it: its weekly rosters cover 2010, 2011 and 2017 onward only, and the drafted player has no add or drop record. Narrow requests to the 2014 instance:

| # | Request (exact) | Expected data | Why |
|---|---|---|---|
| **N1** | `GET https://www48.myfantasyleague.com/2014/export?TYPE=draftResults&L=74598&JSON=1&APIKEY=<MFL_APIKEY>` | The 2014 draft's picks: `round`, `pick`, `franchise`, `player`, `timestamp`, `comments`. 60 picks. | Which franchise MFL itself records for pick 4.12 (round 4, pick 12); whether the two 2014 rows the archive has without a franchise id carry one; MFL's note on 4.12. Compare with the archive's draft row (franchise 0006). |
| **N2** | `GET https://www48.myfantasyleague.com/2014/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1&APIKEY=<MFL_APIKEY>` | All 2014 executed trades. The archive holds 86. | Whether `trade2014_4` (2014-05-06, which moved the `DP_3_11` token from 0008 to 0004) is recorded identically, and whether any record moves that token afterward, which would explain the draft row. |
| **N3 (optional)** | `GET https://www48.myfantasyleague.com/2014/export?TYPE=transactions&L=74598&TRANS_TYPE=*&JSON=1&APIKEY=<MFL_APIKEY>` | All 2014 transactions of every type (about 2,000 records, in the archive 1,983). | Whether an add or drop by franchise 0004 or 0006 around 2014-06-15 shows who rostered the drafted player. Larger and broader; ask for it only if N1 and N2 do not settle the record. |

Decision rules: if N1 records franchise 0004 for pick 4.12, the archive's draft row is wrong and the conflict disappears as a data error; if N1 records 0006 and N2 shows a later transfer of the token to 0006, the chain was incomplete; if both agree with the archive, the conflict stays open and is reported again with these sources named. None of this uses the 2018 ruling.

## 4. The exact command block (for approval, not run)

```bash
# Set once in the commissioner's own shell. Never echoed, never written to a file.
#   export MFL_APIKEY='...'
OUT="$HOME/ups_league_record_exports/2026-11"          # outside the repository
mkdir -p "$OUT"
UA='ups-league-record-readonly/1'
BASE='https://www48.myfantasyleague.com'
get() {  # GET only: name, then the path-and-query without the key
  curl --silent --show-error --fail --max-time 60 --location --max-redirs 1 \
       --header "User-Agent: $UA" \
       --output "$OUT/$1.json" --write-out "$1 %{http_code} %{size_download} bytes %{num_redirects} redirect(s)\n" \
       "$BASE$2&APIKEY=$MFL_APIKEY"
  sleep 1
}
get A1_transactions_2025_trade   '/2025/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1'
get A2_transactions_2026_trade   '/2026/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1'
get A3_futurepicks_2025          '/2025/export?TYPE=futureDraftPicks&L=74598&JSON=1'
get A4_futurepicks_2026          '/2026/export?TYPE=futureDraftPicks&L=74598&JSON=1'
# optional B and N sets, only if approved:
# get B1_saladj_2025             '/2025/export?TYPE=salaryAdjustments&L=74598&JSON=1'
# get B2_saladj_2026             '/2026/export?TYPE=salaryAdjustments&L=74598&JSON=1'
# get N1_draftresults_2014       '/2014/export?TYPE=draftResults&L=74598&JSON=1'
# get N2_transactions_2014_trade '/2014/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1'
# get N3_transactions_2014_all   '/2014/export?TYPE=transactions&L=74598&TRANS_TYPE=*&JSON=1'
shasum -a 256 "$OUT"/*.json                                # hash of every raw response, recorded with the capture time
```

`curl` is used in its default `GET` mode; the block contains no `-X`, `-d`, `--data`, `-F` or `-T`. The key is appended inside `get` and is not part of any printed text: the transfer line shows the name, status, size and redirect count only (the redirect URL is deliberately not printed, because a redirect can carry the query string).

**Strictly read-only confirmation:** every URL is an `export` request; the block calls no import, login, pending-trade, offer or settings endpoint; it writes only the files in `$OUT` on the local machine; it touches no Cloudflare resource and no production database.

## 5. Not requested here (a separate, optional, later approval)

To verify the quiet windows that matter for the future-pick links (`S1_FUTURE_PICK_ASSESSMENT.md`), one `TRANS_TYPE=TRADE` export per instance year, 2013 to 2025 (13 requests), compared with the archive, would allow verification records for the 30 windows listed in `summary.future_picks.event_accounting_windows_needed`. This is **not** part of this request set and would need its own approval and its own total-request count.

## 6. Unverified details (stated, not assumed)

- Whether **MFL still serves old instances** (2014) for this league through these exports, and whether the 2025 instance accepts `futureDraftPicks` after the rollover: unknown until a call is made; a refusal is recorded as a result.
- Whether an **owner key** may read the 2014 and 2026 instances: unknown; if not, the call stops and the commissioner is asked, never retried with a different credential.
- The exact **field set** of `futureDraftPicks` beyond `year`, `round` and `originalPickFor`: only what this repository's code reads is relied on.
- Whether a pending trade offer can appear in a `TRANS_TYPE=TRADE` response (section 0, "pending items").
