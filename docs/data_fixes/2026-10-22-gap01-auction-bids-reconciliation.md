# GAP-01 dry run: individual auction bids, 2014-2025

Dry run generated 2026-10-22T17:58:22Z by `pipelines/etl/scripts/dryrun_gap01_auction_bids.py`. **Nothing was written to D1 or MFL.** The only production read was one budgeted SELECT of `ups_auction_history` plus a table-name check. No comment text appears in this report.

## Plain English

- MFL still holds every auction bid from 2014 to 2025: **8,065 rows** (nominations and bids) across **2,404 auctions**. 2,369 were won. 35 never produced a winner: they were cancelled, or the player was put up again later.
- A load would add them to D1 in two new tables and change nothing that exists. Owners would see nothing new until a story or page reads them.
- Every count reconciles. Each season's rows equal MFL's own count and the June 2026 archive row for row. From 2017 on, every won auction's last bid is exactly MFL's winner and price (1,790 of 1,790). For 2014-2016, replaying MFL's bidding rules over the logged bids gives the same winner and price in 578 of 579.
- Each season's gap against today's `ups_auction_history.total_bids` is fully explained: cancelled bidding, two 2016 auctions where D1 counted a cancelled first bid, and the second auctions D1 lost (GAP-02).
- **Limits.** 2014-2016 logged every bid placed at the amount the owner entered (their maximum), so the price usually sits below the top logged bid. The 2016 start times have no independent check, because MFL's report prints no 2016 start. 2011-2013 have no bids anywhere at MFL.

## Checks at a glance

| Check | Result |
|---|---|
| Rows per season = MFL AUCTION_INIT + AUCTION_BID | PASS |
| Rows = June archive, bid by bid (season, player, second, franchise, amount, type) | PASS |
| Auctions won per season = MFL AUCTION_WON (blank MFL rows excluded) | PASS |
| 2017-2025: last bid = winner and price (1790/1790) | PASS |
| 2014-2016: replaying MFL's proxy rules gives winner and price (578/579; the one exception is a bid MFL logged but did not honor) | PASS |
| Bid-count difference vs ups_auction_history explained every season | PASS |
| Spot checks: Henry 2023, Gore 2016, Snead 2017, Foster 2014 | PASS |
| Local SQLite proof: load, re-run writes 0, rollback clean | PASS |
| Local D1 (Miniflare): billed writes measured, re-run writes 0 | PASS |

## 1. Counts by season

MFL = `TYPE=transactions&TRANS_TYPE=AUCTION_INIT|AUCTION_BID|AUCTION_WON`, one call per type. June = `transactions_auction` in `data/db-archives/mfl_database_2026-06-05.db.gz`. Audit = the 10-22 manifest's GAP-01 row count.

| Season | MFL INIT | MFL BID | Built rows | June | Audit | MFL won | Auctions | Won | No win | O=102 rows | D1 history rows | D1 sum total_bids |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2014 | 0 | 1060 | 1060 | 1060 | 1060 | 213 | 219 | 213 | 6 | 213 | 213 | 1050 |
| 2015 | 0 | 822 | 822 | 822 | 822 | 183 | 191 | 183 | 8 | 183 | 183 | 811 |
| 2016 | 0 | 850 | 850 | 850 | 850 | 183 | 186 | 183 | 3 | 183 | 183 | 849 |
| 2017 | 0 | 738 | 738 | 738 | 738 | 193 | 194 | 193 | 1 | 193 | 193 | 737 |
| 2018 | 0 | 812 | 812 | 812 | 812 | 240 | 240 | 240 | 0 | 240 | 240 | 812 |
| 2019 | 223 | 514 | 737 | 737 | 737 | 223 | 224 | 223 | 1 | 222 | 222 | 734 |
| 2020 | 175 | 253 | 428 | 428 | 428 | 175 | 175 | 175 | 0 | 175 | 175 | 428 |
| 2021 | 192 | 287 | 479 | 479 | 479 | 189 | 192 | 189 | 3 | 189 | 189 | 476 |
| 2022 | 206 | 433 | 639 | 639 | 639 | 204 | 206 | 204 | 2 | 204 | 204 | 635 |
| 2023 | 186 | 279 | 465 | 465 | 465 | 183 | 186 | 183 | 3 | 182 | 182 | 460 |
| 2024 | 205 | 358 | 563 | 563 | 563 | 199 | 205 | 199 | 6 | 195 | 195 | 541 |
| 2025 | 186 | 286 | 472 | 472 | 472 | 184 | 186 | 184 | 2 | 184 | 184 | 470 |
| **Total** | 1373 | 6692 | **8,065** | 8065 | 8065 | 2369 | 2404 | 2369 | 35 | 2363 | 2363 | 8003 |

**2011-2013 (GAP-12): no bid log exists.** MFL returns 0 AUCTION_INIT and 0 AUCTION_BID rows for 2011 (271 wins, 10 blank rows), 2012 (224 wins, 4 blank rows), 2013 (178 wins, 7 blank rows). Nothing to load; this is a missing source record, not a gap to fill.

**Blank MFL win rows.** MFL also returns AUCTION_WON rows with no player, no price and no franchise, all stamped Feb 20-25, 2017 (the league's move to L=74598): 2015: 1, 2016: 46, 2017: 5. They are excluded and counted, never loaded.

## 2. Bid by bid against the June archive

8,065 built rows compared with June on (season, player, second, franchise, amount, type): **0 only in the build, 0 only in June.** The June archive's parsed table and today's MFL replies are the same record.

## 3. How bids were grouped into auctions

MFL's log has no auction id. A player's events in a season are split into auctions in time order. Each auction is keyed by **season + player + its first logged event**:

- `nomination`: AUCTION_INIT (the nomination).
- `new_nomination`: a second AUCTION_INIT for the same player.
- `first_bid`: first BID with no auction open (2014-2018 have no INIT).
- `mfl_report_start`: bids before the start MFL's O=102 report gives.
- `idle_over_lock`: more than 25 hours without a bid or a win (an FA auction locks after 24).
- An AUCTION_WON closes the open auction. Bidding that never reached a win is kept as `outcome = no_win`.

**Why these rules, and the evidence:**
- 2019+ every auction opens with AUCTION_INIT, and every won auction's start equals MFL's O=102 start to the minute.
- 2014-2018 have no INIT. Grouping by wins alone matches O=102's start for every won auction in 2018, and for all but 4 in 2014, 6 in 2015 and 1 in 2017. In each of those 11 the extra leading bids are a cancelled first try: the same franchise re-entering its opening bid, or bids hours to days before MFL's start. The `mfl_report_start` rule moves them into their own `no_win` auction.
- 2016 prints no start in O=102 (every cell is the Unix epoch). The only rule used there is the idle rule: in every FA auction O=102 dates (2014-2025), consecutive logged bids are at most 24.0 hours apart, so a longer silence with no win means the earlier bidding was cancelled. A same-franchise repeat or lower bid is **not** used: 2014-2016 log repeats inside real auctions (Justin Forsett 2015: three $40,000 bids from 0004 in one second).
- **2016 residual risk.** In 2014-2015 (same log format) O=102 moved the start of 10 of 396 won auctions; 6 of those were short re-entries the idle rule cannot see. Expect roughly 3-4 of 2016's 183 auctions to start a few minutes or hours early and to include 1-3 bids from a cancelled first try. These rows carry `start_basis = first_logged_bid`.

| Season | How each auction opened (outcome:rule) | start_basis |
|---|---|---|
| 2014 | no_win:first_bid 6, won:first_bid 209, won:mfl_report_start 4 | first_logged_bid 6, mfl_report 213 |
| 2015 | no_win:first_bid 8, won:first_bid 177, won:mfl_report_start 6 | first_logged_bid 8, mfl_report 183 |
| 2016 | no_win:first_bid 3, won:first_bid 181, won:idle_over_lock 2 | first_logged_bid 186 |
| 2017 | no_win:first_bid 1, won:first_bid 192, won:mfl_report_start 1 | first_logged_bid 1, mfl_report 193 |
| 2018 | won:first_bid 240 | mfl_report 240 |
| 2019 | no_win:first_bid 1, won:new_nomination 1, won:nomination 222 | first_logged_bid 1, nomination 223 |
| 2020 | won:nomination 175 | nomination 175 |
| 2021 | no_win:nomination 3, won:new_nomination 2, won:nomination 187 | nomination 192 |
| 2022 | no_win:nomination 2, won:new_nomination 1, won:nomination 203 | nomination 206 |
| 2023 | no_win:nomination 3, won:nomination 183 | nomination 186 |
| 2024 | no_win:new_nomination 3, no_win:nomination 3, won:new_nomination 3, won:nomination 196 | nomination 205 |
| 2025 | no_win:nomination 2, won:new_nomination 1, won:nomination 183 | nomination 186 |

**Every auction that is not a single nomination-to-win run** (cancelled bidding, re-nominations, split-off early bids):

| Season | Player | Opened | Last bid | Opened by | Rows | Outcome | Rule | Won |
|---|---|---|---|---|---|---|---|---|
| 2014 | Tom Brady | 2014-08-02 08:50 ET | 2014-08-02 09:22 ET | 0006 | 2 | no_win | first_bid |  |
| 2014 | Tom Brady | 2014-08-02 22:41 ET | 2014-08-03 19:34 ET | 0012 | 10 | won | mfl_report_start | 0012 $22,000 2014-08-03 23:53 ET |
| 2014 | C.J. Anderson | 2014-08-04 23:39 ET | 2014-08-04 23:39 ET | 0012 | 1 | no_win | first_bid |  |
| 2014 | C.J. Anderson | 2014-08-05 00:24 ET | 2014-08-05 15:56 ET | 0012 | 7 | won | mfl_report_start | 0008 $6,000 2014-08-06 03:16 ET |
| 2014 | Brady Quinn | 2014-08-06 10:31 ET | 2014-08-06 10:39 ET | 0008 | 4 | no_win | first_bid |  |
| 2014 | Allen Hurns | 2014-08-07 13:48 ET | 2014-08-07 13:48 ET | 0003 | 1 | no_win | first_bid |  |
| 2014 | Alex Henery | 2014-08-07 23:59 ET | 2014-08-07 23:59 ET | 0008 | 1 | no_win | first_bid |  |
| 2014 | Alex Henery | 2014-08-08 00:01 ET | 2014-08-08 00:01 ET | 0008 | 1 | won | mfl_report_start | 0008 $1,000 2014-08-09 00:01 ET |
| 2014 | Dwayne Allen | 2014-08-10 00:05 ET | 2014-08-10 00:05 ET | 0002 | 1 | no_win | first_bid |  |
| 2014 | Dwayne Allen | 2014-08-10 08:21 ET | 2014-08-11 06:27 ET | 0002 | 7 | won | mfl_report_start | 0001 $8,000 2014-08-12 06:31 ET |
| 2015 | Andre Johnson | 2015-08-07 21:17 ET | 2015-08-07 21:18 ET | 0005 | 2 | no_win | first_bid |  |
| 2015 | Andre Johnson | 2015-08-07 21:22 ET | 2015-08-09 09:52 ET | 0005 | 19 | won | mfl_report_start | 0007 $32,000 2015-08-10 09:59 ET |
| 2015 | Brandon Marshall | 2015-08-08 00:03 ET | 2015-08-08 00:07 ET | 0002 | 3 | no_win | first_bid |  |
| 2015 | DeAndre Levy | 2015-08-08 10:52 ET | 2015-08-08 10:52 ET | 0001 | 1 | no_win | first_bid |  |
| 2015 | Marques Colston | 2015-08-08 21:51 ET | 2015-08-08 21:51 ET | 0012 | 1 | no_win | first_bid |  |
| 2015 | Brandon Marshall | 2015-08-09 12:31 ET | 2015-08-10 15:49 ET | 0003 | 10 | won | mfl_report_start | 0012 $27,000 2015-08-11 15:49 ET |
| 2015 | Marques Colston | 2015-08-10 15:59 ET | 2015-08-11 00:21 ET | 0012 | 7 | won | mfl_report_start | 0012 $15,000 2015-08-12 00:24 ET |
| 2015 | Brandon LaFell | 2015-08-10 16:00 ET | 2015-08-10 16:00 ET | 0012 | 1 | no_win | first_bid |  |
| 2015 | Brandon LaFell | 2015-08-12 03:13 ET | 2015-08-13 11:59 ET | 0008 | 7 | won | mfl_report_start | 0007 $16,000 2015-08-14 12:01 ET |
| 2015 | DeAndre Levy | 2015-08-12 07:39 ET | 2015-08-13 12:20 ET | 0001 | 6 | won | mfl_report_start | 0011 $9,000 2015-08-14 12:26 ET |
| 2015 | Albert Wilson | 2015-08-14 09:31 ET | 2015-08-14 09:31 ET | 0003 | 1 | no_win | first_bid |  |
| 2015 | Lance Briggs | 2015-08-15 01:30 ET | 2015-08-15 01:30 ET | 0006 | 1 | no_win | first_bid |  |
| 2015 | Albert Wilson | 2015-08-15 22:22 ET | 2015-08-17 13:59 ET | 0003 | 6 | won | mfl_report_start | 0010 $8,000 2015-08-18 14:18 ET |
| 2015 | Brian Leonhardt | 2015-08-17 16:54 ET | 2015-08-17 16:54 ET | 0009 | 1 | no_win | first_bid |  |
| 2016 | Kamar Aiken | 2016-08-06 04:02 ET | 2016-08-06 04:02 ET | 0011 | 1 | no_win | first_bid |  |
| 2016 | Danny Amendola | 2016-08-07 07:42 ET | 2016-08-07 07:42 ET | 0011 | 1 | no_win | first_bid |  |
| 2016 | Kamar Aiken | 2016-08-07 13:10 ET | 2016-08-09 05:33 ET | 0011 | 13 | won | idle_over_lock | 0011 $20,000 2016-08-10 05:45 ET |
| 2016 | Danny Amendola | 2016-08-08 22:47 ET | 2016-08-09 12:22 ET | 0002 | 9 | won | idle_over_lock | 0007 $9,000 2016-08-10 12:02 ET |
| 2016 | Michael Burton | 2016-08-09 06:05 ET | 2016-08-09 06:05 ET | 0009 | 1 | no_win | first_bid |  |
| 2017 | Jerick McKinnon | 2017-08-10 02:54 ET | 2017-08-10 02:54 ET | 0002 | 1 | no_win | first_bid |  |
| 2017 | Jerick McKinnon | 2017-08-13 00:05 ET | 2017-08-13 00:05 ET | 0002 | 1 | won | mfl_report_start | 0002 $1,000 2017-08-14 00:05 ET |
| 2019 | Larry Fitzgerald | 2019-08-19 08:55 ET | 2019-08-19 08:55 ET | 0004 | 2 | no_win | first_bid |  |
| 2019 | Larry Fitzgerald | 2019-08-20 09:59 ET | 2019-08-21 08:49 ET | 0001 | 5 | won | new_nomination | 0001 $12,000 2019-08-21 22:40 ET |
| 2021 | Mark Ingram | 2021-08-02 23:19 ET | 2021-08-02 23:19 ET | 0012 | 1 | no_win | nomination |  |
| 2021 | Eric Ebron | 2021-08-02 23:21 ET | 2021-08-02 23:21 ET | 0012 | 1 | no_win | nomination |  |
| 2021 | Eric Ebron | 2021-08-03 13:30 ET | 2021-08-03 13:30 ET | 0012 | 1 | won | new_nomination | 0012 $1,000 2021-08-04 13:31 ET |
| 2021 | Mark Ingram | 2021-08-05 13:50 ET | 2021-08-05 13:50 ET | 0012 | 1 | won | new_nomination | 0012 $1,000 2021-08-06 13:57 ET |
| 2021 | Tim Tebow | 2021-08-11 12:35 ET | 2021-08-11 12:35 ET | 0011 | 1 | no_win | nomination |  |
| 2022 | Rob Gronkowski | 2022-05-07 06:40 ET | 2022-05-08 13:04 ET | 0005 | 3 | no_win | nomination |  |
| 2022 | Jonathan Allen | 2022-05-07 19:30 ET | 2022-05-07 19:30 ET | 0002 | 1 | no_win | nomination |  |
| 2022 | Rob Gronkowski | 2022-05-08 19:44 ET | 2022-05-08 21:06 ET | 0005 | 2 | won | new_nomination | 0005 $5,000 2022-05-10 09:17 ET |
| 2023 | Colt McCoy | 2023-08-07 07:16 ET | 2023-08-07 07:16 ET | 0009 | 1 | no_win | nomination |  |
| 2023 | Andy Dalton | 2023-08-07 07:16 ET | 2023-08-07 07:16 ET | 0009 | 1 | no_win | nomination |  |
| 2023 | Bam Knight | 2023-08-08 07:11 ET | 2023-08-08 07:11 ET | 0009 | 1 | no_win | nomination |  |
| 2024 | Derrick Henry | 2024-05-15 08:32 ET | 2024-05-15 08:32 ET | 0006 | 1 | no_win | nomination |  |
| 2024 | Dalton Schultz | 2024-05-15 08:32 ET | 2024-05-15 08:32 ET | 0006 | 1 | no_win | nomination |  |
| 2024 | Jessie Bates | 2024-05-15 08:47 ET | 2024-05-15 08:47 ET | 0006 | 1 | no_win | nomination |  |
| 2024 | Jessie Bates | 2024-05-16 07:47 ET | 2024-05-16 16:52 ET | 0008 | 4 | won | new_nomination | 0008 $5,000 2024-05-18 06:10 ET |
| 2024 | Derrick Henry | 2024-07-27 12:11 ET | 2024-07-29 19:51 ET | 0005 | 14 | won | new_nomination | 0003 $34,000 2024-07-30 19:53 ET |
| 2024 | Dalton Schultz | 2024-07-27 19:34 ET | 2024-07-27 19:34 ET | 0006 | 1 | no_win | new_nomination |  |
| 2024 | Dalton Schultz | 2024-07-27 23:04 ET | 2024-07-27 23:04 ET | 0006 | 1 | no_win | new_nomination |  |
| 2024 | Dalton Schultz | 2024-07-27 23:41 ET | 2024-07-27 23:41 ET | 0006 | 1 | no_win | new_nomination |  |
| 2024 | Dalton Schultz | 2024-07-28 00:02 ET | 2024-07-29 08:29 ET | 0008 | 4 | won | new_nomination | 0012 $4,000 2024-07-29 11:02 ET |
| 2025 | Edgerrin Cooper | 2025-05-26 12:34 ET | 2025-05-26 12:34 ET | 0010 | 1 | no_win | nomination |  |
| 2025 | Tyrice Knight | 2025-05-26 13:24 ET | 2025-05-26 13:24 ET | 0006 | 1 | no_win | nomination |  |
| 2025 | Edgerrin Cooper | 2025-08-06 18:52 ET | 2025-08-07 06:55 ET | 0007 | 3 | won | new_nomination | 0007 $4,000 2025-08-07 19:04 ET |

## 4. Last bid against the winner and price

**2017-2025 (`log_semantics = lead_changes`).** MFL logs a bid only when it takes the lead, plus forced proxy raises. Every won auction's last row is the winner at the price, and amounts rise strictly inside every auction:

| Season | Won | Last row = winner and price | Amounts strictly rising |
|---|---|---|---|
| 2017 | 193 | 193 | 193 |
| 2018 | 240 | 240 | 240 |
| 2019 | 223 | 223 | 223 |
| 2020 | 175 | 175 | 175 |
| 2021 | 189 | 189 | 189 |
| 2022 | 204 | 204 | 204 |
| 2023 | 183 | 183 | 183 |
| 2024 | 199 | 199 | 199 |
| 2025 | 184 | 184 | 184 |

**2014-2016 (`log_semantics = every_bid`).** MFL logged every bid placed, at the amount the owner entered (their maximum), including bids that never took the lead, so the last row is often not the price. The check replays MFL's proxy rules over the rows instead:
- the opening bid leads, with its amount as the maximum, at a price of $1,000;
- the leader's new entry replaces its own maximum and leaves the price alone;
- a rival entry above the leader's maximum takes the lead at the old maximum + $1,000 (no more than the entry);
- a rival entry at or below the leader's maximum (a tie keeps the earlier bidder) sets the price to that entry.

The replay gives MFL's winner **and** price for **578 of 579** won auctions:

| Season | Won | Replay = winner and price | Last row = winner and price | Unopposed, won at $1,000 |
|---|---|---|---|---|
| 2014 | 213 | 213 | 107 | 71 |
| 2015 | 183 | 183 | 94 | 72 |
| 2016 | 183 | 182 | 89 | 62 |

- **Frank Gore 2016** shows why the last row is not the price. Cutting led at $43,000. Kris Lake's $43,000 tied and set the price to $43,000. Cutting then raised his own maximum to $44,000, which moved nothing.
- **Pierre Thomas 2014** only replays if MFL read 0006's '19000-4' entry as $18,996: $18,996 + $1,000 = $19,996, MFL's price.
- **Chris Johnson 2014** only replays if a leader's later, lower entry replaces its maximum. 0009 entered $21,000, then $19,000 and $20,000, and 0008's $21,000 won.

**Exceptions:**

| Season | Player | MFL winner | MFL price | Replay | Last row | Reading |
|---|---|---|---|---|---|---|
| 2016 | Jamison Crowder | 0008 | $4,000 | 0005 $5,000 | 0005 $5,000 | 0005's $5,000 entry was logged 12 hours before the close but never took the lead: MFL appears to have refused it (cap or roster). The log cannot say why. |

## 5. Bid counts against `ups_auction_history.total_bids`

Matched on (season, player, won_at_unix). D1 `total_bids` counts INIT + BID rows, the same unit as the build.

| Season | Built rows | D1 sum | Difference | Auctions matched | Equal counts | In no-win auctions | Lost second auctions (GAP-02) | D1 counted cancelled bids | Explained |
|---|---|---|---|---|---|---|---|---|---|
| 2014 | 1060 | 1050 | 10 | 213 | 213 | 10 | 0 | 0 | yes |
| 2015 | 822 | 811 | 11 | 183 | 183 | 11 | 0 | 0 | yes |
| 2016 | 850 | 849 | 1 | 183 | 181 | 3 | 0 | -2 | yes |
| 2017 | 738 | 737 | 1 | 193 | 193 | 1 | 0 | 0 | yes |
| 2018 | 812 | 812 | 0 | 240 | 240 | 0 | 0 | 0 | yes |
| 2019 | 737 | 734 | 3 | 222 | 222 | 2 | 1 | 0 | yes |
| 2020 | 428 | 428 | 0 | 175 | 175 | 0 | 0 | 0 | yes |
| 2021 | 479 | 476 | 3 | 189 | 189 | 3 | 0 | 0 | yes |
| 2022 | 639 | 635 | 4 | 204 | 204 | 4 | 0 | 0 | yes |
| 2023 | 465 | 460 | 5 | 182 | 182 | 3 | 2 | 0 | yes |
| 2024 | 563 | 541 | 22 | 195 | 195 | 6 | 16 | 0 | yes |
| 2025 | 472 | 470 | 2 | 184 | 184 | 2 | 0 | 0 | yes |

**Every per-auction difference:**

| Season | Player | Kind | Built | D1 | Note |
|---|---|---|---|---|---|
| 2016 | Danny Amendola | d1_counted_cancelled_bidding | 9 | 10 | D1 start 2016-08-07 07:42 ET; build start 2016-08-08 22:47 ET |
| 2016 | Kamar Aiken | d1_counted_cancelled_bidding | 13 | 14 | D1 start 2016-08-06 04:02 ET; build start 2016-08-07 13:10 ET |
| 2019 | A.J. Green | won_auction_missing_from_d1 | 1 |  | won 2019-05-05 21:23 ET; no row in ups_auction_history |
| 2023 | Ezekiel Elliott | won_auction_missing_from_d1 | 2 |  | won 2023-05-16 03:23 ET; no row in ups_auction_history |
| 2024 | Danielle Hunter | won_auction_missing_from_d1 | 3 |  | won 2024-05-16 21:14 ET; no row in ups_auction_history |
| 2024 | Dak Prescott | won_auction_missing_from_d1 | 3 |  | won 2024-05-17 07:36 ET; no row in ups_auction_history |
| 2024 | Joe Mixon | won_auction_missing_from_d1 | 6 |  | won 2024-05-16 21:14 ET; no row in ups_auction_history |
| 2024 | Kyle Dugger | won_auction_missing_from_d1 | 4 |  | won 2024-05-18 06:10 ET; no row in ups_auction_history |

The 2024 gap (June 563 vs D1 541) is 16 bids in four May ERA auctions D1 lost (Danielle Hunter, Dak Prescott, Joe Mixon, Kyle Dugger) plus 6 bids in six auctions with no winner. GAP-02 therefore has **eight** lost won auctions (2011: 2, 2019: 1, 2023: 1, 2024: 4), not seven: Danielle Hunter's May 2024 auction (0005, $6,000) was also dropped.

## 6. Spot checks

**Derrick Henry 2023** (audit: 29 bids: Keith 15, Blake 8, Cutting 6; $94,000). Built: 30 rows = opening (init by 0008 Keith Creelman 1000) + 29 later rows; later rows by franchise 0008 Keith Creelman 15, 0010 Shawn Blake 8, 0004 Brian Cutting 6. Winner 0008 Keith Creelman at $94,000; last row 0008 94000; runner-up 0010 Shawn Blake 91000; forced rows 14; start basis nomination. 2023-07-29 14:01 ET to 2023-08-03 14:54 ET, won 2023-08-04 14:55 ET.

**Frank Gore 2016** (audit: 34 bids; recorded price $43,000 vs last bid $44,000). Built: 34 rows = opening (bid by 0006 Steve Bousquet 1000) + 33 later rows; later rows by franchise 0004 Brian Cutting 14, 0005 Kyle Creelman 10, 0003 Kris Lake 6, 0008 Keith Creelman 2, 0006 Steve Bousquet 1. Winner 0004 Brian Cutting at $43,000; last row 0004 44000; runner-up 0003 Kris Lake 43000; forced rows 0; start basis first_logged_bid. 2016-08-06 15:02 ET to 2016-08-13 15:13 ET, won 2016-08-14 10:53 ET.

**Willie Snead 2017** (audit: 13 bids; $37,000). Built: 13 rows = opening (bid by 0006 Steve Bousquet 1000) + 12 later rows; later rows by franchise 0001 Ryan Bousquet 6, 0006 Steve Bousquet 2, 0005 John Richard, Jarrade Nieber 2, 0008 Keith Creelman 1, 0009 Bear Dunn 1. Winner 0005 John Richard, Jarrade Nieber at $37,000; last row 0005 37000; runner-up 0001 Ryan Bousquet 34000; forced rows 6; start basis mfl_report. 2017-08-03 08:15 ET to 2017-08-03 14:51 ET, won 2017-08-04 14:51 ET.

**Arian Foster 2014** (audit: runner-up Keith $48,000). Built: 27 rows = opening (bid by 0001 Ryan Bousquet 34000) + 26 later rows; later rows by franchise 0006 Steve Bousquet 11, 0003 Kris Lake 6, 0010 Shawn Blake 2, 0009 Bear Dunn 2, 0001 Ryan Bousquet 2, 0008 Keith Creelman 2, 0007 Josh Martel 1. Winner 0006 Steve Bousquet at $48,000; last row 0008 48000; runner-up 0008 Keith Creelman 48000; forced rows 0; start basis mfl_report. 2014-08-02 00:06 ET to 2014-08-05 06:30 ET, won 2014-08-05 07:06 ET.

All four agree with the audit. Henry's "29 bids" are the rows after Keith's opening nomination; Gore's and Snead's counts include the opening bid, because before 2019 the opening is itself a BID. Foster's runner-up is Keith at $48,000: Steve Bousquet entered $48,000 first, and Keith's later $48,000 tied without taking the lead.

## 7. Data quirks

- **Unreadable amounts:** 2014 Reggie Wayne (0006, 2014-08-04 11:17 ET); 2014 Pierre Thomas (0006, 2014-08-05 12:52 ET). MFL wrote '19000-4'; stored as NULL amount, still counted as a bid.
- **Forced proxy raises** (MFL's own note): 2017: 300, 2018: 274, 2019: 253, 2020: 129, 2021: 152, 2022: 265, 2023: 135, 2024: 195, 2025: 165. Forcing franchise resolved for all but 0. The note names the rival's team as it was at bid time; these resolved through a name that franchise used in another season: 2017: The Baster -> 0011 (29), Crystal Blue Persuasion -> 0002 (1); 2022: The Bash Bros -> 0002 (43), Run CMC -> 0005 (14); 2024: The Main Event Mafia -> 0006 (25). MFL also double-encodes emoji in these notes; the loader repairs that before matching.
- **The June archive's `forced_bid_ind` is its own heuristic**, not MFL's note: it marks 2014: 256, 2015: 201, 2016: 193, 2017: 270, 2018: 274, 2019: 267, 2020: 129, 2021: 152, 2022: 266, 2023: 116, 2024: 169, 2025: 153. MFL has no forced note before 2017. The load uses MFL's note only.
- **Owner-written comments dropped** (count only, text never read into any output): 2015: 4, 2016: 2, 2017: 3, 2018: 7, 2019: 7, 2020: 18, 2021: 20, 2022: 3, 2023: 11, 2024: 3, 2025: 2.
- **GAP-04 evidence (franchise 0006 in 2024).** MFL's forced notes call 0006 "The Main Event Mafia" (its 2023 name) from May 15 through Aug 1, 2024; MFL's league export now says "The Long Haulers". So the rename came after Aug 1, 2024. That supports an owner change during or after the FA auction, but it does not date it. The ruling is still pending.

## 8. Flags stored with the rows

So a story never states more than MFL's log supports, each row carries how much it can be trusted:

- **`amount_meaning`** on every bid row: `entered_max` for 2014-2016 (2,732 rows: the maximum the owner entered, **not a price**) and `price_after_bid` for 2017-2025 (5,333 rows). The final price is always `ups_hist_auctions.winning_bid`, MFL's AUCTION_WON amount.
- **`amount_raw`**: MFL's original amount text, kept on the 15 rows where it is not a plain integer ('40000.00', and the two '19000-4' rows whose `amount` is NULL).
- **`price_check`** on every auction: `last_bid`, `proxy_replay`, `unexplained`, or `none` (no winner).
- **`caveat`** on every auction a story must not state as fact: `start_unconfirmed`, `price_unexplained`, `unreadable_amount`.

| Season | price_check | caveat |
|---|---|---|
| 2014 | none 6, proxy_replay 213 | start_unconfirmed 6, unreadable_amount 2 |
| 2015 | none 8, proxy_replay 183 | start_unconfirmed 8 |
| 2016 | none 3, proxy_replay 182, unexplained 1 | price_unexplained 1, start_unconfirmed 186 |
| 2017 | last_bid 193, none 1 | start_unconfirmed 1 |
| 2018 | last_bid 240 | none |
| 2019 | last_bid 223, none 1 | start_unconfirmed 1 |
| 2020 | last_bid 175 | none |
| 2021 | last_bid 189, none 3 | none |
| 2022 | last_bid 204, none 2 | none |
| 2023 | last_bid 183, none 3 | none |
| 2024 | last_bid 199, none 6 | none |
| 2025 | last_bid 184, none 2 | none |

`price_unexplained`: 2016 Jamison Crowder (MFL: 0008 at $4,000). A story may say who won and the price MFL recorded, but not how the bidding produced it.

## 9. What a load would write

- **Schema:** `worker/migrations/manual/gap01_ups_hist_auction_bids.sql` (not applied). Two `WITHOUT ROWID` tables, one secondary index. Rollback: `gap01_ups_hist_auction_bids_rollback.sql` (drops both).
- **Rows:** `ups_hist_auctions` 2,404; `ups_hist_auction_bids` 8,065; 132 upsert statements that skip unchanged rows.
- **Measured on a local D1 (Miniflare, D1's own counters):** forward 12,873 rows written (10,469 rows + index entries); a second run 0 written; rollback 0 written. That is 12.9% of the Free plan's 100,000 daily writes (account-wide, reset 00:00 UTC).

| Read | Rows returned | rows_read | Plan |
|---|---|---|---|
| one_auction_bids | 30 | 31 | SEARCH ups_hist_auction_bids USING PRIMARY KEY (season=? AND player_id=? AND started_at_unix=?) |
| player_auctions | 3 | 4 | SEARCH ups_hist_auctions USING INDEX idx_hist_auctions_player (player_id=?) |
| season_auctions | 186 | 187 | SEARCH ups_hist_auctions USING PRIMARY KEY (season=?) |
| franchise_bids_in_season | 54 | 466 | SEARCH ups_hist_auction_bids USING PRIMARY KEY (season=?) |
| verify_bids_by_season | 12 | 8065 | SCAN ups_hist_auction_bids |
| verify_auctions_by_season | 22 | 4808 | SCAN ups_hist_auctions / USE TEMP B-TREE FOR GROUP BY |

The two full scans are one-time post-load checks, not request paths.
- **Fingerprints (sha256 over sorted rows):** `ups_hist_auctions` `d5c505a14aa97c30…`, `ups_hist_auction_bids` `7afdf8099dae56eb…`, forward SQL `bdcebbe138eb77b8…`. An approved run must rebuild from fresh MFL replies and match these, or stop.

## 10. Privacy

- Comment text is never stored. MFL's forced note becomes `forced` + `forcing_fid`; any other comment is dropped at parse time. O=102's comments column is never parsed.
- Raw MFL replies, the generated SQL and the row files stay in `~/.ups_jobs/gap01_auction_bids/`, outside the repository.
- `report` scans every output file, this report included, for every owner-written comment string MFL returned (2011-2025). It deletes the committed copy and fails if one is found.

## 11. Not proven here

- **No production write was made or tested.** Billed writes were measured on a local D1 only.
- **2016 auction starts** have no independent source (section 3).
- **Why a bid was cancelled** (commissioner reset, nominated too early, eligibility) is not in MFL's log. Each one is listed in section 3 without a reason.
- **Proxy maximums after 2016** are private to each owner and are not in the log.
- **Owner names** above come from the June archive's standings, by season. The 0006 2024 owner is still pending (GAP-04).

## Sources

- MFL: 72 cached replies (transactions by type, league, O=102), fetched 2026-10-22T17:04:34Z to 2026-10-22T17:13:12Z; each file's sha256 is in summary.json.
- June archive: sha256 `898d9330ffbc437b…` (restored scratch copy, read-only).
- D1 (SELECT only): 3,099 rows read in 2 queries; plans: ups_auction_history: SEARCH ups_auction_history USING INDEX idx_auction_hist_winner (season>? AND season<?); name_check: SCAN sqlite_master. Proposed table names free: yes.

