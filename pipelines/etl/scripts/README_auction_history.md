# Auction history ingest → `ups_auction_history`

Populates D1's `ups_auction_history` with every completed UPS auction lot,
2012–present (both ERA and FAA), for use by reports and analytics.

## Why this exists

MFL's `TYPE=transactions` auction log alone is **not enough**:

| Need | Transaction log | O=102 |
|---|---|---|
| 2012–2013 coverage | ❌ `AUCTION_WON` only, no bids | ✅ full rows |
| Bid counts / bidders | ✅ 2014+ | ❌ |
| Nomination (`AUCTION_INIT`) | ✅ 2019+ only | ❌ |
| 2016 start times | ✅ | ❌ epoch-0 junk |
| Winner + price | ✅ | ✅ |

So O=102 is the **spine** (it's the only thing that covers 2012–13) and the
transaction log supplies the **detail** (opening bid, runner-up, bid counts,
exact timestamps).

## Run it

```bash
cd pipelines/etl/scripts
python3 scrape_auction_o102.py                     # scrapes + caches O=102 HTML per season
python3 build_auction_history_sql.py               # merges with the tx-log cache -> load_auction_history.sql
cd ../../../worker
npx wrangler d1 execute ups-mfl-db --remote --file ../pipelines/etl/scripts/load_auction_history.sql
```

`build_auction_history_sql.py` expects the AUCTION_INIT/BID/WON transaction
cache in an `auction_cache/` dir next to it (one `<season>_<TYPE>.json` per
pull). Re-pull it from `/api/mfl-export?TYPE=transactions&TRANS_TYPE=AUCTION_*`.

The generated SQL starts with `DELETE FROM ups_auction_history;` — it's a full
rebuild, not an incremental append. Safe to re-run; **re-run it as the 2026
auction finishes**, since 2026 rows are live and incomplete.

⚠️ Load with `d1 execute --file`, never `d1 migrations apply` (the migration
tracker is ~47 behind and applying it corrupts contracts).

## Gotchas that cost real debugging time

1. **O=102 hrefs are HTML-encoded.** The franchise link is `&amp;F=0004`, so a
   regex anchored on `[?&]F=` matches nothing and silently yields zero
   franchise IDs. Match `\bF=(\d{1,4})\b`.
2. **2016 "Auction Started" is the Unix epoch sentinel** — every row renders
   `Wed Dec 31 7:00 p.m.` (epoch 0 in ET). Any month outside May–Aug is missing
   data, not a real date; those rows get their start from the transaction log.
3. **A player can be auctioned twice in one season** (ERA in May, then FAA in
   July/Aug). The PK includes `won_at_unix` for that reason, and each win is
   scoped to only the events in its own cycle — otherwise you pair a May
   nomination with an August win and report a 1,835-hour auction (this actually
   happened with Derrick Henry 2024).
4. **`proxy_bid` is always NULL.** O=102 renders the column but never fills it
   on the public page — proxy/max bids are private to the bidding owner. Kept
   in the schema in case an authenticated fetch can populate it later.
5. **Pre-2019 has no `AUCTION_INIT`**, but the opening $1,000 nomination *is*
   logged as the first `AUCTION_BID` (verified: Frank Gore 2016). So the
   earliest event is the true auction start in every era — durations for
   2014–2018 are accurate, not approximate.
6. **Retired players don't resolve from MFL.** `TYPE=players` returns nothing
   for e.g. 7877 / 9448 / 10302. Use D1 `src_players` for names.
7. **An abandoned bid cluster can sit in the log ahead of the real auction,
   even in the same month** — MFL's transaction log is append-only, so a
   nomination/bid that was cancelled or never followed up leaves no deletion
   marker. DeAndre Levy 2015: an orphaned $5,000 bid landed Aug 8, four days
   before the real Aug 12–14 bidding war that actually won him; naive
   "previous win → this win" scoping (even with gotcha #3's month filter,
   since both are August) reported a 145.6h auction instead of the real
   52.78h. Fix: trust O=102's own reported `started_unix` as the cycle floor
   whenever MFL gave us a valid one for that (season, player) — its own
   report already excludes cruft like this — and fall back to the
   previous-win/month-window logic only when O=102's start is missing or was
   rejected as the epoch sentinel (gotcha #2).

## Known data limits (don't paper over these in reports)

- **2012–2013**: no `opening_bid`, `runner_up_fid`, `total_bids`,
  `distinct_bidders`, or `lead_changes` — MFL retains no bid-level history that
  far back, and no report exposes it (O=44 is a summary, O=43 302s on a closed
  season).
- **`runner_up_fid` is partial even 2014+** (~50–65% of lots). Many lots are won
  at the opening bid with no second bidder, so there is no runner-up to record.
- **MFL only logs a bid when a franchise TAKES the lead** (or is force-bumped
  while leading). A team that bid and never led leaves no trace, so
  `distinct_bidders` means "teams that ever held the high bid," not "teams that
  tried."
- **2010–2011 are not covered here.** 2011's inaugural auction already lives in
  `mfl_historical_auctions` (269 rows, league 40832). Add 2010 (`www45`/60671)
  and 2011 (`www46`/40832) to the `LEAGUES` dict in the scraper if wanted.
