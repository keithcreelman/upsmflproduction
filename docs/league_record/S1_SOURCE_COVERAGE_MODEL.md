# League Record S1: the source-coverage model (proposal, decision 2 of 2026-11-21)

**Status:** a model and a tested diagnostic (`scripts/league_record/s1/coverage.mjs`), not a rule change. The resolution rules in `lineage.mjs` are unchanged, all 597 unresolved future picks stay in every report, and no link is added. The model changes what a *future* decision could rely on; it relaxes nothing today. Local and read-only: no external call, no production system, no D1.

## 1. The problem the model solves

Today a "quiet window" (14 or more days with no recorded transaction of any kind) marks custody as unobserved. That is deliberately conservative, but it conflates two different facts:

- *No transaction happened* (a quiet period inside a source that would have recorded one), and
- *The source may not have recorded what happened* (a source that is incomplete, or absent).

The commissioner's ruling (2026-11-21): a quiet period must not by itself prove uninterrupted custody, and inactivity must not be treated as missing coverage either. The model therefore describes **how much we trust the source over an interval** separately from **what happened in it**.

## 2. Four things, kept apart

| Concept | What it is | Where it lives | Can it block or prove custody? |
|---|---|---|---|
| **Recorded activity** | A transaction event with its timestamp and date quality | the event ledger | Never by itself. An event is a fact about one asset, not a statement about an interval. |
| **VERIFIED_COMPLETE** | An authoritative, complete source covers the interval **and** the completeness checks in section 4 passed, whether or not any transaction occurred | a verification record | Yes: custody is *observed* across the interval, including a quiet stretch inside it. |
| **UNVERIFIED** | A source exists but its completeness for the event class is not established | the default for every interval | Blocks (as today). A quiet period here proves nothing. |
| **KNOWN_GAP** | No adequate source covers the interval | the named gap (2025-11-28 to 2026-03-07) | Blocks. Becomes VERIFIED_COMPLETE only if verifications cover all of it. |

Two more rules:

- **Per event class.** Coverage is stated for `pick_transfer` and `player_move` separately. A verified add/drop log does not verify trades.
- **Point observations are a different kind of evidence.** A dated end-state (the draft results, an MFL future-picks export on a call date) says who held an asset *on that date*. It is used to *test* an interval (check E3 below) and is never an interval state.

## 3. What the archive actually offers today

Facts checked on 2026-11-21 against the committed archive (read-only):

- **No interval is verified.** The extraction now carries a state on every interval: 38 quiet windows (1,532 days) are UNVERIFIED, the named gap (100 days) is a KNOWN_GAP, 0 are VERIFIED_COMPLETE.
- **Record numbering proves nothing.** `txn_index` in `transactions_base` runs 0..n-1 without a hole in every season, and trade ids run 1..n without a hole in every year, but both are assigned by the load, so their continuity is true by construction. A missing trade would not leave a hole. This is why continuity of ids is **not** accepted as a completeness check.
- **The archive is one copy, captured once.** It is a database dated 2026-06-05; nothing in it records a request, a capture time per season or a response count. So it cannot attest to its own completeness.
- **Recorded activity is uneven in quality.** 2,546 of the 26,141 rows are administrative or automatic (`LOCK_ALL_PLAYERS`, `UNLOCK_ALL_PLAYERS`, `LOAD_ROSTERS`, auto-processed waivers); 68 `AUCTION_WON` rows in the 2011, 2012, 2013, 2015 and 2016 league instances carry dates of 2017-02-17 to 2017-02-25, after the instance year they belong to, so those dates are probably entry or rollover dates rather than event dates (not verified); trades before 2024 carry the commissioner's processing time. Such dates show that the log was written on that day, not that every trade was captured.
- **Internal consistency is weak but real evidence.** Across all traded future picks the archive has 3 chain discontinuities, and 49 across all traded players. A missed transfer usually breaks the next recorded sender; the one thing chains cannot detect is a missed *final* transfer, which is exactly what the evidence-date check (E3) is for.

## 4. When an interval becomes VERIFIED_COMPLETE

A verification record (`docs/league_record/coverage_verifications.json`, empty today) covers one interval and one event class and is accepted only if **all** of this holds (`validateVerification`):

1. **Authoritative source:** an MFL export, with the request recorded (year, league id, parameters, capture date).
2. **Untruncated:** the response is shown to be whole; `COUNT` and `DAYS` parameters (which MFL documents as restricting the result) are refused.
3. **Captured after the interval ended.**
4. **Check E1, required:** the export and the archive agree record for record in the interval, with zero unexplained differences (an extra or missing record is a finding, not a pass).
5. **At least one independent corroboration:** **E2** no break in any pick or player chain across the interval, or **E3** a dated end-state export (holders of every traded pick) equals the holder the chains give.
6. **Any failed check voids the record.** A bad record can never verify anything.

A commissioner statement ("I believe no trade happened") is recorded as provenance but is **not** a check: it cannot make an interval VERIFIED_COMPLETE on its own.

## 5. How it would be used (not wired yet)

Custody of an asset between two dates is **observed** only if no interval touching them is anything but VERIFIED_COMPLETE (`custodyObserved`). Consequences:

- A quiet stretch inside a verified interval does not invalidate custody.
- A quiet stretch inside an unverified interval does not prove it (as today).
- A known gap blocks even when neighbouring intervals are verified.
- The model is never more permissive than today's rule when no verification exists; a test checks this on every traded future pick (see section 6).
- Dense activity is not treated as proof either: the model is *stricter* than today for stretches with frequent activity, but today's strict-custody count is already 0 of 597, so no current result differs.

## 6. How it is tested before any use

`tests/league_record_s1_archive.test.mjs`, test "the source-coverage model":

- the archive's state counts equal a separate SQL recomputation of the quiet windows (38 windows, 1,532 days, plus the 100-day gap);
- twelve refused verification records, one for each condition in section 4;
- a verified window with no transaction in it is VERIFIED_COMPLETE; the same window with no verification, with a record for the other event class, with a failed check, or only partly covered, is not;
- adjacent verified intervals together cover a window; one uncovered day keeps the named gap a KNOWN_GAP; a known gap blocks even beside verified intervals;
- the safety property: with no verification, for every traded future pick in 2010-2025 that has a last transfer and an evidence date, the model never observes custody where today's rule does not;
- all 597 unresolved future picks are still unresolved.

## 7. What would be needed to verify real intervals (for the commissioner's decision)

- **The 2025-11-28 to 2026-03-07 gap:** the read-only requests in `S1_MFL_EXPORT_REQUESTS.md` (section 2), then E1 against the archive and the 2026 snapshot, and E3 with the future-picks export.
- **Earlier quiet windows:** a second, optional request set (one trade-only export per year) covering the windows that matter for the picks assessed in `S1_FUTURE_PICK_ASSESSMENT.md`: 23 distinct windows across the 2013-2025 instances. Not requested here.
- Nothing is verified by the verification file alone: each record must cite a real, recorded export and passing checks.

## 8. Open points

- **Is MFL's transaction export complete for old seasons?** MFL's documentation does not promise it; E1 cannot prove a negative for a record MFL itself no longer holds. A verification therefore says "this export, captured on this date, agrees with the archive", never "no trade ever occurred".
- **Pre-2024 trade timestamps are processing times**, so an interval boundary near a trade has a day of slack; verification must use a margin of at least one day at each end.
- **Event class for commissioner-processed trades** (pre-2024) is `pick_transfer` like any other; the date quality travels with the event.
