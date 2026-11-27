# League Record S1: sources that could close the 2025-11-28 to 2026-03-07 trade-coverage gap

**Status:** a list of candidate sources, not an extraction. Nothing here was queried; no production system, no MFL call and no external service was used. The commissioner cannot confirm that no trade happened in the interval, so it stays a **source-coverage gap** in every report until an authoritative source covers it. Closing it does **not** resolve the three 2026 picks automatically: each pick must still meet its own identity and slot-evidence conditions (see the last section).

## What is known from the committed sources

| Fact | Where |
|---|---|
| Last TRADE in the archive: 2025-11-27 (the deadline); last transaction of any type: 2025-12-29 | `transactions_trades`, `transactions_base` |
| First transaction in the committed 2026 snapshot: 2026-03-07 19:13:45 Eastern; first 2026 snapshot TRADE: 2026-03-27 | `data/mfl-snapshots/<day>/transactions.json` |
| Daily snapshots start 2026-04-21; the transaction list inside them is the 2026 league's own list | `data/mfl-snapshots/` |
| No archive or snapshot record lies between 2025-12-29 (any type) / 2025-11-27 (trades) and 2026-03-07 | extraction, section "gaps" |

The likely reason is structural: the archive is a copy of the **2025 league instance** and the snapshots are the **2026 league instance**; the 2026 instance starts at the rollover. A trade made in the quiet months would sit in whichever instance MFL was running then. That is a hypothesis about where a record would live, not a finding that one exists.

## Candidate sources, in the order of authority

| # | Source | Authority | Where it lives | What it would show | What it needs | Limits |
|---|---|---|---|---|---|---|
| 1 | **MFL transactions export for the 2025 league instance** (the `TYPE=transactions` export, requested for the whole 2025 season with a trade filter, and again for the 2026 instance from its start) | Authoritative (MFL's own log) | MFL (external call) | Every trade with its date, both franchises and every asset token, including `FP_`/`DP_` pick tokens and cap tokens | **Commissioner approval for one read-only external call**, run by an approved route | It returns what MFL still holds; if MFL purges or never wrote a record for the rollover months, it cannot show it |
| 2 | **MFL future-draft-picks export** (`TYPE=futureDraftPicks`) on a date after the gap | Authoritative for the holder **on that date only** | MFL (external call) | Which franchise holds each future pick on the call date | Same approval | A snapshot of the end state, not a history: it cannot say when or how a pick moved |
| 3 | **MFL salary-adjustments export** (cap entries carry dates and trade references) | Authoritative for cap transfers | MFL (external call) | A cap transfer tied to a trade inside the gap would show as an entry even if the trade record were missing | Same approval | Only trades with cap money; the entries are written by the commissioner's tools as well as MFL |
| 4 | **The production D1 mirror and its raw transaction log** | Derived from MFL (an ETL copy) | Cloudflare D1 | Whether the ETL ever stored a trade in the interval | **Separate production-read approval** and a metered, measured query | Copy, not source; it drops pick identity; adds nothing the MFL export would not show |
| 5 | **Daily roster and contract snapshots in R2** (player ownership by day) | Derived from MFL | Cloudflare R2 | A player who changed franchise between two daily snapshots without a recorded add or drop is evidence of a missing trade | **Separate production-read approval** | Detects player moves only, never pick moves; evidence of a gap's content, not a record of it |
| 6 | **The league Discord export already in the repository** (`data/discord-archives/`, taken 2026-08-05) | Secondary (a bot or person posted about a trade) | Local file | A trade announcement dated inside the interval would be a pointer to a missing record | Local read-only search, **no external call**; its text is private chat and must not be copied into any public file or comment | Not authoritative; a missing post proves nothing |
| 7 | **MFL e-mail notifications for trades** | Secondary | The commissioner's mailbox (not on this machine) | Dated trade notices | The commissioner supplies them | Not available locally |
| 8 | **The 2025 and 2026 rulebooks and forum threads in the history archive** | Context only | Local files | Whether trading is allowed in the interval (a closed window is a rule, not evidence of an empty window) | None | Cannot show a trade |

## Recommended order (for the commissioner's decision)

1. **Source 1, one read-only call, approved explicitly.** It is the only source that can both show a trade and name every asset. Ask for both league instances in one request set so the boundary is covered from both sides.
2. **Source 6 as a local, no-call cross-check** if the commissioner wants it before any call (counts and dates only; no message text leaves the file).
3. Sources 4 and 5 only if source 1 returns nothing for the interval **and** a decision is needed that the absence alone does not settle; both are production reads and need their own approval and a measured query.
4. Source 2 as an end-state check after a trade list is in hand: it can confirm or contradict the holder the chains give for each 2026 pick on the call date.

Until one of them is approved and run, every chain that crosses the interval carries the gap flag (the pilot report and the extraction already do), and no pick whose custody crosses it is resolved.

## Closing the gap does not close the picks

Even with a complete trade list for the interval, each of the three 2026 picks still needs:

- **Identity:** a future-pick token names the original franchise, year and round; it never names a slot. Its identity is therefore `(original franchise, year, round)` until MFL's draft data say otherwise.
- **Custody:** every transfer from its last recorded holder to the evidence date accounted for, with no unobserved period left. A gap that is closed by a source still has to be closed *for that pick's chain*.
- **A demonstrably complete inventory** of the round on the evidence date (the approved condition for `UNIQUE_HOLDER_V1`), which today fails for every 2026 round because a slot-token transfer exists in the round and the records and the pre-draft list disagree on who holds picks. A trade list for the interval does not change a slot-token transfer in May.
- **Slot evidence:** a slot named by an MFL token or an MFL draft result. MFL's "Pick traded from..." notes remain corroboration only (commissioner's ruling, 2026-11-20): they name a prior holder, not an original franchise, and are never an inference rule.

So the three picks may stay UNRESOLVED even after the gap closes. The report will say which condition still fails for each.
