# Historical D1 gaps, 2010-2025: backfill plan

Written 2026-10-22, from the read-only gap audit of the same day (17 gaps: GAP-01 to GAP-17). This is a plan. Nothing here has been written to D1.

**Standing rules for every gap:**
- No D1 write, migration or backfill without Keith's separate, explicit go for that specific write.
- Each gap gets the same pattern before its go:
  - a dry-run loader that is offline by default;
  - a reconciliation report against MFL's original exports;
  - a local proof (load, re-run writes 0, rollback);
  - measured `rows_read` / `rows_written` (`docs/D1_QUERY_RULES.md`).
- A missing source record is reported as missing. It is never filled in or guessed.
- Owners' bid, trade and message text never goes into the repo, a PR or a preview.
- Gaps that change published history or owner attribution go through the issue that owns that history (#1307, #1329, #1355).

## Order and status

| Gap | What is missing | Best source (does it exist?) | Owner | Depends on | Status |
|---|---|---|---|---|---|
| **GAP-01** auction bids 2014-2025 | every nomination and bid (8,065 rows) | MFL `AUCTION_INIT` / `AUCTION_BID` / `AUCTION_WON`: **yes**, complete | this PR | none | **Go A given 10-22 (load only; CI green + write guard first)** |
| **GAP-16** weeks past the season | June archive copies the final week into weeks 17-22 / 18-22 | n/a (a guard, not a load) | this PR | none | **Checked: D1 is clean; rule recorded** |
| GAP-02 lost second auctions | 8 won auctions | MFL `AUCTION_WON`: **yes** | after GAP-01 | GAP-01 tables | 6 of 8 land with GAP-01 |
| GAP-06 starter/bench 2012-2019 | lineup status (rows say `fa`) | MFL `weeklyResults` per week: **yes** | #1307 | #1307 plan v5 (#1363) | in #1307's plan |
| GAP-07 playoff player rows | playoff weeks 2011-2020; unscored bench 2021-2025 | MFL `weeklyResults` + `playerScores`: **yes** | #1307 | #1307 plan v5 | in #1307's plan (Batch 1A not yet requested) |
| GAP-08 2012 Weeks 15-16 | June archive wrong (D1 right) | MFL 2012 `weeklyResults` (L=37227): **yes** | #1307 | GAP-06/07 must not copy June 2012 W15-16 | constraint on #1307 |
| GAP-17 2010 lineups, 2012 W14 | phantom/missing rows | MFL 2010 (L=60671), 2012 W14-16: **yes** | #1307, #1329 | GAP-03 | in #1307 / #1329 |
| GAP-09 MFL `WAIVER`-type moves 2010-2017 | 223 adds + 1,388 drops (+ IR / TAXI / LOAD_ROSTERS) | MFL `TYPE=transactions` per league id: **yes** | #1355 | raw-log storage decision | plan below |
| GAP-15 multi-player drops 2011-2025 | about 1,683 rows (first player kept only) | MFL raw transactions: **yes** | #1355 | the same parser fix | plan below |
| GAP-10 restructures | no reliable history before 2026 | partial: form logs, Discord export, forum, salary snapshots | #1355 | contract change gate | partial; some dates do not exist |
| GAP-11 contracts 2010-2016 | `src_contracts` empty / thin | MFL `salaries` for past seasons: **unverified**; forum histories | #1355 | contract change gate | needs a source check first |
| GAP-03 2010 team weekly scores | 38 team-weeks, 20 playoff flags wrong | MFL 2010 `weeklyResults` (L=60671): **yes** | #1329 | #1329 C6/C9/C10 | inside #1329's go |
| GAP-04 franchise 0006 in 2024 | owner on each date | Keith's ruling; MFL owner history needs a commissioner read | #1329 | GAP-05 | ruling pending; new evidence below |
| GAP-05 owner registry | one display name per (season, franchise) | `src_standings` + Keith's ruling on co-owner names | #1329 | ruling | ruling pending |
| GAP-14 playoff finishes | approved corrections C1-C5 not executed | MFL brackets: **yes** | #1329 | #1329 execution go | plan posted 10-22 |
| GAP-12 auction bids 2011-2013 | every bid | **does not exist at MFL** (verified 10-22: 0 INIT, 0 BID rows) | none | forum / email archive (not on this machine) | not recoverable from MFL |
| GAP-13 regular-season pairings 2010-2019 (except 2012) | who played whom | **does not exist at MFL** | #1329 (C5 only) | none | not recoverable |

## GAP-01: auction bids (this PR)

- Report: `docs/data_fixes/2026-10-22-gap01-auction-bids-reconciliation.md`.
- Design: two new tables keyed by auction (season + player + first logged event), not by (season, player).
- **Reconciliation:**
  - 8,065 rows = MFL's count and the June archive, row for row.
  - 2017-2025: every won auction's last bid is MFL's winner and price (1,790 of 1,790).
  - 2014-2016: replaying MFL's proxy rules gives the winner and price for 578 of 579. The one exception is a bid MFL logged but did not honor.
  - Every season's difference from `ups_auction_history.total_bids` is explained.
- **Load cost, measured on a local D1:** 12,873 rows written, about 13% of the Free plan's daily writes. A second run writes 0.
- **Ruling (Keith, 2026-10-22, on #1387):** option A, load 2014-2025, for GAP-01 only. Conditions:
  - CI must be green on the exact PR head, and the write-budget guard must pass immediately before the load;
  - 2014-2016 entered maximums stay distinct from the final price;
  - the Crowder exception and the unconfirmed start times are flagged and never stated as fact;
  - after the load, reconcile against the dry run and report the actual write count.
  - The go does not cover a merge, other gaps, or any Discord post.
- **Flags added for that ruling:** `amount_meaning` and `amount_raw` on each bid; `price_check` and `caveat` on each auction.

## GAP-16: stop at the league's last week

**Checked 2026-10-22, read-only:**
- **June archive.** `playerscores_weekly` has 102,383 rows past the last league week, and `rosters_weekly` has 16,613. Every one is a copy of the final week (`check_gap16_last_league_week.py archive`).
- **D1.** `src_weekly` and `src_franchise_weekly_score` have **0** rows past the last week in every season 2010-2025, and `src_league_season_meta.total_weeks` = 16 (2010-2020) / 17 (2021-2025) in all 16 seasons.
- **Cost:** 81 rows read, covering-index seeks (`check_gap16_last_league_week.py d1 --allow-prod-d1`).

**Rule for every source and backfill:**
- Bound weeks by `last_league_week(season)`: 16 through 2020, 17 from 2021.
- Never sum the June `playerscores_weekly` or `rosters_weekly` without that bound.

**Already compliant:**
- #1363 reads `player_weeklyscoringresults`, which has 0 rows past the last week.
- #1363 bounds its MFL pulls with `canon_weeks`.

**Not covered here:** 2010 season totals in D1 (`src_pointssummary`: Vick 488.2 against MFL's 396.1). Those come from GAP-17's phantom lineup rows and are fixed there.

No write is needed for GAP-16 itself.

## GAP-02: lost second auctions

**Eight won auctions are missing from `ups_auction_history`.**
- The audit said seven; the GAP-01 dry run found Danielle Hunter's May 2024 auction (0005, $6,000) as well.
- 2011: Jon Beason, Zoltan Mesko.
- 2019: A.J. Green (May).
- 2023: Ezekiel Elliott (May).
- 2024: Danielle Hunter, Dak Prescott, Joe Mixon, Kyle Dugger (May).

**Plan:**
- The six from 2019-2024 become rows in `ups_hist_auctions` when GAP-01 loads.
- 2011 has no bids at MFL, only `AUCTION_WON`. Option: add 2011-2013 won-only auctions to `ups_hist_auctions` with `bid_count = 0`, as a separate go after GAP-01.
- `ups_auction_history` has no live reader (`git grep`: only its builder), so correcting it is optional. Its builder would need the same auction key.
- **Not in the auction data:** why each May winner went back to auction in the summer (a cut, a void, or cap). That needs the transaction chain (#1355).

**Verify by:** count of won auctions per season = MFL `AUCTION_WON` (blank rows excluded).

## GAP-06 / 07 / 08 / 17: lineups and playoff player rows (#1307)

**Owned by #1307's src_weekly plan:**
- plan v5, draft #1363;
- the rank safeguard #1372 is released;
- Batch 1A is not requested yet. It waits for #1363's read guard.

**Source:**
- MFL `weeklyResults` per week (the lineup and ownership authority) and `playerScores`.
- Never the June archive for 2010, 2012 Week 14, or 2012 Weeks 15-16 (GAP-08 / GAP-17).

**Verify by:**
- starter sums = team score (±0.05) for every (season, week, franchise);
- starter count = that season's lineup size;
- no week past the last league week (GAP-16);
- one MFL `weeklyResults` week per season matched in full.

**Nothing to build here.** These gaps add one constraint to #1307's plan: the 2012 Weeks 15-16 rule.

## GAP-09 / GAP-15: waiver-type and multi-player moves (#1355)

**The same source and the same dry-run pattern as GAP-01.**

**Source:**
- MFL `TYPE=transactions` per season and league id: `WAIVER`, `IR`, `TAXI`, `FREE_AGENT`, `BBID_WAIVER`.
- The June `transactions_base.raw_json` as the row-for-row cross-check.

**GAP-15 (multi-player drops):**
- The parser that built `src_adddrop` keeps only the first player of a multi-player add or drop list.
- Fix the parser first, then backfill only the missing players. `src_adddrop`'s existing key `(season, txn_index, player_id, move_type)` makes this inserts only.
- The dry run must name the parser it fixes, so new seasons don't repeat the gap.

**GAP-09 (2010-2017 `WAIVER`-type moves):**
- Decision first: does D1 keep a raw per-season transaction log table (new), or do these go into `src_adddrop`?
- `src_adddrop` today means blind-bid and free-agent moves only.

**Verify by:**
- per season and type, D1 count = MFL count;
- every player in each MFL move has a row;
- each player's chain alternates add, then drop or trade, with no double adds;
- spot check: Eli Manning's 2018 chain (Cutting's 2018-09-18 drop) shows each owner with a drop between.

**Owner:** #1355 needs complete transaction chains, so these belong to its plan. It is a separate dry run and a separate go, after GAP-01.

## GAP-10 / GAP-11: restructures and contracts (#1355)

**Partial at best. The contract change gate applies:** canon, then a dry run, then Keith, then confirm.

**Missing restructure history stays open (Keith, 2026-10-22).** An empty restructure record is not evidence of no restructure. No story, page or summary may say a player "had no restructures" because D1 holds none. Kyler Murray and Derrick Henry are the named examples. Until GAP-10 is closed, the only accurate wording is that the restructure history is incomplete.

**GAP-10 (restructures):**
- Sources:
  - the 2022-23 contract form log (ends March 2023);
  - the Discord contract export (from August 2024);
  - forum threads;
  - MFL salaries between two snapshots.
- Some dates do not exist anywhere. Example: D.J. Moore's 2023 restructure has no dated record. Those stay unresolved with the reason; they are never inferred from a neighboring event.

**GAP-11 (contracts 2010-2016):**
- First check whether MFL's `salaries` export serves past seasons for the 2011-2016 league ids. One read per league.
- Without that, only the forum histories already in D1 exist.

## GAP-03 / 04 / 05 / 14: history corrections (#1329)

**GAP-03 (2010 team scores) and GAP-14 (finishes C1-C5):** run inside #1329's correction plan (posted 10-22, awaiting its execution go). They do not run separately.

**GAP-04 (franchise 0006 in 2024):** the ruling is still pending. New evidence from the GAP-01 dry run:
- MFL's forced-bid notes still call 0006 "The Main Event Mafia" (its 2023 name) from May 15 through Aug 1, 2024;
- MFL's league export now names it "The Long Haulers";
- so the rename came after Aug 1, 2024. That fits an owner change during or after the FA auction, but it does not date it.

**GAP-05 (owner registry):** needs Keith's ruling on co-owner display names. Then one display name per (season, franchise) that every history page and story resolves through.

## GAP-12 / GAP-13: no source record

- **GAP-12.** MFL returns 0 `AUCTION_INIT` and 0 `AUCTION_BID` rows for 2011, 2012 and 2013 (fetched 10-22). Only the wins exist.
  - The forum or email archive might name bidders for a few auctions, but it is not on this machine.
  - Story impact: Fred Jackson 2012 can't name his bidders.
- **GAP-13.** MFL exports no regular-season pairings for 2010-2019 except 2012.
  - Official head-to-head records exist in `src_standings`.
  - C5 (2025 Week 17) runs through #1329.
- Neither is recoverable from MFL, and neither will be filled in.
